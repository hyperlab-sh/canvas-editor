import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './test';

// Home lists the service's diagrams by project; a card opens under /p/, rename goes through the service,
// and archive, duplicate and delete stay with the diagrams in this browser.
// npm run e2e:headed -- e2e/service-home.spec.ts

let scratch: string;
let service: ChildProcess;
let url: string;
let alphaDir: string;
const ids: Record<string, string> = {};

test.beforeAll(async () => {
  test.setTimeout(240_000);
  scratch = mkdtempSync(join(tmpdir(), 'ofk-service-home-'));
  alphaDir = join(scratch, 'alpha');
  mkdirSync(alphaDir);
  mkdirSync(join(scratch, 'beta'));
  const app = join(scratch, 'app');
  execFileSync('npx', ['vite', 'build', '--outDir', app, '--emptyOutDir'], { stdio: 'pipe' });
  const config = join(scratch, 'service.json');
  writeFileSync(config, JSON.stringify({
    port: 43120, projects: [{ name: 'alpha', path: alphaDir }, { name: 'beta', path: join(scratch, 'beta') }],
  }));
  service = spawn('npx', ['tsx', 'mcp-server/src/cli.ts', 'serve', '--port', '0', '--config', config, '--app', app], { stdio: ['ignore', 'pipe', 'inherit'] });
  url = await new Promise<string>((resolve, reject) => {
    service.once('exit', (code) => reject(new Error(`the service exited with ${code} before listening`)));
    service.stdout!.on('data', (chunk: Buffer) => {
      const found = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(chunk.toString());
      if (found) resolve(found[1]!);
    });
  });
  for (const [project, name] of [['alpha', 'Alpha flow'], ['alpha', 'Alpha second'], ['beta', 'Beta flow']] as const) {
    const response = await fetch(`${url}/projects/${project}/diagrams`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    });
    ids[name] = ((await response.json()) as { id: string }).id;
  }
});

test.afterAll(() => {
  service?.kill();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test('Home groups service diagrams by project; only the rename is offered on them @gate', async ({ page }) => {
  await page.goto(`${url}/#/home`);
  await expect(page.getByTestId('v2-home')).toBeVisible();
  // A diagram of this browser's own, brought in as a file.
  writeFileSync(join(scratch, 'local.mmd'), 'flowchart LR\n  A --> B\n');
  execFileSync('npx', ['tsx', 'mcp-server/src/cli.ts', 'convert', join(scratch, 'local.mmd'), '-o', join(scratch, 'Local one.json')], { stdio: 'pipe' });
  const local = JSON.parse(readFileSync(join(scratch, 'Local one.json'), 'utf8')) as object;
  writeFileSync(join(scratch, 'Local one.json'), JSON.stringify({ ...local, name: 'Local one' }));
  await page.locator('input[type="file"]').first().setInputFiles(join(scratch, 'Local one.json'));
  await expect(page.getByTestId('v2-home')).toBeVisible();

  const projects = page.getByRole('region', { name: 'Projects', exact: true });
  const alpha = projects.getByRole('region', { name: 'Project alpha' });
  const beta = projects.getByRole('region', { name: 'Project beta' });
  await expect(alpha.getByRole('listitem')).toHaveCount(2);
  await expect(alpha).toContainText('Alpha flow');
  await expect(alpha).toContainText('Alpha second');
  await expect(beta.getByRole('listitem')).toHaveCount(1);
  await expect(beta).toContainText('Beta flow');
  await expect(projects).not.toContainText('Local one');

  // Archive, duplicate and delete: on the browser's card, absent on a service card.
  await page.getByRole('button', { name: 'More actions for Local one' }).click();
  await expect(page.getByRole('menuitem', { name: 'Duplicate' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Archive' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'More actions for Beta flow' }).click();
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Duplicate' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Archive' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Star' })).toHaveCount(0);
  await expect(beta.getByRole('button', { name: 'Star Beta flow' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Rename through the service: the file's name changes.
  await page.getByRole('button', { name: 'More actions for Alpha second' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByRole('textbox', { name: 'Rename Alpha second' }).fill('Alpha renamed');
  await page.keyboard.press('Enter');
  await expect(alpha).toContainText('Alpha renamed');
  const file = readdirSync(alphaDir).map((entry) => JSON.parse(readFileSync(join(alphaDir, entry), 'utf8')) as { id: string; name: string })
    .find((document) => document.id === ids['Alpha second']);
  expect(file?.name).toBe('Alpha renamed');

  // A card opens its diagram under /p/.
  await alpha.getByRole('link', { name: 'Alpha flow' }).click();
  await expect(page).toHaveURL(`${url}/#/p/alpha/${ids['Alpha flow']}`);
  await expect(page.locator('[data-testid="v2-canvas"]')).toBeVisible();
});

test('without a service Home has no Projects section @gate', async ({ page }) => {
  await page.goto('/#/home');
  await expect(page.getByTestId('v2-home')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('region', { name: 'Projects', exact: true })).toHaveCount(0);
});
