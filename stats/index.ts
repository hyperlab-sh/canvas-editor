// Private stats page, stats.openflowkit.com. One server-rendered page over the share Worker's D1 (`openflowkit-data`):
//   GET  /?range=7|30|90  the dashboard (default 30 days), numbers from loadStats (queries.ts), same as `npm run stats`
//   POST /read            "Mark all read" (form: before, range) → 303 back to the page
// Two locks, both fail closed: a Cloudflare Access application in front, and this Worker verifying Access's JWT
// itself (RS256 against the team's JWKS), so a misconfigured or bypassed Access still shows nothing.
// No scripts on the page (CSP default-src 'none'): charts are inline SVG and CSS, hover is SVG <title>.
// Types are the minimum this file uses from Workers; no @cloudflare/workers-types dependency.

import { FEEDBACK_FEATURES } from '../src/services/usage/usageEvents.ts';
import {
  RANGES, fixed, int, loadStats, markReadQuery, pct, retentionLabel,
  type FeedbackRow, type RangeDays, type Ranked, type Row, type Run, type Stats,
} from './queries.ts';

export interface D1StatementLike { bind(...values: unknown[]): D1StatementLike }
export interface D1DatabaseLike {
  prepare(sql: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<{ results?: Row[] }[]>;
}
export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}
export interface Env {
  DB: D1DatabaseLike;
  /** `<team>.cloudflareaccess.com`, from Zero Trust settings. Empty: every request is 403. */
  TEAM_DOMAIN?: string;
  /** The Access application's Audience (AUD) tag. Empty: every request is 403. */
  POLICY_AUD?: string;
}
type JwksCache = Map<string, { keys: Map<string, CryptoKey>; expires: number }>;
export interface Deps {
  fetcher?: typeof fetch;
  now?: () => Date;
  /** Cache API store for the growth numbers; absent: fetched every time. */
  cache?: CacheLike;
  jwks?: JwksCache;
}

export const STATS_ORIGIN = 'https://stats.openflowkit.com';
const JWKS_TTL_MS = 3_600_000;
const GROWTH_TTL_SECONDS = 3_600;
const BUDGET_WARN = 0.6;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const sharedJwks: JwksCache = new Map();

// ---- auth -------------------------------------------------------------------------------------------------------

const base64url = (value: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), (char) => char.charCodeAt(0));
const decodeJson = (value: string): Record<string, unknown> => JSON.parse(new TextDecoder().decode(base64url(value)));
const hostOf = (teamDomain: string): string => teamDomain.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');

async function signingKeys(host: string, fetcher: typeof fetch, now: number, cache: JwksCache): Promise<Map<string, CryptoKey> | null> {
  const cached = cache.get(host);
  if (cached && cached.expires > now) return cached.keys;
  const response = await fetcher(`https://${host}/cdn-cgi/access/certs`);
  if (!response.ok) return null;
  const { keys = [] } = await response.json() as { keys?: (JsonWebKey & { kid?: string })[] };
  const imported = new Map<string, CryptoKey>();
  for (const jwk of keys) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    imported.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  // ponytail: a token signed by a key newer than the cache waits up to an hour. Access publishes keys before using them.
  cache.set(host, { keys: imported, expires: now + JWKS_TTL_MS });
  return imported;
}

/** True only for an RS256 Access JWT signed by the team's key, for this audience and issuer, not expired. */
export async function verifyAccessJwt(
  token: string | null, config: { teamDomain?: string; aud?: string },
  fetcher: typeof fetch = fetch, now = Date.now(), cache: JwksCache = sharedJwks,
): Promise<boolean> {
  const host = hostOf(config.teamDomain ?? '');
  if (!token || !host || !config.aud) return false;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [header, payload, signature] = parts;
    const head = decodeJson(header);
    if (head.alg !== 'RS256' || typeof head.kid !== 'string') return false;
    const key = (await signingKeys(host, fetcher, now, cache))?.get(head.kid);
    if (!key) return false;
    const signed = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64url(signature), new TextEncoder().encode(`${header}.${payload}`));
    if (!signed) return false;
    const claims = decodeJson(payload);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    return audiences.includes(config.aud) && claims.iss === `https://${host}`
      && typeof claims.exp === 'number' && claims.exp * 1000 > now
      && (claims.nbf === undefined || (typeof claims.nbf === 'number' && claims.nbf * 1000 <= now));
  } catch {
    return false;
  }
}

