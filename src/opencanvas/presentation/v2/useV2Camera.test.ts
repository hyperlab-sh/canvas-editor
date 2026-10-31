import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PixiRendererHost } from '../../infrastructure/pixi/PixiRendererHost';
import { worldToScreen } from '../../domain/camera/camera';
import type { SceneDocumentV1 } from '../../domain/document/types';
import { useV2Camera } from './useV2Camera';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

it('centres an off-origin element at capped zoom inside the canvas left by panels', () => {
  document.body.innerHTML =
    '<div class="ofk-v2" data-workspace-open="true" style="--v2-panel-width:320px"></div>';
  vi.stubGlobal('innerWidth', 1440);
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const bounds = { x: 1600, y: 1100, width: 180, height: 100 };
  const host = {
    getContentBounds: () => bounds,
    getViewportSize: () => ({ width: 1440, height: 900 }),
    setCamera: vi.fn(),
  } as unknown as PixiRendererHost;
  const { result } = renderHook(() => useV2Camera({ current: host }));
  act(() => result.current.glideToNodes(['api']));
  const camera = result.current.cameraRef.current;
  expect(camera.zoom).toBe(1.4);
  expect(
    worldToScreen(camera, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })
  ).toEqual({ x: 560, y: 450 });
});

it('a landing asked for before the renderer has a size waits for it instead of fitting nothing', () => {
  vi.stubGlobal('innerWidth', 1440);
  let size = { width: 0, height: 0 };
  const host = {
    getContentBounds: () => ({ x: 160, y: 80, width: 814, height: 572 }),
    getViewportSize: () => size,
    setCamera: vi.fn(),
  } as unknown as PixiRendererHost;
  const { result } = renderHook(() => useV2Camera({ current: host }));
  // A template generates while WebGL is still starting: a 0×0 viewport fits to the floor zoom, jammed at the top.
  act(() => { result.current.landReadable('down', ['frame']); });
  expect(host.setCamera).not.toHaveBeenCalled();
  size = { width: 1440, height: 900 };
  act(() => result.current.fitOnOpen('ready', null, 'doc', 1, 'down'));
  const camera = result.current.cameraRef.current;
  expect(camera.zoom).toBeGreaterThan(1);
  // Centred, not pinned to the top-left padding.
  expect(160 * camera.zoom + camera.y).toBeGreaterThan(64);
});

function deferredHost() {
  const view = { size: { width: 0, height: 0 } };
  const host = {
    getContentBounds: () => ({ x: 160, y: 80, width: 814, height: 572 }),
    getViewportSize: () => view.size,
    setCamera: vi.fn(),
  } as unknown as PixiRendererHost;
  return { host, view };
}

it('a waiting landing runs on the ready transition only, never on a later edit', () => {
  vi.stubGlobal('innerWidth', 1440);
  const { host, view } = deferredHost();
  const { result } = renderHook(() => useV2Camera({ current: host }));
  act(() => result.current.fitOnOpen('ready', null, 'doc', 1, 'down'));
  act(() => { result.current.landReadable('down', ['frame']); });
  view.size = { width: 1440, height: 900 };
  // Already ready: the next fitOnOpen is an edit (revision 2), and must not yank the camera.
  act(() => result.current.fitOnOpen('ready', null, 'doc', 2, 'down'));
  expect(host.setCamera).not.toHaveBeenCalled();
});

it('a waiting landing is dropped by the reader\'s own camera move and by a document switch', () => {
  vi.stubGlobal('innerWidth', 1440);
  const moved = deferredHost();
  const first = renderHook(() => useV2Camera({ current: moved.host }));
  act(() => { first.result.current.landReadable('down'); });
  act(() => first.result.current.updateCamera({ x: 5, y: 5, zoom: 0.8 }));
  moved.view.size = { width: 1440, height: 900 };
  act(() => first.result.current.fitOnOpen('ready', null, 'doc', 1, 'down'));
  expect(first.result.current.cameraRef.current).toEqual({ x: 5, y: 5, zoom: 0.8 });

  const switched = deferredHost();
  const second = renderHook(() => useV2Camera({ current: switched.host }));
  act(() => second.result.current.fitOnOpen('initializing', null, 'doc-a', 1, 'down'));
  act(() => { second.result.current.landReadable('down'); });
  act(() => second.result.current.fitOnOpen('initializing', null, 'doc-b', 1, 'down'));
  switched.view.size = { width: 1440, height: 900 };
  act(() => second.result.current.fitOnOpen('ready', null, 'doc-b', 1, 'down'));
  expect(switched.host.setCamera).not.toHaveBeenCalled();
});

