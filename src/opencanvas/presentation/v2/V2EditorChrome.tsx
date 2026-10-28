import type { MutableRefObject } from 'react';
import type { useDocumentSession } from '../../application/session/useDocumentSession';
import type { DocumentCommand } from '../../domain/commands/types';
import type { PixiRendererStatus } from '../../infrastructure/pixi/PixiRendererHost';
import type { ToastItem } from '../design-system';
import { V2Chrome } from './V2Chrome';
import type { V2Tool } from './V2CreationToolbar';
import type { useV2MapMode } from './map/useV2MapMode';
import type { useV2Architecture } from './useV2Architecture';
import type { useV2ArchitectureActions } from './useV2ArchitectureActions';
import type { useV2Camera } from './useV2Camera';
import type { useV2EditorInput } from './useV2EditorInput';
import type { useV2ExportPanel } from './useV2ExportPanel';
import type { useV2Pages } from './useV2Pages';
import type { useV2Panels } from './useV2Panels';
import type { useV2Preferences } from './useV2Preferences';
import type { useV2RepoDocument, useV2RepoPanel } from './useV2RepoDocument';
import type { useV2WorkspaceFolder } from './useV2WorkspaceFolder';
import type { V2GestureApi } from './v2PointerGestures';
import type { V2ToolConfig } from './v2ToolCatalog';

interface EditorChromeProps {
  /** On a service diagram: the session holding it, and the way to release it. */
  readonly holder?: { readonly label: string | null; readonly onDisconnect: () => void };
  readonly session: ReturnType<typeof useDocumentSession>;
  readonly pageId: string;
  readonly pages: ReturnType<typeof useV2Pages>;
  readonly preferences: ReturnType<typeof useV2Preferences>['preferences'];
  readonly updatePreferences: ReturnType<typeof useV2Preferences>['updatePreferences'];
  readonly canvasDefaultColor: string;
  readonly saveStatus: React.ComponentProps<typeof V2Chrome>['saveStatus'];
  readonly retrySave: () => void;
  readonly reload: () => void;
  readonly docReadOnly: boolean;
  readonly loadReadOnly: boolean;
  readonly rendererStatus: PixiRendererStatus;
  readonly tool: V2Tool;
  readonly toolConfig: V2ToolConfig;
  readonly camera: ReturnType<typeof useV2Camera>;
  readonly panels: ReturnType<typeof useV2Panels>;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly pushToast: (toast: ToastItem) => void;
  readonly workspaceFolder: ReturnType<typeof useV2WorkspaceFolder>;
  readonly architecture: ReturnType<typeof useV2Architecture>;
  readonly architectureActions: ReturnType<typeof useV2ArchitectureActions>;
  readonly map: ReturnType<typeof useV2MapMode>;
  readonly repo: ReturnType<typeof useV2RepoDocument>;
  readonly repoSource: ReturnType<typeof useV2RepoDocument>['source'];
  readonly repoPanel: ReturnType<typeof useV2RepoPanel>;
  readonly repoReadable: boolean;
  readonly repoDrawing: boolean;
  readonly backTo: string | null;
  readonly backToMap: () => boolean;
  readonly pinRef: MutableRefObject<() => void>;
  readonly pinnable: boolean;
  readonly shared: { readonly onEdit: () => Promise<void> } | undefined;
  readonly exportPanel: ReturnType<typeof useV2ExportPanel>;
  readonly commit: (command: DocumentCommand) => void;
  readonly leaveStart: <A extends unknown[], R>(action: (...args: A) => R) => (...args: A) => R;
  readonly setTool: (tool: V2Tool) => void;
  readonly pickShape: React.ComponentProps<typeof V2Chrome>['onPickShape'];
  readonly pickConnector: React.ComponentProps<typeof V2Chrome>['onPickConnector'];
  readonly gestureApiRef: MutableRefObject<V2GestureApi | null>;
  readonly input: ReturnType<typeof useV2EditorInput>;
  readonly fitAll: () => void;
}

