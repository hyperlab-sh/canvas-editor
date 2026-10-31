import { afterEach, expect, it } from 'vitest';
import { overlapsFloatingUi } from './V2FeatureTip';

/** jsdom has no layout: each element gets the box it would have on screen. */
function place(element: HTMLElement, left: number, top: number, width: number, height: number): HTMLElement {
  element.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });
  return element;
}
function add(html: string, box: [number, number, number, number]): HTMLElement {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  const element = holder.firstElementChild as HTMLElement;
  document.body.append(element);
  return place(element, ...box);
}

afterEach(() => { document.body.innerHTML = ''; });

it('a tip overlapping the selection’s context bar yields; one beside it does not', () => {
  const tip = add('<div class="ofk-popover ofk-v2-tip" data-passive="true"></div>', [900, 170, 300, 150]);
  const bar = add('<div data-context-bar></div>', [600, 330, 560, 48]);
  expect(overlapsFloatingUi(tip)).toBe(false);
  place(bar, 600, 200, 560, 48);
  expect(overlapsFloatingUi(tip)).toBe(true);
});

it('counts panels, menus and dialogs, but not itself, a tooltip or anything hidden (no box)', () => {
  const tip = add('<div class="ofk-popover ofk-v2-tip" data-passive="true"><div class="ofk-popover"></div></div>', [900, 170, 300, 150]);
  place(tip.firstElementChild as HTMLElement, 900, 170, 300, 150);
  add('<div class="ofk-popover ofk-tooltip" data-passive="true"></div>', [950, 200, 80, 24]);
  const panel = add('<aside class="ofk-panel"></aside>', [0, 0, 0, 0]);
  expect(overlapsFloatingUi(tip)).toBe(false);
  place(panel, 960, 72, 320, 600);
  expect(overlapsFloatingUi(tip)).toBe(true);
  panel.remove();
  add('<div class="ofk-popover" role="menu"></div>', [1000, 300, 200, 200]);
  expect(overlapsFloatingUi(tip)).toBe(true);
});