it('ready with the viewport still 0×0 retries on the next frames until it has a size', () => {
  vi.stubGlobal('innerWidth', 1440);
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  const { host, view } = deferredHost();
  const { result } = renderHook(() => useV2Camera({ current: host }));
  act(() => { result.current.landReadable('down', ['frame']); });
  act(() => result.current.fitOnOpen('ready', null, 'doc', 1, 'down'));
  expect(host.setCamera).not.toHaveBeenCalled();
  view.size = { width: 1440, height: 900 };
  act(() => { frames.splice(0).forEach((callback) => callback(0)); });
  expect(result.current.cameraRef.current.zoom).toBeGreaterThan(1);
});

it('an agent edit off screen lands readable, not at a fit too small to draw labels; one in view stays put', () => {
  vi.stubGlobal('innerWidth', 1440);
  // A wide architecture diagram well right of the view: fitted, it sits near 40%.
  const wide = { x: 2400, y: 0, width: 3200, height: 500 };
  const host = { getContentBounds: () => wide, getViewportSize: () => ({ width: 1440, height: 900 }), setCamera: vi.fn() } as unknown as PixiRendererHost;
  const fitted = renderHook(() => useV2Camera({ current: host }));
  act(() => fitted.result.current.revealBounds(wide));
  const landed = renderHook(() => useV2Camera({ current: host }));
  act(() => { landed.result.current.revealReadable('right', ['frame']); });
  expect(fitted.result.current.cameraRef.current.zoom).toBeLessThan(0.5);
  expect(landed.result.current.cameraRef.current.zoom).toBeGreaterThan(fitted.result.current.cameraRef.current.zoom);
  const near = { x: 100, y: 100, width: 200, height: 100 };
  const still = renderHook(() => useV2Camera({ current: { ...host, getContentBounds: () => near } as unknown as PixiRendererHost }));
  const before = still.result.current.cameraRef.current;
  act(() => { still.result.current.revealReadable('right', ['box']); });
  expect(still.result.current.cameraRef.current).toEqual(before);
});

it('fit lands in the canvas the floating chrome leaves, never under a rail or the bars (U4-06, U1-09)', () => {
  vi.stubGlobal('innerWidth', 1440);
  document.body.innerHTML = '<div class="ofk-v2">' + ['Create', 'Workspace', 'Document', 'View']
    .map((label) => `<div role="toolbar" aria-label="${label}"></div>`).join('') + '</div>';
  const rects: Record<string, DOMRect> = {
    Create: new DOMRect(8, 80, 60, 400), Workspace: new DOMRect(1372, 80, 52, 300),
    Document: new DOMRect(8, 8, 600, 60), View: new DOMRect(8, 832, 400, 60),
  };
  for (const element of document.querySelectorAll<HTMLElement>('[role="toolbar"]')) {
    element.getBoundingClientRect = () => rects[element.getAttribute('aria-label')!]!;
  }
  const bounds = { x: 0, y: 0, width: 1000, height: 1000 };
  const host = { getContentBounds: () => bounds, getViewportSize: () => ({ width: 1440, height: 900 }), setCamera: vi.fn() } as unknown as PixiRendererHost;
  const { result } = renderHook(() => useV2Camera({ current: host }));
  act(() => result.current.fitView());
  const camera = result.current.cameraRef.current;
  const topLeft = worldToScreen(camera, { x: 0, y: 0 });
  const bottomRight = worldToScreen(camera, { x: 1000, y: 1000 });
  expect(topLeft.x).toBeGreaterThan(68);
  expect(topLeft.y).toBeGreaterThan(68);
  expect(bottomRight.x).toBeLessThan(1372);
  expect(bottomRight.y).toBeLessThan(832);
  // Centred in the free box, not the raw viewport.
  expect((topLeft.y + bottomRight.y) / 2).toBeCloseTo((68 + 832) / 2, 0);
});

