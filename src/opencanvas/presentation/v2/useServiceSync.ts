import { useCallback, useEffect, useRef, useState } from 'react';
import { areStructurallyEqual } from '../../domain/commands/equality';
import { takeThreads, withoutThreads } from '../../domain/threads/threads';
import type { SceneDocumentV1 } from '../../domain/document/types';
import type { ServiceRepository } from '../../../services/storage/v2/serviceSync';
import type { ToastItem } from '../design-system';
import { NoHolderError, setThreadEventSender } from '../../../agent/bridge/threadEvent';

interface ServiceSyncInput {
  /** Null off the service path (`/d/`): nothing is subscribed. */
  readonly repository: ServiceRepository | null;
  readonly id: string | undefined;
  readonly load: { readonly phase: string; readonly readOnly: boolean; readonly baseRevision: number };
  readonly session: {
    readonly document: SceneDocumentV1 | null;
    readonly revision: number;
    readonly replaceDocument: (document: SceneDocumentV1, label: string) => number | null;
    readonly updateThreads: (change: (document: SceneDocumentV1) => SceneDocumentV1) => number | null;
  };
  /** Edits that have not reached the service: waiting out the debounce, mid-save, or a save that failed or met a 409. */
  readonly unsaved: boolean;
  /** Autosave takes the current copy as saved at this save number, and resumes if a conflict had stopped it. */
  readonly adoptSaved: (saveRevision: number) => void;
  readonly pushToast: (toast: ToastItem) => void;
}

const LABEL = 'Updated from the service';

// Keeps a /p/ tab level with the service. A revision event (another tab, or the agent) and a 409 on save both
// bring in the service's copy as one undoable replace, so undo steps back over it; the save that follows
// expects the revision the copy came with.
export function useServiceSync(input: ServiceSyncInput) {
  const { repository, id } = input;
  const ready = input.load.phase === 'ready' && !input.load.readOnly; // events before that have nothing to replace
  const [holder, setHolder] = useState<string | null>(null);
  const latest = useRef(input);
  useEffect(() => { latest.current = input; });
  /** One read at a time; an event that lands meanwhile makes it read once more. */
  const running = useRef(false);
  const again = useRef(false);
  /** A 409 that landed while a read was running: the next pass is the conflict's, with its toast. */
  const pendingConflict = useRef(false);

  const sync = useCallback(async (conflict: boolean): Promise<void> => {
    if (running.current) { again.current = true; pendingConflict.current ||= conflict; return; }
    running.current = true;
    let resume = conflict;
    try {
      do {
        again.current = false;
        resume ||= pendingConflict.current;
        pendingConflict.current = false;
        const { repository: repo, id: diagramId } = latest.current;
        if (!repo || !diagramId) return;
        const current = await repo.fetchCurrent(diagramId);
        setHolder(current.holder);
        const now = latest.current;
        // The tab's own save came back as an event, or an earlier read already took this copy.
        if (!resume && current.revision <= (repo.serviceRevision(diagramId) ?? 0)) continue;
        // Unsaved edits are not dropped by an event: their save meets a 409, which takes the copy and says so.
        if (!resume && now.unsaved) continue;
        const local = now.session.document;
        const shapesSame = local !== null && areStructurallyEqual(withoutThreads(local), withoutThreads(current.document));
        const same = shapesSame && areStructurallyEqual(local, current.document);
        if (same && !resume) continue;
        // A comment from elsewhere changes no shape: it joins without an undo step.
        const sessionRevision = same ? now.session.revision
          : shapesSame ? now.session.updateThreads((document) => takeThreads(document, current.document))
            : now.session.replaceDocument(current.document, LABEL);
        if (sessionRevision === null) return;
        const saveRevision = now.load.baseRevision + sessionRevision;
        repo.adopt(diagramId, saveRevision, current.revision);
        now.adoptSaved(saveRevision);
        if (resume) now.pushToast({ id: 'service-updated', tone: 'info', title: LABEL });
        resume = false;
      } while (again.current);
    } catch (error) {
      // The next event or save tries again; a failed read must not become an uncaught page error.
      console.warn('Could not take the service copy', error);
    } finally {
      running.current = false;
    }
  }, []);

  useEffect(() => {
    if (!repository || !id || !ready) return;
    const source = new EventSource(repository.eventsUrl(id));
    source.addEventListener('revision', () => { void sync(false); });
    // Opening (also after a reconnect) catches up on what was missed while the stream was down, and learns the holder.
    source.addEventListener('open', () => { void sync(false); });
    source.addEventListener('holder', (event) => {
      try {
        const { label } = JSON.parse((event as MessageEvent<string>).data) as { label?: unknown };
        const next = typeof label === 'string' ? label : label === null ? null : undefined;
        if (next !== undefined) setHolder(next);
      } catch (error) {
        console.warn('Ignored a malformed holder event', error);
      }
    });
    return () => source.close();
  }, [repository, id, ready, sync]);

  // Comments go to the session holding this diagram. The sender is set while the tab is on the service; a 409 means nobody holds it.
  useEffect(() => {
    if (!repository || !id) return;
    setThreadEventSender(async (event) => { if (!(await repository.postComment(id, event))) throw new NoHolderError(); });
    return () => setThreadEventSender(null);
  }, [repository, id]);

  /** The holder is cleared by the service's own event; a failure says so, since the badge would otherwise stay. */
  const disconnect = useCallback(async (): Promise<void> => {
    const { repository: repo, id: diagramId } = latest.current;
    if (!repo || !diagramId) return;
    try {
      await repo.disconnect(diagramId);
      setHolder(null);
    } catch (error) {
      latest.current.pushToast({ id: 'service-disconnect', tone: 'danger', title: 'Couldn’t disconnect', description: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  /** Autosave met a 409: the service holds something newer. */
  const onConflict = useCallback(() => { void sync(true); }, [sync]);
  return { holder, onConflict, disconnect };
}
