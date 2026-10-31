import { useState } from 'react';
import {
  IconBrush, IconCamera, IconCheck, IconChevronDown, IconCopy, IconDownload, IconEye, IconPencil, IconPhotoSearch,
  IconPlugConnected, IconTerminal2,
} from '@tabler/icons-react';
import { Button, Dropdown, Icon, Panel, Segmented, type DropdownOption } from '../design-system';
import { BRIDGE_DEFAULT_PORT } from '../../../agent/bridge/protocol';
import { type V2AgentActivity, type V2BridgeStatus } from './useV2AgentBridge';

interface V2AgentConnectModel {
  readonly status: V2BridgeStatus;
  readonly detail: string;
  /** What the agent is doing, or its last change (with an Undo) while that change is the top of the undo stack. */
  readonly activity?: V2AgentActivity | null;
  /** Agents drawing over this connection (several sessions can share it), latest first. */
  readonly agents?: readonly string[];
  readonly onUndo?: () => void;
  readonly port: number;
  readonly token: string;
  readonly onPortChange: (port: number) => void;
  readonly onTokenChange: (token: string) => void;
  readonly onToggle: (connect: boolean) => void;
  /** "Use this tab": take the bridge back from another tab. */
  readonly onClaim?: () => void;
  /** WebMCP tools this browser's agents can call; 0 or absent when the browser has no WebMCP (nothing is shown). */
  readonly webMcpTools?: number;
  /** The last change an agent in this browser applied (its undo label). */
  readonly webMcpActivity?: string | null;
}
export interface V2AgentConnectProps extends V2AgentConnectModel { readonly onClose: () => void; }

const STATUS_LABEL: Record<V2BridgeStatus, string> = {
  off: 'Not connected', connecting: 'Connecting…', waiting: 'Waiting for agent', connected: 'Connected',
  elsewhere: 'In another tab', error: 'Connection unavailable',
};
const CAPABILITIES = [
  { icon: IconEye, title: 'Read', text: 'Every page, shape and connector as structured data.' },
  { icon: IconPencil, title: 'Draw', text: 'Generate or update a diagram from the OpenFlow DSL.' },
  { icon: IconBrush, title: 'Style', text: 'Move, recolour and restyle what is already on the canvas.' },
  { icon: IconPhotoSearch, title: 'Icons', text: 'Search the icon library and place the right one.' },
  { icon: IconCamera, title: 'See', text: 'Take a screenshot to check its own work.' },
  { icon: IconDownload, title: 'Export', text: 'Hand you PNG, SVG or JSON when it is done.' },
] as const;

/** The hosted connector: stateless, it draws cards in a chat and cannot reach this canvas. */
export const HOSTED_MCP_URL = 'https://mcp.openflowkit.com/mcp';

export type AgentClient = 'claude-code' | 'claude-desktop' | 'cursor' | 'vscode' | 'codex' | 'web';
const CLIENTS: readonly DropdownOption[] = [
  { value: 'claude-code', label: 'Claude Code', hint: 'Terminal or VS Code' },
  { value: 'claude-desktop', label: 'Claude Desktop' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'vscode', label: 'VS Code', hint: 'Copilot' },
  { value: 'codex', label: 'Codex' },
  { value: 'web', label: 'claude.ai or ChatGPT', hint: 'In chat' },
];
/** How step 1 is done: by the agent from a pasted prompt, or by hand. One shows at a time. */
type Way = 'prompt' | 'terminal' | 'config' | 'link';
const WAY_LABEL: Record<Way, string> = { prompt: 'Prompt', terminal: 'Terminal', config: 'Config file', link: 'One click' };
const WAYS: Record<Exclude<AgentClient, 'web'>, readonly Way[]> = {
  'claude-code': ['prompt', 'terminal'], codex: ['prompt', 'terminal'], cursor: ['link', 'prompt'], vscode: ['link', 'prompt'],
  'claude-desktop': ['config', 'prompt'],
};
/** What to do once it is added: the agent starts the server, never the person. */
const THEN: Record<Exclude<AgentClient, 'web'>, string> = {
  'claude-code': 'Start a new Claude Code session (or run /mcp to reconnect), then ask it to draw.',
  'claude-desktop': 'Quit Claude Desktop fully, open it again, then ask it to draw.',
  cursor: 'Open a new Agent chat in Cursor and ask it to draw.',
  vscode: 'In Copilot Chat, switch to Agent mode and ask it to draw.',
  codex: 'Start a new codex session, then ask it to draw.',
};

