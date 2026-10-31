import type { HTMLAttributes, ReactNode } from 'react';
import { IconX } from '@tabler/icons-react';
import { IconButton } from './Button';
import { Icon } from './Icon';
import { PopoverAvoid } from './Popover';
import { Toolbar } from './Toolbar';
/** Floating bar near the selection: groups separated by hairlines; each control opens its own popover. */
export function ContextBar({
  label,
  children,
  className = '',
  selection = null,
  ...props
}: HTMLAttributes<HTMLDivElement> & { label: string; /** The selection's screen bounds: popovers off this bar keep clear of them. */ selection?: DOMRect | null }) {
  const bounds = selection && { x: selection.x, y: selection.y, width: selection.width, height: selection.height };
  return (
    <PopoverAvoid.Provider value={bounds}>
      <Toolbar {...props} label={label} className={`ofk-context ofk-floating ofk-enter ${className}`}>
        {children}
      </Toolbar>
    </PopoverAvoid.Provider>
  );
}
export function ContextGroup({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="ofk-context-group" role="group" aria-label={label}>
      {children}
    </div>
  );
}
/** The one panel/popover header: a 14px title and a 32px close button (Panel draws the same row). */
export function PopoverHeader({ title, onClose, closeLabel = 'Close panel' }: { title: string; onClose: () => void; closeLabel?: string }) {
  return (
    <header className="ofk-popover-header">
      <span className="ofk-popover-title">{title}</span>
      <IconButton variant="quiet" label={closeLabel} icon={<Icon icon={IconX} />} onClick={onClose} />
    </header>
  );
}
