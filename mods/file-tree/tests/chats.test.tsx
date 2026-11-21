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

type On = Parameters<Parameters<typeof test>[1]>[1]
type Dollar = Parameters<Parameters<typeof test>[1]>[0]

// A session that /branch moves to a new id, its store kept in `kept`.
const engine = (on: On) => {
  const kept = new Map<string, unknown>()
  const session = {
    kept,
    id: 'root-1',
    turns: 3,
    messages: [
      { role: 'user', text: 'create a new branch and build the feature', toolUses: [] },
      { role: 'assistant', text: 'On it.', toolUses: [] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'ok', isError: false }] },
    ] as { role: 'user' | 'assistant'; text: string; toolUses: never[]; toolResults?: unknown[] }[],
  }
  on('command.register', () => ({ value: { command: 'file-tree' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__file-tree__plan' } }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('store.get', (_, e) => ({ value: kept.get(e.key) }))
  on('store.set', (_, e) => {
    kept.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: session.id }))
  on('session.turns', () => ({ value: session.turns }))
  on('session.messages', () => ({ value: session.messages }) as never)
  on('clock.now', () => ({ value: 1000 }))
  on('clock.after', () => ({ value: {} }))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('command.run', (_, e) => {
    if (e.command === 'branch') session.id = `branch-of-${session.id}`

    return { text: '' }
  })

  return session
}

const start = ($: Dollar) =>
  $.session.start({ cwd: '/Users/me/proj', surface: 'terminal', isInteractive: true })

const branch = ($: Dollar, args = '') =>
  $.command.run({
    command: 'branch',
    args,
    origin: { kind: 'composer' },
    presentation: { layout: 'fullscreen', columns: 120 },
  } as Parameters<Dollar['command']['run']>[0])

test('a conversation never branched shows as Root alone', async ($, on) => {
  engine(on)
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^chats/ }))?.text).toBe('chats')
  expect((await ui.find({ type: 'Text', text: /Root/ }))?.text).toBe('● Root  here')
  expect((await ui.find({ type: 'Text', text: /prompts$/ }))?.text).toBe('3 prompts')
  await ui.unmount()
})

test('/branch shows the branch under Root with the context they share', async ($, on) => {
  const session = engine(on)
  await start($)
  await branch($, 'try-a')
  session.turns = 5
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'u1', reason: 'end_turn' } as Parameters<Dollar['turn']['complete']>[0])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^chats/ }))?.text).toBe('chats  1 branch')
  expect((await ui.find({ type: 'Text', text: /Root/ }))?.text).toBe('○ Root')
  expect((await ui.find({ type: 'Text', text: /try-a/ }))?.text).toBe('└ ● try-a  here')
  expect((await ui.find({ type: 'Text', text: /^shares/ }))?.text).toBe('shares 3 · 5 prompts')
  expect((await ui.find({ type: 'Text', text: /after/ }))?.text).toBe('    ⑂ after "create a new branch and build the feature"')
  await ui.unmount()
})

test('a branch of a branch nests, and the band shows the path to it', async ($, on) => {
  engine(on)
  await start($)
  await branch($)
  await branch($)

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /^chats/ }))?.text).toBe('chats  2 branches')
  expect((await pane.find({ type: 'Text', text: /branch 1/ }))?.text).toBe('└ ○ branch 1')
  expect((await pane.find({ type: 'Text', text: /branch 2/ }))?.text).toBe('  └ ● branch 2  here')
  await pane.unmount()

  await $.command.run({ command: 'file-tree', args: 'band' } as Parameters<Dollar['command']['run']>[0])
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /^chat / }))?.text)
    .toBe('chat Root › branch 1 › branch 2  shares 3 of 3 prompts  2 branches')
  await band.unmount()
})

