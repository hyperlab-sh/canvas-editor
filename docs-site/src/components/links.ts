// The site's outbound and cross-page links, shared by the landing page, the
// docs header and the footer so they cannot disagree.
export const APP_URL = 'https://app.openflowkit.com';
export const REPO_URL = 'https://github.com/openflowkit/openflowkit';
export const NPM_URL = 'https://www.npmjs.com/package/openflowkit';
export const MCP_COMMAND = 'npx -y openflowkit mcp';
/** A small public repo whose map shows services and their evidence well. */
export const SAMPLE_MAP_URL = `${APP_URL}/#/map/github/dockersamples/example-voting-app`;

export interface FooterLink {
  readonly label: string;
  readonly href: string;
}

/** Docs links are slugs; a page that does not exist (yet) is left out. */
export const FOOTER_COLUMNS: readonly { readonly title: string; readonly links: readonly FooterLink[] }[] = [
  {
    title: 'Product',
    links: [
      { label: 'Open the app', href: APP_URL },
      { label: 'Map a sample repo', href: SAMPLE_MAP_URL },
      { label: 'Templates', href: '/templates/' },
      { label: 'Privacy', href: '/local-first-diagramming/' },
      { label: 'Self-hosting', href: '/self-hosting/' },
    ],
  },
  {
    title: 'Docs',
    links: [
      { label: 'Quick start', href: '/quick-start/' },
      { label: 'Agents & MCP', href: '/mcp-server/' },
      { label: 'OpenFlow DSL', href: '/openflow-dsl/' },
      { label: 'CLI', href: '/cli/' },
      { label: 'Keyboard shortcuts', href: '/keyboard-shortcuts/' },
      { label: 'FAQ', href: '/faq/' },
    ],
  },
  {
    title: 'Community',
    links: [
      { label: 'GitHub', href: REPO_URL },
      { label: 'Issues', href: `${REPO_URL}/issues` },
      { label: 'Discussions', href: `${REPO_URL}/discussions` },
      { label: 'npm', href: NPM_URL },
      { label: 'X', href: 'https://x.com/openflowkit' },
      { label: 'LinkedIn', href: 'https://www.linkedin.com/company/openflowkit/' },
      { label: 'YouTube', href: 'https://www.youtube.com/channel/UC3vnYLzGo-0r9CB9T3i7nKw' },
    ],
  },
];
