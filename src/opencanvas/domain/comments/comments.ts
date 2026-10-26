// Comment threads pinned on a page. They are document data but not diagram content: commands, undo and the
// DSL never touch them, so every change goes through these functions and carryComments keeps them across
// a history step.
import type { Point2d } from '../geometry/types';
import { buildNodeWorldMatrices } from '../scene/worldGeometry';
import {
  COMMENT_BODY_MAX,
  type SceneCommentAnchor,
  type SceneCommentAuthor,
  type SceneCommentMessage,
  type SceneCommentThread,
  type SceneDocumentV1,
  type ScenePage,
} from '../document/types';

export class CommentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommentError';
  }
}

const NO_THREADS: readonly SceneCommentThread[] = [];

export function pageComments(page: ScenePage): readonly SceneCommentThread[] {
  return page.comments ?? NO_THREADS;
}

export function openThreadCount(page: ScenePage): number {
  return pageComments(page).filter((thread) => !thread.resolved).length;
}

/** A body as stored: trimmed, non-empty and at most COMMENT_BODY_MAX characters. */
export function commentBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) throw new CommentError('A comment cannot be empty.');
  if (trimmed.length > COMMENT_BODY_MAX) {
    throw new CommentError(`A comment is at most ${COMMENT_BODY_MAX} characters.`);
  }
  return trimmed;
}

/** Pins `point` to `nodeId` (when it is on the page) so the pin follows the node, or to the page. */
export function createAnchor(page: ScenePage, nodeId: string | null, point: Point2d): SceneCommentAnchor {
  const origin = nodeId === null ? undefined : buildNodeWorldMatrices(page).get(nodeId);
  if (!origin) return { nodeId: null, offset: null, point };
  return { nodeId, offset: { x: point.x - origin.tx, y: point.y - origin.ty }, point };
}

/** Moves each node-anchored pin to where its node is now; a pin whose node is gone keeps its last point. */
export function refreshAnchors(page: ScenePage): ScenePage {
  const threads = pageComments(page);
  if (!threads.some((thread) => thread.anchor.nodeId !== null)) return page;
  const origins = buildNodeWorldMatrices(page);
  let changed = false;
  const next = threads.map((thread) => {
    const { nodeId, offset, point } = thread.anchor;
    const origin = nodeId === null ? undefined : origins.get(nodeId);
    if (!origin || !offset) return thread;
    const x = origin.tx + offset.x;
    const y = origin.ty + offset.y;
    if (x === point.x && y === point.y) return thread;
    changed = true;
    return { ...thread, anchor: { ...thread.anchor, point: { x, y } } };
  });
  return changed ? { ...page, comments: next } : page;
}

/**
 * `next` with the comments of `current`: a history step (commit, undo, redo) changes shapes, never comments,
 * even when it restores a whole page snapshot. Pages only in `next` keep their own. Anchors then follow
 * their nodes. Returns `next` itself when nothing changes.
 */
export function carryComments(next: SceneDocumentV1, current: SceneDocumentV1): SceneDocumentV1 {
  const currentById = new Map(current.pages.map((page) => [page.id, page]));
  let changed = false;
  const pages = next.pages.map((page) => {
    const before = currentById.get(page.id);
    let result = page;
    if (before && before.comments !== page.comments) {
      const { comments: _dropped, ...rest } = page;
      result = before.comments ? { ...rest, comments: before.comments } : rest;
    }
    result = refreshAnchors(result);
    if (result !== page) changed = true;
    return result;
  });
  return changed ? { ...next, pages } : next;
}

/** `document` with `update` applied to one page's threads. An empty result drops the key. */
export function updatePageComments(
  document: SceneDocumentV1,
  pageId: string,
  update: (threads: readonly SceneCommentThread[], page: ScenePage) => readonly SceneCommentThread[]
): SceneDocumentV1 {
  const index = document.pages.findIndex((page) => page.id === pageId);
  const page = document.pages[index];
  if (!page) throw new CommentError(`Unknown page "${pageId}".`);
  const threads = update(pageComments(page), page);
  if (threads === page.comments) return document;
  const { comments: _dropped, ...rest } = page;
  const nextPage: ScenePage = threads.length ? { ...rest, comments: threads } : rest;
  const pages = document.pages.slice();
  pages[index] = nextPage;
  return { ...document, pages };
}