test('a branch made before the mod loaded is read off the /branch notice', async ($, on) => {
  const session = engine(on)
  session.id = '7f1d3935-3061-4749-bb66-a11168946494'
  session.turns = 4
  session.messages = [
      { role: 'user', text: 'create a new branch and build the feature', toolUses: [] },
      { role: 'assistant', text: 'On it.', toolUses: [] },
      { role: 'user', text: 'okay right now the goals are missing', toolUses: [] },
      {
        role: 'user',
        text: '<local-command-stdout>Branched conversation "TestingFileFeature001". You are now in the new branch (session 7f1d3935-3061-4749-bb66-a11168946494). Use /resume fa371e5d-3875-4b43-832f-2629a5156873 to return to the original.</local-command-stdout>',
        toolUses: [],
      },
      { role: 'user', text: 'test it', toolUses: [] },
  ]
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^chats/ }))?.text).toBe('chats  1 branch')
  expect((await ui.find({ type: 'Text', text: /Root/ }))?.text).toBe('○ Root')
  expect((await ui.find({ type: 'Text', text: /Testing/ }))?.text).toBe('└ ● TestingFileFeature001  here')
  expect((await ui.find({ type: 'Text', text: /^shares/ }))?.text).toBe('shares 2 · 4 prompts')
  expect((await ui.find({ type: 'Text', text: /after/ }))?.text).toBe('    ⑂ after "okay right now the goals are missing"')
  await ui.unmount()
})

test("a plan is kept per conversation, and a restarted branch shows its parent's", async ($, on) => {
  const session = engine(on)
  session.id = 'branch-of-root-1'
  session.kept.set('chats', [
    { id: 'root-1', parent: null, name: 'Root', forkAt: 0, forkText: '', prompts: 3, at: 1 },
    { id: 'branch-of-root-1', parent: 'root-1', name: 'try-a', forkAt: 3, forkText: 'go', prompts: 3, at: 2 },
  ])
  session.kept.set('plans', {
    'root-1': { steps: [{ text: 'Write the tests', status: 'active' }], at: 1 },
  })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Write the tests/ }))?.text).toBe('▸ Write the tests')
  await ui.unmount()

  await $.tool.call({ tool: 'mcp__file-tree__plan', steps: [{ text: 'Commit', status: 'pending' }] } as never)
  const plans = session.kept.get('plans') as Record<string, { steps: unknown[] }>
  expect(plans['branch-of-root-1']?.steps).toEqual([{ text: 'Commit', status: 'pending' }])
  expect(plans['root-1']?.steps).toEqual([{ text: 'Write the tests', status: 'active' }])
})

const HISTORY = [
  { role: 'user', text: 'set up the project', toolUses: [] },
  { role: 'assistant', text: 'Done: the project is set up.', toolUses: [] },
  { role: 'user', text: '<command-name>/branch</command-name>', toolUses: [] },
  { role: 'user', text: 'now write the README\nwith a legend for the badges', toolUses: [] },
  { role: 'assistant', text: 'Reading the module first.', toolUses: [] },
  { role: 'assistant', text: 'The README is written.', toolUses: [] },
  { role: 'user', text: 'commit it', toolUses: [] },
] as { role: 'user' | 'assistant'; text: string; toolUses: never[] }[]

test('the history lists each prompt, and a click opens it with the answer', async ($, on) => {
  const session = engine(on)
  session.messages = HISTORY
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^history/ }))?.text).toBe('history  3 prompts')
  expect((await ui.find({ type: 'Text', text: /^1 / }))?.text).toBe('1 set up the project')
  expect((await ui.find({ type: 'Text', text: /^2 / }))?.text).toBe('2 now write the README')
  expect(await ui.find({ type: 'Text', text: /legend/ })).toBe(undefined)

  await ui.press({ key: 'turn:1' })
  expect((await ui.find({ type: 'Text', text: /legend/ }))?.text).toBe('  with a legend for the badges')
  expect((await ui.find({ type: 'Text', text: /README is written/ }))?.text).toBe('  ⏺ The README is written.')

  await ui.press({ key: 'turn:1' })
  expect(await ui.find({ type: 'Text', text: /legend/ })).toBe(undefined)
  await ui.unmount()
})

test('the keys walk the history and put a prompt back in the prompt box', async ($, on) => {
  const session = engine(on)
  session.messages = HISTORY
  const filled: string[] = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)

    return { isFilled: true } as never
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, isFocused: true } })
  await ui.press({ key: 'key:c' })
  await ui.press({ key: 'key:k' })
  await ui.press({ key: 'key:k' })
  await ui.press({ key: 'key:l' })
  expect((await ui.find({ type: 'Text', text: /Done: the project/ }))?.text).toBe('  ⏺ Done: the project is set up.')
  await ui.press({ key: 'key:j' })
  await ui.press({ key: 'key:a' })
  expect(filled).toEqual(['now write the README\nwith a legend for the badges'])
  await ui.unmount()
})
