import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './test';

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

test('a service diagram opens from its link with its shapes on the canvas', async ({ page }) => {
  await page.goto(`${url}/#/p/demo/${diagramId}`);
  await expect(page.locator('[data-testid="v2-canvas"]')).toBeVisible();
  const drawn = () => page.evaluate(() => {
    const api = (window as unknown as { __V2__?: { getDocument(): { pages: { nodes: { content?: { label?: string } }[]; connectors: unknown[] }[] } | null } }).__V2__;
    const first = api?.getDocument()?.pages[0];
    return first ? { labels: first.nodes.map((n) => n.content?.label).filter(Boolean).sort(), connectors: first.connectors.length } : null;
  });
  await expect.poll(drawn).toEqual({ labels: ['Finish', 'Start'], connectors: 1 });
});

test('the tab bridge is off on a service diagram and on for a local one', async ({ page }) => {
  const deadPort = 43999;
  const touched: string[] = [];
  page.on('request', (request) => { if (request.url().includes(`:${deadPort}`)) touched.push(request.url()); });
  await page.addInitScript((port) => {
    localStorage.setItem('openflowkit-v2-preferences', JSON.stringify({ agentBridgeEnabled: true, bridgePort: port, bridgeToken: '' }));
  }, deadPort);
  await page.goto(`${url}/#/p/demo/${diagramId}`);
  await expect(page.locator('[data-testid="v2-canvas"]')).toBeVisible();
  expect(touched).toEqual([]);

  // The same preferences on a local document do reach for the bridge: the check above can fail.
  await page.goto('/');
  await expect(page.locator('[data-testid="v2-canvas"]')).toBeVisible();
  await expect.poll(() => touched.length).toBeGreaterThan(0);
});
