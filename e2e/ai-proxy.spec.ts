// The Custom provider through a self-hosted server's AI proxy (/ai-proxy, same origin): the dev server forwards it to the
// stub as nginx/ai-proxy.sh does in the Docker image (playwright.config sets OPENFLOWKIT_AI_UPSTREAM). No CORS involved,
// the reply streams, the browser's Origin stays behind, and a proxy that cannot answer says so.
import { expect, test, type Page } from './test';

async function openDialog(page: Page) {
  await page.goto('/');
  await page.getByRole('toolbar', { name: 'Workspace', exact: true }).getByRole('button', { name: 'AI assistant', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'AI assistant' });
  await panel.getByRole('button', { name: 'Connect an AI provider' }).click();
  const dialog = page.getByRole('dialog', { name: 'AI provider' });
  await dialog.getByRole('button', { name: 'Use Custom' }).click();
  return { panel, dialog };
}

test('Custom reaches a local model through the server\'s AI proxy: model list, test and a streamed reply @gate', async ({ page }) => {
  const { panel, dialog } = await openDialog(page);
  await dialog.getByLabel('API key').fill('sk-stream');
  await dialog.getByLabel('Base URL').fill('/ai-proxy');
  // The key goes through this server: the dialog says so where the endpoint is set.
  await expect(dialog.getByText(/Through this server’s AI proxy: your key passes through the server/)).toBeVisible();
  const models = page.waitForResponse((response) => response.url().endsWith('/ai-proxy/models'));
  await dialog.getByLabel('Model').focus();
  expect((await models).status()).toBe(200);
  await dialog.getByLabel('Model').fill('stub-chat');
  await dialog.getByRole('button', { name: 'Test key' }).click();
  await expect(dialog.getByRole('status')).toContainText('Connected');
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();

  const composer = panel.getByRole('textbox', { name: 'Ask AI assistant' });
  await composer.fill('hi');
  await composer.press('Enter');
  // The first piece shows while the stub holds the rest: the proxy streams, it does not buffer the reply.
  await expect(panel.getByText('Streaming through the proxy', { exact: false })).toBeVisible();
  await expect(panel.getByText('the browser origin.', { exact: false })).toHaveCount(0);
  await expect(panel.getByText('Streaming through the proxy without the browser origin.')).toBeVisible();
});

test('a proxy whose model server is down says so, without the key @gate', async ({ page }) => {
  const { dialog } = await openDialog(page);
  await dialog.getByLabel('API key').fill('sk-down');
  await dialog.getByLabel('Base URL').fill('/ai-proxy');
  await dialog.getByLabel('Model').fill('stub-chat');
  await dialog.getByRole('button', { name: 'Test key' }).click();
  await expect(dialog.getByRole('status')).toContainText("This server's AI proxy answered 503");
  await expect(dialog.getByRole('status')).not.toContainText('sk-down');
});
