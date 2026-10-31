---
title: Command line (CLI)
description: Render, convert and validate diagram text, run any agent op on a file, map a repository, and check architecture drift in CI — from one command.
---

The `canvas` command runs the same parser, compiler, layout engine and ops as the app,
with no editor and no network. Output is plain text, or JSON with `--json`, so agents and
scripts can read it. It needs Node 20.11 or newer.

```sh
npx @hyperlab.sh/canvas            # the welcome screen and three commands to try
npx @hyperlab.sh/canvas --help     # every command
# or install it once
npm install -g canvas
```

<img src="/screens/cli-welcome.png" width="1200" height="1003" loading="lazy" alt="Running npx @hyperlab.sh/canvas: a welcome box, OPEN FLOWKIT in orange block letters, and three commands to try" />

`@hyperlab.sh/canvas` on npm is a short name for `@hyperlab.sh/canvas-mcp`, which also ships the
[MCP server](/mcp-server/); either package gives you the same `canvas` command. Pin a
version in CI, for example `npx -y @hyperlab.sh/canvas@0.2.4 validate diagram.canvas`.

## Commands

| Command | What it does |
| --- | --- |
| `canvas render <file\|-> [-o out.svg] [--theme light\|dark]` | Mermaid, D2, Structurizr or OpenFlow DSL in, SVG out (to stdout without `-o`) |
| `canvas convert <file\|-> [-o out.openflow.json] [--svg]` | The same input, out as an editable `.openflow.json` the app opens; `--svg` also writes the picture beside it |
| `canvas validate <file\|->` | Per-line diagnostics; exit 1 on an error |
| `canvas op <name> [--doc file.openflow.json] [--args '{…}' \| --args -] [--page <id>] [--svg]` | Run one agent op on a document file, exactly as the MCP tool of the same name would |
| `canvas op <name> --help` | The op's description and its arguments |
| `canvas ops [--json]` | List the ops |
| `canvas discover <dir> [--out architecture.canvas] [--no-svg] [--name <name>]` | Scan a repository and print (or write) a proposed C4 workspace in OpenFlow DSL |
| `canvas drift <dir> [--model architecture.canvas] [--json]` | Compare a repository with its model; exit 1 when they drifted |
| `canvas build <dir> [--out dist]` | Compile `<dir>/architecture.canvas` into a self-contained static site: one SVG per view, plus an index page with the model and flows |
| `canvas map <dir> [--depth overview\|detailed\|everything] [--html out.html]` | Print what a repository is made of (parts, files, lines, imports, folders that import each other); `--html` also writes one offline page of the [map](/map-mode/) |

`-` reads the input from a pipe. `render`, `convert` and `validate` accept warnings and
conversion losses by default; `--strict` turns them into exit 1. `discover` and `drift` read at
most 2,000 files unless you pass `--max-files <n>`.

Exit codes: `0` done, `1` the input or the diagram is wrong (or drift was found), `2` a usage
mistake.

## Examples

```sh
# A Mermaid file to an SVG for a README
canvas render docs/flow.mmd -o docs/flow.svg

# Pipe text in, check it, fail CI on any warning
cat docs/checkout.canvas | canvas validate - --strict

# Create a document file with one diagram, and its SVG beside it
canvas op create_diagram --doc docs/shop.openflow.json \
  --args '{"dsl":"flowchart\nClient -> API : request"}' --svg

# Propose a model for this repository, then keep it honest in CI
canvas discover . --out architecture.canvas
canvas drift . --model architecture.canvas
```

`op` without `--doc` runs on a throwaway document and says that nothing was saved. With
`--doc`, a missing file is created and an existing one is opened, changed and written back.

## What it does not do

- **No PNG, GIF or video.** Raster and motion export need a browser canvas; use the app, or
  pair it with the [MCP server](/mcp-server/) and call `export` there.
- **No live editor.** The CLI works on files. To act on the document you have open, use the
  MCP server's live mode.
- **`render` draws one view.** A C4 workspace with several views renders its first; `convert`
  keeps them all.

## Where to go next

- [GitHub Action](/github-action/): the CLI in CI, commenting on pull requests.
- [Coming from Structurizr](/coming-from-structurizr/): a full `convert` and `drift` walkthrough.
- [MCP Server](/mcp-server/): every op, with its arguments.
