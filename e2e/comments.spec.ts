import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from './test';

// Discussions: Figma-style comments pinned on the canvas. They are document data (saved, reloaded, carried with the node)
// but never undo history. CANVAS_SHOTS_DIR=<dir> also writes screenshots.

const SHOTS = process.env.CANVAS_SHOTS_DIR;
type V2Api = {
  getState(): { nodes: string[]; revision: number; saveStatus?: string };
  getNodeRect(id: string): { x: number; y: number; width: number; height: number } | null;
  getDocument(): { pages: { threads?: { resolved: boolean; anchor: { nodeId: string | null }; comments: { body: string; author: { kind: string; name: string } }[] }[] }[] };
};
const api = <T,>(page: Page, run: (v2: V2Api) => T) => page.evaluate(`(${run.toString()})(window.__V2__)`) as Promise<T>;
const threads = (page: Page) => api(page, (v2) => v2.getDocument().pages[0]!.threads ?? []);
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

async function start(page: Page, preferences: Record<string, unknown> = {}): Promise<{ id: string; centre: { x: number; y: number } }> {
  await page.addInitScript((value) => localStorage.setItem('canvas-v2-preferences', JSON.stringify({ theme: 'dark', ...value })), preferences);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.waitForFunction(() => window.__V2__?.getState());
  // The opening cover lies over the canvas until the renderer has drawn.
  await expect(page.locator('[data-cover]')).toHaveCount(0, { timeout: 15_000 });
  await page.getByTestId('v2-canvas').focus();
  // The first press right after load can land before the renderer takes input: arm and click again until a shape is there.
  await expect(async () => {
    await page.keyboard.press('r');
    await page.mouse.click(520, 360);
    expect((await api(page, (v2) => v2.getState())).nodes.length).toBe(1);
  }).toPass({ timeout: 15_000, intervals: [1000] });
  await page.keyboard.press('Escape');
  const id = (await api(page, (v2) => v2.getState())).nodes[0]!;
  const rect = (await page.evaluate((nodeId) => window.__V2__!.getNodeRect(nodeId), id))!;
  return { id, centre: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } };
}

async function comment(page: Page, at: { x: number; y: number }, text: string): Promise<void> {
  await page.keyboard.press('c');
  await page.mouse.click(at.x, at.y);
  const box = page.getByTestId('v2-comment-composer').getByRole('textbox', { name: 'Comment' });
  await expect(box).toBeFocused();
  await box.fill(text);
  await box.press('Enter');
}

test('press C, click a node, type, Enter: a pin appears, survives a reload, and follows the node', { tag: '@gate' }, async ({ page }) => {
  const { id, centre } = await start(page);
  await comment(page, centre, 'Why is this a queue?');
  const pin = page.getByTestId('v2-comment-pin');
  await expect(pin).toHaveCount(1);
  expect(await threads(page)).toMatchObject([{ anchor: { nodeId: id }, resolved: false, comments: [{ body: 'Why is this a queue?', author: { kind: 'human', name: 'User' } }] }]);
  await expect(pin.getByRole('button', { name: 'Comment by User' })).toBeVisible();
  await expect(pin.locator('.canvas-comment-avatar svg')).toHaveCount(1);
  // The tip of the pin is where it was clicked.
  const before = (await pin.boundingBox())!;
  expect(Math.abs(before.x - centre.x)).toBeLessThan(2);
  expect(Math.abs(before.y + before.height - centre.y)).toBeLessThan(2);
  await shot(page, 'comment-pin');

  // The shape moves, the pin goes with it.
  await page.keyboard.press('v');
  await page.mouse.move(centre.x - 30, centre.y + 10);
  await page.mouse.down();
  await page.mouse.move(centre.x + 70, centre.y + 90, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => ((await pin.boundingBox())!.x - before.x)).toBeGreaterThan(80);
  const moved = (await pin.boundingBox())!;
  expect(Math.round(moved.y - before.y)).toBeGreaterThan(70);

  // Saved with the document.
  await expect.poll(async () => (await api(page, (v2) => v2.getState())).saveStatus ?? 'saved').toMatch(/saved|idle/);
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForFunction(() => window.__V2__?.getState());
  await expect(page.getByTestId('v2-comment-pin')).toHaveCount(1);
});

