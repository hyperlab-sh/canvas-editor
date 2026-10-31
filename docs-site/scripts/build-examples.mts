// Compiles every ```` ```openflow ```` block under src/content/docs with the
// real parser, the real compiler and the real SVG exporter, and writes the
// rendered result to public/examples for the remark plugin to place beside the
// source. A block that does not compile fails `npm run build` (via prebuild)
// with the file, the line and the parser's own diagnostic — that is the gate
// that keeps the documentation from describing a language that no longer
// exists. It never reimplements the grammar; it imports it.
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { compileWorkspace, type CompileResult } from '../../src/dsl/compile';
import type { SceneDocumentV1 } from '../../src/opencanvas/domain/document/types';
import { collectIconArt, exportCanonicalSvg } from '../../src/opencanvas/infrastructure/export/canonicalSvg';
import { exportAnimatedSvg } from '../../src/opencanvas/infrastructure/export/animatedSvg';
import { autoSequence } from '../../src/opencanvas/domain/animation/sequence';
import { ICON_PACK_IDS, matchIconId } from '../../src/dsl/iconMatch';
import { PROVIDER_ICON_MANIFEST } from '../../src/services/shapeLibrary/providerIconManifest';
import { tablerSvg, type TablerNode } from '../../src/services/shapeLibrary/tablerSvg';
import { findExamples, hashExample } from './example-blocks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = resolve(HERE, '..', 'src', 'content', 'docs');
const EXAMPLES_DIR = resolve(HERE, '..', 'public', 'examples');
const MANIFEST = resolve(EXAMPLES_DIR, 'examples.json');
const REPO_ROOT = resolve(HERE, '..', '..');
/**
 * The landing page's motion sample is this page's first example, animated by
 * the app's own exporter (build preset, as Export → Animate this page makes
 * it), written as motion-{light,dark}.svg.
 */
const MOTION_PAGE = resolve(DOCS_DIR, 'diagram-architecture.md');

interface ExampleView {
  readonly name: string;
  readonly light: string;
  readonly dark: string;
  readonly width: number;
  readonly height: number;
}

interface ExampleEntry {
  readonly family: string;
  readonly views: ExampleView[];
}

interface Example {
  readonly source: string;
  readonly contentLine: number;
}

/** A failure whose message already names the line in the markdown file. */
class ExampleFailure extends Error {}

