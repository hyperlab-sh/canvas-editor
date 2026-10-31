import { expect, test } from './test';
import { rect } from './helpers';

// A slow start (persona-verify V00): the repo is read and laid out before the renderer has mounted. The map must still land on
// screen once it has, not frame itself in a 0×0 viewport and stay off screen. The renderer's code is held back on purpose.
// npx playwright test e2e/map-slow-renderer.spec.ts

const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-ratelimit-remaining, x-ratelimit-reset' };
const REPO: Readonly<Record<string, string>> = {
  'web/package.json': '{"name":"web"}',
  'web/src/main.ts': "import { App } from './App';\nApp();\n",
  'web/src/App.ts': 'export const App = () => 1;\n',
  'api/package.json': '{"name":"api"}',
  'api/src/server.ts': "import { users } from './users';\nexport const s = users;\n",
  'api/src/users.ts': 'export const users = 1;\n',
};

test('a map laid out before the renderer is ready lands on screen once it is @gate', async ({ page }) => {
  test.setTimeout(90_000);
  await page.route('https://api.github.com/repos/acme/shop/git/trees/**', (route) => route.fulfill({
    json: { sha: 'abc', truncated: false, tree: Object.entries(REPO).map(([path, text]) => ({ path, type: 'blob', mode: '100644', sha: 'x', size: text.length })) }, headers: CORS }));
  await page.route('https://raw.githubusercontent.com/acme/shop/**', (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/acme\/shop\/[^/]+\//, ''));
    return route.fulfill({ status: REPO[path] === undefined ? 404 : 200, contentType: 'text/plain', body: REPO[path] ?? '', headers: CORS });
  });
  // Hold the WebGL renderer chunk for 3 s: the map is read and laid out before the renderer has started.
  await page.route(/WebGLRenderer-[^/]*\.js/, async (route) => { await new Promise((done) => setTimeout(done, 3000)); await route.fallback(); });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/#/map/github/acme/shop');
  await page.waitForFunction(() => '__V2__' in window, undefined, { timeout: 30_000 });
  const ids = () => page.evaluate(() => (window as unknown as { __V2__: { getMapState(): { nodes: string[] } } }).__V2__.getMapState().nodes);
  await expect.poll(async () => (await ids()).length, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(page.locator('.ofk-loader[data-cover]')).toHaveCount(0, { timeout: 10_000 });
  // Some top-level box is on the canvas where the reader can see it.
  const canvas = (await page.locator('[data-testid="v2-canvas"]').boundingBox())!;
  await expect.poll(async () => {
    for (const id of await ids()) {
      const r = await rect(page, id);
      if (r && r.width > 20 && r.x + r.width > 0 && r.y + r.height > 0 && r.x < canvas.width && r.y < canvas.height) return true;
    }
    return false;
  }, { timeout: 10_000 }).toBe(true);
});
