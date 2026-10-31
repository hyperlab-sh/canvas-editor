#!/usr/bin/env node
// `npm run stats [-- 7|30|90]`: usage and feedback from the share Worker's D1 (`openflowkit-data`), plus public growth
// numbers. The same loadStats as stats.openflowkit.com (stats/queries.ts), so the two never disagree. Read-only.
// D1 is reached through wrangler's own login (`npx wrangler login`), from worker/ so its config resolves.
// Imports .ts: Node 22.18+ strips types.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { USAGE_EVENTS, PAY_OPTIONS } from '../src/services/usage/usageEvents.ts';
import {
  DASH, RANGES, WORKERS_PAID_REQUESTS, fixed, inlineParams, int, loadStats, pct, retentionLabel,
} from '../stats/queries.ts';

const WORKER_DIR = fileURLToPath(new URL('../worker/', import.meta.url));
const DATABASE = 'openflowkit-data';
const days = Number(process.argv[2] ?? 30);
if (!RANGES.includes(days)) {
  console.error(`Range is one of ${RANGES.join(', ')} days, not ${process.argv[2]}.`);
  process.exit(1);
}

/** All statements in one wrangler call; one row array per statement, or throws with wrangler's message. */
async function run(queries) {
  let output;
  try {
    output = execFileSync('npx', ['wrangler', 'd1', 'execute', DATABASE, '--remote', '--json', '--command', queries.map(inlineParams).join(';\n')], {
      cwd: WORKER_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const text = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    let reason = text.split('\n').find((line) => /error|✘/i.test(line)) ?? error.message;
    try { reason = JSON.parse(error.stdout).error?.text ?? reason; } catch { /* not JSON */ }
    throw new Error(reason.trim());
  }
  return JSON.parse(output).map((result) => result.results ?? []);
}

function table(title, rows, columns = rows[0] ? Object.keys(rows[0]) : []) {
  console.log(`\n${title}`);
  if (!rows.length) { console.log('  (none yet)'); return; }
  const cells = rows.map((row) => columns.map((column) => (row[column] ?? DASH).toString()));
  const widths = columns.map((column, i) => Math.max(column.length, ...cells.map((cell) => cell[i].length)));
  const numeric = columns.map((_, i) => cells.every((cell) => /^[-\d.,%*—]+$/.test(cell[i])));
  const line = (values) => '  ' + values.map((value, i) => numeric[i] ? value.padStart(widths[i]) : value.padEnd(widths[i])).join('  ');
  console.log(line(columns));
  for (const cell of cells) console.log(line(cell));
}

const now = new Date();
console.log(`OpenFlowKit stats — ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC (D1 ${DATABASE}, last ${days} days)`);

try {
  const s = await loadStats(run, now, days);
  table(`Daily active people (${days} days, UTC; today is partial)`, s.daily.map((row) => ({
    day: row.day, people: int(row.people), new: int(row.new), sessions: int(row.sessions),
  })));
  table('Reach', [
    { metric: 'People today (partial)', value: int(s.reach.dau) },
    { metric: 'WAU (7 days)', value: int(s.reach.wau) },
    { metric: 'MAU (30 days)', value: int(s.reach.mau) },
    { metric: 'Stickiness (avg DAU / MAU, 30 days)', value: pct(s.reach.stickiness) },
    { metric: 'New people this week (7 days)', value: int(s.reach.newThisWeek) },
    { metric: `Activation (new people who created on day 1, ${days} days)`, value: `${pct(s.activation.rate)} of ${int(s.activation.people)}` },
    { metric: `Sessions per active person (${days} days)`, value: fixed(s.sessionsPerPerson, 2) },
    { metric: `Median engaged minutes per active day (${days} days)`, value: fixed(s.medianMinutes) },
  ]);
  table(`Day-N retention (of people first seen in the last ${days} days at least N days ago, back on day N)`, s.dayRetention.map((row) => ({
    day: row.day, people: int(row.size), back: pct(row.rate),
  })));
  table(`Activation by source (new people, ${days} days)`, s.activationBySource.map((row) => ({
    source: row.name, people: int(row.people), created_day_one: pct(row.rate),
  })));
  table('Weekly retention (cohort = first-seen week; * = window still running)', s.retention.map((row) => ({
    cohort: row.cohort, people: int(row.size), week1: retentionLabel(row.week1), week4: retentionLabel(row.week4),
  })));
  table(`Feature adoption (% of ${days}-day active people who used it)`, s.adoption.map((row) => ({
    feature: row.family, people: int(row.people), share: pct(row.share),
  })));
  table(`Event totals (${days} days)`, USAGE_EVENTS.map((event) => ({ event, count: int(s.totals[event]) })));
  table(`Share loop (${days} days)`, [
    { step: 'share links made (view)', count: int(s.share.view) },
    { step: 'share links made (edit)', count: int(s.share.edit) },
    { step: 'link visits that went on to edit (read-only viewers send nothing)', count: int(s.share.sharedSessions) },
    { step: 'viewers who copied to edit', count: int(s.share.copied) },
  ]);
  console.log(`\nErrors: ${fixed(s.errorsPer1k)} per 1k sessions (${days} days)`);
  table(`Top sources (${days} days, by people; a person can appear under several)`, s.sources);
  table(`Top countries (${days} days, by people)`, s.countries);
  // ponytail: share-link requests aren't in D1, so this counts beacons only. Upgrade: the Workers analytics API.
  console.log(`\nWorker budget: ${int(s.budget.requests)} beacons in 30 days of ${int(WORKERS_PAID_REQUESTS)} requests/month on Workers Paid (${pct(s.budget.share)}; share links not counted).`);
  if (s.budget.share >= 0.6) console.log('  WARNING: over 60%. Past 10M a month, requests cost $0.30 per million.');

  table(`Feature thumbs (${days} days)`, s.thumbs.map((row) => ({ ...row, up_share: pct(row.up + row.down ? row.up / (row.up + row.down) : null) })));
  table(`PMF: "How would you feel if you could no longer use OpenFlowKit?" (${days} days)`, ['very', 'somewhat', 'not'].map((answer) => ({
    disappointed: answer, people: int(s.pmf[answer]), share: pct(s.pmf.total ? s.pmf[answer] / s.pmf.total : null),
  })));
  console.log(`  ${pct(s.pmf.veryShare)} very disappointed of ${int(s.pmf.total)} (40% is the usual PMF bar)`);
  table(`Would pay for (${days} days, votes)`, PAY_OPTIONS.map((option) => ({ option, votes: int(s.pay[option]) })));
  console.log(`\nPro waitlist (${days} days): ${int(s.pro.opened)} opened it, ${int(s.pro.joined)} joined (${pct(s.pro.joinRate)})`);
  table('  Plan they\'d join', Object.entries(s.pro.plans).map(([plan, people]) => ({ plan, people: int(people) })));
  table(`  Feels fair a month (median ${s.pro.price.median === null ? '—' : `$${s.pro.price.median}`})`, s.pro.price.bands);
  table('  Would pay for (waitlist)', Object.entries(s.pro.features).filter(([option]) => option !== 'free').map(([option, votes]) => ({ option, votes: int(votes) })));
  console.log(`\nEmails left: ${int(s.emails)} (${days} days)`);
  console.log(s.unread ? `Unread feedback: ${int(s.unread.count)} (mark read at stats.openflowkit.com)`
    : 'Unread feedback: unavailable — apply worker/migrations/0002_feedback_read.sql');
  console.log('\nLatest comments');
  if (!s.comments.length) console.log('  (none yet)');
  for (const row of s.comments) console.log(`  ${row.day} ${row.kind}${row.feature ? `/${row.feature}` : ''}: ${row.text.replace(/\s+/g, ' ')}`);
} catch (error) {
  console.log(`\nD1 unavailable — ${error.message.split('\n')[0]}`);
}

async function publicNumber(label, url, pick) {
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'openflowkit-stats', Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    console.log(`  ${label}: ${int(pick(await response.json()))}`);
  } catch (error) {
    console.log(`  ${label}: unavailable — ${error.message}`);
  }
}
console.log('\nPublic growth');
await publicNumber('npm downloads last week (openflowkit)',
  'https://api.npmjs.org/downloads/point/last-week/openflowkit', (body) => body.downloads);
await publicNumber('GitHub stars (openflowkit/openflowkit)', 'https://api.github.com/repos/openflowkit/openflowkit', (body) => body.stargazers_count);