/** The page holding `threadId`, or undefined. */
export function findThread(
  document: SceneDocumentV1,
  threadId: string
): { readonly page: ScenePage; readonly thread: SceneCommentThread } | undefined {
  for (const page of document.pages) {
    const thread = pageComments(page).find((candidate) => candidate.id === threadId);
    if (thread) return { page, thread };
  }
  return undefined;
}

function requireThread(document: SceneDocumentV1, threadId: string) {
  const found = findThread(document, threadId);
  if (!found) throw new CommentError(`Unknown comment thread "${threadId}".`);
  return found;
}

function replaceThread(
  document: SceneDocumentV1,
  threadId: string,
  change: (thread: SceneCommentThread) => SceneCommentThread | null
): SceneDocumentV1 {
  const { page } = requireThread(document, threadId);
  return updatePageComments(document, page.id, (threads) =>
    threads.flatMap((thread) => {
      if (thread.id !== threadId) return [thread];
      const next = change(thread);
      return next ? [next] : [];
    })
  );
}

export interface NewMessage {
  readonly id: string;
  readonly author: SceneCommentAuthor;
  readonly body: string;
  readonly createdAt: string;
}

function message(input: NewMessage): SceneCommentMessage {
  return { id: input.id, author: input.author, body: commentBody(input.body), createdAt: input.createdAt };
}

export function addThread(
  document: SceneDocumentV1,
  input: {
    readonly pageId: string;
    readonly threadId: string;
    readonly nodeId: string | null;
    readonly point: Point2d;
    readonly message: NewMessage;
  }
): SceneDocumentV1 {
  if (findThread(document, input.threadId)) throw new CommentError(`Thread "${input.threadId}" already exists.`);
  return updatePageComments(document, input.pageId, (threads, page) => [
    ...threads,
    {
      id: input.threadId,
      anchor: createAnchor(page, input.nodeId, input.point),
      resolved: false,
      messages: [message(input.message)],
    },
  ]);
}

/** A reply also reopens a resolved thread, as it does in Figma. */
export function addReply(document: SceneDocumentV1, threadId: string, reply: NewMessage): SceneDocumentV1 {
  return replaceThread(document, threadId, (thread) => ({
    ...thread,
    resolved: false,
    messages: [...thread.messages, message(reply)],
  }));
}

export function editMessage(
  document: SceneDocumentV1,
  threadId: string,
  messageId: string,
  body: string,
  editedAt: string
): SceneDocumentV1 {
  return replaceThread(document, threadId, (thread) => {
    if (!thread.messages.some((candidate) => candidate.id === messageId)) {
      throw new CommentError(`Unknown message "${messageId}".`);
    }
    return {
      ...thread,
      messages: thread.messages.map((candidate) =>
        candidate.id === messageId ? { ...candidate, body: commentBody(body), editedAt } : candidate
      ),
    };
  });
}

/** Deleting the opening message deletes the thread. */
export function removeMessage(document: SceneDocumentV1, threadId: string, messageId: string): SceneDocumentV1 {
  return replaceThread(document, threadId, (thread) => {
    if (thread.messages[0]?.id === messageId) return null;
    return { ...thread, messages: thread.messages.filter((candidate) => candidate.id !== messageId) };
  });
}

export function setThreadResolved(document: SceneDocumentV1, threadId: string, resolved: boolean): SceneDocumentV1 {
  return replaceThread(document, threadId, (thread) => (thread.resolved === resolved ? thread : { ...thread, resolved }));
}

export function removeThread(document: SceneDocumentV1, threadId: string): SceneDocumentV1 {
  return replaceThread(document, threadId, () => null);
}
