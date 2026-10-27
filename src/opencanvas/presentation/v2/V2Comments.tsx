import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { CanvasCamera } from '../../domain/camera/types';
import {
  addComment, addThread, editComment, pageThreads, removeComment, removeThread, setThreadResolved,
} from '../../domain/threads/threads';
import type { Point2d } from '../../domain/geometry/types';
import type { SceneThread, SceneDocumentV1, ScenePage } from '../../domain/document/types';
import { postThreadEvent } from '../../../agent/bridge/threadEvent';
import type { BridgeThreadEvent } from '../../../agent/bridge/protocol';
import type { PixiRendererHost } from '../../infrastructure/pixi/PixiRendererHost';
import { Avatar, CommentComposer, ThreadPopover } from './V2CommentsParts';
import { mintV2Id } from './v2Document';
import type { V2Tool } from './v2ToolCatalog';

/** A pin and what opens from it keep their place on screen by world position: one rAF loop sets transforms, React never renders a frame. */
class Placement {
  private readonly entries = new Map<HTMLElement, { world: Point2d; key: string }>();
  private raf = 0;
  constructor(private readonly camera: () => CanvasCamera, private readonly width: () => number) {}

  add(el: HTMLElement, world: Point2d): void {
    this.entries.set(el, { world, key: '' });
    this.paint(el, this.entries.get(el)!);
    this.kick();
  }

  move(el: HTMLElement, world: Point2d): void {
    const entry = this.entries.get(el);
    if (entry) entry.world = world;
  }

