import type { SceneDocumentV1 } from '@/opencanvas/domain/document/types';
import type { V2DocumentRepository } from './v2Repository';

/** What the editor's live sync needs beyond storage: the service's current copy, its event stream, and re-pairing revisions. */
export interface ServiceRepository extends V2DocumentRepository {
  readonly project: string;
  /** The service's copy now, and who holds the diagram. Does not change what this repository expects on the next save. */
  readonly fetchCurrent: (id: string) => Promise<{ readonly document: SceneDocumentV1; readonly revision: number; readonly holder: string | null }>;
  /** The service revision this repository last loaded or saved for the diagram. */
  readonly serviceRevision: (id: string) => number | undefined;
  /** The editor adopted the service's copy at `service` as its own revision `editor`: the next save expects it. */
  readonly adopt: (id: string, editor: number, service: number) => void;
  readonly eventsUrl: (id: string) => string;
}

export function isServiceRepository(repository: V2DocumentRepository): repository is ServiceRepository {
  return 'eventsUrl' in repository;
}
