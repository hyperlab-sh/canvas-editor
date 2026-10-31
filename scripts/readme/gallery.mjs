// Renders the README's diagram-type gallery: each type page's first ```openflow example, through
// the CLI's own `render`, light and dark, framed on a same-size card → assets/readme/types/*.png
// (GitHub can't size mixed-aspect SVGs into an even grid). Re-run after a renderer change:
//
//   npm --prefix mcp-server run build && node scripts/readme/gallery.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TYPES = ['flowchart', 'architecture', 'sequence', 'state', 'erd', 'class', 'mindmap', 'gitgraph', 'chart', 'wireframe'];
const CARD = { width: 800, height: 520, padding: 32 };
// The export's own background (SVG_BACKGROUND in canonicalSvg.ts), so the diagram sits on the card seamlessly.
const GROUND = { light: '#ffffff', dark: '#191b19' };
const OUT = 'assets/readme/types';
const scratch = mkdtempSync(join(tmpdir(), 'ofk-gallery-'));
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: CARD.width, height: CARD.height }, deviceScaleFactor: 2 });
for (const type of TYPES) {
  const doc = readFileSync(`docs-site/src/content/docs/diagram-${type}.md`, 'utf8');
  const source = /```openflow\n([\s\S]*?)```/.exec(doc)?.[1];
  if (!source) throw new Error(`diagram-${type}.md has no openflow example`);
  const input = join(scratch, `${type}.ofk`);
  writeFileSync(input, source);
  for (const theme of ['light', 'dark']) {
    const svgPath = join(scratch, `${type}-${theme}.svg`);
    execFileSync('node', ['mcp-server/dist/cli.js', 'render', input, '-o', svgPath, '--theme', theme], { stdio: 'ignore' });
    const svg = readFileSync(svgPath, 'utf8');
    // The diagram scales down to fit the card, never up: small diagrams stay crisp at their own size.
    await page.setContent(`<body style="margin:0;background:${GROUND[theme]};display:grid;place-items:center;width:${CARD.width}px;height:${CARD.height}px">
      <img style="max-width:${CARD.width - 2 * CARD.padding}px;max-height:${CARD.height - 2 * CARD.padding}px" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}"></body>`);
    await page.waitForFunction(() => document.images[0]?.complete);
    await page.screenshot({ path: join(OUT, `${type}-${theme}.png`) });
  }
}
await browser.close();
