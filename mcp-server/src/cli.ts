#!/usr/bin/env node
// The `openflowkit` CLI: discover a repo, check drift in CI, or build the
// self-contained static site. Node stdlib + the agent bundle only; views are laid
// out by the file host's in-process ELK, the same engine the editor runs.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isMain } from './lib/isMain.js';
import {
  collectIconArt,
  compileWorkspace,
  exportCanonicalSvg,
  type BundleWorkspace,
  type SvgExportDocument,
} from './lib/agent.js';
import { svgBeside, tryWriteSvgBeside } from './lib/svgBeside.js';
import { loadFileCapabilities, loadIconArt } from './lib/fileCapabilities.js';
import { OP_COMMANDS, OP_USAGE, documentOfDsl, runRegistryCommand } from './cliCommands.js';
import {
  discoverySummary,
  discoveryToDsl,
  driftReport,
  runArchitectureDiscovery,
  type ArchitectureDiscovery,
  type DriftReportResult,
} from './lib/architectureDiscovery.js';
import { renderMapHtml } from './lib/mapHtml.js';
import { MAP_DEPTHS, MapInputError, buildRepoMap, summarizeMap } from './lib/repoMap.js';
import { MCP_SERVER_VERSION } from './lib/version.js';
import { welcome } from './lib/welcome.js';
import {
  EMPTY_SVG,
  type SiteFlow,
  type SiteView,
  escapeHtml,
  firstModel,
  flattenFlowSteps,
  renderIndexHtml,
  slugifyViewId,
} from './cliSite.js';

export interface CliIo {
  out(message: string): void;
  err(message: string): void;
  /** Piped input for `-`; absent on a terminal. */
  stdin?: () => Promise<string>;
  /** Set when stdout is a terminal a person reads: bare `openflowkit` greets instead of failing. */
  terminal?: { readonly columns: number; readonly color: boolean };
}

const USAGE = `openflowkit — diagrams agents write, kept valid, editable and next to the code

Usage:
${OP_USAGE}
  openflowkit discover <dir> [--out architecture.ofk] [--no-svg]
  openflowkit drift <dir> [--model architecture.ofk] [--json]
  openflowkit build <dir> [--out dist]
  openflowkit map <dir> [--depth overview|detailed|everything] [--html out.html]
  openflowkit mcp
  openflowkit serve [--port N] [--config path] [--app dir]

Commands:
${OP_COMMANDS}
  discover  scan a repository and print or write a proposed C4 DSL workspace
  drift     compare a repository against its model (exit 1 when drift is found)
  build     compile architecture.ofk into a self-contained static site
  map       print what a repository is made of: parts, files, lines, imports, the folders that import each other
  mcp       run the MCP server (stdio) for Claude Code, Cursor and other agents
  serve     run the local diagram service: projects as folders, a link per diagram, the app

Options:
  --out <path>    discover: write the DSL here (default: stdout); build: output dir (default: dist)
  --no-svg        discover --out also writes <path>.svg for a README; this skips it
  --svg           op --doc / convert -o: also write the .svg beside the .openflow.json
  --model <path>  drift: model file (default: <dir>/architecture.ofk)
  --json          render, convert, validate, drift, ops: machine-readable output
  --depth <d>     map: overview (default), detailed or everything
  --html <path>   map: also write one self-contained, offline HTML page of the map
  --name <name>   discover: system name (default: directory name)
  --max-files <n> discover/drift: cap on files scanned (default: 2000)
  --port <n>      serve: port (default: the config's, 43120)
  --config <path> serve: service config file (default: ~/.config/openflowkit/service.json)
  --app <dir>     serve: the built app to serve (default: OPENFLOWKIT_APP_DIR, else <repo>/dist)
  --help          this text; <command> --help for one command's
  --version       the version

Exit codes: 0 done, 1 the input or the diagram is wrong (or drift found), 2 usage error.`;

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string>;
  error?: string;
}

function parseArgs(args: readonly string[], valued: ReadonlySet<string>): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    if (valued.has(name)) {
      const value = inline ?? args[++index];
      if (value === undefined) return { positionals, flags, error: `--${name} needs a value` };
      flags.set(name, value);
      continue;
    }
    if (inline !== undefined) return { positionals, flags, error: `--${name} takes no value` };
    flags.set(name, 'true');
  }
  return { positionals, flags };
}

