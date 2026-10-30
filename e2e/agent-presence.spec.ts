import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from './test';

// An agent's edit, live on the canvas: a named cursor shows while the request runs and glides to the change, and the
// change builds in (pop in connector order, lines drawing on). Presentation only: the shapes are in the document, one
// undo step, the moment the result is posted. The bridge is a real HTTP server with the MCP server's long-poll rules,
// so the op travels the same path an MCP client's does (useV2AgentBridge → runLiveAgentOp → commit).
// CANVAS_SHOTS_DIR=<dir> also writes the frames (light and dark).

const SHOTS = process.env.CANVAS_SHOTS_DIR;
const DSL = 'flowchart\n  Client -> API\n  API -> Queue\n  Queue -> Worker\n  Worker -> Database';

interface Bridge { port: number; results: { id: string; ok: boolean; output?: { frameId?: string; base64?: string; mime?: string } }[]; send: (request: unknown) => void; close: () => Promise<void> }

async function bridge(): Promise<Bridge> {
  const results: Bridge['results'] = [];
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

async function open(page: Page, port: number, theme: 'light' | 'dark'): Promise<void> {
  await page.addInitScript(({ port, theme }) => {
    localStorage.setItem('canvas-v2-preferences', JSON.stringify({ theme, agentBridgeEnabled: true, bridgePort: port, bridgeToken: '' }));
  }, { port, theme });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/d/presence-${theme}-${Date.now().toString(36)}`);
  await expect(page.getByTestId('v2-editor')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-bridge-status="connected"]').first()).toBeVisible({ timeout: 30_000 });
}

type Api = {
  getDocument: () => { pages: { nodes: { kind: string }[]; connectors: unknown[] }[] };
  getRevealState: () => { active: boolean; runs: number; frames: number; groups: number; morphs: number; durationMs: number; cut: number } | null;
};
const reveal = (page: Page) => page.evaluate(() => (window as unknown as { __V2__: Api }).__V2__.getRevealState());
const shapes = (page: Page) => page.evaluate(() => {
  const first = (window as unknown as { __V2__: Api }).__V2__.getDocument().pages[0]!;
  return { nodes: first.nodes.filter((node) => node.kind !== 'frame').length, connectors: first.connectors.length };
});
/** Every state the cursor goes through, in order (a slow run can pass a state between two polls). */
const recordStates = (page: Page) => page.evaluate(() => {
  const el = document.querySelector('[data-testid="v2-agent-cursor"]')!;
  const seen: string[] = [];
  (window as unknown as { __cursorStates: string[] }).__cursorStates = seen;
  new MutationObserver(() => { const state = el.getAttribute('data-state') ?? ''; if (seen.at(-1) !== state) seen.push(state); })
    .observe(el, { attributes: true, attributeFilter: ['data-state'] });
});
const states = (page: Page) => page.evaluate(() => (window as unknown as { __cursorStates: string[] }).__cursorStates);
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

for (const theme of ['light', 'dark'] as const) {
  test(`an agent's diagram builds in under its named cursor, in the document at once as one undo step (${theme})`, { tag: theme === 'light' ? '@gate' : [] }, async ({ page }) => {
    test.setTimeout(90_000);
    const fake = await bridge();
    try {
      await open(page, fake.port, theme);
      const cursor = page.getByTestId('v2-agent-cursor');
      await recordStates(page);
      fake.send({ id: 'r1', op: 'create_diagram', input: { dsl: DSL }, client: 'claude-code' });
      // The cursor names the agent from its MCP clientInfo.
      await expect(cursor).toContainText('Claude Code');
      // It shows while the agent works, then glides to the change.
      await expect(cursor).toHaveAttribute('data-state', /working|gliding/, { timeout: 20_000 });
      await expect.poll(() => fake.results.length, { timeout: 20_000 }).toBe(1);
      expect(fake.results[0]).toMatchObject({ id: 'r1', ok: true });
      // In the document already: the motion is a view over it. (Polled: the test hook reads the last render, which can trail
      // the commit by a frame on a loaded machine.)
      await expect.poll(() => shapes(page), { timeout: 2000 }).toEqual({ nodes: 5, connectors: 4 });
      await expect.poll(async () => (await reveal(page))?.runs ?? 0).toBe(1);
      const started = await reveal(page);
      expect(started!.groups).toBeGreaterThanOrEqual(9);
      // A filmstrip of the build (screenshots take ~50-100 ms each, so the times are rough).
      for (const frame of [1, 2, 3, 4]) { await page.waitForTimeout(120); await shot(page, `${theme}-1-building-${frame}`); }
      // The agent's screenshot reads the document, not the canvas: taken mid-build, it is whole.
      fake.send({ id: 'r2', op: 'screenshot', input: { frameId: fake.results[0]!.output!.frameId }, client: 'claude-code' });
      await expect.poll(() => fake.results.length, { timeout: 20_000 }).toBe(2);
      expect(fake.results[1]).toMatchObject({ id: 'r2', ok: true, output: { mime: 'image/png' } });
      // The build ends by itself, having drawn frames on the way.
      await expect.poll(async () => (await reveal(page))?.active, { timeout: 5000 }).toBe(false);
      const ended = await reveal(page);
      // It started, drew on a later frame than its first (it animated, not jumped), and ran to its end. Not a frame count:
      // headless SwiftShader drew 8-12 frames in the 700 ms here (review 2 #11), a slow CI runner fewer.
      expect(ended!.frames).toBeGreaterThan(1);
      expect(ended!.cut).toBe(0);
      // The cursor rests on the change and never takes a click: what is under it is the canvas.
      if (SHOTS) await expect(cursor).toHaveAttribute('data-state', 'resting', { timeout: 5000 });
      await shot(page, `${theme}-2-resting`);
      const box = (await cursor.boundingBox())!;
      const under = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.canvas-agent-cursor') !== null, { x: box.x + 30, y: box.y + 28 });
      expect(under).toBe(false);
      // It fades out after a quiet second and a half.
      await expect(cursor).toHaveAttribute('data-state', 'hidden', { timeout: 6000 });
      // Working, a glide to the change, a rest there, then gone.
      expect(await states(page)).toEqual(expect.arrayContaining(['gliding', 'resting', 'leaving', 'hidden']));
      expect((await states(page)).indexOf('gliding')).toBeLessThan((await states(page)).indexOf('resting'));
      // One undo step takes the whole diagram away.
      await page.getByTestId('v2-canvas').focus();
      await page.keyboard.press('ControlOrMeta+z');
      await expect.poll(() => shapes(page)).toEqual({ nodes: 0, connectors: 0 });
    } finally {
      await fake.close();
    }
  });
}

