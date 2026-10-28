import { describe, expect, it } from 'vitest';
import type { DocumentCommand } from '../../domain/commands/types';
import { addThread } from '../../domain/threads/threads';
import { createTestDocument, createTestNode } from '../../testing/builders/documentBuilder';
import {
  StaleSessionRevisionError,
  commitSessionCommand,
  createDocumentSession,
  forgetSessionHistory,
  redoSessionCommand,
  replaceSessionDocument,
  undoSessionCommand,
} from './session';

function renameCommand(previousLabel = 'node-1', nextLabel = 'Renamed'): DocumentCommand {
  const before = createTestNode('node-1', { content: { label: previousLabel } });
  return {
    kind: 'set-node',
    id: 'rename-node:node-1',
    label: 'Rename node',
    pageId: 'page-1',
    before,
    after: { ...before, content: { label: nextLabel } },
  };
}

function session() {
  return createDocumentSession(createTestDocument({ nodes: [createTestNode('node-1')] }));
}

describe('revisioned document session', () => {
  it('starts at revision zero', () => {
    const initial = session();
    expect(initial.revision).toBe(0);
    expect(initial.document).toBe(initial.history.present);
  });

  it('increments the revision on every commit', () => {
    const committed = commitSessionCommand(session(), renameCommand(), 0);
    expect(committed.revision).toBe(1);
    expect(committed.document.pages[0].nodes[0].content.label).toBe('Renamed');
    const again = commitSessionCommand(committed, renameCommand('Renamed', 'Renamed again'), 1);
    expect(again.revision).toBe(2);
  });

  it('rejects a stale commit without touching the session', () => {
    const committed = commitSessionCommand(session(), renameCommand(), 0);
    expect(() => commitSessionCommand(committed, renameCommand('Renamed', 'Again'), 0)).toThrow(
      StaleSessionRevisionError
    );
    try {
      commitSessionCommand(committed, renameCommand('Renamed', 'Again'), 0);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StaleSessionRevisionError);
      expect((error as StaleSessionRevisionError).expectedRevision).toBe(0);
      expect((error as StaleSessionRevisionError).actualRevision).toBe(1);
    }
    expect(committed.revision).toBe(1);
    expect(committed.document.pages[0].nodes[0].content.label).toBe('Renamed');
  });

  it('treats undo and redo as new commits that move the revision forward', () => {
    const initial = session();
    const committed = commitSessionCommand(initial, renameCommand(), 0);
    const undone = undoSessionCommand(committed, 1);
    expect(undone.revision).toBe(2);
    expect(undone.document).toEqual(initial.document);
    const redone = redoSessionCommand(undone, 2);
    expect(redone.revision).toBe(3);
    expect(redone.document).toEqual(committed.document);
  });

  it('rejects stale undo and redo', () => {
    const committed = commitSessionCommand(session(), renameCommand(), 0);
    expect(() => undoSessionCommand(committed, 0)).toThrow(StaleSessionRevisionError);
    const undone = undoSessionCommand(committed, 1);
    expect(() => redoSessionCommand(undone, 1)).toThrow(StaleSessionRevisionError);
  });

  it('leaves the session untouched when undo or redo has nothing to do', () => {
    const initial = session();
    expect(undoSessionCommand(initial, 0)).toBe(initial);
    expect(redoSessionCommand(initial, 0)).toBe(initial);
  });

  it('forgets history without moving the document or revision: a template is where the document starts', () => {
    const committed = commitSessionCommand(session(), renameCommand(), 0);
    const started = forgetSessionHistory(committed);
    expect(started.document).toBe(committed.document);
    expect(started.revision).toBe(committed.revision);
    expect(undoSessionCommand(started, started.revision)).toBe(started);
  });

  it('keeps history when another step landed beside the template (an edit while it generated)', () => {
    const edited = commitSessionCommand(session(), renameCommand(), 0);
    const both = commitSessionCommand(edited, renameCommand('Renamed', 'Again'), edited.revision);
    expect(forgetSessionHistory(both)).toBe(both);
  });

  describe('replaceSessionDocument', () => {
    const incoming = () => createTestDocument({ nodes: [createTestNode('node-1'), createTestNode('node-2')] });

    it('is one undo step: undo restores the previous document, redo re-applies, the revision moves forward each time', () => {
      const initial = session();
      const replaced = replaceSessionDocument(initial, incoming(), 'Updated from the service', 0);
      expect(replaced.revision).toBe(1);
      expect(replaced.document.pages[0].nodes.map((node) => node.id)).toEqual(['node-1', 'node-2']);
      expect(replaced.history.past).toHaveLength(1);

      const undone = undoSessionCommand(replaced, 1);
      expect(undone.revision).toBe(2);
      expect(undone.document).toEqual(initial.document);

      const redone = redoSessionCommand(undone, 2);
      expect(redone.revision).toBe(3);
      expect(redone.document).toEqual(replaced.document);
    });

    it('carries the threads this tab has across the replace, undo and redo', () => {
      const withThread = addThread(session().document, {
        pageId: 'page-1', threadId: 't1', nodeId: null, point: { x: 10, y: 10 },
        comment: { id: 'c1', author: { kind: 'human', name: 'Ann' } as never, body: 'look here', createdAt: '2026-01-01T00:00:00.000Z' },
      });
      const start = createDocumentSession(withThread);
      const threadIds = (document: typeof withThread) => (document.pages[0].threads ?? []).map((thread) => thread.id);

      const replaced = replaceSessionDocument(start, incoming(), 'Updated from the service', 0);
      expect(threadIds(replaced.document)).toEqual(['t1']);
      const undone = undoSessionCommand(replaced, 1);
      expect(threadIds(undone.document)).toEqual(['t1']);
      expect(threadIds(redoSessionCommand(undone, 2).document)).toEqual(['t1']);
    });

    it('rejects a stale expected revision', () => {
      expect(() => replaceSessionDocument(session(), incoming(), 'x', 5)).toThrow(StaleSessionRevisionError);
    });
  });
});
