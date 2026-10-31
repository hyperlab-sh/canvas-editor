import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from './test';
import { doc } from './helpers';

// F02 (2026-10-14): an agent asked to draw while the tab shows a repo map. The map is read from the code and never
// written: the change lands on the map's drawing, opened the way Canvas opens it (made from the map on screen the first
// time), as its own undo step. With nothing to copy yet (the repo still being read) the agent is told the next step and
// the person sees what it tried. The bridge is a real HTTP server with the MCP server's long-poll rules (as
// agent-presence.spec.ts), GitHub a fake repo served by page.route (as map-drawing.spec.ts).
// npx playwright test e2e/agent-repo-map.spec.ts --headed --workers=1

const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-ratelimit-remaining, x-ratelimit-reset' };
const REPO: Readonly<Record<string, string>> = {
  'README.md': '# shop\n',
  'web/package.json': '{"name":"web"}',
  'web/src/main.ts': "import { App } from './App';\nApp();\n",
  'web/src/App.ts': 'export const App = () => 1;\n',
  'api/package.json': '{"name":"api"}',
  'api/src/server.ts': "import { users } from './users';\nexport const s = users;\n",
  'api/src/users.ts': 'export const users = 1;\n',
};

interface Result { id: string; ok: boolean; output?: unknown; error?: string }
interface Bridge { port: number; results: Result[]; send: (request: unknown) => void; close: () => Promise<void> }

