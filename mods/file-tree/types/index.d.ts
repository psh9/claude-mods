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

// One line of `git log --graph`: the graph's own drawing, and the commit on
// it when the line holds one.
export type GraphLine = {
  graph: string
  commit?: { hash: string; refs: string; subject: string; when: string }
}

// The git state of the repository the tree shows; `isRepo` false outside one.
export type GitView = {
  root: string
  isRepo: boolean
  branch: string
  upstream: string
  ahead: number
  behind: number
  staged: number
  changed: number
  untracked: number
  // Local branches, the most recently committed first.
  branches: string[]
  graph: GraphLine[]
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'file-tree': {
      files: Shaped<TouchedFile[]>
      activity: Shaped<Activity>
      plan: Shaped<Plan>
      git: Shaped<GitView | null>
      layout: Shaped<Layout>
    }
  }
}
