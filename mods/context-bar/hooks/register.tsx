import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ContextRow, ContextSnapshot } from '../types'

const snapshot = atom({ plugin: 'context-bar', key: 'snapshot' } as const, null)
const isShown = atom({ plugin: 'context-bar', key: 'isShown' } as const, true)
const hasLegend = atom({ plugin: 'context-bar', key: 'hasLegend' } as const, false)

const FILLED = '█'
const HOLLOW = '░'

/** Most cells the bar takes: enough to read the split, never the whole row. */
const BAR_CELLS = 20

/** Where each kind sits in the bar: what is spent, the reserve, then the room left. */
const RANK: Record<ContextRow['kind'], number> = { used: 0, buffer: 1, free: 2, deferred: 3 }

const human = (n: number): string => {
  const t = Math.max(0, Math.round(n))
  if (t < 1000) return String(t)
  const k = t / 1000
  return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`
}

const money = (usd: number): string =>
  usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`

/** A category with the cells of the bar it gets. */
type Segment = { row: ContextRow; cells: number }

/**
 * Cells per category, summing to exactly `cells`: floor every share, hand the
 * remainder to the largest fractions, then make sure a category with tokens in
 * it never vanishes while a bigger one can spare a cell.
 */
const allocate = (rows: ContextRow[], cells: number): Segment[] => {
  const total = rows.reduce((sum, row) => sum + row.tokens, 0)
  if (total <= 0 || cells <= 0) return rows.map(row => ({ row, cells: 0 }))

  const parts = rows.map(row => {
    const exact = (row.tokens / total) * cells
    const whole = Math.floor(exact)

    return { row, whole, fraction: exact - whole }
  })

  let left = cells - parts.reduce((sum, part) => sum + part.whole, 0)
  for (const part of [...parts].sort((a, b) => b.fraction - a.fraction)) {
    if (left <= 0) break
    part.whole += 1
    left -= 1
  }

  for (const part of parts) {
    if (part.whole > 0 || part.row.tokens <= 0) continue
    const donor = parts.reduce<typeof part | null>(
      (best, other) =>
        other.whole > 1 && (best === null || other.whole > best.whole) ? other : best,
      null,
    )
    if (donor === null) break
    donor.whole -= 1
    part.whole = 1
  }

  return parts.map(part => ({ row: part.row, cells: part.whole }))
}

/**
 * Reads the window from the engine. `summary` estimates locally and sends no
 * requests, so it is what the band refreshes on; `full` counts per tool and
 * memory file the way /context does, and is asked for by hand.
 */
const measure = async (
  $: EngineInterface,
  detail: 'summary' | 'full',
): Promise<ContextSnapshot | null> => {
  const usage = await $.session.usage({ breakdown: detail })
  const breakdown = usage.context.breakdown
  if (breakdown === undefined) return null

  const rows: ContextRow[] = breakdown.categories
    .filter(row => !row.isDeferred)
    .map(row => ({
      name: row.name,
      tokens: Math.max(0, row.tokens),
      color: row.color,
      kind: row.kind,
    }))
    .sort((a, b) => RANK[a.kind] - RANK[b.kind])

  return {
    rows,
    total: breakdown.totalTokens,
    max: breakdown.rawMaxTokens || breakdown.maxTokens,
    percent: breakdown.percentage,
    detail,
    model: breakdown.model,
    costUsd: usage.cost?.usd,
  }
}

/**
 * Measures the window and keeps it, for the band to draw. A reading the
 * engine cannot give (no session bound yet) leaves the last one standing
 * rather than failing the hook that asked.
 */
async function refresh(
  $: EngineInterface,
  detail: 'summary' | 'full' = 'summary',
): Promise<ContextSnapshot | null> {
  let taken: ContextSnapshot | null = null
  try {
    taken = await measure($, detail)
  } catch {
    return null
  }
  if (taken !== null) await update($, snapshot, () => taken)

  return taken
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'context-bar',
      description: 'Toggle the context-window bar above the prompt',
      argumentHint: 'on | off | full | legend',
    })
    await refresh($)

    return next(e)
  })

  // The engine pushes a measurement after every turn; no polling needed.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context') || e.changed.includes('cost')) await refresh($)

    return next(e)
  })

  on('command.run', { command: 'context-bar' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'full') {
      const taken = await refresh($, 'full')
      await update($, isShown, () => true)

      return {
        text: taken === null
          ? 'No window to measure yet — the bar fills in after the first response.'
          : `Context bar counted exactly: ${human(taken.total)} of ${human(taken.max)} used (${Math.round(taken.percent)}%)${
              taken.costUsd === undefined ? '' : `, ${money(taken.costUsd)} spent this session`
            }.`,
      }
    }

    if (arg === 'legend') {
      const shows = await update($, hasLegend, value => !value)

      return { text: `Context bar legend ${shows ? 'on' : 'off'}.` }
    }

    const wanted = arg === 'on' ? true : arg === 'off' ? false : undefined
    const shows = wanted === undefined
      ? await update($, isShown, value => !value)
      : await update($, isShown, () => wanted)
    if (shows) await refresh($)

    return { text: `Context bar ${shows ? 'on' : 'off'}.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const shows = await read($, isShown)
    const taken = await read($, snapshot)
    if (!shows || taken === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns)
    const spent = taken.costUsd === undefined ? '' : ` ${money(taken.costUsd)}`
    const head = `ctx ${String(Math.round(taken.percent)).padStart(2)}% ${human(taken.total)}/${human(taken.max)}${spent} `
    const cells = Math.min(BAR_CELLS, Math.max(8, width - head.length))
    const bar = allocate(taken.rows, cells)
      .filter(segment => segment.cells > 0)
      .map(({ row, cells: count }) => (
        <Text key={row.name} color={row.color}>
          {(row.kind === 'used' || row.kind === 'buffer' ? FILLED : HOLLOW).repeat(count)}
        </Text>
      ))

    // The legend, when asked for, sits above the bar: the bar is the last row,
    // right over the prompt.
    const legend = []
    if (await read($, hasLegend)) {
      const keys = []
      let room = width
      for (const row of taken.rows) {
        if (row.tokens <= 0) continue
        const label = ` ${row.name} ${human(row.tokens)}`
        if (room - (label.length + 2) < 0) break
        room -= label.length + 2
        keys.push(
          <Text key={`${row.name}-swatch`} color={row.color}>
            {`  ${FILLED}`}
          </Text>,
          <Text key={`${row.name}-label`} dimColor>
            {label}
          </Text>,
        )
      }
      if (keys.length > 0) legend.push(<Box key="legend">{keys}</Box>)
    }

    return (
      <Box flexDirection="column">
        {legend}
        <Box key="bar">
          <Text dimColor>{head}</Text>
          {bar}
        </Box>
      </Box>
    )
  })
}