// Found 2026-10-11: an agent edit landed at 65% or stayed at 100%: one frame later the host often had no bounds yet.
it('an agent edit the host has not drawn yet is revealed once its bounds exist', () => {
  vi.stubGlobal('innerWidth', 1440);
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  const wide = { x: 2400, y: 0, width: 3200, height: 500 };
  let drawn = false;
  const host = { getContentBounds: () => (drawn ? wide : null), getViewportSize: () => ({ width: 1440, height: 900 }), setCamera: vi.fn() } as unknown as PixiRendererHost;
  const { result } = renderHook(() => useV2Camera({ current: host }));
  const zoomed = vi.fn();
  act(() => result.current.revealWhenDrawn('right', ['frame'], zoomed));
  act(() => { frames.splice(0).forEach((callback) => callback(0)); });
  expect(host.setCamera).not.toHaveBeenCalled();
  drawn = true;
  act(() => { frames.splice(0).forEach((callback) => callback(0)); });
  expect(host.setCamera).toHaveBeenCalled();
  expect(zoomed).toHaveBeenCalledOnce();
});

it('a document that opens in Map leaves the first camera to Map: no open landing on the map scene, nor later on Canvas', () => {
  vi.stubGlobal('innerWidth', 1440);
  // While Map is up the host draws the map, so its bounds are the map's: a document whose page is still empty has them too.
  const host = {
    getContentBounds: () => ({ x: 20, y: 20, width: 1620, height: 881 }),
    getViewportSize: () => ({ width: 1440, height: 900 }),
    setCamera: vi.fn(),
  } as unknown as PixiRendererHost;
  const { result } = renderHook(() => useV2Camera({ current: host }));
  const doc = { pages: [] } as unknown as SceneDocumentV1;
  act(() => result.current.fitOnOpen('ready', doc, 'map-doc', 0, 'down', true));
  expect(host.setCamera).not.toHaveBeenCalled();
  // Leaving Map fits Canvas itself (useV2MapMode): the open landing does not run a second time.
  act(() => result.current.fitOnOpen('ready', doc, 'map-doc', 0, 'down', false));
  expect(host.setCamera).not.toHaveBeenCalled();
  // Another document opened on Canvas still lands.
  act(() => result.current.fitOnOpen('ready', doc, 'other-doc', 0, 'down', false));
  expect(host.setCamera).toHaveBeenCalled();
});

it('a Layers row off screen glides to the middle at the same zoom; one in view leaves the camera alone', () => {
  vi.stubGlobal('innerWidth', 1440);
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  let bounds = { x: 5000, y: 3000, width: 160, height: 72 };
  const host = { getContentBounds: () => bounds, getViewportSize: () => ({ width: 1440, height: 900 }), setCamera: vi.fn() } as unknown as PixiRendererHost;
  const { result } = renderHook(() => useV2Camera({ current: host }));
  const zoom = result.current.cameraRef.current.zoom;
  act(() => result.current.revealNodes(['far']));
  const camera = result.current.cameraRef.current;
  expect(camera.zoom).toBe(zoom);
  const centre = worldToScreen(camera, { x: bounds.x + 80, y: bounds.y + 36 });
  expect(centre.x).toBeGreaterThan(0);
  expect(centre.x).toBeLessThan(1440);
  expect(centre.y).toBeGreaterThan(0);
  expect(centre.y).toBeLessThan(900);
  bounds = { x: bounds.x + 10, y: bounds.y + 10, width: 160, height: 72 };
  act(() => result.current.revealNodes(['near']));
  expect(result.current.cameraRef.current).toEqual(camera);
});
