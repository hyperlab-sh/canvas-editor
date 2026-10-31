// README stills, the hero GIF and the link-preview cards, captured from the
// real app (headed Chromium for WebGL; nothing mocked):
//
//   APP_URL=http://localhost:4310/ node scripts/capture-readme.mjs [hero code og gif mapgif]
//
// No parts = all of them, in that order. Needs the
// docs-site install for sharp and a built mcp-server/dist for the agent scenes;
// the agent's MCP server runs on AGENT_PORT (default 43147), never on 43119.
// The map reads MAP_REPO from GitHub: one API call of the 60/h anonymous budget, or none with
// GITHUB_REC=<folder of recorded responses> (replayed; a miss is fetched once and saved there).
//
// ponytail: these go stale when the UI changes; re-run against a fresh build.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { encodeGif, glide, record, showPointer } from './readme/gif.mjs';
import { CHECKOUT, SUBMIT, agentScene, codeScene, frameOn, mapSettled, nameDocument, openMap, openPage, setScheme, still } from './readme/scenes.mjs';
import { connectAgent } from './readme/agent.mjs';

const sharp = createRequire(new URL('../docs-site/package.json', import.meta.url))('sharp');
const root = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const README = root('assets/readme/');
const STILL = { width: 1280, height: 800 };
const MAP = { width: 1440, height: 900 };
const BUDGET = 500 * 1024;

/** 2x capture → 1600 px wide PNG under 500 KB (full colour if it fits, else a 256-colour palette). */
async function savePng(buffer, name) {
  const resized = sharp(buffer).resize({ width: 1600 });
  let out = await resized.clone().png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  if (out.length > BUDGET) out = await resized.clone().png({ palette: true, quality: 95, compressionLevel: 9 }).toBuffer();
  writeFileSync(`${README}${name}`, out);
  console.log(`assets/readme/${name} ${Math.round(out.length / 1024)} KB`);
}

async function pair(browser, viewport, scene, name) {
  const page = await openPage(browser, { viewport });
  const agent = await scene(page);
  for (const scheme of ['light', 'dark']) {
    await setScheme(page, scheme);
    await savePng(await still(page), `${name}-${scheme}.png`);
  }
  await agent?.close();
  await page.context().close();
}

const PARTS = {
  hero: (browser) => pair(browser, STILL, agentScene, 'hero'),
  code: (browser) => pair(browser, STILL, codeScene, 'code'),
  og: ogCards,
  gif: async (browser) => { for (const scheme of ['light', 'dark']) await heroGif(browser, scheme); },
  mapgif: async (browser) => { for (const scheme of ['light', 'dark']) await mapGif(browser, scheme); },
};

/**
 * 1200×630 link preview: the logo, a short headline, and the checkout as text beside the diagram it
 * compiles to, drawn by the CLI as SVG so it stays sharp at feed size. Needs a built mcp-server/dist.
 */
