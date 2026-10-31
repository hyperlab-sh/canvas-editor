import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { unified } from '@astrojs/markdown-remark';
import { remarkOpenflowExamples } from './src/plugins/remark-openflow-examples.mjs';
import { CURATED, DIAGRAM_TYPE_LABELS, SUBLINE, TAGLINE } from './src/docsIndex.mjs';

// The sidebar mirrors the file system, so a page can never be orphaned: every
// markdown file under src/content/docs/ appears exactly once, titled by its
// frontmatter. Curated groups come first, anything unlisted lands in "More".
// A slug listed here before its page exists is skipped, so a group can name a
// page that is still being written. A nested object is a sub-group.
const DOCS_DIR = fileURLToPath(new URL('./src/content/docs', import.meta.url));

const OPEN = new Set(['Get started', 'Agents & MCP', 'Write diagrams']);

const slugs = readdirSync(DOCS_DIR).filter((file) => /\.mdx?$/.test(file)).map((file) => file.replace(/\.mdx?$/, ''));
const curated = Object.values(CURATED).flat().flatMap((entry) => (typeof entry === 'string' ? [entry] : Object.values(entry).flat()));
const group = (label, entries, collapsed) => ({
  label,
  collapsed,
  items: entries.flatMap((entry) => {
    if (typeof entry !== 'string') {
      return Object.entries(entry).map(([sub, subSlugs]) => ({
        label: sub,
        collapsed: false,
        items: subSlugs.filter((slug) => slugs.includes(slug)).map((slug) => ({ label: DIAGRAM_TYPE_LABELS[slug], slug })),
      })).filter(({ items }) => items.length > 0);
    }
    return slugs.includes(entry) ? [{ slug: entry }] : [];
  }),
});
const sidebar = [
  ...Object.entries(CURATED).map(([label, entries]) => group(label, entries, !OPEN.has(label)))
    .filter(({ items }) => items.length > 0),
  ...(slugs.some((slug) => !curated.includes(slug))
    ? [group('More', slugs.filter((slug) => !curated.includes(slug)).sort(), false)]
    : []),
];

const SITE = 'https://docs.openflowkit.com';

export default defineConfig({
  site: SITE,
  // Every ```` ```openflow ```` block becomes a figure whose SVG was compiled
  // from the same block at build time (scripts/build-examples.mts).
  markdown: {
    processor: unified({ remarkPlugins: [remarkOpenflowExamples] }),
  },
  integrations: [
    starlight({
      title: 'OpenFlowKit',
      description: `${TAGLINE} ${SUBLINE}`,
      // Starlight writes og:title and og:description per page; the card image
      // and its size are the site's.
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: `${SITE}/og.png` } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: `${SITE}/og.png` } },
        // Agents and answer engines: the whole docs as one index (src/pages/llms.txt.ts).
        { tag: 'link', attrs: { rel: 'alternate', type: 'text/plain', title: 'llms.txt', href: '/llms.txt' } },
      ],
      // The header carries "Open app" and GitHub on every width, the footer the
      // site's links; the 404 is src/pages/404.astro.
      components: {
        Header: './src/components/Header.astro',
        Footer: './src/components/Footer.astro',
      },
      disable404Route: true,
      favicon: '/favicon.svg',
      logo: {
        src: './src/assets/Logo_openflowkit.svg',
        alt: 'OpenFlowKit',
      },
      editLink: {
        baseUrl: 'https://github.com/openflowkit/openflowkit/edit/main/docs-site/',
      },
      // English only: root locale keeps clean URLs (/introduction, not /en/introduction).
      defaultLocale: 'root',
      sidebar,
      // Neutral code themes: the warm palette stays the only colour story.
      // Frames take the app's surface radius and hairline, no drop shadow.
      expressiveCode: {
        themes: ['github-light', 'github-dark'],
        styleOverrides: {
          borderRadius: '12px',
          borderColor: 'var(--ofk-border)',
          // Code sits on the app's warm surface, not the themes' cool greys.
          codeBackground: 'var(--ofk-surface)',
          codeFontFamily: 'var(--sl-font-mono)',
          uiFontFamily: 'var(--sl-font)',
          frames: { frameBoxShadowCssValue: 'none' },
        },
        // Wrap long lines (an MCP config, a shell command) instead of hiding
        // their tail off-screen; wrapped lines keep their indent.
        defaultProps: { wrap: true },
      },
      customCss: ['./src/styles/custom.css'],
    }),
  ],
});
