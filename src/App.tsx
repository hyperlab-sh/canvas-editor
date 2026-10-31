import React, { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { HashRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { lastDocumentId, mintV2Id } from '@/opencanvas/presentation/v2/v2Document';
import { V2ErrorBoundary } from '@/opencanvas/presentation/v2/V2ErrorBoundary';
import { BrandLoader } from '@/opencanvas/presentation/v2/BrandLoader';
import { createV2Repository } from '@/services/storage/v2/v2Repository';
import { createServiceRepository } from '@/services/storage/service/serviceRepository';

const loadEditor = () => import('@/opencanvas/presentation/v2/V2EditorPage');
const HomePage = lazy(async () => {
  const module = await import('@/opencanvas/presentation/v2/V2HomePage');
  // Every way out of Home opens the editor: it downloads while the reader looks, so a click never waits on a frozen Home.
  // ponytail: ~1.1 MB fetched even for a visit that only browses the list — split the editor if that matters.
  const idle = window.requestIdleCallback ?? ((run: () => void) => setTimeout(run, 1));
  idle(() => { void loadEditor(); });
  return { default: module.V2HomePage };
});

const LegacyFlowRedirect = lazy(async () => ({ default: (await import('@/opencanvas/presentation/v2/V2LegacyRoutes')).LegacyFlowRedirect }));
const LegacyViewPage = lazy(async () => ({ default: (await import('@/opencanvas/presentation/v2/V2LegacyRoutes')).LegacyViewPage }));

/** v1 routes that were screens of the old app (phase 12.5); bookmarks land on home. */
export const LEGACY_HOME_PATHS = ['/templates', '/settings', '/canvas', '/mcp'] as const;
/** v1 forwarded `#/docs…` to the docs site. Its pages were rebuilt (phase 9), so old slugs land on its home. */
const LEGACY_DOCS_PATHS = ['/docs', '/docs/:slug', '/docs/:lang/:slug'] as const;
const DOCS_SITE = 'https://docs.openflowkit.com/';

function DocsSiteRedirect(): React.JSX.Element {
  useEffect(() => { window.location.replace(DOCS_SITE); }, []);
  return <BrandLoader screen label="Opening the docs" />;
}

const SharedPage = lazy(async () => ({ default: (await import('@/opencanvas/presentation/v2/V2SharedPage')).V2SharedPage }));

const FromGithubPage = lazy(async () => ({ default: (await import('@/opencanvas/presentation/v2/V2FromGithubPage')).V2FromGithubPage }));
const MapRoute = lazy(async () => ({ default: (await import('@/opencanvas/presentation/v2/map/MapRoute')).MapRoute }));
const FromDslPage = lazy(async () => ({ default: (await import('@/opencanvas/presentation/v2/V2FromDslPage')).V2FromDslPage }));

const EditorPage = lazy(async () => ({ default: (await loadEditor()).V2EditorPage }));

// A first visit lands on the newest diagram brought over from v1, if the import finishes
// within 2 s; otherwise a new document, and the import carries on in the background.
const FIRST_VISIT_WAIT_MS = 2000;

/** `then` rides along to the editor: `#/connect` lands on the last document as `?connect` (opens Connect agent). */
function HomeDocument({ then = '' }: { readonly then?: string }): React.JSX.Element {
  const [target, setTarget] = useState(lastDocumentId);
  useEffect(() => {
    if (target) return undefined;
    let live = true;
    const fresh = mintV2Id('doc');
    // The editor downloads while the v1 check runs; it is where this route lands either way.
    void loadEditor();
    void Promise.race([
      // Loaded on demand: the converter it carries is the biggest thing a first paint never needs.
      import('@/services/storage/v2/v1Import').then(({ runV1Import }) => runV1Import())
        .then((report) => report.imported[0] ?? fresh, () => fresh),
      new Promise<string>((resolve) => setTimeout(() => resolve(fresh), FIRST_VISIT_WAIT_MS)),
    ]).then((id) => { if (live) setTarget(id); });
    return () => { live = false; };
  }, [target]);
  // <Navigate> draws nothing while the editor downloads: the loader stays up through it.
  return <>{target ? <Navigate to={`/d/${target}${then}`} replace /> : null}<BrandLoader screen label="Loading OpenFlowKit" /></>;
}

/** One editor per document: switching /d/A → /d/B (back, forward) unmounts A's editor, which saves A's pending edit as A. */
function EditorRoute(): React.JSX.Element {
  const { project, id } = useParams();
  // /d/ keeps documents in this browser; /p/ keeps them in the local service's project.
  const repository = useMemo(() => project === undefined ? createV2Repository(window.indexedDB) : createServiceRepository(project), [project]);
  return <EditorPage key={project === undefined ? id : `${project}/${id}`} repository={repository} />;
}

function LegacyV2Redirect(): React.JSX.Element {
  const { id } = useParams();
  return <Navigate to={`/d/${id}`} replace />;
}

export default function App(): React.JSX.Element {
  return (
    <HashRouter>
      <V2ErrorBoundary>
        <Suspense fallback={<BrandLoader screen label="Loading OpenFlowKit" />}>
          <Routes>
            <Route path="/home" element={<HomePage />} />
            <Route path="/flow/:flowId" element={<LegacyFlowRedirect />} />
            <Route path="/view" element={<LegacyViewPage />} />
            {LEGACY_HOME_PATHS.map((path) => <Route key={path} path={path} element={<Navigate to="/home" replace />} />)}
            {LEGACY_DOCS_PATHS.map((path) => <Route key={path} path={path} element={<DocsSiteRedirect />} />)}
            <Route path="/d/:id" element={<EditorRoute />} />
            <Route path="/p/:project/:id" element={<EditorRoute />} />
            <Route path="/s/:id/:key?" element={<SharedPage />} />
            <Route path="/from/github/*" element={<FromGithubPage />} />
            <Route path="/map/github/*" element={<MapRoute />} />
            <Route path="/from/dsl" element={<FromDslPage />} />
            <Route path="/v2/:id" element={<LegacyV2Redirect />} />
            <Route path="/connect" element={<HomeDocument then="?connect" />} />
            <Route path="*" element={<HomeDocument />} />
          </Routes>
        </Suspense>
      </V2ErrorBoundary>
    </HashRouter>
  );
}
