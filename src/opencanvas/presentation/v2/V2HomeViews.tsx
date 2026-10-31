import type { ReactNode } from 'react';
import { Button } from '../design-system';
import { HomeCard, StartCard } from './V2HomeCards';
import { HOME_NEWS } from './homeNews';
import { REPO_URL } from './homeStars';
import { NEWS_DATE, STARTS, templateFit, templatePicture } from './homeConfig';
import { STARTER_TEMPLATES } from '../../../agent/starterTemplates';
import type { V2StartIntent } from './v2Document';

type Template = (typeof STARTER_TEMPLATES)[number];

export function HomeTemplateGrid({ templates, appearance, onOpen }: {
  readonly templates: readonly Template[]; readonly appearance: 'light' | 'dark'; readonly onOpen: (name: string) => void;
}): React.JSX.Element {
  return (
  <ul className="ofk-home-grid ofk-home-templates" aria-label="Templates">
    {templates.map((template) => (
      <HomeCard key={template.name} title={template.title} meta={template.summary}
        onOpen={() => onOpen(template.name)}
        preview={<img className="ofk-home-preview-image" alt="" decoding="async" src={templatePicture(template.name, appearance)}
          onLoad={(event) => { event.currentTarget.dataset.fit = templateFit(event.currentTarget); }} />} />
    ))}
  </ul>
  );
}

export function HomeNoMatch({ query, onClear }: { readonly query: string; readonly onClear: () => void }): React.JSX.Element {
  return (
    <p className="ofk-home-nomatch" role="status">
      Nothing matches “{query.trim()}”. <Button variant="quiet" onClick={onClear}>Clear search</Button>
    </p>
  );
}

/** What's new: the changelog, newest first. */
export function HomeNews(): React.JSX.Element {
  return <>
    <p className="ofk-home-lede">
      What changed lately, newest first. <a href={`${REPO_URL}/blob/main/CHANGELOG.md`} target="_blank" rel="noreferrer">Full changelog</a>
    </p>
    <ol className="ofk-home-changelog">
      {HOME_NEWS.map(({ date, title, text }, index) => (
        <li key={title}>
          {date !== HOME_NEWS[index - 1]?.date ? <time dateTime={date}>{NEWS_DATE.format(new Date(`${date}T12:00:00`))}</time> : <span />}
          <div><h2>{title}</h2><p>{text}</p></div>
        </li>
      ))}
    </ol>
  </>;
}

/** The first run: pick a way in, map a repo, or start from a template. */
export function HomeFirstRun({ repoField, templateGrid, onStart }: {
  readonly repoField: ReactNode; readonly templateGrid: ReactNode; readonly onStart: (intent?: V2StartIntent) => void;
}): React.JSX.Element {
  return <>
    <p className="ofk-home-lede">Pick a way in, or drop a file anywhere to import it. No account needed: your diagrams stay on your device, and basic usage stats can be turned off in Settings.</p>
    <section aria-label="Start">
      <ul className="ofk-home-starts">
        {STARTS.map(({ kind, title, text, intent }) => (
          <StartCard key={kind} kind={kind} title={title} text={text} onStart={() => onStart(intent)} />
        ))}
      </ul>
    </section>
    <section className="ofk-home-section ofk-home-map" aria-labelledby="ofk-home-map">
      <h2 id="ofk-home-map" className="ofk-home-section-title">Or map a GitHub repo</h2>
      {repoField}
    </section>
    <section className="ofk-home-section" aria-labelledby="ofk-home-templates">
      <h2 id="ofk-home-templates" className="ofk-home-section-title">Or start from a template</h2>
      {templateGrid}
    </section>
  </>;
}
