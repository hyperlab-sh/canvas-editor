import { encryptDocument } from '../src/services/share/shareCrypto';
import { createTestDocument } from '../src/opencanvas/testing/builders/documentBuilder';
import { drawShape, openCanvas } from './helpers';
import { expect, test, type Page } from './test';

// Usage counts and feedback prompts. The e2e app is a dev build, where counting is off: each spec here opts in with
// localStorage `ofk.usage` = 'on' (usage.ts honours it in dev only for this). The share Worker is route-stubbed.
// npm run e2e:headed -- e2e/feedback.spec.ts

const SHARE = 'https://share.openflowkit.com';
const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js*';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };

interface Sent { readonly path: string; readonly body: Record<string, unknown>; readonly token: string | undefined }

/** Stubs /e and /feedback (and the Turnstile widget) and records what arrives. */
async function backend(page: Page): Promise<Sent[]> {
  const sent: Sent[] = [];
  await page.context().route(`${SHARE}/**`, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    sent.push({ path: new URL(request.url()).pathname, body: JSON.parse(request.postData() ?? 'null') as Record<string, unknown>, token: await request.headerValue('x-turnstile-token') ?? undefined });
    return route.fulfill({ status: request.url().endsWith('/e') ? 204 : 201, headers: CORS });
  });
  await page.context().route(TURNSTILE_SCRIPT, (route) => route.fulfill({
    contentType: 'text/javascript',
    body: 'window.turnstile={render:(el,o)=>{setTimeout(()=>o.callback("stub-token"),10);return "w1"},remove:()=>{}};',
  }));
  return sent;
}

/** Counting on (dev build), tips out of the way, and the feedback state given (first visit long ago by default). */
async function seed(page: Page, feedback: Record<string, unknown> = { firstVisitAt: 0 }): Promise<void> {
  await page.addInitScript((state) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('ofk.usage', 'on');
    localStorage.setItem('ofk.tips.seen', JSON.stringify(['code', 'connect', 'assistant', 'motion']));
    localStorage.setItem('ofk.feedback', JSON.stringify(state));
  }, feedback);
}

const hideTab = (page: Page) => page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
});

async function exportPng(page: Page): Promise<void> {
  await drawShape(page, 'r', 360, 300);
  await page.getByRole('toolbar', { name: 'Share and export' }).getByRole('button', { name: 'Export' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  await download;
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}

const prompt = (page: Page) => page.locator('.ofk-v2-feedback');

test('one beacon carries the session and what was used, when the tab hides @gate', async ({ page }) => {
  const sent = await backend(page);
  await seed(page);
  await openCanvas(page);
  await exportPng(page);
  await hideTab(page);
  await expect.poll(() => sent.filter((item) => item.path === '/e').length).toBe(1);
  const beacon = sent.find((item) => item.path === '/e')!.body;
  expect(beacon).toMatchObject({ v: 1, entry: 'home', returning: false, counts: { session: 1, created_draw: 1, export_image: 1 } });
  expect(beacon.uid).toMatch(/^[0-9a-f]{32}$/);
  // A second hide within 5 minutes stays quiet; nothing new is never sent.
  await hideTab(page);
  await page.waitForTimeout(300);
  expect(sent.filter((item) => item.path === '/e')).toHaveLength(1);
});

test('stats turned off in Settings: nothing is sent and the id is gone @gate', async ({ page }) => {
  const sent = await backend(page);
  await seed(page);
  await openCanvas(page);
  await page.getByRole('button', { name: 'Canvas menu' }).click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  const stats = page.getByRole('switch', { name: 'Share usage stats' });
  await expect(stats).toBeChecked();
  await page.getByText('Share usage stats').click();
  await expect(stats).not.toBeChecked();
  await page.keyboard.press('Escape');
  await exportPng(page);
  await hideTab(page);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.waitForTimeout(500);
  expect(sent.filter((item) => item.path === '/e')).toHaveLength(0);
  expect(await page.evaluate(() => [localStorage.getItem('ofk.usage'), localStorage.getItem('ofk.usage.id')])).toEqual(['off', null]);
});

test('after an export settles, one question; a thumb and a note post with the human check @gate', async ({ page }) => {
  const sent = await backend(page);
  await seed(page);
  await page.clock.install();
  await openCanvas(page);
  await exportPng(page);
  await expect(prompt(page)).toHaveCount(0);
  await page.clock.fastForward(21_000);
  await expect(prompt(page)).toContainText('How was the export?');
  // Passive, like a tip: it never takes focus on its own.
  expect(await prompt(page).evaluate((card) => card.contains(document.activeElement))).toBe(false);
  await prompt(page).getByRole('button', { name: 'Thumbs up' }).click();
  const note = prompt(page).getByRole('textbox', { name: 'What would make it better?' });
  await expect(note).toBeFocused();
  await note.fill('Transparent background please');
  await prompt(page).getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Thanks — sent.')).toBeVisible();
  await expect(prompt(page)).toHaveCount(0);
  const posted = sent.find((item) => item.path === '/feedback')!;
  expect(posted.body).toMatchObject({ kind: 'feature', feature: 'export', rating: 'up', text: 'Transparent background please' });
  expect(posted.token).toBe('stub-token');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('ofk.feedback')!) as { asked: string[]; lastPromptAt: number });
  expect(stored.asked).toEqual(['export']);
  // Asked once, ever: another export stays quiet.
  await exportPng(page);
  await page.clock.fastForward(21_000);
  await expect(prompt(page)).toHaveCount(0);
});

