import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconAlertCircle, IconAlertTriangle, IconCircleCheck, IconInfoCircle, IconX } from '@tabler/icons-react';
import { Button, IconButton } from './Button';
import { Icon } from './Icon';
import type { StatusTone } from './Status';
import { foundation } from './tokens';
export interface ToastItem {
  id: string;
  tone?: StatusTone;
  /** Short, sentence case, no closing period: "Link copied". Detail goes in `description`. */
  title: string;
  description?: string;
  /** Undo/retry/open. Host owns the behavior. */
  action?: { label: string; onClick: () => void };
  /** Errors and conflicts persist until dismissed; informational toasts auto-dismiss. */
  persistent?: boolean;
}
/** At most this many on screen; the oldest goes first. */
export const TOAST_LIMIT = 3;
const TONE_ICON: Partial<Record<StatusTone, typeof IconX>> = {
  success: IconCircleCheck, warning: IconAlertTriangle, danger: IconAlertCircle, info: IconInfoCircle,
};

/**
 * The host's push: newest last (nearest the edge), at most TOAST_LIMIT. A twin (same id, or same title with no action on
 * either) is replaced in place of stacking; it moves to the newest slot and its timer starts over. Two toasts that each
 * carry an action both stay: collapsing them would drop an Undo.
 */
export function withToast(current: readonly ToastItem[], toast: ToastItem): ToastItem[] {
  const twin = current.find((item) => item.id === toast.id || (item.title === toast.title && !item.action && !toast.action));
  const rest = current.filter((item) => item !== twin);
  return [...rest, twin ? { ...toast, id: twin.id } : toast].slice(-TOAST_LIMIT);
}

const lingers = (toast: ToastItem) => toast.persistent || toast.tone === 'danger' || toast.tone === 'warning';

/** One toast. Its timer pauses while the pointer is over it or focus is in it, and starts over when the host re-pushes it. */
function Toast({ toast, onDismiss, dismissLabel }: { toast: ToastItem; onDismiss: (id: string) => void; dismissLabel: string }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef<number>(foundation.motion.toastDuration);
  const dismissRef = useRef(onDismiss);
  useEffect(() => { dismissRef.current = onDismiss; }, [onDismiss]);
  // A re-pushed twin is a new object: a full duration again.
  useEffect(() => { remaining.current = foundation.motion.toastDuration; }, [toast]);
  useEffect(() => {
    if (lingers(toast) || hovered || focused) return;
    const started = Date.now();
    const timer = window.setTimeout(() => dismissRef.current(toast.id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [toast, hovered, focused]);
  const mark = toast.tone ? TONE_ICON[toast.tone] : undefined;
  return (
    <div
      className="ofk-toast ofk-overlay"
      data-tone={toast.tone ?? 'neutral'}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}
    >
      {/* The tone is the icon's colour; a neutral note is just words. */}
      {mark ? <span className="ofk-toast-mark" aria-hidden="true"><Icon icon={mark} /></span> : null}
      <div className="ofk-toast-text">
        <strong>{toast.title}</strong>
        {toast.description && <p>{toast.description}</p>}
      </div>
      {toast.action && (
        <Button variant="secondary" onClick={toast.action.onClick}>
          {toast.action.label}
        </Button>
      )}
      <IconButton variant="quiet" label={dismissLabel} icon={<Icon icon={IconX} />} onClick={() => onDismiss(toast.id)} />
    </div>
  );
}

/** One live region for transient outcomes (saved, failed, conflict). Never for streaming progress. */
export function ToastRegion({
  items,
  onDismiss,
  dismissLabel = 'Dismiss',
  children,
}: {
  items: readonly ToastItem[];
  onDismiss: (id: string) => void;
  dismissLabel?: string;
  children?: ReactNode;
}) {
  return (
    <div className="ofk-toasts" role="region" aria-label="Notifications">
      <div role="status" aria-live="polite" aria-atomic="false">
        {items.map((t) => <Toast key={t.id} toast={t} onDismiss={onDismiss} dismissLabel={dismissLabel} />)}
      </div>
      {children}
    </div>
  );
}
