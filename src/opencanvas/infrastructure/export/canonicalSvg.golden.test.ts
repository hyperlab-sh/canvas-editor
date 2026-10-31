import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile, type CompileResult } from '../../../dsl/compile';
import type { SceneDocumentV1 } from '../../domain/document/types';
import { projectClassEntityNodeVisual } from '../pixi/classEntityNodeVisual';
import { exportCanonicalSvg } from './canonicalSvg';

// Export goldens: one real fixture per family, compiled and rendered to SVG.
// A change that moves geometry, ink or typography shows up as a diff here —
// that is the point. Update with `vitest -u` only when the change is intended.
const FIXTURES: readonly { readonly family: string; readonly file: string }[] = [
  { family: 'flowchart', file: '01-tiny-connection.dsl' },
  { family: 'flowchart-groups', file: '05-groups.dsl' },
  { family: 'architecture', file: 'architecture/aws-3tier.dsl' },
  { family: 'sequence', file: 'sequence/basic.dsl' },
  { family: 'state', file: 'state/basic.dsl' },
  { family: 'erd', file: 'erd/shop.dsl' },
  { family: 'class', file: 'class/shop.dsl' },
  { family: 'gitgraph', file: 'gitgraph/basic.dsl' },
  { family: 'mindmap', file: 'mindmap/product.dsl' },
  { family: 'shape-library', file: 'shapes/library.dsl' },
  { family: 'long-label', file: 'flowchart/long-label.dsl' },
  { family: 'edge-markers', file: 'flowchart/markers.dsl' },
  { family: 'titled-groups', file: 'flowchart/titled-groups.dsl' },
] as const;

