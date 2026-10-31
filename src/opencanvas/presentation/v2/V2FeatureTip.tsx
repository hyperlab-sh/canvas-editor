import { useEffect, useRef, useState } from 'react';
import { IconX } from '@tabler/icons-react';
import { Button, Icon, IconButton, Kbd, Popover } from '../design-system';
import { V2_TIPS, type V2TipId } from './v2FeatureTips';
import { platformKeys } from './v2Shortcuts';

/** Floating UI a tip must never cover: the selection's context bar, chrome toolbars, panels, menus, dialogs, find and flow bars. */
const FLOATING_UI = '[data-context-bar], .ofk-floating-region .ofk-toolbar, .ofk-panel, .ofk-popover:not([data-passive]), dialog[open], .ofk-v2-find, .ofk-v2-flow';

/** True when the tip's box overlaps any other floating UI on screen. */
export function overlapsFloatingUi(tip: Element): boolean {
  const a = tip.getBoundingClientRect();
  return [...document.querySelectorAll(FLOATING_UI)].some((element) => {
    if (tip.contains(element)) return false;
    const b = element.getBoundingClientRect();
    return b.width > 0 && b.height > 0 && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  });
}

/**
 * True while the card holding `layer` would sit over other floating UI. Floating UI appears, moves and goes by DOM
 * changes (a selection by keyboard, a context bar following a drag): one check per frame at most, only while something changed.
 */
export function useYielding(layer: React.RefObject<HTMLElement | null>, active: boolean): boolean {
  const [yielding, setYielding] = useState(false);
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      const card = layer.current?.closest('.ofk-v2-tip');
      if (card) setYielding(overlapsFloatingUi(card));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(check); };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'open'] });
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      cancelAnimationFrame(frame);
    };
  }, [layer, active]);
  return yielding;
}

/**
 * One hint beside the control it is about. Passive: it never takes focus or a key,
 * and only its buttons catch the pointer, so a gesture under it still reaches the canvas.
 * It yields (hides, keeps its place) while other floating UI — a selection's context bar,
 * a panel, a menu — would sit under it, and comes back when that is gone.
 */
export function V2FeatureTip({ id, onAction, onClose }: {
  readonly id: V2TipId;
  readonly onAction: () => void;
  readonly onClose: () => void;
}): React.JSX.Element | null {
  const tip = V2_TIPS[id];
  const anchor = useRef<HTMLElement | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [found, setFound] = useState(false);
  useEffect(() => {
    anchor.current = document.querySelector<HTMLElement>(tip.anchor);
    setFound(anchor.current !== null);
  }, [tip.anchor]);
  // Escape and any press elsewhere put it away; neither is consumed.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    const onPointer = (event: PointerEvent) => {
      if (!layer.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, [onClose]);
  const yielding = useYielding(layer, found);
  if (!found) return null;
  const keys = tip.keys ? platformKeys(tip.keys) : null;
  return (
    <Popover open passive anchorRef={anchor} onClose={onClose} placement={tip.placement} gap={12}
      className="ofk-v2-tip" data-tip={id} data-yielding={yielding || undefined}
      style={yielding ? { visibility: 'hidden' } : undefined}>
      <div ref={layer} className="ofk-v2-tip-card" aria-live="polite" aria-label="Tip">
        <div className="ofk-v2-tip-head">
          <span className="ofk-v2-tip-glyph" aria-hidden="true"><Icon icon={tip.icon} /></span>
          <strong>{tip.title}</strong>
          <IconButton variant="quiet" label="Dismiss tip" icon={<Icon icon={IconX} />} onClick={onClose} />
        </div>
        <p>{tip.text}</p>
        {/* A tip with nothing to open is only words: its close button is the way out. */}
        {tip.action ? (
          <div className="ofk-v2-tip-actions">
            <Button variant="quiet" onClick={onClose}>Got it</Button>
            <Button variant="secondary" onClick={onAction}>
              {tip.action}
              {keys ? <span aria-hidden="true"><Kbd keys={keys} /></span> : null}
            </Button>
          </div>
        ) : null}
      </div>
    </Popover>
  );
}
