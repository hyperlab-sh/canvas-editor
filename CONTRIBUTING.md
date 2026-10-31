# Contributing to OpenFlowKit

Thanks for helping. Bug reports, ideas, docs fixes and code are all welcome.

- **A bug:** open an [issue](https://github.com/openflowkit/openflowkit/issues/new/choose). The
  smallest DSL or Mermaid text that shows it is worth more than a long description.
- **An idea or a question:** start a [Discussion](https://github.com/openflowkit/openflowkit/discussions).
- **Code:** look for issues labelled `good first issue` or `help wanted`, or say in an issue
  what you plan to change before a large PR.
- **A security problem:** report it privately, as [SECURITY.md](SECURITY.md) describes, not in an issue.

## Set up

You need Node **22.22+** and git. Everything else is in `package.json`.

```bash
git clone https://github.com/openflowkit/openflowkit.git
cd openflowkit
npm install                       # also installs the pre-commit hook (husky + lint-staged)
npx playwright install chromium   # once, for the browser tests
npm run dev                       # http://localhost:3000
```

## Commands

| Command | What it does | Time |
|---|---|---|
| `npm run dev` | Vite dev server on port 3000 | seconds |
| `npm run typecheck` | `tsc -b` | under a minute |
| `npm run lint` | ESLint, zero warnings allowed | about a minute |
| `npm test -- --run` | Vitest unit and golden tests, once (`npm test` watches) | 3–4 minutes |
| `npm --prefix mcp-server run test:run` | MCP server and `openflowkit` CLI tests (builds the agent bundle first) | under a minute |
| `npm run verify` | **The merge gate:** typecheck, lint, unit, MCP tests, then the `@gate` browser set in a **headed** browser | about 9 minutes |
| `npm run e2e:headed` | The whole Playwright suite (about 270 tests) in a visible browser on your GPU, including the `@local` GPU specs | long; ask before a release |
| `npm run e2e:ci` | The suite headless with software WebGL (SwiftShader), for machines **without a GPU or display** (Linux, WSL, containers). Sets `CI=1` itself and skips the `@local` specs | roughly 30 minutes |
| `npm run build` | Production build into `dist/` | under a minute |

Notes:

- The canvas is WebGL. Headless Chromium has none unless it runs with SwiftShader, which only
  `e2e:ci` turns on, so plain `npm run e2e` fails the canvas specs with "no empty point".
- `verify` opens a real browser window, so it needs a display. Without one, run the first five
  rows plus `npm run e2e:ci -- --grep @gate`, and say so in the PR.
- The browser tests start their own dev server on port 4173 and a stub AI provider on 4399. Free
  those ports first. One spec on its own: `npx playwright test e2e/<name>.spec.ts --headed`.
- Any uncaught page error fails a browser test. That is on purpose.
- To try the CLI from your checkout: `npm --prefix mcp-server run build`, then
  `node mcp-server/dist/cli.js --help`.

CI runs lint, the unit tests, the build, the MCP tests and the browser suite in four shards
(software WebGL) on every push and pull request.

## Pull requests

1. Fork, branch from **the default branch**, and open the PR against it.
2. Keep one change per PR. Say what changed and why, and link the issue.
3. A bug fix starts with a test that fails without the fix. A new domain or DSL function gets a
   unit test beside it (`foo.ts` → `foo.test.ts`). A UI change adds one Playwright check in `e2e/`.
4. Run `npm run verify` and paste the last lines. For UI changes, add a screenshot in light and dark.
5. Commit messages follow the log's style: `fix(map): Backspace on a map box no longer leaves the app`.
   Type, optional scope, then what is true now.

The [PR template](.github/pull_request_template.md) has the checklist.

## Releases and versions

The app follows [Semantic Versioning](https://semver.org/): a patch (2.1.1) for fixes, a minor (2.2.0) for
features, a major only when old files or links stop working. Every change people will notice adds one line
under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md). A maintainer releases by bumping `package.json`, renaming
that section to the version and date, and pushing a `vX.Y.Z` tag; the release workflow checks the two match and
publishes the GitHub release from the changelog. The MCP server versions on its own (`mcp-vX.Y.Z` tags, npm).

## Code rules

The full rules are in [AGENTS.md](AGENTS.md#code-rules), which the maintainers' coding agents
also follow. The short version:

- **Domain stays pure.** `src/opencanvas/domain` and `src/dsl` are plain TypeScript: no React,
  Pixi or DOM. Presentation (`src/opencanvas/presentation`) stays thin.
- **One undo step per user intent.** Every edit is a command with an exact inverse
  (`src/opencanvas/domain/commands`). Agent and AI edits go through the same commands.
- **Heavy work runs off the main thread.** ELK layout, repo-map loading and video export run in workers.
- **Every action has a key**, listed in `src/opencanvas/presentation/v2/v2Shortcuts.ts`.
- **Shortest thing that works.** No new dependency without a one-line reason in the PR. No
  flags or "for later" code. Delete dead code you find.
- **Deliberate shortcuts are marked** `// ponytail: <ceiling> — <upgrade path>`, so the debt can be found with grep.
- **Keep new components small.** Split along the layers in [ARCHITECTURE.md](ARCHITECTURE.md).
- **Avoid `any`.** If you must use it, add a comment saying why.

### Storage keys

Documents live in the IndexedDB database `openflowkit-persistence`. Settings use
`openflowkit-v2-*` and `ofk.*` localStorage keys. **Don't rename a store or key** without a
migration that reads the old one: a rename silently loses every user's data.

## Common changes

New to the code? Read [ARCHITECTURE.md](ARCHITECTURE.md) first. It traces text → canvas end to end.

### Add a diagram type

1. Name it in `DSL_FAMILIES` (`src/dsl/ast.ts`). If it is listed in `RESERVED_FAMILIES`
   (`src/dsl/document.ts`), remove it from there.
2. Implement the `Family` interface (`src/dsl/families/types.ts`): `compile` turns statements into
   scene records, and `serialize` writes the canonical text back. `src/dsl/families/state.ts`
   (under 100 lines) is a small, complete example.
3. Register it in `src/dsl/families/index.ts`.
4. Add tests beside it (`src/dsl/families/<name>.test.ts`) and a round-trip case
   (`src/dsl/roundTrip.test.ts`).
5. Document the syntax in `src/dsl/grammar.md`, then regenerate the copies agents and the docs
   read: `npm --prefix mcp-server run build:grammar` and `npm run generate:dsl -w docs-site`.
6. Add a docs page `docs-site/src/content/docs/diagram-<name>.md` and list it in
   `docs-site/astro.config.mjs`.

If the type needs a new look, the canvas renderers are in `src/opencanvas/infrastructure/pixi/` and
the SVG export is in `src/opencanvas/infrastructure/export/canonicalSvg.ts`.

### Add an icon

1. Put the SVG in `assets/third-party-icons/<provider>/processed/<Category>/<name>.svg` and record
   its source and licence in that provider's `SOURCE.md`. Its id becomes
   `<provider>/<category>-<name>`, for example `developer/monitoring-sentry`.
2. Run `node scripts/gen-icon-manifest.mjs` to regenerate
   `src/services/shapeLibrary/providerIconManifest.ts`. The MCP server rebuilds its own manifest
   when it builds.
3. To let auto-icons pick it from a label, add an alias row to `src/dsl/autoIcon.ts`.
4. Check: `npx vitest run src/services/shapeLibrary src/dsl/autoIcon.test.ts`.