function documentFrom(compiled: CompileResult, name: string): SceneDocumentV1 {
  return {
    format: 'openflowkit.scene', schemaVersion: 1, id: 'golden', name,
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

function readFixture(file: string): string {
  return readFileSync(join(process.cwd(), 'src/dsl/fixtures', file), 'utf8');
}

describe('canonical SVG goldens', () => {
  for (const { family, file } of FIXTURES) {
    it(`renders ${family}`, async () => {
      const source = readFixture(file);
      const compiled = await compile(source);
      const svg = exportCanonicalSvg(documentFrom(compiled, family), { theme: 'light', pixelRatio: 2 });
      expect(svg).toMatchSnapshot();
      const dark = exportCanonicalSvg(documentFrom(compiled, family), { theme: 'dark', pixelRatio: 1 });
      expect(dark).toMatchSnapshot();
      expect(dark).toContain('data-theme="dark"');
    });
  }
});

describe('canonical SVG wrapped labels', () => {
  it('draws a long label in the lines the canvas wraps it to', async () => {
    const compiled = await compile(readFixture('flowchart/long-label.dsl'));
    const svg = exportCanonicalSvg(documentFrom(compiled, 'long-label'), { theme: 'light', pixelRatio: 1 });
    expect(svg).toContain('<tspan');
    expect(svg).toContain('>Validate the incoming payment request</tspan>');
    expect(svg).toContain('>against fraud rules and limits</tspan>');
  });

  it('draws a C4 card with a long name in wrapped lines', async () => {
    const compiled = await compile(`architecture
model {
  person Customer [desc: "Places and tracks orders"]
  system Shop "Online shop for customers who want to place and track orders from anywhere" [desc: "Takes orders"]
  Customer -> Shop : buys
}`);
    const svg = exportCanonicalSvg(documentFrom(compiled, 'c4-long-name'), { theme: 'light', pixelRatio: 1 });
    expect(svg).toMatchSnapshot();
    expect(svg).toContain('>anywhere</tspan>');
  });
});

describe('canonical SVG sequence', () => {
  // Found 2026-10-07: every export drew a participant as one box the height of its lifeline,
  // over its own messages; notes were plain boxes.
  it('draws a participant as the canvas does: header, dashed lifeline, actor figure; a note as a note', async () => {
    const compiled = await compile('sequence\nparticipant Browser [actor]\nAPI = API Gateway\nBrowser -> API : hi\nactivate API\nnote right of API : cached\nAPI --> Browser : ok\ndeactivate API');
    const svg = exportCanonicalSvg(documentFrom(compiled, 'sequence'), { theme: 'light' });
    const group = (id: string) => new RegExp(`<g data-node-id="${id}"[^>]*>([^]*?)</g>`).exec(svg)?.[1] ?? '';
    const api = group('API');
    expect(api).toMatch(/<rect [^>]*height="48"/);
    expect(api).toMatch(/<line [^>]*stroke-dasharray="6 6"/);
    expect(api).toMatch(/<rect [^>]*width="12"/);
    expect(api).toContain('>API Gateway<');
    expect(api).not.toMatch(new RegExp(`<(rect|path)[^>]*height="${compiled.nodes.find((node) => node.id === 'API')!.size.height}"`));
    expect(group('browser')).toMatch(/<circle [^>]*r="5"/);
    expect(group('note-1')).toContain('>cached<');
  });

  it('paints a fragment band under the messages it holds, as the canvas does', async () => {
    const compiled = await compile('sequence\nA\nB\nalt ok {\n  A -> B : inside\n}');
    const svg = exportCanonicalSvg(documentFrom(compiled, 'sequence'), { theme: 'light' });
    const band = svg.indexOf(`data-node-id="${compiled.nodes.find((node) => node.kind === 'annotation')!.id}"`);
    expect(band).toBeGreaterThan(-1);
    expect(band).toBeLessThan(svg.indexOf('data-connector-id='));
  });

  // Found 2026-10-11 (U2-7): a block exported as a sticky note with its guard as body text at y=46,
  // under the first arrow; db/queue participants exported as plain boxes.
  it('draws a block as the canvas does: tag and guard in the header row, else as a dashed divider', async () => {
    const compiled = await compile('sequence\nA\nB\nalt ok {\n  A -> B : yes\n} else no {\n  B -> A : nope\n}');
    const svg = exportCanonicalSvg(documentFrom(compiled, 'sequence'), { theme: 'light' });
    const group = (id: string) => new RegExp(`<g data-node-id="${id}"[^>]*>([^]*?)</g>`).exec(svg)?.[1] ?? '';
    const [start, branch] = [group('alt-1'), group('alt-2')];
    const guardX = (compiled.nodes.find((node) => node.id === 'alt-1')!.content.seqGuard as { x: number }).x;
    expect(start).toMatch(/<text x="8" y="6"[^>]*>ALT</);
    expect(start).toMatch(new RegExp(`<text x="${guardX}" y="6"[^>]*>ok<`));
    expect(start).not.toContain('Z" fill'); // no sticky-note fold
    expect(branch).toMatch(new RegExp(`<text x="${guardX}" y="6"[^>]*>\\[no\\]<`));
    expect(branch).not.toContain('>ELSE<');
    expect(branch).toContain('stroke-dasharray="5 5"');
  });

  it('draws db and queue heads as the canvas does', async () => {
    const compiled = await compile('sequence\nparticipant A [actor]\nparticipant B [db]\nparticipant C [queue]\nA -> B : read\nB -> C : put');
    const svg = exportCanonicalSvg(documentFrom(compiled, 'sequence'), { theme: 'light' });
    const group = (id: string) => new RegExp(`<g data-node-id="${id}"[^>]*>([^]*?)</g>`).exec(svg)?.[1] ?? '';
    for (const id of ['b', 'c']) {
      expect(group(id)).not.toMatch(/<rect [^>]*height="48"/);
      expect(group(id).match(/<path d="M[^"]*Z" fill=/g)).toHaveLength(1);
    }
    expect(group('a')).toMatch(/<rect y="40" [^>]*height="48"/);
  });
});

// Found 2026-10-11 (U2-9/10/11): tables and classes exported as empty labelled boxes, `o{` lost its
// crow's foot, and a sequence's lifelines ran through the message labels.
describe('canonical SVG tables, classes and their relations', () => {
  const nodeGroup = (svg: string, id: string) => new RegExp(`<g data-node-id="${id}"[^>]*>([^]*?)</g>`).exec(svg)?.[1] ?? '';
  const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}`;

  it('draws an entity as the canvas does: header, typed columns, key badges, its tint in both themes', async () => {
    const compiled = await compile(readFixture('erd/shop.dsl'));
    for (const theme of ['light', 'dark'] as const) {
      const svg = exportCanonicalSvg(documentFrom(compiled, 'erd'), { theme });
      const users = nodeGroup(svg, 'users');
      for (const text of ['>Entity<', '>users<', '>email<', '>text<', '>full name<', '>PK<', '>UQ<']) expect(users).toContain(text);
      expect(nodeGroup(svg, 'orders')).toContain('>FK<');
      expect(nodeGroup(svg, 'orders')).toContain('>NN<');
      expect(nodeGroup(svg, 'orders')).toContain('>placed_at<');
      // The canvas paints `users [blue]` with this fill whatever the theme; an export must not turn it white.
      const visual = projectClassEntityNodeVisual(compiled.nodes.find((node) => node.id === 'users')!)!;
      expect(users).toContain(`fill="${hex(visual.fill)}"`);
      expect(users).toContain(`fill="${hex(visual.headerFill)}"`);
    }
  });

  it('draws a class with its stereotype, attributes and methods either side of the divider', async () => {
    const compiled = await compile(readFixture('class/shop.dsl'));
    const order = nodeGroup(exportCanonicalSvg(documentFrom(compiled, 'class'), { theme: 'light' }), 'order');
    for (const text of ['>«interface»<', '>Order<', '>id: UUID<', '>items: Item[]<', '>total(): Money<', '>-<', '>+<']) expect(order).toContain(text);
  });

  it("draws a crow's foot on a many end", async () => {
    const compiled = await compile('erd\nA {\n  id int pk\n}\nB {\n  id int pk\n}\nA ||--o{ B : has');
    const svg = exportCanonicalSvg(documentFrom(compiled, 'erd'), { theme: 'light' });
    const connector = /<g data-connector-id="[^"]+">([^]*?)<\/g>/.exec(svg)![1]!;
    // Bar + bar at the source; circle + a three-prong fork at the target.
    expect(connector.match(/<circle /g)).toHaveLength(1);
    expect(connector.match(/<path d="M[^"]*M[^"]*M[^"]*"/g)).toHaveLength(1);
  });

  // The canvas fills hollow glyphs (circle, open triangle/diamond) so the line never shows through them.
  it('fills hollow markers with the page surface, as the canvas does', async () => {
    const compiled = await compile('class\nA\nB\nC\nA --|> B : extends\nA o-- C : has');
    const erd = await compile('erd\nA {\n  id int pk\n}\nB {\n  id int pk\n}\nA ||--o{ B : has');
    for (const [theme, surface] of [['light', '#ffffff'], ['dark', '#191b19']] as const) {
      const circle = /<circle [^>]*>/.exec(exportCanonicalSvg(documentFrom(erd, 'erd'), { theme }).split('data-connector-id=')[1]!)![0];
      expect(circle).toContain(`fill="${surface}"`);
      const markers = exportCanonicalSvg(documentFrom(compiled, 'class'), { theme }).split('data-connector-id=').slice(1).join('');
      expect(markers.match(new RegExp(`<path d="[^"]*Z" fill="${surface}"`, 'g'))).toHaveLength(2);
    }
  });

  it('paints lifelines under the messages, so a label is never crossed by a lifeline', async () => {
    const compiled = await compile('sequence\nA\nB\nC\nA -> C : across B');
    const svg = exportCanonicalSvg(documentFrom(compiled, 'sequence'), { theme: 'light' });
    expect(svg.indexOf('data-node-id="b"')).toBeGreaterThan(-1);
    expect(svg.indexOf('data-node-id="b"')).toBeLessThan(svg.indexOf('data-connector-id='));
  });
});

describe('canonical SVG labels', () => {
  it('places labels where the canvas does: frame title band, icon label below its plate', async () => {
    const compiled = await compile(readFixture('architecture/aws-3tier.dsl'));
    const dark = exportCanonicalSvg(documentFrom(compiled, 'architecture'), { theme: 'dark', pixelRatio: 1 });
    // The frame title sits in the 40px header band, not halfway down the frame.
    expect(dark).toMatch(/<text x="16" y="20"[^>]*>AWS three-tier service</);
    // An icon node paints a 72px plate; its white-on-dark label sits below it, on the canvas.
    const gateway = /<g data-node-id="gateway"[^>]*><rect x="(\d+)" y="4" width="72" height="72"[^]*?<text [^>]*fill="#ffffff"[^>]*><tspan x="[\d.]+" y="([\d.]+)">Gateway</.exec(dark);
    expect(gateway).not.toBeNull();
    expect(Number(gateway![2])).toBeGreaterThanOrEqual(84);
  });
});
