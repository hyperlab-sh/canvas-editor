import { describe, expect, it } from 'vitest';
import { RepoError } from '../../../services/discovery/githubRepo';
import { describeRepoError } from './v2RepoProblem';

describe('describeRepoError', () => {
  it('a pause GitHub asked for says to wait and retry, with no token form (a token would not help)', () => {
    const view = describeRepoError(new RepoError({ kind: 'slow-down', retryAfter: 60 }, 'GitHub asked for a pause between reads. Wait 60 seconds and try again.'), 'map');
    expect(view).toMatchObject({ retry: true, title: 'GitHub asked to wait before more reads.' });
    expect(view.askToken).toBeUndefined();
    expect(view.detail).toContain('Wait 60 seconds');
  });

  it('a private repo the token cannot read asks for one that can, points at the CLI, and offers no plain retry', () => {
    const view = describeRepoError(new RepoError({ kind: 'private' }, 'The token cannot read it.'), 'discover');
    expect(view).toMatchObject({ retry: false, title: 'This repo is private.', askToken: true });
    expect(view.detail).toContain('openflowkit discover .');
  });

  it('not found may be private: the address comes back and a token is one click away', () => {
    const view = describeRepoError(new RepoError({ kind: 'not-found' }, "acme/shop wasn't found."), 'map');
    expect(view).toMatchObject({ retype: true, privateToken: true });
    expect(view.detail).toContain('GitHub token');
  });

  it('the hourly limit still asks for a token', () => {
    expect(describeRepoError(new RepoError({ kind: 'rate-limited', resetAt: null }, 'used up.'), 'map').askToken).toBe(true);
  });
});
