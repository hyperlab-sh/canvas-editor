import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { IconChevronRight, IconCopy, IconDots, IconEye, IconEyeOff, IconLayersIntersect, IconLock, IconLockOpen, IconPencil, IconSquare, IconTrash, IconTypography, IconVectorBezier2 } from '@tabler/icons-react';
import type { CanvasSelection } from '../../application/selection/selection';
import type { SceneNode, ScenePage } from '../../domain/document/types';
import { isContainerNodeKind } from '../../domain/nodes/containerNodePresentation';
import { layerDropAllowed, layerFrontFirst, layerPaintEdges, type LayerDrop } from '../../domain/commands/layerMove';
import { buildNodeStateMap, connectorVisible } from '../../domain/scene/nodeState';
import { Icon, IconButton, Menu, MenuItem, MenuSeparator, MenuSubmenu, Panel } from '../design-system';
import type { IconComponent } from '../design-system/Icon';
import { layerConnectorName, layerNodeName } from './v2LayerNames';

type ConnectorAction = 'hide' | 'lock' | 'duplicate' | 'delete';
type LayerObjectAction = ConnectorAction | 'rename' | 'front' | 'forward' | 'backward' | 'back';
interface V2TreePanelProps {
  readonly page: ScenePage;
  readonly selection: CanvasSelection;
  readonly selectedConnectorIds: readonly string[];
  readonly onSelectNode: (id: string, additive: boolean) => void;
  readonly onSelectConnector: (id: string) => void;
  readonly onObjectAction: (id: string, action: LayerObjectAction) => void;
  readonly onConnectorMenu: (id: string, x: number, y: number) => void;
  readonly onConnectorAction: (id: string, action: ConnectorAction) => void;
  /** A row dragged to a new place; the drop was checked with `layerDropAllowed`. */
  readonly onMoveLayer: (id: string, drop: LayerDrop) => void;
  readonly onClose: () => void;
  readonly readOnly: boolean;
  /** Map mode lists the map's boxes; its empty state is not "add a shape". */
  readonly mapMode?: boolean;
}

/** One row's state; every field is a primitive (or a stable icon), so an unchanged row skips rendering. */
interface LayerRow {
  readonly id: string;
  readonly connector: boolean;
  readonly depth: number;
  readonly name: string;
  readonly glyph: IconComponent;
  readonly nested: boolean;
  readonly expanded: boolean;
  readonly selected: boolean;
  /** Drawn or not: hidden itself, or inside something hidden (a connector: or one of its ends). */
  readonly hidden: boolean;
  readonly ownHidden: boolean;
  readonly locked: boolean;
  readonly ownLocked: boolean;
  readonly menuOpen: boolean;
  /** This row is being dragged. */
  readonly dragging: boolean;
  /** The drop indicator drawn on this row: a line on its top or bottom edge at `dropDepth`, or the row lit as the new parent. */
  readonly dropEdge: 'top' | 'bottom' | 'into' | null;
  readonly dropDepth: number;
}

type DropIndicator = { readonly rowId: string; readonly edge: 'top' | 'bottom' | 'into'; readonly depth: number };
type DropTarget = LayerDrop & { readonly indicator: DropIndicator };

interface RowHandlers {
  select(id: string, connector: boolean, additive: boolean): void;
  toggle(id: string): void;
  action(id: string, connector: boolean, action: LayerObjectAction): void;
  menu(id: string, connector: boolean, anchor: HTMLElement): void;
  dragStart(id: string, event: React.PointerEvent): void;
}

/** Pixels a press travels before it is a drag, not a click; the canvas uses the same. */
const DRAG_THRESHOLD_PX = 4;
/** Within this distance of the list's top or bottom edge a drag scrolls it. */
const AUTO_SCROLL_EDGE_PX = 32;