const bridgeEnv = (port: number, token: string): Record<string, string> =>
  ({ ...(port !== BRIDGE_DEFAULT_PORT ? { OPENFLOWKIT_BRIDGE_PORT: String(port) } : {}), ...(token ? { OPENFLOWKIT_BRIDGE_TOKEN: token } : {}) });

/** The same server as one `claude mcp add` line, for Claude Code: user scope, so every project has it, not just this one. */
export function claudeCodeCommand(port: number, token: string): string {
  const env = Object.entries(bridgeEnv(port, token)).map(([key, value]) => `-e ${key}=${value} `).join('');
  return `claude mcp add -s user openflowkit ${env}-- npx -y openflowkit mcp`;
}

/** The same server for the Codex CLI (`codex mcp add NAME --env K=V -- COMMAND`). */
export function codexCommand(port: number, token: string): string {
  const env = Object.entries(bridgeEnv(port, token)).map(([key, value]) => `--env ${key}=${value} `).join('');
  return `codex mcp add openflowkit ${env}-- npx -y openflowkit mcp`;
}

/** One-click installs (Cursor's and VS Code's own link schemes) carrying the same server and env as the copied config. */
export function installLinks(port: number, token: string): { cursor: string; vscode: string } {
  const server = serverEntry(port, token);
  return {
    cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=openflowkit&config=${encodeURIComponent(btoa(JSON.stringify(server)))}`,
    vscode: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'openflowkit', ...server }))}`,
  };
}

const serverEntry = (port: number, token: string) => {
  const env = bridgeEnv(port, token);
  return { command: 'npx', args: ['-y', 'openflowkit', 'mcp'], ...(Object.keys(env).length ? { env } : {}) };
};

/**
 * What to paste into an agent so it adds OpenFlowKit itself: the same server and pairing env as the copied setup, and the
 * one thing it cannot do (reload its own tools) handed back to the person. Claude Desktop's is for another agent that can
 * edit files, since Claude Desktop cannot edit its own config.
 */
export function agentPrompt(client: Exclude<AgentClient, 'web'>, port: number, token: string): string {
  const json = JSON.stringify({ openflowkit: serverEntry(port, token) }, null, 2);
  const merge = 'Merge this into its "mcpServers" object, keeping any servers already there:';
  switch (client) {
    case 'claude-code': return `Add the OpenFlowKit MCP server so you can draw on my OpenFlowKit canvas. Run this once in a terminal:\n\n${claudeCodeCommand(port, token)}\n\nThen tell me to run /mcp (or start a new session) so its tools load.`;
    case 'codex': return `Add the OpenFlowKit MCP server so you can draw on my OpenFlowKit canvas. Run this once in a terminal:\n\n${codexCommand(port, token)}\n\nThen tell me to start a new codex session so its tools load.`;
    case 'cursor': return `Add the OpenFlowKit MCP server to my Cursor config, ~/.cursor/mcp.json (create it if it is missing). ${merge}\n\n${json}\n\nThen tell me to open a new Agent chat so its tools load.`;
    case 'vscode': return `Add the OpenFlowKit MCP server to VS Code. Run this once in a terminal (quote the JSON for my shell):\n\ncode --add-mcp '${JSON.stringify({ name: 'openflowkit', ...serverEntry(port, token) })}'\n\nThen tell me to switch Copilot Chat to Agent mode so its tools load.`;
    case 'claude-desktop': return `Add the OpenFlowKit MCP server to my Claude Desktop config, claude_desktop_config.json (in ~/Library/Application Support/Claude/ on a Mac, %APPDATA%\\Claude\\ on Windows). ${merge}\n\n${json}\n\nIf \`which npx\` is not on a standard path, use its full path as "command". Then tell me to quit Claude Desktop fully and open it again.`;
  }
}

