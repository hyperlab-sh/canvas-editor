export const OPEN_CANVAS_RENDER_WORK_MEASURE = 'canvas:opencanvas-render-work';

/**
 * Phase measures for the camera path.
 *
 * `OPEN_CANVAS_RENDER_WORK_MEASURE` covers only `app.render()`, which on real
 * hardware is under a millisecond even at 1,000 nodes while the frame itself
 * misses budget. These name the work between a camera change and that submit,
 * so the expensive phase is attributable instead of invisible.
 */
const OPEN_CANVAS_CAMERA_PHASE_MEASURES = {
  total: 'canvas:opencanvas-camera-total',
  projection: 'canvas:opencanvas-camera-projection',
  rebuild: 'canvas:opencanvas-camera-rebuild',
  labels: 'canvas:opencanvas-camera-labels',
  connectorOverlay: 'canvas:opencanvas-camera-connector-overlay',
} as const;

type OpenCanvasCameraPhase = keyof typeof OPEN_CANVAS_CAMERA_PHASE_MEASURES;

export function recordOpenCanvasCameraPhase(
  timeline: PerformanceMeasurePort,
  phase: OpenCanvasCameraPhase,
  startedAt: number,
  endedAt: number
): boolean {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) {
    return false;
  }
  try {
    timeline.measure(OPEN_CANVAS_CAMERA_PHASE_MEASURES[phase], {
      start: startedAt,
      end: endedAt,
    });
    return true;
  } catch {
    return false;
  }
}

interface PerformanceMeasurePort {
  measure(name: string, options: { start: number; end: number }): unknown;
}

export function recordOpenCanvasRenderWork(
  timeline: PerformanceMeasurePort,
  startedAt: number,
  endedAt: number
): boolean {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) {
    return false;
  }
  try {
    timeline.measure(OPEN_CANVAS_RENDER_WORK_MEASURE, { start: startedAt, end: endedAt });
    return true;
  } catch {
    return false;
  }
}
