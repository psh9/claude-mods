import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, GitView, GraphLine, Layout, Op, Plan, Step, TouchedFile } from '../types'

const PANE = 'file-tree'
const PLAN_TOOL = 'mcp__file-tree__plan'
// Change a tag when its value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const files = atom({ plugin: 'file-tree', key: 'files' } as const, [], {
  shape: 'files-3',
})
const activity = atom(
  { plugin: 'file-tree', key: 'activity' } as const,
  { active: [], last: null },
  { shape: 'activity-1' },
)
const plan = atom({ plugin: 'file-tree', key: 'plan' } as const, { steps: [], at: 0 }, {
  shape: 'plan-1',
})
const layout = atom({ plugin: 'file-tree', key: 'layout' } as const, 'side', {
  shape: 'layout-1',
})
const git = atom({ plugin: 'file-tree', key: 'git' } as const, null, {
  shape: 'git-1',
})

const TOOL_OPS: Record<string, Op> = {
  Read: 'read',
  Edit: 'write',
  MultiEdit: 'write',
  Write: 'write',
  NotebookEdit: 'write',
  Grep: 'search',
  Glob: 'search',
}
// Shell commands by what they do to the paths they are given.
const READ_CMDS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'wc', 'diff', 'cmp', 'grep', 'rg',
  'awk', 'jq', 'bat', 'stat', 'file', 'shasum', 'md5',
])
// The first argument of these is a pattern or a program, not a path.
const PATTERN_FIRST = new Set(['grep', 'rg', 'awk', 'jq'])
const WRITE_CMDS = new Set(['mkdir', 'touch', 'rm', 'rmdir', 'chmod', 'truncate', 'tee'])
// The last path is written, the others read.
const COPY_CMDS = new Set(['cp', 'mv', 'rsync', 'ln', 'install', 'ditto'])
const PREFIX_CMDS = new Set(['sudo', 'time', 'command', 'env', 'nohup', 'exec', 'then', 'do', 'else'])
// Options whose value is the next word, not a path.
const VALUE_OPTIONS = new Set(['--exclude', '--include', '-e', '-m', '--message', '-n'])
const OP_RANK: Record<Op, number> = { write: 3, read: 2, search: 1, shell: 0 }
const MAX_SHELL_PATHS = 12