async function markdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(full)));
    else if (/\.mdx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

/** The same document shape the golden export test builds; nothing extra. */
function documentFrom(compiled: CompileResult, id: string, name: string): SceneDocumentV1 {
  return {
    format: 'openflowkit.scene', schemaVersion: 1, id, name,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    pages: [{
      id: 'page-1', name: 'Page 1', diagramKind: compiled.meta.family,
      layers: [{ id: 'default', name: 'Layer 1', visible: true, locked: false }],
      nodes: [compiled.frame, ...compiled.groups, ...compiled.nodes],
      connectors: compiled.connectors, metadata: {}, extensions: {},
    }],
    metadata: {}, extensions: {},
  } as SceneDocumentV1;
}

/**
 * The editor's icon catalog, read from the sources its bundle is built from
 * (assets/third-party-icons through the generated manifest, and @tabler/icons):
 * provider → shape id → where its art lives. The editor's own resolver loads
 * art through Vite globs and the MCP server's through build artifacts a clean
 * checkout lacks, so neither runs here; ids and matching are theirs.
 */
/** Wherever npm put @tabler/icons (hoisted or not); its exports map hides this file from require.resolve. */
function tablerNodesPath(): string {
  const file = join('@tabler', 'icons', 'tabler-nodes-outline.json');
  const found = (createRequire(import.meta.url).resolve.paths('@tabler/icons') ?? []).map((dir) => join(dir, file)).find(existsSync);
  if (!found) throw new Error(`${file} not found: is @tabler/icons installed?`);
  return found;
}

async function iconCatalog(): Promise<Map<string, Map<string, () => Promise<string>>>> {
  const catalog = new Map<string, Map<string, () => Promise<string>>>();
  const tabler: Record<string, readonly TablerNode[]> = JSON.parse(
    await readFile(tablerNodesPath(), 'utf8'));
  catalog.set('tabler', new Map(Object.entries(tabler).filter(([name]) => !name.endsWith('-filled'))
    .map(([name, nodes]) => [name, async () => tablerSvg(nodes)])));
  for (const [provider, categories] of Object.entries(PROVIDER_ICON_MANIFEST)) {
    const paths = Object.entries(categories).flatMap(([category, names]) => names.map((name) => (category ? `${category}/${name}` : name)));
    catalog.set(provider, new Map(paths.map((path) => [
      path.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
      () => readFile(resolve(REPO_ROOT, 'assets', 'third-party-icons', provider, 'processed', `${path}.svg`), 'utf8'),
    ])));
  }
  return catalog;
}

const catalog = await iconCatalog();
const shapeIds = new Map([...catalog].map(([provider, shapes]) => [provider, [...shapes.keys()]]));
const resolveIcon = (id: string) => matchIconId(id, (provider) => shapeIds.get(provider) ?? []);

/** The art the editor draws for one icon, as the data URL its exports embed. */
async function loadIconArt(packId: string, shapeId: string): Promise<string | null> {
  const provider = Object.keys(ICON_PACK_IDS).find((name) => ICON_PACK_IDS[name] === packId);
  const svg = await catalog.get(provider ?? '')?.get(shapeId)?.();
  return svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null;
}

function svgSize(svg: string): { width: number; height: number } {
  const match = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/.exec(svg);
  if (!match) throw new Error('The exporter produced an SVG without a viewBox.');
  return { width: Number(match[1]), height: Number(match[2]) };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'view';
}

async function renderExample(example: Example, hash: string, animate = false): Promise<{ entry: ExampleEntry; files: { name: string; svg: string }[] }> {
  const workspace = await compileWorkspace(example.source, { resolveIcon });
  const diagnostics = workspace.views.flatMap(({ result }) => result.diagnostics);
  const problems = diagnostics.filter(({ severity }) => severity !== 'info');
  // Warnings count as failures: a warning is the compiler saying it dropped or
  // ignored part of the example, which would make the rendered picture lie.
  if (problems.length > 0) {
    throw new ExampleFailure(problems.map(({ code, severity, line, message, hint }) =>
      `${example.contentLine + line - 1} [${code} ${severity}] ${message}${hint ? ` (${hint})` : ''}`).join('\n'),
    );
  }
  // A fragment (an `animate` block on its own, say) compiles to an empty
  // frame: there is nothing to show beside it, so it is not an example.
  const empty = workspace.views.filter(({ result }) =>
    result.nodes.length + result.groups.length + result.connectors.length === 0);
  if (empty.length > 0) {
    throw new ExampleFailure(`${example.contentLine} the block compiled to no nodes or connectors; a docs example must be a complete diagram`);
  }
  const files: { name: string; svg: string }[] = [];
  const views = await Promise.all(workspace.views.map(async (view, index) => {
    const document = documentFrom(view.result, `example-${hash}-${index}`, view.name || hash);
    const iconArt = await collectIconArt(document, loadIconArt);
    // Transparent: the page draws the canvas (colour and dot grid) behind it.
    const light = exportCanonicalSvg(document, { theme: 'light', pixelRatio: 1, transparent: true, iconArt });
    const dark = exportCanonicalSvg(document, { theme: 'dark', pixelRatio: 1, transparent: true, iconArt });
    const suffix = workspace.views.length > 1 ? `-${index + 1}-${slug(view.name || view.viewId)}` : '';
    const lightName = `${hash}${suffix}-light.svg`;
    const darkName = `${hash}${suffix}-dark.svg`;
    files.push({ name: lightName, svg: light }, { name: darkName, svg: dark });
    if (animate && index === 0) {
      const timeline = autoSequence(document.pages[0]!, 'build');
      for (const theme of ['light', 'dark'] as const) {
        files.push({ name: `motion-${theme}.svg`, svg: exportAnimatedSvg(document, timeline, { theme, iconArt }) });
      }
    }
    const { width, height } = svgSize(light);
    return { name: view.name, light: lightName, dark: darkName, width, height };
  }));
  return { entry: { family: workspace.family, views }, files };
}

async function main(): Promise<void> {
  const manifest: Record<string, ExampleEntry> = {};
  const problems: string[] = [];
  await rm(EXAMPLES_DIR, { recursive: true, force: true });
  await mkdir(EXAMPLES_DIR, { recursive: true });

  const files = await markdownFiles(DOCS_DIR);
  let blockCount = 0;
  for (const file of files) {
    const markdown = await readFile(file, 'utf8');
    if (!markdown.includes('```openflow')) continue;
    const shown = relative(REPO_ROOT, file);
    let examples: Example[];
    try {
      examples = findExamples(markdown);
    } catch (error) {
      problems.push(`${shown}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const [index, example] of examples.entries()) {
      blockCount += 1;
      const hash = hashExample(example.source);
      if (manifest[hash]) continue;
      try {
        const { entry, files: written } = await renderExample(example, hash, file === MOTION_PAGE && index === 0);
        manifest[hash] = entry;
        for (const output of written) await writeFile(resolve(EXAMPLES_DIR, output.name), output.svg, 'utf8');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        problems.push(error instanceof ExampleFailure ? `${shown}:${message}` : `${shown}:${example.contentLine} ${message}`);
      }
    }
  }

  await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[examples] ${problem}`);
    console.error(`[examples] ${problems.length} example(s) failed to compile.`);
    process.exit(1);
  }
  console.log(`[examples] rendered ${Object.keys(manifest).length} unique diagram(s) from ${blockCount} block(s) in ${files.length} file(s)`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
