<div align="center">

# OpenFlowKit MCP Server

**Give Claude Code, Claude Desktop, Cursor, Windsurf, or any MCP client first-class diagramming tools.**

[![npm](https://img.shields.io/npm/v/@openflowkit/openflowkit-mcp?style=flat-square&color=f97316)](https://www.npmjs.com/package/@openflowkit/openflowkit-mcp)
[![MIT License](https://img.shields.io/badge/License-MIT-f97316.svg?style=flat-square)](https://github.com/openflowkit/openflowkit/blob/main/LICENSE)
[![Node 20.11+](https://img.shields.io/badge/Node-20.11%2B-339933.svg?style=flat-square)](https://nodejs.org/)

</div>

---

OpenFlowKit MCP is **local-first by design** — it runs on your machine over stdio with no API key and no cloud round-trip, and its tools return deterministic output. Your MCP client already has an LLM; this server just gives it diagram-specific tools.

It gives the agent the same operations a human has, in two modes:

- **Live** — click **Connect agent** in the app and the tools act on the document you
  see, over a local bridge on `127.0.0.1:43119` (port: `OPENFLOWKIT_BRIDGE_PORT`; Host- and
  origin-checked; optional `OPENFLOWKIT_BRIDGE_TOKEN`). `screenshot` returns a real PNG and every edit is one undo.
- **File** — `openflow_open` a `.openflow.json`, edit it with the same tools,
  `openflow_save` it back.

No API keys and no account. This server calls no outside service; the hosted endpoint for chat apps (below) stores nothing.

Every client, step by step, with fixes for what goes wrong: [Connect your agent](https://docs.openflowkit.com/connect-your-agent/).

```
You:    Create a checkout flow with a promo-code branch
Claude: get_syntax → writes OpenFlow DSL itself → validate_openflow_dsl
        fixes any issues → create_diagram → screenshot
        returns DSL + what it drew
```

---

## Install

```bash
# No install required; npx fetches the latest published version
npx -y openflowkit mcp

# Or install globally
npm install -g openflowkit
openflowkit mcp
```

Requires **Node 20.11+**. You don't start the server yourself: add it to your agent, and the agent starts it.

### Claude Code

The terminal and the Claude Code extension for VS Code share this setup:

```bash
claude mcp add -s user openflowkit -- npx -y openflowkit mcp
```

Start a new session (or run `/mcp`), then open the app and click **Connect agent**, or open
[app.openflowkit.com/#/connect](https://app.openflowkit.com/#/connect).

### Teach your agent when and how to draw

[`skills/openflowkit/SKILL.md`](https://github.com/openflowkit/openflowkit/blob/main/skills/openflowkit/SKILL.md)
tells an agent when a diagram helps, how to write it (Mermaid or DSL), and to save it as a
`.openflow.json` beside the code. For Claude Code, copy it into `~/.claude/skills/openflowkit/`.
Agents that fetch the web read the same text at `https://app.openflowkit.com/llms.txt`.

### Claude Code plugin

```bash
claude plugin marketplace add openflowkit/openflowkit
claude plugin install openflowkit@openflowkit
```

Installs this server and the skill together.

### Codex

```bash
codex mcp add openflowkit -- npx -y openflowkit mcp
```

Or add it to `~/.codex/config.toml` by hand:

```toml
[mcp_servers.openflowkit]
command = "npx"
args = ["-y", "openflowkit", "mcp"]
```

Or install the plugin, which adds the server and the skill together:

```bash
codex plugin marketplace add openflowkit/openflowkit
```

Then install **OpenFlowKit** from that marketplace in the Plugins Directory.

---

## Claude Desktop setup

Settings → Developer → Edit Config opens the config file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "openflowkit": {
      "command": "npx",
      "args": ["-y", "openflowkit", "mcp"]
    }
  }
}
```

Quit Claude Desktop fully and open it again; **openflowkit** shows in the tool picker. Then open the app and click
**Connect agent**. If it says `npx` was not found, use the full path that `which npx` prints. No install at all:
Claude Desktop also takes the hosted connector (below), which draws cards in the chat instead of on your canvas.

### Cursor, VS Code, Windsurf and other MCP clients

[Add to Cursor](https://cursor.com/en/install-mcp?name=openflowkit&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm9wZW5mbG93a2l0IiwibWNwIl19) ·
[Install in VS Code](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522openflowkit%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522openflowkit%2522%252C%2522mcp%2522%255D%257D) (Copilot agent mode)

Anything else points at the same command:

- command: `npx`
- args: `["-y", "openflowkit", "mcp"]`

The server speaks the standard MCP stdio protocol. Client UIs differ, but the command shape is the same.

---

## Tools

All tools run locally and require no provider key.

Every op accepts an optional `documentId`: omit it while an editor is paired, pass one to
target a file-mode document (omitted in file mode, it means the document opened or created
last). Page-scoped ops (`update_diagram`, `move`, `style`, `delete`, `add_shape`, `get_document`,
`export`, …) also take a `pageId` from `list_pages`.

| Tool | What it does |
|---|---|
| `create_diagram` / `update_diagram` | Compile DSL — or Mermaid, Structurizr DSL or D2, converted with a loss report — into a new frame, or replace one in place; one undo step |
| `get_diagram` / `list_diagrams` | Read a frame's DSL, its drift from the canvas, and what the text cannot express |
| `get_syntax` | The grammar, or one family's section |
| `search_icons` / `find_icons_for` | Search 7,310 icons (AWS, Azure, Google Cloud, CNCF, developer logos, 5,148 Standard glyphs), or expand a concept ("cache", "queue", "auth") |
| `move` / `style` / `delete` / `add_shape` | Scene edits the language cannot say |
| `export` | SVG, PNG, PDF (print HTML) or JSON for a page, a selection or the document |
| `screenshot` | PNG of one frame (live mode) |
| `fit_view` | Frame the camera |
| `get_document` / `list_pages` | Nodes, connectors and pages with geometry |
| `validate_openflow_dsl` | Parse and compile DSL (or Mermaid, Structurizr DSL, D2 — converted first): the same diagnostics as `openflowkit validate` |
| `analyze_codebase` | Detect platforms, services, structure and language mix in a local repo |
| `discover_architecture` | Walk a repo (compose, Dockerfiles, k8s, terraform, manifests) and propose a C4 `architecture` workspace as DSL, with evidence per element |
| `drift_report` | Re-run discovery against a model (DSL text, a `documentId`, or else `architecture.ofk` in the repo) and report `missing` / `undrawn` / `changed` with evidence lines |
| `explain_element` | An element with its relations, discovery evidence, and the text of any linked `adr/*.md` |
| `openflow_create` / `openflow_open` / `openflow_save` | File-mode lifecycle; `openflow_save` takes `svg: true` to also write the `.svg` beside the file |
| `list_starter_templates` / `get_starter_template` | Working DSL to start from |
| `whoami` | Which mode you are in and what this server holds |
| `list_diagram_node_types` / `server_info` | Reference data and capability metadata |

### `openflowkit` CLI

The package also ships the `openflowkit` binary: every MCP op, plus discovery, without an
MCP client. No browser download; SVG is drawn in plain TypeScript.

```bash
openflowkit render diagram.mmd -o diagram.svg          # Mermaid, D2, Structurizr or DSL → SVG (stdin: -)
openflowkit convert diagram.mmd -o diagram.openflow.json # → an editable document
openflowkit validate diagram.mmd --json                # per-line diagnostics; exit 1 on an error
openflowkit op create_diagram --doc flow.openflow.json --args '{"dsl":"flowchart\nA -> B"}'
openflowkit op move --help                             # any op's arguments; `openflowkit ops` lists them
openflowkit discover ./my-app --out architecture.ofk   # propose a model, with evidence
openflowkit drift ./my-app --model architecture.ofk    # report drift; exit 1 when the model is stale
openflowkit build ./docs-architecture --out dist       # static site: every view, drill-down, flows
```

Unconverted Mermaid lines go to stderr and the command still succeeds; `--strict` makes them
(and warnings) exit 1. `op` reads a `.openflow.json` (or starts an empty one) and writes the
change back. Exit codes: 0 done, 1 the input or diagram is wrong, 2 usage. `--json` always prints
one JSON document. Layout outside the app stops at 1000 shapes or 400 connections with a message
rather than block; `validate` checks any size. Stdin is read only for `-`.

`build` reads `architecture.ofk` (plus `views/*.snap` layout overrides) and writes a
self-contained `index.html` with inline SVG views, breadcrumb drill-down and a flow
player. It replaces the Structurizr Cloud static export for wiki/GitHub Pages hosting:
no server, no account.

---

## Resources

Agents can read these directly:

| URI | Description |
|---|---|
| `openflowkit://docs/grammar` | The complete, versioned DSL reference |
| `openflowkit://templates` | Starter template catalog |
| `openflowkit://templates/{name}` | DSL for a named starter template |
| `openflowkit://icons` | Provider icon catalog (Standard glyphs are under `tabler`) |
| `openflowkit://icons/{provider}` | Icon catalog for one provider pack |

Provider packs are `aws`, `azure`, `gcp`, `cncf`, `developer`, and `tabler` (the 5,000 Standard glyphs).

---

## Prompts

Clients can surface two prompt templates:

- `flowchart_from_description` — agent writes the DSL, validates it and draws it
- `architecture_from_codebase` — agent scans a local repo, picks icon slugs, validates the DSL and draws it

---

## Recommended agent workflow

Ask your MCP client:

```text
Using the openflowkit MCP server: read openflowkit://docs/grammar, then write an OpenFlow DSL flowchart for checkout with cart, shipping, promo-code decision, payment, Stripe webhook, and confirmation. Call validate_openflow_dsl, fix any issues, then draw it with create_diagram and show me a screenshot.
```

For architecture diagrams:

```text
Using openflowkit: call analyze_codebase on /path/to/project, read openflowkit://docs/grammar, use search_icons for exact architecture icon slugs, write OpenFlow DSL, validate it, then draw it with create_diagram.
```

---

## In a chat app: claude.ai, ChatGPT

Chat apps that run in the cloud cannot start a local process, so they use the hosted endpoint:

```
https://mcp.openflowkit.com/mcp
```

- **claude.ai** (and Claude Desktop, which shares its connectors): Settings → Connectors (Customize → Connectors on
  newer accounts) → **Add custom connector**, paste the URL, and choose **No sign-in**. Then, in a chat, **+** →
  **Connectors** → turn OpenFlowKit on. The Free plan allows one custom connector; on Team and Enterprise only an
  Owner can add one.
- **ChatGPT:** where your plan allows custom connectors (developer mode), create one with the same URL.

Ask for a diagram and it appears in the chat as a card: the picture, zoom, and **Open in OpenFlowKit**, which opens
an editable copy in the app. It does not draw on the canvas you have open; for that, run the local server. The
diagram rides in the link's `#fragment`, so opening it sends the diagram to no server. Where the host supports it, the
card draws itself while the model writes, sends Claude a small picture of the result, and older cards grey out as
**Earlier version** when a newer one arrives.

The endpoint serves two tools to the model: `render_diagram` (OpenFlow DSL or Mermaid in, picture out, with the
canonical DSL and the editor link) and `get_syntax`, plus `preview_diagram`, which only the card calls while it streams.
All three are read-only. It is stateless (a fresh server per request), needs no login and **stores
nothing**. It has no file system, live editor, discovery or document tools: for those, run the local server.

## Where the diagram shows up

| Where your agent runs | What you see |
|---|---|
| Claude Desktop, VS Code (MCP Apps hosts), local server | A card under the tool call: picture, zoom, Open in OpenFlowKit |
| Claude Code, Codex, any terminal, file mode | The `.openflow.json` you save, and an `openUrl` in the result that opens the diagram in the app |
| Any client, live mode (**Connect agent** in the app) | The diagram is drawn on the canvas you have open, one undo step per change |
| claude.ai, ChatGPT, hosted endpoint | A card in the chat |

Only a client that announces MCP Apps support at startup gets the card's data; everyone else gets the same text
result as before, so no client pays for a picture it cannot show.

### Running the remote endpoint

It runs on Cloudflare Workers (`wrangler.toml`, `src/worker.ts`). The grammar and icon data are the Worker's
static assets, read by the Worker only.

```bash
npm run dev:remote                                  # workerd on http://127.0.0.1:8787/mcp
npm run smoke:remote -- http://127.0.0.1:8787       # every check against a running endpoint
npm run deploy:remote                               # deploys mcp.openflowkit.com (Cloudflare login needed)
npm run smoke:remote -- https://mcp.openflowkit.com
```

The same server also runs on Node: `npm run build && PORT=8787 npm run start:http`.

| Env (Node) | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Listen port. |
| `HOST` | `127.0.0.1` | Bind address. Anything but localhost requires `OPENFLOWKIT_ALLOWED_HOSTS`. |
| `OPENFLOWKIT_ALLOWED_HOSTS` | none | Comma-separated hostnames (no port) the `Host` header may carry (DNS-rebinding protection). Localhost is always allowed when bound to localhost. |
| `APP_ORIGIN` | `https://app.openflowkit.com` | Origin of the open-in-app link: `<origin>/#/from/dsl?d=<base64url(deflate-raw(dsl))>`. Over 32 KB the link is dropped and `losses` says so. |

The Worker reads `APP_ORIGIN` and `ALLOWED_HOSTS` from `[vars]` in `wrangler.toml`.

Limits, both hosts: only `POST` is served, on `/mcp` (also `/` and `/mcp/`, for a pasted bare host); GET and DELETE
get 405, since there are no sessions. Requests over
512 KB get 413; `source` is capped at 100 KB. A diagram over 1000 shapes or 400 connections in total (all views) is
refused, only the first view is laid out and drawn, and a render has a 15 s deadline. A picture over 1 MB is not
sent; the card says so and keeps the editor link. Renders in flight are capped (Node: 4, then 503 with
`Retry-After`; Worker: 8 per isolate, then a queue of up to 10 s before the 503).

## Privacy model

- **Local.** The stdio server calls no outside service, and the live bridge binds to 127.0.0.1.
- **No provider keys.** The MCP client model authors diagrams directly.
- **No OpenFlowKit account.** The hosted endpoint needs no sign-in and stores nothing.
- **The app** keeps your diagrams in your browser and sends basic usage stats, which you can turn off in Settings.
- **Local filesystem access only when requested.** Codebase analysis only reads the path passed to `analyze_codebase`.

---

## Development

This package lives in the [openflowkit monorepo](https://github.com/openflowkit/openflowkit).

```bash
# From the repo root
npm install --workspace=mcp-server
npm run --workspace=mcp-server build
npm run --workspace=mcp-server test:run

# Run locally against the MCP Inspector
npx @modelcontextprotocol/inspector dist/index.js
```

The MCP Inspector gives you a UI to manually call every tool, browse every resource, and verify client behavior before publishing.
