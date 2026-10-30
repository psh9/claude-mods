# file-tree

A pane beside the chat (or a band above the prompt) with a tree of the folder Claude is working in, styled after nvim-tree with Tokyo Night colors. It follows Claude as it works: what it reads, what it writes, where it goes, and what it plans to do next.

```
next  1/3
✓ Write the README
▸ Commit to main
○ Push to psh9/claude-mods
──────────────────────────────────
~/froot_wsl/claude-mods      M2 A3 R1
├ ▾ .claude-plugin
│ └ marketplace.json              A
├ ▾ mods
│ └ ▾ file-tree
│   ├ ▸ hooks
│   ├ README.md                    W
│   └ tests
├ .gitignore                      A
└ README.md                       M2
also ~/.claude  R4
```

## Legend

### Header

The top line of the tree is the folder it shows, with totals for that folder on the right:

| Total | Means |
| --- | --- |
| `M2` | 2 files modified (existing files Claude edited) |
| `A3` | 3 files added (files Claude created) |
| `R1` | 1 file read and not changed |

A file counts once, by its strongest mark: a file read and then edited counts as `M`.

`away from ~/your-folder` after the folder name means the tree has followed Claude out of the folder the session started in. See [Following Claude](#following-claude).

### Badges: what is happening now

While a tool is working on a path, its row turns blue and wears a colored badge on the right:

| Badge | Color | Means |
| --- | --- | --- |
| ` R ` | teal | reading the file |
| ` W ` | orange | writing the file (an edit, a new file, a shell command writing to it) |
| ` S ` | purple | searching in it (Grep or Glob) |
| ` $ ` | yellow | a shell command working in that folder or on that path, its effect unknown |

When the call ends, the last row touched keeps a softer highlight for 8 seconds, so a fast read or write is still easy to spot.

### Marks: what happened this session

After the call, a plain letter stays on the row:

| Mark | Color | Means |
| --- | --- | --- |
| `M` | orange | modified: the file existed and was edited |
| `A` | green | added: the file was created this session |
| `R` | teal | read, not changed |

A number after the letter counts repeats: `M3` is a file edited three times, `R2` a file read twice. A modified or added file's name is bold and takes the mark's color.

### Tree

| Glyph | Means |
| --- | --- |
| `▾ name` | an open folder: something inside it was touched |
| `▸ name` | a closed folder |
| `├ └ │` | tree lines |
| `N more` | entries left out: a folder shows its first 30 entries, plus every one that matters |
| `↑ N more` / `↓ N more` | the tree is taller than the pane, so it shows the part around the active file |

Folders open by themselves along the path to whatever Claude touched. `.git`, `node_modules`, `__pycache__`, `.venv` and similar folders are hidden unless something inside them was touched.

File names are colored by type, roughly as nvim-web-devicons does: `.py` yellow, `.ts`/`.tsx` blue, `.md` cyan, `.sh` green, `.toml`/`.yaml` purple, dotfiles grey.

### Plan

When Claude lays out steps, it calls the mod's `plan` tool and the steps show above the tree:

| Glyph | Means |
| --- | --- |
| `next  1/3` | steps done out of the whole plan |
| `▸` (orange, highlighted) | the step in progress |
| `○` | a step still to come |
| `✓` (struck through) | a step done; the last two stay in view |

In the band layout the plan is one line: `next ▸ Commit to main  ○ Push ...`.

### Footer

`also ~/other-folder  M1 R4` lines list the other folders touched this session, with their totals, so nothing drops out of sight when the tree moves.

## Following Claude

The tree shows the folder of Claude's latest activity. Inside the session's folder that is the session's folder. When Claude touches a path outside it, the tree moves to that path's project: the nearest folder above it holding `.git`, `.claude`, `package.json`, `pyproject.toml`, `Cargo.toml` or `go.mod`, stopping short of the home folder, or else the file's own folder. It moves back as soon as Claude works in the session's folder again.

## Shell commands

Claude's file tools (Read, Write, Edit, Grep, Glob) are tracked exactly. For a shell command the mod reads the command's text and guesses:

- writes: `> file`, `>> file`, `tee`, `cp`/`mv`/`rsync` (their last path), `mkdir`, `touch`, `rm`, `sed -i`
- reads: `cat`, `head`, `tail`, `less`, `wc`, `diff`, `grep`/`rg` (after the pattern), `awk`, `jq`, `< file`, and the sources of `cp`/`mv`/`rsync`
- `$`: `cd dir`, `git -C dir`, and any other path the command names

It follows simple variables (`D=~/proj; cat $D/x`), skips heredoc bodies, and only counts paths that exist (or, for a write, whose folder exists). A command it cannot read (`$(...)`, globs, unset variables) is left out; the tree still re-lists after it runs.

## Commands and keys

- `/file-tree side`: the docked side pane (the default)
- `/file-tree band`: a horizontal band above the prompt; the choice is remembered across sessions

Keys (Control, not Cmd, on a Mac):

| Keys | Does |
| --- | --- |
| `ctrl+x` then `tab` | focus the pane, or move between panes |
| arrows | scroll it while focused |
| `esc` | back to the prompt |
| `ctrl+x` then `x` | close the pane (`/file-tree` opens it again) |
| `ctrl+x` then `ctrl+a` | collapse or expand the band |

The side pane docks beside the chat in fullscreen mode (`"tui": "fullscreen"` in settings) on a terminal at least 110 columns wide; otherwise it shows above the prompt.

## Requirements

Claude Code with plugin hook modules (2.1.314 or later). macOS or Linux: paths are handled with `/`.
