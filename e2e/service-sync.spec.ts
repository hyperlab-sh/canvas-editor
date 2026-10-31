import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from './test';
import { doc, drawShape, state } from './helpers';

// Tabs on one service diagram follow each other and the agent, and a stale save recovers.
// npm run e2e:headed -- e2e/service-sync.spec.ts

let scratch: string;
let service: ChildProcess;
let url: string;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  scratch = mkdtempSync(join(tmpdir(), 'canvas-service-sync-'));
  mkdirSync(join(scratch, 'demo'));
  const app = join(scratch, 'app');
  execFileSync('npx', ['vite', 'build', '--outDir', app, '--emptyOutDir'], { stdio: 'pipe' });
  const config = join(scratch, 'service.json');
  writeFileSync(config, JSON.stringify({ port: 43121, projects: [{ name: 'demo', path: join(scratch, 'demo') }] }));
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

async function newDiagram(name: string): Promise<{ id: string; file: string }> {
  const { json } = await api<{ id: string }>('POST', '/projects/demo/diagrams', { name });
  const files = readdirSync(join(scratch, 'demo'));
  const file = files.find((f) => readFileSync(join(scratch, 'demo', f), 'utf8').includes(`"id": "${json.id}"`));
  return { id: json.id, file: join(scratch, 'demo', file!) };
}

const onDisk = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as { pages: { nodes: { content?: { label?: string } }[] }[] };
const diskLabels = (file: string) => onDisk(file).pages.flatMap((p) => p.nodes.map((n) => n.content?.label)).filter(Boolean).sort();
const labels = async (page: Page) => ((await doc(page))?.pages ?? []).flatMap((p) => p.nodes.map((n) => (n as { content?: { label?: string } }).content?.label)).filter(Boolean).sort();

async function openTab(page: Page, id: string): Promise<void> {
  await page.goto(`${url}/#/p/demo/${id}`);
  await page.waitForSelector('[data-testid="v2-canvas"]');
  await expect.poll(async () => (await doc(page)) !== null).toBe(true);
  await page.getByTestId('v2-canvas').focus();
}

test('an agent op shows in both tabs within 2 s, and one undo removes it and saves', async ({ page, browser }) => {
  const { id, file } = await newDiagram('sync-agent');
  const other = await browser.newContext();
  const errors: string[] = [];
  other.on('weberror', (webError) => errors.push(webError.error().message));
  const second = await other.newPage();
  await openTab(page, id);
  await openTab(second, id);

  const session = (await api<{ sessionId: string }>('POST', '/sessions', { client: 'e2e', cwd: scratch, pid: process.pid })).json.sessionId;
  expect((await api('POST', `/sessions/${session}/bindings`, { project: 'demo', id })).status).toBe(200);
  const drawn = await api<{ ok: boolean }>('POST', `/sessions/${session}/ops`, { project: 'demo', id, op: 'create_diagram', input: { dsl: 'flowchart\n  Ping -> Pong\n' } });
  expect(drawn.json.ok).toBe(true);

  await expect.poll(() => labels(page), { timeout: 2000 }).toEqual(['Ping', 'Pong']);
  await expect.poll(() => labels(second), { timeout: 2000 }).toEqual(['Ping', 'Pong']);

  await page.getByTestId('v2-canvas').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => labels(page)).toEqual([]);
  // The save after the undo reaches the service, and the other tab follows it.
  await expect.poll(() => diskLabels(file), { timeout: 3000 }).toEqual([]);
  await expect.poll(() => labels(second), { timeout: 2000 }).toEqual([]);
  expect(errors).toEqual([]);
  await other.close();
});

