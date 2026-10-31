import { getCollection, type CollectionEntry } from 'astro:content';
import { CURATED, SUBLINE, TAGLINE } from '../docsIndex.mjs';

export const SITE = 'https://docs.openflowkit.com';
export const url = (slug: string): string => `${SITE}/${slug === 'index' ? '' : `${slug}/`}`;

/** Every docs page in the sidebar's groups and order; anything not curated lands in "More", as in the sidebar. */
export async function groupedPages(): Promise<[string, CollectionEntry<'docs'>[]][]> {
  const pages = await getCollection('docs');
  const bySlug = new Map(pages.map((page) => [page.id, page]));
  const flat = (entries: readonly (string | Record<string, readonly string[]>)[]): string[] =>
    entries.flatMap((entry) => (typeof entry === 'string' ? [entry] : Object.values(entry).flat()));
  const groups = Object.entries(CURATED).map(([label, entries]): [string, CollectionEntry<'docs'>[]] =>
    [label, flat(entries).flatMap((slug) => bySlug.get(slug) ?? [])]);
  const listed = new Set(groups.flatMap(([, list]) => list.map((page) => page.id)));
  const more = pages.filter((page) => !listed.has(page.id) && page.id !== 'index').sort((a, b) => a.id.localeCompare(b.id));
  return [...groups, ...(more.length ? [['More', more] as [string, CollectionEntry<'docs'>[]]] : [])].filter(([, list]) => list.length);
}

// What an agent most often needs before it opens any page: what this is, and where each way in starts.
export const HEADER = `# OpenFlowKit

> ${TAGLINE} ${SUBLINE}

- App: https://app.openflowkit.com (no account; documents stay in the browser). Source: https://github.com/openflowkit/openflowkit (MIT).
- Agents draw on the open canvas over MCP: \`claude mcp add -s user openflowkit -- npx -y openflowkit mcp\` (Claude Code; other clients: ${url('connect-your-agent')}). Chat apps (claude.ai, ChatGPT) use the hosted connector https://mcp.openflowkit.com/mcp, which draws diagram cards in the chat.
- Map a GitHub repo: https://app.openflowkit.com/#/map/github/<owner>/<repo> (private repos: a fine-grained token with Contents read-only, or \`npx openflowkit map . --html map.html\` on a checkout).
- Diagrams as code: the OpenFlow DSL (${url('openflow-dsl')}); Mermaid, Structurizr and D2 import.
- Self-host: one Docker image (${url('self-hosting')}); \`OPENFLOWKIT_AI_UPSTREAM\` turns on a same-origin AI proxy for a local model.
- How to draw well, for agents: https://app.openflowkit.com/llms.txt
`;
