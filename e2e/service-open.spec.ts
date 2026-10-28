import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from './test';

// The link the service hands out opens its diagram: the app is served by the service, and the
// editor reads the diagram from the service rather than from this browser's storage.
// npm run e2e:headed -- e2e/service-open.spec.ts

let scratch: string;
let service: ChildProcess;
let url: string;
let diagramId: string;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  scratch = mkdtempSync(join(tmpdir(), 'ofk-service-open-'));
  const project = join(scratch, 'demo');
  mkdirSync(project);
  writeFileSync(join(scratch, 'flow.mmd'), 'flowchart LR\n  A[Start] --> B[Finish]\n');
  const cli = ['tsx', 'mcp-server/src/cli.ts'];
  execFileSync('npx', [...cli, 'convert', join(scratch, 'flow.mmd'), '-o', join(project, 'flow.openflow.json')], { stdio: 'pipe' });
  diagramId = (JSON.parse(readFileSync(join(project, 'flow.openflow.json'), 'utf8')) as { id: string }).id;
  const app = join(scratch, 'app');
  execFileSync('npx', ['vite', 'build', '--outDir', app, '--emptyOutDir'], { stdio: 'pipe' });
  const config = join(scratch, 'service.json');
  // The config requires a port; --port 0 below overrides it.
  writeFileSync(config, JSON.stringify({ port: 43120, projects: [{ name: 'demo', path: project }] }));
  service = spawn('npx', [...cli, 'serve', '--port', '0', '--config', config, '--app', app], { stdio: ['ignore', 'pipe', 'inherit'] });
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

const drawn = (page: Page) => page.evaluate(() => {
  const api = (window as unknown as { __V2__?: { getDocument(): { pages: { nodes: { content?: { label?: string } }[]; connectors: unknown[] }[] } | null } }).__V2__;
  const first = api?.getDocument()?.pages[0];
  return first ? { labels: first.nodes.map((n) => n.content?.label).filter(Boolean).sort(), connectors: first.connectors.length } : null;
});

test('a service diagram opens from its link with its shapes on the canvas', async ({ page }) => {
  await page.goto(`${url}/#/p/demo/${diagramId}`);
  await expect(page.locator('[data-testid="v2-canvas"]')).toBeVisible();
  await expect.poll(() => drawn(page)).toEqual({ labels: ['Finish', 'Start'], connectors: 1 });
});

test('the tab bridge is off on a service diagram and on for a local one', async ({ page }) => {
  const deadPort = 43999;
  const touched: string[] = [];
  page.on('request', (request) => { if (request.url().includes(`:${deadPort}`)) touched.push(request.url()); });
  await page.addInitScript((port) => {
    localStorage.setItem('openflowkit-v2-preferences', JSON.stringify({ agentBridgeEnabled: true, bridgePort: port, bridgeToken: '' }));
  }, deadPort);
  const streamOpened = page.waitForRequest((request) => request.url().includes('/events?'));
  await page.goto(`${url}/#/p/demo/${diagramId}`);
  await expect(page.locator('[data-testid="v2-canvas"]')).toBeVisible();
  await expect.poll(() => drawn(page)).not.toBeNull();
  // The page has started everything it starts once the diagram is on screen and its event stream is open
  // (that stream never ends, so the network never goes idle).
  await streamOpened;
  await page.waitForLoadState('load');
  expect(touched).toEqual([]);

  // The same preferences on a local document do reach for the bridge: the check above can fail.
  await page.goto('/');
  await expect(page.locator('[data-testid="v2-canvas"]')).toBeVisible();
  await expect.poll(() => touched.length).toBeGreaterThan(0);
});

test('an unknown service diagram is not found and nothing is written; a service diagram is not the one / reopens', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', (request) => { if (request.method() !== 'GET' && request.url().includes('/projects/')) writes.push(`${request.method()} ${request.url()}`); });
  // Even the document this browser opened last is never made up when the service lacks it.
  await page.addInitScript(() => { if (location.hash.includes('no-such-id')) localStorage.setItem('ofk:last-document', 'no-such-id'); });
  await page.goto(`${url}/#/p/demo/no-such-id`);
  await expect(page.getByText('That diagram isn’t in this browser.')).toBeVisible();
  expect(writes).toEqual([]);
  expect(readdirSync(join(scratch, 'demo'))).toEqual(['flow.openflow.json']);

  await page.goto(`${url}/#/p/demo/${diagramId}`);
  await expect.poll(() => drawn(page)).not.toBeNull();
  await page.goto(`${url}/#/`);
  await expect(page.locator('[data-testid="v2-canvas"]')).toBeVisible();
  expect(page.url()).not.toContain(`/d/${diagramId}`);
});
