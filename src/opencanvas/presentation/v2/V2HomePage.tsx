import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { IconAlertTriangle, IconArchive, IconStar } from '@tabler/icons-react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { HomeNotice } from './V2LegacyRoutes';
import { Button, EmptyState, ErrorState, Icon, SystemRoot, ToastRegion, withToast, type ToastItem } from '../design-system';
import { CommandPalette } from '../design-system/CommandPalette';
import { createV2Repository, type V2DocumentSummary, type V2Thumbnail } from '../../../services/storage/v2/v2Repository';
import { listServiceDocuments } from '../../../services/storage/service/serviceRepository';
import { describeStorageFailure } from '../../../services/storage/v2/v2Errors';
import { plainImportFailure } from '../../domain/document/legacyWorkspace';
import { readV1ImportMarker, runV1Import } from '../../../services/storage/v2/v1Import';
import { buildV2Thumbnail } from './v2Thumbnail';
import { STARTER_TEMPLATES } from '../../../agent/starterTemplates';
import { forgetMapMode } from './map/mapDepth';
import { mapRepoPath, MapRepoForm, repoToMap } from './map/V2MapStart';
import { isEditableTarget } from './pointerOperations';
import { forgetLastDocument, forgetPageId, mintV2Id, type V2StartIntent } from './v2Document';
import { DiagramCard, HomeNoticeStrip, SkeletonCard, StartChip, ArchivedCard, type CardSelection } from './V2HomeCards';
import { V2StateHero } from './V2StateHero';
import { V2ProWaitlist, joinedProPlan } from './V2ProWaitlist';
import { HOME_NEWS } from './homeNews';
import { arrange, copyName, gridStep, parseView, selectRange, toggleId, useHomeState, type HomeView } from './homeLibrary';
import { SORTS, STARTS, VIEWS, plural, typing, viewLink } from './homeConfig';
import { buildHomeCommands } from './homeCommands';
import { downloadAllDiagrams, importHomeFiles, type HomeTransfer } from './homeTransfer';
import { renameLocalDiagram, renameServiceCard } from './homeActions';
import { HomeProjects } from './V2HomeProjects';
import { V2HomeSidebar } from './V2HomeSidebar';
import { V2HomeHeader } from './V2HomeHeader';
import { HomeDeleteDialog, HomeDropOverlay, HomeKeysDialog, HomeSelectionBar } from './V2HomeOverlays';
import { HomeFirstRun, HomeNews, HomeNoMatch, HomeTemplateGrid } from './V2HomeViews';
import { useV2Appearance } from './useV2Appearance';
import { useV2Preferences } from './useV2Preferences';
import './v2EditorPage.css';
import './v2Home.css';