// A folder holding one of these is a project root the tree can move to.
const ROOT_MARKERS = ['.git', '.claude', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']
// Skipped in the tree unless something touched sits under them.
const HIDDEN = new Set([
  '.git', 'node_modules', '.DS_Store', '__pycache__', '.venv', 'venv',
  '.next', '.cache', '.pytest_cache', '.mypy_cache',
])
const MAX_PER_DIR = 30
// How long the last file touched keeps its highlight.
const FLASH_MS = 8000
const BAND_COLUMN = 30
const MAX_STEPS = 12
// Commits the git graph shows, and how long a reading of the repository
// stands before a file tool's call reads it again.
const GIT_COMMITS = 6
const GIT_FRESH_MS = 3000
// Graph columns cycle through these.
const GRAPH_COLORS = ['#7aa2f7', '#bb9af7', '#9ece6a', '#7dcfff', '#e0af68']

// Tokyo Night (night).
const C = {
  fg: '#c0caf5',
  comment: '#565f89',
  line: '#3b4261',
  blue: '#7aa2f7',
  cyan: '#7dcfff',
  purple: '#bb9af7',
  green: '#9ece6a',
  teal: '#73daca',
  yellow: '#e0af68',
  orange: '#ff9e64',
  red: '#f7768e',
  cursorLine: '#292e42',
  visual: '#283457',
  badgeText: '#1a1b26',
}

const EXT_COLORS: Record<string, string> = {
  py: C.yellow, ts: C.blue, tsx: C.blue, js: C.yellow, jsx: C.cyan,
  json: C.yellow, jsonl: C.yellow, md: C.cyan, sh: C.green, zsh: C.green,
  toml: C.purple, yaml: C.purple, yml: C.purple, lua: C.blue, rs: C.orange,
  go: C.cyan, swift: C.orange, html: C.orange, css: C.purple, csv: C.green,
  txt: C.fg, lock: C.comment, bak: C.comment, log: C.comment,
}

// The badge a row wears while a tool works on it.
const OP_MARKS: Record<Op, { text: string; color: string }> = {
  read: { text: 'R', color: C.teal },
  write: { text: 'W', color: C.orange },
  search: { text: 'S', color: C.purple },
  shell: { text: '$', color: C.yellow },
}

const PLAN_DESCRIPTION = [
  'Shows your plan in the file-tree pane the person keeps beside the chat:',
  'what you are doing now and the steps you intend next (for example',
  '"Write the README", "Commit to main", "Push to owner/repo").',
  'Call it whenever you lay out two or more steps, and again as a step starts',
  'or finishes, passing the whole list each time with each step\'s status.',
  'An empty list clears it. Keep each step under 60 characters.',
].join(' ')

type Row = {
  path: string
  indent: string
  name: string
  tone: 'dir' | 'openDir' | 'file' | 'more' | 'note'
  touched?: TouchedFile
}

// One path a tool call works on, with the root the tree shows it under.
type Tracked = { path: string; op: Op; root: string; existed: boolean }

type RenderEvent = Parameters<EngineInterface['ui']['resolve']>[0]

// The working directory; session.start sets it again on every reload.
let cwd = ''
// Project root per folder, found once.
const roots = new Map<string, string>()

const normalize = (path: string, base: string): string => {
  const full = path.startsWith('/') ? path : `${base}/${path}`
  const parts: string[] = []
  for (const part of full.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }

  return `/${parts.join('/')}`
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/'
const joinPath = (dir: string, name: string) =>
  dir === '/' ? `/${name}` : `${dir}/${name}`
const homeOf = (path: string) => /^\/(Users|home)\/[^/]+/.exec(path)?.[0] ?? ''
const tildify = (path: string) =>
  path.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~')
const isUnder = (path: string, root: string) =>
  path === root || path.startsWith(root === '/' ? '/' : `${root}/`)

const pathOf = (e: unknown): string | undefined => {
  const input = e as { file_path?: unknown; notebook_path?: unknown; path?: unknown }
  const path = input.file_path ?? input.notebook_path ?? input.path

  return typeof path === 'string' && path !== '' ? path : undefined
}

// Words and operators of one line of shell, quotes removed.
const tokenize = (line: string): string[] => {
  const out: string[] = []
  let word = ''
  let hasWord = false
  let quote: string | null = null
  const push = () => {
    if (hasWord) out.push(word)
    word = ''
    hasWord = false
  }
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? ''
    if (quote !== null) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) word += line[++i]
      else word += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      hasWord = true
    } else if (ch === '\\' && i + 1 < line.length) {
      word += line[++i]
      hasWord = true
    } else if (/\s/.test(ch)) {
      push()
    } else if (';|&()'.includes(ch)) {
      push()
      let op = ch
      while (i + 1 < line.length && '|&'.includes(line[i + 1] ?? '')) op += line[++i]
      out.push(op)
    } else if (ch === '>' || ch === '<') {
      // A file descriptor before a redirection (2>) is not a word.
      if (/^\d+$/.test(word)) {
        word = ''
        hasWord = false
      } else {
        push()
      }
      let op = ch
      while (i + 1 < line.length && '<>&'.includes(line[i + 1] ?? '')) op += line[++i]
      out.push(op)
    } else {
      word += ch
      hasWord = true
    }
  }
  push()

  return out
}

// The lines of a command with the bodies of its heredocs left out.
const commandLines = (command: string) => {
  const kept: string[] = []
  let until: string | null = null
  for (const line of command.split('\n')) {
    if (until !== null) {
      if (line.trim() === until) until = null
      continue
    }
    kept.push(line)
    const heredoc = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line)
    if (heredoc?.[1] !== undefined) until = heredoc[1]
  }

  return kept
}

