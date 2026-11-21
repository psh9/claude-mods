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

// One conversation of a /branch tree: the root, or a branch made from
// `parent` after its `forkAt`th prompt. Everything up to there is context the
// two share.
export type Chat = {
  id: string
  parent: string | null
  name: string
  forkAt: number
  // The last prompt before the fork.
  forkText: string
  // Prompts in the conversation when it was last seen, shared ones included.
  prompts: number
  at: number
}

// The /branch tree the current conversation belongs to, root first.
export type Chats = { current: string; nodes: Chat[] }

// The person's own walk through the tree, with the pane's keys.
export type Explore = {
  // The folder the person is exploring; null while the tree follows Claude.
  root: string | null
  // Folders the person opened.
  open: string[]
  // The path under the cursor.
  cursor: string
  // Which list the cursor keys move in.
  on: 'tree' | 'search' | 'chat'
  // The grep field is showing.
  isAsking: boolean
}

// One prompt of this conversation and the answer Claude gave it.
export type Turn = { text: string; reply: string }

// This conversation's prompts, oldest first, walked with the pane's keys or
// the mouse. `cursor` -1 is the latest; `isOpen` shows the cursor's whole.
export type History = { turns: Turn[]; cursor: number; isOpen: boolean }

// One matching line of a search.
export type Hit = { path: string; line: number; text: string }

// The last search, the person's (the pane's grep) or Claude's (Grep, or a
// grep or rg command), run again by the mod to list every matching line.
export type Search = {
  pattern: string
  root: string
  by: 'person' | 'claude'
  hits: Hit[]
  isTruncated: boolean
  // The hit under the cursor.
  cursor: number
  error: string
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'file-tree': {
      files: Shaped<TouchedFile[]>
      activity: Shaped<Activity>
      plan: Shaped<Plan>
      git: Shaped<GitView | null>
      chats: Shaped<Chats>
      layout: Shaped<Layout>
      explore: Shaped<Explore>
      search: Shaped<Search | null>
      history: Shaped<History>
    }
  }
}
