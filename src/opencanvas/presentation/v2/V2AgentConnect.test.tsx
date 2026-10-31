import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentPrompt, claudeCodeCommand, codexCommand, HOSTED_MCP_URL, installLinks, mcpConfig, V2AgentConnect, type V2AgentConnectProps } from './V2AgentConnect';
import { ELSEWHERE, TOKEN_REJECTED, WAITING } from './useV2AgentBridge';

const base: V2AgentConnectProps = {
  status: 'off', detail: '', port: 43119, token: 'tok', activity: null,
  onPortChange: vi.fn(), onTokenChange: vi.fn(), onToggle: vi.fn(), onClose: vi.fn(),
};

describe('V2AgentConnect', () => {
  // jsdom has no ResizeObserver; the agent picker's popover places itself with one.
  beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
  afterEach(() => vi.unstubAllGlobals());

  it('offers a Claude Code one-liner carrying the token (and the port when it is not the default)', async () => {
    // User scope: the default (local) scope adds it to one project only, and the next repo has no OpenFlowKit (U3 2026-10-11).
    expect(claudeCodeCommand(43119, 'tok')).toBe('claude mcp add -s user openflowkit -e OPENFLOWKIT_BRIDGE_TOKEN=tok -- npx -y openflowkit mcp');
    expect(claudeCodeCommand(5000, '')).toBe('claude mcp add -s user openflowkit -e OPENFLOWKIT_BRIDGE_PORT=5000 -- npx -y openflowkit mcp');
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const onToggle = vi.fn();
    render(<V2AgentConnect {...base} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Terminal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));
    expect(writeText).toHaveBeenCalledWith(claudeCodeCommand(43119, 'tok'));
    // Copying the setup means the agent is next: the panel starts waiting for it.
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('does not promise a review MCP edits never get', () => {
    render(<V2AgentConnect {...base} />);
    expect(screen.queryByText(/review every change/)).toBeNull();
    expect(screen.getByText(/each change is one undo step/)).toBeTruthy();
  });

  it('a rejected token is red; waiting for the agent is not an alert', () => {
    const { rerender } = render(<V2AgentConnect {...base} status="error" detail={TOKEN_REJECTED} />);
    expect(screen.getByRole('alert').textContent).toBe(TOKEN_REJECTED);
    rerender(<V2AgentConnect {...base} status="waiting" detail={WAITING} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(WAITING)).toBeTruthy();
    // Nobody can "start the server": the agent does. The panel says what the person can do.
    expect(document.body.textContent).not.toMatch(/start the (MCP )?server/i);
    expect(screen.getByRole('button', { name: 'Stop waiting' })).toBeTruthy();
  });

  it('another tab has the bridge: says so, and Use this tab claims it', () => {
    const onClaim = vi.fn();
    render(<V2AgentConnect {...base} status="elsewhere" detail={ELSEWHERE} onClaim={onClaim} />);
    expect(screen.getByText(ELSEWHERE)).toBeTruthy();
    // Its setup is done in that tab: no steps to repeat here (persona F11).
    expect(screen.queryByRole('button', { name: 'Copy command' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use this tab' }));
    expect(onClaim).toHaveBeenCalledTimes(1);
  });

  // Persona F09: the settings note named Disconnect while nothing was connected and the fields were editable.
  it('says how to change settings only while the fields are locked, with the button that unlocks them', () => {
    const { rerender } = render(<V2AgentConnect {...base} />);
    expect(screen.queryByText(/to change settings/)).toBeNull();
    rerender(<V2AgentConnect {...base} status="waiting" detail={WAITING} />);
    expect(screen.getByText(/Stop waiting to change settings/)).toBeTruthy();
    rerender(<V2AgentConnect {...base} status="connected" />);
    expect(screen.getByText(/Disconnect to change settings/)).toBeTruthy();
  });

  it('a command wraps at its spaces, never inside a flag', () => {
    render(<V2AgentConnect {...base} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Terminal' }));
    const command = document.querySelector('.ofk-connection-snippet')!;
    const flags = [...command.querySelectorAll('.ofk-connection-flag')].map((flag) => flag.textContent);
    expect(flags).toEqual(['-s', '-e', '--', '-y']);
    expect(command.querySelector('.ofk-v2-bridge-snippet')?.textContent).toBe(claudeCodeCommand(43119, 'tok'));
  });

  it('says who is working, then offers Undo for its change', () => {
    const onUndo = vi.fn();
    const { rerender } = render(<V2AgentConnect {...base} status="connected" activity={{ agent: 'Claude Code', doing: 'drawing', change: null }} onUndo={onUndo} />);
    expect(screen.getByText('Claude Code is drawing…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    rerender(<V2AgentConnect {...base} status="connected" activity={{ agent: 'Claude Code', doing: null, change: 'restyled 2 shapes' }}
      agents={['Claude Code', 'Cursor']} onUndo={onUndo} />);
    expect(screen.getByText('Claude Code, Cursor')).toBeTruthy();
    expect(screen.getByText('Claude Code restyled 2 shapes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('each agent gets its own setup, all carrying the same server and pairing env', () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<V2AgentConnect {...base} />);
    const pick = (name: string, way?: string) => {
      fireEvent.click(screen.getByRole('button', { name: /^Your agent/ }));
      fireEvent.click(screen.getByRole('option', { name: new RegExp(`^${name}`) }));
      if (way) fireEvent.click(screen.getByRole('radio', { name: way }));
    };
    pick('Claude Desktop', 'Config file');
    expect(screen.getByText('claude_desktop_config.json')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy configuration' }));
    expect(writeText).toHaveBeenLastCalledWith(mcpConfig(43119, 'tok'));
    pick('Codex', 'Terminal');
    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));
    expect(writeText).toHaveBeenLastCalledWith('codex mcp add openflowkit --env OPENFLOWKIT_BRIDGE_TOKEN=tok -- npx -y openflowkit mcp');
    expect(codexCommand(5000, '')).toBe('codex mcp add openflowkit --env OPENFLOWKIT_BRIDGE_PORT=5000 -- npx -y openflowkit mcp');
    pick('Cursor');
    expect(screen.getByRole('link', { name: 'Add to Cursor' }).getAttribute('href')).toBe(installLinks(43119, 'tok').cursor);
    fireEvent.click(screen.getByRole('radio', { name: 'Prompt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    expect(writeText).toHaveBeenLastCalledWith(agentPrompt('cursor', 43119, 'tok'));
    pick('VS Code', 'One click');
    expect(screen.getByRole('link', { name: 'Add to VS Code' }).getAttribute('href')).toBe(installLinks(43119, 'tok').vscode);
    expect(screen.getByText(/Using the Claude Code extension\? Pick Claude Code/)).toBeTruthy();
  });

  // Owner 2026-10-14: a prompt to paste into the agent, not only a terminal command; one way shows at a time.
  it('offers a prompt the agent sets itself up from, carrying the same server and pairing env', () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const onToggle = vi.fn();
    render(<V2AgentConnect {...base} onToggle={onToggle} />);
    expect(screen.getAllByRole('radio').map((radio) => radio.closest('label')!.textContent)).toEqual(['Prompt', 'Terminal']);
    expect(screen.getAllByRole('button', { name: /^Copy/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    expect(writeText).toHaveBeenLastCalledWith(agentPrompt('claude-code', 43119, 'tok'));
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(agentPrompt('claude-code', 43119, 'tok')).toContain(claudeCodeCommand(43119, 'tok'));
    expect(agentPrompt('codex', 5000, '')).toContain(codexCommand(5000, ''));
    const server = { command: 'npx', args: ['-y', 'openflowkit', 'mcp'], env: { OPENFLOWKIT_BRIDGE_TOKEN: 'tok' } };
    for (const client of ['cursor', 'claude-desktop'] as const) {
      const json = agentPrompt(client, 43119, 'tok').match(/\n\n(\{[\s\S]*\})\n\n/)![1]!;
      expect(JSON.parse(json)).toEqual({ openflowkit: server });
    }
    const vscode = agentPrompt('vscode', 43119, 'tok').match(/code --add-mcp '(.*)'/)![1]!;
    expect(JSON.parse(vscode)).toEqual({ name: 'openflowkit', ...server });
    for (const client of ['claude-code', 'claude-desktop', 'cursor', 'vscode', 'codex'] as const) {
      expect(agentPrompt(client, 43119, 'tok')).toMatch(/Then tell me to /);
    }
  });

  it('is honest that chat apps draw cards in the chat, not on this canvas', () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const onToggle = vi.fn();
    render(<V2AgentConnect {...base} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: /^Your agent/ }));
    fireEvent.click(screen.getByRole('option', { name: /^claude\.ai or ChatGPT/ }));
    expect(screen.getByText(/not on this canvas/)).toBeTruthy();
    expect(screen.getByText(/No sign-in/)).toBeTruthy();
    expect(screen.getByText(/\+ → Connectors/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
    expect(writeText).toHaveBeenCalledWith(HOSTED_MCP_URL);
    // Nothing local will answer for a chat app: copying its URL does not start waiting.
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('one-click links carry the same server and pairing env as the copied config', () => {
    const { cursor, vscode } = installLinks(5000, 'tok');
    const server = { command: 'npx', args: ['-y', 'openflowkit', 'mcp'], env: { OPENFLOWKIT_BRIDGE_PORT: '5000', OPENFLOWKIT_BRIDGE_TOKEN: 'tok' } };
    const cursorUrl = new URL(cursor);
    expect(cursorUrl.protocol).toBe('cursor:');
    expect(cursorUrl.searchParams.get('name')).toBe('openflowkit');
    expect(JSON.parse(atob(cursorUrl.searchParams.get('config')!))).toEqual(server);
    expect(vscode.startsWith('vscode:mcp/install?')).toBe(true);
    expect(JSON.parse(decodeURIComponent(vscode.slice('vscode:mcp/install?'.length)))).toEqual({ name: 'openflowkit', ...server });
    expect(JSON.parse(atob(new URL(installLinks(43119, '').cursor).searchParams.get('config')!))).not.toHaveProperty('env');
  });
});