// A best guess at the paths a shell command reads, writes or works in.
const parseShell = (command: string, base: string, home: string) => {
  const vars = new Map<string, string>([['HOME', home]])
  const found: { path: string; op: Op }[] = []
  let dir = base

  const expand = (word: string): string | undefined => {
    if (word.includes('$(') || word.includes('`')) return undefined
    let unknown = false
    let out = word.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (_, braced: string | undefined, bare: string | undefined) => {
        const value = vars.get(braced ?? bare ?? '')
        if (value === undefined) unknown = true

        return value ?? ''
      },
    )
    if (unknown || out.includes('$') || /[*?[\]{}]/.test(out)) return undefined
    if (out === '~' || out.startsWith('~/')) out = home + out.slice(1)

    return out
  }
  const add = (word: string, op: Op, needsSlash: boolean) => {
    const value = expand(word)
    if (value === undefined || value === '' || value.startsWith('-')) return
    if (needsSlash && !value.includes('/')) return
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.includes('=')) return
    const path = normalize(value, dir)
    if (path === '/dev' || path.startsWith('/dev/')) return
    found.push({ path, op })
  }

  for (const line of commandLines(command)) {
    const tokens = tokenize(line)
    let words: string[] = []
    const run = () => {
      let at = 0
      // Leading assignments (NAME=value), and export's, set variables.
      while (at < words.length) {
        const word = words[at] ?? ''
        if (word === 'export') {
          at++
          continue
        }
        const assign = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(word)
        if (assign === null) break
        vars.set(assign[1] ?? '', expand(assign[2] ?? '') ?? '')
        at++
      }
      while (at < words.length && PREFIX_CMDS.has(words[at] ?? '')) at++
      const name = words[at] ?? ''
      const args = words.slice(at + 1)
      words = []
      if (name === '') return
      const plain: string[] = []
      for (let i = 0; i < args.length; i++) {
        const arg = args[i] ?? ''
        if (VALUE_OPTIONS.has(arg) && name !== 'sed') {
          i++
        } else if (arg === '-C' && name === 'git') {
          add(args[i + 1] ?? '', 'shell', false)
          i++
        } else if (!arg.startsWith('-')) {
          plain.push(arg)
        }
      }

      if (name === 'cd') {
        const target = expand(plain[0] ?? '~')
        if (target === undefined) return
        dir = normalize(target === '' ? home : target, dir)
        found.push({ path: dir, op: 'shell' })
      } else if (name === 'sed') {
        const inPlace = args.some(arg => arg === '-i' || arg.startsWith('-i') || arg === '--in-place')
        for (const arg of plain.slice(1)) add(arg, inPlace ? 'write' : 'read', false)
      } else if (READ_CMDS.has(name)) {
        for (const arg of plain.slice(PATTERN_FIRST.has(name) ? 1 : 0)) add(arg, 'read', false)
      } else if (WRITE_CMDS.has(name)) {
        for (const arg of plain) add(arg, 'write', false)
      } else if (COPY_CMDS.has(name)) {
        plain.forEach((arg, index) => add(arg, index === plain.length - 1 ? 'write' : 'read', false))
      } else {
        if (name.includes('/')) add(name, 'shell', true)
        for (const arg of plain) add(arg, 'shell', true)
      }
    }

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] ?? ''
      if (token === '>' || token === '>>' || token === '>|' || token === '&>') {
        add(tokens[i + 1] ?? '', 'write', false)
        i++
      } else if (token.startsWith('>&') || token.startsWith('<<')) {
        // A descriptor copy (>&1) or a heredoc's word: no path.
        i++
      } else if (token === '<') {
        add(tokens[i + 1] ?? '', 'read', false)
        i++
      } else if (/^[;|&()]+$/.test(token)) {
        run()
      } else {
        words.push(token)
      }
    }
    run()
  }

  // One entry per path, its strongest op kept.
  const byPath = new Map<string, Op>()
  for (const one of found) {
    const had = byPath.get(one.path)
    if (had === undefined || OP_RANK[one.op] > OP_RANK[had]) byPath.set(one.path, one.op)
  }

  return [...byPath.entries()].slice(0, MAX_SHELL_PATHS).map(([path, op]) => ({ path, op }))
}

// The session folder for a path inside it; else the nearest project folder
// above the path, stopping short of the home folder; else the path's folder.
const rootFor = async ($: EngineInterface, path: string) => {
  if (isUnder(path, cwd)) return cwd
  const isDir = await $.fs.stat(path).then(stat => stat.kind === 'dir').catch(() => false)
  const start = isDir ? path : parentOf(path)
  const cached = roots.get(start)
  if (cached !== undefined) return cached

  const home = homeOf(cwd)
  let found = start
  search: for (let dir = start; dir !== '/' && dir.length > home.length; dir = parentOf(dir)) {
    for (const marker of ROOT_MARKERS) {
      if (await $.fs.exists(joinPath(dir, marker)).catch(() => false)) {
        found = dir
        break search
      }
    }
  }
  roots.set(start, found)

  return found
}

// Keeps the guesses that lead somewhere: a path that exists, or a write into
// a folder that does.
const placeShell = async ($: EngineInterface, guesses: { path: string; op: Op }[]) => {
  const placed: Tracked[] = []
  for (const guess of guesses) {
    const existed = await $.fs.exists(guess.path).catch(() => false)
    const isPlaced = existed
      || (guess.op === 'write' && (await $.fs.exists(parentOf(guess.path)).catch(() => false)))
    if (isPlaced) placed.push({ ...guess, existed, root: await rootFor($, guess.path) })
  }

  return placed
}

// The path the tree follows: the strongest op, the first among equals.
const focusOf = (tracked: Tracked[]) =>
  tracked.reduce((best, one) => (OP_RANK[one.op] > OP_RANK[best.op] ? one : best))

const begin = async ($: EngineInterface, id: string, tracked: Tracked[]) => {
  const focus = focusOf(tracked)
  const at = await $.clock.now()
  await update($, activity, now => ({
    active: [...now.active, ...tracked.map((one, index) => ({ id: `${id}:${index}`, path: one.path, op: one.op }))].slice(-30),
    last: { path: focus.path, op: focus.op, root: focus.root, at },
  }))
}

const finish = async ($: EngineInterface, id: string, tracked: Tracked[], isDone: boolean) => {
  const focus = focusOf(tracked)
  const at = await $.clock.now()
  await update($, activity, now => ({
    active: now.active.filter(one => !one.id.startsWith(`${id}:`)),
    last: { path: focus.path, op: focus.op, root: focus.root, at },
  }))
  if (isDone) {
    for (const one of tracked) {
      if (one.op !== 'read' && one.op !== 'write') continue
      // Only files get a mark: not a folder made, nor a file removed.
      const isFile = await $.fs.stat(one.path).then(stat => stat.kind === 'file').catch(() => false)
      if (isFile) await record($, one, at)
    }
  }
  // Redraw once the highlight has run its time.
  $.clock.after(FLASH_MS + 100, () => $.ui.invalidate('ui.render'))
}

