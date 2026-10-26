import { describe, expect, it, vi } from 'vitest';
import { applyDocumentCommand } from '@/opencanvas/domain/commands/execute';
import { pageComments } from '@/opencanvas/domain/comments/comments';
import type { SceneDocumentV1 } from '@/opencanvas/domain/document/types';
import { createAgentDocument } from '../index';
import { READ_ONLY_REFUSAL, runLiveAgentOp, type LiveAgentSession } from '../liveOp';
import { resolveAgentOpCommand, runAgentOp } from '../runAction';
import { AGENT_OPS, findAgentOp } from './index';
import { createTestCapabilities } from './testHost';
import type { OpContext } from './types';

const FLOW = '%% ofk 1\nflowchart\n\n  Client [blue] -> API [emerald]\n  API -> Store [cylinder, red]';
const capabilities = createTestCapabilities();

const op = (name: string) => findAgentOp(name)!;

async function drawn(): Promise<SceneDocumentV1> {
  const document = createAgentDocument('Comments fixture', 'doc-c');
  const context: OpContext = { document, pageId: document.pages[0]!.id, capabilities };
  const { command } = await resolveAgentOpCommand(op('create_diagram'), { dsl: FLOW }, context);
  return applyDocumentCommand(document, command!).document;
}

const contextOf = (document: SceneDocumentV1, client?: string): OpContext =>
  ({ document, pageId: document.pages[0]!.id, capabilities, ...(client ? { client } : {}) });

/** File mode: the op's result applied to the document, as the MCP server does. */
const file = (document: SceneDocumentV1, name: string, input: unknown, client?: string) =>
  runAgentOp(op(name), input, contextOf(document, client));

