import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'file-tree',
  component: 'Pane',
  requestId: 'file-tree',
  props: {
    isFocused: true,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
    title: 'Files',
    placement: 'dock',
  },
} as const

const DIRS: Record<string, { name: string; kind: 'file' | 'dir' }[]> = {
  '/Users/me/proj': [{ name: 'src', kind: 'dir' }, { name: 'README.md', kind: 'file' }],
  '/Users/me/proj/src': [{ name: 'main.py', kind: 'file' }, { name: 'util.py', kind: 'file' }],
}

type Ran = { argv: readonly string[] }

const engine = (on: Parameters<Parameters<typeof test>[1]>[1], runs: Ran[], stdout: string) => {
  on('command.register', () => ({ value: { command: 'file-tree' } }))
  on('tool.register', () => ({ value: {} }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.focus', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1000 }))
  on('clock.after', () => ({ value: {} }))
  on('fs.exists', (_, e) => ({ value: e.path === '/Users/me/proj/.git' || !e.path.endsWith('/.git') }))
  on('fs.stat', (_, e) => ({
    value: { kind: DIRS[e.path] !== undefined ? 'dir' : 'file', size: 0, mtimeMs: 0, isLink: false },
  }))
  on('fs.list', (_, e) => ({
    value: (DIRS[e.path] ?? []).map(one => ({ ...one, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv })
    const isSearch = e.argv[0] === 'rg'

    return {
      value: {
        exitCode: e.argv[0] === 'git' ? 1 : 0,
        stdout: isSearch ? stdout : e.argv[0] === 'sh' ? 'tmux\n' : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
}

const HITS = [
  '/Users/me/proj/src/main.py\u000012:def main():',
  '/Users/me/proj/src/main.py\u000030:    main()',
  '/Users/me/proj/src/util.py\u00004:from main import main',
].join('\n')

const start = ($: Parameters<Parameters<typeof test>[1]>[0]) =>
  $.session.start({ cwd: '/Users/me/proj', surface: 'terminal', isInteractive: true })

test('j and l walk into a folder, e opens the file in vim', async ($, on) => {
  const runs: Ran[] = []
  engine(on, runs, '')
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // The cursor starts on the first row, src; l opens it.
  await ui.press({ key: 'key:l' })
  expect((await ui.find({ type: 'Text', text: /main\.py/ }))?.text).toBe('│ ├ main.py')
  expect((await ui.find({ type: 'Text', text: /exploring/ }))?.text).toBe('~/proj  exploring')

  await ui.press({ key: 'key:j' })
  await ui.press({ key: 'key:e' })
  const editor = runs.find(run => run.argv[0] === 'sh')
  expect(editor?.argv.slice(-3)).toEqual(['/Users/me/proj/src/main.py', '1', '/Users/me/proj/src'])

  // h closes the folder holding the cursor; f follows Claude again.
  await ui.press({ key: 'key:h' })
  expect(await ui.find({ type: 'Text', text: /main\.py/ })).toBeUndefined()
  await ui.press({ key: 'key:f' })
  expect(await ui.find({ type: 'Text', text: /exploring/ })).toBeUndefined()
  await ui.unmount()
})

test('g asks for a pattern and lists its lines; n goes to the next file', async ($, on) => {
  const runs: Ran[] = []
  engine(on, runs, HITS)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'key:g' })
  await ui.input({ key: 'grep', text: 'main' })
  const rg = runs.find(run => run.argv[0] === 'rg')
  expect(rg?.argv.slice(-3)).toEqual(['main', '--', '/Users/me/proj'])
  expect((await ui.find({ type: 'Text', text: /3 in 2 files/ }))?.text).toBe('3 in 2 files')
  expect((await ui.find({ type: 'Text', text: /^src\/util\.py$/ }))?.text).toBe('src/util.py')

  await ui.press({ key: 'key:n' })
  await ui.press({ key: 'key:e' })
  const editor = runs.find(run => run.argv[0] === 'sh')
  expect(editor?.argv.slice(-3)).toEqual(['/Users/me/proj/src/util.py', '4', '/Users/me/proj/src'])
  await ui.unmount()
})

test("Claude's Grep is run again and its lines shown", async ($, on) => {
  const runs: Ran[] = []
  engine(on, runs, HITS)
  on('tool.call', () => ({ result: {} }))
  await start($)
  await $.tool.call({ tool: 'Grep', pattern: 'main', path: 'src', '-i': true })
  // The search after Claude's call runs in the background: give it turns.
  for (let i = 0; i < 30 && !runs.some(run => run.argv[0] === 'rg'); i++) {
    await (await $.ui.mount({ ...PANE, surface: 'terminal' })).unmount()
  }

  const rg = runs.find(run => run.argv[0] === 'rg')
  expect(rg?.argv).toContain('-i')
  expect(rg?.argv.at(-1)).toBe('/Users/me/proj/src')
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (let i = 0; i < 30 && (await ui.find({ type: 'Text', text: /^claude grep $/ })) === undefined; i++) {
    await ui.unmount()
    ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  }
  expect((await ui.find({ type: 'Text', text: /^claude grep $/ }))?.text).toBe('claude grep ')
  await ui.unmount()
})

test("Claude's rg command is read for its pattern and folder", async ($, on) => {
  const runs: Ran[] = []
  engine(on, runs, HITS)
  on('tool.call', () => ({ result: {} }))
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'cd /Users/me/proj/src && rg -n "def main" . | head' })
  // The search after Claude's call runs in the background: give it turns.
  for (let i = 0; i < 30 && !runs.some(run => run.argv[0] === 'rg'); i++) {
    await (await $.ui.mount({ ...PANE, surface: 'terminal' })).unmount()
  }

  const rg = runs.find(run => run.argv[0] === 'rg')
  expect(rg?.argv.slice(-3)).toEqual(['def main', '--', '/Users/me/proj/src'])
})