test('an update slides the shapes it moved from where they were and builds in the new one', async ({ page }) => {
  test.setTimeout(90_000);
  const fake = await bridge();
  try {
    await open(page, fake.port, 'light');
    fake.send({ id: 'r1', op: 'create_diagram', input: { dsl: DSL }, client: 'claude-code' });
    await expect.poll(() => fake.results.length, { timeout: 20_000 }).toBe(1);
    await expect.poll(async () => (await reveal(page))?.runs ?? 0).toBe(1);
    await expect.poll(async () => (await reveal(page))?.active, { timeout: 5000 }).toBe(false);
    // A cache between the API and the queue: the shapes below it move down.
    const frameId = fake.results[0]!.output!.frameId;
    fake.send({ id: 'r2', op: 'update_diagram', input: { frameId, dsl: DSL.replace('API -> Queue', 'API -> Cache\n  Cache -> Queue') }, client: 'claude-code' });
    await expect.poll(() => fake.results.length, { timeout: 20_000 }).toBe(2);
    expect(fake.results[1]).toMatchObject({ id: 'r2', ok: true });
    await expect.poll(() => shapes(page), { timeout: 2000 }).toEqual({ nodes: 6, connectors: 5 });
    await expect.poll(async () => (await reveal(page))?.runs ?? 0).toBe(2);
    expect((await reveal(page))!.morphs).toBeGreaterThan(0);
    await page.waitForTimeout(200);
    await shot(page, 'update-morphing');
    await expect.poll(async () => (await reveal(page))?.active, { timeout: 5000 }).toBe(false);
    expect((await reveal(page))!.cut).toBe(0);
  } finally {
    await fake.close();
  }
});

test('with reduced motion nothing builds in: the cursor shows at the change, then fades', async ({ page }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const fake = await bridge();
  try {
    await open(page, fake.port, 'light');
    const cursor = page.getByTestId('v2-agent-cursor');
    await recordStates(page);
    fake.send({ id: 'r1', op: 'create_diagram', input: { dsl: DSL }, client: 'cursor-vscode' });
    await expect.poll(() => fake.results.length, { timeout: 20_000 }).toBe(1);
    await expect.poll(() => shapes(page), { timeout: 2000 }).toEqual({ nodes: 5, connectors: 4 });
    await expect(cursor).toHaveAttribute('data-reveal', 'reduced');
    await expect(cursor).toContainText('Cursor');
    if (SHOTS) await expect(cursor).toHaveAttribute('data-state', 'resting');
    await shot(page, 'reduced-resting');
    expect((await reveal(page))!.runs).toBe(0);
    await expect(cursor).toHaveAttribute('data-state', 'hidden', { timeout: 6000 });
    // It rests at the change and fades; it never glides.
    expect(await states(page)).toEqual(expect.arrayContaining(['resting', 'hidden']));
    expect(await states(page)).not.toContain('gliding');
  } finally {
    await fake.close();
  }
});