describe('comment ops, file mode', () => {
  it('add_comment on a node pins at its top-right corner and signs with the agent name', async () => {
    const document = await drawn();
    const node = document.pages[0]!.nodes.find((candidate) => candidate.kind !== 'frame')!;
    const { document: next, output, changed } = await file(document, 'add_comment', { nodeId: node.id, body: ' Check this ' }, 'claude-code');
    expect(changed).toBe(true);
    const [thread] = pageComments(next.pages[0]!);
    expect(thread!.anchor.nodeId).toBe(node.id);
    expect(thread!.anchor.point.x).toBeGreaterThan(node.transform.translation.x);
    expect(thread!.messages).toHaveLength(1);
    expect(thread!.messages[0]).toMatchObject({ author: { kind: 'agent', name: 'Claude Code' }, body: 'Check this' });
    expect(output).toMatchObject({ threadId: thread!.id, messageId: thread!.messages[0]!.id });
  });

  it('add_comment on a point pins to the page; point wins over the node corner', async () => {
    const document = await drawn();
    const node = document.pages[0]!.nodes.find((candidate) => candidate.kind !== 'frame')!;
    const onPage = (await file(document, 'add_comment', { point: { x: 5, y: 6 }, body: 'here' })).document;
    expect(pageComments(onPage.pages[0]!)[0]!.anchor).toEqual({ nodeId: null, offset: null, point: { x: 5, y: 6 } });
    const both = (await file(document, 'add_comment', { nodeId: node.id, point: { x: 1, y: 2 }, body: 'there' })).document;
    expect(pageComments(both.pages[0]!)[0]!.anchor).toMatchObject({ nodeId: node.id, point: { x: 1, y: 2 } });
  });

  it('add_comment refuses with neither a node nor a point, an unknown node, or an empty body', async () => {
    const document = await drawn();
    await expect(file(document, 'add_comment', { body: 'x' })).rejects.toThrow(/nodeId.*point/);
    await expect(file(document, 'add_comment', { nodeId: 'ghost', body: 'x' })).rejects.toThrow(/ghost/);
    await expect(file(document, 'add_comment', { point: { x: 0, y: 0 }, body: '   ' })).rejects.toThrow(/empty/);
  });

  it('reply_comment and resolve_comment change the thread; reply reopens; unknown ids refuse', async () => {
    const started = (await file(await drawn(), 'add_comment', { point: { x: 0, y: 0 }, body: 'first' }, 'cursor')).document;
    const threadId = pageComments(started.pages[0]!)[0]!.id;
    const resolved = (await file(started, 'resolve_comment', { threadId })).document;
    expect(pageComments(resolved.pages[0]!)[0]!.resolved).toBe(true);
    const replied = (await file(resolved, 'reply_comment', { threadId, body: 'again' }, 'cursor')).document;
    const thread = pageComments(replied.pages[0]!)[0]!;
    expect(thread.resolved).toBe(false);
    expect(thread.messages.map(({ body }) => body)).toEqual(['first', 'again']);
    expect(thread.messages[1]!.author).toEqual({ kind: 'agent', name: 'Cursor' });
    const reopened = (await file(resolved, 'resolve_comment', { threadId, resolved: false })).document;
    expect(pageComments(reopened.pages[0]!)[0]!.resolved).toBe(false);
    await expect(file(started, 'reply_comment', { threadId: 'ghost', body: 'x' })).rejects.toThrow(/ghost/);
    await expect(file(started, 'resolve_comment', { threadId: 'ghost' })).rejects.toThrow(/ghost/);
  });

  it('list_comments hides resolved threads by default, labels live nodes, and survives a deleted node', async () => {
    let document = await drawn();
    const node = document.pages[0]!.nodes.find((candidate) => candidate.kind !== 'frame' && typeof candidate.content.label === 'string')!;
    document = (await file(document, 'add_comment', { nodeId: node.id, body: 'one' })).document;
    document = (await file(document, 'add_comment', { point: { x: 1, y: 1 }, body: 'two' })).document;
    const [first] = pageComments(document.pages[0]!);
    document = (await file(document, 'resolve_comment', { threadId: first!.id })).document;
    const open = (await file(document, 'list_comments', {})).output as { threads: { id: string; nodeLabel?: string; pageId: string }[] };
    expect(open.threads.map(({ id }) => id)).not.toContain(first!.id);
    const all = (await file(document, 'list_comments', { includeResolved: true })).output as typeof open;
    expect(all.threads).toHaveLength(2);
    expect(all.threads.find(({ id }) => id === first!.id)).toMatchObject({ nodeLabel: node.content.label, pageId: document.pages[0]!.id });
    const gone = { ...document, pages: [{ ...document.pages[0]!, nodes: document.pages[0]!.nodes.filter(({ id }) => id !== node.id) }] };
    const afterDelete = (await file(gone, 'list_comments', { includeResolved: true })).output as typeof open;
    const orphan = afterDelete.threads.find(({ id }) => id === first!.id)!;
    expect(orphan.nodeLabel).toBeUndefined();
    await expect(file(document, 'list_comments', { pageId: 'nope' })).rejects.toThrow(/nope/);
  });

  it('get_document and list_pages count open threads', async () => {
    let document = await drawn();
    document = (await file(document, 'add_comment', { point: { x: 0, y: 0 }, body: 'a' })).document;
    document = (await file(document, 'add_comment', { point: { x: 0, y: 0 }, body: 'b' })).document;
    document = (await file(document, 'resolve_comment', { threadId: pageComments(document.pages[0]!)[0]!.id })).document;
    expect((await file(document, 'get_document', {})).output).toMatchObject({ openThreads: 1 });
    expect((await file(document, 'list_pages', {})).output).toMatchObject({ pages: [{ openThreads: 1 }] });
  });

  it('comments never reach the DSL: get_diagram and its drift are identical with and without them', async () => {
    const document = await drawn();
    const frameId = document.pages[0]!.nodes.find((node) => node.kind === 'frame')!.id;
    const node = document.pages[0]!.nodes.find((candidate) => candidate.kind !== 'frame')!;
    const commented = (await file(document, 'add_comment', { nodeId: node.id, body: 'noted' })).document;
    expect(pageComments(commented.pages[0]!)).toHaveLength(1);
    for (const input of [{ frameId }, { frameId, diffOnly: true }]) {
      const plain = await runAgentOp(op('get_diagram'), input, contextOf(document));
      const withComments = await runAgentOp(op('get_diagram'), input, contextOf(commented));
      expect(withComments.output).toEqual(plain.output);
    }
    const listed = (id: SceneDocumentV1) => runAgentOp(op('list_diagrams'), {}, contextOf(id));
    expect((await listed(commented)).output).toEqual((await listed(document)).output);
  });

  it('the comment ops are registered once, and read-only list_comments is not a write', () => {
    for (const name of ['list_comments', 'reply_comment', 'resolve_comment', 'add_comment']) {
      expect(AGENT_OPS.filter((candidate) => candidate.name === name)).toHaveLength(1);
    }
  });
});