test('on a third day, the product question walks three steps and sends what was chosen @gate', async ({ page }) => {
  const sent = await backend(page);
  const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
  await seed(page, { firstVisitAt: 0, activeDays: [day(3), day(2)] });
  await page.clock.install();
  await openCanvas(page);
  await page.clock.fastForward(21_000);
  await expect(prompt(page)).toContainText('How would you feel if you could no longer use OpenFlowKit?');
  await prompt(page).getByRole('button', { name: 'Very disappointed' }).click();
  await expect(prompt(page)).toContainText('What would you pay for?');
  await prompt(page).getByRole('checkbox', { name: 'Sync across devices' }).check({ force: true });
  await prompt(page).getByRole('button', { name: 'Next' }).click();
  await prompt(page).getByRole('textbox', { name: 'Email' }).fill('me@example.com');
  await prompt(page).getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Thanks — sent.')).toBeVisible();
  const posted = sent.find((item) => item.path === '/feedback')!;
  expect(posted.body).toMatchObject({ kind: 'product', pmf: 'very', pay: ['sync'], email: 'me@example.com' });
  expect(posted.token).toBe('stub-token');
});

test('Help → Send feedback posts the note, whatever the prompt rules say @gate', async ({ page }) => {
  const sent = await backend(page);
  await seed(page, { never: true });
  await openCanvas(page);
  const menu = page.getByRole('button', { name: 'Canvas menu' });
  await menu.click();
  await page.getByRole('menuitem', { name: 'Send feedback…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send feedback' });
  const note = dialog.getByRole('textbox', { name: 'Your feedback' });
  await expect(note).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Send' })).toBeDisabled();
  await note.fill('Please add swimlanes');
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Thanks — sent.')).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(menu).toBeFocused();
  const posted = sent.find((item) => item.path === '/feedback')!;
  expect(posted.body).toMatchObject({ kind: 'general', text: 'Please add swimlanes' });
  expect(posted.body.email).toBeUndefined();
  expect(posted.token).toBe('stub-token');
});

