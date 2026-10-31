import { useNavigate } from 'react-router-dom';
import { Button, ErrorState, Progress } from '../../design-system';
import type { RepoMapSource } from '../../../application/map/repoMapSource';
import { BrandLoader } from '../BrandLoader';
import { V2StateHero } from '../V2StateHero';
import { V2StateShell } from '../V2StateShell';
import { CliText, PrivateRepoToken, RepoTokenForm } from '../v2RepoProblem';
import { mapRepoPath, MapRepoForm } from './V2MapStart';
import type { RepoMapState } from './useRepoMap';
import './map.css';

/** A crowded level: the strongest arrows are drawn; the rest wait for "Show all". */
interface RepoLinks { readonly shown: number; readonly total: number; readonly all: boolean; readonly onToggle: () => void }
const fmt = (n: number) => n.toLocaleString('en-US');

/** An address that names no repo: the field comes back with what was asked for, ready to fix (like "not found"). */
export function BadRepoAddress({ initial = '' }: { readonly initial?: string } = {}): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <V2StateShell testId="v2-map">
      <ErrorState hero={<V2StateHero kind="lost-link" />} title="That is not a GitHub repo address." description="Enter owner/repo or a github.com address."
        action={<MapRepoForm initial={initial} onMapRepo={(ref) => navigate(mapRepoPath(ref), { replace: true })} />}
        secondary={<Button variant="secondary" onClick={() => navigate('/home')}>Back to home</Button>} />
    </V2StateShell>
  );
}

/**
 * What the editor frame shows instead of the map while there is none to draw: reading, a problem, or an empty repo. Null once the
 * map can show. `onOpenDrawing`: the reader already made a drawing of this map; a failed read (offline, a limit) must not hide it.
 */
export function V2RepoMapState({ source, map, onOpenDrawing }: { readonly source: RepoMapSource; readonly map: RepoMapState; readonly onOpenDrawing?: (() => void) | undefined }): React.JSX.Element | null {
  const navigate = useNavigate();
  const drawing = onOpenDrawing ? <Button variant="secondary" onClick={onOpenDrawing}>Open your drawing</Button> : null;
  const home = (primary: boolean) => <>{drawing}<Button variant={primary && !drawing ? 'primary' : 'secondary'} onClick={() => navigate('/home')}>Back to home</Button></>;
  const name = `${source.owner}/${source.repo}`;
  const { problem } = map;
  if (map.status === 'problem' && problem) {
    return (
      <V2StateShell testId="v2-map">
        <ErrorState hero={<V2StateHero kind={problem.hero} />} title={problem.title} description={<CliText text={problem.detail} />}
          {...(problem.askToken
            ? { action: <RepoTokenForm home={home(false)} onSubmit={map.submitToken} /> }
            : problem.retry ? { onRetry: map.retry, secondary: home(false) }
              // Not found is most often a typo: the address field comes back with what was asked for, ready to fix.
              : problem.retype ? {
                action: <>
                  <MapRepoForm initial={name} onMapRepo={(ref) => navigate(mapRepoPath(ref))} />
                  {problem.privateToken ? <PrivateRepoToken onSubmit={map.submitToken} /> : null}
                </>,
                secondary: home(false),
              }
                : { action: home(true) })} />
      </V2StateShell>
    );
  }
  const files = map.model?.stats.files ?? 0;
  if (map.status === 'ready' && files === 0) {
    return (
      <V2StateShell testId="v2-map">
        <ErrorState hero={<V2StateHero kind="no-canvas" />} title="Nothing to map here." description={`${name} has no TypeScript, JavaScript, Python or Go files, which is what a map reads. A repo of Dockerfiles, compose files, Kubernetes manifests or package manifests can be drawn as a diagram of its services instead.`} action={home(true)} />
      </V2StateShell>
    );
  }
  if (map.status === 'loading' && files === 0) {
    const { read, total } = map.progress;
    return (
      <V2StateShell testId="v2-map">
        <div className="ofk-empty" role="status">
          <BrandLoader />
          <p className="ofk-empty-title">{`Reading ${name}…`}</p>
          {total > 0 ? <Progress label={`Reading ${fmt(read)} of ${fmt(total)} files…`} value={read} max={total} /> : null}
          <div className="ofk-empty-actions">{home(false)}</div>
        </div>
      </V2StateShell>
    );
  }
  return null;
}

/** Notes over the drawn map: the reading counter while it fills in, then how much of a partly read repo is on it. */
export function V2RepoMapChips({ map, links }: { readonly map: RepoMapState; readonly links?: RepoLinks | null }): React.JSX.Element | null {
  const { read, total } = map.progress;
  // Before a map is drawn the state screen has its own counter; an unknown total would read "0 of 0".
  const counting = map.status === 'loading' && (map.model?.stats.files ?? 0) > 0 && total > 0;
  // Said once the read is over: until then the counter is the truth.
  const sampled = counting ? undefined : map.progress.sampled;
  const { stale, staleRef } = map.progress;
  if (map.status === 'idle' || (!sampled && !links && !counting && !stale)) return null;
  return (
    <div className="map-status">
      {stale ? <div className="map-chip" role="note">{`May be out of date: ${staleRef ? `showing ${staleRef === 'HEAD' ? 'the default branch' : staleRef}, ` : ''}GitHub's limit was reached.`}</div> : null}
      {sampled ? <div className="map-chip" role="note">{`Read ${fmt(sampled.read)} of ${fmt(sampled.total)}${sampled.truncated ? '+' : ''} files`}</div> : null}
      {links ? (
        <div className="map-chip" role="group" aria-label="Arrows shown">
          <span>{links.all ? `Showing all ${fmt(links.total)} links` : `Showing ${fmt(links.shown)} of ${fmt(links.total)} links`}</span>
          <Button variant="quiet" onClick={links.onToggle}>{links.all ? 'Show fewer' : 'Show all'}</Button>
        </div>
      ) : null}
      {counting ? <div className="map-chip" role="status"><Progress label={`Reading ${fmt(read)} of ${fmt(total)} files…`} value={read} max={total} /></div> : null}
    </div>
  );
}

/** What goes over the canvas of a repo map: the state screen while there is no map to draw, and the notes over it once there is. */
export function V2RepoMapOverlay({ source, map, links, onOpenDrawing }: { readonly source: RepoMapSource; readonly map: RepoMapState; readonly links?: RepoLinks | null; readonly onOpenDrawing?: (() => void) | undefined }): React.JSX.Element {
  return (
    <>
      <div className="ofk-v2-map-state"><V2RepoMapState source={source} map={map} onOpenDrawing={onOpenDrawing} /></div>
      <V2RepoMapChips map={map} links={links} />
    </>
  );
}