/** Home: a sidebar of views and one quiet, keyboard-first list of the diagrams in this browser. */
export function V2HomePage(): React.JSX.Element {
  const { preferences, updatePreferences } = useV2Preferences();
  const appearance = useV2Appearance(preferences.theme);
  const [home, updateHome] = useHomeState();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const view = parseView(params.get('view'));
  const repository = useMemo(() => createV2Repository(window.indexedDB), []);
  const [documents, setDocuments] = useState<readonly V2DocumentSummary[] | null>(null);
  // Diagrams kept by the local service, when one answers; null otherwise and Home shows nothing of it.
  const [serviceDocuments, setServiceDocuments] = useState<readonly V2DocumentSummary[] | null>(null);
  const [archive, setArchive] = useState<readonly V2DocumentSummary[] | null>(null);
  const [thumbnails, setThumbnails] = useState<ReadonlyMap<string, V2Thumbnail | null>>(new Map());
  const [thumbnailsListed, setThumbnailsListed] = useState(false);
  const previewed = useRef(new Set<string>());
  // An old link that found nothing, or an opened backup, arrives with a notice in router state;
  // clear it so a reload or Back does not show it again.
  const location = useLocation();
  const [notice, setNotice] = useState<HomeNotice | null>(() => {
    const arrived = location.state as Partial<HomeNotice> | null;
    return typeof arrived?.notice === 'string' ? { tone: 'info', ...arrived, notice: arrived.notice } : null;
  });
  const [listError, setListError] = useState<ReturnType<typeof describeStorageFailure> | null>(null);
  // A GitHub address pasted anywhere on Home (not into a field) opens its map: the shortest way to a repo's picture.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const text = event.clipboardData?.getData('text/plain').trim() ?? '';
      const ref = /github\.com/i.test(text) ? repoToMap(text) : null;
      if (!ref) return;
      event.preventDefault();
      navigate(mapRepoPath(ref));
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [navigate]);
  useEffect(() => {
    if (location.state) navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [location.state, location.pathname, location.search, navigate]);
  const [renaming, setRenaming] = useState<{ id: string; draft: string; project?: string } | null>(null);
  /** Deleting for good always asks first. */
  const [deleting, setDeleting] = useState<readonly V2DocumentSummary[] | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<readonly string[]>([]);
  const anchor = useRef<string | null>(null);
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const [open, setOpen] = useState<'sort' | 'palette' | 'keys' | 'pro' | null>(null);
  const [proJoined, setProJoined] = useState(() => joinedProPlan() !== null);
  const [dragging, setDragging] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const renameCancelled = useRef(false);
  const failed = Object.entries(readV1ImportMarker()?.docs ?? {}).filter(([, entry]) => entry.status === 'failed');

  const toast = useCallback((item: Omit<ToastItem, 'id'>) =>
    setToasts((current) => withToast(current, { id: `home-${Date.now()}-${Math.random()}`, ...item })), []);
  const setProblem = (text: string) => setNotice({ notice: text, tone: 'danger' });
  const fail = (error: unknown) => toast({ tone: 'danger', title: describeStorageFailure(error).message });
  const refresh = useCallback(() => {
    repository.listDocuments().then((listed) => { setListError(null); setDocuments(listed); },
      (error: unknown) => setListError(describeStorageFailure(error)));
    repository.listArchive().then(setArchive, () => setArchive([]));
    // No service, or one that answers badly, is not an error: there is just no Projects section.
    listServiceDocuments().then(setServiceDocuments, () => setServiceDocuments(null));
    // A preview that fails to load is a placeholder, never an error.
    repository.listThumbnails().then((listed) => { setThumbnails(listed); setThumbnailsListed(true); }, () => undefined);
  }, [repository]);
  // List at once, and again when a v1 import still running on this load lands.
  useEffect(() => {
    refresh();
    runV1Import().then(refresh, () => undefined);
  }, [repository, refresh]);
  // An editor save draws a card's preview; a diagram brought over from v1 has had none, so draw them
  // here, one at a time, once each. A failure leaves the placeholder.
  useEffect(() => {
    if (!documents || !thumbnailsListed) return;
    const todo = documents.filter(({ id }) => id.startsWith('v1-') && !thumbnails.has(id) && !previewed.current.has(id));
    todo.forEach(({ id }) => previewed.current.add(id));
    void (async () => {
      for (const { id } of todo) {
        try {
          const loaded = await repository.loadDocument(id);
          if (loaded.status !== 'ok' && loaded.status !== 'recovered') continue;
          const thumbnail = await buildV2Thumbnail(loaded.record.document);
          await repository.saveThumbnail(id, thumbnail);
          setThumbnails((current) => new Map(current).set(id, thumbnail));
        } catch { /* the placeholder stays */ }
      }
    })();
  }, [documents, thumbnails, thumbnailsListed, repository]);
  useEffect(() => { renameRef.current?.select(); }, [renaming?.id]);
  // Visiting What's new is what reads it.
  useEffect(() => {
    if (view === 'news' && home.newsSeen !== HOME_NEWS[0].title) updateHome({ newsSeen: HOME_NEWS[0].title });
  }, [view, home.newsSeen, updateHome]);
  // A selection belongs to the view it was made in.
  useEffect(() => { setSelected([]); anchor.current = null; }, [view]);

  const create = useCallback((intent?: V2StartIntent) =>
    navigate(`/d/${mintV2Id('doc')}`, intent ? { state: intent } : undefined), [navigate]);

  const shown = useMemo(() => {
    // Templates and What's new show no diagrams, so ⌘A and the arrows have nothing to act on.
    if (view === 'templates' || view === 'news') return [];
    if (view === 'archive') return archive ? arrange(archive, { view: 'recents', starred: [], query, sort: 'edited' }) : null;
    return documents ? arrange(documents, { view, starred: home.starred, query, sort: home.sort }) : null;
  }, [view, archive, documents, home.starred, home.sort, query]);
  const serviceShown = useMemo(() => {
    const matching = view === 'recents' && serviceDocuments ? arrange(serviceDocuments, { view, starred: [], query, sort: home.sort }) : [];
    return matching.length ? matching : null;
  }, [view, serviceDocuments, query, home.sort]);
  const shownIds = useMemo(() => (shown ?? []).map(({ id }) => id), [shown]);
  const byId = useMemo(() => new Map([...(documents ?? []), ...(archive ?? [])].map((summary) => [summary.id, summary])), [documents, archive]);
  const starredDocs = (documents ?? []).filter(({ id }) => home.starred.includes(id));

  // Keyboard focus follows the card it acted on, or "New diagram" once the card is gone.
  const focusAfter = (id: string | null) => requestAnimationFrame(() =>
    (document.querySelector<HTMLElement>(id ? `[data-doc-id="${id}"]` : '[data-home-new]'))?.focus());
  /** The card to land on once `ids` leave the list: the next one still shown, else the previous. */
  const survivor = (ids: readonly string[]) => {
    const index = shownIds.findIndex((id) => ids.includes(id));
    return shownIds.slice(index).find((id) => !ids.includes(id)) ?? shownIds.slice(0, index).reverse().find((id) => !ids.includes(id)) ?? null;
  };

  async function commitRename(): Promise<void> {
    if (!renaming || renameCancelled.current) return;
    const { id, draft, project } = renaming;
    const name = draft.trim();
    setRenaming(null);
    try {
      const problem = project === undefined ? await renameLocalDiagram(repository, id, name) : await renameServiceCard(serviceDocuments, project, id, name);
      if (problem) setProblem(problem);
    } catch (error) {
      fail(error);
    }
    refresh();
    focusAfter(id);
  }
  const startRename = (id: string, project?: string) => {
    const summary = project === undefined ? byId.get(id) : serviceShown?.find((other) => other.id === id && other.project === project);
    if (!summary || view === 'archive') return;
    renameCancelled.current = false;
    setRenaming({ id, draft: summary.name, project });
  };

  async function duplicate(summary: V2DocumentSummary): Promise<void> {
    const id = mintV2Id('doc');
    try {
      const loaded = await repository.loadDocument(summary.id);
      if (loaded.status !== 'ok' && loaded.status !== 'recovered') {
        setProblem('This diagram can only be duplicated after it opens cleanly. Open it first.');
        return;
      }
      const now = new Date().toISOString();
      const name = copyName(summary.name, (documents ?? []).map((other) => other.name));
      await repository.saveDocument(id, { ...loaded.record.document, id, name, createdAt: now, updatedAt: now }, 1);
      const thumbnail = thumbnails.get(summary.id);
      if (thumbnail) await repository.saveThumbnail(id, thumbnail).catch(() => undefined);
    } catch (error) {
      fail(error);
    }
    refresh();
    focusAfter(id);
  }

  const toggleStars = (ids: readonly string[]) => {
    const all = ids.every((id) => home.starred.includes(id));
    updateHome({ starred: all ? home.starred.filter((id) => !ids.includes(id)) : [...home.starred, ...ids.filter((id) => !home.starred.includes(id))] });
  };

  async function archiveIds(ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    const next = survivor(ids);
    const name = byId.get(ids[0]!)?.name ?? 'Diagram';
    try {
      await repository.archiveDocuments(ids);
      ids.forEach((id) => { forgetLastDocument(id); forgetMapMode(id); forgetPageId(id); });
      toast({
        title: ids.length === 1 ? `“${name}” archived` : `${plural(ids.length, 'diagram')} archived`,
        action: { label: 'Undo', onClick: () => void restore(ids, false) },
      });
    } catch (error) {
      fail(error);
    }
    setSelected([]);
    refresh();
    focusAfter(next);
  }

  async function restore(ids: readonly string[], announce = true): Promise<void> {
    const next = view === 'archive' ? survivor(ids) : ids[0] ?? null;
    try {
      await repository.restoreDocuments(ids);
      if (announce) toast({ tone: 'success', title: `${plural(ids.length, 'diagram')} restored`, action: { label: 'Show', onClick: () => navigate(viewLink('recents')) } });
    } catch (error) {
      fail(error);
    }
    setSelected([]);
    refresh();
    focusAfter(next);
  }

  async function confirmDelete(): Promise<void> {
    if (!deleting) return;
    const ids = deleting.map(({ id }) => id);
    const next = survivor(ids);
    setDeleting(null);
    try {
      for (const id of ids) await repository.deleteDocument(id);
    } catch (error) {
      fail(error);
    }
    if (ids.some((id) => home.starred.includes(id))) updateHome({ starred: home.starred.filter((id) => !ids.includes(id)) });
    setSelected([]);
    refresh();
    focusAfter(next);
  }

  const transfer: HomeTransfer = { repository, toast, fail, create, refresh, setThumbnails };
  const importFiles = (files: readonly File[]) => importHomeFiles(transfer, files);

  const select = (id: string, range: boolean) => {
    if (range) setSelected((current) => [...new Set([...current, ...selectRange(shownIds, anchor.current, id)])]);
    else setSelected((current) => toggleId(current, id));
    if (!range) anchor.current = id;
  };
  const selectionFor = (id: string): CardSelection => ({
    selected: selected.includes(id), active: selected.length > 0, onToggle: (range) => select(id, range),
  });
  /** What a key acts on: the selection when the focused card is part of it, else just that card. */
  const targets = (id: string) => (selected.includes(id) ? selected : [id]);

  // Page shortcuts: N new, / filter, ⌘K find anything, ⌘A select all, Delete, Escape, ? the list of keys.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => (current === 'palette' ? null : 'palette'));
        return;
      }
      if (typing(event.target) || deleting || open === 'palette' || open === 'keys') return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && shownIds.length) {
        event.preventDefault();
        setSelected(shownIds);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'Escape' && selected.length) { setSelected([]); return; }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selected.length) {
        event.preventDefault();
        if (view === 'archive') setDeleting(selected.flatMap((id) => byId.get(id) ?? []));
        else void archiveIds(selected);
        return;
      }
      if (event.key === 'n' || event.key === 'N') { event.preventDefault(); create(); }
      if (event.key === '/') { event.preventDefault(); searchRef.current?.focus(); }
      if (event.key === '?') { event.preventDefault(); setOpen('keys'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /** Arrows walk the cards; Space selects, F2 renames, S stars, Delete archives — on the focused card or the selection. */
  const onGridKey = (event: ReactKeyboardEvent<HTMLUListElement>, project?: string) => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains('ofk-home-card-hit') || event.metaKey || event.ctrlKey || event.altKey) return;
    const hits = [...event.currentTarget.querySelectorAll<HTMLElement>('.ofk-home-card-hit')];
    const index = hits.indexOf(target);
    const id = target.dataset.docId;
    const top = hits[0]?.closest('li')?.offsetTop;
    const columns = Math.max(1, hits.filter((hit) => hit.closest('li')?.offsetTop === top).length);
    const next = gridStep(index, hits.length, columns, event.key);
    if (next !== null) {
      event.preventDefault();
      hits[next]!.focus();
      if (project === undefined && event.shiftKey && id && hits[next]!.dataset.docId) {
        anchor.current ??= id;
        setSelected(selectRange(shownIds, anchor.current, hits[next]!.dataset.docId!));
      }
      return;
    }
    if (!id) return;
    if (project !== undefined) { // a service card can be renamed, nothing else
      if (event.key === 'F2') { event.preventDefault(); startRename(id, project); }
      return;
    }
    if (event.key === ' ') { event.preventDefault(); select(id, event.shiftKey); }
    else if (event.key === 'F2') { event.preventDefault(); startRename(id); }
    else if ((event.key === 's' || event.key === 'S') && view !== 'archive') { event.preventDefault(); toggleStars(targets(id)); }
    else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      if (view === 'archive') setDeleting(targets(id).flatMap((other) => byId.get(other) ?? []));
      else void archiveIds(targets(id));
    }
  };

  const serviceSection = serviceShown && (
    <HomeProjects documents={serviceShown} layout={home.layout} appearance={appearance} renameRef={renameRef} renaming={renaming}
      onGridKey={onGridKey} onStartRename={startRename} onDraft={setRenaming} onCommit={() => void commitRename()}
      onCancel={(id) => { renameCancelled.current = true; setRenaming(null); focusAfter(id); }} />
  );
  const needle = query.trim().toLowerCase();
  const templates = STARTER_TEMPLATES.filter(({ title }) => !needle || title.toLowerCase().includes(needle));
  const firstRun = view === 'recents' && documents !== null && documents.length === 0;
  const dark = appearance === 'dark';
  const unseenNews = home.newsSeen !== HOME_NEWS[0].title;
  const viewTitle = view === 'news' ? 'What’s new' : VIEWS.find((entry) => entry.view === view)!.title;
  const sortTitle = SORTS.find(({ sort }) => sort === home.sort)!.title;
  // Sort and layout belong to a list of your diagrams, not to templates, the archive or the first run.
  const listing = !listError && (view === 'recents' || view === 'starred') && !firstRun;
  const count = (entry: HomeView) =>
    entry === 'recents' ? documents?.length : entry === 'starred' ? starredDocs.length : entry === 'archive' ? archive?.length : undefined;
  const selectedAllStarred = selected.length > 0 && selected.every((id) => home.starred.includes(id));


  const commands = useMemo(() => buildHomeCommands({
    documents, dark, fileRef, create, navigate, openDialog: setOpen, setTheme: (theme) => updatePreferences({ theme }),
  }), [documents, dark, create, navigate, updatePreferences]);

  const clearSearch = () => { setQuery(''); searchRef.current?.focus(); };
  const templateGrid = <HomeTemplateGrid templates={templates} appearance={appearance} onOpen={(name) => create({ template: name })} />;
  const noMatch = <HomeNoMatch query={query} onClear={clearSearch} />;

  // Map a repo: the address field, straight to the map (no Untitled diagram on the way).
  const repoField = <MapRepoForm onMapRepo={(ref) => navigate(mapRepoPath(ref))} />;
  let content: React.ReactNode;
  if (listError) {
    content = (
      <ErrorState hero={<V2StateHero kind="torn-page" />}
        title={listError.blocked ? 'Diagrams can’t be opened here.' : 'Your diagrams didn’t load.'}
        description={listError.message} onRetry={refresh} />
    );
  } else if (view === 'news') {
    content = <HomeNews />;
  } else if (view === 'templates') {
    content = <>
      <p className="ofk-home-lede">Real diagrams to change. No API key needed.</p>
      {templates.length ? templateGrid : noMatch}
    </>;
  } else if (firstRun) {
    content = <><HomeFirstRun repoField={repoField} templateGrid={templateGrid} onStart={create} />{serviceSection}</>;
  } else {
    const empty = view === 'starred' && documents && starredDocs.length === 0
      ? <EmptyState icon={<Icon icon={IconStar} />} title="Nothing starred yet."
        description="Star a diagram from its card, or press S on it, to keep it here and in the sidebar." />
      : view === 'archive' && archive && archive.length === 0
        ? <EmptyState icon={<Icon icon={IconArchive} />} title="Nothing archived."
          description="Archive a diagram to take it off your list without losing it. It waits here until you restore or delete it." />
        : null;
    content = <>
      {view === 'recents' ? (
        <>
          <ul className="ofk-home-chips" aria-label="Start">
            {STARTS.map(({ kind, chip, hint, intent }) => (
              <StartChip key={kind} kind={kind} title={chip} hint={hint} onStart={() => create(intent)} />
            ))}
          </ul>
          {/* The repo map stays one field away for a returning visitor too (not only a paste nobody knows about). */}
          <section className="ofk-home-map" aria-label="Map a GitHub repo">{repoField}</section>
        </>
      ) : null}
      {view === 'archive' && archive?.length ? (
        <p className="ofk-home-lede">Off your list, kept until you delete them. Restore one to open it again.</p>
      ) : null}
      {empty ?? (shown && shown.length === 0 ? noMatch : (
        <ul className="ofk-home-grid" data-layout={home.layout} aria-label="Diagrams" aria-busy={shown === null}
          aria-multiselectable="true" onKeyDown={onGridKey}>
          {shown ? shown.map((summary) => view === 'archive' ? (
            <ArchivedCard key={summary.id} summary={summary} thumbnail={thumbnails.get(summary.id)} appearance={appearance}
              selection={selectionFor(summary.id)}
              onRestore={() => void restore(targets(summary.id))}
              onDelete={() => setDeleting(targets(summary.id).flatMap((id) => byId.get(id) ?? []))} />
          ) : (
            <DiagramCard key={summary.id} summary={summary} thumbnail={thumbnails.get(summary.id)} appearance={appearance}
              renameRef={renameRef} selection={selectionFor(summary.id)}
              rename={renaming?.id === summary.id ? {
                draft: renaming.draft,
                onChange: (draft) => setRenaming({ id: summary.id, draft }),
                onCommit: () => void commitRename(),
                onCancel: () => { renameCancelled.current = true; setRenaming(null); focusAfter(summary.id); },
              } : null}
              actions={{
                starred: home.starred.includes(summary.id),
                onStar: () => toggleStars(targets(summary.id)),
                onRename: () => startRename(summary.id),
                onDuplicate: () => void duplicate(summary),
                onArchive: () => void archiveIds(targets(summary.id)),
              }} />
          )) : [0, 1, 2, 3].map((index) => <SkeletonCard key={index} />)}
        </ul>
      ))}
      {serviceSection}
    </>;
  }

  return (
    <SystemRoot appearance={appearance} density={preferences.density}>
      <div className="ofk-home-page" data-testid="v2-home" data-selecting={selected.length ? '' : undefined}
        onDragEnter={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }}
        onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          setDragging(false);
          void importFiles([...event.dataTransfer.files]);
        }}>
        <V2HomeSidebar dark={dark} view={view} query={query} searchRef={searchRef} starredDocs={starredDocs} proJoined={proJoined}
          unseenNews={unseenNews} count={count} onQuery={setQuery} onPro={() => setOpen('pro')}
          onToggleTheme={() => updatePreferences({ theme: dark ? 'light' : 'dark' })}
          onDownloadAll={() => { void downloadAllDiagrams(transfer); }} />

        <main className="ofk-home-main">
          <V2HomeHeader title={firstRun ? 'Let’s draw your first diagram.' : viewTitle} listing={listing} sortTitle={sortTitle}
            sortOpen={open === 'sort'} home={home} fileRef={fileRef} blocked={listError?.blocked}
            onSortOpen={(next) => setOpen(next ? 'sort' : null)} onUpdateHome={updateHome}
            onImport={(files) => void importFiles(files)} onCreate={() => create()} />
          <div className="ofk-home-content">
            {notice ? <HomeNoticeStrip notice={notice} onDismiss={() => setNotice(null)} /> : null}
            {failed.length > 0 ? (
              <section className="ofk-home-notice" data-tone="warning" aria-label="Not brought over">
                <Icon icon={IconAlertTriangle} />
                <div>
                  <p><strong>{failed.length === 1 ? '1 diagram' : `${failed.length} diagrams`} from the previous editor didn’t come over yet.</strong> {failed.length === 1 ? 'It’s' : 'They’re'} safe in this browser.</p>
                  <ul>{failed.map(([v1Id, entry]) => <li key={v1Id} title={entry.error}>Couldn’t bring over “{entry.name ?? v1Id}”: {plainImportFailure(entry.error)}</li>)}</ul>
                </div>
                {/* The import runs once per page load; a reload is the retry. */}
                <Button variant="quiet" onClick={() => window.location.reload()}>Try again</Button>
              </section>
            ) : null}
            {content}
          </div>
        </main>

        {selected.length ? (
          <HomeSelectionBar count={selected.length} archive={view === 'archive'} allStarred={selectedAllStarred}
            onRestore={() => void restore(selected)} onDelete={() => setDeleting(selected.flatMap((id) => byId.get(id) ?? []))}
            onStar={() => toggleStars(selected)} onArchive={() => void archiveIds(selected)} onClear={() => setSelected([])} />
        ) : null}

        {dragging ? <HomeDropOverlay /> : null}

        <ToastRegion items={toasts} onDismiss={(id) => setToasts((current) => current.filter((item) => item.id !== id))} />
        {/* Mounted only while open: hundreds of diagrams are not hidden DOM on every render. */}
        {open === 'palette' ? (
          <CommandPalette open onClose={() => setOpen(null)} commands={commands} label="Find anything"
            placeholder="Find a diagram, template or action…" emptyLabel="Nothing matches." />
        ) : null}

        {open === 'pro' ? <V2ProWaitlist open onClose={() => setOpen(null)} onJoined={() => setProJoined(true)} /> : null}

        <HomeKeysDialog open={open === 'keys'} onClose={() => setOpen(null)} />
        <HomeDeleteDialog deleting={deleting} onClose={() => setDeleting(null)} onConfirm={() => void confirmDelete()} />
      </div>
    </SystemRoot>
  );
}