const record = async ($: EngineInterface, one: Tracked, at: number) => {
  const isRead = one.op === 'read'
  await update($, files, list => {
    const found = list.find(file => file.path === one.path)
    if (found === undefined) {
      const added: TouchedFile = {
        path: one.path,
        root: one.root,
        kind: isRead ? 'read' : one.existed ? 'edited' : 'created',
        reads: isRead ? 1 : 0,
        edits: isRead ? 0 : 1,
        changedAt: at,
      }

      return [...list, added].slice(-300)
    }

    return list.map(file =>
      file.path !== one.path ? file : {
        ...file,
        kind: !isRead && file.kind === 'read' ? 'edited' : file.kind,
        reads: file.reads + (isRead ? 1 : 0),
        edits: file.edits + (isRead ? 0 : 1),
        changedAt: at,
      },
    )
  })
}

const stepsOf = (input: unknown): Step[] => {
  const raw = (input as { steps?: unknown }).steps
  if (!Array.isArray(raw)) return []

  return raw.flatMap((one: unknown): Step[] => {
    const step = one as { text?: unknown; status?: unknown }
    if (typeof step.text !== 'string' || step.text.trim() === '') return []
    const status = step.status === 'active' || step.status === 'done' ? step.status : 'pending'

    return [{ text: step.text.trim().slice(0, 120), status }]
  }).slice(0, MAX_STEPS)
}

const gitRun = ($: EngineInterface, root: string, args: string[]) =>
  $.process.run(['git', '-C', root, ...args], { timeoutMs: 4000 })
    .catch(() => ({ exitCode: 1, stdout: '', stderr: 'git did not run' }))

const UNITS: Record<string, string> = {
  second: 's', minute: 'm', hour: 'h', day: 'd', week: 'w', month: 'mo', year: 'y',
}
// "3 minutes ago" as "3m".
const shortWhen = (text: string) => {
  const parts = /^(\d+) (second|minute|hour|day|week|month|year)s? ago$/.exec(text.trim())

  return parts === null ? text.trim() : `${parts[1]}${UNITS[parts[2] ?? ''] ?? ''}`
}

const readGit = async ($: EngineInterface, root: string): Promise<GitView> => {
  const at = await $.clock.now()
  const view: GitView = {
    root, isRepo: false, branch: '', upstream: '', ahead: 0, behind: 0,
    staged: 0, changed: 0, untracked: 0, branches: [], graph: [], at,
  }
  const status = await gitRun($, root, ['status', '--porcelain=v2', '--branch'])
  if (status.exitCode !== 0) return view
  view.isRepo = true
  for (const line of status.stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) view.branch = line.slice(14)
    else if (line.startsWith('# branch.upstream ')) view.upstream = line.slice(18)
    else if (line.startsWith('# branch.ab ')) {
      const counts = /\+(\d+) -(\d+)/.exec(line)
      view.ahead = Number(counts?.[1] ?? 0)
      view.behind = Number(counts?.[2] ?? 0)
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      if (line[2] !== '.') view.staged++
      if (line[3] !== '.') view.changed++
    } else if (line.startsWith('u ')) view.changed++
    else if (line.startsWith('? ')) view.untracked++
  }

  const log = await gitRun($, root, [
    'log', '--graph', '--color=never', `-n${GIT_COMMITS}`,
    '--format=%x01%h%x02%D%x02%s%x02%cr',
  ])
  view.graph = log.exitCode !== 0 ? [] : log.stdout.split('\n').filter(line => line.trim() !== '')
    .map((line): GraphLine => {
      const [graph = '', rest] = line.split('\u0001')
      if (rest === undefined) return { graph: line.trimEnd() }
      const [hash = '', refs = '', subject = '', when = ''] = rest.split('\u0002')

      return { graph, commit: { hash, refs, subject, when: shortWhen(when) } }
    })

  const heads = await gitRun($, root, [
    'for-each-ref', '--sort=-committerdate', '--count=8', '--format=%(refname:short)', 'refs/heads',
  ])
  view.branches = heads.exitCode !== 0 ? [] : heads.stdout.split('\n').filter(name => name !== '')

  return view
}

// Reads the repository again unless the last reading of the same root is
// fresh; `isForced` after anything that may have changed it.
const refreshGit = async ($: EngineInterface, root: string, isForced: boolean) => {
  const current = await read($, git)
  const now = await $.clock.now()
  if (!isForced && current !== null && current.root === root && now - current.at < GIT_FRESH_MS) return
  const view = await readGit($, root)
  await update($, git, () => view)
}

