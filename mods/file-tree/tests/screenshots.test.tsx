// Plays the scenes the README's screenshots show and prints each drawing as
// one `SCENE <name> <json>` line; scripts/render-screenshots.py turns those
// lines into the SVGs in docs/. Run from the repository root:
//   claude plugin test mods/file-tree | python3 scripts/render-screenshots.py
import { expect, test } from 'claude-code/testing'

const HOME = '/Users/you'
const ROOT = `${HOME}/projects/weather-app`
const NOTES = `${HOME}/notes`

type Entry = { name: string; kind: 'file' | 'dir' }
const dirs = (...names: string[]): Entry[] =>
  names.map(name => (name.endsWith('/') ? { name: name.slice(0, -1), kind: 'dir' } : { name, kind: 'file' }))

const DIRS: Record<string, Entry[]> = {
  [ROOT]: dirs('src/', 'tests/', 'docs/', '.git/', 'README.md', 'package.json', 'tsconfig.json', '.gitignore'),
  [`${ROOT}/src`]: dirs('api/', 'components/', 'index.ts', 'config.ts'),
  [`${ROOT}/src/api`]: dirs('forecast.ts', 'client.ts', 'cache.ts'),
  [`${ROOT}/src/components`]: dirs('Header.tsx', 'Forecast.tsx', 'Chart.tsx'),
  [`${ROOT}/tests`]: dirs('forecast.test.ts', 'cache.test.ts'),
  [`${ROOT}/docs`]: dirs('api.md'),
  [NOTES]: dirs('.git/', 'ideas.md', 'weather-app.md', 'reading-list.md'),
}
// Files that do not exist until the scene writes them.
const NEW = new Set([`${ROOT}/src/api/cache.ts`, `${ROOT}/tests/cache.test.ts`])
const MARKER = /\/(\.git|\.claude|package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/
const written = new Set<string>()

const GIT: Record<string, string> = {
  status: [
    '# branch.oid 0000000',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -0',
    '1 .M N... 100644 100644 100644 aaa bbb src/api/forecast.ts',
    '? src/api/cache.ts',
    '? tests/cache.test.ts',
  ].join('\n'),
  log: [
    '* \u0001a41c9e2\u0002HEAD -> main\u0002Retry forecast calls on 503\u000212 minutes ago',
    '* \u00017d3f0b1\u0002\u0002Fetch hourly data\u00021 hour ago',
    '*   \u0001c92e4aa\u0002origin/main\u0002Merge branch \'charts\'\u00023 hours ago',
    '|\\',
    '| * \u00015b8e21f\u0002charts\u0002Draw the temperature chart\u00025 hours ago',
    '|/',
    '* \u0001e10f3c7\u0002\u0002Set up the project\u00022 days ago',
  ].join('\n'),
  'for-each-ref': 'main\ncharts\nfix-units',
}
const NOTES_GIT: Record<string, string> = {
  status: '# branch.oid 0000000\n# branch.head main\n1 .M N... 100644 100644 100644 aaa bbb weather-app.md',
  log: '* \u00013be91d0\u0002HEAD -> main\u0002Ideas for the weather app\u00021 day ago\n* \u0001f00a2c4\u0002\u0002Start a notes repo\u00021 week ago',
  'for-each-ref': 'main',
}

const engine = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  written.clear()
  on('process.run', (_, e) => {
    const repo = e.argv[2] === ROOT ? GIT : e.argv[2] === NOTES ? NOTES_GIT : undefined

    return { value: { exitCode: repo === undefined ? 128 : 0, stdout: repo?.[e.argv[3] ?? ''] ?? '', stderr: '' } }
  })
  on('command.register', () => ({ value: { command: 'file-tree' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__file-tree__plan' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1000 }))
  on('clock.after', () => ({ value: {} }))
  on('fs.exists', (_, e) => {
    if (MARKER.test(e.path)) return { value: e.path === `${ROOT}/.git` || e.path === `${NOTES}/.git` || e.path === `${ROOT}/package.json` }
    if (NEW.has(e.path)) return { value: written.has(e.path) }

    return { value: true }
  })
  on('fs.stat', (_, e) => ({
    value: { kind: DIRS[e.path] === undefined ? 'file' : 'dir', size: 0, mtimeMs: 0, isLink: false },
  }))
  on('fs.list', (_, e) => ({
    value: (DIRS[e.path] ?? []).map(one => ({ ...one, size: 0, mtimeMs: 0, isLink: false })),
  }))
}

const SITE = { isFocused: false, scroll: { offset: 0, bodyRows: 30 }, view: {} }
const PANE = {
  plugin: 'file-tree',
  component: 'Pane',
  requestId: 'file-tree',
  props: { ...SITE, bodyColumns: 46, scroll: { offset: 0, bodyRows: 42 }, title: 'Files', placement: 'dock' },
} as const
const BAND = {
  plugin: 'file-tree',
  component: 'AbovePrompt',
  props: { ...SITE, bodyColumns: 118, scroll: { offset: 0, bodyRows: 10 }, hasSurvey: false, isWorking: true, maxRows: 11 },
} as const

const PLAN = (active: number) => [
  'Read the forecast client',
  'Add a cache for forecast calls',
  'Write tests for the cache',
  'Run the tests',
  'Commit to main',
].map((text, index) => ({
  text,
  status: index < active ? 'done' : index === active ? 'active' : 'pending',
}))

const print = (name: string, tree: unknown) => {
  console.log(`SCENE ${name} ${JSON.stringify(tree)}`)
}

const work = async ($: Parameters<Parameters<typeof test>[1]>[0]) => {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__file-tree__plan', steps: PLAN(2) })
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/api/forecast.ts` })
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/api/client.ts` })
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/api/client.ts` })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/api/cache.ts`, content: '' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/api/forecast.ts`, old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/api/forecast.ts`, old_string: 'b', new_string: 'c' })
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/README.md` })
}

test('scene: the side pane while Claude writes a file', async ($, on) => {
  engine(on)
  let tree: unknown
  on('tool.call', async (_, e) => {
    const path = (e as { file_path?: string }).file_path
    if (path !== undefined) written.add(path)
    if (path === `${ROOT}/tests/cache.test.ts`) {
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
      tree = await ui.drawn()
      await ui.unmount()
    }

    return { result: '' }
  })
  await work($)
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/tests/cache.test.ts`, content: '' })
  print('pane', tree)
  expect(tree).toBeDefined()
})

