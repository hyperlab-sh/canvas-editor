#!/usr/bin/env node
// Release notes for a tag, or exit 1 when the tag doesn't match what the repo says (.github/workflows/release.yml).
//   vX.Y.Z      → package.json must be X.Y.Z; notes = CHANGELOG.md's `## [X.Y.Z]` section.
//   mcp-vX.Y.Z  → mcp-server/package.json must be X.Y.Z; notes point at npm and the changelog.
import { readFileSync } from 'node:fs';
import process from 'node:process';
import assert from 'node:assert/strict';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const fail = (message) => { console.error(`release-notes: ${message}`); process.exit(1); };

/** The body of `## [version]` up to the next `## [`, without its heading line. */
export function changelogSection(changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start < 0) return null;
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## ['));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

function notes(tag) {
  const mcp = /^mcp-v(\d+\.\d+\.\d+)$/.exec(tag);
  if (mcp) {
    const { version } = JSON.parse(read('mcp-server/package.json'));
    if (version !== mcp[1]) fail(`tag ${tag} but mcp-server/package.json is ${version}`);
    return `MCP server ${version}: \`npx -y openflowkit@${version} mcp\` ` +
      `([npm](https://www.npmjs.com/package/openflowkit/v/${version})). ` +
      'Changes are under "For developers" in [CHANGELOG.md](https://github.com/openflowkit/openflowkit/blob/main/CHANGELOG.md).';
  }
  const app = /^v(\d+\.\d+\.\d+)$/.exec(tag);
  if (!app) fail(`${tag} is neither vX.Y.Z nor mcp-vX.Y.Z`);
  const { version } = JSON.parse(read('package.json'));
  if (version !== app[1]) fail(`tag ${tag} but package.json is ${version}`);
  const section = changelogSection(read('CHANGELOG.md'), version);
  if (!section) fail(`CHANGELOG.md has no "## [${version}]" section`);
  return section;
}

if (process.argv[2] === '--self-check') {
  const sample = '# C\n\n## [Unreleased]\n\nnext\n\n## [2.1.0] — 2026-10-12\n\n### Highlights\n\n- a\n\n## [2.0.0] — x\n\nold\n';
  assert.equal(changelogSection(sample, '2.1.0'), '### Highlights\n\n- a');
  assert.equal(changelogSection(sample, '2.0.0'), 'old');
  assert.equal(changelogSection(sample, '9.9.9'), null);
  console.log('release-notes self-check ok');
} else if (process.argv[2]) {
  process.stdout.write(`${notes(process.argv[2])}\n`);
} else {
  fail('usage: node scripts/release-notes.mjs <vX.Y.Z | mcp-vX.Y.Z | --self-check>');
}