// A branch chip's press: switch, say how it went, read the repository again.
const switchBranch = async ($: EngineInterface, root: string, name: string) => {
  const ran = await gitRun($, root, ['switch', name])
  const reason = ran.stderr.split('\n').find(line => line.trim() !== '') ?? 'it failed'
  $.ui.toast(ran.exitCode === 0 ? `Switched to ${name}` : `git switch ${name}: ${reason}`)
  await refreshGit($, root, true)
  $.ui.invalidate('ui.render')
}

const walk = async (
  $: EngineInterface,
  dir: string,
  indent: string,
  open: Set<string>,
  byPath: Map<string, TouchedFile>,
  rows: Row[],
) => {
  const entries = await $.fs.list(dir).catch(() => [])
  const visible = entries
    .filter(one => !HIDDEN.has(one.name) || open.has(joinPath(dir, one.name)))
    .sort((a, b) =>
      a.kind === 'dir' && b.kind !== 'dir' ? -1
        : b.kind === 'dir' && a.kind !== 'dir' ? 1
          : a.name.localeCompare(b.name),
    )
  // Past the cap, keep the first entries plus every one that matters.
  const shown = visible.filter((one, index) => {
    const path = joinPath(dir, one.name)

    return index < MAX_PER_DIR || open.has(path) || byPath.has(path)
  })
  const hidden = visible.length - shown.length

  for (const [index, one] of shown.entries()) {
    const isLast = index === shown.length - 1 && hidden === 0
    const path = joinPath(dir, one.name)
    const branch = isLast ? '└ ' : '├ '
    if (one.kind === 'dir') {
      const isOpen = open.has(path)
      rows.push({ path, indent: indent + branch, name: one.name, tone: isOpen ? 'openDir' : 'dir' })
      if (isOpen) {
        await walk($, path, indent + (isLast ? '  ' : '│ '), open, byPath, rows)
      }
    } else {
      rows.push({ path, indent: indent + branch, name: one.name, tone: 'file', touched: byPath.get(path) })
    }
  }
  if (hidden > 0) {
    rows.push({ path: '', indent: `${indent}└ `, name: `${hidden} more`, tone: 'more' })
  }
}

// Keeps the row in focus on screen when the tree is taller than the room.
const windowRows = (rows: Row[], room: number, focus: string | undefined) => {
  if (rows.length <= room) return rows
  const inner = Math.max(1, room - 2)
  const at = Math.max(0, rows.findIndex(row => row.path === focus))
  const start = Math.min(Math.max(0, at - Math.floor(inner / 2)), rows.length - inner)
  const end = start + inner
  const more = (count: number, arrow: string): Row =>
    ({ path: '', indent: '', name: `${arrow} ${count} more`, tone: 'more' })

  return [
    ...(start > 0 ? [more(start, '↑')] : []),
    ...rows.slice(start, end),
    ...(end < rows.length ? [more(rows.length - end, '↓')] : []),
  ]
}

const changeColor = (file: TouchedFile) =>
  file.kind === 'created' ? C.green : file.kind === 'edited' ? C.orange : C.teal

const fileColor = (name: string) => {
  if (name.startsWith('.')) return C.comment
  const dot = name.lastIndexOf('.')

  return dot > 0 ? EXT_COLORS[name.slice(dot + 1).toLowerCase()] ?? C.fg : C.fg
}

const countsOf = (touched: TouchedFile[]) => ({
  added: touched.filter(one => one.kind === 'created').length,
  changed: touched.filter(one => one.kind === 'edited').length,
  read: touched.filter(one => one.kind === 'read').length,
})

const show = async ($: EngineInterface, next: Layout) => {
  await update($, layout, () => next)
  await $.store.set('layout', next)
  if (next === 'side') return $.ui.open({ id: PANE, title: 'Files' })
  await $.ui.close({ id: PANE })

  return { isPlaced: true as const }
}

// The plan's rows: the last two steps done, then the rest; one line when
// `isCompact`.
const drawPlan = async ($: EngineInterface, e: RenderEvent, width: number, isCompact: boolean) => {
  const { Box, Text } = $.ui.resolve(e)
  const { steps } = await read($, plan)
  if (steps.length === 0) return []
  const done = steps.filter(step => step.status === 'done')
  const shown = [...done.slice(-2), ...steps.filter(step => step.status !== 'done')]
  const glyph = (step: Step) => (step.status === 'done' ? '✓' : step.status === 'active' ? '▸' : '○')
  const color = (step: Step) =>
    step.status === 'done' ? C.comment : step.status === 'active' ? C.orange : C.fg

  if (isCompact) {
    return [
      <Text wrap="truncate-end">
        <Text color={C.purple} bold>next </Text>
        {shown.filter(step => step.status !== 'done').map(step => (
          <Text color={color(step)} bold={step.status === 'active'}>{`${glyph(step)} ${step.text}  `}</Text>
        ))}
      </Text>,
    ]
  }

  return [
    <Text color={C.purple} bold>{`next  ${done.length}/${steps.length}`}</Text>,
    ...shown.map(step => (
      <Box width={width} backgroundColor={step.status === 'active' ? C.visual : undefined}>
        <Text wrap="truncate-end">
          <Text color={step.status === 'active' ? C.orange : C.comment}>{`${glyph(step)} `}</Text>
          <Text color={color(step)} bold={step.status === 'active'} strikethrough={step.status === 'done'}>
            {step.text}
          </Text>
        </Text>
      </Box>
    )),
    <Text color={C.line}>{'─'.repeat(Math.max(1, width))}</Text>,
  ]
}

