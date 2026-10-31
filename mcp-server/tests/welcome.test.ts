import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { main, type CliIo } from '../src/cli.js';
import { welcome } from '../src/lib/welcome.js';

const run = async (terminal?: CliIo['terminal']) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([], { out: (m) => out.push(m), err: (m) => err.push(m), ...(terminal ? { terminal } : {}) });
  return { code, out: stripVTControlCharacters(out.join('\n')), err: err.join('\n') };
};

describe('bare openflowkit', () => {
  it('greets a person at a terminal and exits 0', async () => {
    const shown = await run({ columns: 100, color: true });
    expect(shown.code).toBe(0);
    expect(shown.out).toContain('██');
    expect(shown.out).toContain('Welcome to OpenFlowKit');
    expect(shown.out).toContain('openflowkit render');
    expect(shown.err).toBe('');
  });

  it('keeps the usage error for scripts and pipes', async () => {
    const piped = await run();
    expect(piped.code).toBe(2);
    expect(piped.err).toContain('Usage:');
    expect(piped.out).toBe('');
  });
});

describe('welcome', () => {
  it('drops the big letters on a narrow terminal', () => {
    const narrow = welcome({ columns: 60, color: true, version: '1.0.0' });
    expect(narrow).not.toContain('██');
    expect(narrow).toContain('OpenFlowKit');
  });

  it('fits 80 columns and has no colour codes under NO_COLOR', () => {
    const plain = welcome({ columns: 80, color: false, version: '1.0.0' });
    expect(plain).not.toContain('\u001b[');
    expect(Math.max(...plain.split('\n').map((line) => line.length))).toBeLessThanOrEqual(80);
  });
});