  remove(el: HTMLElement): void {
    this.entries.delete(el);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private paint(el: HTMLElement, entry: { world: Point2d; key: string }): void {
    const { x, y, zoom } = this.camera();
    const left = entry.world.x * zoom + x;
    const top = entry.world.y * zoom + y;
    const key = `${left}|${top}`;
    if (key === entry.key) return;
    entry.key = key;
    el.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    // A card opens to the left of a pin too near the right edge for it.
    const side = left > this.width() - 380 ? 'left' : 'right';
    if (el.dataset.side !== side) el.dataset.side = side;
  }

  private kick(): void {
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  private readonly tick = (): void => {
    this.raf = 0;
    for (const [el, entry] of this.entries) this.paint(el, entry);
    if (this.entries.size > 0) this.raf = requestAnimationFrame(this.tick);
  };
}

const PlacementContext = createContext<Placement | null>(null);

/** Children sit at a world point; the tip of whatever is inside is the origin. */
function Anchored(props: { readonly world: Point2d; readonly className?: string; readonly children: ReactNode; readonly testId?: string }): React.JSX.Element {
  const placement = useContext(PlacementContext);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !placement) return;
    placement.add(el, props.world);
    return () => placement.remove(el);
    // The world point is handed over below on every render; add/remove is for mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placement]);
  useLayoutEffect(() => {
    if (ref.current) placement?.move(ref.current, props.world);
  }, [placement, props.world]);
  return <div ref={ref} className={`ofk-comment-anchor ${props.className ?? ''}`} data-testid={props.testId}>{props.children}</div>;
}

type Open =
  | { readonly kind: 'composer'; readonly world: Point2d; readonly nodeId: string | null }
  | { readonly kind: 'thread'; readonly id: string };

interface Props {
  readonly document: SceneDocumentV1 | null;
  readonly page: ScenePage;
  readonly sectionRef: RefObject<HTMLElement | null>;
  readonly hostRef: RefObject<PixiRendererHost | null>;
  readonly cameraRef: RefObject<CanvasCamera>;
  readonly tool: V2Tool;
  /** Pins and threads show; nothing can be added or changed. */
  readonly readOnly: boolean;
  /** The canvas shows another page than the one holding the threads (Map): their coordinates mean nothing there. */
  readonly hidden: boolean;
  readonly updateThreads: (change: (document: SceneDocumentV1) => SceneDocumentV1) => void;
  readonly liveComments: boolean;
  readonly bridgeConnected: boolean;
  readonly onLiveComments: (on: boolean) => void;
  readonly onLiveMessage: (event: BridgeThreadEvent) => void;
}

/** Every human comment is written by this name until named commenters exist; the data model, the bridge event and the MCP meta already carry it. */
export const HUMAN_AUTHOR_NAME = 'User';

const HUMAN_AUTHOR = { kind: 'human' as const, name: HUMAN_AUTHOR_NAME };

const nodeLabelOf = (page: ScenePage, nodeId: string | null): string | null => {
  const label = nodeId === null ? undefined : page.nodes.find((node) => node.id === nodeId)?.content?.label;
  return typeof label === 'string' && label.trim() ? label.trim() : null;
};

/** Comment pins over the canvas, the composer a click with the comment tool opens, and a pin's thread. DOM, so no export ever draws them. */
export function V2Comments(props: Props): React.JSX.Element | null {
  const { page, hidden, readOnly, tool, sectionRef, hostRef, cameraRef, updateThreads } = props;
  const [open, setOpen] = useState<Open | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // The loop reads the refs when a frame runs, never during render.
  // eslint-disable-next-line react-hooks/refs
  const [placement] = useState(() => new Placement(() => cameraRef.current, () => sectionRef.current?.clientWidth ?? Infinity));
  useEffect(() => () => placement.stop(), [placement]);

  const threads = useMemo(() => pageThreads(page).filter((thread) => !thread.resolved), [page]);
  const openThread = open?.kind === 'thread' ? pageThreads(page).find((thread) => thread.id === open.id) : undefined;
  // A thread that went away (deleted, an agent resolved it, another page) closes with it.
  useEffect(() => {
    if (open?.kind === 'thread' && (!openThread || openThread.resolved)) setOpen(null);
  }, [open, openThread]);
  useEffect(() => { setOpen(null); }, [page.id, hidden]);
  useEffect(() => { if (readOnly && open?.kind === 'composer') setOpen(null); }, [readOnly, open]);
  // Ages tick while a thread is open.
  useEffect(() => {
    if (open?.kind !== 'thread') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [open]);

  const latest = useRef({ open, tool, readOnly, hidden });
  useEffect(() => { latest.current = { open, tool, readOnly, hidden }; });
  // One press on the canvas: clicking away closes what is open (and only that); with nothing open, the comment tool places a composer.
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const onDown = (event: PointerEvent) => {
      const state = latest.current;
      if (event.button !== 0 || state.hidden) return;
      const target = event.target as Element;
      if (target.closest('[data-comment-ui]')) return;
      if (state.open) { setOpen(null); return; }
      const host = hostRef.current;
      if (state.tool !== 'comment' || state.readOnly || !host) return;
      const rect = section.getBoundingClientRect();
      const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      setOpen({ kind: 'composer', world: host.screenToWorld(screen), nodeId: host.pickNode(screen) });
    };
    section.addEventListener('pointerdown', onDown);
    return () => section.removeEventListener('pointerdown', onDown);
  }, [sectionRef, hostRef]);
  // Leaving the comment tool abandons a half-written composer.
  useEffect(() => { if (tool !== 'comment') setOpen((current) => (current?.kind === 'composer' ? null : current)); }, [tool]);

  const documentId = props.document?.id ?? '';
  const message = useCallback((body: string) => ({ id: mintV2Id('msg'), author: HUMAN_AUTHOR, body, createdAt: new Date().toISOString() }), []);
  const announce = (event: Omit<BridgeThreadEvent, 'type' | 'documentId' | 'pageId' | 'author'>) => {
    if (props.liveComments && props.bridgeConnected) {
      props.onLiveMessage({ type: 'thread', documentId, pageId: page.id, author: HUMAN_AUTHOR_NAME, ...event });
    }
  };

  if (hidden) return null;
  const live = { on: props.liveComments, available: props.bridgeConnected, onChange: props.onLiveComments };