test('the pin opens its thread: reply, edit, resolve hides the pin and keeps the thread in the document', async ({ page }) => {
  const { centre } = await start(page);
  await comment(page, centre, 'First');
  await page.getByTestId('v2-comment-pin').getByRole('button').click();
  const thread = page.getByTestId('v2-comment-thread');
  await expect(thread.getByRole('heading', { name: 'Comment' })).toBeVisible();
  await expect(thread.getByTestId('v2-comment-message')).toHaveCount(1);
  await expect(thread).toContainText('Just now');

  const reply = thread.getByRole('textbox', { name: 'Reply' });
  await reply.fill('Second line one');
  await reply.press('Shift+Enter');
  await reply.type('line two');
  await reply.press('Enter');
  await expect(thread.getByTestId('v2-comment-message')).toHaveCount(2);
  await expect(thread.getByTestId('v2-comment-message').nth(1)).toContainText('line two');
  await shot(page, 'comment-thread');

  // Edit the reply from its menu.
  await thread.getByTestId('v2-comment-message').nth(1).getByRole('button', { name: 'Comment actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const edit = thread.getByRole('textbox', { name: 'Edit comment' });
  await edit.fill('Edited');
  await edit.press('Enter');
  await expect(thread.getByTestId('v2-comment-message').nth(1)).toContainText('Edited');
  await expect(thread.getByTestId('v2-comment-message').nth(1)).toContainText('edited');

  await thread.getByRole('button', { name: 'Resolve thread' }).click();
  await expect(page.getByTestId('v2-comment-pin')).toHaveCount(0);
  expect(await threads(page)).toMatchObject([{ resolved: true, comments: [{ body: 'First' }, { body: 'Edited' }] }]);
});

test('deleting a thread asks first, in the app and not in the browser', async ({ page }) => {
  const { centre } = await start(page);
  page.on('dialog', () => { throw new Error('a browser dialog opened'); });
  await comment(page, centre, 'Gone soon');
  await page.getByTestId('v2-comment-pin').getByRole('button').click();
  const thread = page.getByTestId('v2-comment-thread');
  await thread.getByRole('button', { name: 'Thread actions' }).click();
  await page.getByRole('menuitem', { name: /Delete thread/ }).click();
  await thread.getByRole('button', { name: 'Cancel' }).click();
  expect(await threads(page)).toHaveLength(1);
  await thread.getByRole('button', { name: 'Thread actions' }).click();
  await page.getByRole('menuitem', { name: /Delete thread/ }).click();
  await thread.getByRole('button', { name: 'Delete thread' }).click();
  await expect(page.getByTestId('v2-comment-pin')).toHaveCount(0);
  expect(await threads(page)).toHaveLength(0);
});

test('undo never removes a comment, and a comment adds no undo step', async ({ page }) => {
  const { centre } = await start(page);
  await comment(page, centre, 'Stays');
  await expect(page.getByTestId('v2-comment-pin')).toHaveCount(1);
  await page.getByTestId('v2-canvas').focus();
  await page.keyboard.press('ControlMeta+z'.replace('ControlMeta', process.platform === 'darwin' ? 'Meta' : 'Control'));
  // The undo took the rectangle, not the comment.
  await expect.poll(async () => (await api(page, (v2) => v2.getState())).nodes.length).toBe(0);
  await expect(page.getByTestId('v2-comment-pin')).toHaveCount(1);
  expect(await threads(page)).toHaveLength(1);
});

test('Esc and clicking away cancel the composer; an empty comment cannot be sent', async ({ page }) => {
  const { centre } = await start(page);
  await page.keyboard.press('c');
  await page.mouse.click(centre.x, centre.y);
  const composer = page.getByRole('dialog', { name: 'New comment' });
  const box = composer.getByRole('textbox', { name: 'Comment' });
  await expect(box).toBeFocused();
  await expect(composer.getByRole('button', { name: 'Send comment' })).toBeDisabled();
  await box.fill('   ');
  await box.press('Enter');
  await expect(composer).toBeVisible();
  expect(await threads(page)).toHaveLength(0);
  await box.press('Escape');
  await expect(composer).toHaveCount(0);

  await page.getByTestId('v2-canvas').focus();
  await page.mouse.click(centre.x, centre.y);
  await expect(composer).toBeVisible();
  await page.mouse.click(centre.x + 300, centre.y + 200);
  await expect(composer).toHaveCount(0);
  expect(await threads(page)).toHaveLength(0);
});

test('the comment tool stays active after posting; a second click starts a second thread; Esc leaves it', async ({ page }) => {
  const { centre } = await start(page);
  await comment(page, centre, 'First');
  await expect(page.getByTestId('v2-comment-pin')).toHaveCount(1);
  // No second press of C: the tool is still the comment tool.
  await page.mouse.click(centre.x + 200, centre.y + 150);
  const box = page.getByTestId('v2-comment-composer').getByRole('textbox', { name: 'Comment' });
  await expect(box).toBeFocused();
  await box.fill('Second');
  await box.press('Enter');
  await expect(page.getByTestId('v2-comment-pin')).toHaveCount(2);
  expect(await threads(page)).toMatchObject([{ comments: [{ body: 'First' }] }, { comments: [{ body: 'Second' }] }]);
  // Clicking an existing pin opens its thread, not a new composer.
  await page.getByTestId('v2-comment-pin').first().getByRole('button').click();
  await expect(page.getByTestId('v2-comment-thread')).toBeVisible();
  await expect(page.getByTestId('v2-comment-composer')).toHaveCount(0);
  // Esc leaves the tool: a click on the canvas no longer starts a thread.
  await page.getByTestId('v2-canvas').focus();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.mouse.click(centre.x + 200, centre.y - 150);
  await expect(page.getByTestId('v2-comment-composer')).toHaveCount(0);
  expect(await threads(page)).toHaveLength(2);
});

test('live comments are off without an agent, and say why', async ({ page }) => {
  const { centre } = await start(page);
  await page.keyboard.press('c');
  await page.mouse.click(centre.x, centre.y);
  // The switch lives in the Threads panel, which the comment tool opened; the composer has none.
  const toggle = page.getByTestId('v2-threads-panel').getByRole('switch', { name: 'Live comments' });
  await expect(toggle).toBeDisabled();
  await expect(page.getByTestId('v2-comment-composer').getByRole('switch')).toHaveCount(0);
  await page.getByTestId('v2-comment-composer').getByRole('textbox', { name: 'Comment' }).fill('Needs a second look');
  await shot(page, 'comment-composer');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Connect agent' }).click();
  // Only the Threads panel carries the switch; the agent panel stays compact.
  await expect(page.getByRole('complementary', { name: 'Connect agent' }).getByRole('switch')).toHaveCount(0);
  await shot(page, 'comment-agent-panel');
  await page.getByRole('button', { name: 'Close agent connection' }).click();
  await page.getByRole('button', { name: /^Threads/ }).click();
  await expect(page.getByTestId('v2-threads-panel').locator('.canvas-comment-live')).toHaveAttribute('title', /Connect an agent/);
});

// A fake MCP server's bridge: long-poll /next, results on /result, and the comment events of live mode on /event.
// `channel` is what its hello says: whether the session hears the events (false for a session started without one).
async function bridge(channel = true) {
  const events: Record<string, unknown>[] = [];
  const results: { id: string; ok: boolean }[] = [];
  const queue: unknown[] = [];
  let parked: ServerResponse | null = null;
  const reply = (response: ServerResponse, status: number, body?: unknown) => {
    response.writeHead(status, {
      'access-control-allow-origin': response.req.headers.origin ?? '*', 'access-control-allow-private-network': 'true', 'access-control-allow-headers': '*',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    });
    response.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method === 'OPTIONS') { reply(response, 204); return; }
    if (path === '/next') {
      if (parked) { reply(parked, 204); parked = null; }
      if (queue.length) { reply(response, 200, queue.shift()); return; }
      parked = response;
      response.on('close', () => { if (parked === response) parked = null; });
      return;
    }
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      if (path === '/event') events.push(JSON.parse(body));
      if (path === '/result') results.push(JSON.parse(body));
      reply(response, 200, { ok: true, protocol: 1, channel });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port, events, results,
    send: (request: unknown) => { if (parked) { const response = parked; parked = null; reply(response, 200, request); } else queue.push(request); },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

test('an agent whose session cannot hear comments keeps live comments and Send off, and says why', async ({ page }) => {
  const fake = await bridge(false);
  try {
    const { centre } = await start(page, { liveComments: true, agentBridgeEnabled: true, bridgePort: fake.port, bridgeToken: '' });
    await expect(page.locator('[data-bridge-status="connected"]').first()).toBeVisible({ timeout: 30_000 });
    await comment(page, centre, 'Anyone listening?');
    const panel = page.getByTestId('v2-threads-panel');
    await expect(panel.getByRole('switch', { name: 'Live comments' })).toBeDisabled();
    await expect(panel.locator('.canvas-comment-live')).toHaveAttribute('title', /cannot receive comments/);
    const send = page.getByTestId('v2-threads-send');
    await expect(send).toHaveText('Send 1 comment to agent');
    await expect(send).toBeDisabled();
    await expect(send).toHaveAttribute('title', /cannot receive comments/);
    expect(fake.events).toHaveLength(0);
  } finally {
    await fake.close();
  }
});

test('on /d/ there is no holder badge, and Send to agent still reaches the bridge', async ({ page }) => {
  const fake = await bridge();
  try {
    const { centre } = await start(page, { agentBridgeEnabled: true, bridgePort: fake.port, bridgeToken: '' });
    await expect(page.locator('[data-bridge-status="connected"]').first()).toBeVisible({ timeout: 30_000 });
    await comment(page, centre, 'Over the bridge');
    const send = page.getByTestId('v2-threads-send');
    await expect(send).toHaveText('Send 1 comment to agent');
    await send.click();
    await expect.poll(() => fake.events.length).toBe(1);
    expect(fake.events[0]).toMatchObject({ kind: 'new_thread', body: 'Over the bridge' });
    await expect(page.getByTestId('v2-holder')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

test('live comments: each new human message is posted to the agent, and the agent answers in the thread', async ({ page }) => {
  const fake = await bridge();
  try {
    const { id, centre } = await start(page, { liveComments: true, agentBridgeEnabled: true, bridgePort: fake.port, bridgeToken: '' });
    await expect(page.locator('[data-bridge-status="connected"]').first()).toBeVisible({ timeout: 30_000 });
    await comment(page, centre, 'Is this right?');
    await expect.poll(() => fake.events.length).toBe(1);
    expect(fake.events[0]).toMatchObject({ type: 'thread', kind: 'new_thread', nodeId: id, author: 'User', body: 'Is this right?' });
    const threadId = fake.events[0]!.threadId as string;

    await page.getByTestId('v2-comment-pin').getByRole('button').click();
    const thread = page.getByTestId('v2-comment-thread');
    await expect(thread.getByRole('switch')).toHaveCount(0);
    // Pressing C opened the Threads panel already; the rail button would close it.
    await expect(page.getByTestId('v2-threads-panel').getByRole('switch', { name: 'Live comments' })).toBeChecked();
    await thread.getByRole('textbox', { name: 'Reply' }).fill('And this?');
    await thread.getByRole('textbox', { name: 'Reply' }).press('Enter');
    await expect.poll(() => fake.events.length).toBe(2);
    expect(fake.events[1]).toMatchObject({ kind: 'reply', threadId, body: 'And this?' });

    // The agent replies (no undo step, no drawing cursor) and its message shows under its own name.
    fake.send({ id: 'r1', op: 'reply_to_thread', input: { threadId, body: 'Looks right to me.' }, client: 'claude-code' });
    await expect(thread.getByTestId('v2-comment-message')).toHaveCount(3);
    await expect(thread.getByTestId('v2-comment-message').nth(2)).toContainText('Claude Code');
    await expect(thread.getByTestId('v2-comment-message').nth(2)).toContainText('Looks right to me.');
    // Agent messages are never pushed back, and have no edit menu.
    expect(fake.events).toHaveLength(2);
    await expect(thread.getByTestId('v2-comment-message').nth(2).getByRole('button', { name: 'Comment actions' })).toHaveCount(0);
    await shot(page, 'comment-agent-reply');

    // The agent starts a thread of its own on the node.
    fake.send({ id: 'r2', op: 'start_thread', input: { nodeId: id, body: 'Also check the queue.' }, client: 'claude-code' });
    // The thread is open over the first pin: the agent's is the second.
    await expect(page.getByTestId('v2-comment-pin')).toHaveCount(2);
    await expect(page.locator('.canvas-comment-pin[data-kind="agent"]')).toHaveCount(1);
    await expect.poll(() => fake.results.map((result) => result.ok)).toEqual([true, true]);
  } finally {
    await fake.close();
  }
});
