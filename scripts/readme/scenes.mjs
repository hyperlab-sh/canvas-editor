// The scenes behind every README and docs screenshot, driven through the real
// app (no mocks): the checkout diagram from the code panel, the same diagram
// drawn by a paired agent, a repo map with one box open in place, and home.
// Used by scripts/capture-readme.mjs and docs-site/scripts/capture-screens.mjs.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectAgent } from './agent.mjs';

export const APP = process.env.APP_URL ?? 'http://127.0.0.1:4173/';
export const SUBMIT = process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter';
/** A public multi-service repo that maps well; one GitHub API call per read (60/h without a token). */
export const MAP_REPO = process.env.MAP_REPO ?? 'GoogleCloudPlatform/microservices-demo';
/** A folder of recorded GitHub responses: replayed when present, recorded on a miss (keeps re-runs off the rate limit). */
const GITHUB_REC = process.env.GITHUB_REC;

// Short lines, so the code panel never wraps or clips them; explicit icons, so
// the picture does not shift with the auto-icon heuristics.
export const TITLE = 'Checkout architecture';
export const CHECKOUT = `architecture down
title: ${TITLE}

Web [tech/react]
API [tech/go]
Orders [tech/postgresql]
Cache [tech/redis]
Stripe [tabler/brand-stripe, violet]
Events [tech/kafka, teal]

Web -> API : place order
API -> Orders : write
API -> Cache : session
API -> Stripe : charge
API -> Events : order.paid`;

const settle = (page, ms = 900) => page.waitForTimeout(ms);

/** A fresh browser context (first visit: no recents, no saved panels). Toasts are transient chrome, kept out of the picture. */
export async function openPage(browser, { viewport, scale = 2, path = '' }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: scale, colorScheme: 'light' });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.warn(`page error: ${error.message}`));
  if (GITHUB_REC) await replayGithub(page);
  await page.goto(APP + path);
  await page.addStyleTag({ content: '.ofk-toasts { visibility: hidden !important; }' });
  return page;
}

// Same file naming as the map lane's recorder, so its recordings replay here.
async function replayGithub(page) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-ratelimit-remaining, x-ratelimit-reset' };
  await page.route(/https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const file = join(GITHUB_REC, encodeURIComponent(route.request().url().replace(/^https:\/\//, '')).slice(0, 240));
    if (!existsSync(file)) {
      const response = await route.fetch();
      writeFileSync(file, JSON.stringify({ status: response.status(), ct: response.headers()['content-type'] ?? 'text/plain', body: (await response.body()).toString('base64') }));
      console.log(`github live: ${response.status()} ${route.request().url().slice(0, 100)}`);
    }
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    return route.fulfill({ status: saved.status, contentType: saved.ct, body: Buffer.from(saved.body, 'base64'), headers: cors });
  });
}

export async function setScheme(page, colorScheme) {
  await page.emulateMedia({ colorScheme });
  await settle(page, 1200);
}

/** No focus ring, no hover, no pointer in the frame. */
export async function still(page) {
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.mouse.move(1, 1);
  await settle(page, 600);
  return page.screenshot();
}

/** Ctrl+wheel (a trackpad pinch) at the centre of `rect`, in 10 px ticks: negative zooms in, positive out (40 px ≈ ×0.68). */
export async function pinch(page, rect, deltaY) {
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.keyboard.down('Control');
  for (let i = 0; i < Math.abs(deltaY) / 10; i += 1) { await page.mouse.wheel(0, Math.sign(deltaY) * 10); await page.waitForTimeout(40); }
  await page.keyboard.up('Control');
  await settle(page);
}

/** Zoom to fit (the app fits the free area beside panels) with nothing selected.
 * Escape would also close an open agent panel, so only the code panel scene deselects with it. */
export async function fit(page, { deselect = false } = {}) {
  await page.getByTestId('v2-canvas').focus();
  if (deselect) await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+1');
  await settle(page);
}

/** Pinches and scrolls (as a trackpad would) until the boxes `ids` fill the free canvas left of the side panel. */
export async function frameOn(page, ids) {
  const viewport = page.viewportSize();
  const panel = await page.locator('.ofk-v2-workspace-panel').first().boundingBox();
  const free = { x: 30, y: 90, width: (panel?.x ?? viewport.width) - 110, height: viewport.height - 200 };
  const bounds = () => page.evaluate((list) => {
    const rects = list.map((id) => window.__V2__.getNodeRect(id)).filter(Boolean);
    const x = Math.min(...rects.map((r) => r.x)); const y = Math.min(...rects.map((r) => r.y));
    return { x, y, width: Math.max(...rects.map((r) => r.x + r.width)) - x, height: Math.max(...rects.map((r) => r.y + r.height)) - y };
  }, ids);
  const centre = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  for (let tick = 0; tick < 40; tick += 1) {
    const r = await bounds();
    const next = 1 / 0.908;
    if (r.width * next > free.width * 0.92 || r.height * next > free.height * 0.92) break;
    const c = centre(r);
    await page.mouse.move(c.x, c.y);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -10);
    await page.keyboard.up('Control');
    await page.waitForTimeout(80);
  }
  await settle(page, 500);
  for (let step = 0; step < 4; step += 1) {
    const c = centre(await bounds());
    const dx = c.x - (free.x + free.width / 2); const dy = c.y - (free.y + free.height / 2);
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) break;
    await page.mouse.move(free.x + free.width / 2, free.y + free.height / 2);
    await page.mouse.wheel(dx, dy);
    await settle(page, 400);
  }
}

