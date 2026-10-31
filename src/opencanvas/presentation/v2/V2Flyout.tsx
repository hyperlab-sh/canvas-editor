import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, IconButton, Popover, Tooltip } from '../design-system';
import type { ToolOption, ToolSection } from './v2ToolCatalog';
import { platformKeys } from './v2Shortcuts';
import './v2Flyout.css';

const LONG_PRESS_MS = 400;

// A rail button with a corner triangle that opens a grid of variants. A tool
// button (`onActivate`) arms its last-used variant on click, as its letter does
// (U1-05); its corner, a long press or ArrowRight opens the grid (Figma, tldraw).
// Insert has no tool to arm, so a click opens its grid. Picking arms the variant
// and closes. A flyout with `sections` (Insert) shows a heading over each group.
export function FlyoutButton<T extends string>(props: {
  readonly label: string;
  readonly shortcut?: string;
  readonly icon: ReactNode;
  readonly selected: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly options: readonly ToolOption<T>[] | readonly ToolSection<T>[];
  /** Nothing picked yet (More): focus lands on the first cell. */
  readonly selectedId: T | null;
  /** `keyboard`: Enter or Space picked the cell (a click with no pointer: detail 0). */
  readonly onPick: (id: T, keyboard: boolean) => void;
  /** Narrow grids (connectors) read better at half width. */
  readonly columns?: number;
  /** A tool button: a click arms the last-used variant; the corner button opens the grid. */
  readonly onActivate?: () => void;
  /** The variant a click arms: the button wears its icon and its tooltip names it. */
  readonly variant?: ToolOption<string> | undefined;
}): React.JSX.Element {
  // The grid sits beside whichever control opened it, and Escape hands focus back there. Both share the button's top and right edge.
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const pressTimer = useRef<number | undefined>(undefined);
  const longPressed = useRef(false);
  // A pointerdown on the corner closes an open grid (an outside press) before its click: the click reads the state from before.
  const openAtPress = useRef(false);
  useEffect(() => () => window.clearTimeout(pressTimer.current), []);
  const openFrom = (from: HTMLButtonElement | null) => {
    anchorRef.current = from;
    props.onOpenChange(true);
  };
  const headingId = useId();
  const sections: readonly ToolSection<T>[] = isSectioned(props.options)
    ? props.options : [{ title: '', options: props.options }];
  const options = sections.flatMap((section) => section.options);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowRight') return;
    event.preventDefault();
    openFrom(event.currentTarget);
  };

  // The grid is a listbox: arrows move by cell, Home/End to the ends. Focus is
  // managed (not a tab stop per cell) so the Popover's focus return stays intact.
  // Up/Down go by position, so they cross into a section with a short last row.
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const cells = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    const index = cells.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const next = event.key === 'ArrowRight' ? cells[index + 1]
      : event.key === 'ArrowLeft' ? cells[index - 1]
        : event.key === 'ArrowDown' || event.key === 'ArrowUp' ? verticalNeighbour(cells, cells[index]!, event.key === 'ArrowDown')
          : event.key === 'Home' ? cells[0]
            : event.key === 'End' ? cells[cells.length - 1]
              : undefined;
    if (!next) {
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') event.preventDefault();
      return;
    }
    event.preventDefault();
    next.focus();
  };

  const autofocusId = props.open
    ? (options.some((option) => option.id === props.selectedId) ? props.selectedId : options[0]?.id ?? null)
    : null;
  const cell = (option: ToolOption<T>) => (
    <Tooltip key={option.id} content={option.label} shortcut={option.shortcut && platformKeys(option.shortcut)}>
      <button
        type="button"
        role="option"
        aria-selected={option.id === props.selectedId}
        aria-label={option.label}
        className="ofk-v2-flyout-cell"
        data-selected={option.id === props.selectedId || undefined}
        {...(autofocusId === option.id ? { 'data-autofocus': '' } : {})}
        tabIndex={-1}
        onClick={(event) => {
          props.onPick(option.id, event.detail === 0);
          props.onOpenChange(false);
        }}
      >
        <Icon icon={option.icon} />
      </button>
    </Tooltip>
  );
  const grid = (cells: readonly ToolOption<T>[]) => (
    <div className="ofk-v2-flyout-grid" style={{ gridTemplateColumns: `repeat(${props.columns ?? 4}, 1fr)` }}>
      {cells.map(cell)}
    </div>
  );
  const activate = props.onActivate;
  const endPress = () => window.clearTimeout(pressTimer.current);
  const variant = props.variant;
  const shortcut = variant?.shortcut ?? props.shortcut;
  const button = activate ? (
    <Tooltip content={variant?.label ?? props.label} shortcut={shortcut && platformKeys(shortcut)}>
      <IconButton
        variant="quiet"
        label={props.label}
        icon={variant ? <Icon icon={variant.icon} /> : props.icon}
        selected={props.selected}
        data-flyout=""
        onKeyDown={onKeyDown}
        onPointerDown={(event) => {
          longPressed.current = false;
          if (event.button !== 0) return;
          const target = event.currentTarget;
          pressTimer.current = window.setTimeout(() => { longPressed.current = true; openFrom(target); }, LONG_PRESS_MS);
        }}
        onPointerUp={endPress} onPointerLeave={endPress} onPointerCancel={endPress}
        onClick={() => {
          if (!longPressed.current) { activate(); if (props.open) props.onOpenChange(false); }
          longPressed.current = false;
        }}
      />
    </Tooltip>
  ) : (
    <Tooltip content={props.label} shortcut={props.shortcut && platformKeys(props.shortcut)}>
      <IconButton
        ref={(element) => { anchorRef.current = element; }}
        variant="quiet"
        label={props.label}
        icon={props.icon}
        selected={props.selected}
        data-flyout=""
        aria-haspopup="dialog"
        aria-expanded={props.open}
        onKeyDown={onKeyDown}
        onClick={() => props.onOpenChange(!props.open)}
      />
    </Tooltip>
  );
  return (
    <>
      {activate ? (
        <span className="ofk-v2-flyout-slot">
          {button}
          <Tooltip content={`${props.label} options`}>
            <button
              type="button"
              className="ofk-v2-flyout-corner"
              tabIndex={-1}
              aria-label={`${props.label} options`}
              aria-haspopup="dialog"
              aria-expanded={props.open}
              onPointerDown={() => { openAtPress.current = props.open; }}
              onClick={(event) => {
                const wasOpen = event.detail === 0 ? props.open : openAtPress.current;
                if (wasOpen) props.onOpenChange(false); else openFrom(event.currentTarget);
              }}
            />
          </Tooltip>
        </span>
      ) : button}
      <Popover role="dialog" aria-label={`${props.label} options`} open={props.open}
        anchorRef={anchorRef} onClose={() => props.onOpenChange(false)} placement="right-start"
        gap={12} className="ofk-v2-flyout" onKeyDown={moveFocus}
        onPointerDown={(event) => event.stopPropagation()}>
        <div role="listbox" aria-label={props.label} tabIndex={-1}>
          {sections.map((section, index) => section.title ? (
            <div key={section.title} role="group" aria-labelledby={`${headingId}-${index}`} className="ofk-v2-flyout-section">
              <div id={`${headingId}-${index}`} className="ofk-v2-flyout-heading">{section.title}</div>
              {grid(section.options)}
            </div>
          ) : <div key={index}>{grid(section.options)}</div>)}
        </div>
      </Popover>
    </>
  );
}

function isSectioned<T extends string>(
  options: readonly ToolOption<T>[] | readonly ToolSection<T>[]
): options is readonly ToolSection<T>[] {
  return options.length > 0 && 'options' in options[0]!;
}

/** The nearest cell in the next row up or down, by horizontal centre. */
function verticalNeighbour(cells: readonly HTMLButtonElement[], from: HTMLButtonElement, down: boolean): HTMLButtonElement | undefined {
  const origin = from.getBoundingClientRect();
  const centre = (rect: DOMRect) => rect.left + rect.width / 2;
  const rows = cells
    .map((cell) => ({ cell, rect: cell.getBoundingClientRect() }))
    .filter(({ rect }) => (down ? rect.top > origin.top + 1 : rect.top < origin.top - 1));
  if (rows.length === 0) return undefined;
  const rowTop = down ? Math.min(...rows.map(({ rect }) => rect.top)) : Math.max(...rows.map(({ rect }) => rect.top));
  return rows
    .filter(({ rect }) => Math.abs(rect.top - rowTop) <= 1)
    .sort((a, b) => Math.abs(centre(a.rect) - centre(origin)) - Math.abs(centre(b.rect) - centre(origin)))[0]?.cell;
}
