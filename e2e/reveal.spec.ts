import { expect, test } from './test';

// One reveal: the editor gets ready under the loader and shows whole. Every animation frame records whether the loader
// still covers the editor and whether the empty canvas's welcome and the document bar are there: the frame the cover
// starts to leave must already have them (no blank canvas filling in after the loader is gone).
// npx playwright test e2e/reveal.spec.ts

test('a new canvas appears whole when the loader leaves, never piece by piece @gate', async ({ page }) => {
  await page.addInitScript(() => {
    const frames: { covered: boolean; welcome: boolean; bar: boolean }[] = [];
    (window as unknown as { __frames: typeof frames }).__frames = frames;
    const tick = () => {
      const cover = document.querySelector('.ofk-loader[data-cover]');
      frames.push({
        covered: !!cover && !cover.hasAttribute('data-leaving'),
        welcome: !!document.querySelector('[data-testid="v2-welcome"]'),
        bar: !!document.querySelector('[role="toolbar"][aria-label="Document"]'),
      });
      if (frames.length < 1200) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // A slower CPU stretches every wait, so a gap would show in more than one frame.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto('/');
  await expect(page.getByTestId('v2-welcome')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.ofk-loader[data-cover]')).toHaveCount(0);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const frames = await page.evaluate(() => (window as unknown as { __frames: { covered: boolean; welcome: boolean; bar: boolean }[] }).__frames);
  // Once the editor is mounted, every uncovered frame shows the finished screen.
  const uncovered = frames.filter((frame) => frame.bar && !frame.covered);
  expect(uncovered.length).toBeGreaterThan(0);
  expect(uncovered.filter((frame) => !frame.welcome)).toEqual([]);
});
