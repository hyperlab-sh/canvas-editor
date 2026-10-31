import { readFileSync } from 'node:fs';
import { expect, test, type Page } from './test';

// Phase 12.6: a browser still running v1's app-shell worker meets v2, and the worker goes.
// npm run e2e:headed -- e2e/service-worker.spec.ts

const V1_WORKER = readFileSync('e2e/fixtures/v1-sw.js', 'utf8'); // main's public/sw.js, verbatim

const registrations = (page: Page) => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
const cacheNames = (page: Page) => page.evaluate(() => caches.keys());
// The kill-switch worker navigates open tabs when it activates, which can land on top of the
// test's own reload: that navigation winning is the worker doing its job, not a failure.
const reload = (page: Page) => page.reload().catch((error: unknown) => {
  if (!/ERR_ABORTED|detached/.test(String(error))) throw error;
  return page.waitForLoadState('load');
});

test('v1 service worker unregisters itself and its caches once v2 is served @gate', async ({ page, context }) => {
  // Before the deploy: `/sw.js` is v1's, registered the way v1 did on load.
  await context.route('**/sw.js', (route) => route.fulfill({ contentType: 'text/javascript', body: V1_WORKER }));
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => cacheNames(page)).toContain('openflowkit-app-shell-v1');
  expect(await registrations(page)).toBe(1);

  // The deploy: the server's `/sw.js` is now the kill switch. A navigation makes the
  // browser check for a new worker, as every real visit does.
  await context.unroute('**/sw.js');
  await reload(page);
  await expect.poll(() => registrations(page), { timeout: 15_000 }).toBe(0);
  await expect.poll(() => cacheNames(page)).toEqual([]);
  await expect(page.locator('[data-testid="v2-canvas"]')).toBeVisible();
  // The next visit runs on the network, not under a worker.
  await reload(page);
  expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
});

// A v1 tab that moved between v1's hash routes: the worker's own navigation must be a real load,
// not a hash change, or v1 keeps running and its next lazy chunk 404s.
// @local, not @gate: sw.js unregisters at install, so activation (which navigates) doesn't always come
// (~1 run in 5 here). When it comes, the load is real; when it doesn't, the v1 tab's next chunk fails.
test('the kill switch reloads a tab on a hash route instead of leaving it running @local', async ({ page, context }) => {
  await context.route('**/sw.js', (route) => route.fulfill({ contentType: 'text/javascript', body: V1_WORKER }));
  await page.goto('/#/home');
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
  });
  await page.evaluate(() => { (window as unknown as { staysAlive: boolean }).staysAlive = true; });

  await context.unroute('**/sw.js');
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update(); });
  await expect.poll(() => page.evaluate(() => (window as unknown as { staysAlive?: boolean }).staysAlive), { timeout: 15_000 }).toBeUndefined();
  await expect(page.locator('[data-home-new]').first()).toBeVisible();
  // The marker param is v2's to strip.
  expect(new URL(page.url()).search).toBe('');
});
