import type { SceneDocumentV1, SceneNode } from '../../domain/document/types';
import type { NodeStyle } from '../../domain/nodes/nodeStyle';
import { resolveArchitectureNodePresentation } from '../../domain/nodes/architectureNodePresentation';
import { architectureIconBounds } from '../../domain/nodes/iconCardLayout';
import { inkMonochromeSvg, monochromeIconInk, svgDataUrl, svgFromDataUrl } from '../../domain/nodes/iconInk';
import { number, xml } from './svgMarkup';

export function iconArtKey(packId: string, shapeId: string): string {
  return `${packId}:${shapeId}`;
}

/**
 * Every provider icon the document draws, loaded once each by the host's `load`
 * (the editor fetches its bundled art, the MCP server reads its data files).
 * An icon whose load fails or returns null exports as its plate alone.
 */
export async function collectIconArt(
  document: SceneDocumentV1,
  load: (packId: string, shapeId: string) => Promise<string | null>,
): Promise<Record<string, string>> {
  const wanted = new Map<string, { packId: string; shapeId: string }>();
  for (const node of document.pages.flatMap((page) => page.nodes)) {
    const icon = resolveArchitectureNodePresentation(node)?.icon;
    if (icon?.kind === 'provider') wanted.set(iconArtKey(icon.packId, icon.shapeId), icon);
  }
  const entries = await Promise.all([...wanted].map(async ([key, { packId, shapeId }]) =>
    [key, await load(packId, shapeId).catch(() => null)] as const));
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry[1] !== null));
}

/**
 * The icons one export draws: each distinct art (after inking) is written once as a `<symbol>` and every
 * node places it with `<use>`, so twenty cards of one TypeScript icon carry its data URL once, not twenty times.
 * Ids come from the art itself: two exports in one DOM name the same art alike, and a re-render never repoints a `<use>`.
 */
export interface IconSheet {
  readonly art: Readonly<Record<string, string>> | undefined;
  readonly ids: Map<string, string>;
}

function iconId(sheet: IconSheet, href: string): string {
  const known = sheet.ids.get(href);
  if (known) return known;
  let hash = 0x811c9dc5;
  for (let index = 0; index < href.length; index += 1) hash = Math.imul(hash ^ href.charCodeAt(index), 0x01000193);
  const base = `ofk-icon-${(hash >>> 0).toString(36)}`;
  const taken = new Set(sheet.ids.values());
  let id = base;
  for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}-${suffix}`;
  sheet.ids.set(href, id);
  return id;
}

/** Every icon symbol the export placed, or ''. Icon boxes are square, so a 1×1 viewBox draws the art exactly as an `<image>` in the box would. */
export function iconDefs(sheet: IconSheet): string {
  if (sheet.ids.size === 0) return '';
  return `<defs>${[...sheet.ids].map(([href, id]) =>
    `<symbol id="${id}" viewBox="0 0 1 1"><image href="${xml(href)}" width="1" height="1" preserveAspectRatio="xMidYMid meet"/></symbol>`).join('')}</defs>`;
}

/** The icon on an architecture node, placed at the canvas's position, or ''. On a dark plate a one-colour dark icon takes the canvas's ink. */
export function iconMarkup(node: SceneNode, sheet: IconSheet, style?: NodeStyle, background?: string): string {
  const presentation = resolveArchitectureNodePresentation(node);
  if (!presentation) return '';
  const { icon } = presentation;
  const art = icon.kind === 'provider' ? sheet.art?.[iconArtKey(icon.packId, icon.shapeId)]
    : icon.kind === 'url' && icon.url.startsWith('data:image/') ? icon.url : undefined;
  if (!art) return '';
  const ink = style && background ? monochromeIconInk(presentation.display, style, background) : null;
  const svg = ink ? svgFromDataUrl(art) : null;
  const inked = svg && ink ? inkMonochromeSvg(svg, ink) : null;
  const href = inked ? svgDataUrl(inked) : art;
  const box = architectureIconBounds(node, presentation.display);
  return `<use href="#${iconId(sheet, href)}" x="${number(box.x)}" y="${number(box.y)}" width="${number(box.width)}" height="${number(box.height)}"/>`;
}
