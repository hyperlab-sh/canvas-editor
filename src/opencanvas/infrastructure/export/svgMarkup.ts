import type { Matrix2d, Point2d, Size2d } from '../../domain/geometry/types';
import { PULSE_DASH, PULSE_TRAVEL } from '../../domain/animation/frame';
import type { ElementFrameState } from '../../domain/animation/types';

// Dark matches the app's dark canvas (tokens.ts darkColors.canvas), so an export looks like the screen.
export const SVG_BACKGROUND = { light: '#ffffff', dark: '#191b19' } as const;

/** One CSS animation on an exported element; the keyframes live in `<style>`. */
export interface CssAnimation {
  readonly name: string;
  readonly durationMs: number;
  readonly delayMs: number;
  /** `both` holds the final keyframe; `backwards` reverts to the base look. */
  readonly fill?: 'both' | 'backwards' | 'none';
  readonly timing?: string;
  readonly iterationCount?: number | 'infinite';
}

export interface ElementAnimations {
  readonly group?: CssAnimation;
  /** Connector draw-on (a unit dash on `pathLength="1"`) or pulse's travelling dash (pixels). */
  readonly path?: CssAnimation & { readonly dash: string; readonly unitLength?: boolean };
}

export const ANIMATED_CLASS = 'ofk-anim';

export function number(value: number): string {
  return Number(value.toFixed(3)).toString();
}

// Characters XML 1.0 forbids outright (control characters such as PowerPoint's soft break \u000B,
// lone surrogates, U+FFFE/U+FFFF): one in a label would make the whole file unreadable.
// eslint-disable-next-line no-control-regex -- matching them is the point
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function xml(value: unknown): string {
  return String(value ?? '').replace(XML_ILLEGAL, '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]!);
}

export function safeColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^(?:#[0-9a-f]{3,8}|[a-z]{3,20})$/i.test(value)
    ? value : fallback;
}

/** `fill` (+ `fill-opacity` for an rgba wash): SVG consumers differ on rgba() attribute values. */
export function fillAttributes(value: unknown, fallback: string): string {
  const wash = typeof value === 'string' ? value.match(/^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/) : null;
  if (!wash) return `fill="${safeColor(value, fallback)}"`;
  const hex = [wash[1], wash[2], wash[3]].map((part) => Number(part).toString(16).padStart(2, '0')).join('');
  return `fill="#${hex}" fill-opacity="${number(Number(wash[4]))}"`;
}

export function matrixAttribute(matrix: Matrix2d): string {
  return `matrix(${number(matrix.a)} ${number(matrix.b)} ${number(matrix.c)} ${number(matrix.d)} ${number(matrix.tx)} ${number(matrix.ty)})`;
}

/**
 * The same matrix as a CSS `transform` value. One formatter for the still and
 * the animated keyframes: identical strings, identical rendering.
 */
export function matrixCss(matrix: Matrix2d): string {
  return `matrix(${number(matrix.a)}, ${number(matrix.b)}, ${number(matrix.c)}, ${number(matrix.d)}, ${number(matrix.tx)}, ${number(matrix.ty)})`;
}

export function cssAnimation(animation: CssAnimation): string {
  const iteration = animation.iterationCount === undefined ? '1' : String(animation.iterationCount);
  return `animation:${animation.name} ${number(animation.durationMs)}ms ${animation.timing ?? 'linear'} ${number(animation.delayMs)}ms ${iteration} ${animation.fill ?? 'both'}`;
}

/**
 * Scale about a point, as a CSS transform list. The wrapper sits inside the
 * node's group, so the point is node-local — no reference box, no origin
 * property, and the node's stroke is never clipped by a layer.
 */
export function scaleAbout(center: Point2d, scale: number): string {
  return `translate(${number(center.x)}px,${number(center.y)}px) scale(${number(scale)}) translate(${number(-center.x)}px,${number(-center.y)}px)`;
}

/**
 * The visible state of one element at a paused frame, as CSS on a wrapper
 * group. The animated export animates the same properties on the same group,
 * so a still and the animated SVG paused at the same time cannot drift.
 */
export function elementFrameStyle(
  kind: 'node' | 'connector',
  id: string,
  state: ElementFrameState | undefined,
  size: Size2d | undefined,
  animations: ((kind: 'node' | 'connector', id: string) => ElementAnimations | undefined) | undefined
): { readonly className: string; readonly style: string } | null {
  const animation = animations?.(kind, id)?.group;
  const declarations: string[] = [];
  if (animation) declarations.push(cssAnimation(animation));
  if (state && state.opacity < 1) declarations.push(`opacity:${number(state.opacity)}`);
  if (kind === 'node' && (animation || (state && state.scale !== 1))) {
    declarations.push('transform-origin:0 0');
  }
  if (kind === 'node' && state && state.scale !== 1 && size) {
    declarations.push(`transform:${scaleAbout({ x: size.width / 2, y: size.height / 2 }, state.scale)}`);
  }
  if (declarations.length === 0) return null;
  return {
    className: animation ? ` class="${ANIMATED_CLASS}"` : '',
    style: ` style="${declarations.join(';')}"`,
  };
}

/** Dash state a paused frame needs on the connector path, if any. */
export function connectorPathDash(state: ElementFrameState | undefined): string {
  if (!state) return '';
  if (state.pulsePhase !== undefined) {
    return ` stroke-dasharray="${PULSE_DASH.join(' ')}" stroke-dashoffset="${number(-state.pulsePhase * PULSE_TRAVEL)}"`;
  }
  if (state.drawProgress < 1) {
    return ` pathLength="1" stroke-dasharray="1" stroke-dashoffset="${number(1 - state.drawProgress)}"`;
  }
  return '';
}

export function pathData(points: readonly Point2d[]): string {
  return points.map((point, index) => `${index ? 'L' : 'M'}${number(point.x)} ${number(point.y)}`).join(' ') + ' Z';
}

export function openPathData(points: readonly Point2d[]): string {
  return points
    .map((point, index) => `${index ? 'L' : 'M'}${number(point.x)} ${number(point.y)}`)
    .join(' ');
}

/** Node group with the paused-frame wrapper inside it, so CSS animates the art
 *  while the world transform stays a plain attribute. */
export function nodeGroup(attributes: string, body: string, frame: { readonly className: string; readonly style: string } | null): string {
  return frame
    ? `<g ${attributes}><g${frame.className}${frame.style}>${body}</g></g>`
    : `<g ${attributes}>${body}</g>`;
}

export function textElement(
  value: string,
  x: number,
  y: number,
  attributes: string,
  lineHeight: number
): string {
  const lines = value.split(/\r?\n/).slice(0, 32);
  const spans = lines.map((line, index) => (
    `<tspan x="${number(x)}" dy="${index === 0 ? 0 : number(lineHeight)}">${xml(line)}</tspan>`
  )).join('');
  return `<text x="${number(x)}" y="${number(y)}" ${attributes}>${spans}</text>`;
}
