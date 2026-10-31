import { expect, test, type Page } from './test';
import { centreOf, drawShape, emptyPoint, openCanvas, state } from './helpers';

// Feature tips: one hint when it pays off, at most one a session, never the same one twice.
// npm run e2e:headed -- e2e/feature-tips.spec.ts

const tip = (page: Page) => page.locator('.ofk-v2-tip');

async function drawThree(page: Page) {
  await drawShape(page, 'r', 360, 300);
  await drawShape(page, 'r', 560, 300);
  await drawShape(page, 'o', 760, 300);
}

test('three hand-drawn shapes point at Diagram as code once, and never again @gate', async ({ page }) => {
  await openCanvas(page);
  await drawThree(page);
  await expect(tip(page)).toContainText('Draw it from text');
  // Beside the control it is about, and it never took focus from the canvas.
  await expect(page.getByTestId('v2-canvas')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(tip(page)).toHaveCount(0);

  // Same session: a second trigger (two shapes selected, no connectors) stays silent.
  await page.keyboard.press('Meta+a');
  await page.waitForTimeout(400);
  await expect(tip(page)).toHaveCount(0);

  // A new tab is a new session; the seen tip still never returns.
  const next = await page.context().newPage();
  await openCanvas(next);
  await drawThree(next);
  await next.waitForTimeout(600);
  await expect(tip(next)).toHaveCount(0);
});

test('the tip’s action opens what it names @gate', async ({ page }) => {
  await openCanvas(page);
  await drawThree(page);
  await expect(tip(page)).toBeVisible();
  await tip(page).getByRole('button', { name: 'Open Diagram as code' }).click();
  await expect(page.getByRole('textbox', { name: 'Diagram source' })).toBeVisible();
  await expect(tip(page)).toHaveCount(0);
});

/** Overlap in CSS pixels between the tip and the selection's context bar; 0 when either is not on screen. */
async function tipOverContextBar(page: Page): Promise<number> {
  const bar = page.locator('[data-context-bar]');
  if (!(await tip(page).isVisible()) || !(await bar.isVisible())) return 0;
  const [a, b] = [(await tip(page).boundingBox())!, (await bar.boundingBox())!];
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}

test('a tip waits for an idle canvas and never covers the selection’s context bar @gate', async ({ page }) => {
  await openCanvas(page);
  // Shapes right under the Diagram as code button: the selection's context bar lands where the tip would.
  const code = (await page.locator('[role="toolbar"][aria-label="Workspace"] button[aria-label="Diagram as code"]').boundingBox())!;
  await drawShape(page, 'r', code.x - 160, code.y + 150);
  await drawShape(page, 'r', code.x - 160, code.y + 300);
  const last = await drawShape(page, 'o', code.x - 420, code.y + 220);
  const at = await centreOf(page, last);
  await page.mouse.click(at.x, at.y);
  await expect(page.locator('[data-context-bar]')).toBeVisible();
  // Something selected: not the moment.
  await page.waitForTimeout(1200);
  await expect(tip(page)).toHaveCount(0);

  const empty = await emptyPoint(page, 300, 600);
  await page.mouse.click(empty.x, empty.y);
  await expect(tip(page)).toBeVisible();
  await expect(tip(page)).toHaveCSS('opacity', '1');

  // A selection made with the keyboard does not dismiss the tip: it steps aside while the bar would sit under it.
  await page.keyboard.press('ControlOrMeta+a');
  await expect(page.locator('[data-context-bar]')).toBeVisible();
  await expect.poll(() => tipOverContextBar(page)).toBe(0);
  await page.waitForTimeout(300);
  expect(await tipOverContextBar(page)).toBe(0);
  await expect(tip(page)).toHaveCount(1);
});

test('after an export, the motion tip points at Export once the panel has closed, clear of the chrome @gate', async ({ page }) => {
  await openCanvas(page);
  await drawShape(page, 'r', 360, 300);
  await drawShape(page, 'r', 560, 300);
  const exportButton = page.getByRole('toolbar', { name: 'Share and export' }).getByRole('button', { name: 'Export' });
  await exportButton.click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  await download;
  // Not over the open panel.
  await page.waitForTimeout(1200);
  await expect(tip(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(tip(page)).toContainText('Make it move');
  await expect(tip(page)).toBeVisible();
  // Beside Export, its caret at the button, and over no other chrome.
  const [t, e] = [(await tip(page).boundingBox())!, (await exportButton.boundingBox())!];
  expect(t.x + t.width).toBeLessThanOrEqual(e.x);
  expect(t.y).toBeLessThanOrEqual(e.y + e.height / 2);
  expect(t.y + t.height).toBeGreaterThanOrEqual(e.y + e.height / 2);
  expect(await tip(page).getAttribute('data-yielding')).toBeNull();
  await tip(page).getByRole('button', { name: 'Animate this page' }).click();
  await expect(page.getByRole('complementary', { name: 'Animation export' })).toBeVisible();
});

test('Mermaid pasted on the canvas is drawn in place, its source open beside it, one undo step @gate', async ({ page }) => {
  await openCanvas(page);
  await page.getByTestId('v2-canvas').evaluate((canvas) => {
    const data = new DataTransfer();
    data.setData('text/plain', 'flowchart LR\n  A[Cart] --> B[Paid]');
    canvas.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole('textbox', { name: 'Diagram source' })).toContainText('Cart');
  await expect.poll(async () => (await state(page)).nodes.length).toBeGreaterThan(0);
  await page.getByTestId('v2-canvas').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await state(page)).nodes.length).toBe(0);
});
