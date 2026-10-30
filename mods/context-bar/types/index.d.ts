/** One row of the /context breakdown, kept for drawing. */
export type ContextRow = {
  name: string
  tokens: number
  /** A theme key (`promptBorder`, `inactive`, ...), so the bar matches /context. */
  color: string
  kind: 'used' | 'free' | 'buffer' | 'deferred'
}

/** The last measurement of the window, as the band draws it. */
export type ContextSnapshot = {
  rows: ContextRow[]
  total: number
  max: number
  percent: number
  /** `full` counted per tool and memory file; `summary` estimated locally. */
  detail: 'summary' | 'full'
  model: string
  /** US dollars the session has cost, as /cost totals it; absent where the host keeps no ledger. */
  costUsd?: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-bar': {
      snapshot: ContextSnapshot | null
      isShown: boolean
      hasLegend: boolean
    }
  }
}
