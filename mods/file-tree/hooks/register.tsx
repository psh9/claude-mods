import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { Activity, Chat, Explore, GitView, GraphLine, History, Hit, Layout, Op, Plan, Search, Step, TouchedFile, Turn } from '../types'

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
const chats = atom({ plugin: 'file-tree', key: 'chats' } as const, { current: '', nodes: [] }, {
  shape: 'chats-1',
})
const FOLLOWING: Explore = { root: null, open: [], cursor: '', on: 'tree', isAsking: false }
const explore = atom({ plugin: 'file-tree', key: 'explore' } as const, FOLLOWING, {
  shape: 'explore-1',
})
const search = atom({ plugin: 'file-tree', key: 'search' } as const, null, {
  shape: 'search-1',
})
const LATEST: History = { turns: [], cursor: -1, isOpen: false }
const history = atom({ plugin: 'file-tree', key: 'history' } as const, LATEST, {
  shape: 'history-1',
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
// Conversation branches: kept in the store, since /branch moves the process
// to a new session; the commands that make one; and how many the pane lists.
const CHATS_KEY = 'chats'
const MAX_CHATS = 200
// Each conversation's plan, so it outlives a restart and a branch starts
// with its parent's.
const PLANS_KEY = 'plans'
const MAX_PLANS = 100
const MAX_CHAT_ROWS = 8
// The prompt history: prompts listed at once, and the lines an opened one
// shows of itself and of Claude's answer.
const MAX_TURN_ROWS = 6
const MAX_PROMPT_LINES = 8
const MAX_REPLY_LINES = 4
const MAX_PROMPT_CHARS = 2000
const MAX_REPLY_CHARS = 800
const BRANCH_COMMANDS = new Set(['branch', 'fork'])
// Search: hits kept, matches per file, and the share of the pane's room the
// results take beside the tree (more while the cursor is in them).
const MAX_HITS = 500
const MAX_PER_FILE = 50
const SEARCH_SHARE = 0.4
const SEARCH_SHARE_ON = 0.6
const GREP_INPUT = 'grep'
// Never searched into, as the tree hides them.
// grep and rg options whose value is the next word.
const SEARCH_VALUE_OPTIONS = new Set([
  '-m', '--max-count', '-A', '-B', '-C', '-g', '--glob', '-t', '--type', '-T', '--type-not',
  '-f', '--file', '--include', '--exclude', '--exclude-dir', '-M', '--max-columns', '-j', '--threads',
])
const SEARCH_EXCLUDE = ['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.next', '.cache']

// Opens a file in vim (or $VISUAL, $EDITOR) beside Claude Code: in a new tmux
// window when Claude Code runs in tmux, else a new Windows Terminal tab under
// WSL. A mod's process has no terminal, so vim cannot run in this one.
// Exits 3 with nowhere to open it, 4 with no editor.
const OPEN_SCRIPT = `
file=$1 line=$2 dir=$3
ed=$(command -v "\${VISUAL:-\${EDITOR:-vim}}" || command -v vim || command -v vi) || exit 4
if [ -n "$TMUX" ] && command -v tmux >/dev/null 2>&1; then
  tmux new-window -c "$dir" "$ed" "+$line" "$file" && echo tmux && exit 0
fi
if [ -n "$WSL_DISTRO_NAME" ] && command -v wt.exe >/dev/null 2>&1; then
  wt.exe -w 0 new-tab --title "\${file##*/}" wsl.exe -d "$WSL_DISTRO_NAME" --cd "$dir" -- "$ed" "+$line" "$file" && echo 'Windows Terminal' && exit 0
fi
exit 3
`

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
  selection: '#364a82',
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

const isChat = (one: unknown): one is Chat => {
  const chat = one as Partial<Chat> | null
  if (chat === null || typeof chat !== 'object') return false

  return typeof chat.id === 'string' && (chat.parent === null || typeof chat.parent === 'string')
    && typeof chat.name === 'string' && typeof chat.forkAt === 'number'
    && typeof chat.forkText === 'string' && typeof chat.prompts === 'number'
    && typeof chat.at === 'number'
}

// Every conversation that has a branch or is one, across sessions.
const storedChats = async ($: EngineInterface) => {
  const raw = await $.store.get(CHATS_KEY).catch(() => undefined)

  return Array.isArray(raw) ? raw.filter(isChat) : []
}

const saveChats = ($: EngineInterface, list: Chat[]) =>
  $.store.set(CHATS_KEY, [...list].sort((a, b) => a.at - b.at).slice(-MAX_CHATS))

const rootChat = (id: string, prompts: number, at: number): Chat =>
  ({ id, parent: null, name: 'Root', forkAt: 0, forkText: '', prompts, at })

// The tree `current` belongs to, root first and each branch after its
// parent, the earliest fork first; a conversation never branched is a root
// alone. `prompts` is the current conversation's count now.
const treeOf = (list: Chat[], current: string, prompts: number, at: number): Chat[] => {
  const known = list.find(chat => chat.id === current)
  const all = known === undefined
    ? [...list, rootChat(current, prompts, at)]
    : list.map(chat => (chat.id === current ? { ...chat, prompts } : chat))
  const byId = new Map(all.map(chat => [chat.id, chat]))
  let root = byId.get(current) ?? rootChat(current, prompts, at)
  const climbed = new Set<string>()
  for (let up = root.parent; up !== null && !climbed.has(up); up = root.parent) {
    climbed.add(up)
    const parent = byId.get(up)
    if (parent === undefined) break
    root = parent
  }

  const out: Chat[] = []
  const visit = (chat: Chat) => {
    if (out.some(one => one.id === chat.id)) return
    out.push(chat)
    all.filter(one => one.parent === chat.id && one.id !== chat.id)
      .sort((a, b) => a.forkAt - b.forkAt || a.at - b.at)
      .forEach(visit)
  }
  visit(root)

  return out
}

// The last prompt the person typed, one line of it.
const lastPrompt = (messages: readonly SessionMessage[]) => {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user' || (message.toolResults?.length ?? 0) > 0) continue
    const line = message.text.split('\n').map(one => one.trim())
      .find(one => one !== '' && !one.startsWith('<'))
    if (line !== undefined) return line.slice(0, 120)
  }

  return ''
}

const isPrompt = (message: SessionMessage) =>
  message.role === 'user' && (message.toolResults?.length ?? 0) === 0
  && message.text.split('\n').some(line => line.trim() !== '' && !line.trim().startsWith('<'))

// A prompt's own words: the lines the person typed, not the tags the engine
// wraps around a command or a reminder.
const promptText = (text: string) =>
  text.split('\n').filter(line => !line.trim().startsWith('<')).join('\n').trim()

// The conversation's prompts in order, each with the last text Claude
// answered it with.
const turnsOf = (messages: readonly SessionMessage[]): Turn[] => {
  const out: Turn[] = []
  for (const message of messages) {
    if (isPrompt(message)) {
      out.push({ text: promptText(message.text).slice(0, MAX_PROMPT_CHARS), reply: '' })
      continue
    }
    const turn = out.at(-1)
    if (message.role === 'assistant' && turn !== undefined && message.text.trim() !== '') {
      turn.reply = message.text.trim().slice(0, MAX_REPLY_CHARS)
    }
  }

  return out
}

// Reads the conversation's prompts again; a cursor past the end (a /clear)
// goes back to the latest.
const seeHistory = async ($: EngineInterface) => {
  const messages = await $.session.messages()
  if (!Array.isArray(messages)) return
  const turns = turnsOf(messages)
  await update($, history, now => (now.cursor < turns.length ? { ...now, turns } : { ...LATEST, turns }))
}

// What /branch prints into the conversation it makes.
const BRANCH_NOTICE = /Branched conversation(?: "([^"]*)")?\. You are now in the new branch \(session ([0-9a-f-]+)\)\. Use \/resume ([0-9a-f-]+)/

