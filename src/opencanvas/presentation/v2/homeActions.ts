import { renameServiceDiagram } from '../../../services/storage/service/serviceRepository';
import type { V2DocumentRepository, V2DocumentSummary } from '../../../services/storage/v2/v2Repository';

/** Renames a diagram of this browser; a sentence for the user when it cannot be, else null. */
export async function renameLocalDiagram(repository: V2DocumentRepository, id: string, name: string): Promise<string | null> {
  const loaded = await repository.loadDocument(id);
  if (loaded.status !== 'ok') return 'This diagram can only be renamed after it opens cleanly. Open it first.';
  if (!name || loaded.record.document.name === name) return null;
  const saved = await repository.saveDocument(id, { ...loaded.record.document, name }, loaded.record.revision + 1);
  return saved.status === 'saved' ? null : 'That diagram changed in another tab. Reload and try again.';
}

/** Renames a service diagram. An unchanged name is not sent: the service would rewrite the file and move its revision under any open editor. */
export async function renameServiceCard(listed: readonly V2DocumentSummary[] | null, project: string, id: string, name: string): Promise<null> {
  const current = listed?.find((other) => other.id === id && other.project === project)?.name;
  if (name && name !== current) await renameServiceDiagram(project, id, name);
  return null;
}
