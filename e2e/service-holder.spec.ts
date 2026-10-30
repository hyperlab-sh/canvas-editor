import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from './test';
import { drawShape } from './helpers';

// The holder badge on a /p/ diagram, Disconnect, and comments reaching the holding session.
// npm run e2e:headed -- e2e/service-holder.spec.ts

let scratch: string;
let service: ChildProcess;
let url: string;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  scratch = mkdtempSync(join(tmpdir(), 'canvas-service-holder-'));
  mkdirSync(join(scratch, 'demo'));
  const app = join(scratch, 'app');
  execFileSync('npx', ['vite', 'build', '--outDir', app, '--emptyOutDir'], { stdio: 'pipe' });
  const config = join(scratch, 'service.json');
  writeFileSync(config, JSON.stringify({ port: 43122, projects: [{ name: 'demo', path: join(scratch, 'demo') }] }));
  service = spawn('npx', ['tsx', 'mcp-server/src/cli.ts', 'serve', '--port', '0', '--config', config, '--app', app], { stdio: ['ignore', 'pipe', 'inherit'] });
  url = await new Promise<string>((resolve, reject) => {
    service.once('exit', (code) => reject(new Error(`the service exited with ${code} before listening`)));
    service.stdout!.on('data', (chunk: Buffer) => {
      const found = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(chunk.toString());
      if (found) resolve(found[1]!);
    });
  });
});

test.afterAll(() => {
  service?.kill();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const response = await fetch(`${url}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, json: await response.json().catch(() => ({})) as T };
}

async function newDiagram(name: string): Promise<string> {
  return (await api<{ id: string }>('POST', '/projects/demo/diagrams', { name })).json.id;
}

/** A session the way the MCP server registers one (with a channel, so comments reach it), bound to the diagram. */
async function hold(id: string, channel = true): Promise<{ sessionId: string; label: string }> {
  const { sessionId, label } = (await api<{ sessionId: string; label: string }>('POST', '/sessions', { client: 'Claude Code', cwd: scratch, pid: process.pid, channel })).json;
  expect((await api('POST', `/sessions/${sessionId}/bindings`, { project: 'demo', id })).status).toBe(200);
  return { sessionId, label };
}

async function openTab(page: Page, id: string, preferences: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((value) => localStorage.setItem('canvas-v2-preferences', JSON.stringify(value)), preferences);
  await page.goto(`${url}/#/p/demo/${id}`);
  await page.waitForSelector('[data-testid="v2-canvas"]');
  await page.getByTestId('v2-canvas').focus();
}

async function comment(page: Page, at: { x: number; y: number }, text: string): Promise<void> {
  await page.keyboard.press('c');
  await page.mouse.click(at.x, at.y);
  const box = page.getByTestId('v2-comment-composer').getByRole('textbox', { name: 'Comment' });
  await expect(box).toBeFocused();
  await box.fill(text);
  await box.press('Enter');
}

const parked = async (sessionId: string) =>
  (await api<{ events?: { body: string }[] }>('GET', `/sessions/${sessionId}/events?wait=2`)).json.events?.map((event) => event.body) ?? [];

test('the badge shows the holding session; Disconnect clears it and the session is refused', async ({ page }) => {
  const id = await newDiagram('holder-badge');
  await openTab(page, id);
  const badge = page.getByTestId('v2-holder');
  await expect(badge).toHaveCount(0);

  const { sessionId, label } = await hold(id);
  expect(label).toMatch(/^Claude Code/);
  await expect(badge).toContainText(label, { timeout: 2000 });

  // The control keeps the toolbar contract: a tooltip on hover, and it is a button in the bar's toolbar.
  await badge.getByRole('button', { name: 'Disconnect' }).hover();
  await expect(page.getByRole('tooltip')).toContainText('Disconnect this session');
  await expect(page.getByRole('toolbar').getByRole('button', { name: 'Disconnect' })).toBeVisible();
  await badge.getByRole('button', { name: 'Disconnect' }).click();
  await expect(badge).toHaveCount(0, { timeout: 2000 });
  const refused = await api('POST', `/sessions/${sessionId}/ops`, { project: 'demo', id, op: 'create_diagram', input: { dsl: 'flowchart\n  A -> B\n' } });
  expect(refused.status).toBe(409);
});

test('Send to agent reaches the holder; with none it says so and keeps the count', async ({ page }) => {
  const id = await newDiagram('holder-send');
  await openTab(page, id);
  await drawShape(page, 'r', 500, 360);
  const { sessionId } = await hold(id);
  await comment(page, { x: 520, y: 380 }, 'Why a queue?');

  const send = page.getByTestId('v2-threads-send');
  await expect(send).toHaveText('Send 1 comment to agent');
  await send.click();
  await expect(page.getByText('Sent 1 comment to the agent')).toBeVisible();
  expect(await parked(sessionId)).toEqual(['Why a queue?']);
  await expect(send).toHaveText('Send 0 comments to agent');

  await page.getByTestId('v2-holder').getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByTestId('v2-holder')).toHaveCount(0, { timeout: 2000 });
  // With no session holding the diagram there is nobody to send to: the button waits, enabled again with the next holder.
  await comment(page, { x: 540, y: 400 }, 'Anyone there?');
  await expect(send).toHaveText('Send 1 comment to agent');
  await expect(send).toBeDisabled();
  await expect(send).toHaveAttribute('title', /Connect an agent first/);
  const { sessionId: next } = await hold(id);
  await expect(send).toBeEnabled();
  await send.click();
  expect(await parked(next)).toEqual(['Anyone there?']);
});

test('a Live comment goes to the holder; with none, or a holder that cannot hear it, the switch is off and says why', async ({ page }) => {
  const id = await newDiagram('holder-live');
  await openTab(page, id, { liveComments: true });
  await drawShape(page, 'r', 500, 360);
  const live = page.getByTestId('v2-threads-panel').locator('.canvas-comment-live');
  // Nobody holds the diagram: nothing is posted, and the switch says what to do.
  await comment(page, { x: 520, y: 380 }, 'Nobody home');
  await expect(live.getByRole('switch', { name: 'Live comments' })).toBeDisabled();
  await expect(live).toHaveAttribute('title', /Connect an agent first/);
  await expect(page.getByTestId('v2-threads-send')).toHaveText('Send 1 comment to agent');

  // A session that registered without a channel would never see the comment: still off, with the reason.
  await hold(id, false);
  await expect(page.getByTestId('v2-holder')).toBeVisible();
  await expect(live.getByRole('switch', { name: 'Live comments' })).toBeDisabled();
  await expect(live).toHaveAttribute('title', /cannot receive comments/);
  await page.getByTestId('v2-holder').getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByTestId('v2-holder')).toHaveCount(0, { timeout: 2000 });

  const { sessionId } = await hold(id);
  await expect(live.getByRole('switch', { name: 'Live comments' })).toBeChecked();
  await comment(page, { x: 540, y: 400 }, 'Now live');
  expect(await parked(sessionId)).toEqual(['Now live']);
});
