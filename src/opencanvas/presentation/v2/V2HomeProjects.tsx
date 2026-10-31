import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import type { V2DocumentSummary } from '../../../services/storage/v2/v2Repository';
import { DiagramCard } from './V2HomeCards';
import { groupByProject } from './homeLibrary';

interface Renaming { readonly id: string; readonly draft: string; readonly project?: string }

/** The diagrams the local service keeps, one group per project. A card opens under /p/ and can be renamed; nothing else. */
export function HomeProjects({ documents, layout, appearance, renameRef, renaming, onGridKey, onStartRename, onDraft, onCommit, onCancel }: {
  readonly documents: readonly V2DocumentSummary[];
  readonly layout: 'grid' | 'list';
  readonly appearance: 'light' | 'dark';
  readonly renameRef: RefObject<HTMLInputElement | null>;
  readonly renaming: Renaming | null;
  readonly onGridKey: (event: ReactKeyboardEvent<HTMLUListElement>, project: string) => void;
  readonly onStartRename: (id: string, project: string) => void;
  readonly onDraft: (renaming: Renaming) => void;
  readonly onCommit: () => void;
  readonly onCancel: (id: string) => void;
}): React.JSX.Element {
  return (
    <section className="canvas-home-projects" aria-label="Projects">
      {groupByProject(documents).map(({ project, documents: grouped }) => (
        <section key={project} aria-label={`Project ${project}`}>
          <h2 className="canvas-home-project-title">{project}</h2>
          <ul className="canvas-home-grid" data-layout={layout} aria-label={`${project} project`} onKeyDown={(event) => onGridKey(event, project)}>
            {grouped.map((summary) => (
              <DiagramCard key={summary.id} summary={summary} thumbnail={undefined} appearance={appearance} renameRef={renameRef}
                rename={renaming?.id === summary.id && renaming.project === project ? {
                  draft: renaming.draft,
                  onChange: (draft) => onDraft({ id: summary.id, draft, project }),
                  onCommit,
                  onCancel: () => onCancel(summary.id),
                } : null}
                actions={{ onRename: () => onStartRename(summary.id, project) }} />
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
