// What a tool is doing to a path: Claude's file tools read, write and search;
// a shell command whose effect on a path is not known is `shell`.
export type Op = 'read' | 'write' | 'search' | 'shell'

export type TouchedFile = {
  path: string
  // The tree root the file belongs to: the session folder, or the project
  // folder of a file outside it.
  root: string
  kind: 'read' | 'edited' | 'created'
  reads: number
  edits: number
  changedAt: number
}

export type Activity = {
  active: { id: string; path: string; op: Op }[]
  last: { path: string; op: Op; root: string; at: number } | null
}

export type Step = { text: string; status: 'pending' | 'active' | 'done' }

// The next steps Claude announced through the mod's plan tool.
export type Plan = { steps: Step[]; at: number }

export type Layout = 'side' | 'band'

declare module 'claude-code' {
  interface PluginState {
    'file-tree': {
      files: Shaped<TouchedFile[]>
      activity: Shaped<Activity>
      plan: Shaped<Plan>
      layout: Shaped<Layout>
    }
  }
}
