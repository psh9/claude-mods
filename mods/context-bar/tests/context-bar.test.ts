import type { ContextCategory, On, SessionUsage } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'

const CATEGORIES: ContextCategory[] = [
  { name: 'System prompt', tokens: 2400, color: 'promptBorder', isDeferred: false, kind: 'used' },
  { name: 'System tools', tokens: 11500, color: 'permission', isDeferred: false, kind: 'used' },
  { name: 'MCP tools', tokens: 28100, color: 'inactive', isDeferred: false, kind: 'used' },
  { name: 'Memory files', tokens: 7100, color: 'warning', isDeferred: false, kind: 'used' },
  { name: 'Messages', tokens: 26000, color: 'success', isDeferred: false, kind: 'used' },
  // Outside the window: the bar must leave it out.
  { name: 'Deferred tools', tokens: 90000, color: 'inactive', isDeferred: true, kind: 'deferred' },
  { name: 'Autocompact buffer', tokens: 20000, color: 'inactive', isDeferred: false, kind: 'buffer' },
  { name: 'Free space', tokens: 104900, color: 'inactive', isDeferred: false, kind: 'free' },
]

const usage = (hasBreakdown = true, usd: number | null = 0.42): SessionUsage => ({
  startedAt: 0,
  ...(usd === null ? {} : { cost: { usd } }),
  context: {
    tokens: 75100,
    window: 200000,
    percent: 38,
    breakdown: hasBreakdown
      ? {
          categories: CATEGORIES,
          totalTokens: 75100,
          maxTokens: 200000,
          rawMaxTokens: 200000,
          autocompactSource: 'model-default',
          percentage: 38,
          gridRows: [],
          model: 'claude-opus-5',
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          isAutoCompactEnabled: true,
          apiUsage: null,
        }
      : undefined,
  },
  rateLimits: [],
})

const BAND = {
  plugin: 'context-bar',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const BLOCKS = /^[█░]+$/

/**
 * Nothing sits beneath a test's hooks, so every op the mod calls through
 * needs an answer here: the engine, as far as the mod can tell.
 */
const beneath = (on: On, reading: () => SessionUsage = usage) => {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  // Ops answer in a { value } envelope.
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({ value: reading() }))
  // The engine draws nothing above the prompt of its own; an empty box stands
  // for that, and only the paths where the mod yields ever reach it.
  on('ui.render', ($, e) => $.ui.resolve(e).Box({}))
}

const started = ($: Engine) =>
  $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

/** A command run as the person's Enter at the prompt. */
const typed = ($: Engine, args: string) =>
  $.command.run({
    command: 'context-bar',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

test('draws one stacked segment per category, in /context colours', async ($, on) => {
  beneath(on)
  await started($)
  // The legend is off by default; turn it on to see the labels.
  await typed($, 'legend')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: /38%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /75\.1k\/200k/ })).toBeDefined()

    const segments = (await ui.findAll({ type: 'Text' })).filter(one =>
      BLOCKS.test(one.text),
    )
    // Five used rows, the buffer and free space all get a segment.
    expect(segments.length).toBeGreaterThanOrEqual(7)

    const colours = new Set(segments.map(one => one.props.color))
    expect(colours.has('promptBorder')).toBe(true)
    expect(colours.has('success')).toBe(true)

    // The legend names them with their counts.
    expect(await ui.find({ type: 'Text', text: /MCP tools 28\.1k/ })).toBeDefined()
    // Deferred schemas are outside the window: never drawn.
    expect(await ui.find({ type: 'Text', text: /Deferred tools/ })).toBeUndefined()

    await ui.unmount()
  }
})

test('the bar is one compact line, capped in width, drawn last', async ($, on) => {
  beneath(on)
  await started($)

  for (const bodyColumns of [60, 100, 160]) {
    const ui = await $.ui.mount({
      ...BAND,
      surface: 'terminal',
      props: { ...BAND.props, bodyColumns },
    })

    // The legend is off, so the band is the one line of head and bar.
    const bar = (await ui.findAll({ type: 'Text' }))
      .map(one => one.text)
      .filter(text => BLOCKS.test(text))
      .join('')
    const head = (await ui.find({ type: 'Text', text: /^ctx / }))?.text ?? ''

    expect(head.length).toBeGreaterThan(0)
    expect(bar.length).toBe(Math.min(20, bodyColumns - head.length))

    await ui.unmount()
  }
})