/** The MCP client config: the editor's token goes in env so the server and this window pair on their own. */
export function mcpConfig(port: number, token: string): string {
  return JSON.stringify({ mcpServers: { openflowkit: serverEntry(port, token) } }, null, 2);
}

/** Rail panel for the MCP bridge: per-agent setup when off, a live status card when an agent is on. */
export function V2AgentConnect(props: V2AgentConnectProps) {
  const [draftPort, setDraftPort] = useState(String(props.port));
  const [draftToken, setDraftToken] = useState(props.token);
  const [copyStatus, setCopyStatus] = useState('');
  const [client, setClient] = useState<AgentClient>('claude-code');
  const [chosenWay, setWay] = useState<Way>('prompt');
  const connected = props.status === 'connected';
  const running = props.status !== 'off';
  const port = Number(draftPort);
  const validPort = Number.isInteger(port) && port > 0 && port < 65536;
  const links = installLinks(props.port, props.token);
  // Copying the setup means "I am about to start my agent": wait for it from here on.
  const connectNow = () => { if (props.status === 'off' && validPort) props.onToggle(true); };
  async function copy(text: string, done: string, connect = true): Promise<void> {
    if (connect) connectNow();
    try { await navigator.clipboard.writeText(text); setCopyStatus(done); }
    catch { setCopyStatus('Could not copy. Select the text and copy it instead.'); }
  }
  const snippet = (text: string, name: string, connect = true) => <div className="ofk-connection-snippet" data-prompt={name === 'Copy prompt' || undefined}>
    {/* Breaks at spaces: a flag (`-e`, `--`) never splits after its hyphen. Copy takes `text`, not the DOM. */}
    <pre className="ofk-v2-bridge-snippet">{text.split(/( )/).map((part, at) => (part.startsWith('-') && part.length <= 6
      ? <span key={at} className="ofk-connection-flag">{part}</span> : part))}</pre>
    <Button variant="quiet" aria-label={name} onClick={() => { void copy(text, `${name.replace('Copy', 'Copied')}`, connect); }}>
      <Icon icon={copyStatus === name.replace('Copy', 'Copied') ? IconCheck : IconCopy} />Copy
    </Button>
  </div>;

  const ways = client === 'web' ? [] : WAYS[client];
  const way = ways.includes(chosenWay) ? chosenWay : ways[0];
  const clientName = CLIENTS.find((option) => option.value === client)?.label ?? '';
  // The prompt is pasted into the agent, which adds OpenFlowKit itself; the other way is doing it by hand.
  const setup = (agent: Exclude<AgentClient, 'web'>): React.ReactNode => {
    if (way === 'prompt') {
      return <><p>{agent === 'claude-desktop' ? 'Paste into Claude Code or Cursor, which can edit Claude Desktop’s config for you.'
        : `Paste into ${clientName}. It adds OpenFlowKit itself.`}</p>{snippet(agentPrompt(agent, props.port, props.token), 'Copy prompt')}</>;
    }
    if (way === 'terminal') {
      return <><p>Run once in a terminal.</p>
        {snippet(agent === 'codex' ? codexCommand(props.port, props.token) : claudeCodeCommand(props.port, props.token), 'Copy command')}</>;
    }
    if (way === 'config') {
      return <><p>Settings → Developer → Edit Config, then add this to <code>claude_desktop_config.json</code>.
        If npx is not found, use the full path from <code>which npx</code>.</p>
        {snippet(mcpConfig(props.port, props.token), 'Copy configuration')}</>;
    }
    return <><p>{agent === 'vscode' ? 'For Copilot agent mode. Using the Claude Code extension? Pick Claude Code.' : 'Then approve it in Cursor.'}</p>
      <a className="ofk-button" data-variant="secondary" href={agent === 'vscode' ? links.vscode : links.cursor} onClick={connectNow}>
        Add to {agent === 'vscode' ? 'VS Code' : 'Cursor'}</a></>;
  };

  return <Panel title="Connect agent" onClose={props.onClose} closeLabel="Close agent connection"
    className="ofk-v2-workspace-panel ofk-connection-panel" data-status={props.status}
    tools={<span className="ofk-connection-badge"><span className="ofk-connection-dot" />{STATUS_LABEL[props.status]}</span>}>
    <div className="ofk-connection-hero" aria-hidden="true">
      <span className="ofk-connection-hero-node"><Icon icon={IconTerminal2} />Agent</span>
      <span className="ofk-connection-hero-link"><i /><i /><i /></span>
      <span className="ofk-connection-hero-node ofk-connection-hero-canvas"><img src="/Logo_openflowkit.svg" width="16" height="16" alt="" />Canvas</span>
    </div>
    {connected ? <>
      <h3>Your agent is on the canvas.</h3>
      <p className="ofk-connection-lede">Everything it draws lands here as one undo step, like any edit of your own.</p>
      <div className="ofk-connection-summary">
        <span className="ofk-connection-mark"><Icon icon={IconPlugConnected} /></span>
        <div><strong>Live over MCP</strong><span className="ofk-connection-endpoint">127.0.0.1:{props.port}</span>
          {props.agents?.length ? <span className="ofk-connection-agents">{props.agents.join(', ')}</span> : null}</div>
        <Button variant="quiet" onClick={() => props.onToggle(false)}>Disconnect</Button>
      </div>
      {props.activity ? <p className="ofk-connection-activity" role="status" data-working={props.activity.doing ? '' : undefined}>
        {props.activity.doing ? <><span className="ofk-connection-dot" /><span>{props.activity.agent} is {props.activity.doing}…</span></>
          : <span>{props.activity.agent} {props.activity.change}</span>}
        {!props.activity.doing && props.onUndo ? <Button variant="quiet" onClick={props.onUndo}>Undo</Button> : null}</p> : null}
      <h4 className="ofk-connection-heading">What your agent can do</h4>
      <ul className="ofk-connection-capabilities">
        {CAPABILITIES.map(({ icon, title, text }) => <li key={title}><Icon icon={icon} /><strong>{title}</strong><span>{text}</span></li>)}
      </ul>
    </> : <>
      <h3>Your agent, on your canvas.</h3>
      <p className="ofk-connection-lede">An agent on this computer can read this document and draw on it — each change is one undo step.</p>
      {props.status === 'error' ? <p role="alert" className="ofk-connection-error"><strong>{props.detail}</strong></p> : null}
      {props.status === 'waiting' || props.status === 'connecting' ? <p role="status" className="ofk-connection-waiting">
        <span className="ofk-connection-dot" /><span>{props.status === 'waiting' ? props.detail : 'Connecting…'}</span></p> : null}
      {props.status === 'elsewhere' ? <div role="status" className="ofk-connection-elsewhere"><span>{props.detail}</span>
        {props.onClaim ? <Button variant="primary" onClick={props.onClaim}>Use this tab</Button> : null}</div> : null}
      {/* Another tab has Connect on: its setup is done; the steps would only repeat it. */}
      {props.status === 'elsewhere' ? null : <><div className="ofk-connection-client">
        <Dropdown label="Your agent" value={client} options={CLIENTS} onChange={(value) => setClient(value as AgentClient)} />
      </div>
      {client === 'web' ? <>
        <p className="ofk-connection-web"><strong>These draw diagram cards in your chat, not on this canvas.</strong> Each card has an Open in OpenFlowKit link that opens it here.</p>
        <ol className="ofk-connection-steps">
          <li><span>1</span><div><strong>Copy the connector URL</strong>{snippet(HOSTED_MCP_URL, 'Copy URL', false)}</div></li>
          <li><span>2</span><div><strong>Add it as a custom connector</strong><p>claude.ai: Settings → Connectors (Customize → Connectors on newer
            accounts) → Add custom connector. Paste the URL and choose No sign-in. ChatGPT takes the same URL where your plan allows it.</p></div></li>
          <li><span>3</span><div><strong>Turn it on in a chat</strong><p>Press + → Connectors and turn OpenFlowKit on, then ask for a diagram.</p></div></li>
        </ol>
        <p className="ofk-connection-note">On a Team or Enterprise plan only an owner can add connectors.</p>
      </> : <ol className="ofk-connection-steps">
        <li><span>1</span><div><strong>Add OpenFlowKit to {clientName}</strong>
          <div className="ofk-connection-way"><Segmented<Way> label="How" value={way!} onChange={setWay}
            options={ways.map((value) => ({ value, label: WAY_LABEL[value] }))} /></div>
          {setup(client)}</div></li>
        <li><span>2</span><div><strong>{THEN[client]}</strong><p>This panel connects by itself.</p>
          {running ? <Button variant="quiet" onClick={() => props.onToggle(false)}>{props.status === 'error' ? 'Stop retrying' : 'Stop waiting'}</Button>
            : <Button variant="primary" disabled={!validPort} onClick={() => props.onToggle(true)}><Icon icon={IconPlugConnected} />Connect</Button>}
        </div></li>
      </ol>}</>}
    </>}
    {props.webMcpTools ? <>
      <p className="ofk-connection-activity" data-testid="webmcp-status"><span>WebMCP (experimental): agents in this browser can use {props.webMcpTools} tools.</span></p>
      {props.webMcpActivity ? <p className="ofk-connection-activity" role="status"><span>Browser agent: {props.webMcpActivity}</span>
        {props.onUndo ? <Button variant="quiet" onClick={props.onUndo}>Undo</Button> : null}</p> : null}
    </> : null}
    <details className="ofk-accordion ofk-connection-details" open={props.status === 'error' || undefined}><summary>Connection settings<Icon icon={IconChevronDown} /></summary>
      <div className="ofk-accordion-body">
        <div className="ofk-connection-fields">
          <label htmlFor="ofk-bridge-port">Port<input id="ofk-bridge-port" className="ofk-v2-bridge-input" inputMode="numeric" value={draftPort}
            disabled={running} aria-invalid={!validPort || undefined} onChange={(event) => setDraftPort(event.target.value.replace(/[^0-9]/g, ''))}
            onBlur={() => { if (validPort) props.onPortChange(port); }} /></label>
          <label htmlFor="ofk-bridge-token">Token<input id="ofk-bridge-token" type="password" autoComplete="off" className="ofk-v2-bridge-input"
            value={draftToken} disabled={running} placeholder="Server token" onChange={(event) => setDraftToken(event.target.value)}
            onBlur={() => props.onTokenChange(draftToken.trim())} /></label>
        </div>
        {!validPort ? <p role="alert" className="ofk-connection-error">Use a port between 1 and 65535.</p> : null}
        <p>{running && props.status !== 'elsewhere' ? `${connected ? 'Disconnect' : props.status === 'error' ? 'Stop retrying' : 'Stop waiting'} to change settings. ` : ''}
          The copied setup carries both, so copy it again after a change.</p>
      </div>
    </details>
    {copyStatus ? <span className="ofk-copy-feedback" role="status">{copyStatus}</span> : null}
  </Panel>;
}
