// The Claude Code and Codex plugins share plugin/ (listed by .claude-plugin/ and
// .agents/plugins/ marketplace.json): one .mcp.json launching the MCP server from npm,
// plus the skill. A plugin installs only its own folder, so it carries a copy of the
// skill; neither may drift.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const plugin = json('plugin/.claude-plugin/plugin.json');
const codex = json('plugin/.codex-plugin/plugin.json');
const mcp = json('plugin/.mcp.json');
const marketplace = json('.claude-plugin/marketplace.json');
const codexMarketplace = json('.agents/plugins/marketplace.json');
const pkg = json('mcp-server/package.json');
const alias = json('cli/package.json');

describe('claude code and codex plugins', () => {
  it('has the version of the MCP package it launches', () => {
    expect(plugin.version).toBe(pkg.version);
    expect(codex.version).toBe(pkg.version);
    expect(alias.version).toBe(pkg.version);
  });

  it('launches the real package through npx', () => {
    expect(plugin.mcpServers).toBe('./.mcp.json');
    expect(codex.mcpServers).toBe('./.mcp.json');
    // `openflowkit` (cli/) is the public name; `openflowkit mcp` runs the server from @openflowkit/openflowkit-mcp.
    expect(mcp.mcpServers.openflowkit).toEqual({ command: 'npx', args: ['-y', alias.name, 'mcp'] });
    expect(alias.dependencies[pkg.name]).toBe(pkg.version);
  });

  it('is listed by the repo marketplace and ships the current skill (npm run skill:sync)', () => {
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: plugin.name, source: './plugin' })]);
    expect(codexMarketplace.plugins).toEqual([expect.objectContaining({ name: codex.name, source: { source: 'local', path: './plugin' } })]);
    for (const path of [codex.skills, codex.interface.composerIcon, codex.interface.logo]) expect(existsSync(`plugin/${path}`)).toBe(true);
    expect(readFileSync('plugin/skills/openflowkit/SKILL.md', 'utf8')).toBe(readFileSync('skills/openflowkit/SKILL.md', 'utf8'));
  });
});
