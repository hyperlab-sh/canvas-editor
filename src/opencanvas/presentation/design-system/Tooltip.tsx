import { cloneElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Popover } from './Popover';
import { foundation } from './tokens';
// Shared across tooltips: sweeping a toolbar should not pay the delay per button.
let lastHiddenAt = -Infinity;
// One tip on screen: a tip left open by focus (returned after a popover closes) gives way to the next one.
let shown: { hide(): void } | null = null;
/** Supplemental text only; never the sole label. Hover/focus after a delay, long-press on touch, Escape hides. */
export function Tooltip({
  content,
  children,
  shortcut,
}: {
  content: ReactNode;
  shortcut?: string;
  children: ReactElement<{ 'aria-describedby'?: string; title?: string }>;
}) {
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  // A tip on a vertical rail opens beside it, away from the screen edge, so it never covers the next tool.
  const [placement, setPlacement] = useState<'bottom-start' | 'left' | 'right'>('bottom-start');
  const openRef = useRef(false);
  // One object for the tooltip's life: the one-on-screen slot (`shown`) holds it.
  const [self] = useState(() => {
    const me = {
      hide() {
        window.clearTimeout(timer.current);
        if (openRef.current) lastHiddenAt = performance.now();
        openRef.current = false;
        if (shown === me) shown = null;
        setOpen(false);
      },
    };
    return me;
  });
  const { hide } = self;
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    if (shown === self) shown = null;
  }, [self]);
  function schedule(delay: number) {
    window.clearTimeout(timer.current);
    if (shown && shown !== self) shown.hide();
    const warm = performance.now() - lastHiddenAt < foundation.motion.tooltipWarm;
    timer.current = window.setTimeout(() => {
      const rail = anchorRef.current?.closest('[role="toolbar"][aria-orientation="vertical"]')?.getBoundingClientRect();
      setPlacement(rail ? (rail.left + rail.right < window.innerWidth ? 'right' : 'left') : 'bottom-start');
      // Another tip's timer may have fired in the meantime: one tip on screen, the latest.
      if (shown && shown !== self) shown.hide();
      openRef.current = true;
      shown = self;
      setOpen(true);
    }, warm ? 0 : delay);
  }
  const described = children.props['aria-describedby'];
  // The native title would show a second, late tooltip; this one owns the hint.
  const trigger = cloneElement(children, {
    title: undefined,
    ...(open ? { 'aria-describedby': [described, id].filter(Boolean).join(' ') } : {}),
  });
  return (
    <>
      <span
        ref={anchorRef}
        className="ofk-tooltip-anchor"
        onPointerEnter={(e) =>
          e.pointerType !== 'touch' && schedule(foundation.motion.tooltipDelay)
        }
        onPointerLeave={hide}
        onPointerDown={(e) =>
          e.pointerType === 'touch' ? schedule(foundation.motion.tooltipDelay) : hide()
        }
        onPointerUp={(e) => e.pointerType === 'touch' && window.clearTimeout(timer.current)}
        onPointerCancel={hide}
        onFocus={(e) => e.target.matches(':focus-visible') && schedule(0)}
        onBlur={hide}
      >
        {trigger}
      </span>
      <Popover
        open={open}
        anchorRef={anchorRef}
        onClose={hide}
        passive
        placement={placement}
        gap={placement === 'bottom-start' ? undefined : foundation.space.sm}
        id={id}
        role="tooltip"
        className="ofk-tooltip"
      >
        {content}
        {shortcut && <kbd className="ofk-kbd">{shortcut}</kbd>}
      </Popover>
    </>
  );
}
