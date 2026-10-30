# context-bar

A one-line bar above the prompt showing how full the context window is, split by category in the same colours as `/context`.

```
ctx 38% 75.1k/200k $0.42 ██████░░░░░░░░░░░░░░
```

The bar is the last row above the prompt. Its figures are the window's percentage, the tokens used against the window's size, and the session's cost when the host keeps a ledger.

## Commands

| Command | Does |
| --- | --- |
| `/context-bar` | Toggle the bar on and off |
| `/context-bar on` / `off` | Show or hide it |
| `/context-bar legend` | Toggle the labelled legend above the bar (off by default) |
| `/context-bar full` | Recount the window exactly, per tool and memory file, and report it |

The bar refreshes after every turn from the engine's own measurement; `full` is the only command that asks for the detailed count.

## Install

```
/plugin install context-bar --marketplace psh9/claude-mods
```

## Developing

Run from the repository root: `claude --plugin-dir mods/context-bar`, check with `claude plugin validate mods/context-bar`, and run the tests with `claude plugin test mods/context-bar`.