/** The editor's chrome (bars, toolbars, rail): what each control does, bound to this editor's state. */
export function V2EditorChrome(p: EditorChromeProps): React.JSX.Element {
  const { session, map, repo, repoSource, repoPanel, preferences, workspaceFolder, panels, camera, input, leaveStart, exportPanel, shared } = p;
  return (
    <V2Chrome
      preferences={preferences} canvasDefaultColor={p.canvasDefaultColor}
      onPreferencesChange={p.updatePreferences}
      document={session.document!}
      pages={p.pages}
      pageId={p.pageId}
      saveStatus={p.saveStatus}
      canUndo={session.canUndo} canRedo={session.canRedo}
      readOnly={p.docReadOnly} canvasUnavailable={p.rendererStatus === 'unavailable'}
      tool={p.tool} zoomPercent={camera.zoom} treeOpen={panels.treeOpen}
      onUndo={p.undo} onRedo={p.redo}
      onRetrySave={p.retrySave} onReload={p.reload} onToast={p.pushToast}
      {...(p.holder ? { holder: p.holder } : {})}
      workspace={{
        name: workspaceFolder.folder?.name ?? null,
        onOpenFolder: () => { void workspaceFolder.openFolder(); },
        onCloseFolder: workspaceFolder.closeFolder,
      }}
      breadcrumb={p.architecture.breadcrumb}
      {...(repoPanel.drawn && !map.start ? { mapToolbar: { ...map.toolbar, ...(p.loadReadOnly ? {} : { onPin: () => p.pinRef.current(), canPin: p.pinnable }) } } : {})}
      {...(p.backTo ? { mapMode: { mode: 'canvas' as const, onChange: (next: 'canvas' | 'map') => { if (next === 'map') p.backToMap(); } } }
        // A repo that could not be read (or has nothing to map) has no drawing to switch to.
        // A drawing made earlier keeps its way in whatever the read does (offline, a limit).
        : map.available && (p.repoDrawing || !(repoSource && (repo.state.status === 'problem' || (repo.state.status === 'ready' && !p.repoReadable))))
          ? { mapMode: { mode: map.mode, onChange: map.choose } } : {})}
      mapStart={map.start}
      {...(map.active ? { mapPath: map.path, onMapPath: map.reveal } : {})}
      onCrumb={(crumb) => p.architectureActions.openCrumb(crumb)}
      {...(shared ? { onEditShared: shared.onEdit } : {})}
      onOpenExport={(anchor) => exportPanel.openExport(anchor, 'page')}
      {...(shared ? {} : { onOpenShare: (anchor: HTMLElement | null) => exportPanel.openExport(anchor, 'page', 'menu-share') })}
      onDismissExport={() => exportPanel.setExportOpen(false)}
      onRename={(name) => {
        const before = session.document!.name;
        if (name === before) return;
        p.commit({
          kind: 'set-document-name',
          id: `rename-document:${session.document!.id}`,
          label: 'Rename document',
          before,
          after: name,
        });
      }}
      onToolChange={leaveStart(p.setTool)}
      toolConfig={p.toolConfig}
      onPickShape={leaveStart(p.pickShape)}
      onPlaceShape={(shape, square) => p.gestureApiRef.current?.placeShape(input.media.centreWorld(), shape, square)}
      onPickConnector={leaveStart(p.pickConnector)}
      iconsOpen={input.iconLibrary.open} onIconsOpenChange={input.iconLibrary.setOpen} onInsertIcon={leaveStart(input.iconLibrary.insertIcon)}
      onInsertImage={leaveStart(input.pickImageFile)} onPickEmoji={leaveStart(input.pickEmoji)}
      recentEmoji={preferences.recentEmoji} librarySection={input.librarySection}
      moreOpen={input.moreOpen} onMoreOpenChange={input.setMoreOpen} onPickMore={leaveStart(input.inserts.pickMore)}
      onZoomIn={() => camera.zoomStep(1.2)}
      onZoomOut={() => camera.zoomStep(1 / 1.2)}
      onZoomTo={camera.zoomTo}
      onFitView={p.fitAll}
      onToggleTree={panels.toggleTree}
    />
  );
}
