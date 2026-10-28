import type { SceneDocumentV1 } from '@/opencanvas/domain/document/types';
import type { BridgeThreadEvent } from '@/agent/bridge/protocol';
import type { V2DocumentRepository } from './v2Repository';

/** The agent session holding a diagram: its label, and whether the comments sent to it reach its model (a Claude Code channel). */
export interface ServiceHolder {
  readonly label: string;
  readonly channel: boolean;
}

/** What the editor's live sync needs beyond storage: the service's current copy, its event stream, and re-pairing revisions. */
export interface ServiceRepository extends V2DocumentRepository {
  /** The service's copy now, and who holds the diagram. Does not change what this repository expects on the next save. */
  readonly fetchCurrent: (id: string) => Promise<{ readonly document: SceneDocumentV1; readonly revision: number; readonly holder: ServiceHolder | null }>;
  /** The service revision this repository last loaded or saved for the diagram. */
  readonly serviceRevision: (id: string) => number | undefined;
  /** The editor adopted the service's copy at `service` as its own revision `editor`: the next save expects it. */
  readonly adopt: (id: string, editor: number, service: number) => void;
  readonly eventsUrl: (id: string) => string;
  /** Hands a comment to the session holding the diagram; false when none does (409). Throws when the service cannot be reached or refuses. */
  readonly postComment: (id: string, event: BridgeThreadEvent) => Promise<boolean>;
  /** Releases the diagram from the session holding it. */
  readonly disconnect: (id: string) => Promise<void>;
}

export function isServiceRepository(repository: V2DocumentRepository): repository is ServiceRepository {
  return 'eventsUrl' in repository;
}