test('a hand edit reaches the file and the other tab; a stale save takes the service copy, says so, and saving goes on', async ({ page, browser }) => {
  const { id, file } = await newDiagram('sync-hand');
  const other = await browser.newContext();
  const second = await other.newPage();
  await openTab(page, id);
  await openTab(second, id);

  await drawShape(page, 'r', 300, 300);
  await expect.poll(() => onDisk(file).pages.flatMap((p) => p.nodes).length, { timeout: 2000 }).toBe(1);
  await expect.poll(async () => (await state(second)).nodes.length, { timeout: 2000 }).toBe(1);

  // Another writer saves directly and the tab is not told (no event stream): the next save is stale.
  await page.route('**/events?**', (route) => route.abort());
  await page.reload();
  await page.waitForSelector('[data-testid="v2-canvas"]');
  await expect.poll(async () => (await state(page)).nodes.length).toBe(1);
  const current = await api<{ document: Record<string, unknown>; revision: number }>('GET', `/projects/demo/diagrams/${id}`);
  const newer = { ...current.json.document, name: 'Renamed by another writer' };
  expect((await api('PUT', `/projects/demo/diagrams/${id}`, { document: newer, revision: current.json.revision })).status).toBe(200);

  await page.getByTestId('v2-canvas').focus();
  await drawShape(page, 'r', 500, 400);
  await expect(page.getByText('Updated from the service')).toBeVisible({ timeout: 5000 });
  // The service's copy replaced the edit that lost the race.
  await expect.poll(async () => (await state(page)).nodes.length).toBe(1);
  expect((onDisk(file) as unknown as { name: string }).name).toBe('Renamed by another writer');

  // The replace is one undo step: undo brings the edit that lost the race back.
  await page.getByTestId('v2-canvas').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await state(page)).nodes.length).toBe(2);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await state(page)).nodes.length).toBe(1);

  // The next edit saves.
  await page.getByTestId('v2-canvas').focus();
  await drawShape(page, 'r', 500, 400);
  await expect.poll(() => onDisk(file).pages.flatMap((p) => p.nodes).length, { timeout: 3000 }).toBe(2);
  await other.close();
});

const threadsOf = (page: Page) => page.evaluate(() => {
  const api = (window as unknown as { __V2__?: { getDocument(): { pages: { threads?: { id: string }[] }[] } | null } }).__V2__;
  return (api?.getDocument()?.pages ?? []).flatMap((p) => (p.threads ?? []).map((t) => t.id));
});

test('a comment made elsewhere shows here without an undo step, and a save here keeps it', async ({ page }) => {
  const { id, file } = await newDiagram('sync-comment');
  await openTab(page, id);
  await drawShape(page, 'r', 300, 300);
  await expect.poll(() => onDisk(file).pages.flatMap((p) => p.nodes).length, { timeout: 3000 }).toBe(1);

  const current = await api<{ document: { pages: Record<string, unknown>[] }; revision: number }>('GET', `/projects/demo/diagrams/${id}`);
  const [first, ...rest] = current.json.document.pages;
  const thread = { id: 'remote-thread', number: 1, anchor: { nodeId: null, offset: null, point: { x: 5, y: 5 } }, resolved: false,
    comments: [{ id: 'remote-comment', author: { kind: 'human', name: 'Ann' }, body: 'from another tab', createdAt: '2026-01-01T00:00:00.000Z' }] };
  const commented = { ...current.json.document, pages: [{ ...first, threads: [thread] }, ...rest] };
  expect((await api('PUT', `/projects/demo/diagrams/${id}`, { document: commented, revision: current.json.revision })).status).toBe(200);
  await expect.poll(() => threadsOf(page), { timeout: 2000 }).toEqual(['remote-thread']);

  // The first undo takes the shape away: the comment did not add a step of its own.
  await page.getByTestId('v2-canvas').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await state(page)).nodes.length).toBe(0);
  await expect.poll(() => threadsOf(page)).toEqual(['remote-thread']);
  // The save that follows keeps the comment in the file.
  await expect.poll(() => onDisk(file).pages.flatMap((p) => p.nodes).length, { timeout: 3000 }).toBe(0);
  expect(JSON.stringify(onDisk(file))).toContain('remote-thread');
});

