// The README's animated SVGs, exported by the CLI from their sources, light and dark:
//   assets/motion/flow-build-*.svg  ← README's `flowchart` block + its `animate` block (build preset)
//   assets/readme/how-it-works-*.svg ← assets/readme/how-it-works.ofk (pulse preset)
// Re-run after a renderer change, or after editing either source:
//
//   npm --prefix mcp-server run build && node scripts/readme/diagrams.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'ofk-diagrams-'));
const cli = (...args) => execFileSync('node', ['mcp-server/dist/cli.js', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });

/** The README's fenced block that starts with `word`, so the picture always shows the text beside it. */
function readmeBlock(word) {
  const block = [...readFileSync('README.md', 'utf8').matchAll(/```\n([\s\S]*?)```/g)].map(([, body]) => body)
    .find((body) => body.startsWith(word));
  if (!block) throw new Error(`README.md has no fenced block starting with "${word}"`);
  return block;
}

function exportAnimated(source, name, args, out) {
  const ofk = join(scratch, `${name}.ofk`);
  const doc = join(scratch, `${name}.openflow.json`);
  writeFileSync(ofk, source);
  cli('convert', ofk, '-o', doc);
  for (const theme of ['light', 'dark']) {
    const result = JSON.parse(cli('op', 'export', '--doc', doc, '--args', JSON.stringify({ format: 'svg-animated', scope: 'page', loop: true, theme, ...args })));
    writeFileSync(`${out}-${theme}.svg`, result.output.files[0].text);
    console.log(`${out}-${theme}.svg`);
  }
}

exportAnimated(`${readmeBlock('flowchart')}\n${readmeBlock('animate')}`, 'flow-build', { preset: 'build', order: 'code' }, 'assets/motion/flow-build');
exportAnimated(readFileSync('assets/readme/how-it-works.ofk', 'utf8'), 'how-it-works', { preset: 'pulse' }, 'assets/readme/how-it-works');