// The git section: a rule, the branch and its counts, the graph of recent
// commits, and a chip per local branch that switches to it; one line and the
// chips when `isCompact`. Nothing outside a repository.
const drawGit = async ($: EngineInterface, e: RenderEvent, width: number, root: string, isCompact: boolean) => {
  const { Box, Button, Text } = $.ui.resolve(e)
  const view = await read($, git)
  if (view === null || !view.isRepo || view.root !== root) return []

  const sync = [
    view.ahead > 0 ? <Text color={C.cyan}>{` ↑${view.ahead}`}</Text> : null,
    view.behind > 0 ? <Text color={C.red}>{` ↓${view.behind}`}</Text> : null,
  ]
  const isClean = view.staged + view.changed + view.untracked === 0
  const counts = isClean
    ? [<Text color={C.green}>clean</Text>]
    : [
        view.staged > 0 ? <Text color={C.green}>{`+${view.staged} `}</Text> : null,
        view.changed > 0 ? <Text color={C.orange}>{`~${view.changed} `}</Text> : null,
        view.untracked > 0 ? <Text color={C.comment}>{`?${view.untracked}`}</Text> : null,
      ]
  const branchLine = (
    <Box flexDirection="row" justifyContent="space-between" width={width}>
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          <Text color={C.purple} bold>git </Text>
          <Text color={C.green} bold>{view.branch}</Text>
          {view.upstream !== '' && <Text color={C.comment}>{` → ${view.upstream}`}</Text>}
          {sync}
        </Text>
      </Box>
      <Box flexShrink={0} paddingLeft={1}>
        <Text>{counts}</Text>
      </Box>
    </Box>
  )
  const chips = view.branches.length < 2 ? [] : [
    <Box flexDirection="row" flexWrap="wrap" columnGap={2} width={width}>
      {view.branches.map(name => {
        const isCurrent = name === view.branch

        return (
          <Button key={`branch:${name}`} label={name} plain onPress={() => switchBranch($, view.root, name)}>
            <Text color={isCurrent ? C.green : C.comment} bold={isCurrent}>{`${isCurrent ? '●' : '○'} ${name}`}</Text>
          </Button>
        )
      })}
    </Box>,
  ]

  if (isCompact) {
    const head = view.graph.find(line => line.commit !== undefined)?.commit

    return [
      <Box flexDirection="row" columnGap={3} width={width}>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            <Text color={C.purple} bold>git </Text>
            <Text color={C.green} bold>{view.branch}</Text>
            {sync}
            <Text>{'  '}</Text>
            {counts}
            {head !== undefined && <Text color={C.yellow}>{`  ${head.hash} `}</Text>}
            {head !== undefined && <Text color={C.fg}>{head.subject}</Text>}
          </Text>
        </Box>
        <Box flexShrink={0}>{chips}</Box>
      </Box>,
    ]
  }

  const graph = view.graph.map(line => {
    const drawing = [...line.graph].map((ch, index) => (
      <Text color={ch === ' ' ? undefined : GRAPH_COLORS[Math.floor(index / 2) % GRAPH_COLORS.length]} bold={ch === '*'}>
        {ch}
      </Text>
    ))
    const commit = line.commit
    if (commit === undefined) return <Text wrap="truncate-end">{drawing}</Text>

    return (
      <Box flexDirection="row" justifyContent="space-between" width={width}>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            {drawing}
            <Text color={C.yellow}>{commit.hash}</Text>
            {commit.refs !== '' && <Text color={C.cyan} bold>{` (${commit.refs})`}</Text>}
            <Text color={C.fg}>{` ${commit.subject}`}</Text>
          </Text>
        </Box>
        <Box flexShrink={0} paddingLeft={1}>
          <Text color={C.comment}>{commit.when}</Text>
        </Box>
      </Box>
    )
  })

  return [
    <Text color={C.line}>{'─'.repeat(Math.max(1, width))}</Text>,
    branchLine,
    ...graph,
    ...chips,
  ]
}

