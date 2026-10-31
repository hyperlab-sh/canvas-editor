import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BrandLoader, BrandLoaderMark } from './BrandLoader';

describe('BrandLoader', () => {
  it('index.html shows the same mark before any script runs', () => {
    const html = readFileSync('index.html', 'utf8');
    expect(html).toContain(renderToStaticMarkup(<BrandLoaderMark />));
  });

  it('a fresh loader fades in; a labelled one is announced, an unlabelled one is hidden', () => {
    const fresh = renderToStaticMarkup(<BrandLoader screen label="Loading" />);
    expect(fresh).toContain('class="ofk-loader ofk-loader-screen"');
    expect(fresh).toContain('data-fade="true"');
    expect(fresh).toContain('role="status" aria-label="Loading"');
    expect(renderToStaticMarkup(<BrandLoader />)).toContain('aria-hidden="true"');
  });
});