test('scene: the tree follows Claude to another project', async ($, on) => {
  engine(on)
  on('tool.call', (_, e) => {
    const path = (e as { file_path?: string }).file_path
    if (path !== undefined) written.add(path)

    return { result: '' }
  })
  await work($)
  await $.tool.call({ tool: 'Edit', file_path: `${NOTES}/weather-app.md`, old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Read', file_path: `${NOTES}/ideas.md` })
  await $.tool.call({ tool: 'mcp__file-tree__plan', steps: PLAN(4) })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  print('follow', await ui.drawn())
  await ui.unmount()
})

test('scene: the band above the prompt', async ($, on) => {
  engine(on)
  on('command.run', () => ({ text: '' }))
  let tree: unknown
  on('tool.call', async (_, e) => {
    const path = (e as { file_path?: string }).file_path
    if (path !== undefined) written.add(path)
    if ((e as { command?: string }).command !== undefined) {
      const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
      tree = await ui.drawn()
      await ui.unmount()
    }

    return { result: '' }
  })
  await work($)
  await $.command.run({ command: 'file-tree', args: 'band' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/tests/cache.test.ts`, content: '' })
  await $.tool.call({ tool: 'mcp__file-tree__plan', steps: PLAN(3) })
  await $.tool.call({ tool: 'Bash', command: `cd ${ROOT} && npm test -- tests/cache.test.ts` })
  print('band', tree)
  expect(tree).toBeDefined()
})
