import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from './test';

// Two editor tabs with the agent bridge on (a per-browser setting, so every tab has it). Each poll used to end the
// other tab's parked poll: ~600 polls a second per tab, and an agent's ops landed in either tab (audit F2,
// 2026-10-13). One tab owns the bridge now; the other says so and can take it back.
//
// The bridge here is a real HTTP server with the MCP server's long-poll rules: a new poll answers the parked one
// with 204. `tabAware` adds the newer rule: a poll from a tab that is not the latest to say hello gets 409.

interface FakeBridge {
  readonly port: number;
  readonly polls: Map<string, number>;
  readonly results: { tab: string; body: string }[];
  send: (request: unknown) => void;
  close: () => Promise<void>;
}

async function fakeBridge({ tabAware, token = '' }: { tabAware: boolean; token?: string }): Promise<FakeBridge> {
  const polls = new Map<string, number>();
  const results: { tab: string; body: string }[] = [];
  const queue: unknown[] = [];
  let parked: ServerResponse | null = null;
  let latest = '';
  const reply = (response: ServerResponse, status: number, body?: unknown) => {
    response.writeHead(status, {
      'access-control-allow-origin': response.req.headers.origin ?? '*',
      'access-control-allow-private-network': 'true',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    });
    response.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const tab = url.searchParams.get('tab') ?? '(none)';
    if (request.method === 'OPTIONS') { reply(response, 204); return; }
    if (token && url.searchParams.get('token') !== token) { reply(response, 401, { error: 'Missing or wrong x-canvas-token.' }); return; }
    if (url.pathname === '/hello') { latest = tab; request.resume(); request.on('end', () => reply(response, 200, { ok: true, protocol: 1, channel: true })); return; }
    if (url.pathname === '/result') {
      let body = '';
      request.on('data', (chunk) => { body += String(chunk); });
      request.on('end', () => { results.push({ tab, body }); reply(response, 200, { ok: true }); });
      return;
    }
    if (url.pathname === '/next') {
      polls.set(tab, (polls.get(tab) ?? 0) + 1);
      if (tabAware && tab !== latest) { reply(response, 409, { error: 'Another tab has the bridge.' }); return; }
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
    port: (server.address() as AddressInfo).port,
    polls,
    results,
    send: (request) => {
      if (parked) { const response = parked; parked = null; reply(response, 200, request); } else queue.push(request);
    },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const bridgeStatus = (page: Page) => page.getByRole('toolbar', { name: 'Workspace', exact: true })
  .getByRole('button', { name: 'Connect agent', exact: true });

async function openTab(page: Page, port: number, { theme = 'light', enabled = true, path = '/' } = {}): Promise<void> {
  await page.addInitScript(({ bridgePort, theme, enabled }) => {
    localStorage.setItem('canvas-v2-preferences', JSON.stringify({ theme, agentBridgeEnabled: enabled, bridgePort, bridgeToken: '' }));
  }, { bridgePort: port, theme, enabled });
  await page.goto(path);
  await expect(page.getByTestId('v2-editor')).toBeVisible({ timeout: 30_000 });
}

const total = (polls: Map<string, number>) => [...polls.values()].reduce((sum, count) => sum + count, 0);

for (const tabAware of [false, true]) {
  test(`two tabs: one polls, the other says another tab has it (${tabAware ? 'tab-aware' : 'older'} server)`, async ({ context }) => {
    test.setTimeout(90_000);
    const bridge = await fakeBridge({ tabAware });
    try {
      const first = await context.newPage();
      await openTab(first, bridge.port);
      await expect(bridgeStatus(first)).toHaveAttribute('data-bridge-status', 'connected');
      const second = await context.newPage();
      await openTab(second, bridge.port);
      await second.waitForTimeout(500);
      const before = total(bridge.polls);
      await second.waitForTimeout(3000);
      // A parked poll lasts 25 s: two tabs that leave each other alone poll a handful of times in 3 s, not thousands.
      expect(total(bridge.polls) - before).toBeLessThan(10);
      await bridgeStatus(second).click();
      const panel = second.getByRole('complementary', { name: 'Connect agent' });
      await expect(panel.getByText('Connect is on in another tab.')).toBeVisible();

      // "Use this tab" moves the bridge here, and the agent's next op lands here, not in the first tab.
      await panel.getByRole('button', { name: 'Use this tab' }).click();
      await expect(bridgeStatus(second)).toHaveAttribute('data-bridge-status', 'connected');
      await first.bringToFront();
      await bridgeStatus(first).click();
      await expect(first.getByRole('complementary', { name: 'Connect agent' }).getByText('Connect is on in another tab.')).toBeVisible();
      await second.bringToFront();
      await second.waitForTimeout(500);
      bridge.send({ id: 'r1', op: 'add_shape', input: { kind: 'rectangle', id: 'from-agent' }, client: 'claude-code' });
      await expect.poll(() => bridge.results.length, { timeout: 15_000 }).toBe(1);
      const owner = await second.evaluate(() => sessionStorage.getItem('canvas-agent-tab'));
      expect(bridge.results[0].tab).toBe(owner);
      expect(JSON.parse(bridge.results[0].body)).toMatchObject({ id: 'r1', ok: true });
      await expect(panel.getByRole('status').filter({ hasText: 'Claude Code added a rectangle' })).toBeVisible();
    } finally {
      await bridge.close();
    }
  });
}

// Another browser (or profile) shares no Web Lock with this one: the server's 409 is what stops the replaced tab.
test('a tab replaced from another browser stops polling, and Use this tab takes the bridge back', async ({ context, browser }) => {
  test.setTimeout(90_000);
  const bridge = await fakeBridge({ tabAware: true });
  const elsewhere = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
  const tabOf = (page: Page) => page.evaluate(() => sessionStorage.getItem('canvas-agent-tab') ?? '');
  try {
    const first = await context.newPage();
    await openTab(first, bridge.port);
    await expect(bridgeStatus(first)).toHaveAttribute('data-bridge-status', 'connected');
    const second = await elsewhere.newPage();
    await openTab(second, bridge.port);
    await expect(bridgeStatus(second)).toHaveAttribute('data-bridge-status', 'connected');

    await first.bringToFront();
    await bridgeStatus(first).click();
    const panel = first.getByRole('complementary', { name: 'Connect agent' });
    // Not "Connect is on in another tab": the tab that has it is in another browser.
    await expect(panel.getByText('Another Canvas tab has the agent connection.')).toBeVisible();
    const firstTab = await tabOf(first);
    const stopped = bridge.polls.get(firstTab) ?? 0;
    await first.waitForTimeout(3000);
    expect(bridge.polls.get(firstTab) ?? 0, 'a replaced tab must not keep polling').toBe(stopped);

    await panel.getByRole('button', { name: 'Use this tab' }).click();
    await expect(bridgeStatus(first)).toHaveAttribute('data-bridge-status', 'connected');
    await expect(bridgeStatus(second)).toHaveAttribute('data-bridge-status', 'disconnected');
  } finally {
    await elsewhere.close();
    await bridge.close();
  }
});

/** A port that was free a moment ago: nothing listens there. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const connectPanel = (page: Page) => page.getByRole('complementary', { name: 'Connect agent' });
// CANVAS_SHOTS_DIR=<dir> keeps a light and a dark screenshot of every panel state, for review.
const shot = async (page: Page, name: string, theme: string) => {
  if (process.env.CANVAS_SHOTS_DIR) await connectPanel(page).screenshot({ animations: 'disabled', path: `${process.env.CANVAS_SHOTS_DIR}/${name}-${theme}.png` });
};

// The link an agent hands out when no editor is paired: the tab it opens takes the bridge, even from an older tab (review 2 #2).
test('a tab opened from #/connect takes the bridge from an older tab', async ({ context }) => {
  test.setTimeout(90_000);
  const bridge = await fakeBridge({ tabAware: true });
  try {
    const first = await context.newPage();
    await openTab(first, bridge.port);
    await expect(bridgeStatus(first)).toHaveAttribute('data-bridge-status', 'connected');
    const second = await context.newPage();
    await openTab(second, bridge.port, { path: '/#/connect' });
    await expect(connectPanel(second)).toHaveAttribute('data-status', 'connected', { timeout: 15_000 });
    await first.bringToFront();
    await bridgeStatus(first).click();
    await expect(connectPanel(first)).toHaveAttribute('data-status', 'elsewhere');
    await expect(connectPanel(first).getByText('Connect is on in another tab.')).toBeVisible();
  } finally {
    await bridge.close();
  }
});

// Waiting holds nothing: a second tab waits too instead of saying another tab has a connection that does not exist.
test('two tabs waiting for the agent both say waiting', async ({ context }) => {
  const port = await closedPort();
  const first = await context.newPage();
  await openTab(first, port);
  await bridgeStatus(first).click();
  await expect(connectPanel(first)).toHaveAttribute('data-status', 'waiting', { timeout: 15_000 });
  const second = await context.newPage();
  await openTab(second, port, { path: '/#/connect' });
  await expect(connectPanel(second)).toHaveAttribute('data-status', 'waiting', { timeout: 15_000 });
  await second.waitForTimeout(2000);
  await expect(connectPanel(second)).toHaveAttribute('data-status', 'waiting');
  await expect(connectPanel(first)).toHaveAttribute('data-status', 'waiting');
});

// #/connect is the link the MCP server hands an agent when no editor is paired: it opens the panel with Connect on.
test('#/connect opens Connect agent and waits for the agent, neutral, without a token in the link', async ({ page }) => {
  const port = await closedPort();
  await openTab(page, port, { enabled: false, path: '/#/connect' });
  await expect(connectPanel(page)).toHaveAttribute('data-status', 'waiting', { timeout: 15_000 });
  await expect(page).not.toHaveURL(/connect/);
  await expect(connectPanel(page).getByRole('alert')).toHaveCount(0);
});

for (const theme of ['light', 'dark']) {
  test(`every Connect agent state reads right (${theme})`, async ({ page, context }) => {
    test.setTimeout(120_000);
    const port = await closedPort();
    await openTab(page, port, { theme, enabled: false });
    await page.getByRole('toolbar', { name: 'Workspace', exact: true }).getByRole('button', { name: 'Connect agent', exact: true }).click();
    const panel = connectPanel(page);
    await expect(panel).toHaveAttribute('data-status', 'off');
    await shot(page, '01-off-claude-code', theme);
    for (const [option, name] of [['Claude Desktop', '02-off-claude-desktop'], ['Cursor', '03-off-cursor'], ['VS Code', '04-off-vscode'],
      ['Codex', '05-off-codex'], ['claude.ai or ChatGPT', '06-off-chat-apps']] as const) {
      await panel.getByRole('button', { name: /^Your agent/ }).click();
      await page.getByRole('option', { name: new RegExp(`^${option.replace('.', '\\.')}`) }).click();
      await shot(page, name, theme);
    }
    await expect(panel.getByText(/not on this canvas/)).toBeVisible();
    await panel.getByRole('button', { name: /^Your agent/ }).click();
    await page.getByRole('option', { name: /^Claude Code/ }).click();
    await panel.getByRole('radio', { name: 'Terminal', exact: true }).click();

    // Copy turns Connect on: nothing listens yet, so it waits, neutral.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await panel.getByRole('button', { name: 'Copy command' }).click();
    await expect(panel).toHaveAttribute('data-status', 'waiting');
    await expect(panel.getByRole('alert')).toHaveCount(0);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^claude mcp add -s user canvas -e CANVAS_BRIDGE_PORT=\d+ -e CANVAS_BRIDGE_TOKEN=\w+ -- npx -y @hyperlab\.sh\/canvas mcp$/);
    await shot(page, '07-waiting', theme);
    await panel.getByRole('button', { name: 'Stop waiting' }).click();

    // A server that refuses this window's token: red, with its fix.
    const strict = await fakeBridge({ tabAware: true, token: 'not-this-one' });
    try {
      await panel.locator('summary', { hasText: 'Connection settings' }).click();
      await page.locator('#canvas-bridge-port').fill(String(strict.port));
      await page.locator('#canvas-bridge-port').blur();
      await panel.getByRole('button', { name: 'Connect', exact: true }).click();
      await expect(panel.getByRole('alert')).toContainText('did not accept this token');
      await shot(page, '08-token-rejected', theme);
      await panel.getByRole('button', { name: 'Stop retrying' }).click();
      await expect(panel).toHaveAttribute('data-status', 'off');
    } finally {
      await strict.close();
    }

    // Connected; an agent edit says who made it, and Undo clears the line instead of leaving a stale label (audit F6).
    const bridge = await fakeBridge({ tabAware: true });
    try {
      // Leaving the error state closes the settings it opened.
      if (!await panel.locator('details.canvas-connection-details[open]').count()) await panel.locator('summary', { hasText: 'Connection settings' }).click();
      await page.locator('#canvas-bridge-port').fill(String(bridge.port));
      await page.locator('#canvas-bridge-port').blur();
      await panel.getByRole('button', { name: 'Connect', exact: true }).click();
      await expect(panel).toHaveAttribute('data-status', 'connected');
      await page.waitForTimeout(300);
      bridge.send({ id: 'r1', op: 'add_shape', input: { kind: 'rectangle', id: 'from-agent' }, client: 'claude-code' });
      const line = panel.getByRole('status').filter({ hasText: 'Claude Code added a rectangle' });
      await expect(line).toBeVisible({ timeout: 15_000 });
      await expect(panel.getByText('Claude Code', { exact: true })).toBeVisible();
      await shot(page, '09-connected-activity', theme);
      await line.getByRole('button', { name: 'Undo' }).click();
      await expect(line).toHaveCount(0);
      await shot(page, '10-connected-after-undo', theme);

      // A second tab: it waits for this one, says so, and can take the bridge.
      const other = await context.newPage();
      await openTab(other, bridge.port, { theme });
      await other.getByRole('toolbar', { name: 'Workspace', exact: true }).getByRole('button', { name: 'Connect agent', exact: true }).click();
      await expect(connectPanel(other)).toHaveAttribute('data-status', 'elsewhere');
      await shot(other, '11-elsewhere', theme);
      await other.close();
    } finally {
      await bridge.close();
    }
  });
}