test('/context-bar off hides the band and on brings it back', async ($, on) => {
  beneath(on)
  await started($)

  const off = await typed($, 'off')
  expect(off.text).toContain('off')

  const hidden = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await hidden.find({ type: 'Text', text: /38%/ })).toBeUndefined()
  await hidden.unmount()

  const back = await typed($, 'on')
  expect(back.text).toContain('on')

  const shown = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await shown.find({ type: 'Text', text: /38%/ })).toBeDefined()
  await shown.unmount()
})

test('/context-bar with no argument toggles', async ($, on) => {
  beneath(on)
  await started($)

  const first = await typed($, '')
  expect(first.text).toContain('off')

  const second = await typed($, '')
  expect(second.text).toContain('on')
})

test('the legend is off by default and /context-bar legend adds the labels', async ($, on) => {
  beneath(on)
  await started($)

  const quiet = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await quiet.find({ type: 'Text', text: /38%/ })).toBeDefined()
  expect(await quiet.find({ type: 'Text', text: /MCP tools/ })).toBeUndefined()
  await quiet.unmount()

  const on1 = await typed($, 'legend')
  expect(on1.text).toContain('on')

  const labelled = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await labelled.find({ type: 'Text', text: /MCP tools/ })).toBeDefined()
  await labelled.unmount()
})

test('/context-bar full recounts and reports the figures', async ($, on) => {
  const asked: string[] = []
  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('session.measure', ($$, e) => ({ changed: e.changed }))
  on('command.register', ($$, e) => ({ value: { command: e.name } }))
  on('ui.render', ($$, e) => $$.ui.resolve(e).Box({}))
  on('session.usage', ($$, e) => {
    if (e.breakdown !== undefined) asked.push(e.breakdown)

    return { value: usage() }
  })
  await started($)

  const ran = await typed($, 'full')
  expect(asked).toContain('full')
  expect(ran.text).toContain('75.1k')
})

test('yields the band to a survey', async ($, on) => {
  beneath(on)
  await started($)

  const ui = await $.ui.mount({
    ...BAND,
    surface: 'terminal',
    props: { ...BAND.props, hasSurvey: true },
  })
  expect(await ui.find({ type: 'Text', text: /38%/ })).toBeUndefined()
  await ui.unmount()
})

test('draws nothing before the first measurement', async ($, on) => {
  beneath(on, () => usage(false))
  await started($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /ctx/ })).toBeUndefined()
  await ui.unmount()
})

test('refreshes when the engine reports the window moved', async ($, on) => {
  let total = 75100
  beneath(on, () => {
    const base = usage()

    return {
      ...base,
      context: {
        ...base.context,
        breakdown: {
          ...base.context.breakdown!,
          totalTokens: total,
          percentage: Math.round((total / 200000) * 100),
        },
      },
    }
  })
  await started($)

  total = 150000
  await $.session.measure({ context: { tokens: total, window: 200000, percent: 75 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /75%/ })).toBeDefined()
  await ui.unmount()
})

test('the header carries what the session has cost', async ($, on) => {
  beneath(on)
  await started($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /\$0\.42/ })).toBeDefined()
  await ui.unmount()
})

test('a cost under a cent reads as under a cent, not as zero', async ($, on) => {
  beneath(on, () => usage(true, 0.004))
  await started($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /<\$0\.01/ })).toBeDefined()
  await ui.unmount()
})

test('no ledger, no cost in the header', async ($, on) => {
  beneath(on, () => usage(true, null))
  await started($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /38%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\$/ })).toBeUndefined()
  await ui.unmount()
})

test('refreshes when only the cost moved', async ($, on) => {
  let usd = 0.42
  beneath(on, () => usage(true, usd))
  await started($)

  usd = 1.87
  await $.session.measure({
    context: { tokens: 75100, window: 200000, percent: 38 },
    rateLimits: [],
    cost: { usd },
    changed: ['cost'],
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /\$1\.87/ })).toBeDefined()
  await ui.unmount()
})

test('/context-bar full reports the spend beside the count', async ($, on) => {
  beneath(on)
  await started($)

  const ran = await typed($, 'full')
  expect(ran.text).toContain('$0.42')
})
