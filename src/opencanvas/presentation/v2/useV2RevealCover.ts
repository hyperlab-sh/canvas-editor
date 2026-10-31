import { useEffect, useState } from 'react';
import type { ScenePage } from '../../domain/document/types';
import type { PixiRendererStatus } from '../../infrastructure/pixi/PixiRendererHost';
import type { useV2MapMode } from './map/useV2MapMode';
import type { useV2DocumentLoad } from './useV2DocumentLoad';
import type { useV2RepoDocument } from './useV2RepoDocument';
import type { V2StartIntent } from './v2Document';

/** The longest the loader covers an editor that is still getting ready; then it shows what it has. */
const REVEAL_LIMIT_MS = 4000;
/** The loader's fade into the finished editor (index.css, `.ofk-loader[data-leaving]`). */
const COVER_FADE_MS = 200;

interface RevealCoverInput {
  readonly load: ReturnType<typeof useV2DocumentLoad>;
  readonly page: ScenePage | null;
  readonly rendererStatus: PixiRendererStatus;
  readonly startIntent: V2StartIntent | null;
  readonly generating: boolean;
  readonly map: ReturnType<typeof useV2MapMode>;
  readonly repoSource: ReturnType<typeof useV2RepoDocument>['source'];
  readonly repoStatus: ReturnType<typeof useV2RepoDocument>['state']['status'];
}

/** The one-reveal gate: 'on' (loader covers) → 'leaving' (fading) → 'gone'. */
export function useV2RevealCover({ load, page, rendererStatus, startIntent, generating, map, repoSource, repoStatus }: RevealCoverInput): 'on' | 'leaving' | 'gone' {
  // One reveal: the editor mounts under the loader (so the renderer starts and the chrome is measured) and shows once
  // it can be seen whole: the renderer up (or known unavailable), the type loaded, a template drawn, a map on screen or
  // its reading status. Never again after that; a slow GPU or font gets REVEAL_LIMIT_MS, then whatever is ready.
  const [fontsReady, setFontsReady] = useState(() => typeof document === 'undefined' || !document.fonts);
  useEffect(() => {
    let live = true;
    void document.fonts?.load('500 14px Inter').catch(() => undefined).then(() => { if (live) setFontsReady(true); });
    return () => { live = false; };
  }, []);
  const mapOnScreen = !map.active || map.start || map.error !== null || map.empty || (map.mapPage?.nodes.length ?? 0) > 0
    || (repoSource !== null && repoStatus !== 'ready');
  // Opened to draw something (a template, an import): the reveal waits for it on the canvas, not only for the work to end.
  const [opensDrawn] = useState(() => !!startIntent && ('template' in startIntent || 'source' in startIntent));
  const whole = load.phase === 'ready' && page !== null && rendererStatus !== 'initializing' && fontsReady
    && !startIntent && !generating && mapOnScreen && !(opensDrawn && page.nodes.length === 0);
  const [cover, setCover] = useState<'on' | 'leaving' | 'gone'>('on');
  if (cover === 'on' && whole) setCover('leaving');
  useEffect(() => {
    if (cover === 'gone' || load.phase !== 'ready') return;
    const timer = setTimeout(() => setCover(cover === 'on' ? 'leaving' : 'gone'), cover === 'on' ? REVEAL_LIMIT_MS : COVER_FADE_MS);
    return () => clearTimeout(timer);
  }, [cover, load.phase]);
  return cover;
}