test('a failed send keeps the note and says why @gate', async ({ page }) => {
  await backend(page);
  await page.context().route(`${SHARE}/feedback`, (route) => route.fulfill({ status: route.request().method() === 'OPTIONS' ? 204 : 429, headers: CORS }));
  await seed(page);
  await openCanvas(page);
  await page.getByRole('button', { name: 'Canvas menu' }).click();
  await page.getByRole('menuitem', { name: 'Send feedback…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send feedback' });
  await dialog.getByRole('textbox', { name: 'Your feedback' }).fill('Keep me');
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Too much feedback from this network. Wait a minute and try again.')).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Your feedback' })).toHaveValue('Keep me');
});

test('a shared link’s viewer is never asked and sends nothing @gate', async ({ page }) => {
  const sent = await backend(page);
  const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
  await seed(page, { firstVisitAt: 0, activeDays: [day(3), day(2), day(1)] });
  const { body, key } = await encryptDocument(createTestDocument());
  await page.context().route(`${SHARE}/s/${'a'.repeat(32)}`, (route) => route.fulfill({ status: 200, headers: CORS, body: Buffer.from(body) }));
  await page.clock.install();
  await page.goto(`/#/s/${'a'.repeat(32)}/${key}`);
  await expect(page.getByText('Shared diagram, read-only')).toBeVisible();
  await page.clock.fastForward(25_000);
  await page.waitForTimeout(500);
  await expect(prompt(page)).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.waitForTimeout(300);
  expect(sent.filter((item) => item.path === '/e')).toHaveLength(0);
});

test('the Pro waitlist: a plan, what you’d pay for, a fair price, an email; the sidebar remembers @gate', async ({ page }) => {
  const sent = await backend(page);
  await seed(page);
  await page.goto('/#/home');
  const row = page.getByRole('button', { name: /OpenFlowKit Pro/ });
  await expect(row).toContainText('Waitlist');
  await row.click();
  const dialog = page.getByRole('dialog', { name: 'OpenFlowKit Pro' });
  const next = dialog.getByRole('button', { name: 'Continue' });
  await expect(next).toBeDisabled();
  await dialog.getByRole('radio', { name: /Team/ }).check({ force: true });
  await next.click();
  await dialog.getByRole('button', { name: 'Real-time collaboration' }).click();
  await dialog.getByRole('button', { name: 'Drift alerts on PRs' }).click();
  await expect(dialog.getByRole('button', { name: 'Drift alerts on PRs' })).toHaveAttribute('aria-pressed', 'true');
  const slider = dialog.getByRole('slider', { name: 'What would feel fair, per person a month?' });
  // It opens on the plan's founding price, already a number, never an empty "drag to answer".
  await expect(dialog.locator('output')).toHaveText('$9 a month');
  await slider.focus();
  for (let press = 0; press < 3; press += 1) await page.keyboard.press('ArrowRight');
  await expect(dialog.locator('output')).toHaveText('$12 a month');
  await next.click();
  await expect(dialog.getByText('2 must-haves')).toBeVisible();
  const claim = dialog.getByRole('button', { name: 'Claim my founding spot' });
  await expect(claim).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Where should we send your invite?' }).fill('ada@example.com');
  await page.keyboard.press('Enter');
  const done = page.getByRole('dialog', { name: 'You’re on the list' });
  await expect(done).toContainText('Founding member');
  await expect(done).toContainText('$9 a person, a month, for life');
  await expect(done.getByRole('link', { name: 'Star us while you wait' })).toHaveAttribute('href', /github\.com/);
  const posted = sent.find((item) => item.path === '/feedback')!;
  expect(posted.body).toMatchObject({ kind: 'pro', plan: 'team', price: 12, pay: ['collaboration', 'drift'], email: 'ada@example.com' });
  expect(posted.token).toBe('stub-token');
  await done.getByRole('button', { name: 'Back to drawing' }).click();
  await expect(done).toBeHidden();
  await expect(row).toContainText('On the list');
  await page.reload();
  await expect(page.getByRole('button', { name: /OpenFlowKit Pro/ })).toContainText('On the list');
});