// The branch `id` is, read off the notice /branch left in its transcript:
// for a branch made while the mod was not loaded to see the command.
const branchFromNotice = (messages: readonly SessionMessage[], id: string) => {
  for (const [index, message] of messages.entries()) {
    const found = BRANCH_NOTICE.exec(message.text)
    if (found === null || found[2] !== id || found[3] === undefined) continue
    const before = messages.slice(0, index)

    return {
      from: found[3],
      name: found[1] ?? '',
      forkAt: before.filter(isPrompt).length,
      forkText: lastPrompt(before),
    }
  }

  return undefined
}

// Conversations whose transcript was already read for a /branch notice.
const scanned = new Set<string>()

// Reads which conversation this is and how far it has got, keeps the count
// of a stored one, and shows its tree.
const seeChat = async ($: EngineInterface) => {
  const id = await $.session.id()
  const prompts = await $.session.turns()
  const at = await $.clock.now()
  let list = await storedChats($)
  if (!list.some(chat => chat.id === id) && !scanned.has(id)) {
    scanned.add(id)
    const messages = await $.session.messages()
    const branch = Array.isArray(messages) ? branchFromNotice(messages, id) : undefined
    if (branch !== undefined && branch.from !== id) {
      await branchChat($, branch.from, id, branch.forkAt, branch.forkText, branch.name)
      list = await storedChats($)
    }
  }
  const known = list.find(chat => chat.id === id)
  if (known !== undefined && known.prompts !== prompts) {
    await saveChats($, list.map(chat => (chat.id === id ? { ...chat, prompts } : chat)))
  }
  const nodes = treeOf(list, id, prompts, at)
  await update($, chats, () => ({ current: id, nodes }))
  await keepPlan($, id, nodes)
}

const storedPlans = async ($: EngineInterface): Promise<Record<string, Plan>> => {
  const raw = await $.store.get(PLANS_KEY).catch(() => undefined)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, Plan> = {}
  for (const [id, one] of Object.entries(raw)) {
    const at = (one as { at?: unknown }).at
    out[id] = { steps: stepsOf(one), at: typeof at === 'number' ? at : 0 }
  }

  return out
}

const savePlan = async ($: EngineInterface, id: string, value: Plan) => {
  const plans = { ...(await storedPlans($)), [id]: value }
  const kept = Object.entries(plans).sort(([, a], [, b]) => a.at - b.at).slice(-MAX_PLANS)
  await $.store.set(PLANS_KEY, Object.fromEntries(kept))
}

// Shows the plan this conversation last had, else the nearest parent's; a
// plan shown before any was stored (an older version's) is stored for it.
const keepPlan = async ($: EngineInterface, id: string, nodes: Chat[]) => {
  const plans = await storedPlans($)
  const shown = await read($, plan)
  if (plans[id] === undefined && shown.steps.length > 0) {
    await savePlan($, id, shown)

    return
  }
  if (shown.steps.length > 0) return
  const byId = new Map(nodes.map(chat => [chat.id, chat]))
  const climbed = new Set<string>()
  for (let at: string | null = id; at !== null && !climbed.has(at); at = byId.get(at)?.parent ?? null) {
    climbed.add(at)
    const found = plans[at]
    if (found !== undefined) {
      if (found.steps.length > 0) await update($, plan, () => found)

      return
    }
  }
}

