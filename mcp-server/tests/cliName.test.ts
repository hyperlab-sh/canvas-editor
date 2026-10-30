import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliIo } from '../src/cli.js';

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (message) => out.push(message), err: (message) => err.push(message) }, out, err };
}

/** The name is read when the module loads, so each case loads it fresh with the variable set. */
async function loadMain(name?: string): Promise<(typeof import('../src/cli.js'))['main']> {
  if (name === undefined) delete process.env.CANVAS_CLI_NAME;
  else process.env.CANVAS_CLI_NAME = name;
  vi.resetModules();
  return (await import('../src/cli.js')).main;
}

afterEach(() => { delete process.env.CANVAS_CLI_NAME; });

describe('CANVAS_CLI_NAME', () => {
  it('keeps canvas when unset or blank', async () => {
    for (const name of [undefined, '', '  ']) {
      const run = capture();
      expect(await (await loadMain(name))(['--help'], run.io)).toBe(0);
      const text = run.out.join('\n');
      expect(text).toContain('canvas serve');
      expect(text.split('\n')[0]).toMatch(/^canvas — /);
    }
  });

  it('names the command in help, command help, version and errors', async () => {
    const main = await loadMain('diagrams');
    const help = capture();
    expect(await main(['--help'], help.io)).toBe(0);
    const text = help.out.join('\n');
    expect(text.split('\n')[0]).toMatch(/^diagrams — /);
    for (const command of ['serve', 'mcp', 'render', 'op', 'discover']) expect(text).toContain(`  diagrams ${command}`);
    expect(text).not.toMatch(/\bcanvas (op|ops|render|convert|validate|discover|drift|build|map|mcp|serve)\b/);

    for (const command of ['serve', 'render', 'map']) {
      const one = capture();
      expect(await main([command, '--help'], one.io), command).toBe(0);
      expect(one.out.join('\n')).toMatch(new RegExp(`^diagrams ${command}`));
      expect(one.out.join('\n')).not.toContain('canvas ');
    }

    const version = capture();
    expect(await main(['--version'], version.io)).toBe(0);
    expect(version.out[0]).toMatch(/^diagrams \d/);

    const unknown = capture();
    expect(await main(['nope'], unknown.io)).toBe(2);
    expect(unknown.err.join('\n')).toContain('diagrams: unknown command "nope"');
  });
});
