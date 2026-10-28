import { useEffect } from 'react';
import type { useDocumentSession } from '../../application/session/useDocumentSession';
import type { SceneDocumentV1 } from '../../domain/document/types';
import type { createV2Repository } from '../../../services/storage/v2/v2Repository';
import type { ToastItem } from '../design-system';
import { useV2DocumentLoad } from './useV2DocumentLoad';
import type { useV2RepoDocument } from './useV2RepoDocument';
import { mayCreateDocument, rememberLastDocument, type V2StartIntent } from './v2Document';
import { downloadRawRecords } from './v2Export';

interface EditorLoadInput {
  readonly id: string | undefined;
  readonly lastOpen: string | null;
  readonly fixed: SceneDocumentV1 | undefined;
  readonly startIntent: V2StartIntent | null;
  readonly repo: ReturnType<typeof useV2RepoDocument>;
  readonly repoReadable: boolean;
  readonly session: ReturnType<typeof useDocumentSession>;
  readonly repository: ReturnType<typeof createV2Repository>;
  readonly pushToast: (toast: ToastItem) => void;
  /** Kept by the local service: a link that finds nothing is not found, never a new document, and is not the one `/` reopens. */
  readonly onService?: boolean;
}

/** Opens the document (stored, new, a repo's map or a shared one) and remembers it as the one `/` lands on. */
export function useV2EditorLoad({ id, lastOpen, fixed, startIntent, repo, repoReadable, session, repository, pushToast, onService = false }: EditorLoadInput) {
  const load = useV2DocumentLoad({
    documentId: id,
    initialize: repo.initialize,
    saveBorn: repoReadable,
    createIfMissing: !onService && (!id || startIntent !== null || mayCreateDocument(id, lastOpen)),
    repository,
    fixed,
    openDocument: session.openDocument,
    // The damaged copy is kept beside the backup: it may hold edits the backup lacks.
    onRecovered: () => pushToast({ id: 'recovered', tone: 'warning', title: 'Recovered from the last good backup',
      ...(id ? { action: { label: 'Download the damaged copy', onClick: () => downloadRawRecords(id, 'damaged-copy') } } : {}) }),
  });
  // Only a document that opened becomes the one `/` lands on: never a link that was not found.
  useEffect(() => { if (id && !onService && load.phase === 'ready' && (repo.source === null || repoReadable)) rememberLastDocument(id); }, [id, onService, load.phase, repo.source, repoReadable]);
  return load;
}
