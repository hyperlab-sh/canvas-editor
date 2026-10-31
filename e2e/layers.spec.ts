import { deflateRawSync } from 'node:zlib';
import { expect, test, type Page } from './test';

// The Layers panel against the canvas: names, hidden and locked parents, selection both ways, the row menu.
// npx playwright test e2e/layers.spec.ts --headed

const DSL = 'flowchart\ngroup Backend {\n  API -> DB\n}\nClient -> API\n';
type Api = {
  getState(): { selectedNodes: string[] };
  getDocument(): { pages: { nodes: { id: string; parentId: string | null; content: { label?: string } }[] }[] } | null;
  getNodeRect(id: string): { x: number; y: number; width: number; height: number } | null;
};
const api = (page: Page) => ({
  selected: () => page.evaluate(() => (window as unknown as { __V2__: Api }).__V2__.getState().selectedNodes),
  nodes: () => page.evaluate(() => (window as unknown as { __V2__: Api }).__V2__.getDocument()?.pages[0]?.nodes ?? []),
  rect: (id: string) => page.evaluate((nodeId) => (window as unknown as { __V2__: Api }).__V2__.getNodeRect(nodeId), id),
});

test('Layers follows the canvas: hidden parents, selection both ways, rename, reorder, duplicate in place @gate', async ({ page }) => {
  const { selected, nodes, rect } = api(page);
  await page.goto(`/#/from/dsl?d=${deflateRawSync(Buffer.from(DSL, 'utf8')).toString('base64url')}`);
  await page.waitForSelector('[data-testid="v2-canvas"]', { timeout: 30_000 });
  await expect.poll(async () => (await nodes()).length).toBe(5);
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  const layers = page.getByRole('complementary', { name: 'Layers' });
  const row = (name: string) => layers.locator('.ofk-object-row', { has: page.getByRole('button', { name, exact: true }) });
  // An unlabeled connection reads as the shapes it joins.
  await expect(layers.getByRole('button', { name: 'Client → API', exact: true })).toBeVisible();

  // Hiding a group dims its members and drops them from the selection; a hidden row selects nothing.
  await layers.getByRole('button', { name: 'API', exact: true }).click();
  expect(await selected()).toEqual(['api']);
  await row('Backend').hover();
  await layers.getByRole('button', { name: 'Hide Backend', exact: true }).click();
  await expect(row('API')).toHaveAttribute('data-hidden', 'true');
  await expect.poll(() => selected()).toEqual([]);
  await layers.getByRole('button', { name: 'API', exact: true }).click({ force: true });
  expect(await selected()).toEqual([]);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(row('API')).not.toHaveAttribute('data-hidden');

  // A shape picked on the canvas opens its collapsed group in the list.
  await layers.getByRole('button', { name: 'Collapse Backend', exact: true }).click();
  await expect(row('API')).toHaveCount(0);
  const canvas = (await page.locator('[data-testid="v2-canvas"] canvas').boundingBox())!;
  const box = (await rect('api'))!;
  await page.mouse.click(canvas.x + box.x + box.width / 2, canvas.y + box.y + box.height / 2);
  await expect(row('API')).toHaveAttribute('data-selected', 'true');

  // A row whose shape is off screen brings it back, at the same zoom.
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.mouse.wheel(0, 4000);
  await expect.poll(async () => (await rect('client'))!.y).toBeLessThan(-200);
  await layers.getByRole('button', { name: 'Client', exact: true }).click();
  await expect.poll(async () => (await rect('client'))!.y).toBeGreaterThan(0);

  // Double-click renames in place; one undo step.
  await layers.getByRole('button', { name: 'Client', exact: true }).dblclick();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
  await page.keyboard.type('Browser');
  await page.keyboard.press('Enter');
  await expect(layers.getByRole('button', { name: 'Browser → API', exact: true })).toBeVisible();

  // Reorder from the row menu.
  const order = () => layers.locator('.ofk-object-select').allTextContents();
  expect((await order()).indexOf('DB')).toBeLessThan((await order()).indexOf('API'));
  await layers.getByRole('button', { name: 'Actions for DB', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Reorder' }).click();
  await page.getByRole('menuitem', { name: 'Send to back' }).click();
  await expect.poll(async () => (await order()).indexOf('DB')).toBeGreaterThan((await order()).indexOf('API'));

  // Duplicating a member keeps the copy in its group (it used to jump to the page origin), one row selected.
  await layers.getByRole('button', { name: 'Actions for API', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect.poll(async () => (await nodes()).filter((node) => node.content.label === 'API').map((node) => node.parentId)).toEqual(['backend', 'backend']);
  await expect(layers.locator('.ofk-object-row[data-selected]')).toHaveCount(1);
});

test('dragging a row reorders, drops into a section (inside its box), refuses its own child, and Escape cancels @gate', async ({ page }) => {
  const { nodes, rect } = api(page);
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.goto('/');
  const canvas = page.getByTestId('v2-canvas');
  await canvas.waitFor();
  for (const [key, label, x, y] of [['r', 'Alpha', 520, 260], ['r', 'Beta', 820, 260], ['o', 'Gamma', 700, 560]] as const) {
    await canvas.focus();
    await page.keyboard.press(key);
    await page.mouse.click(x, y);
    await page.keyboard.type(label);
    await page.keyboard.press('Escape');
  }
  await expect.poll(async () => (await nodes()).map((node) => node.content.label)).toEqual(['Alpha', 'Beta', 'Gamma']);
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  const layers = page.getByRole('complementary', { name: 'Layers' });
  await layers.getByRole('button', { name: 'Alpha', exact: true }).click();
  await canvas.focus();
  await page.keyboard.press(`${mod}+Alt+g`);
  await expect(layers.getByRole('button', { name: 'Section', exact: true })).toBeVisible();
  const order = () => layers.locator('.ofk-object-select').allTextContents();
  const idOf = async (label: string) => (await nodes()).find((node) => node.content.label === label)!.id;
  /** Presses `from`, drags past the threshold to `share` of the `to` row's height, and returns the drop indicator shown. */
  async function dragRow(from: string, to: string, share: number, finish: 'drop' | 'escape' = 'drop') {
    const a = (await layers.getByRole('button', { name: from, exact: true }).boundingBox())!;
    const b = (await layers.getByRole('button', { name: to, exact: true }).boundingBox())!;
    await page.mouse.move(a.x + 24, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + 24, a.y + a.height / 2 + 8, { steps: 2 });
    await page.mouse.move(b.x + 24, b.y + b.height * share, { steps: 6 });
    const shown = await layers.locator('[data-drop]').evaluateAll((rows) => rows.map((row) => `${row.textContent}:${row.getAttribute('data-drop')}`));
    if (finish === 'escape') await page.keyboard.press('Escape');
    await page.mouse.up();
    return shown;
  }

  // Between siblings: Gamma (front) goes behind Beta, one undo step.
  expect(await order()).toEqual(['Gamma', 'Beta', 'Section', 'Alpha']);
  expect(await dragRow('Gamma', 'Beta', 0.9)).toEqual(['Beta:bottom']);
  await expect.poll(order).toEqual(['Beta', 'Gamma', 'Section', 'Alpha']);
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(order).toEqual(['Gamma', 'Beta', 'Section', 'Alpha']);

  // Escape mid-drag: nothing moves, the panel stays.
  await dragRow('Gamma', 'Section', 0.5, 'escape');
  await expect.poll(order).toEqual(['Gamma', 'Beta', 'Section', 'Alpha']);
  await expect(layers).toBeVisible();

  // Onto the section row: Beta, standing outside it, joins it in front of Alpha and lands inside its box,
  // never a child outside its parent (the next canvas drag would quietly take it out again).
  const beta = await idOf('Beta');
  expect(await dragRow('Beta', 'Section', 0.5)).toEqual(['Section:into']);
  await expect.poll(async () => (await nodes()).find((node) => node.id === beta)!.parentId).toBe(await idOf('Section'));
  expect(await order()).toEqual(['Gamma', 'Section', 'Beta', 'Alpha']);
  const inside = (await rect(beta))!;
  const section = (await rect(await idOf('Section')))!;
  const centre = { x: inside.x + inside.width / 2, y: inside.y + inside.height / 2 };
  expect(centre.x).toBeGreaterThan(section.x);
  expect(centre.x).toBeLessThan(section.x + section.width);
  expect(centre.y).toBeGreaterThan(section.y);
  expect(centre.y).toBeLessThan(section.y + section.height);

  // A section dropped into its own child is refused: no indicator, nothing changes.
  expect(await dragRow('Section', 'Alpha', 0.9)).toEqual([]);
  expect(await order()).toEqual(['Gamma', 'Section', 'Beta', 'Alpha']);

  // The front-most shape cannot come further forward: those Reorder items are disabled.
  await layers.getByRole('button', { name: 'Actions for Gamma', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Reorder' }).click();
  await expect(page.getByRole('menuitem', { name: 'Bring to front' })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: 'Send to back' })).toBeEnabled();
});
