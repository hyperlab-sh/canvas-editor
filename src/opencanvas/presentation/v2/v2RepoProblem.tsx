import { useState } from 'react';
import { Button, Field } from '../design-system';
import { RepoError } from '../../../services/discovery/githubRepo';
import type { V2StateHeroKind } from './V2StateHero';

// What the two GitHub pages (repo -> diagram, repo -> map) say when a read fails, and the token form they share.

// The token lives in this tab's sessionStorage only: never logged, never in a URL.
const TOKEN_KEY = 'ofk.github-token';
export const storedToken = (): string | undefined => { try { return sessionStorage.getItem(TOKEN_KEY) ?? undefined; } catch { return undefined; } };
export const keepToken = (token: string | null): void => { try { if (token) sessionStorage.setItem(TOKEN_KEY, token); else sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked: the token is used for this try only */ } };


export interface RepoProblemView {
  readonly status: 'problem';
  readonly title: string;
  readonly detail: string;
  readonly retry: boolean;
  readonly hero: V2StateHeroKind;
  readonly askToken?: boolean;
  /** Most often a typo: the screen offers the address field again. */
  readonly retype?: boolean;
  /** It may be private: a token that can read it is offered one click away (PrivateRepoToken). */
  readonly privateToken?: boolean;
}

/** The CLI command a page names in its error screens: exactly once, with its own subcommand. `map` writes a page to open (alone it prints text). */
export const cliCommand = (sub: 'discover' | 'map'): string => (sub === 'map' ? 'npx openflowkit map . --html map.html' : `npx openflowkit ${sub} .`);

/** A screen's text with its CLI command kept on one line (as code), so `npx openflowkit` never breaks from what follows. */
export function CliText({ text }: { readonly text: string }): React.JSX.Element {
  const parts = text.split(/(npx openflowkit (?:discover \.|map \. --html map\.html))/);
  return <>{parts.map((part, i) => (i % 2 ? <code key={i} style={{ whiteSpace: 'nowrap' }}>{part}</code> : part))}</>;
}

export function describeRepoError(error: unknown, sub: 'discover' | 'map'): RepoProblemView {
  const cli = cliCommand(sub);
  if (!(error instanceof RepoError)) return { status: 'problem', title: 'Something went wrong reading this repo.', detail: `Try again, or use the CLI on a checkout: ${cli}`, retry: true, hero: 'torn-page' };
  switch (error.problem.kind) {
    case 'not-found': return { status: 'problem', title: 'This repo was not found, or it is private.', detail: `${error.message} Check the spelling. A private repo opens with a GitHub token that can read it, or with the CLI on a checkout: ${cli}`, retry: false, hero: 'lost-link', retype: true, privateToken: true };
    case 'rate-limited': return { status: 'problem', title: 'GitHub is limiting reads from your network.', detail: `${error.message} The CLI reads a checkout with no limit: ${cli}`, retry: false, hero: 'torn-page', askToken: true };
    case 'slow-down': return { status: 'problem', title: 'GitHub asked to wait before more reads.', detail: error.message, retry: true, hero: 'torn-page' };
    case 'private': return { status: 'problem', title: 'This repo is private.', detail: `${error.message} Or read it with the CLI on a checkout: ${cli}`, retry: false, hero: 'lost-link', askToken: true };
    case 'token-rejected': return { status: 'problem', title: 'That GitHub token was rejected.', detail: error.message, retry: false, hero: 'lost-link', askToken: true };
    case 'offline': return { status: 'problem', title: 'GitHub could not be reached.', detail: 'Check your connection and try again.', retry: true, hero: 'torn-page' };
    case 'empty': return { status: 'problem', title: 'This repo is empty.', detail: 'There is nothing in it to draw yet.', retry: false, hero: 'no-canvas' };
    default: return { status: 'problem', title: 'GitHub had a problem.', detail: error.message, retry: true, hero: 'torn-page' };
  }
}


/**
 * The token field. `required` (a private repo's step, where the token is the point): labelled as such, focused when it opens,
 * and nothing to submit until one is typed. Otherwise (a rate limit) it is optional and an empty try simply reads again.
 */
export function RepoTokenForm({ onSubmit, home, required = false }: { readonly onSubmit: (token: string) => void; readonly home: React.ReactNode; readonly required?: boolean }): React.JSX.Element {
  const [token, setToken] = useState('');
  return (
    <form className="ofk-v2-state-token" onSubmit={(event) => { event.preventDefault(); onSubmit(token.trim()); }}>
      <Field label={required ? 'GitHub token' : 'GitHub token (optional)'} type="password" autoComplete="new-password" spellCheck={false} value={token} onChange={(event) => setToken(event.target.value)}
        autoFocus={required}
        hint="A token raises the limit to 5,000/hour and reads the private repos it can access. Use a fine-grained token with Contents read-only. It stays in this browser tab and goes only to api.github.com." />
      <a className="ofk-caption" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">Create a fine-grained token on GitHub</a>
      <div className="ofk-empty-actions">
        <Button variant="primary" type="submit" disabled={required && token.trim() === ''}>Try with token</Button>
        {home}
      </div>
    </form>
  );
}


/** "Not found" may mean private: one click opens the token form, so a private repo has its next step on the same screen. */
export function PrivateRepoToken({ onSubmit }: { readonly onSubmit: (token: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  if (!open) return <Button variant="quiet" onClick={() => setOpen(true)}>Private repo? Use a GitHub token</Button>;
  return <RepoTokenForm home={null} required onSubmit={onSubmit} />;
}
