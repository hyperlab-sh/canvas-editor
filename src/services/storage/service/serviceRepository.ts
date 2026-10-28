import type { SceneDocumentV1 } from '@/opencanvas/domain/document/types';
import { V2DocumentInvalidError, V2StorageError, V2StorageUnavailableError } from '../v2/v2Errors';
import type { ServiceRepository } from '../v2/serviceSync';
import type { V2DocumentRecord, V2DocumentSummary, LoadV2DocumentResult } from '../v2/v2Repository';
import { SERVICE_ORIGIN } from './origin';

interface ServiceDiagram { readonly id: string; readonly title: string; readonly modifiedAt: string }
interface ServiceProject { readonly name: string; readonly diagrams: readonly ServiceDiagram[] }

const unsupported = (what: string): never => {
  throw new V2StorageError(`${what} is not available for diagrams kept by the local service.`);
};

/** What the service said went wrong, in its words; falls back to the status. */
async function failure(response: Response, action: string): Promise<V2StorageError> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  const detail = typeof body?.error === 'string' ? body.error : `it answered ${response.status}`;
  return new V2StorageError(`The local service could not ${action} the diagram: ${detail}`);
}

/**
 * Documents of one service project, over the service's HTTP API.
 * The service's revisions are its own counter; the editor numbers its saves itself. `known` pairs the two
 * for the revision this repository last saw per document, so the editor's "expected" becomes the service's.
 */
export function createServiceRepository(project: string, origin: string = SERVICE_ORIGIN): ServiceRepository {
  const known = new Map<string, { readonly editor: number; readonly service: number }>();
  const diagramUrl = (id: string): string => `${origin}/projects/${encodeURIComponent(project)}/diagrams/${encodeURIComponent(id)}`;

  const send = async (url: string, init?: RequestInit): Promise<Response> => {
    try {
      return await fetch(url, init);
    } catch (error) {
      throw new V2StorageUnavailableError(`The local service is not reachable at ${origin}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const record = (id: string, document: SceneDocumentV1, revision: number): V2DocumentRecord =>
    ({ id, revision, schemaVersion: document.schemaVersion, document, savedAt: document.updatedAt });

  return {
    eventsUrl: (id) => `${origin}/events?project=${encodeURIComponent(project)}&id=${encodeURIComponent(id)}`,
    serviceRevision: (id) => known.get(id)?.service,
    adopt: (id, editor, service) => { known.set(id, { editor, service }); },
    fetchCurrent: async (id) => {
      const response = await send(diagramUrl(id));
      if (!response.ok) throw await failure(response, 'reload');
      const { document, revision, holder } = await response.json() as { document: SceneDocumentV1; revision: number; holder?: string | null };
      return { document, revision, holder: holder ?? null };
    },
    loadDocument: async (id): Promise<LoadV2DocumentResult> => {
      const response = await send(diagramUrl(id));
      if (response.status === 404) return { status: 'missing' };
      if (!response.ok) throw await failure(response, 'open');
      const { document, revision } = await response.json() as { document: SceneDocumentV1; revision: number };
      known.set(id, { editor: revision, service: revision });
      // The service parses every file before it answers, so what arrives is a current document.
      return { status: 'ok', record: record(id, document, revision) };
    },

    saveDocument: async (id, document, revision, expectedRevision = revision - 1) => {
      const seen = known.get(id);
      // The editor's count and the service's differ; with no pairing for this revision there is nothing safe to send.
      if (!seen || seen.editor !== expectedRevision) {
        throw new V2StorageError('Open the diagram again before saving it: this tab no longer knows which revision the service holds.');
      }
      const response = await send(diagramUrl(id), {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document, revision: seen.service }),
      });
      if (response.status === 409) {
        const { revision: storedRevision } = await response.json() as { revision: number };
        return { status: 'stale', storedRevision };
      }
      if (response.status === 400) {
        const { error } = await response.json().catch(() => ({})) as { error?: unknown };
        throw new V2DocumentInvalidError({ path: '$', message: typeof error === 'string' ? error : 'the service refused the document' });
      }
      if (!response.ok) throw await failure(response, 'save');
      const { revision: service } = await response.json() as { revision: number };
      known.set(id, { editor: revision, service });
      return { status: 'saved', record: record(id, document, revision) };
    },

    listDocuments: async () => {
      const response = await send(`${origin}/projects`);
      if (!response.ok) throw await failure(response, 'list');
      const projects = await response.json() as readonly ServiceProject[];
      // The listing reads only a file's head, so what the summary needs from the pages stays empty.
      return projects.flatMap(({ name, diagrams }): V2DocumentSummary[] => diagrams.map((diagram) => ({
        id: diagram.id, name: diagram.title, savedAt: diagram.modifiedAt, pageCount: 0, pageIds: [], searchText: '', project: name,
      }))).sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
    },

    listArchive: async () => [],
    archiveDocuments: async () => unsupported('Archiving'),
    restoreDocuments: async () => unsupported('Restoring'),
    deleteDocument: async () => unsupported('Deleting'),
    saveThumbnail: async () => undefined,
    listThumbnails: async () => new Map(),
  };
}
