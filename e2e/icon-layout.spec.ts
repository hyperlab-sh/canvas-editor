// Icon cards, end to end: an arrow into a tile ends at what is painted (#68), and the Icon panel puts the icon
// above the caption or left of the text as one undo step that the code panel writes as `iconpos` (#51).
import { centreOf, doc, openCanvas, rect, state } from './helpers';
import { expect, test, type Page } from './test';

type Api = { getConnectorScreenSamples(id: string): { x: number; y: number }[] | null };
const samples = (page: Page, id: string) => page.evaluate(
  (connectorId) => (window as unknown as { __V2__: Api }).__V2__.getConnectorScreenSamples(connectorId), id);

type DocNode = { id: string; size: { width: number; height: number }; content: Record<string, unknown> };
const nodeOf = async (page: Page, id: string) => (await doc(page))!.pages[0]!.nodes.find((candidate) => candidate.id === id) as unknown as DocNode;

async function generate(page: Page, source: string, expected: number): Promise<void> {
  await openCanvas(page);
  await page.getByRole('toolbar', { name: 'Workspace', exact: true }).getByRole('button', { name: 'Diagram as code' }).click();
  const editor = page.getByRole('textbox', { name: 'Diagram source' });
  await editor.fill(source);
  await editor.press('ControlOrMeta+Enter');
  await expect.poll(async () => (await state(page)).nodes.length, { timeout: 15_000 }).toBeGreaterThan(expected);
  await page.getByRole('button', { name: 'Close panel' }).click();
}

test('an arrow into the bottom of an icon tile ends under its caption, not in the empty box below @gate', async ({ page }) => {
  // The tile is 150 tall by hand: its box reaches well below the caption, where the arrow used to stop.
  await generate(page, '%% ofk 1\narchitecture up\n\nAPI [icon: tabler/server, height: 150]\nDB [icon: tabler/database]\nDB -> API', 2);
  const api = (await rect(page, 'api'))!;
  const size = (await nodeOf(page, 'api')).size;
  const scale = api.width / size.width;
  await expect.poll(async () => (await samples(page, (await doc(page))!.pages[0]!.connectors[0]!.id))?.length ?? 0).toBeGreaterThan(1);
  const route = (await samples(page, (await doc(page))!.pages[0]!.connectors[0]!.id))!;
  const end = route.at(-1)!;
  // Below the 72px plate (bottom at 76), at the caption's foot (one 14.4px line from 88, plus 4px padding).
  expect(end.y).toBeGreaterThanOrEqual(api.y + 76 * scale);
  expect(end.y).toBeLessThanOrEqual(api.y + 106.5 * scale);
});

test('the Icon panel puts the icon left of the text, undoes in one step, and the code says iconpos @gate', async ({ page }) => {
  await generate(page, '%% ofk 1\narchitecture\n\nAPI [icon: tabler/server]', 0);
  const before = await nodeOf(page, 'api');
  const centre = await centreOf(page, 'api');
  await page.mouse.click(centre.x, centre.y);
  await page.getByRole('button', { name: 'Icon', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Icon above' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: 'Icon left' }).click();
  await expect.poll(async () => (await nodeOf(page, 'api')).content.contentLayout).toMatchObject({ iconPlacement: 'left' });
  const row = await nodeOf(page, 'api');
  expect(row.size.width).not.toBe(before.size.width);
  await expect(page.getByRole('radio', { name: 'Icon left' })).toHaveAttribute('aria-checked', 'true');

  await page.getByTestId('v2-canvas').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await nodeOf(page, 'api')).size).toEqual(before.size);
  expect((await nodeOf(page, 'api')).content.contentLayout).toBeUndefined();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await nodeOf(page, 'api')).content.contentLayout).toMatchObject({ iconPlacement: 'left' });

  await page.getByRole('toolbar', { name: 'Workspace', exact: true }).getByRole('button', { name: 'Diagram as code' }).click();
  await expect(page.getByRole('textbox', { name: 'Diagram source' })).toHaveValue(/iconpos: left/);
});