async function bridge(): Promise<Bridge> {
  const results: Result[] = [];
  const queue: unknown[] = [];
  let parked: ServerResponse | null = null;
  const reply = (response: ServerResponse, status: number, body?: unknown) => {
    response.writeHead(status, {
      'access-control-allow-origin': response.req.headers.origin ?? '*', 'access-control-allow-private-network': 'true',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    });
    response.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method === 'OPTIONS') { reply(response, 204); return; }
    if (path === '/hello') { request.resume(); request.on('end', () => reply(response, 200, { ok: true, protocol: 1, channel: true })); return; }
    if (path === '/result') {
      let body = '';
      request.on('data', (chunk) => { body += String(chunk); });
      request.on('end', () => { results.push(JSON.parse(body)); reply(response, 200, { ok: true }); });
      return;
    }
    if (path === '/next') {
      if (parked) { reply(parked, 204); parked = null; }
      if (queue.length) { reply(response, 200, queue.shift()); return; }
      parked = response;
      response.on('close', () => { if (parked === response) parked = null; });
      return;
    }
    reply(response, 404, { error: 'unknown' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port, results,
    send: (request) => { if (parked) { const response = parked; parked = null; reply(response, 200, request); } else queue.push(request); },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** The fake repo; `hold` keeps its file list unanswered (the repo is still being read) until it resolves. */
async function serveRepo(page: Page, hold?: Promise<void>): Promise<void> {
  await page.route('https://api.github.com/repos/acme/shop/git/trees/**', async (route) => {
    await hold;
    await route.fulfill({
      json: { sha: 'abc', truncated: false, tree: Object.entries(REPO).map(([path, text]) => ({ path, type: 'blob', mode: '100644', sha: 'x', size: text.length })) },
      headers: CORS,
    }).catch(() => undefined);
  });
  await page.route('https://raw.githubusercontent.com/acme/shop/**', (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/acme\/shop\/[^/]+\//, ''));
    return route.fulfill({ status: REPO[path] === undefined ? 404 : 200, contentType: 'text/plain', body: REPO[path] ?? '', headers: CORS });
  });
}

async function openMap(page: Page, port: number): Promise<void> {
  await page.addInitScript((port) => {
    localStorage.setItem('openflowkit-v2-preferences', JSON.stringify({ agentBridgeEnabled: true, bridgePort: port, bridgeToken: '' }));
  }, port);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/#/map/github/acme/shop');
  await page.waitForFunction(() => '__V2__' in window);
  await expect(page.locator('[data-bridge-status="connected"]').first()).toBeAttached({ timeout: 30_000 });
}

interface MapState { mode: 'canvas' | 'map'; nodes: string[] }
const mapState = (page: Page): Promise<MapState> =>
  page.evaluate(() => (window as unknown as { __V2__: { getMapState(): MapState } }).__V2__.getMapState())
    .catch(() => ({ mode: 'canvas', nodes: [] }) as MapState);
const pagesOf = async (page: Page) => (await doc(page).catch(() => null))?.pages ?? [];
const current = (page: Page) => page.getByRole('button', { name: /^Pages \(current: / }).getAttribute('aria-label');
const result = async (fake: Bridge, id: string): Promise<Result> => {
  await expect.poll(() => fake.results.some((entry) => entry.id === id), { timeout: 20_000 }).toBe(true);
  return fake.results.find((entry) => entry.id === id)!;
};

test('an agent drawing while the tab shows a repo map draws on its drawing, shown as Canvas shows it, one undo step @gate', async ({ page }) => {
  test.setTimeout(120_000);
  const fake = await bridge();
  try {
    await serveRepo(page);
    await openMap(page, fake.port);
    await expect.poll(async () => (await mapState(page)).mode, { timeout: 20_000 }).toBe('map');
    await expect.poll(async () => (await mapState(page)).nodes.length, { timeout: 20_000 }).toBeGreaterThan(0);
    const canvasSwitch = page.getByRole('button', { name: 'Canvas', exact: true });
    const before = await pagesOf(page);
    const mapPage = before[0]!;

    // A read on the map answers from the map page and changes nothing on screen.
    fake.send({ id: 'read', op: 'list_pages', input: {}, client: 'claude-code' });
    expect(await result(fake, 'read')).toMatchObject({ ok: true });
    expect((await mapState(page)).mode).toBe('map');
    expect(await pagesOf(page)).toHaveLength(before.length);

    // A change: the map's drawing is made from the map on screen and shown, and the shape lands there.
    fake.send({ id: 'draw', op: 'add_shape', input: { kind: 'rectangle', id: 'agent-box', label: 'Cache' }, client: 'claude-code' });
    expect(await result(fake, 'draw')).toMatchObject({ ok: true, output: { id: 'agent-box' } });
    await expect(canvasSwitch).toHaveAttribute('aria-pressed', 'true');
    const after = await pagesOf(page);
    expect(after).toHaveLength(before.length + 1);
    const drawing = after.at(-1)!;
    expect(drawing.name).toMatch(/\(drawing\)$/);
    expect(drawing.nodes.map((node) => node.id)).toContain('agent-box');
    expect(after[0]!.nodes).toHaveLength(mapPage.nodes.length);
    await expect.poll(() => current(page)).toContain(drawing.name);

    // One undo step takes the agent's shape away; the drawing (its own step) stays.
    await page.getByTestId('v2-canvas').focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await pagesOf(page)).at(-1)!.nodes.map((node) => node.id)).not.toContain('agent-box');
    expect(await pagesOf(page)).toHaveLength(before.length + 1);
    await expect(canvasSwitch).toHaveAttribute('aria-pressed', 'true');

    // Back on the map, a change addressed to the drawing by its pageId shows the drawing first (never out of sight).
    await page.getByRole('button', { name: 'Map', exact: true }).click();
    await expect.poll(async () => (await mapState(page)).mode).toBe('map');
    fake.send({ id: 'aimed', op: 'add_shape', input: { kind: 'rectangle', id: 'aimed-box' }, pageId: drawing.id, client: 'claude-code' });
    expect(await result(fake, 'aimed')).toMatchObject({ ok: true });
    await expect(canvasSwitch).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => current(page)).toContain(drawing.name);
    expect((await pagesOf(page)).at(-1)!.nodes.map((node) => node.id)).toContain('aimed-box');
    expect(await pagesOf(page)).toHaveLength(before.length + 1);
  } finally {
    await fake.close();
  }
});

test('an agent drawing while the repo is still being read is refused with the next step, and the person sees it @gate', async ({ page }) => {
  test.setTimeout(120_000);
  const fake = await bridge();
  let release = () => undefined as void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  try {
    await serveRepo(page, hold);
    await openMap(page, fake.port);
    const before = await pagesOf(page);
    expect(before.length).toBeGreaterThan(0);

    fake.send({ id: 'early', op: 'add_shape', input: { kind: 'rectangle', label: 'Cache' }, client: 'claude-code' });
    const refused = await result(fake, 'early');
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('repo map');
    expect(refused.error).toContain('press Canvas');
    const toast = page.getByRole('region', { name: 'Notifications' }).locator('.ofk-toast').filter({ hasText: 'tried to draw on the repo map' });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('Claude Code');
    await expect(toast).toContainText('still being read');
    expect(await pagesOf(page)).toHaveLength(before.length);
  } finally {
    release();
    await fake.close();
  }
});