function maxFilesOf(flags: Map<string, string>): number | undefined {
  const raw = flags.get('max-files');
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/* ----------------------------------------------------------------- drift */

function formatDrift(
  modelPath: string,
  discovery: ArchitectureDiscovery,
  report: DriftReportResult,
): string {
  const lines: string[] = [];
  lines.push(`Architecture drift — ${modelPath}`);
  lines.push(`${discovery.units.length} units, ${discovery.relations.length} relations, ${discovery.evidenceCount} evidence lines in the repo`);
  const section = (title: string, entries: string[]) => {
    if (entries.length === 0) return;
    lines.push('', `${title} (${entries.length})`);
    lines.push(...entries);
  };
  section('Missing — in the repo, not in the model', report.missing.map((finding) => {
    const evidence = finding.evidence[0];
    const where = evidence ? ` — ${evidence.file}:${evidence.line}: ${evidence.text}` : '';
    return `  • ${finding.name} (${finding.id})${where}`;
  }));
  section('Undrawn — in the model, no repo evidence', report.undrawn.map((finding) => `  • ${finding.name} (${finding.id})`));
  section('Changed — name matches, details differ', report.changed.map((change) =>
    `  • ${change.id}: ${change.field} "${change.model}" → "${change.repo}"`));
  const total = report.missing.length + report.undrawn.length + report.changed.length;
  lines.push('', total === 0 ? 'No drift.' : `${total} finding(s).`);
  return lines.join('\n');
}

async function runDrift(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseArgs(args, new Set(['model', 'max-files']));
  if (parsed.error) { io.err(`openflowkit drift: ${parsed.error}\n\n${USAGE}`); return 2; }
  const dir = parsed.positionals[0];
  if (!dir) { io.err(`openflowkit drift: missing <dir>\n\n${USAGE}`); return 2; }
  const modelPath = parsed.flags.get('model') ?? path.join(dir, 'architecture.ofk');
  try {
    const maxFiles = maxFilesOf(parsed.flags);
    const discovery = await runArchitectureDiscovery(dir, maxFiles ? { maxFiles } : {});
    const source = await readFile(modelPath, 'utf8');
    // Only the model is read, so the compile's default layout is fine here.
    const model = firstModel(await compileWorkspace(source));
    if (!model) {
      io.err(`openflowkit drift: no C4 model in ${modelPath}`);
      return 2;
    }
    const report = driftReport(model, discovery);
    const drift = report.missing.length + report.undrawn.length + report.changed.length > 0;
    if (parsed.flags.has('json')) {
      io.out(JSON.stringify({ model: modelPath, units: discovery.units.length, checked: model.elements.length, drift, ...report }, null, 2));
    } else {
      io.out(formatDrift(modelPath, discovery, report));
    }
    return drift ? 1 : 0;
  } catch (error) {
    io.err(`openflowkit drift: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

/* -------------------------------------------------------------- discover */

async function runDiscover(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseArgs(args, new Set(['out', 'name', 'max-files']));
  if (parsed.error) { io.err(`openflowkit discover: ${parsed.error}\n\n${USAGE}`); return 2; }
  const dir = parsed.positionals[0];
  if (!dir) { io.err(`openflowkit discover: missing <dir>\n\n${USAGE}`); return 2; }
  try {
    const maxFiles = maxFilesOf(parsed.flags);
    const discovery = await runArchitectureDiscovery(dir, maxFiles ? { maxFiles } : {});
    const dsl = discoveryToDsl(discovery, parsed.flags.get('name') ?? path.basename(path.resolve(dir)));
    const out = parsed.flags.get('out');
    if (out) {
      // `--out` is a path, not a promise that the folder exists.
      await mkdir(path.dirname(path.resolve(out)), { recursive: true });
      await writeFile(out, dsl, 'utf8');
      io.out(`wrote ${out} — ${discovery.units.length} units, ${discovery.relations.length} relations, ${discovery.evidenceCount} evidence lines`);
      // The picture is for a README, so it is on unless --no-svg.
      let failedSvg = false;
      if (!parsed.flags.has('no-svg')) {
        const document = await documentOfDsl(dsl, path.basename(out).replace(/\.[^.]+$/, ''));
        if (document === null) {
          const stale = existsSync(svgBeside(out)) ? `; ${svgBeside(out)} is now stale` : '';
          io.err(`openflowkit discover: ${out} does not compile; no svg written${stale}`);
        } else {
          const picture = await tryWriteSvgBeside(out, document);
          if ('svg' in picture) io.out(`wrote ${picture.svg}`);
          else { failedSvg = true; io.err(`openflowkit discover: saved ${out}; svg failed: ${picture.svgError}`); }
        }
      }
      io.err(discoverySummary(discovery));
      if (failedSvg) return 1;
    } else {
      io.out(dsl);
    }
    return 0;
  } catch (error) {
    io.err(`openflowkit discover: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

/* ------------------------------------------------------------------- map */

async function runMap(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseArgs(args, new Set(['depth', 'html']));
  if (parsed.error) { io.err(`openflowkit map: ${parsed.error}\n\n${USAGE}`); return 2; }
  const dir = parsed.positionals[0];
  if (!dir) { io.err(`openflowkit map: missing <dir>\n\n${USAGE}`); return 2; }
  const depth = parsed.flags.get('depth') ?? 'overview';
  if (!(MAP_DEPTHS as readonly string[]).includes(depth)) {
    io.err(`openflowkit map: --depth must be overview, detailed or everything, not "${depth}"`);
    return 2;
  }
  try {
    const chosen = depth as (typeof MAP_DEPTHS)[number];
    const map = await buildRepoMap(dir);
    io.out(summarizeMap(map, chosen));
    const html = parsed.flags.get('html');
    if (html) {
      const repo = map.github;
      const page = await renderMapHtml({ name: map.name, model: map.model, depth: chosen, repo });
      await mkdir(path.dirname(path.resolve(html)), { recursive: true });
      await writeFile(html, page, 'utf8');
      io.out(`wrote ${html} (${(Buffer.byteLength(page) / 1048576).toFixed(1)} MB) — ${repo ? `evidence links to github.com/${repo.owner}/${repo.repo} at ${repo.ref.slice(0, 7)}` : 'no evidence links (needs a github.com origin and the checkout root)'}`);
    }
    return 0;
  } catch (error) {
    io.err(`openflowkit map: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof MapInputError ? 1 : 2;
  }
}


async function runBuild(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseArgs(args, new Set(['out']));
  if (parsed.error) { io.err(`openflowkit build: ${parsed.error}\n\n${USAGE}`); return 2; }
  const dir = parsed.positionals[0];
  if (!dir) { io.err(`openflowkit build: missing <dir>\n\n${USAGE}`); return 2; }
  const outDir = parsed.flags.get('out') ?? 'dist';
  try {
    const source = await readFile(path.join(dir, 'architecture.ofk'), 'utf8');
    // The MCP file host's compile: ELK layout plus the editor's icon rule and art.
    const workspace = await (await loadFileCapabilities()).compileWorkspace(source) as unknown as BundleWorkspace;
    if (workspace.views.length === 0) {
      io.err('openflowkit build: architecture.ofk compiled to no views');
      return 2;
    }
    const model = firstModel(workspace) ?? { elements: [], relations: [], views: [], flows: [] };
    const name = model.name ?? path.basename(path.resolve(dir));

    const used = new Set<string>();
    const views: SiteView[] = [];
    for (const view of workspace.views) {
      const slug = slugifyViewId(view.viewId || 'primary', used);
      const pageId = `page:${slug}`;
      const document: SvgExportDocument = {
        id: `openflowkit-build:${slug}`,
        pages: [{
          id: pageId,
          layers: [{ id: 'default', visible: true }],
          nodes: [view.result.frame, ...view.result.groups, ...view.result.nodes],
          connectors: view.result.connectors,
        }],
      };
      const iconArt = await collectIconArt(document, loadIconArt);
      const render = (theme: 'light' | 'dark'): string => {
        try {
          return exportCanonicalSvg(document, { pageId, theme, padding: 32, iconArt });
        } catch {
          return EMPTY_SVG(escapeHtml(`${view.name} — empty view`));
        }
      };
      views.push({
        slug,
        viewId: view.viewId,
        name: view.name || slug,
        svgLight: render('light'),
        svgDark: render('dark'),
        nodes: [...view.result.groups, ...view.result.nodes].map((node) => node.id),
        connectors: view.result.connectors.flatMap((connector) => {
          const from = connector.source?.nodeId;
          const to = connector.target?.nodeId;
          return typeof from === 'string' && typeof to === 'string' ? [{ id: connector.id, from, to }] : [];
        }),
      });
    }
    const flows: SiteFlow[] = model.flows.map((flow) => ({ name: flow.name, steps: flattenFlowSteps(flow) }));

    await mkdir(path.join(outDir, 'views'), { recursive: true });
    for (const view of views) {
      await writeFile(path.join(outDir, 'views', `${view.slug}.svg`), view.svgLight, 'utf8');
      await writeFile(path.join(outDir, 'views', `${view.slug}.dark.svg`), view.svgDark, 'utf8');
    }
    await writeFile(path.join(outDir, 'model.json'), `${JSON.stringify({
      name: model.name ?? null, elements: model.elements, relations: model.relations, views: model.views,
    }, null, 2)}\n`, 'utf8');
    await writeFile(path.join(outDir, 'flows.json'), `${JSON.stringify({ flows }, null, 2)}\n`, 'utf8');
    await writeFile(path.join(outDir, 'index.html'), renderIndexHtml(name, model, views, flows), 'utf8');
    io.out(`built ${outDir} — ${views.length} view(s), ${flows.reduce((total, flow) => total + flow.steps.length, 0)} flow step(s)`);
    return 0;
  } catch (error) {
    io.err(`openflowkit build: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

/* ------------------------------------------------------------------ main */

/** One command's usage, options and summary, cut from USAGE so the two cannot disagree; null for no such command. */
function commandHelp(command: string): string | null {
  const lines = USAGE.split('\n');
  const usage = lines.filter((line) => line.trimStart() === `openflowkit ${command}` || line.trimStart().startsWith(`openflowkit ${command} `));
  if (usage.length === 0) return null;
  const summary = lines.find((line) => line.startsWith(`  ${command} `))?.slice(command.length + 2).trim();
  const options = lines.filter((line) => line.startsWith('  -') && new RegExp(`\\b${command}\\b`).test(line));
  return [`openflowkit ${command}${summary ? ` — ${summary}` : ''}`, '', 'Usage:', ...usage, ...(options.length ? ['', 'Options:', ...options] : [])].join('\n');
}

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h' || command === 'help') { io.out(USAGE); return 0; }
  if (command === '--version' || command === '-v') { io.out(`openflowkit ${MCP_SERVER_VERSION}`); return 0; }
  if (!command) {
    if (io.terminal) { io.out(welcome({ ...io.terminal, version: MCP_SERVER_VERSION })); return 0; }
    io.err(USAGE);
    return 2;
  }
  // `op` answers --help itself (per op); every other command prints its own lines, never a parser's complaint.
  const help = command !== 'op' && (rest.includes('--help') || rest.includes('-h')) ? commandHelp(command) : null;
  if (help) { io.out(help); return 0; }
  if (command === 'drift') return runDrift(rest, io);
  if (command === 'discover') return runDiscover(rest, io);
  if (command === 'build') return runBuild(rest, io);
  if (command === 'map') return runMap(rest, io);
  // The server starts when its module loads and keeps the process alive on stdio.
  if (command === 'mcp') { await import('./index.js'); return 0; }
  if (command === 'serve') return (await import('./service/serve.js')).runServe(rest, io);
  const handled = await runRegistryCommand(command, rest, io, USAGE);
  if (handled !== null) return handled;
  io.err(`openflowkit: unknown command "${command}"\n\n${USAGE}`);
  return 2;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2), {
    out: (message) => process.stdout.write(`${message}\n`),
    err: (message) => process.stderr.write(`${message}\n`),
    ...(process.stdout.isTTY ? { terminal: { columns: process.stdout.columns || 80, color: !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb' } } : {}),
    ...(process.stdin.isTTY ? {} : {
      stdin: async () => {
        // Whole bytes first: a UTF-8 character split across two chunks must not decode as two halves.
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks).toString('utf8');
      },
    }),
  }).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      process.stderr.write(`openflowkit: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    },
  );
}
