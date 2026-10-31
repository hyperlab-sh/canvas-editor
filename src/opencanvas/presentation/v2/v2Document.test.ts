import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetPageId, savePageId, savedPageId } from './v2Document';

afterEach(() => localStorage.clear());

// Found 2026-10-11 (U2-8): a reload reopened Page 1, and the next export took the wrong page.
describe('the page a document was left on', () => {
  it('is remembered per document in this browser', () => {
    expect(savedPageId('doc-a')).toBeNull();
    savePageId('doc-a', 'page-2');
    savePageId('doc-b', 'page-9');
    expect(savedPageId('doc-a')).toBe('page-2');
    expect(savedPageId('doc-b')).toBe('page-9');
  });

  // Review 2026-10-11: one key per document ever opened, kept after delete.
  it('stores nothing for the first page, and nothing survives a delete', () => {
    savePageId('doc-a', 'page-2');
    savePageId('doc-a', null);
    expect(localStorage.getItem('ofk.page:doc-a')).toBeNull();
    savePageId('doc-b', 'page-9');
    forgetPageId('doc-b');
    expect(savedPageId('doc-b')).toBeNull();
    expect(localStorage.length).toBe(0);
  });
});

// Found 2026-10-12: a reload before the editor finished loading (a stale-chunk reload, the v1 kill
// switch's navigation, F5) turned a just-minted diagram into "That diagram isn't in this browser."
describe('a document this tab minted', () => {
  it('may still be created after a reload of the tab', async () => {
    const { mintV2Id } = await import('./v2Document');
    const id = mintV2Id('doc');
    vi.resetModules();
    const reloaded = await import('./v2Document');
    expect(reloaded.mayCreateDocument(id, null)).toBe(true);
    expect(reloaded.mayCreateDocument('doc-someone-elses', null)).toBe(false);
  });
});
