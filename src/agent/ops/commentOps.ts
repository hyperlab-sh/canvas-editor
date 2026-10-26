// Comment threads as agent ops. They return a document transform (`comments`), never a command: threads are
// conversation, not drawing, so they take no undo step, no camera move and no page switch (see liveOp).
import { z } from 'zod';
import { addReply, addThread, CommentError, findThread, pageComments, setThreadResolved } from '../../opencanvas/domain/comments/comments';
import { buildNodeWorldMatrices } from '../../opencanvas/domain/scene/worldGeometry';
import { COMMENT_BODY_MAX, type SceneCommentAuthor } from '../../opencanvas/domain/document/types';
import { agentName } from '../agentName';
import { defineOp, pointOf, pointSchema, requirePage, type OpContext } from './types';

const body = () => z.string().min(1).max(COMMENT_BODY_MAX).describe(`Plain text, at most ${COMMENT_BODY_MAX} characters.`);
const author = (context: OpContext): SceneCommentAuthor => ({ kind: 'agent', name: agentName(context.client) });
const stamp = () => ({ id: crypto.randomUUID(), createdAt: new Date().toISOString() });

export const listComments = defineOp({
  name: 'list_comments',
  title: 'List comments',
  description: 'Comment threads people (and agents) pinned on the canvas: id, page, the node it is pinned to (with its label, '
    + 'when the node still exists), the pin point, resolved, and every message. Resolved threads are left out unless asked for. '
    + 'Threads never appear in get_diagram or exports.',
  schema: z.object({
    pageId: z.string().min(1).optional().describe('Only this page (see list_pages); default every page.'),
    includeResolved: z.boolean().default(false).describe('Also list resolved threads.'),
  }),
  async run({ pageId, includeResolved }, context) {
    const pages = pageId ? [requirePage(context.document, pageId)] : context.document.pages;
    const threads = pages.flatMap((page) => {
      const nodes = new Map(page.nodes.map((node) => [node.id, node]));
      return pageComments(page).filter((thread) => includeResolved || !thread.resolved).map((thread) => {
        const node = thread.anchor.nodeId === null ? undefined : nodes.get(thread.anchor.nodeId);
        return {
          id: thread.id, pageId: page.id, nodeId: thread.anchor.nodeId,
          ...(node ? { nodeLabel: typeof node.content.label === 'string' ? node.content.label : '' } : {}),
          point: thread.anchor.point, resolved: thread.resolved,
          messages: thread.messages.map(({ id, author: by, body: text, createdAt, editedAt }) => ({
            id, author: by, body: text, createdAt, ...(editedAt ? { editedAt } : {}),
          })),
        };
      });
    });
    return { command: null, output: { threads } };
  },
});

export const replyComment = defineOp({
  name: 'reply_comment',
  title: 'Reply to a comment',
  description: 'Reply in a comment thread (list_comments gives the threadId). Signed with your agent name. '
    + 'A reply reopens a resolved thread. Takes no undo step.',
  schema: z.object({ threadId: z.string().min(1), body: body() }),
  async run({ threadId, body: text }, context) {
    if (!findThread(context.document, threadId)) throw new CommentError(`Unknown comment thread "${threadId}".`);
    const message = { ...stamp(), author: author(context), body: text };
    return {
      command: null,
      comments: (document) => addReply(document, threadId, message),
      output: { threadId, messageId: message.id },
    };
  },
});

export const resolveComment = defineOp({
  name: 'resolve_comment',
  title: 'Resolve a comment',
  description: 'Mark a comment thread resolved (it leaves the canvas but stays in the file), or reopen it with resolved: false.',
  schema: z.object({ threadId: z.string().min(1), resolved: z.boolean().default(true) }),
  async run({ threadId, resolved }, context) {
    if (!findThread(context.document, threadId)) throw new CommentError(`Unknown comment thread "${threadId}".`);
    return {
      command: null,
      comments: (document) => setThreadResolved(document, threadId, resolved),
      output: { threadId, resolved },
    };
  },
});

export const addComment = defineOp({
  name: 'add_comment',
  title: 'Start a comment',
  description: 'Start a comment thread. Pin it to a node (nodeId: the pin sits at its top-right corner and follows the node) '
    + 'or to a world point; one of the two is required. Signed with your agent name. Takes no undo step.',
  schema: z.object({
    nodeId: z.string().min(1).optional().describe('Node to pin to (see get_document).'),
    point: pointSchema().optional().describe('World position of the pin; wins over the node corner when both are given.'),
    body: body(),
  }),
  async run({ nodeId, point, body: text }, context) {
    if (!nodeId && !point) throw new CommentError('Say where the comment goes: pass nodeId (a node on the page) or point ({x, y} in world coordinates).');
    const page = requirePage(context.document, context.pageId);
    let pin = point ? pointOf(point) : null;
    if (nodeId) {
      const node = page.nodes.find((candidate) => candidate.id === nodeId);
      const origin = node ? buildNodeWorldMatrices(page).get(nodeId) : undefined;
      if (!node || !origin) throw new CommentError(`Node "${nodeId}" is not on page "${page.id}" (get_document lists them).`);
      pin ??= { x: origin.tx + node.size.width, y: origin.ty };
    }
    const threadId = crypto.randomUUID();
    const message = { ...stamp(), author: author(context), body: text };
    const pageId = page.id;
    const at = pin!;
    return {
      command: null,
      comments: (document) => addThread(document, { pageId, threadId, nodeId: nodeId ?? null, point: at, message }),
      output: { threadId, messageId: message.id, pageId, nodeId: nodeId ?? null, point: at },
    };
  },
});