describe('comment ops, live', () => {
  const live = async (overrides: Partial<LiveAgentSession> = {}) => {
    let document = await drawn();
    const commentChange = vi.fn((change: (doc: SceneDocumentV1) => SceneDocumentV1) => { document = change(document); });
    const commit = vi.fn();
    const session = (): LiveAgentSession => ({
      document, pageId: document.pages[0]!.id, capabilities, commit, commentChange, ...overrides,
    });
    return { session, commentChange, commit, document: () => document };
  };

  it('a comment write goes through commentChange only: no commit, no undo step, no camera or page move', async () => {
    const onApplied = vi.fn();
    const showPage = vi.fn();
    const host = await live({ onApplied, showPage });
    const result = await runLiveAgentOp(host.session, 'add_comment', { point: { x: 3, y: 4 }, body: 'hi' }, undefined, undefined, 'claude-code');
    expect(result.command).toBeNull();
    expect(host.commit).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
    expect(showPage).not.toHaveBeenCalled();
    expect(host.commentChange).toHaveBeenCalledTimes(1);
    const [thread] = pageComments(host.document().pages[0]!);
    expect(thread!.messages[0]!.author).toEqual({ kind: 'agent', name: 'Claude Code' });
    const threadId = thread!.id;
    await runLiveAgentOp(host.session, 'reply_comment', { threadId, body: 'more' });
    await runLiveAgentOp(host.session, 'resolve_comment', { threadId });
    expect(pageComments(host.document().pages[0]!)[0]).toMatchObject({ resolved: true });
    expect(host.commit).not.toHaveBeenCalled();
    const listed = await runLiveAgentOp(host.session, 'list_comments', { includeResolved: true });
    expect((listed.output as { threads: unknown[] }).threads).toHaveLength(1);
  });

  it('a read-only document refuses comment writes but lists comments', async () => {
    const host = await live({ readOnly: true });
    for (const [name, input] of [['add_comment', { point: { x: 0, y: 0 }, body: 'x' }], ['reply_comment', { threadId: 't', body: 'x' }], ['resolve_comment', { threadId: 't' }]] as const) {
      await expect(runLiveAgentOp(host.session, name, input)).rejects.toThrow(READ_ONLY_REFUSAL);
    }
    expect(host.commentChange).not.toHaveBeenCalled();
    await expect(runLiveAgentOp(host.session, 'list_comments', {})).resolves.toMatchObject({ command: null });
  });

  it('a repo-map (locked) page takes comments without redirecting to the drawing', async () => {
    const openDrawing = vi.fn(() => true);
    const host = await live({ lockedPageId: (await drawn()).pages[0]!.id, openDrawing });
    const pageId = host.session().pageId!;
    await runLiveAgentOp(host.session, 'add_comment', { pageId, point: { x: 0, y: 0 }, body: 'on the map' }, pageId);
    expect(openDrawing).not.toHaveBeenCalled();
    expect(host.commentChange).toHaveBeenCalledTimes(1);
  });

  it('a host without commentChange refuses writes', async () => {
    const host = await live({ commentChange: undefined });
    await expect(runLiveAgentOp(host.session, 'add_comment', { point: { x: 0, y: 0 }, body: 'x' })).rejects.toThrow();
  });

  it('a bad thread id surfaces as an error for the agent', async () => {
    const host = await live();
    await expect(runLiveAgentOp(host.session, 'reply_comment', { threadId: 'ghost', body: 'x' })).rejects.toThrow(/ghost/);
    expect(host.commentChange).not.toHaveBeenCalled();
  });
});
