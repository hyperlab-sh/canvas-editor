import { useCallback, useEffect, useRef, useState } from 'react';
import { areStructurallyEqual } from '../../domain/commands/equality';
import { takeThreads, withoutThreads } from '../../domain/threads/threads';
import type { SceneDocumentV1 } from '../../domain/document/types';
import type { ServiceRepository } from '../../../services/storage/v2/serviceSync';
import type { ToastItem } from '../design-system';

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
  /** Autosave takes the current copy as saved at this save number, and resumes if a conflict had stopped it. */
  /** Edits not yet saved (waiting out the debounce, or mid-save). */
  readonly unsaved: boolean;
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

  const sync = useCallback(async (conflict: boolean): Promise<void> => {
    if (running.current) { again.current = true; return; }
    running.current = true;
    let resume = conflict;
    try {
      do {
        again.current = false;
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

  /** Autosave met a 409: the service holds something newer. */
  const onConflict = useCallback(() => { void sync(true); }, [sync]);
  return { holder, onConflict };
}
