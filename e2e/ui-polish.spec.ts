// Headed: first-visit polish found by the 2026-10-13 personas (V12, V13, R19, V11/R18).
// OFK_SHOTS_DIR=<dir> keeps a light and a dark screenshot of each state, for review.
// npx playwright test e2e/ui-polish.spec.ts --headed --workers=1
import { expect, test, type Page } from './test';
import { openCanvas } from './helpers';

const shot = async (page: Page, name: string) => {
  if (!process.env.OFK_SHOTS_DIR) return;
  const theme = await page.locator('.ofk-system').first().getAttribute('data-ofk-appearance');
  await page.screenshot({ animations: 'disabled', path: `${process.env.OFK_SHOTS_DIR}/${name}-${theme}.png` });
};
const rail = (page: Page) => page.getByRole('toolbar', { name: 'Workspace', exact: true });
const settingsDialog = (page: Page) => page.getByRole('dialog', { name: 'Settings' });

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Canvas menu' }).click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await expect(settingsDialog(page)).toBeVisible();
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`one tooltip at a time: the one focus left after a popover gives way to the hovered one (V12, ${colorScheme}) @gate`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await openCanvas(page);
    await openSettings(page);
    await page.keyboard.press('Escape');
    await expect(settingsDialog(page)).toHaveCount(0);
    // Focus came back to the Canvas menu by keyboard, so its tooltip shows.
    await expect(page.getByRole('tooltip')).toHaveText(/Canvas menu/);
    await rail(page).getByRole('button', { name: 'AI assistant', exact: true }).hover();
    await expect(page.getByRole('tooltip')).toHaveText(/AI assistant/);
    await expect(page.getByRole('tooltip')).toHaveCount(1);
    await shot(page, 'v12-one-tooltip');
  });
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`first visit: guides hide under popovers, Export and Share on an empty page say what works (V13, ${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    const guides = page.locator('.ofk-v2-guide');
    await expect(guides.first()).toBeVisible();
    await shot(page, 'v13-welcome');

    await openSettings(page);
    for (const guide of await guides.all()) await expect(guide).toBeHidden();
    await shot(page, 'v13-settings-no-guides');
    await page.keyboard.press('Escape');
    await expect(guides.first()).toBeVisible();

    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const exportPanel = page.getByRole('dialog', { name: 'Export' });
    await expect(exportPanel.getByRole('button', { name: 'Download', exact: true })).toBeDisabled();
    await expect(exportPanel.getByRole('button', { name: 'Animate this page…' })).toBeDisabled();
    for (const guide of await guides.all()) await expect(guide).toBeHidden();
    await shot(page, 'v13-export-empty');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Share', exact: true }).click();
    const sharePanel = page.getByRole('dialog', { name: 'Share' });
    await expect(sharePanel).toBeVisible();
    await expect(sharePanel).not.toContainText('share server');
    await shot(page, 'v13-share');
  });
}

// A small fake repo served by page.route (the map-repo.spec.ts pattern): two parts, folders, imports.
const imp = (names: string, from: string) => `import { ${names} } from '${from}';\n`;
const REPO: Readonly<Record<string, string>> = {
  'web/package.json': '{"name":"web"}',
  'web/src/main.ts': imp('App', './App') + 'App();\n',
  'web/src/App.ts': imp('Button', './ui/Button') + imp('Card', './ui/Card') + imp('call', './lib/client') + 'export const App = () => [Button, Card, call];\n',
  'web/src/ui/Button.ts': 'export const Button = 1;\n',
  'web/src/ui/Card.ts': imp('Button', './Button') + 'export const Card = Button;\n',
  'web/src/lib/format.ts': 'export const fmt = (n: number) => String(n);\n',
  'web/src/lib/client.ts': imp('fmt', './format') + 'export const call = () => fmt(1);\n',
  'api/package.json': '{"name":"api"}',
  'api/src/db.ts': 'export const query = () => [];\n',
  'api/src/server.ts': imp('users', './routes/users') + imp('orders', './routes/orders') + 'export const s = [users, orders];\n',
  'api/src/routes/users.ts': imp('query', '../db') + 'export const users = [query];\n',
  'api/src/routes/orders.ts': imp('query', '../db') + 'export const orders = [query];\n',
};
const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-ratelimit-remaining, x-ratelimit-reset' };

async function openMap(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.route('https://api.github.com/repos/acme/shop/git/trees/**', (route) => route.fulfill({ headers: CORS,
    json: { sha: 'abc', truncated: false, tree: Object.entries(REPO).map(([path, text]) => ({ path, type: 'blob', mode: '100644', sha: 'x', size: text.length })) } }));
  await page.route('https://raw.githubusercontent.com/acme/shop/**', (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/acme\/shop\/[^/]+\//, ''));
    return route.fulfill({ status: REPO[path] === undefined ? 404 : 200, contentType: 'text/plain', body: REPO[path] ?? '', headers: CORS });
  });
  await page.goto('/#/map/github/acme/shop');
  await expect(page).toHaveURL(/#\/d\/map-acme_shop$/);
  await expect(page.getByRole('progressbar')).toHaveCount(0, { timeout: 20_000 });
}

const zoomButton = (page: Page) => page.getByRole('button', { name: /^Zoom \d+%/ });
async function zoomTo(page: Page, percent: number): Promise<void> {
  await zoomButton(page).click();
  await page.getByRole('menuitemcheckbox', { name: new RegExp(`^Zoom to ${percent}%`) }).click();
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`zoomed out, a map box drops its header strip with the header text (R19, ${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await openMap(page, 1440, 900);
    await page.getByRole('toolbar', { name: 'Map depth', exact: true }).getByRole('button', { name: 'All levels', exact: true }).click();
    await page.waitForTimeout(1_200); // the boxes grow in place
    await zoomTo(page, 50);
    await page.keyboard.press('ControlOrMeta+Minus');
    await expect(zoomButton(page)).toHaveAttribute('aria-label', /Zoom (3\d|4\d)%/);
    await page.waitForTimeout(400);
    await shot(page, 'r19-map-40');
    await zoomTo(page, 100);
    await expect(zoomButton(page)).toHaveAttribute('aria-label', 'Zoom 100%');
    await page.waitForTimeout(400);
    await shot(page, 'r19-map-100');
  });

  test(`390 px: the map's toast rises above the map toolbar, covering none of it (V11/R18, ${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await openMap(page, 390, 844);
    // The first visit opens the map's outline over a phone screen; the next session lands on the map and says it is partial.
    await page.getByRole('complementary', { name: 'Map' }).getByRole('button', { name: 'Close panel' }).click();
    await page.reload();
    await expect(page.getByRole('toolbar', { name: 'Map depth', exact: true })).toBeVisible({ timeout: 20_000 });
    const toast = page.locator('.ofk-toast').filter({ hasText: 'Showing part of the map' });
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await shot(page, 'v11-390-map-toast');
    const t = (await toast.boundingBox())!;
    for (const name of ['Map depth', 'View']) {
      const bar = (await page.getByRole('toolbar', { name, exact: true }).boundingBox())!;
      const overlap = t.x < bar.x + bar.width && t.x + t.width > bar.x && t.y < bar.y + bar.height && t.y + t.height > bar.y;
      expect(overlap, `toast clear of ${name}`).toBe(false);
    }
  });
}