// A /branch moves the process to a new conversation holding a copy of this
// one: the new one is stored as a branch of this, made after its last prompt.
const branchChat = async ($: EngineInterface, from: string, to: string, forkAt: number, forkText: string, asked: string) => {
  const at = await $.clock.now()
  const list = (await storedChats($)).filter(chat => chat.id !== to)
  const tree = treeOf(list, from, forkAt, at)
  const parent = list.some(chat => chat.id === from) ? [] : [rootChat(from, forkAt, at)]
  const name = asked !== '' ? asked.slice(0, 40) : `branch ${tree.length}`
  await saveChats($, [...list, ...parent, { id: to, parent: from, name, forkAt, forkText, prompts: forkAt, at }])
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

// The conversation's /branch tree: a row per conversation under its parent,
// with how many prompts it shares with the parent and the prompt it forked
// after; the path from the root to this one when `isCompact`.
const drawChats = async ($: EngineInterface, e: RenderEvent, width: number, isCompact: boolean) => {
  const { Box, Text } = $.ui.resolve(e)
  const { current, nodes } = await read($, chats)
  const here = nodes.find(chat => chat.id === current)
  if (here === undefined) return []
  const count = (n: number) => `${n} prompt${n === 1 ? '' : 's'}`
  const branches = nodes.length - 1

  if (isCompact) {
    const path: Chat[] = []
    for (let at: Chat | undefined = here; at !== undefined && !path.includes(at); at = nodes.find(chat => chat.id === at?.parent)) {
      path.unshift(at)
    }

    return [
      <Text wrap="truncate-end">
        <Text color={C.purple} bold>chat </Text>
        {path.map((chat, index) => (
          <Text color={chat === here ? C.green : C.comment} bold={chat === here}>
            {`${index > 0 ? ' › ' : ''}${chat.name}`}
          </Text>
        ))}
        {here.parent !== null && <Text color={C.comment}>{`  shares ${here.forkAt} of ${count(here.prompts)}`}</Text>}
        {branches > 0 && <Text color={C.comment}>{`  ${branches} branch${branches === 1 ? '' : 'es'}`}</Text>}
      </Text>,
    ]
  }

  type Line = { chat: Chat; lead: string; under: string }
  const lines: Line[] = []
  const visit = (chat: Chat, indent: string, isRoot: boolean, isLast: boolean) => {
    const kids = nodes.filter(one => one.parent === chat.id)
    const inner = isRoot ? '' : indent + (isLast ? '  ' : '│ ')
    lines.push({
      chat,
      lead: isRoot ? '' : indent + (isLast ? '└ ' : '├ '),
      under: inner + (kids.length > 0 ? '│ ' : '  '),
    })
    kids.forEach((kid, index) => visit(kid, inner, false, index === kids.length - 1))
  }
  const root = nodes[0]
  if (root !== undefined) visit(root, '', true, true)
  // Past the cap, the rows nearest this conversation stay.
  const at = lines.findIndex(line => line.chat === here)
  const start = Math.min(Math.max(0, at - Math.floor(MAX_CHAT_ROWS / 2)), Math.max(0, lines.length - MAX_CHAT_ROWS))
  const shown = lines.slice(start, start + MAX_CHAT_ROWS)
  const left = lines.length - shown.length

  const rows = shown.flatMap(({ chat, lead, under }) => {
    const isHere = chat === here
    const row = (
      <Box flexDirection="row" justifyContent="space-between" width={width} backgroundColor={isHere ? C.cursorLine : undefined}>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            <Text color={C.line}>{lead}</Text>
            <Text color={isHere ? C.green : C.comment}>{isHere ? '● ' : '○ '}</Text>
            <Text color={isHere ? C.green : C.fg} bold={isHere}>{chat.name}</Text>
            {isHere && <Text color={C.comment} italic>  here</Text>}
          </Text>
        </Box>
        <Box flexShrink={0} paddingLeft={1}>
          <Text color={C.comment}>
            {chat.parent === null ? count(chat.prompts) : `shares ${chat.forkAt} · ${count(chat.prompts)}`}
          </Text>
        </Box>
      </Box>
    )
    if (chat.parent === null || chat.forkText === '') return [row]

    return [
      row,
      <Text wrap="truncate-end">
        <Text color={C.line}>{under}</Text>
        <Text color={C.comment} italic>{`⑂ after "${chat.forkText}"`}</Text>
      </Text>,
    ]
  })

  return [
    <Text color={C.purple} bold>
      {`chats${branches > 0 ? `  ${branches} branch${branches === 1 ? '' : 'es'}` : ''}`}
    </Text>,
    ...rows,
    ...(left > 0 ? [<Text color={C.comment}>{`${left} more`}</Text>] : []),
    <Text color={C.line}>{'─'.repeat(Math.max(1, width))}</Text>,
  ]
}

// Words laid into lines of `width`, a word longer than that cut; at most `max`
// lines, the last ending in an ellipsis when there was more.
const wrapLines = (text: string, width: number, max: number) => {
  const room = Math.max(8, width)
  const lines: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(one => one !== '')) {
      for (let piece = word; piece !== ''; piece = piece.slice(room)) {
        const part = piece.slice(0, room)
        if (line === '') line = part
        else if (line.length + 1 + part.length <= room) line += ` ${part}`
        else {
          lines.push(line)
          line = part
        }
      }
    }
    lines.push(line)
  }
  while (lines.length > 0 && lines.at(-1) === '') lines.pop()
  if (lines.length <= max) return lines
  const kept = lines.slice(0, max)
  kept[max - 1] = `${(kept[max - 1] ?? '').slice(0, room - 1)}…`

  return kept
}

// Opens the prompt `index`, or closes it when it is the one open; the cursor
// keys then walk the history.
const pressTurn = async ($: EngineInterface, index: number) => {
  await update($, history, now => ({
    ...now,
    cursor: index,
    isOpen: !(now.isOpen && now.cursor === index),
  }))
  await update($, explore, (now): Explore => ({ ...now, on: 'chat' }))
}