const LayerRowView = memo(function LayerRowView({ handlers, readOnly, ...row }: LayerRow & { readonly handlers: RowHandlers; readonly readOnly: boolean }) {
  const { id, connector, name, hidden, locked } = row;
  // A hidden object draws nothing to select or rename; its row keeps show and lock.
  const renamable = !readOnly && !connector && !hidden;
  // Dragging moves a shape; a hidden or locked one stays put, as it does on the canvas.
  const draggable = renamable && !locked;
  return <li>
    <div className="ofk-object-row" data-object-id={id} data-connector={connector || undefined} data-selected={row.selected || undefined}
      data-hidden={hidden || undefined} data-dragging={row.dragging || undefined} data-drop={row.dropEdge ?? undefined}
      style={{ paddingInlineStart: 8 + row.depth * 14, '--ofk-drop-indent': `${8 + row.dropDepth * 14}px` } as React.CSSProperties}
      onContextMenu={(event) => { event.preventDefault(); if (!readOnly) handlers.menu(id, connector, event.currentTarget); }}>
      {row.nested ? <button type="button" className="ofk-object-expand" aria-label={`${row.expanded ? 'Collapse' : 'Expand'} ${name}`}
        aria-expanded={row.expanded} onClick={() => handlers.toggle(id)}><Icon icon={IconChevronRight} /></button>
        : <span className="ofk-object-indent" />}
      <button type="button" className="ofk-object-select" aria-pressed={row.selected} aria-disabled={hidden || undefined}
        title={hidden ? `${name} (hidden)` : name}
        onClick={(event) => { if (!hidden) handlers.select(id, connector, event.shiftKey || event.metaKey || event.ctrlKey); }}
        onPointerDown={(event) => { if (draggable && event.button === 0) handlers.dragStart(id, event); }}
        onDoubleClick={() => { if (renamable) handlers.action(id, false, 'rename'); }}
        onKeyDown={(event) => {
          if (readOnly) return;
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault(); handlers.menu(id, connector, event.currentTarget);
          } else if (event.key === 'F2' && renamable) {
            event.preventDefault(); handlers.action(id, false, 'rename');
          }
        }}><Icon icon={row.glyph} /><span>{name}</span></button>
      <div className="ofk-object-actions">
        {/* Read-only (a shared view, Map) keeps the state icons and drops the controls. */}
        {!readOnly || hidden ? <IconButton variant="quiet" label={`${row.ownHidden ? 'Show' : 'Hide'} ${name}`} disabled={readOnly}
          data-persistent={hidden || undefined} data-inherited={(hidden && !row.ownHidden) || undefined}
          icon={<Icon icon={hidden ? IconEyeOff : IconEye} />} onClick={() => handlers.action(id, connector, 'hide')} /> : null}
        {!readOnly || locked ? <IconButton variant="quiet" label={`${row.ownLocked ? 'Unlock' : 'Lock'} ${name}`} disabled={readOnly}
          data-persistent={locked || undefined} data-inherited={(locked && !row.ownLocked) || undefined}
          icon={<Icon icon={locked ? IconLock : IconLockOpen} />} onClick={() => handlers.action(id, connector, 'lock')} /> : null}
        {readOnly ? null : <IconButton variant="quiet" label={`Actions for ${name}`} aria-haspopup="menu" aria-expanded={row.menuOpen}
          icon={<Icon icon={IconDots} />} onClick={(event) => handlers.menu(id, connector, event.currentTarget)} />}
      </div>
    </div>
  </li>;
});