async function ogCards(browser) {
  const logo = readFileSync(root('docs-site/src/assets/Logo_openflowkit.svg'), 'utf8');
  // The checkout without its cache and title: five icons stay legible at feed size.
  const source = CHECKOUT.replace('architecture down', 'architecture right').replace(/^title:.*\n\n/m, '').replace(/^.*Cache.*\n/gm, '');
  const diagram = execFileSync(process.execPath, [root('mcp-server/dist/cli.js'), 'render', '-', '--theme', 'light'], { input: source, encoding: 'utf8' });
  const code = ['Web [tech/react]', 'API [tech/go]', 'Stripe [tabler/brand-stripe]', '', 'Web -> API : place order', 'API -> Stripe : charge']
    .map((line) => line.replace(/(\[[^\]]+\])/g, '<i>$1</i>').replace(/(->)/g, '<b>$1</b>').replace(/(: .*)$/, '<u>$1</u>')).join('\n');
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><html><head><style>
    * { box-sizing: border-box; margin: 0; }
    body { width: 1200px; height: 630px; overflow: hidden; background: #f7f6f3;
      background-image: radial-gradient(#dcd8d1 1.2px, transparent 1.2px); background-size: 24px 24px;
      font-family: -apple-system, 'SF Pro Display', Inter, 'Segoe UI', sans-serif; color: #1c1917; position: relative; }
    .text { position: absolute; left: 64px; top: 60px; width: 490px; }
    .brand { display: flex; align-items: center; gap: 14px; font-size: 30px; font-weight: 680; letter-spacing: -0.015em; }
    .brand svg { width: 52px; height: 52px; }
    h1 { margin-top: 64px; font-size: 56px; line-height: 1.04; font-weight: 760; letter-spacing: -0.035em; }
    h1 em { font-style: normal; color: #e95420; }
    .tags { margin-top: 34px; display: flex; gap: 10px; flex-wrap: wrap; }
    .tags span { font-size: 19px; font-weight: 560; color: #44403c; background: #fff; border: 1px solid #e3e0da; border-radius: 999px; padding: 8px 16px; }
    .url { position: absolute; left: 64px; bottom: 54px; font-size: 22px; font-weight: 600; color: #78716c; letter-spacing: -0.01em; }
    .canvas { position: absolute; left: 580px; top: 44px; width: 576px; height: 336px; background: #fff; border: 1px solid #e3e0da; border-radius: 20px;
      box-shadow: 0 30px 70px rgba(28, 25, 23, 0.14), 0 2px 8px rgba(28, 25, 23, 0.06); display: grid; place-items: center; padding: 10px; }
    .canvas svg { width: 100%; height: 100%; }
    .code { position: absolute; left: 616px; top: 350px; width: 420px; background: #1c1917; color: #e7e5e4; border-radius: 16px; padding: 22px 26px;
      font: 500 19px/1.5 'SF Mono', ui-monospace, Menlo, monospace; white-space: pre; box-shadow: 0 24px 50px rgba(28, 25, 23, 0.28); }
    .code i { font-style: normal; color: #a8a29e; } .code b { font-weight: 600; color: #f97316; } .code u { text-decoration: none; color: #fdba74; }
    .code .file { font: 600 14px/1 -apple-system, Inter, sans-serif; color: #a8a29e; letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 14px; }
  </style></head><body>
    <div class="text">
      <div class="brand">${logo}OpenFlowKit</div>
      <h1>Architecture<br>diagrams <em>as code</em>,<br>with your agent.</h1>
      <div class="tags"><span>Free &amp; open source</span><span>Local-first</span><span>MCP</span></div>
    </div>
    <div class="url">openflowkit.com</div>
    <div class="canvas">${diagram}</div>
    <div class="code"><div class="file">checkout.ofk</div>${code}</div>
  </body></html>`);
  await page.evaluate(() => document.fonts.ready);
  const card = await sharp(await page.screenshot()).resize(1200, 630).png({ compressionLevel: 9 }).toBuffer();
  for (const path of ['public/og.png', 'docs-site/public/og.png']) {
    writeFileSync(root(path), card);
    console.log(`${path} ${Math.round(card.length / 1024)} KB`);
  }
  await page.close();
}

/**
 * The README GIF, all real: a paired agent draws the checkout → the user drags Stripe (its connector follows) →
 * ⌥C, one new line → ⌘↵ regenerates. Recorded at 1200×750, scaled to 960 px, once per theme
 * (the README's <picture> shows the reader's).
 */
async function heroGif(browser, scheme) {
  const GIF = { width: 960, height: 600 };
  const page = await openPage(browser, { viewport: { width: 1200, height: 750 }, scale: 1 });
  await page.emulateMedia({ colorScheme: scheme });
  await page.waitForSelector('[data-testid="v2-canvas"]');
  // The welcome's arrows point at chrome the GIF never uses; at this size they only crowd the first second.
  await page.addStyleTag({ content: '.ofk-v2-guide { display: none !important; }' });
  await nameDocument(page);
  const agent = await connectAgent(page);
  await showPointer(page);
  const start = { x: 120, y: 560 };
  await page.mouse.move(start.x, start.y);
  await page.waitForTimeout(800);
  const nodeCentre = async (label) => page.evaluate((name) => {
    const node = window.__V2__.getDocument().pages[0].nodes.find((n) => n.content?.label === name);
    const r = node && window.__V2__.getNodeRect(node.id);
    return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, label);

  const frames = await record(page, async () => {
    await page.waitForTimeout(400);
    // 1. The agent draws (one MCP call, the same the agent's client makes).
    await agent.call('create_diagram', { dsl: CHECKOUT.split('\n').filter((line) => !line.includes('Events')).join('\n') });
    await page.waitForTimeout(400);
    await page.getByTestId('v2-canvas').focus();
    await page.keyboard.press('Shift+1');
    await page.waitForTimeout(700);
    // 2. Drag Stripe up and in, inside its frame: the connector follows.
    const stripe = await nodeCentre('Stripe');
    await glide(page, start, stripe, 450);
    await page.mouse.down();
    const to = { x: stripe.x + 20, y: stripe.y - 110 };
    await glide(page, stripe, to, 600);
    await page.mouse.up();
    await page.waitForTimeout(300);
    // 3. ⌥C, one new line at the end of the source, ⌘↵.
    await page.keyboard.press('Alt+c');
    const editor = page.getByRole('textbox', { name: 'Diagram source' });
    await editor.waitFor();
    await page.waitForTimeout(300);
    const box = await editor.boundingBox();
    const caret = { x: box.x + box.width * 0.6, y: box.y + box.height * 0.75 };
    await glide(page, to, caret, 350);
    await editor.click({ position: { x: caret.x - box.x, y: caret.y - box.y } });
    await page.keyboard.press('Meta+ArrowDown');
    await page.keyboard.type('\nAPI -> Kafka : order.paid', { delay: 22 });
    await page.waitForTimeout(250);
    await page.keyboard.press(SUBMIT);
    await page.waitForTimeout(600);
    // 4. Click off the diagram and fit: the regenerated checkout, whole.
    const off = { x: 110, y: 640 };
    await glide(page, caret, off, 350);
    await page.mouse.click(off.x, off.y);
    await page.keyboard.press('Shift+1');
    await page.waitForTimeout(400);
  }, { interval: 100 });
  await agent.close();
  await page.context().close();

  await saveGif(frames, GIF, `hero-${scheme}.gif`);
}

async function saveGif(frames, size, name) {
  const decoded = await Promise.all(frames.map(async ({ t, png }) => ({
    t, rgba: new Uint8Array(await sharp(png).resize(size.width, size.height).ensureAlpha().raw().toBuffer()),
  })));
  const { bytes, frames: count, ms } = encodeGif(decoded, { ...size, holdMs: 1500 });
  writeFileSync(`${README}${name}`, bytes);
  console.log(`assets/readme/${name} ${(bytes.length / 1048576).toFixed(2)} MB, ${count} frames, ${(ms / 1000).toFixed(1)} s`);
  if (ms > 12_000 || bytes.length > 4 * 1048576) console.warn(`${name} is over its budget (12 s, 4 MB): a slow machine stretches the waits; re-run or trim them.`);
}

/**
 * The repo map GIF, all real: MAP_REPO's top level → click checkoutservice, it opens in place with its card beside it →
 * Top level closes it again and Escape lets go, so the loop ends where it starts. Recorded at 1440×900 (the map toolbar needs the width), 1152 px.
 */
async function mapGif(browser, scheme) {
  const page = await openPage(browser, { viewport: MAP, scale: 1 });
  await page.emulateMedia({ colorScheme: scheme });
  await openMap(page);
  // Every box but the one stray script, so nothing starts cut off at an edge.
  await frameOn(page, ['src/frontend', 'root#more', 'root#outside', 'src/productcatalogservice', 'src/recommendationservice']);
  await showPointer(page);
  const box = await page.evaluate(() => window.__V2__.getNodeRect('src/checkoutservice'));
  const checkout = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const topLevel = page.getByRole('toolbar', { name: 'Map depth', exact: true }).getByRole('button', { name: 'Top level' });
  const start = { x: 700, y: 820 };
  await page.mouse.move(start.x, start.y);
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  const frames = await record(page, async () => {
    await page.waitForTimeout(900);
    await glide(page, start, checkout, 550);
    await page.mouse.click(checkout.x, checkout.y);
    await page.waitForFunction(() => window.__V2__.getMapState().open.includes('src/checkoutservice'));
    await mapSettled(page);
    await page.waitForTimeout(2600);
    const button = await topLevel.boundingBox();
    await glide(page, checkout, { x: button.x + button.width / 2, y: button.y + button.height / 2 }, 550);
    await topLevel.click();
    await mapSettled(page);
    // Nothing selected, so nothing dimmed: the last frame reads like the first.
    await page.getByTestId('v2-canvas').focus();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
  }, { interval: 100 });
  await page.context().close();
  await saveGif(frames, { width: 1152, height: 720 }, `map-${scheme}.gif`);
}

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PARTS);
mkdirSync(README, { recursive: true });
const browser = await chromium.launch({ headless: false });
try {
  for (const name of wanted) await PARTS[name](browser);
} finally {
  await browser.close();
}
