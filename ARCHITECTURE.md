# Architecture

How OpenFlowKit turns text into a canvas and back, and where each piece lives. Read this before
your first PR. The code rules are in [AGENTS.md](AGENTS.md#code-rules); setup is in
[CONTRIBUTING.md](CONTRIBUTING.md).

## The pipeline

```
 text (OpenFlow DSL, or Mermaid / Structurizr / D2 converted first)
   │  src/dsl/document.ts       parseDocument: header, family, title, directives, segments
   │  src/dsl/compile.ts        lifts the animate block (animate.ts) before the family runs
   ▼
 family                         src/dsl/families/<name>  (statements → scene records)
   │  src/dsl/layout.ts         LayoutPort; ELK in a worker in the app, headless ELK in the CLI
   ▼
 CompileResult                  src/dsl/compile.ts: one frame + nodes, groups, connectors, diagnostics
   │  src/opencanvas/application/dsl/dslPageCommand.ts   → one reversible DocumentCommand
   ▼
 SceneDocumentV1                src/opencanvas/domain/document/types.ts  (pages, nodes, connectors)
   │  session + history         src/opencanvas/application/session, …/history  (one undo per command)
   ├──► Pixi canvas             src/opencanvas/infrastructure/pixi/PixiRendererHost.ts
   ├──► export                  src/opencanvas/infrastructure/export/canonicalSvg.ts, raster.ts, animatedSvg.ts, motion.worker.ts
   └──► IndexedDB               src/services/storage/v2/v2Repository.ts
```

And back: `src/dsl/serialize.ts` writes a frame's scene as canonical text, and
`src/dsl/losses.ts` lists what the language cannot say (a fill with no grammar word, for
example). Positions are not losses, because layout regenerates them. `format(format(x))`
equals `format(x)`, and `src/dsl/roundTrip.test.ts` holds that line.

Every diagram from text is a **frame** whose `metadata.dsl` keeps its source, a hash and the
family. The code panel (`src/opencanvas/presentation/v2/useV2CodeWorkspace.ts`) re-binds to a
frame by that metadata; `src/dsl/frameScene.ts` compares the hash to tell a hand-edited frame
from a generated one.

## Layers

| Layer | Path | Rule |
|---|---|---|
| Language | `src/dsl/` | Pure TypeScript. Tokenizer (`tokenize.ts`), families, compile, serialize, discovery, map model. |
| Domain | `src/opencanvas/domain/` | Pure. The document model, geometry, connectors, node styles, and **commands**: immutable edits that return their exact inverse (`commands/execute.ts`). |
| Application | `src/opencanvas/application/` | Use cases over the domain: session and history, DSL → command, selection, the AI assistant, Map navigation. |
| Infrastructure | `src/opencanvas/infrastructure/` | Pixi renderers and overlays (`pixi/`), exporters (`export/`). |
| Presentation | `src/opencanvas/presentation/` | React. `v2/` is the editor and home, `design-system/` the shared components and tokens. |
| Services | `src/services/` | I/O: IndexedDB storage (`openflowkit-persistence`), AI providers (Anthropic, OpenAI, Google, Ollama wire formats), GitHub reads, share links, feedback, importers, ELK runtime. |

Domain and language code import no React, Pixi or DOM. That is what lets the same compiler run
in the browser, in the MCP server and in the CLI. The editor page
(`src/opencanvas/presentation/v2/V2EditorPage.tsx`) wires the hooks together. Most behaviour
lives in the `useV2*` hooks beside it.

Heavy work stays off the main thread: ELK layout (`src/services/elk-layout/runtime.ts`; main thread
only in unit tests), repo-map
loading (`src/services/map/map.worker.ts`) and GIF/MP4/WebM encoding
(`src/opencanvas/infrastructure/export/motion.worker.ts`).

## Importers and exporters

- In: `src/services/dsl/mermaidToDsl.ts`, `structurizrToDsl.ts`, `d2ToDsl.ts`. Each converts to
  DSL text and reports losses, then the normal pipeline runs.
- Out: `src/dsl/mermaid/toMermaid.ts` (Copy as Mermaid), the exporters listed above, and
  `src/opencanvas/infrastructure/export/canonicalJson.ts` for `.openflow.json`.

## Agents

One op registry serves every surface: `src/agent/ops/index.ts` (`AGENT_OPS`). An op validates
its input with zod and returns **one reversible command** plus a JSON-safe result
(`src/agent/runAction.ts`). The surfaces:

- **MCP server** (`mcp-server/`). `npm run build:agent` bundles `src/agent/index.ts` into
  `mcp-server/src/generated/`, and `mcp-server/src/tools/ops.ts` turns each op into an MCP
  tool. Repo tools (discovery, drift, templates) sit beside it in `mcp-server/src/tools/`.
- **Live bridge.** `mcp-server/src/lib/bridge.ts` listens on `127.0.0.1:43119` and checks Host,
  Origin and an optional token. The editor long-polls it from
  `src/opencanvas/presentation/v2/useV2AgentBridge.ts`, runs each op against the open session and
  posts the result back. The wire types are in `src/agent/bridge/protocol.ts`. An agent edit
  commits through the same session as a mouse edit, so it is one undo step.
- **File mode.** With no editor paired, `src/agent/host.ts` gives the ops a headless host:
  headless ELK, canonical SVG, no raster.
- **CLI.** `mcp-server/src/cli.ts` and `cliCommands.ts`: `render`, `convert`, `validate`, `op` and
  `ops` over the same registry, plus `discover`, `drift`, `build`, `map`, and `mcp` (starts the
  server). Bare `openflowkit` at a terminal prints a welcome (`mcp-server/src/lib/welcome.ts`).
- **Remote MCP Apps.** `mcp-server/src/http.ts` (`npm run start:http`) serves `render_diagram` with
  an inline viewer from `mcp-server/src/remote/`; it stores nothing.
- **In the browser (WebMCP).** `src/agent/webMcp.ts` registers the ops with a browser agent that
  supports WebMCP; `webMcpTools.ts` loads lazily.
- **In-app assistant** (bring your own key). `src/opencanvas/application/ai/` builds the prompt
  and runs the same ops on a draft. The result is a proposal the user applies or dismisses.
  Provider wiring is in `src/services/ai/providers.ts`.
- **PR Action.** `action/` runs the CLI on a pull request's changed diagrams and posts one comment.

`src/agent/manifest.ts` lists every op, and `manifest.test.ts` fails when an op and the
manifest disagree.

## Map and discovery

- **Discovery** (`src/dsl/discovery/discovery.ts`) is pure. It takes files that were already
  read and proposes a C4 model from compose, Dockerfiles, Kubernetes, Terraform, package
  manifests and known client libraries. Every claim carries `file:line` evidence.
  `imports/` resolves source imports for TypeScript, Python and Go.
- **Map model** (`src/dsl/map/`). Facts become a tree of boxes (`build.ts`, `fold.ts`) and then
  a scene (`scene.ts`). `fromArch.ts` maps a hand-written architecture model the same way.
- **Repo maps in the browser.** `#/map/github/<owner>/<repo>` →
  `src/services/map/loadRepoMap.ts` starts the worker. `pipeline.ts` lists the tree and fetches
  only the files it needs through `src/services/discovery/githubRepo.ts`, streams snapshots, and
  caches the facts. Nothing is cloned.
- **Map mode in the editor**: `src/opencanvas/presentation/v2/map/useV2MapMode.ts`, with
  navigation, focus and motion in `src/opencanvas/application/map/`, drawn by the same Pixi host.
- **Offline map page.** `openflowkit map . --html` inlines the model into the DOM viewer in
  `src/viewer/map/` (built by `vite.map-viewer.config.ts` into `mcp-server/src/generated-viewer/`).

## Outside the app

| Path | What |
|---|---|
| `worker/` | Cloudflare Worker for share links (`share.openflowkit.com`, R2 plus a Quota Durable Object). It stores ciphertext only; the key stays in the link's `#` fragment. |
| `mcp-server/`, `cli/` | npm packages. `@openflowkit/openflowkit-mcp` is the engine (bins `openflowkit`, `openflowkit-mcp`); `openflowkit` is the public name and pins the engine at the same version. The root package is private. |
| `Dockerfile`, `nginx/` | Self-hosting: build the app, serve `dist` with nginx on port 3045. `docker-publish.yml` pushes the image to GHCR. |
| `docs-site/` | Astro Starlight docs. The DSL reference is generated from `src/dsl/grammar.md`. |
| `skills/`, `plugin/`, `.claude-plugin/` | The agent skill and the Claude Code / Codex plugin packaging. |
| `e2e/` | Playwright. Specs tagged `@gate` are the merge gate; `@local` needs a real GPU. |
| `architecture.ofk` | This repo's own C4 model, rendered to `architecture.svg`. Check it with `openflowkit drift .`. |

## Where to start reading

1. `src/dsl/compile.ts`: text → scene in about 230 lines.
2. `src/dsl/families/state.ts`: a small, complete family.
3. `src/opencanvas/domain/commands/execute.ts`: how every edit applies and inverts.
4. `src/opencanvas/presentation/v2/useV2CodeWorkspace.ts`: the code panel's Generate, end to end.
5. `src/agent/ops/dslOps.ts`: `create_diagram` and `update_diagram`, the same path an agent takes.
6. `src/dsl/grammar.md`: the language, as agents and the docs see it.