test('an agent op that lands while this tab has an unsaved edit is not dropped silently', async ({ page }) => {
  const { id, file } = await newDiagram('sync-unsaved');
  await openTab(page, id);
  const session = (await api<{ sessionId: string }>('POST', '/sessions', { client: 'e2e', cwd: scratch, pid: process.pid })).json.sessionId;
  expect((await api('POST', `/sessions/${session}/bindings`, { project: 'demo', id })).status).toBe(200);

  await drawShape(page, 'r', 300, 300);
  // Still inside the autosave delay: the edit is not saved yet.
  expect(onDisk(file).pages.flatMap((p) => p.nodes)).toHaveLength(0);
  const drawn = await api<{ ok: boolean }>('POST', `/sessions/${session}/ops`, { project: 'demo', id, op: 'create_diagram', input: { dsl: 'flowchart\n  Left -> Right\n' } });
  expect(drawn.json.ok).toBe(true);

  // The edit's save meets the newer revision: the tab says so and shows the service's copy.
  await expect(page.getByText('Updated from the service')).toBeVisible({ timeout: 5000 });
  await expect.poll(() => labels(page)).toEqual(['Left', 'Right']);
});

test('a document in this browser opens no event stream', async ({ page }) => {
  const streams: string[] = [];
  page.on('request', (request) => { if (request.url().includes('/events')) streams.push(request.url()); });
  await page.goto(`${url}/#/`);
  await page.waitForSelector('[data-testid="v2-canvas"]');
  await expect.poll(async () => (await doc(page)) !== null).toBe(true);
  expect(streams).toEqual([]);
});

test('a tab that lost its event stream catches up when the stream comes back', async ({ page }) => {
  const { id } = await newDiagram('sync-reconnect');
  const blocked = (route: { abort(): Promise<void> }) => route.abort();
  await page.route('**/events?**', blocked);
  await openTab(page, id);
  const session = (await api<{ sessionId: string }>('POST', '/sessions', { client: 'e2e', cwd: scratch, pid: process.pid })).json.sessionId;
  expect((await api('POST', `/sessions/${session}/bindings`, { project: 'demo', id })).status).toBe(200);
  const drawn = await api<{ ok: boolean }>('POST', `/sessions/${session}/ops`, { project: 'demo', id, op: 'create_diagram', input: { dsl: 'flowchart\n  Back -> Again\n' } });
  expect(drawn.json.ok).toBe(true);
  // The change was sent while the tab had no stream: nothing shows until the browser reconnects.
  expect(await labels(page)).toEqual([]);
  await page.unroute('**/events?**', blocked);
  await expect.poll(() => labels(page), { timeout: 15_000 }).toEqual(['Again', 'Back']);
});

test('an edit whose save failed is kept when an agent op arrives', async ({ page }) => {
  const { id, file } = await newDiagram('sync-failed-save');
  await openTab(page, id);
  const session = (await api<{ sessionId: string }>('POST', '/sessions', { client: 'e2e', cwd: scratch, pid: process.pid })).json.sessionId;
  expect((await api('POST', `/sessions/${session}/bindings`, { project: 'demo', id })).status).toBe(200);

  await page.route(`**/projects/demo/diagrams/${id}`, (route) => route.request().method() === 'PUT' ? route.abort() : route.continue());
  const failed = page.waitForEvent('requestfailed');
  await drawShape(page, 'r', 300, 300);
  await failed;

  const read = page.waitForResponse((response) => response.request().method() === 'GET' && response.url().endsWith(`/diagrams/${id}`));
  const drawn = await api<{ ok: boolean }>('POST', `/sessions/${session}/ops`, { project: 'demo', id, op: 'create_diagram', input: { dsl: 'flowchart\n  Up -> Down\n' } });
  expect(drawn.json.ok).toBe(true);
  await (await read).finished();
  // The tab read the service's copy and left the unsaved shape alone.
  await expect.poll(async () => (await state(page)).nodes.length).toBe(1);
  expect(await labels(page)).toEqual([]);
  expect(diskLabels(file)).toEqual(['Down', 'Up']);
});