/** Access sends the JWT as a header; the CF_Authorization cookie carries the same token. */
export function accessToken(request: Request): string | null {
  const header = request.headers.get('Cf-Access-Jwt-Assertion');
  if (header) return header;
  const cookie = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(request.headers.get('Cookie') ?? '');
  return cookie?.[1] ?? null;
}

// ---- growth -----------------------------------------------------------------------------------------------------

export const GROWTH_SOURCES = {
  stars: { url: 'https://api.github.com/repos/openflowkit/openflowkit', pick: (body: Record<string, unknown>) => body.stargazers_count },
  npm: { url: 'https://api.npmjs.org/downloads/point/last-week/openflowkit', pick: (body: Record<string, unknown>) => body.downloads },
} as const;
export type Growth = Record<keyof typeof GROWTH_SOURCES, number | null>;

/** A public number, cached an hour; null (shown as —) on any failure, which is never cached. */
async function publicNumber(source: (typeof GROWTH_SOURCES)[keyof typeof GROWTH_SOURCES], fetcher: typeof fetch, cache?: CacheLike): Promise<number | null> {
  try {
    const key = new Request(source.url);
    let body = await (await cache?.match(key))?.text();
    if (body === undefined) {
      // ponytail: GitHub allows 60 unauthenticated calls an hour per IP, shared on Workers; a token secret if — shows up.
      const response = await fetcher(source.url, {
        headers: { 'User-Agent': 'openflowkit-stats', Accept: 'application/json' }, signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) return null;
      body = await response.text();
      await cache?.put(key, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${GROWTH_TTL_SECONDS}` } }));
    }
    const value = source.pick(JSON.parse(body));
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export async function loadGrowth(fetcher: typeof fetch, cache?: CacheLike): Promise<Growth> {
  const [stars, npm] = await Promise.all([publicNumber(GROWTH_SOURCES.stars, fetcher, cache), publicNumber(GROWTH_SOURCES.npm, fetcher, cache)]);
  return { stars, npm };
}

// ---- page -------------------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** HTML-escapes text and attribute values. Feedback text, emails and every D1 string are attacker-controlled. */
export const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (char) => ENTITIES[char]);

const FAMILY_LABELS: Record<string, string> = {
  created: 'Created a diagram', repo_map: 'Mapped a repo', ai: 'Applied an AI edit', agent: 'Used an agent (MCP)',
  share_link: 'Made a share link', export: 'Exported', code_panel: 'Opened the code panel', shared_copied: 'Copied a shared diagram',
};
const FEATURE_NAMES: Record<string, string> = { repo_map: 'Repo map', ai: 'AI assistant', agent: 'Agent', export: 'Export', share: 'Share link' };
const PAY_NAMES: Record<string, string> = {
  collaboration: 'Real-time collaboration', private_repos: 'Private repos + PR checks', sync: 'Sync across devices', free: 'Nothing, free is great',
  history: 'Version history', libraries: 'Team libraries', private_links: 'Private share links', ai_included: 'AI included', sso: 'SSO and audit logs',
  comments: 'Comments and mentions', drift: 'Drift alerts on PRs', integrations: 'Notion, Confluence, Slack', branding: 'Unbranded embeds',
  self_host: 'Self-hosted',
};
const PLAN_NAMES: Record<string, string> = { pro: 'Pro ($8, founding $6)', team: 'Team ($12/person, founding $9)', enterprise: 'Enterprise' };

const SOURCE_NAMES: Record<string, string> = {
  hn: 'Hacker News', producthunt: 'Product Hunt', x: 'X', reddit: 'Reddit', github: 'GitHub', google: 'Google',
  linkedin: 'LinkedIn', direct: 'Direct', other: 'Other sites',
};
/** A stored id in words; anything unknown (a utm_source, a new value) shows as stored. */
const named = (names: Record<string, string>, id: string | null | undefined): string => (id ? names[id] ?? id : '');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDay = (day: string): string => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
const when = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

const tile = (label: string, value: string, note = ''): string =>
  `<div class="tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div>${note ? `<div class="tile-note">${note}</div>` : ''}</div>`;
const section = (title: string, body: string, note = ''): string =>
  `<section><h2>${title}</h2>${note ? `<p class="note">${note}</p>` : ''}${body}</section>`;
const empty = (text = 'No data yet.'): string => `<p class="empty">${text}</p>`;

/** Horizontal bars, one series: length is share of `scale` (the largest value, or 1 for rates). */
function bars(rows: readonly { label: string; value: number; display: string }[], scale = Math.max(0, ...rows.map((row) => row.value))): string {
  if (!rows.length) return empty();
  return `<ul class="bars">${rows.map((row) => {
    const width = scale > 0 ? Math.min(100, (100 * row.value) / scale) : 0;
    return `<li title="${esc(row.label)}: ${esc(row.display)}"><span class="bar-label">${esc(row.label)}</span>`
      + `<span class="bar-track"><span class="bar" style="width:${width.toFixed(2)}%"></span></span><span class="bar-value">${esc(row.display)}</span></li>`;
  }).join('')}</ul>`;
}
const rankedBars = (list: readonly Ranked[]): string => bars(list.map((row) => ({ label: row.name, value: row.people, display: int(row.people) })));

/** Clean y ticks: a 1/2/5 step giving at most ~4 intervals, integers only. */
function yTicks(max: number): number[] {
  const rough = Math.max(1, max / 4);
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * power).find((candidate) => candidate >= rough) ?? 10 * power);
  const top = Math.max(step, Math.ceil(max / step) * step);
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
}

/** Daily active people with new people as a second series. Plot stretches (non-scaling strokes); text is HTML. */
function dailyChart(stats: Stats): string {
  const { daily } = stats;
  const ticks = yTicks(Math.max(0, ...daily.flatMap((row) => [row.people, row.new])));
  const top = ticks[ticks.length - 1];
  const x = (i: number) => (daily.length > 1 ? (1000 * i) / (daily.length - 1) : 500);
  const y = (value: number) => 200 - (200 * value) / top;
  const path = (key: 'people' | 'new') => daily.map((row, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(row[key]).toFixed(1)}`).join(' ');
  const band = 1000 / Math.max(1, daily.length - 1);
  const last = daily[daily.length - 1];
  const hits = daily.map((row, i) => `<rect class="hit" x="${Math.max(0, x(i) - band / 2).toFixed(1)}" y="0" width="${band.toFixed(1)}" height="200">`
    + `<title>${row.day}: ${int(row.people)} active, ${int(row.new)} new, ${int(row.sessions)} sessions</title></rect>`).join('');
  const grid = ticks.map((tick) => `<line class="${tick ? 'grid' : 'axis'}" x1="0" x2="1000" y1="${y(tick)}" y2="${y(tick)}"/>`).join('');
  const labels = ticks.map((tick) => `<span class="ytick" style="top:${(100 * y(tick)) / 200}%">${int(tick)}</span>`).join('');
  const dots = (['people', 'new'] as const).map((key) => `<span class="dot dot-${key}" style="left:100%;top:${(100 * y(last[key])) / 200}%"></span>`).join('');
  const middle = daily[Math.floor((daily.length - 1) / 2)];
  const table = `<details><summary>Show as table</summary><div class="scroll"><table><thead><tr><th>Day (UTC)</th><th>Active</th><th>New</th><th>Sessions</th></tr></thead><tbody>`
    + daily.map((row) => `<tr><td>${row.day}</td><td>${int(row.people)}</td><td>${int(row.new)}</td><td>${int(row.sessions)}</td></tr>`).join('')
    + '</tbody></table></div></details>';
  return `<figure class="chart">
<div class="legend"><span><i class="key key-people"></i>Active people <b>${int(last.people)}</b> today</span><span><i class="key key-new"></i>New people <b>${int(last.new)}</b> today</span></div>
<div class="plot">${labels}<svg viewBox="0 0 1000 200" preserveAspectRatio="none" role="img" aria-label="Daily active and new people, last ${stats.days} days">
${grid}<path class="line line-people" d="${path('people')}"/><path class="line line-new" d="${path('new')}"/>${hits}</svg>${dots}</div>
<div class="xaxis"><span>${shortDay(daily[0].day)}</span><span>${shortDay(middle.day)}</span><span>${shortDay(last.day)}</span></div>
${table}</figure>`;
}

function feedbackItem(row: FeedbackRow): string {
  const tags = [row.kind, named(FEATURE_NAMES, row.feature), row.rating && `rated ${row.rating}`, row.pmf && `PMF: ${row.pmf}`,
    row.plan && `plan: ${named(PLAN_NAMES, row.plan)}`, row.price !== null && row.price !== undefined && `fair: $${row.price}/mo`,
    ...(row.pay ? row.pay.split(',').map((option) => `pays for: ${named(PAY_NAMES, option)}`) : [])].filter(Boolean);
  const meta = [row.email ? `<a href="mailto:${esc(row.email)}">${esc(row.email)}</a>` : '', esc(row.country), `v${esc(row.version)}`, esc(when(row.created_at))]
    .filter(Boolean).join(' · ');
  return `<li class="feedback"><div class="tags">${tags.map((tag) => `<span class="tag">${esc(tag)}</span>`).join('')}</div>`
    + `${row.text ? `<p class="feedback-text">${esc(row.text)}</p>` : ''}<div class="feedback-meta">${meta}</div></li>`;
}

function unreadSection(stats: Stats): string {
  const { unread } = stats;
  if (!unread) return section('Unread feedback', empty('Unavailable: apply worker/migrations/0002_feedback_read.sql to D1.'));
  if (!unread.items.length) return section('Unread feedback', empty('Nothing unread.'));
  const shown = unread.count > unread.items.length ? ` (newest ${unread.items.length} shown)` : '';
  return section(`Unread feedback <span class="count">${int(unread.count)}</span>`,
    `<form method="post" action="/read"><input type="hidden" name="before" value="${esc(unread.items[0].created_at)}">`
    + `<input type="hidden" name="range" value="${stats.days}"><button type="submit">Mark all read</button></form>`
    + `<ul class="feedback-list">${unread.items.map(feedbackItem).join('')}</ul>`, `Newest first${shown}.`);
}

export function renderPage(stats: Stats, growth: Growth): string {
  const { reach, days } = stats;
  const range = RANGES.map((option) => `<a href="/?range=${option}"${option === days ? ' aria-current="page"' : ''}>${option} days</a>`).join('');
  const budgetWarn = stats.budget.share >= BUDGET_WARN;
  const thumbs = stats.thumbs.length
    ? `<div class="scroll"><table><thead><tr><th>Feature</th><th>Up</th><th>Down</th><th>Up share</th></tr></thead><tbody>${stats.thumbs.map((row) =>
      `<tr><td>${esc(named(FEATURE_NAMES, row.feature))}</td><td>${int(row.up)}</td><td>${int(row.down)}</td><td>${pct(row.up + row.down ? row.up / (row.up + row.down) : null)}</td></tr>`).join('')}</tbody></table></div>`
    : empty('No feature ratings yet.');
  const body = [
    unreadSection(stats),
    section('Headline', `<div class="tiles">${[
      tile('People today', int(reach.dau), 'UTC day so far'),
      tile('Weekly active', int(reach.wau), 'last 7 days'),
      tile('Monthly active', int(reach.mau), 'last 30 days'),
      tile('Stickiness', pct(reach.stickiness), 'average DAU ÷ MAU'),
      tile('New this week', int(reach.newThisWeek), 'first seen, last 7 days'),
      tile('Very disappointed', pct(stats.pmf.veryShare), `${int(stats.pmf.total)} answers · 40% is the bar`),
    ].join('')}</div>`),
    section('Daily active people', dailyChart(stats), `Last ${days} days. Today is partial. Hover a day for its numbers.`),
    section('Retention', `<div class="tiles">${stats.dayRetention.map((row) =>
      tile(`Day ${row.day}`, pct(row.rate, 0), `${int(row.size)} new people old enough`)).join('')}</div><div class="scroll"><table><thead><tr><th>Cohort (week of)</th><th>People</th><th>Week 1</th><th>Week 4</th></tr></thead><tbody>${
      stats.retention.map((row) => `<tr><td>${row.cohort}</td><td>${int(row.size)}</td><td>${retentionLabel(row.week1)}</td><td>${retentionLabel(row.week4)}</td></tr>`).join('')
    }</tbody></table></div>`, 'Day N = of people first seen in the range at least N days ago, back exactly N days later. Cohort = the Monday week a person was first seen. Week 1 = days 7–13 after it starts, week 4 = days 28–34. * window still open; — not started or no one in the cohort.'),
    section('Activation', `<div class="tiles">${[
      tile('Created on day one', pct(stats.activation.rate), `${int(stats.activation.activated)} of ${int(stats.activation.people)} new people`),
      tile('Sessions per person', fixed(stats.sessionsPerPerson, 2), `${int(reach.active)} active people`),
      tile('Median engaged minutes', fixed(stats.medianMinutes), 'per person per active day'),
    ].join('')}</div>${stats.activationBySource.length
      ? `<div class="scroll"><table><thead><tr><th>Came from</th><th>New people</th><th>Created on day one</th></tr></thead><tbody>${stats.activationBySource.map((row) =>
        `<tr><td>${esc(named(SOURCE_NAMES, row.name))}</td><td>${int(row.people)}</td><td>${pct(row.rate, 0)} · ${int(row.activated)}</td></tr>`).join('')}</tbody></table></div>`
      : ''}`, `Last ${days} days.`),
    section('Feature adoption', bars(stats.adoption.map((row) => ({
      label: FAMILY_LABELS[row.family] ?? row.family, value: row.share ?? 0, display: `${pct(row.share, 0)} · ${int(row.people)}`,
    })), 1), `Share of the ${int(reach.active)} people active in the last ${days} days who used each at least once.`),
    `<div class="pair">${section('Top sources', rankedBars(stats.sources.map((row) => ({ ...row, name: named(SOURCE_NAMES, row.name) }))), 'People, last ' + days + ' days. A person can count under several.')}`
    + `${section('Top countries', rankedBars(stats.countries), `People, last ${days} days.`)}</div>`,
    section('Share loop', `<div class="tiles">${[
      tile('View links made', int(stats.share.view)),
      tile('Edit links made', int(stats.share.edit)),
      tile('Link visits that went on to edit', int(stats.share.sharedSessions), 'viewers who only read send nothing'),
      tile('Viewers who copied to edit', int(stats.share.copied), 'shared visits that became users'),
    ].join('')}</div>`, `Last ${days} days.`),
    section('Product fit and money', `<div class="pair"><div><h3>If OpenFlowKit went away</h3>${stats.pmf.total ? bars((['very', 'somewhat', 'not'] as const).map((answer) => ({
      label: `${answer} disappointed`, value: stats.pmf[answer], display: `${pct(stats.pmf[answer] / stats.pmf.total, 0)} · ${int(stats.pmf[answer])}`,
    }))) : empty('No answers yet.')}</div><div><h3>Would pay for</h3>${bars(Object.entries(stats.pay).map(([option, votes]) => ({
      label: named(PAY_NAMES, option), value: votes, display: int(votes),
    })))}</div></div><div class="tiles">${tile('Emails left', int(stats.emails))}</div><h3>Feature ratings</h3>${thumbs}`,
    `Last ${days} days of feedback. Features asked about: ${FEEDBACK_FEATURES.join(', ')}.`),
    section('Pro waitlist', `<div class="tiles">${[
      tile('Opened it', int(stats.pro.opened), `${pct(reach.active ? stats.pro.opened / reach.active : null)} of ${int(reach.active)} active people`),
      tile('Joined', int(stats.pro.joined), `${pct(stats.pro.joinRate)} of those who opened it`),
    ].join('')}</div><div class="pair"><div><h3>Plan they'd join</h3>${stats.pro.joined ? bars(Object.entries(stats.pro.plans).map(([plan, n]) => ({
      label: named(PLAN_NAMES, plan), value: n, display: `${pct(n / stats.pro.joined, 0)} · ${int(n)}`,
    }))) : empty('No one yet.')}</div><div><h3>Feels fair a month${stats.pro.price.median === null ? '' : ` · median $${int(stats.pro.price.median)}`}</h3>${
      stats.pro.price.answered ? bars(stats.pro.price.bands.map((band) => ({ label: band.label, value: band.people, display: int(band.people) })))
        : empty('No answers yet.')}</div></div><h3>Would pay for</h3>${stats.pro.joined ? bars(Object.entries(stats.pro.features)
      .filter(([option]) => option !== 'free').sort(([, a], [, b]) => b - a).map(([option, n]) => ({
        label: named(PAY_NAMES, option), value: n, display: `${pct(n / stats.pro.joined, 0)} · ${int(n)}`,
      }))) : empty('No one yet.')}`, `Last ${days} days. A waitlist, not sales: nobody has paid. The fair-price slider starts at the plan's founding price.`),
    section('Growth outside the app', `<div class="tiles">${[
      tile('GitHub stars', int(growth.stars), 'openflowkit/openflowkit'),
      tile('npm downloads', int(growth.npm), '`openflowkit`, last week'),
    ].join('')}</div>`, 'Fetched server-side, cached for an hour. — means the source did not answer.'),
    section('Health', `<div class="tiles">${tile('Errors per 1k sessions', fixed(stats.errorsPer1k), `last ${days} days`)}</div>`
      + `<div class="meter${budgetWarn ? ' warn' : ''}"><div class="meter-label">Usage beacons, last 30 days, vs the 10M requests Workers Paid includes <b>${int(stats.budget.requests)} (${pct(stats.budget.share)})</b></div>`
      + `<div class="meter-track"><div class="meter-fill" style="width:${Math.min(100, 100 * stats.budget.share).toFixed(2)}%"></div></div>`
      + (budgetWarn ? '<p class="warning"><b>Warning:</b> over 60%. Past 10M a month, requests cost $0.30 per million.</p>' : '')
      + '<p class="note">Counts beacons only; share links use the same allowance.</p></div>'),
  ].join('\n');
  return htmlDocument('OpenFlowKit stats', `<header><div><h1>OpenFlowKit stats</h1><p class="note">Updated ${esc(when(stats.generatedAt))} · all days are UTC</p></div>`
    + `<nav class="range" aria-label="Range">${range}</nav></header><main>${body}</main>`);
}