// This conversation's prompts under the /branch tree: a row per prompt,
// numbered, that a click opens to show it whole and the start of Claude's
// answer. The window holds the latest, or the ones around the cursor.
const drawHistory = async ($: EngineInterface, e: RenderEvent, width: number) => {
  const { Box, Button, Text } = $.ui.resolve(e)
  const { turns, cursor, isOpen } = await read($, history)
  if (turns.length === 0) return []
  const walking = await read($, explore)
  const isOn = walking.on === 'chat'
  const { current, nodes } = await read($, chats)
  const forkAt = nodes.find(chat => chat.id === current && chat.parent !== null)?.forkAt ?? 0
  const at = cursor < 0 ? turns.length - 1 : cursor
  const start = Math.min(Math.max(0, at - Math.floor(MAX_TURN_ROWS / 2)), Math.max(0, turns.length - MAX_TURN_ROWS))
  const numberWidth = String(turns.length).length
  const indent = ' '.repeat(numberWidth + 1)

  const rows = turns.slice(start, start + MAX_TURN_ROWS).flatMap((turn, offset) => {
    const index = start + offset
    const isCursor = index === at && (isOn || cursor >= 0)
    const first = turn.text.split('\n').find(line => line.trim() !== '') ?? ''
    const row = (
      <Box key={`turn:${index}`} width={width} backgroundColor={isCursor ? (isOn ? C.selection : C.cursorLine) : undefined}>
        <Button key={`turn:${index}`} label={`prompt ${index + 1}`} plain onPress={() => pressTurn($, index)}>
          <Text wrap="truncate-end">
            <Text color={isCursor ? C.orange : C.comment}>{`${String(index + 1).padStart(numberWidth)} `}</Text>
            <Text color={index < forkAt ? C.comment : C.fg} bold={isCursor}>{first}</Text>
          </Text>
        </Button>
      </Box>
    )
    const fork = forkAt > 0 && index === forkAt - 1 && index < turns.length - 1
      ? [<Text color={C.comment} italic wrap="truncate-end">{`${indent}⑂ branched here`}</Text>]
      : []
    if (!(isOpen && index === at)) return [row, ...fork]
    const body = wrapLines(turn.text, width - indent.length, MAX_PROMPT_LINES).slice(1)
    const reply = turn.reply === '' ? [] : wrapLines(turn.reply, width - indent.length - 2, MAX_REPLY_LINES)

    return [
      row,
      ...body.map(line => <Text color={C.fg} wrap="truncate-end">{`${indent}${line}`}</Text>),
      ...reply.map((line, n) => (
        <Text wrap="truncate-end">
          <Text color={C.purple}>{n === 0 ? `${indent}⏺ ` : `${indent}  `}</Text>
          <Text color={C.comment}>{line}</Text>
        </Text>
      )),
      ...fork,
    ]
  })
  const above = start
  const below = Math.max(0, turns.length - start - MAX_TURN_ROWS)

  return [
    <Box flexDirection="row" justifyContent="space-between" width={width}>
      <Text color={C.purple} bold>{`history  ${turns.length} prompt${turns.length === 1 ? '' : 's'}`}</Text>
      <Text color={C.comment}>
        {above > 0 || below > 0 ? `${above > 0 ? `↑${above}` : ''}${above > 0 && below > 0 ? ' ' : ''}${below > 0 ? `↓${below}` : ''}` : ''}
      </Text>
    </Box>,
    ...rows,
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

// The tree as it stands: the folder the person explores, else the one the
// latest activity is in; its open folders, its rows, and the row in focus.
const treeModel = async ($: EngineInterface) => {
  const touched = await read($, files)
  const { active, last } = await read($, activity)
  const walking = await read($, explore)
  const root = walking.root ?? last?.root ?? cwd
  const here = touched.filter(one => one.root === root)
  const open = new Set<string>([root])
  if (walking.root !== null) {
    for (const dir of walking.open) if (isUnder(dir, root)) open.add(dir)
  } else {
    // Expand every folder that leads to something touched or in progress.
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
  }
  const rows: Row[] = []
  await walk($, root, '', open, new Map(here.map(one => [one.path, one])), rows)
  const focus = walking.root !== null ? walking.cursor : active.at(-1)?.path ?? last?.path

  return { root, here, touched, open, rows, focus, walking }
}

// The tree of the folder the latest activity is in, its rows windowed to
// the room, with the header and footer around it.
const drawTree = async ($: EngineInterface, e: RenderEvent, width: number, room: number) => {
  const { Box, Text } = $.ui.resolve(e)
  const { active, last } = await read($, activity)
  const now = await $.clock.now()
  const { root, here, touched, rows, focus, walking } = await treeModel($)
  const elsewhere = new Map<string, TouchedFile[]>()
  for (const one of touched) {
    if (one.root !== root) elsewhere.set(one.root, [...(elsewhere.get(one.root) ?? []), one])
  }
  const footer = [...elsewhere.entries()].slice(0, 3)
  const shown = windowRows(rows, Math.max(3, room - 1 - footer.length), focus)
  const cursor = walking.root !== null && walking.on === 'tree' ? walking.cursor : undefined

  const view = shown.map(row => {
    const file = row.touched
    const running = active.findLast(one => one.path === row.path)
    const isRecent = running === undefined && last !== null
      && last.path === row.path && now - last.at < FLASH_MS
    const isCursor = cursor !== undefined && row.path === cursor
    const background = isCursor ? C.selection
      : running !== undefined ? C.visual : isRecent ? C.cursorLine : undefined
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
              bold={isCursor || row.tone === 'openDir' || running !== undefined || isRecent
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
          {walking.root !== null
            ? <Text color={C.comment} italic>  exploring</Text>
            : root !== cwd && <Text color={C.comment} italic>{`  away from ${tildify(cwd)}`}</Text>}
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

  return { header, view, lines, root }
}

const relative = (path: string, root: string) =>
  path === root ? '.' : isUnder(path, root) ? path.slice(root === '/' ? 1 : root.length + 1) : tildify(path)

// `path\0line:text` lines, as rg --null and grep -Z print them.
const parseHits = (stdout: string): Hit[] => {
  const hits: Hit[] = []
  for (const line of stdout.split('\n')) {
    const nul = line.indexOf('\u0000')
    if (nul < 0) continue
    const found = /^(\d+):(.*)$/.exec(line.slice(nul + 1))
    if (found === null) continue
    hits.push({ path: line.slice(0, nul), line: Number(found[1]), text: (found[2] ?? '').trim().slice(0, 300) })
    if (hits.length >= MAX_HITS + 1) break
  }

  return hits
}

type SearchAsk = { pattern: string; path: string; by: Search['by']; glob?: string; ignoreCase?: boolean }

// Lists every line matching `pattern` under `path` with rg, else grep, and
// shows them in the pane.
const runSearch = async ($: EngineInterface, ask: SearchAsk) => {
  const root = await $.fs.stat(ask.path).then(stat => (stat.kind === 'dir' ? ask.path : parentOf(ask.path)))
    .catch(() => parentOf(ask.path))
  const rg = [
    'rg', '--line-number', '--no-heading', '--null', '--color=never', '--sort=path',
    '--max-columns=300', '--max-columns-preview', `--max-count=${MAX_PER_FILE}`,
    ask.ignoreCase === true ? '-i' : '--smart-case',
    ...(ask.glob === undefined ? [] : ['--glob', ask.glob]),
    '-e', ask.pattern, '--', ask.path,
  ]
  const grep = [
    'grep', '-rnIZ', `--max-count=${MAX_PER_FILE}`,
    ...SEARCH_EXCLUDE.map(dir => `--exclude-dir=${dir}`),
    ...(ask.ignoreCase === true ? ['-i'] : []),
    ...(ask.glob === undefined ? [] : [`--include=${ask.glob}`]),
    '-e', ask.pattern, '--', ask.path,
  ]
  const missing = { exitCode: 127, stdout: '', stderr: '' }
  let ran = await $.process.run(rg, { cwd: root, timeoutMs: 15000 }).catch(() => missing)
  if (ran.exitCode === 127) ran = await $.process.run(grep, { cwd: root, timeoutMs: 15000 }).catch(() => missing)
  const hits = parseHits(ran.stdout)
  const error = ran.exitCode > 1 && hits.length === 0
    ? ran.stderr.split('\n').find(line => line.trim() !== '') ?? `search failed (${ran.exitCode})`
    : ''
  const at = await $.clock.now()
  await update($, search, () => ({
    pattern: ask.pattern,
    root,
    by: ask.by,
    hits: hits.slice(0, MAX_HITS),
    isTruncated: hits.length > MAX_HITS,
    cursor: 0,
    error,
    at,
  }))
}

// Claude's grep or rg command: its pattern, the folder or file it searched,
// and whether it ignored case. The first such command of a line.
const shellSearch = (command: string, base: string, home: string): Omit<SearchAsk, 'by'> | undefined => {
  const expand = (word: string) => normalize(word === '~' || word.startsWith('~/') ? home + word.slice(1) : word, dir)
  let dir = base
  for (const line of commandLines(command)) {
    const tokens = tokenize(line)
    for (let i = 0; i < tokens.length; i++) {
      const name = tokens[i] ?? ''
      // A plain `cd dir` moves where later paths are read from.
      const target = tokens[i + 1]
      if (name === 'cd' && target !== undefined && !target.includes('$') && !/^[;|&()]+$/.test(target)) {
        dir = expand(target)
        continue
      }
      if (name !== 'grep' && name !== 'rg' && name !== 'egrep') continue
      if (i > 0 && !/^[;|&()]+$/.test(tokens[i - 1] ?? '') && !PREFIX_CMDS.has(tokens[i - 1] ?? '')) continue
      // A grep reading a pipe searches no files.
      if (i > 0 && tokens[i - 1] === '|') continue
      let pattern: string | undefined
      let ignoreCase = false
      const paths: string[] = []
      for (let j = i + 1; j < tokens.length && !/^[;|&()<>]+$/.test(tokens[j] ?? ''); j++) {
        const arg = tokens[j] ?? ''
        if (arg === '-e' || arg === '--regexp') pattern = tokens[++j]
        else if (arg === '-i' || arg === '--ignore-case' || (/^-[a-zA-Z]+$/.test(arg) && arg.includes('i'))) ignoreCase = true
        else if (SEARCH_VALUE_OPTIONS.has(arg)) j++
        else if (arg.startsWith('-')) continue
        else if (pattern === undefined) pattern = arg
        else paths.push(arg)
      }
      if (pattern === undefined || pattern === '') return undefined
      const first = paths[0] ?? '.'
      if (first.includes('$') || /[*?[\]{}]/.test(first)) return undefined
      const path = expand(first)

      return { pattern, path, ignoreCase }
    }
  }

  return undefined
}

const openInEditor = async ($: EngineInterface, path: string, line: number) => {
  const ran = await $.process.run(
    ['sh', '-c', OPEN_SCRIPT, 'open', path, String(Math.max(1, line)), parentOf(path)],
    { timeoutMs: 10000 },
  ).catch(() => ({ exitCode: 1, stdout: '', stderr: 'sh did not run' }))
  const where = ran.stdout.trim()
  $.ui.toast(
    ran.exitCode === 0 ? `Opened ${relative(path, cwd)} in vim (${where})`
      : ran.exitCode === 3 ? `No tmux or Windows Terminal to open vim in. Run: vim +${line} ${tildify(path)}`
        : ran.exitCode === 4 ? 'No vim found ($VISUAL, $EDITOR, vim or vi)'
          : `vim did not open: ${ran.stderr.trim() || `exit ${ran.exitCode}`}`,
  )
}

// The person's first key takes the tree over from Claude, as it stands.
const takeTree = async ($: EngineInterface): Promise<Explore> => {
  const walking = await read($, explore)
  if (walking.root !== null) return walking
  const model = await treeModel($)
  const first = model.rows.find(row => row.path !== '')?.path ?? model.root
  const cursor = model.focus !== undefined && model.rows.some(row => row.path === model.focus) ? model.focus : first
  const taken: Explore = { ...walking, root: model.root, open: [...model.open], cursor }
  await update($, explore, () => taken)

  return taken
}

const rowAtCursor = async ($: EngineInterface) => {
  await takeTree($)
  const model = await treeModel($)

  return { model, row: model.rows.find(row => row.path !== '' && row.path === model.walking.cursor) }
}

const hitAtCursor = async ($: EngineInterface) => {
  const found = await read($, search)

  return found?.hits[found.cursor]
}

const inSearch = async ($: EngineInterface) =>
  (await read($, explore)).on === 'search' && ((await read($, search))?.hits.length ?? 0) > 0

const inChat = async ($: EngineInterface) =>
  (await read($, explore)).on === 'chat' && (await read($, history)).turns.length > 0

// The prompt under the history's cursor.
const turnAtCursor = async ($: EngineInterface) => {
  const { turns, cursor } = await read($, history)

  return turns[cursor < 0 ? turns.length - 1 : cursor]
}

// j and k: a row down or up, in the list the cursor is in.
const move = async ($: EngineInterface, by: number) => {
  if (await inChat($)) {
    await update($, history, now => {
      const at = now.cursor < 0 ? now.turns.length - 1 : now.cursor

      return { ...now, cursor: Math.min(now.turns.length - 1, Math.max(0, at + by)) }
    })

    return
  }
  if (await inSearch($)) {
    await update($, search, now => (now === null ? now : {
      ...now, cursor: Math.min(now.hits.length - 1, Math.max(0, now.cursor + by)),
    }))

    return
  }
  const { model } = await rowAtCursor($)
  const paths = model.rows.filter(row => row.path !== '').map(row => row.path)
  const at = paths.indexOf(model.walking.cursor)
  const next = paths[Math.min(paths.length - 1, Math.max(0, at < 0 ? 0 : at + by))]
  if (next !== undefined) await update($, explore, now => ({ ...now, cursor: next }))
}

// l: opens the folder under the cursor, or the file in vim.
const openRow = async ($: EngineInterface) => {
  if (await inChat($)) {
    await update($, history, now => ({ ...now, cursor: now.cursor < 0 ? now.turns.length - 1 : now.cursor, isOpen: true }))

    return
  }
  if (await inSearch($)) return editHere($)
  const { row } = await rowAtCursor($)
  if (row === undefined) return
  if (row.tone === 'file') return openInEditor($, row.path, 1)
  await update($, explore, now => ({ ...now, open: [...new Set([...now.open, row.path])] }))
}

// h: closes the folder under the cursor, else the one holding it.
const closeRow = async ($: EngineInterface) => {
  if (await inChat($)) {
    const { isOpen } = await read($, history)
    if (isOpen) await update($, history, now => ({ ...now, isOpen: false }))
    else await update($, explore, (now): Explore => ({ ...now, on: 'tree' }))

    return
  }
  if (await inSearch($)) {
    await update($, explore, (now): Explore => ({ ...now, on: 'tree' }))

    return
  }
  const { model, row } = await rowAtCursor($)
  if (row === undefined) return
  const target = row.tone === 'openDir' ? row.path : parentOf(row.path)
  if (target === model.root || !isUnder(target, model.root)) return
  await update($, explore, now => ({
    ...now,
    cursor: target,
    open: now.open.filter(dir => !isUnder(dir, target)),
  }))
}

// e: the file under the cursor in vim, at the line of a search hit.
const editHere = async ($: EngineInterface) => {
  if (await inChat($)) return $.ui.toast('A prompt, not a file: a puts it back in the prompt box')
  if (await inSearch($)) {
    const hit = await hitAtCursor($)
    if (hit !== undefined) await openInEditor($, hit.path, hit.line)

    return
  }
  const { row } = await rowAtCursor($)
  if (row?.tone === 'file') await openInEditor($, row.path, 1)
  else $.ui.toast('Not a file: l opens a folder')
}

// a: an @-mention of the file under the cursor in the prompt, for Claude.
const mentionHere = async ($: EngineInterface) => {
  if (await inChat($)) {
    const turn = await turnAtCursor($)
    if (turn === undefined) return
    const filled = await $.prompt.fill({ text: turn.text, mode: 'replace' }).catch(() => ({ isFilled: false }))
    $.ui.toast(filled.isFilled ? 'Prompt put back in the prompt box: edit it, or Enter to ask again' : 'Could not reach the prompt box')

    return
  }
  const hit = (await inSearch($)) ? await hitAtCursor($) : undefined
  const path = hit?.path ?? (await rowAtCursor($)).row?.path
  if (path === undefined) return
  const text = `@${relative(path, cwd)}${hit === undefined ? '' : ` (line ${hit.line})`} `
  const filled = await $.prompt.fill({ text, mode: 'insert' }).catch(() => ({ isFilled: false }))
  if (!filled.isFilled) $.ui.toast(`Could not reach the prompt: ${text}`)
}

// n and p: the next or previous file, in the search's hits or among the
// files Claude touched.
const jumpFile = async ($: EngineInterface, by: 1 | -1) => {
  if (await inChat($)) return move($, by)
  if (await inSearch($)) {
    await update($, search, now => {
      if (now === null) return now
      const here = now.hits[now.cursor]?.path
      const order = by === 1 ? now.hits.map((hit, index) => ({ hit, index }))
        : now.hits.map((hit, index) => ({ hit, index })).reverse()
      const start = order.findIndex(one => one.index === now.cursor)
      const found = order.slice(start + 1).find(one => one.hit.path !== here)
      if (found === undefined) return now
      // Backwards, land on that file's first hit.
      const first = now.hits.findIndex(hit => hit.path === found.hit.path)

      return { ...now, cursor: by === 1 ? found.index : first }
    })

    return
  }
  const { model } = await rowAtCursor($)
  const paths = model.here.map(one => one.path).sort()
  if (paths.length === 0) {
    $.ui.toast('No file read or changed here yet')

    return
  }
  const cursor = model.walking.cursor
  const next = by === 1 ? paths.find(path => path > cursor) ?? paths[0]
    : [...paths].reverse().find(path => path < cursor) ?? paths.at(-1)
  if (next === undefined) return
  const dirs: string[] = []
  for (let dir = parentOf(next); isUnder(dir, model.root) && dir !== model.root; dir = parentOf(dir)) dirs.push(dir)
  await update($, explore, now => ({ ...now, cursor: next, open: [...new Set([...now.open, ...dirs])] }))
}

const askGrep = async ($: EngineInterface) => {
  await takeTree($)
  await update($, explore, now => ({ ...now, isAsking: true }))
  await $.ui.focus({ requestId: PANE, key: GREP_INPUT }).catch(() => undefined)
}

const submitGrep = async ($: EngineInterface, pattern: string) => {
  const walking = await update($, explore, now => ({ ...now, isAsking: false }))
  if (pattern.trim() === '') return
  await runSearch($, { pattern, path: walking.root ?? cwd, by: 'person' })
  await update($, explore, (now): Explore => ({ ...now, on: 'search' }))
}

// c: the cursor onto the prompt history, or back to the tree.
const toggleChat = async ($: EngineInterface) => {
  const { turns } = await read($, history)
  if (turns.length === 0) return $.ui.toast('No prompts in this conversation yet')
  await update($, explore, (now): Explore => ({ ...now, on: now.on === 'chat' ? 'tree' : 'chat' }))
}

// y: the prompt under the history's cursor, onto the clipboard.
const copyTurn = async ($: EngineInterface) => {
  const turn = (await inChat($)) ? await turnAtCursor($) : undefined
  if (turn === undefined) return $.ui.toast('y copies a prompt: c to walk the history')
  const copied = await $.ui.copy({ text: turn.text }).catch(() => ({ isCopied: false }))
  $.ui.toast(copied.isCopied ? 'Prompt copied' : 'Could not copy the prompt')
}

const toggleList = async ($: EngineInterface) => {
  const found = await read($, search)
  if (found === null) return $.ui.toast('No search yet: g to grep')
  await takeTree($)
  await update($, explore, (now): Explore => ({ ...now, on: now.on === 'search' ? 'tree' : 'search' }))
}

const clearSearch = async ($: EngineInterface) => {
  if (await inChat($)) {
    await update($, history, now => ({ ...now, cursor: -1, isOpen: false }))
    await update($, explore, (now): Explore => ({ ...now, on: 'tree' }))

    return
  }
  await update($, search, () => null)
  await update($, explore, (now): Explore => ({ ...now, on: 'tree', isAsking: false }))
}

// f: back to following Claude.
const follow = async ($: EngineInterface) => {
  await update($, explore, () => FOLLOWING)
  await update($, history, now => ({ ...now, cursor: -1, isOpen: false }))
}

const KEYS = [
  { hotkey: 'j', label: 'down' },
  { hotkey: 'k', label: 'up' },
  { hotkey: 'l', label: 'open' },
  { hotkey: 'h', label: 'close' },
  { hotkey: 'e', label: 'vim' },
  { hotkey: 'a', label: '@claude' },
  { hotkey: 'g', label: 'grep' },
  { hotkey: 'n', label: 'next file' },
  { hotkey: 'p', label: 'prev file' },
  { hotkey: 't', label: 'tree/hits' },
  { hotkey: 'c', label: 'history' },
  { hotkey: 'y', label: 'copy' },
  { hotkey: 'x', label: 'clear' },
  { hotkey: 'f', label: 'follow' },
] as const

const pressKey = async ($: EngineInterface, hotkey: (typeof KEYS)[number]['hotkey']) => {
  switch (hotkey) {
    case 'j': return move($, 1)
    case 'k': return move($, -1)
    case 'l': return openRow($)
    case 'h': return closeRow($)
    case 'e': return editHere($)
    case 'a': return mentionHere($)
    case 'g': return askGrep($)
    case 'n': return jumpFile($, 1)
    case 'p': return jumpFile($, -1)
    case 't': return toggleList($)
    case 'c': return toggleChat($)
    case 'y': return copyTurn($)
    case 'x': return clearSearch($)
    case 'f': return follow($)
  }
}

// The keys while the pane holds them, else a line saying how to take them.
const drawKeys = async ($: EngineInterface, e: RenderEvent, width: number, isFocused: boolean) => {
  const elements = $.ui.resolve(e)
  const { Box, Button, Text } = elements
  // The mobile app draws no field.
  const Input = 'Input' in elements ? elements.Input : undefined
  const walking = await read($, explore)
  const field = walking.isAsking && Input !== undefined
    ? [
        <Input
          key={GREP_INPUT}
          label="grep "
          placeholder={`pattern, in ${tildify(walking.root ?? cwd)} (empty cancels)`}
          submitLabel="search"
          autoFocus
          onSubmit={(value: string) => void submitGrep($, value)}
        />,
      ]
    : []
  if (!isFocused) {
    return [
      ...field,
      <Text color={C.comment} wrap="truncate-end">ctrl+x tab: explore · j k h l · g grep · e vim · c history</Text>,
    ]
  }

  return [
    ...field,
    <Box flexDirection="row" flexWrap="wrap" columnGap={2} width={width}>
      {KEYS.map(one => (
        <Button key={`key:${one.hotkey}`} label={one.label} hotkey={one.hotkey} plain dimColor onPress={() => void pressKey($, one.hotkey)} />
      ))}
    </Box>,
  ]
}

// The last search's hits under their files, windowed to `room` around the
// cursor; nothing with no search.
const drawSearch = async ($: EngineInterface, e: RenderEvent, width: number, room: number) => {
  const { Box, Text } = $.ui.resolve(e)
  const found = await read($, search)
  if (found === null || room < 2) return []
  const walking = await read($, explore)
  const isOn = walking.on === 'search'
  const fileCount = new Set(found.hits.map(hit => hit.path)).size
  const head = (
    <Box flexDirection="row" justifyContent="space-between" width={width}>
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          <Text color={C.purple} bold>{found.by === 'claude' ? 'claude grep ' : 'grep '}</Text>
          <Text color={C.yellow}>{found.pattern}</Text>
          <Text color={C.comment}>{`  in ${tildify(found.root)}`}</Text>
        </Text>
      </Box>
      <Box flexShrink={0} paddingLeft={1}>
        <Text color={found.error !== '' ? C.red : C.comment}>
          {found.error !== '' ? 'error'
            : `${found.hits.length}${found.isTruncated ? '+' : ''} in ${fileCount} file${fileCount === 1 ? '' : 's'}`}
        </Text>
      </Box>
    </Box>
  )
  const rule = <Text color={C.line}>{'─'.repeat(Math.max(1, width))}</Text>
  if (found.error !== '' || found.hits.length === 0) {
    return [rule, head, <Text color={C.comment} wrap="truncate-end">{found.error !== '' ? found.error : 'no matches'}</Text>]
  }

  type Line = { hit?: Hit; index: number; path: string }
  const lines: Line[] = []
  found.hits.forEach((hit, index) => {
    if (found.hits[index - 1]?.path !== hit.path) lines.push({ index, path: hit.path })
    lines.push({ hit, index, path: hit.path })
  })
  const inner = Math.max(1, room - 2)
  const at = lines.findIndex(line => line.hit !== undefined && line.index === found.cursor)
  const start = Math.min(Math.max(0, at - Math.floor(inner / 2)), Math.max(0, lines.length - inner))
  const shown = lines.slice(start, start + inner)
  const numberWidth = String(Math.max(...found.hits.map(hit => hit.line))).length

  return [
    rule,
    head,
    ...shown.map(line => {
      if (line.hit === undefined) {
        return <Text color={C.cyan} bold wrap="truncate-end">{relative(line.path, found.root)}</Text>
      }
      const isCursor = isOn && line.index === found.cursor

      return (
        <Box width={width} backgroundColor={isCursor ? C.selection : undefined}>
          <Text wrap="truncate-end">
            <Text color={isCursor ? C.orange : C.comment}>{`  ${String(line.hit.line).padStart(numberWidth)} `}</Text>
            <Text color={C.fg} bold={isCursor}>{line.hit.text}</Text>
          </Text>
        </Box>
      )
    }),
  ]
}

// Claude's Grep, or a grep or rg command it ran: the same search again,
// every matching line listed in the pane. A search of the person's that the
// cursor is in stays.
const showClaudeSearch = async ($: EngineInterface, e: { tool: string }) => {
  let ask: SearchAsk | undefined
  if (e.tool === 'Grep') {
    const input = e as unknown as { pattern?: unknown; path?: unknown; glob?: unknown; '-i'?: unknown }
    if (typeof input.pattern !== 'string' || input.pattern === '') return
    ask = {
      pattern: input.pattern,
      path: normalize(typeof input.path === 'string' && input.path !== '' ? input.path : cwd, cwd),
      glob: typeof input.glob === 'string' && input.glob !== '' ? input.glob : undefined,
      ignoreCase: input['-i'] === true,
      by: 'claude',
    }
  } else if (e.tool === 'Bash') {
    const command = (e as unknown as { command?: unknown }).command
    const found = typeof command === 'string' ? shellSearch(command, cwd, homeOf(cwd)) : undefined
    if (found !== undefined) ask = { ...found, by: 'claude' }
  }
  if (ask === undefined) return
  const walking = await read($, explore)
  const current = await read($, search)
  if (current?.by === 'person' && walking.on === 'search') return
  await runSearch($, ask)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = normalize(e.cwd, '/')
    roots.clear()
    await $.command.register({
      name: 'file-tree',
      description: 'File tree of this folder: /file-tree side, /file-tree band, /file-tree grep <pattern>',
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
    await seeChat($).catch(() => undefined)
    await seeHistory($).catch(() => undefined)

    return next(e)
  })

  // /branch: the conversation before is the parent, the one after the branch.
  on('command.run', async ($, e, next) => {
    if (!BRANCH_COMMANDS.has(e.command)) return next(e)
    const from = await $.session.id()
    const forkAt = await $.session.turns()
    const messages = await $.session.messages()
    const forkText = Array.isArray(messages) ? lastPrompt(messages) : ''
    const ran = await next(e)
    const to = await $.session.id()
    if (to !== from) await branchChat($, from, to, forkAt, forkText, e.args.trim())
    await seeChat($)
    await seeHistory($).catch(() => undefined)

    return ran
  }).catch(($, e, next) => next(e))

  // /cd moves the session folder: the tree and git follow it, as on session start.
  on('command.run', { command: 'cd' }, async ($, e, next) => {
    if (cwd === '') return next(e)
    const ran = await next(e)
    const word = e.args.trim().replace(/^(['"])(.*)\1$/, '$2')
    const target = word === '' ? homeOf(cwd) || '/' : word.replace(/^~(?=\/|$)/, homeOf(cwd))
    const dir = normalize(target, cwd)
    if (await $.fs.exists(dir).catch(() => false)) {
      cwd = dir
      roots.clear()
      await refreshGit($, cwd, true)
      $.ui.invalidate('ui.render')
    }

    return ran
  }).catch(($, e, next) => next(e))

  // Counts the prompt just answered; and a /clear starts another conversation.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      await seeChat($).catch(() => undefined)
      await seeHistory($).catch(() => undefined)
    }

    return done
  })

  on('command.run', { command: 'file-tree' }, async ($, e) => {
    const grep = /^grep\s+(.+)$/s.exec(e.args.trim())
    if (grep?.[1] !== undefined) {
      const walking = await read($, explore)
      await runSearch($, { pattern: grep[1], path: walking.root ?? cwd, by: 'person' })
      await update($, explore, (now): Explore => ({ ...now, on: 'search' }))
      const found = await read($, search)
      await show($, await read($, layout))

      return { text: `grep ${grep[1]}: ${found?.hits.length ?? 0} lines in the file-tree pane. ctrl+x tab, then j k to walk them, e to open in vim.` }
    }
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
    const id = await $.session.id().catch(() => '')
    if (id !== '') await savePlan($, id, { steps, at }).catch(() => undefined)
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
      void showClaudeSearch($, e).catch(() => undefined)
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
    void showClaudeSearch($, e).catch(() => undefined)
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
    const walking = await read($, explore)
    const planRows = await drawPlan($, e, width, false)
    const chatRows = [...(await drawChats($, e, width, false)), ...(await drawHistory($, e, width))]
    const gitRows = await drawGit($, e, width, walking.root ?? last?.root ?? cwd, false)
    const keyRows = await drawKeys($, e, width, e.props.isFocused)
    // The key row wraps: as many lines as its buttons fill.
    const keyWidth = KEYS.reduce((sum, one) => sum + one.label.length + 3, 0) + 2 * (KEYS.length - 1)
    const keyHeight = keyRows.length + (e.props.isFocused ? Math.ceil(keyWidth / Math.max(1, width)) - 1 : 0)
    const room = e.props.scroll.bodyRows - planRows.length - chatRows.length - gitRows.length - keyHeight
    const share = walking.on === 'search' ? SEARCH_SHARE_ON : SEARCH_SHARE
    const searchRows = await drawSearch($, e, width, Math.floor(room * share))
    const { header, view, lines } = await drawTree($, e, width, room - searchRows.length)

    return (
      <Box flexDirection="column" width={width}>
        {planRows}
        {chatRows}
        {header}
        {view}
        {lines}
        {searchRows}
        {gitRows}
        {keyRows}
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
    const chatRows = await drawChats($, e, width, true)
    const gitRows = await drawGit($, e, width, last?.root ?? cwd, true)
    const perColumn = Math.max(3, e.props.scroll.bodyRows - 2 - planRows.length - chatRows.length - gitRows.length)
    const { header, view, lines } = await drawTree($, e, columnWidth, perColumn * columns + 1)
    const height = Math.max(1, Math.ceil(view.length / columns))
    const stacks = Array.from({ length: columns }, (_, index) =>
      view.slice(index * height, (index + 1) * height),
    ).filter(stack => stack.length > 0)

    return (
      <Box flexDirection="column" width={width}>
        {planRows}
        {chatRows}
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
