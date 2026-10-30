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
          memoryFiles: [
            { path: '/repo/CLAUDE.md', type: 'Project', tokens: 5200 },
            { path: '/home/me/.claude/CLAUDE.md', type: 'User', tokens: 1900 },
          ],
          mcpTools: [
            { name: 'mcp__linear__create_issue', serverName: 'linear', tokens: 900, isLoaded: true },
            { name: 'mcp__linear__list_issues', serverName: 'linear', tokens: 700, isLoaded: true },
            { name: 'mcp__figma__use_figma', serverName: 'figma', tokens: 2600, isLoaded: true },
            { name: 'mcp__figma__get_screenshot', serverName: 'figma', tokens: 400, isLoaded: false },
          ],
          agents: [{ agentType: 'reviewer', source: 'projectSettings', tokens: 120 }],
          skills: {
            totalSkills: 9,
            includedSkills: 8,
            tokens: 9900,
            skillFrontmatter: [
              { name: 'pdf', source: 'plugin', pluginName: 'anthropic-skills', tokens: 600 },
              { name: 'deep-research', source: 'plugin', pluginName: 'anthropic-skills', tokens: 4100 },
              { name: 'loop', source: 'built-in', tokens: 300 },
              ...['a', 'b', 'c', 'd', 'e'].map(name => ({ name, source: 'userSettings', tokens: 980 })),
            ],
          },
          slashCommands: { totalCommands: 12, includedCommands: 12, tokens: 800 },
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

test('the bar fills a readable width, capped, drawn last', async ($, on) => {
  beneath(on)
  await started($)

  for (const bodyColumns of [60, 100, 160]) {
    const ui = await $.ui.mount({
      ...BAND,
      surface: 'terminal',
      props: { ...BAND.props, bodyColumns },
    })

    const bar = (await ui.findAll({ type: 'Text' }))
      .map(one => one.text)
      .filter(text => BLOCKS.test(text))
      .join('')

    // Wide enough to read the split, never wider than the band.
    expect(bar.length).toBeGreaterThanOrEqual(8)
    expect(bar.length).toBeLessThanOrEqual(Math.min(48, bodyColumns))

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

test('the legend is on by default and /context-bar legend hides it', async ($, on) => {
  beneath(on)
  await started($)

  const labelled = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await labelled.find({ type: 'Text', text: /MCP tools/ })).toBeDefined()
  await labelled.unmount()

  const off = await typed($, 'legend')
  expect(off.text).toContain('off')

  const quiet = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await quiet.find({ type: 'Text', text: /MCP tools/ })).toBeUndefined()
  await quiet.unmount()
})

test('the percentage colour follows how full the window is', async ($, on) => {
  let percent = 38
  beneath(on, () => {
    const base = usage()

    return {
      ...base,
      context: {
        ...base.context,
        percent,
        breakdown: { ...base.context.breakdown!, percentage: percent },
      },
    }
  })
  await started($)

  for (const [next, colour] of [[38, 'success'], [75, 'warning'], [95, 'error']] as const) {
    percent = next
    await $.session.measure({ context: { tokens: 75100, window: 200000, percent: next }, rateLimits: [], changed: ['context'] })

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const head = await ui.find({ type: 'Text', text: /ctx/ })
    expect(head?.props.color).toBe(colour)
    await ui.unmount()
  }
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

test('/context-bar skills lists every skill, heaviest first', async ($, on) => {
  beneath(on)
  await started($)

  const ran = await typed($, 'skills')
  const lines = ran.text!.split('\n')
  expect(lines[0]).toBe('Skills — 9.9k')
  expect(lines[1]).toContain('4.1k  anthropic-skills:deep-research  (plugin)')
  expect(lines[2]).toContain('980  a')
  expect(ran.text).toContain('300  loop  (built-in)')
  expect(ran.text).toContain('1 of 9 skills left out')
  expect(ran.text).toContain('slash commands: 12 listed, 800')
})

test('/context-bar mcp sums loaded schemas per server', async ($, on) => {
  beneath(on)
  await started($)

  const ran = await typed($, 'mcp')
  expect(ran.text).toContain('MCP tools, by server — 4.2k')
  expect(ran.text).toContain('2.6k  figma  (1 tool, 1 deferred)')
  expect(ran.text).toContain('1.6k  linear  (2 tools)')
  expect(ran.text!.indexOf('figma')).toBeLessThan(ran.text!.indexOf('linear'))
})

test('/context-bar memory and agents name each file and agent', async ($, on) => {
  beneath(on)
  await started($)

  const memory = await typed($, 'memory')
  expect(memory.text).toContain('Memory files — 7.1k')
  expect(memory.text).toContain('5.2k  /repo/CLAUDE.md  (Project)')

  const agents = await typed($, 'agents')
  expect(agents.text).toContain('120  reviewer  (projectSettings)')
})

test('/context-bar full shows each section, its heaviest items folded', async ($, on) => {
  beneath(on)
  await started($)

  const ran = await typed($, 'full')
  for (const title of ['Skills', 'Memory files', 'MCP tools, by server', 'Custom agents']) {
    expect(ran.text).toContain(title)
  }
  // Eight skills, five shown.
  expect(ran.text).toContain('3 more')
})

test('/context-bar categories lists every /context row, deferred last', async ($, on) => {
  beneath(on)
  await started($)

  const ran = await typed($, 'categories')
  const lines = ran.text!.split('\n')
  expect(lines[0]).toBe('Context — 75.1k of 200k (claude-opus-5)')
  expect(lines[1]).toBe('    2.4k  System prompt         1.2%')
  expect(lines[2]).toBe('   11.5k  System tools          5.8%')
  expect(ran.text).toContain('26.0k  Messages')
  expect(lines[lines.length - 1]).toMatch(/Deferred tools +loaded on demand, not counted$/)
})

test('/context-bar full leads with the category table', async ($, on) => {
  beneath(on)
  await started($)

  const ran = await typed($, 'full')
  expect(ran.text!.indexOf('System tools')).toBeLessThan(ran.text!.indexOf('Skills —'))
})