export const renderDenied = (): string =>
  htmlDocument('Not authorised', '<main><section><h1>Not authorised</h1><p class="note">Sign in through Cloudflare Access to see this page.</p></section></main>');

const STYLE = `
:root{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink-2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;
--border:rgba(11,11,11,.10);--s1:#2a78d6;--s2:#eb6834;--track:#cde2fb;--warning:#fab219;--hover:rgba(11,11,11,.05);--link:#1c5cab}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink-2:#c3c2b7;--grid:#2c2c2a;
--axis:#383835;--border:rgba(255,255,255,.10);--s1:#3987e5;--s2:#d95926;--track:#104281;--hover:rgba(255,255,255,.06);--link:#86b6ef}}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
header,main{max-width:1080px;margin:0 auto;padding:0 16px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;justify-content:space-between;padding-top:24px}
h1{font-size:22px;margin:0}h2{font-size:17px;margin:0 0 4px}h3{font-size:14px;margin:16px 0 8px;color:var(--ink-2)}
a{color:var(--link)}
.note,.empty{color:var(--ink-2);font-size:13px;margin:0 0 12px}
section{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;margin:16px 0;min-width:0}
.range{display:flex;border:1px solid var(--border);border-radius:8px;overflow:hidden}
.range a{padding:6px 12px;text-decoration:none;color:var(--ink-2);font-size:13px}
.range a[aria-current]{background:var(--ink);color:var(--surface);font-weight:600}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.tile{border:1px solid var(--border);border-radius:8px;padding:12px}
.tile-label{font-size:13px;color:var(--ink-2)}.tile-value{font-size:28px;font-weight:600;margin:2px 0}.tile-note{font-size:12px;color:var(--ink-2)}
table,.bar-value,.ytick,.xaxis,.count,.meter-label b{font-variant-numeric:tabular-nums}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:right;padding:6px 8px;border-bottom:1px solid var(--grid);white-space:nowrap}
th:first-child,td:first-child{text-align:left}th{font-weight:600;color:var(--ink-2);font-size:13px}
.chart{margin:0}
.legend{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:13px;color:var(--ink-2);margin-bottom:12px}
.legend b{color:var(--ink)}
.key{display:inline-block;width:14px;height:2px;vertical-align:middle;margin-right:6px;border-radius:1px}
.key-people{background:var(--s1)}.key-new{background:var(--s2)}
.plot{position:relative;height:180px;margin:8px 8px 0 36px}
.plot svg{display:block;width:100%;height:100%;overflow:visible}
.grid{stroke:var(--grid);stroke-width:1;vector-effect:non-scaling-stroke}
.axis{stroke:var(--axis);stroke-width:1;vector-effect:non-scaling-stroke}
.line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}
.line-people{stroke:var(--s1)}.line-new{stroke:var(--s2)}
.hit{fill:transparent}.hit:hover{fill:var(--hover)}
.ytick{position:absolute;right:calc(100% + 8px);transform:translateY(-50%);font-size:11px;color:var(--muted)}
.dot{position:absolute;width:10px;height:10px;border-radius:50%;transform:translate(-50%,-50%);box-shadow:0 0 0 2px var(--surface);pointer-events:none}
.dot-people{background:var(--s1)}.dot-new{background:var(--s2)}
.xaxis{display:flex;justify-content:space-between;margin:6px 8px 0 36px;font-size:11px;color:var(--muted)}
details{margin-top:12px;font-size:13px}summary{cursor:pointer;color:var(--ink-2)}
.bars{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.bars li{display:grid;grid-template-columns:minmax(90px,38%) 1fr auto;gap:8px;align-items:center;font-size:14px}
.bar-label{overflow-wrap:anywhere}
.bar-track{height:12px}.bar{display:block;height:12px;background:var(--s1);border-radius:0 4px 4px 0}
.bar-value{color:var(--ink-2);font-size:13px;white-space:nowrap}
.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:0 16px}
.pair>section{margin:16px 0}
.count{display:inline-block;min-width:24px;padding:0 8px;border-radius:12px;background:var(--ink);color:var(--surface);font-size:13px;text-align:center;vertical-align:2px}
form{margin:0 0 12px}
button{font:inherit;font-size:14px;padding:6px 14px;border-radius:8px;border:1px solid var(--border);background:var(--ink);color:var(--surface);cursor:pointer}
.feedback-list{list-style:none;margin:0;padding:0}
.feedback{border-top:1px solid var(--grid);padding:12px 0}
.tags{display:flex;flex-wrap:wrap;gap:6px}
.tag{font-size:12px;padding:1px 8px;border-radius:10px;border:1px solid var(--border);color:var(--ink-2)}
.feedback-text{margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.feedback-meta{font-size:13px;color:var(--ink-2);overflow-wrap:anywhere}
.meter{margin-top:16px}.meter-label{font-size:14px;color:var(--ink-2);margin-bottom:6px}.meter-label b{color:var(--ink)}
.meter-track{height:12px;border-radius:6px;background:var(--track);overflow:hidden}
.meter-fill{height:100%;background:var(--s1);border-radius:6px}
.warn .meter-fill{background:var(--warning)}
.warning{font-size:14px;margin:8px 0}
.meter .note{margin:8px 0 0}
`;