/** Names the document through the title field in the document bar, as a person would. */
export async function nameDocument(page, name = TITLE) {
  const title = page.locator('button[title="Rename diagram"]');
  if ((await title.innerText()).trim() === name) return;
  await title.click();
  const field = page.getByRole('textbox', { name: 'Diagram title' });
  await field.fill(name);
  await field.press('Enter');
  await settle(page, 300);
}

async function editorReady(page) {
  await page.waitForSelector('[data-testid="v2-canvas"]');
  await page.waitForFunction(() => Boolean(window.__V2__));
}

/** Code panel open beside the diagram it generated. */
export async function codeScene(page, source = CHECKOUT) {
  await editorReady(page);
  await page.getByRole('toolbar', { name: 'Workspace', exact: true }).getByRole('button', { name: 'Diagram as code' }).click();
  const editor = page.getByRole('textbox', { name: 'Diagram source' });
  await editor.fill(source);
  await editor.press(SUBMIT);
  await page.waitForFunction(() => (window.__V2__?.getState().nodes.length ?? 0) > 3);
  await settle(page, 600);
  await nameDocument(page);
  await fit(page, { deselect: true });
}

/** A real MCP agent paired over the Connect agent panel draws the diagram; the panel shows its activity line. */
export async function agentScene(page, source = CHECKOUT) {
  await editorReady(page);
  const agent = await connectAgent(page);
  await agent.call('create_diagram', { dsl: source });
  await page.locator('.ofk-connection-activity').waitFor();
  await settle(page, 600);
  await nameDocument(page);
  await fit(page);
  return agent;
}

/** The repo's map, checkoutservice opened in place, the checkout → payment arrow selected with its file:line evidence. */
/** Waits out the map's grow-in-place motion. */
export const mapSettled = (page) => page.waitForFunction(() => !window.__V2__.getMapMotion().running, null, { timeout: 30_000 });

/** MAP_REPO's map, read and laid out, at its top level. */
export async function openMap(page) {
  await page.goto(`${APP}#/map/github/${MAP_REPO}`);
  await editorReady(page);
  await page.waitForFunction(() => (window.__V2__.getMapState?.().nodes.length ?? 0) > 5, null, { timeout: 60_000 })
    .catch(async () => { throw new Error(`Map did not load (GitHub rate limit?): ${(await page.locator('body').innerText()).slice(0, 300)}`); });
  await page.waitForFunction(() => !/Reading \d/.test(document.body.innerText), null, { timeout: 60_000 });
  await mapSettled(page);
}

export async function mapScene(page) {
  await openMap(page);
  const settled = () => mapSettled(page);
  // Click the box, as a reader would: it opens in place.
  const box = await page.evaluate(() => window.__V2__.getNodeRect('src/checkoutservice'));
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(() => window.__V2__.getMapState().open.includes('src/checkoutservice'));
  await settled();
  // Close in on frontend → checkoutservice (open, its card beside it) → paymentservice. Nothing else is selected:
  // an arrow's evidence would dim the open box, the point of the picture.
  await frameOn(page, ['src/frontend', 'src/checkoutservice', 'src/paymentservice']);
  await settled();
}

export async function homeScene(page) {
  await page.goto(`${APP}#/home`);
  await page.waitForSelector('[data-testid="v2-home"] .ofk-home-templates img');
  await page.waitForFunction(() => [...document.querySelectorAll('.ofk-home-templates img')].every((img) => img.complete));
  await settle(page);
}
