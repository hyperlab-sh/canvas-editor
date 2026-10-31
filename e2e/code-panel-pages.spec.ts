// The code panel follows the page on screen, and ⌘V takes any diagram text the panel can draw.
import { doc, openCanvas } from './helpers';
import { expect, test, type Page } from './test';

const WORKSPACE = 'architecture\nmodel {\n  person Alice\n  system Shop { container Web }\n  Alice -> Shop\n}\nviews {\n  view landscape\n}\n';

const paste = (page: Page, text: string) => page.evaluate((value) => {
  const data = new DataTransfer();
  data.setData('text/plain', value);
  document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}, text);

test('Generate never rewrites a page the panel was not opened on @gate', async ({ page }) => {
  await openCanvas(page);
  await page.getByRole('toolbar', { name: 'Workspace', exact: true }).getByRole('button', { name: 'Diagram as code' }).click();
  const source = page.getByRole('textbox', { name: 'Diagram source' });
  await source.fill('%% ofk 1\nflowchart\nOne -> Two');
  await source.press('ControlOrMeta+Enter');
  await expect.poll(async () => (await doc(page))!.pages[0]!.nodes.length).toBeGreaterThan(2);
  const firstPage = (await doc(page))!.pages[0]!;

  await page.getByRole('button', { name: /^Pages/ }).click();
  await page.getByRole('button', { name: 'Add page' }).click();
  await expect.poll(async () => (await doc(page))!.pages.length).toBe(2);
  // The new page is empty: the panel no longer shows the other page's source.
  await expect(source).not.toHaveValue(/One -> Two/);

  await source.fill(WORKSPACE);
  await source.press('ControlOrMeta+Enter');
  await expect.poll(async () => (await doc(page))!.pages[1]!.nodes.length).toBeGreaterThan(0);
  const pages = (await doc(page))!.pages;
  expect(pages[0]).toEqual(firstPage);
});

test('⌘V of D2, Structurizr or DSL opens the code panel and draws; plain text says why not', async ({ page }) => {
  await openCanvas(page);
  await paste(page, 'flowchart\nPay -> Ship');
  await expect(page.getByRole('textbox', { name: 'Diagram source' })).toBeVisible();
  await expect.poll(async () => (await doc(page))!.pages[0]!.nodes.length).toBeGreaterThan(2);
  await paste(page, 'Remember to add the fraud check');
  await expect(page.getByText(/isn’t a diagram/)).toBeVisible();
});