  const create = (body: string) => {
    if (open?.kind !== 'composer') return;
    const threadId = mintV2Id('thread');
    const next = message(body);
    updateThreads((doc) => addThread(doc, { pageId: page.id, threadId, nodeId: open.nodeId, point: open.world, comment: next }));
    announce({ threadId, commentId: next.id, nodeId: open.nodeId, nodeLabel: nodeLabelOf(page, open.nodeId), kind: 'new_thread', body: next.body });
    // The comment tool stays active: the next click starts the next thread. Esc or another tool leaves it.
    setOpen(null);
  };
  const reply = (thread: SceneThread, body: string) => {
    const next = message(body);
    updateThreads((doc) => addComment(doc, thread.id, next));
    announce({ threadId: thread.id, commentId: next.id, nodeId: thread.anchor.nodeId, nodeLabel: nodeLabelOf(page, thread.anchor.nodeId), kind: 'reply', body: next.body });
  };

  return (
    <PlacementContext.Provider value={placement}>
      {threads.map((thread) => {
        const lead = thread.comments[0]!;
        const selected = open?.kind === 'thread' && open.id === thread.id;
        return (
          <Anchored key={thread.id} world={thread.anchor.point} className="ofk-comment-pinned" testId="v2-comment-pin">
            <button type="button" className="ofk-comment-pin" data-comment-ui data-selected={selected || undefined} data-kind={lead.author.kind}
              aria-label={`Comment by ${lead.author.name}${thread.comments.length > 1 ? `, ${thread.comments.length} messages` : ''}`}
              aria-expanded={selected}
              onClick={() => setOpen(selected ? null : { kind: 'thread', id: thread.id })}>
              <Avatar kind={lead.author.kind} name={lead.author.name} size={22} />
            </button>
            {selected && openThread ? (
              <ThreadPopover thread={openThread} readOnly={readOnly} live={live} now={now}
                onClose={() => { setOpen(null); sectionRef.current?.focus({ preventScroll: true }); }}
                onResolve={() => { updateThreads((doc) => setThreadResolved(doc, thread.id, true)); setOpen(null); }}
                onDeleteThread={() => { updateThreads((doc) => removeThread(doc, thread.id)); setOpen(null); }}
                onReply={(body) => reply(thread, body)}
                onEditMessage={(commentId, body) => updateThreads((doc) => editComment(doc, thread.id, commentId, body, new Date().toISOString()))}
                onDeleteMessage={(commentId) => updateThreads((doc) => removeComment(doc, thread.id, commentId))} />
            ) : null}
          </Anchored>
        );
      })}
      {open?.kind === 'composer' ? (
        <Anchored world={open.world} className="ofk-comment-pinned" testId="v2-comment-composer">
          <span className="ofk-comment-pin" data-ghost><Avatar kind="human" name={HUMAN_AUTHOR_NAME} size={22} /></span>
          <CommentComposer live={live} onSend={create} onCancel={() => setOpen(null)} />
        </Anchored>
      ) : null}
    </PlacementContext.Provider>
  );
}

type HostInput = Omit<Props, 'document' | 'liveComments' | 'onLiveComments' | 'onLiveMessage' | 'updateThreads' | 'cameraRef'> & {
  readonly session: { readonly document: SceneDocumentV1 | null; readonly updateThreads: Props['updateThreads'] };
  readonly cameraRef: RefObject<CanvasCamera>;
  readonly preferences: { readonly liveComments: boolean };
  readonly updatePreferences: (patch: { liveComments?: boolean }) => void;
};

/** V2Comments wired to the editor's session, preferences and the agent bridge's comment poster. */
export function V2CommentsHost({ session, preferences, updatePreferences, ...rest }: HostInput): React.JSX.Element | null {
  return (
    <V2Comments {...rest} document={session.document} updateThreads={session.updateThreads}
      liveComments={preferences.liveComments} onLiveComments={(liveComments) => updatePreferences({ liveComments })}
      onLiveMessage={(event) => { void postThreadEvent(event); }} />
  );
}