export function V2TreePanel(props: V2TreePanelProps): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useState<{ readonly id: string; readonly connector: boolean } | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [drag, setDrag] = useState<{ readonly id: string; readonly target: DropTarget | null } | null>(null);
  const { page } = props;
  const nodeById = useMemo(() => new Map(page.nodes.map((node) => [node.id, node])), [page.nodes]);
  const states = useMemo(() => buildNodeStateMap(page), [page]);
  // Rows are memoised: they call the latest props through a ref, so a selection change re-renders only the rows it touches.
  const propsRef = useRef(props);
  useLayoutEffect(() => { propsRef.current = props; });
  const dragRef = useRef<(id: string, x: number, y: number) => void>(() => undefined);
  const handlers = useMemo<RowHandlers>(() => ({
    select: (id, connector, additive) => {
      if (connector) propsRef.current.onSelectConnector(id); else propsRef.current.onSelectNode(id, additive);
    },
    toggle: (id) => setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    }),
    action: (id, connector, action) => {
      if (!connector) propsRef.current.onObjectAction(id, action);
      else if (action === 'hide' || action === 'lock' || action === 'duplicate' || action === 'delete') propsRef.current.onConnectorAction(id, action);
    },
    menu: (id, connector, anchor) => { anchorRef.current = anchor; setMenu({ id, connector }); },
    dragStart: (id, event) => dragRef.current(id, event.clientX, event.clientY),
  }), []);

  // A selection made on the canvas shows in the list: its parents open (once, so a later collapse is the user's) and its row scrolls into view.
  const focusId = props.selection.primaryNodeId ?? props.selectedConnectorIds[0] ?? null;
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  if (focusId !== openedFor) {
    setOpenedFor(focusId);
    const ancestors = new Set<string>();
    for (let parent = focusId ? nodeById.get(focusId)?.parentId : null; parent && !ancestors.has(parent); parent = nodeById.get(parent)?.parentId) ancestors.add(parent);
    if ([...ancestors].some((id) => collapsed.has(id))) setCollapsed(new Set([...collapsed].filter((id) => !ancestors.has(id))));
  }
  useEffect(() => {
    if (focusId) listRef.current?.querySelector(`[data-object-id="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [focusId]);

  const children = new Map<string | null, SceneNode[]>();
  for (const node of [...page.nodes].sort(layerFrontFirst)) {
    const parent = node.parentId && nodeById.has(node.parentId) ? node.parentId : null;
    const siblings = children.get(parent) ?? [];
    siblings.push(node);
    children.set(parent, siblings);
  }
  const rows: LayerRow[] = [];
  const addRows = (parent: string | null, depth: number) => {
    if (depth > page.nodes.length) return;
    for (const node of children.get(parent) ?? []) {
      const nested = children.has(node.id);
      const expanded = !collapsed.has(node.id);
      const state = states.get(node.id);
      rows.push({
        id: node.id, connector: false, depth, name: layerNodeName(node),
        glyph: nested || node.kind === 'frame' ? IconLayersIntersect : node.kind === 'text' ? IconTypography : IconSquare,
        nested, expanded, selected: props.selection.nodeIds.includes(node.id),
        hidden: state ? !state.visible : node.content.sectionHidden === true, ownHidden: node.content.sectionHidden === true,
        locked: state?.locked ?? node.content.sectionLocked === true, ownLocked: node.content.sectionLocked === true,
        menuOpen: menu?.id === node.id, dragging: drag?.id === node.id,
        dropEdge: drag?.target?.indicator.rowId === node.id ? drag.target.indicator.edge : null,
        dropDepth: drag?.target?.indicator.rowId === node.id ? drag.target.indicator.depth : 0,
      });
      if (nested && expanded) addRows(node.id, depth + 1);
    }
  };
  addRows(null, 0);
  for (const connector of page.connectors) {
    const locked = connector.metadata.locked === true;
    rows.push({
      id: connector.id, connector: true, depth: 0, name: layerConnectorName(connector, nodeById), glyph: IconVectorBezier2,
      nested: false, expanded: false, selected: props.selectedConnectorIds.includes(connector.id),
      hidden: !connectorVisible(connector, states), ownHidden: connector.metadata.hidden === true,
      locked, ownLocked: locked, menuOpen: menu?.id === connector.id, dragging: false, dropEdge: null, dropDepth: 0,
    });
  }

  // Drag-to-reorder reads the latest tree from window listeners, so it goes through refs.
  const treeRef = useRef({ children, nodeById, collapsed });
  useLayoutEffect(() => { treeRef.current = { children, nodeById, collapsed }; });

  /** Where a row dragged to viewport `y` would land, or null where it may not go (the canvas drop rules). */
  function targetAt(dragId: string, y: number): DropTarget | null {
    const { children: tree, nodeById: byId, collapsed: shut } = treeRef.current;
    const elements = [...(listRef.current?.querySelectorAll<HTMLElement>('.ofk-object-row:not([data-connector])') ?? [])];
    if (elements.length === 0) return null;
    const parentOf = (id: string) => { const parent = byId.get(id)?.parentId; return parent && byId.has(parent) ? parent : null; };
    let depth = 0;
    const depthOf = (id: string) => { depth = 0; for (let at = parentOf(id); at && depth <= byId.size; at = parentOf(at)) depth += 1; return depth; };
    // Siblings in front of `id`, the dragged row left out: the drop index just above it.
    const indexOf = (parent: string | null, id: string) => {
      const siblings = tree.get(parent) ?? [];
      return siblings.slice(0, Math.max(0, siblings.findIndex((node) => node.id === id))).filter((node) => node.id !== dragId).length;
    };
    const allowed = (target: DropTarget) => layerDropAllowed(propsRef.current.page, dragId, target.parentId) ? target : null;
    const element = elements.find((candidate) => candidate.getBoundingClientRect().bottom > y);
    if (!element) {
      // Below every shape: the back of the page.
      const top = (tree.get(null) ?? []).filter((node) => node.id !== dragId);
      return allowed({ parentId: null, index: top.length, indicator: { rowId: elements.at(-1)!.dataset.objectId!, edge: 'bottom', depth: 0 } });
    }
    const id = element.dataset.objectId!;
    const node = byId.get(id);
    if (!node) return null;
    const box = element.getBoundingClientRect();
    const share = (y - box.top) / box.height;
    const parent = parentOf(id);
    const rowDepth = depthOf(id);
    // The middle of a container row drops into it, in front of its children.
    if (isContainerNodeKind(node.kind) && node.kind !== 'group' && share > 0.25 && share < 0.75) {
      const into = allowed({ parentId: id, index: 0, indicator: { rowId: id, edge: 'into', depth: rowDepth } });
      if (into) return into;
    }
    if (share < 0.5) return allowed({ parentId: parent, index: indexOf(parent, id), indicator: { rowId: id, edge: 'top', depth: rowDepth } });
    // Below an open container is above its first child.
    const first = shut.has(id) ? undefined : (tree.get(id) ?? []).find((child) => child.id !== dragId);
    if (first) return allowed({ parentId: id, index: 0, indicator: { rowId: first.id, edge: 'top', depth: rowDepth + 1 } });
    return allowed({ parentId: parent, index: indexOf(parent, id) + (id === dragId ? 0 : 1), indicator: { rowId: id, edge: 'bottom', depth: rowDepth } });
  }

  /** Pointer drag of a row: a line (or a lit container) shows where it lands, the list scrolls at its edges, Escape cancels. */
  function startDrag(id: string, startX: number, startY: number): void {
    let active = false;
    let target: DropTarget | null = null;
    let lastY = startY;
    let frame = 0;
    const scroller = listRef.current?.closest<HTMLElement>('.ofk-panel-body') ?? null;
    const update = () => { target = targetAt(id, lastY); setDrag({ id, target }); };
    const scroll = () => {
      const box = scroller?.getBoundingClientRect();
      const step = !box ? 0 : lastY < box.top + AUTO_SCROLL_EDGE_PX ? -8 : lastY > box.bottom - AUTO_SCROLL_EDGE_PX ? 8 : 0;
      if (scroller && step) {
        const before = scroller.scrollTop;
        scroller.scrollTop += step;
        if (scroller.scrollTop !== before) update();
      }
      frame = requestAnimationFrame(scroll);
    };
    const move = (event: PointerEvent) => {
      lastY = event.clientY;
      if (!active) {
        if (Math.hypot(event.clientX - startX, event.clientY - startY) < DRAG_THRESHOLD_PX) return;
        active = true;
        frame = requestAnimationFrame(scroll);
      }
      update();
    };
    const end = (drop: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      cancelAnimationFrame(frame);
      if (!active) return;
      // The click that ends a drag is not a click on the row it ends over.
      const swallow = (event: MouseEvent) => { event.stopPropagation(); event.preventDefault(); };
      window.addEventListener('click', swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      setDrag(null);
      if (drop && target) propsRef.current.onMoveLayer(id, target);
    };
    const up = () => end(true);
    const cancel = () => end(false);
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !active) return;
      event.preventDefault(); event.stopPropagation(); end(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
  }

  useLayoutEffect(() => { dragRef.current = startDrag; });

  const menuRow = menu ? rows.find((row) => row.id === menu.id && row.connector === menu.connector) : undefined;
  const run = (action: LayerObjectAction) => { if (menuRow) handlers.action(menuRow.id, menuRow.connector, action); };
  const isGroup = menuRow && !menuRow.connector && nodeById.get(menuRow.id)?.kind === 'group';
  // Already in front of (or behind) everything it paints with: those Reorder items would change nothing.
  const edges = menuRow && !menuRow.connector ? layerPaintEdges(page, menuRow.id) : null;
  return <Panel title="Layers" side="start" onClose={props.onClose} className="ofk-v2-layers-panel"
    tools={<span className="ofk-v2-panel-badge" title={page.name}>{page.name}</span>}>
    {rows.length === 0 ? <div className="ofk-panel-empty">
      <Icon icon={IconLayersIntersect} />
      {props.mapMode ? <><strong>Nothing on the map</strong><p>Map shows architecture models.<br />Canvas has this page&apos;s drawing.</p></>
        : <><strong>No objects yet</strong><p>Add a shape or generate a diagram.<br />Manage its layers here.</p></>}
    </div> : <ul ref={listRef} className="ofk-object-list" aria-label="Objects on this page"
      data-drag={drag ? (drag.target ? 'ok' : 'refused') : undefined} onKeyDown={(event) => {
      if (!(event.target instanceof HTMLElement) || !event.target.matches('.ofk-object-select')) return;
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.ofk-object-select'));
      const index = buttons.indexOf(event.target as HTMLButtonElement);
      let next: HTMLButtonElement | undefined;
      if (event.key === 'ArrowDown') next = buttons[index + 1];
      else if (event.key === 'ArrowUp') next = buttons[index - 1];
      else if (event.key === 'Home') next = buttons[0];
      else if (event.key === 'End') next = buttons.at(-1);
      else return;
      event.preventDefault(); event.stopPropagation(); next?.focus();
    }}>
      {rows.map((row) => <LayerRowView key={`${row.connector ? 'c' : 'n'}:${row.id}`} {...row} handlers={handlers} readOnly={props.readOnly} />)}
    </ul>}
    <Menu open={!!menuRow && !props.readOnly} anchorRef={anchorRef} onClose={() => setMenu(null)} label="Object actions" placement="right-start">
      {menuRow ? <>
        {menuRow.connector ? null : <MenuItem icon={<Icon icon={IconPencil} />} disabled={menuRow.hidden || isGroup} onSelect={() => run('rename')}>Rename</MenuItem>}
        <MenuItem icon={<Icon icon={IconCopy} />} onSelect={() => run('duplicate')}>Duplicate</MenuItem>
        {menuRow.connector ? <MenuItem onSelect={() => {
          const box = anchorRef.current?.getBoundingClientRect();
          if (box) props.onConnectorMenu(menuRow.id, box.right, box.top);
        }}>Edit connection</MenuItem> : <MenuSubmenu label="Reorder">
          <MenuItem disabled={edges?.front} onSelect={() => run('front')}>Bring to front</MenuItem>
          <MenuItem disabled={edges?.front} onSelect={() => run('forward')}>Bring forward</MenuItem>
          <MenuItem disabled={edges?.back} onSelect={() => run('backward')}>Send backward</MenuItem>
          <MenuItem disabled={edges?.back} onSelect={() => run('back')}>Send to back</MenuItem>
        </MenuSubmenu>}
        <MenuSeparator />
        <MenuItem icon={<Icon icon={IconEye} />} onSelect={() => run('hide')}>{menuRow.ownHidden ? 'Show' : 'Hide'}</MenuItem>
        <MenuItem icon={<Icon icon={IconLock} />} onSelect={() => run('lock')}>{menuRow.ownLocked ? 'Unlock' : 'Lock'}</MenuItem>
        <MenuSeparator />
        <MenuItem icon={<Icon icon={IconTrash} />} danger onSelect={() => run('delete')}>Delete</MenuItem>
      </> : null}
    </Menu>
  </Panel>;
}
