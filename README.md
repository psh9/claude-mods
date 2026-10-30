# claude-mods

Mods for Claude Code: small plugins that change its interface while you work.

| Mod | What it does |
| --- | --- |
| [file-tree](mods/file-tree/README.md) | A side pane or band with a tree of the working folder that shows, live, what Claude reads, writes and plans next, plus the repository's git graph and a branch switcher. Focus it to explore the tree with vim keys, grep the folder (Claude's own greps show there too) and open files in vim. The legend for its marks (`M2 A3 R1`, the ` R ` ` W ` ` S ` ` $ ` badges, the plan and git glyphs) is in its README. |
| [context-bar](mods/context-bar/README.md) | A one-line bar above the prompt showing how full the context window is, split by category in the colours of `/context`. |

<p align="center">
  <img src="docs/pane.png" alt="The file-tree pane: Claude's plan, the tree with the file being written, and the git graph" width="380">
</p>

<p align="center">
  <img src="docs/band.png" alt="The file-tree band above the prompt" width="100%">
</p>

## Exploring, searching and opening files

In the file-tree side pane, `ctrl+x` then `tab` gives the pane the keyboard, and its keys show along the bottom:

| Key | Does |
| --- | --- |
| `j` `k` | move the cursor (the first key takes the tree over from Claude; `f` hands it back) |
| `l` `h` | open / close a folder; `l` on a file opens it in vim |
| `g` | grep the folder shown; the matching lines are listed under their files |
| `n` `p` | next / previous file in the results, or among the files Claude touched |
| `e` | open the file in vim, at the line of a search result |
| `a` | put `@path` in the prompt, to ask Claude about it |
| `t` `x` | switch between the tree and the results / clear the search |

- **Claude's searches:** when Claude runs Grep, or `grep`/`rg` in a shell command, the same search is listed in the pane as `claude grep`.
- **From the prompt:** `/file-tree grep <pattern>` runs a search without focusing the pane.
- **Vim:** opens in a new tmux window when Claude Code runs in tmux, otherwise in a new Windows Terminal tab under WSL. `$EDITOR` picks another editor.

The full legend and the details are in [the file-tree README](mods/file-tree/README.md#exploring-and-searching).

## Install

This repository is private: you need access to it on GitHub, and git on your computer signed in to GitHub (for example with `gh auth login`).

At the prompt of a Claude Code terminal session:

```
/plugin install file-tree --marketplace psh9/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user, to have it in every project).

From a shell:

```
claude plugin install file-tree --marketplace psh9/claude-mods
```

## Developing

Each mod is a folder under `mods/`, listed in `.claude-plugin/marketplace.json`. Run one from its folder with `claude --plugin-dir mods/<mod>`, check it with `claude plugin validate mods/<mod>`, and run its tests with `claude plugin test mods/<mod>`.
