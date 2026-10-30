import type { RefObject } from 'react';
import {
  IconArrowUpRight, IconBook2, IconBrandGithub, IconBulb, IconDownload, IconHierarchy2, IconLock, IconMoon, IconSearch,
  IconSparkles, IconSpeakerphone, IconStarFilled, IconSun,
} from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import { Icon, IconButton, Tooltip } from '../design-system';
import type { V2DocumentSummary } from '../../../services/storage/v2/v2Repository';
import { ISSUE_URL } from '../../application/ai/assistantReport';
import { DOCS_URL, REPO_URL, formatStars, useGitHubStars } from './homeStars';
import type { HomeView } from './homeLibrary';
import { VIEWS, viewLink } from './homeConfig';

interface HomeSidebarProps {
  readonly dark: boolean;
  readonly view: HomeView;
  readonly query: string;
  readonly searchRef: RefObject<HTMLInputElement>;
  readonly starredDocs: readonly V2DocumentSummary[];
  readonly proJoined: boolean;
  readonly unseenNews: boolean;
  readonly count: (view: HomeView) => number | undefined;
  readonly onQuery: (query: string) => void;
  readonly onToggleTheme: () => void;
  readonly onPro: () => void;
  readonly onDownloadAll: () => void;
}

/** Home's sidebar: brand, search, the views, starred diagrams and the footer links. */
export function V2HomeSidebar({
  dark, view, query, searchRef, starredDocs, proJoined, unseenNews, count, onQuery, onToggleTheme, onPro, onDownloadAll,
}: HomeSidebarProps): React.JSX.Element {
  const stars = useGitHubStars();
  return (
    <aside className="canvas-home-sidebar">
      <div className="canvas-home-sidebar-top">
        <Link to="/home" className="canvas-home-brand" aria-label="Canvas home">
          <img src="/logo-canvas.svg" alt="" width="24" height="24" />
          <span>Canvas</span>
        </Link>
        <Tooltip content={dark ? 'Light theme' : 'Dark theme'}>
          <IconButton variant="quiet" label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
            icon={<Icon icon={dark ? IconSun : IconMoon} />}
            onClick={onToggleTheme} />
        </Tooltip>
      </div>

      <label className="canvas-home-search">
        <Icon icon={IconSearch} />
        <input ref={searchRef} type="search" placeholder={view === 'templates' ? 'Search templates' : 'Search diagrams'}
          aria-label={view === 'templates' ? 'Search templates' : 'Search diagrams'} value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape') { onQuery(''); event.currentTarget.blur(); } }} />
        <kbd aria-hidden="true">/</kbd>
      </label>

      <nav className="canvas-home-nav" aria-label="Home">
        {VIEWS.map((entry) => (
          <Link key={entry.view} to={viewLink(entry.view)} className="canvas-home-nav-item" data-view={entry.view}
            aria-current={view === entry.view ? 'page' : undefined}>
            <Icon icon={entry.icon} />
            <span>{entry.title}</span>
            {count(entry.view) ? <span className="canvas-home-nav-count">{count(entry.view)}</span> : null}
          </Link>
        ))}
        <button type="button" className="canvas-home-nav-item canvas-home-pro" data-joined={proJoined || undefined} onClick={onPro}>
          <Icon icon={IconSparkles} />
          <span>Canvas Pro</span>
          <span className="canvas-home-pro-pill">{proJoined ? 'On the list' : 'Waitlist'}</span>
        </button>
      </nav>

      {starredDocs.length > 0 ? (
        <section className="canvas-home-sidebar-section" aria-labelledby="canvas-home-starred">
          <h2 id="canvas-home-starred">Starred</h2>
          <ul>
            {starredDocs.map(({ id, name }) => (
              <li key={id}><Link to={`/d/${id}`} className="canvas-home-nav-item" title={name}><Icon icon={IconHierarchy2} /><span>{name}</span></Link></li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="canvas-home-sidebar-foot">
        <div className="canvas-home-local">
          <span className="canvas-home-local-icon"><Icon icon={IconLock} /></span>
          <p><strong>Private by default</strong>Saved in this browser. No account needed.</p>
        </div>
        <button type="button" className="canvas-home-nav-item" onClick={onDownloadAll}>
          <Icon icon={IconDownload} /><span>Download all diagrams</span>
        </button>
        <Link to={viewLink('news')} className="canvas-home-nav-item" aria-current={view === 'news' ? 'page' : undefined}>
          <Icon icon={IconSpeakerphone} />
          <span>What’s new</span>
          {unseenNews ? <span className="canvas-home-dot" aria-label="New" /> : null}
        </Link>
        <a className="canvas-home-nav-item" href={DOCS_URL} target="_blank" rel="noreferrer">
          <Icon icon={IconBook2} /><span>Docs</span>
          <Icon icon={IconArrowUpRight} />
        </a>
        <a className="canvas-home-nav-item" href={ISSUE_URL} target="_blank" rel="noreferrer">
          <Icon icon={IconBulb} /><span>Request a feature</span>
          <Icon icon={IconArrowUpRight} />
        </a>
        <a className="canvas-home-nav-item" href={REPO_URL} target="_blank" rel="noreferrer"
          aria-label={stars === null ? 'Star on GitHub' : `Star on GitHub, ${stars} stars`}>
          <Icon icon={IconBrandGithub} /><span>Star on GitHub</span>
          {stars === null ? <Icon icon={IconArrowUpRight} /> : (
            <span className="canvas-home-stars" aria-hidden="true"><Icon icon={IconStarFilled} />{formatStars(stars)}</span>
          )}
        </a>
      </div>
    </aside>
  );
}