// The tree of the folder the latest activity is in, its rows windowed to
// the room, with the header and footer around it.
const drawTree = async ($: EngineInterface, e: RenderEvent, width: number, room: number) => {
  const { Box, Text } = $.ui.resolve(e)
  const touched = await read($, files)
  const { active, last } = await read($, activity)
  const now = await $.clock.now()
  const root = last?.root ?? cwd
  const here = touched.filter(one => one.root === root)
  const elsewhere = new Map<string, TouchedFile[]>()
  for (const one of touched) {
    if (one.root !== root) elsewhere.set(one.root, [...(elsewhere.get(one.root) ?? []), one])
  }

  // Expand every folder that leads to something touched or in progress.
  const open = new Set<string>([root])
  const leads = [
    ...here.map(one => one.path),
    ...active.map(one => one.path),
    ...(last === null ? [] : [last.path]),
  ].filter(path => isUnder(path, root))
  for (const path of leads) {
    for (let dir = parentOf(path); isUnder(dir, root) && dir !== root; dir = parentOf(dir)) {
      open.add(dir)
    }
  }

  const rows: Row[] = []
  await walk($, root, '', open, new Map(here.map(one => [one.path, one])), rows)
  const footer = [...elsewhere.entries()].slice(0, 3)
  const focus = active.at(-1)?.path ?? last?.path
  const shown = windowRows(rows, Math.max(3, room - 1 - footer.length), focus)

  const view = shown.map(row => {
    const file = row.touched
    const running = active.findLast(one => one.path === row.path)
    const isRecent = running === undefined && last !== null
      && last.path === row.path && now - last.at < FLASH_MS
    const background = running !== undefined ? C.visual : isRecent ? C.cursorLine : undefined
    const icon = row.tone === 'openDir' ? '▾ ' : row.tone === 'dir' ? '▸ ' : ''
    const nameColor =
      row.tone === 'openDir' || row.tone === 'dir' ? C.blue
        : row.tone === 'more' || row.tone === 'note' ? C.comment
          : file !== undefined ? changeColor(file)
            : fileColor(row.name)
    const letter = file === undefined ? ''
      : file.kind === 'created' ? 'A' : file.kind === 'edited' ? 'M' : 'R'
    const times = file === undefined ? 0 : file.kind === 'read' ? file.reads : file.edits
    const mark = running !== undefined ? OP_MARKS[running.op]
      : file !== undefined
        ? { text: `${letter}${times > 1 ? times : ''}`, color: changeColor(file) }
        : undefined

    return (
      <Box flexDirection="row" justifyContent="space-between" width={width} backgroundColor={background}>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            <Text color={C.line}>{row.indent}</Text>
            {icon !== '' && <Text color={row.tone === 'openDir' ? C.blue : C.comment}>{icon}</Text>}
            <Text
              color={nameColor}
              bold={row.tone === 'openDir' || running !== undefined || isRecent
                || (file !== undefined && file.kind !== 'read')}
            >
              {row.name}
            </Text>
          </Text>
        </Box>
        {mark !== undefined && (
          <Box flexShrink={0} paddingLeft={1}>
            {running !== undefined
              ? <Text backgroundColor={mark.color} color={C.badgeText} bold>{` ${mark.text} `}</Text>
              : <Text color={mark.color}>{mark.text}</Text>}
          </Box>
        )}
      </Box>
    )
  })

  const counts = countsOf(here)
  const totals = (
    <Text>
      {counts.changed > 0 && <Text color={C.orange}>{`M${counts.changed} `}</Text>}
      {counts.added > 0 && <Text color={C.green}>{`A${counts.added} `}</Text>}
      {counts.read > 0 && <Text color={C.teal}>{`R${counts.read}`}</Text>}
    </Text>
  )
  const header = (
    <Box flexDirection="row" justifyContent="space-between" width={width}>
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          <Text color={C.purple} bold>{tildify(root)}</Text>
          {root !== cwd && <Text color={C.comment} italic>{`  away from ${tildify(cwd)}`}</Text>}
        </Text>
      </Box>
      <Box flexShrink={0} paddingLeft={1}>{totals}</Box>
    </Box>
  )
  const lines = footer.map(([other, list]) => {
    const c = countsOf(list)
    const parts = [
      c.changed > 0 ? `M${c.changed}` : '',
      c.added > 0 ? `A${c.added}` : '',
      c.read > 0 ? `R${c.read}` : '',
    ].filter(part => part !== '').join(' ')

    return (
      <Text color={C.comment} wrap="truncate-end">{`also ${tildify(other)}  ${parts}`}</Text>
    )
  })

  return { header, view, lines }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = normalize(e.cwd, '/')
    roots.clear()
    await $.command.register({
      name: 'file-tree',
      description: 'File tree of this folder: /file-tree side, /file-tree band',
    })
    await $.tool.register({
      name: 'plan',
      description: PLAN_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: 'The whole plan in order, each step with its status',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'The step, under 60 characters' },
                status: { type: 'string', enum: ['pending', 'active', 'done'] },
              },
              required: ['text', 'status'],
            },
          },
        },
        required: ['steps'],
      },
    })
    const saved = await $.store.get('layout').catch(() => undefined)
    const start: Layout = saved === 'band' ? 'band' : 'side'
    await update($, layout, () => start)
    if (start === 'side') void $.ui.open({ id: PANE, title: 'Files' })
    await refreshGit($, cwd, true)

    return next(e)
  })

  on('command.run', { command: 'file-tree' }, async ($, e) => {
    const asked = e.args.trim().toLowerCase()
    const current = await read($, layout)
    const wanted: Layout =
      asked === 'band' || asked === 'horizontal' ? 'band'
        : asked === 'side' || asked === 'vertical' ? 'side'
          : current
    const shown = await show($, wanted)

    return {
      text: !shown.isPlaced
        ? `File tree pane is waiting: ${shown.reason}`
        : wanted === 'band'
          ? 'File tree shown as a band above the prompt. /file-tree side for the side pane.'
          : 'File tree shown in the side pane. /file-tree band for a band above the prompt.',
    }
  })

  on('tool.call', { tool: PLAN_TOOL }, async ($, e) => {
    const steps = stepsOf(e)
    const at = await $.clock.now()
    await update($, plan, () => ({ steps, at }))
    const text = steps.length === 0
      ? 'Plan cleared from the file-tree pane.'
      : `Plan shown in the file-tree pane: ${steps.length} steps.`

    return { result: text, text }
  })

  on('tool.call', async ($, e, next) => {
    if (cwd === '' || e.tool === PLAN_TOOL) return next(e)

    const op = TOOL_OPS[e.tool]
    let tracked: Tracked[] = []
    if (e.tool === 'Bash') {
      const command = (e as unknown as { command?: unknown }).command
      if (typeof command === 'string') {
        tracked = await placeShell($, parseShell(command, cwd, homeOf(cwd)))
      }
    } else if (op !== undefined) {
      const raw = pathOf(e) ?? (op === 'search' ? cwd : undefined)
      if (raw !== undefined) {
        const path = normalize(raw, cwd)
        const existed = op === 'write' ? await $.fs.exists(path).catch(() => true) : true
        tracked = [{ path, op, root: await rootFor($, path), existed }]
      }
    }
    if (tracked.length === 0) {
      const ran = await next(e)
      if (e.tool === 'Bash') {
        // A shell command may add or remove files, or commit and switch.
        const { last } = await read($, activity)
        await refreshGit($, last?.root ?? cwd, true)
        $.ui.invalidate('ui.render')
      }

      return ran
    }

    await begin($, e.tool_use_id, tracked)
    const ran = await next(e)
    // A shell command that exits non-zero may still have written its files.
    const isDone = ran.deny === undefined && (e.tool === 'Bash' || ran.isError !== true)
    await finish($, e.tool_use_id, tracked, isDone)
    const isChange = e.tool === 'Bash' || tracked.some(one => one.op === 'write')
    await refreshGit($, focusOf(tracked).root, isChange)

    return ran
    // The tree is bookkeeping: a failure here never stops the tool.
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    if (cwd === '') return <Text color={C.comment}>Waiting for the session to start.</Text>

    const width = e.props.bodyColumns
    const { last } = await read($, activity)
    const planRows = await drawPlan($, e, width, false)
    const gitRows = await drawGit($, e, width, last?.root ?? cwd, false)
    const room = e.props.scroll.bodyRows - planRows.length - gitRows.length
    const { header, view, lines } = await drawTree($, e, width, room)

    return (
      <Box flexDirection="column" width={width}>
        {planRows}
        {header}
        {view}
        {lines}
        {gitRows}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (cwd === '' || e.props.hasSurvey || (await read($, layout)) !== 'band') return next(e)

    const { Box } = $.ui.resolve(e)
    const width = e.props.bodyColumns
    const columns = Math.max(1, Math.floor(width / BAND_COLUMN))
    const columnWidth = Math.floor(width / columns) - 1
    const { last } = await read($, activity)
    const planRows = await drawPlan($, e, width, true)
    const gitRows = await drawGit($, e, width, last?.root ?? cwd, true)
    const perColumn = Math.max(3, e.props.scroll.bodyRows - 2 - planRows.length - gitRows.length)
    const { header, view, lines } = await drawTree($, e, columnWidth, perColumn * columns + 1)
    const height = Math.max(1, Math.ceil(view.length / columns))
    const stacks = Array.from({ length: columns }, (_, index) =>
      view.slice(index * height, (index + 1) * height),
    ).filter(stack => stack.length > 0)

    return (
      <Box flexDirection="column" width={width}>
        {planRows}
        <Box width={Math.min(width, columnWidth * 2)}>{header}</Box>
        <Box flexDirection="row" columnGap={1}>
          {stacks.map(stack => (
            <Box flexDirection="column" width={columnWidth}>{stack}</Box>
          ))}
        </Box>
        {lines}
        {gitRows}
      </Box>
    )
  })
}
