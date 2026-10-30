import { expect, test } from 'claude-code/testing'

const SITE = { isFocused: false, bodyColumns: 60, scroll: { offset: 0, bodyRows: 30 }, view: {} }
const PANE = {
  plugin: 'file-tree',
  component: 'Pane',
  requestId: 'file-tree',
  props: { ...SITE, title: 'Files', placement: 'dock' },
} as const
const BAND = {
  plugin: 'file-tree',
  component: 'AbovePrompt',
  props: { ...SITE, hasSurvey: false, isWorking: false, maxRows: 12 },
} as const

const DIRS: Record<string, { name: string; kind: 'file' | 'dir' }[]> = {
  '/Users/me/.claude': [
    { name: 'settings.json', kind: 'file' },
    { name: 'skills', kind: 'dir' },
    { name: 'context-bar', kind: 'dir' },
  ],
  '/Users/me/.claude/context-bar': [{ name: 'statusline.py', kind: 'file' }],
  '/Users/me/proj': [{ name: 'src', kind: 'dir' }, { name: 'README.md', kind: 'file' }],
  '/Users/me/proj/src': [{ name: 'main.py', kind: 'file' }],
}
const MARKER = /\/(\.git|\.claude|package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/

const EDIT = {
  tool: 'Edit',
  file_path: '/Users/me/.claude/context-bar/statusline.py',
  old_string: 'a',
  new_string: 'b',
} as const

const engine = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  on('command.register', () => ({ value: { command: 'file-tree' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1000 }))
  on('clock.after', () => ({ value: {} }))
  // Only ~/proj is a project; every other file exists.
  on('fs.exists', (_, e) => ({ value: e.path === '/Users/me/proj/.git' || !MARKER.test(e.path) }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false } }))
  on('fs.list', (_, e) => ({
    value: (DIRS[e.path] ?? []).map(one => ({ ...one, size: 0, mtimeMs: 0, isLink: false })),
  }))
}

const start = ($: Parameters<Parameters<typeof test>[1]>[0]) =>
  $.session.start({ cwd: '/Users/me/.claude', surface: 'terminal', isInteractive: true })

test('an edited file is marked under its expanded folder', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {} }))
  await start($)
  await $.tool.call(EDIT)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^~\/\.claude$/ }))?.text).toBe('~/.claude')
  expect((await ui.find({ type: 'Text', text: /statusline/ }))?.text).toBe('│ └ statusline.py')
  expect((await ui.find({ type: 'Text', text: /context-bar/ }))?.text).toBe('├ ▾ context-bar')
  expect((await ui.find({ type: 'Text', text: /skills/ }))?.text).toBe('├ ▸ skills')
  expect((await ui.find({ type: 'Text', text: /^M\d*$/ }))?.text).toBe('M')
  await ui.unmount()
})

test('a file wears a W badge while it is written', async ($, on) => {
  engine(on)
  let seen: string | undefined
  on('tool.call', async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    seen = (await ui.find({ type: 'Text', text: /^ W $/ }))?.text
    await ui.unmount()

    return { result: {} }
  })
  await start($)
  await $.tool.call(EDIT)

  expect(seen).toBe(' W ')
})

test('reading a file outside the folder moves the tree to its project', async ($, on) => {
  engine(on)
  let seen: string | undefined
  on('tool.call', async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    seen = (await ui.find({ type: 'Text', text: /^ R $/ }))?.text
    await ui.unmount()

    return { result: {} }
  })
  await start($)
  await $.tool.call(EDIT)
  await $.tool.call({ tool: 'Read', file_path: '/Users/me/proj/src/main.py' })
  expect(seen).toBe(' R ')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^~\/proj$/ }))?.text).toBe('~/proj')
  expect((await ui.find({ type: 'Text', text: /away from/ }))?.text).toBe('~/proj  away from ~/.claude')
  expect((await ui.find({ type: 'Text', text: /main\.py/ }))?.text).toBe('│ └ main.py')
  expect((await ui.find({ type: 'Text', text: /^R$/ }))?.text).toBe('R')
  expect((await ui.find({ type: 'Text', text: /^also / }))?.text).toBe('also ~/.claude  M1')
  await ui.unmount()
})

test('a shell command moves the tree and badges what it writes', async ($, on) => {
  engine(on)
  let seen: string | undefined
  on('tool.call', async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    seen = (await ui.find({ type: 'Text', text: /^ W $/ }))?.text
    await ui.unmount()

    return { result: {} }
  })
  await start($)
  // The heredoc body names a path of the session folder: it is not followed.
  await $.tool.call({
    tool: 'Bash',
    command: "P=~/proj\ncat > $P/src/main.py <<'EOF'\nprint('/Users/me/.claude/settings.json')\nEOF\nhead -5 ~/proj/README.md 2>/dev/null",
  })
  expect(seen).toBe(' W ')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^~\/proj/ }))?.text).toBe('~/proj  away from ~/.claude')
  expect((await ui.find({ type: 'Text', text: /^M$/ }))?.text).toBe('M')
  expect((await ui.find({ type: 'Text', text: /^R$/ }))?.text).toBe('R')
  await ui.unmount()
})

test('the plan tool shows the steps above the tree', async ($, on) => {
  engine(on)
  on('tool.register', () => ({ value: { tool: 'mcp__file-tree__plan' } }))
  on('tool.call', () => ({ result: {} }))
  await start($)
  const answer = await $.tool.call({
    tool: 'mcp__file-tree__plan',
    steps: [
      { text: 'Write the README', status: 'done' },
      { text: 'Commit to main', status: 'active' },
      { text: 'Push to psh9/claude-mods', status: 'pending' },
    ],
  })
  expect(answer.text).toBe('Plan shown in the file-tree pane: 3 steps.')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^next/ }))?.text).toBe('next  1/3')
  expect((await ui.find({ type: 'Text', text: /Commit/ }))?.text).toBe('▸ Commit to main')
  expect((await ui.find({ type: 'Text', text: /Push/ }))?.text).toBe('○ Push to psh9/claude-mods')
  await ui.unmount()
})

test('the band lays the tree out across the prompt', async ($, on) => {
  engine(on)
  on('command.run', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))
  await start($)
  await $.command.run({ command: 'file-tree', args: 'band' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /settings\.json/ }))?.text).toBe('└ settings.json')
  await ui.unmount()
})