function htmlDocument(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head>`
    + `<body>${body}</body></html>`;
}

// ---- routes -----------------------------------------------------------------------------------------------------

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'",
  'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
};
const html = (status: number, body: string): Response =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS } });
const denied = (): Response => html(403, renderDenied());
const parseRange = (value: string | null): RangeDays => RANGES.find((option) => String(option) === value) ?? 30;

export function d1Run(db: D1DatabaseLike): Run {
  return async (queries) => (await db.batch(queries.map((query) => db.prepare(query.sql).bind(...query.params)))).map((result) => result.results ?? []);
}

export async function handle(request: Request, env: Env, deps: Deps = {}): Promise<Response> {
  const fetcher = deps.fetcher ?? fetch;
  const now = deps.now?.() ?? new Date();
  if (!(await verifyAccessJwt(accessToken(request), { teamDomain: env.TEAM_DOMAIN, aud: env.POLICY_AUD }, fetcher, now.getTime(), deps.jwks))) {
    return denied();
  }
  const url = new URL(request.url);
  const run = d1Run(env.DB);
  if (url.pathname === '/' && request.method === 'GET') {
    const [stats, growth] = await Promise.all([loadStats(run, now, parseRange(url.searchParams.get('range'))), loadGrowth(fetcher, deps.cache)]);
    return html(200, renderPage(stats, growth));
  }
  if (url.pathname === '/read' && request.method === 'POST') {
    // A cross-site form post would carry the Access cookie; only our own page may mark feedback read.
    const origin = request.headers.get('Origin');
    if (origin !== STATS_ORIGIN && origin !== url.origin) return denied();
    const form = new URLSearchParams(await request.text());
    const before = form.get('before') ?? '';
    if (!ISO_TIME.test(before)) return html(400, htmlDocument('Bad request', '<main><section><h1>Bad request</h1></section></main>'));
    await run([markReadQuery(now, before)]);
    return new Response(null, { status: 303, headers: { Location: `/?range=${parseRange(form.get('range'))}`, ...SECURITY_HEADERS } });
  }
  return html(404, htmlDocument('Not found', '<main><section><h1>Not found</h1></section></main>'));
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> =>
    handle(request, env, { cache: (globalThis as { caches?: { default?: CacheLike } }).caches?.default }),
};
