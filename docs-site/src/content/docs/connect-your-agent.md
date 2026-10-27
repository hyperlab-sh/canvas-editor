---
title: Connect your agent
description: Add OpenFlowKit to Claude Code, Claude Desktop, Cursor, VS Code, Codex, claude.ai or ChatGPT, then pair it with the canvas you have open.
---

There are two ways in. Pick by where your agent runs.

| | Local MCP server | Hosted connector |
| --- | --- | --- |
| **For** | Claude Code, Claude Desktop, Cursor, VS Code, Codex, Windsurf | claude.ai, Claude Desktop, ChatGPT |
| **Install** | One command or one click. Your agent runs `npx -y openflowkit mcp` on your computer (Node 20.11 or newer) | Paste `https://mcp.openflowkit.com/mcp`. Nothing to install |
| **Draws** | On the canvas you have open, one undo step per change. With no editor open, in `.openflow.json` files in your repo | A diagram card in the chat, with **Open in OpenFlowKit**. Not on your open canvas |
| **Tools** | All of them: see [MCP server](/mcp-server/) | Drawing and the grammar only. No files, no live canvas, no repo tools |

The app has the same steps. Open **Connect agent** in the editor and pick your client under **Your agent**. Step 1
has two ways: **Prompt**, a message you paste into the agent so it adds OpenFlowKit itself, or the command, config or
one-click link to do it by hand (**Terminal**, **Config file**, **One click**). Whichever you copy carries this
browser's pairing token. The prompt reaches your agent's model with the token in it; the token only pairs a server
on your own machine with this browser.
[app.openflowkit.com/#/connect](https://app.openflowkit.com/#/connect) opens the editor with that panel open and
Connect on.

## Claude Code

The terminal and the Claude Code extension for VS Code share this setup. Run it once:

```bash
claude mcp add -s user openflowkit -- npx -y openflowkit mcp
```

`-s user` adds it for every project, not only the folder you are in. Start a new Claude Code session (or run `/mcp`
to reconnect), then ask it to draw. `claude mcp list` shows `openflowkit` once it is added.

Or install the plugin, which adds the server and the diagram skill together:

```bash
claude plugin marketplace add openflowkit/openflowkit
claude plugin install openflowkit@openflowkit
```

## Claude Desktop

### Local server: draws on your canvas

Open Settings → Developer → Edit Config. That opens `claude_desktop_config.json`:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add OpenFlowKit to it:

```json
{
  "mcpServers": {
    "openflowkit": {
      "command": "npx",
      "args": ["-y", "openflowkit", "mcp"]
    }
  }
}
```

Quit Claude Desktop fully (closing the window is not enough), open it again, then ask it to draw. If it says `npx`
was not found, replace `npx` with the full path that `which npx` prints (`where npx` on Windows).

### Hosted connector: no install

Claude Desktop shares its connectors with claude.ai, so a connector you add there (next section) shows up here
too. It draws cards in the chat, not on your canvas.

## claude.ai and ChatGPT

:::note[Cards in the chat, not your canvas]
A chat app runs in the cloud and cannot reach the editor on your computer. It draws a diagram card in the chat
instead. Each card has **Open in OpenFlowKit**, which opens an editable copy in the app. To have an agent draw on
the canvas you have open, use one of the local clients on this page.
:::

The URL for both:

```text
https://mcp.openflowkit.com/mcp
```

### claude.ai

1. Open Settings → Connectors (Customize → Connectors on newer accounts) and choose **Add custom connector**.
2. Paste the whole URL, ending in `/mcp`.
3. When it asks how to sign in, choose **No sign-in**. OpenFlowKit has no account. This choice cannot be changed
   later: to fix it, remove the connector and add it again.
4. In a chat, press **+** → **Connectors** and turn OpenFlowKit on.
5. Ask for a diagram.

Who can add one:

- **Free:** one custom connector in total.
- **Pro and Max:** you add it yourself.
- **Team and Enterprise:** only an Owner adds custom connectors (Organization settings → Connectors). Members then
  turn it on in their chats.
- The mobile apps use connectors added on the web or desktop, but cannot add them.

### ChatGPT

ChatGPT takes the same URL where your plan allows custom connectors. They sit under developer mode in ChatGPT's
settings; its menus change often, so look for "connectors" there.

### What the card does

- Shows the diagram with zoom, Download and **Open in OpenFlowKit**.
- Where the host supports it, the card draws itself while the model is still writing, and sends Claude a small
  picture of the result so it can see what it drew.
- When a newer diagram card appears, older ones grey out with an **Earlier version** label. Hovering brings one
  back, and it still opens.
- The endpoint stores nothing. The diagram travels to the app inside the Open link itself.

### If the connector does not work

| What you see | Usual cause and fix |
| --- | --- |
| "Couldn't reach the MCP server" | Check the URL is exactly `https://mcp.openflowkit.com/mcp`. If it is, [open an issue](https://github.com/openflowkit/openflowkit/issues) with the full error text, including its `ofid_…` code |
| "Couldn't register with … sign-in service", or a sign-in prompt | **Sign in now** or **Sign in when needed** was chosen. Remove the connector and add it again with **No sign-in** |
| The connector is added but Claude never draws | Turn it on in that chat: **+** → **Connectors** → OpenFlowKit |
| No **Add custom connector** button | On Team or Enterprise, ask an Owner to add it. On Free, the one custom connector is already used |

## Cursor

[Add to Cursor](https://cursor.com/en/install-mcp?name=openflowkit&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm9wZW5mbG93a2l0IiwibWNwIl19),
then approve it in Cursor. Or put the same JSON as Claude Desktop's above in `~/.cursor/mcp.json`. Then open a new
Agent chat and ask it to draw.

## VS Code

This is for VS Code's own agent mode (Copilot). Using the Claude Code extension instead? Follow
[Claude Code](#claude-code).

[Install in VS Code](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522openflowkit%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522openflowkit%2522%252C%2522mcp%2522%255D%257D),
then in Copilot Chat switch to **Agent** mode and ask it to draw.

## Codex

Run it once:

```bash
codex mcp add openflowkit -- npx -y openflowkit mcp
```

Or add it to `~/.codex/config.toml` by hand:

```toml
[mcp_servers.openflowkit]
command = "npx"
args = ["-y", "openflowkit", "mcp"]
```

Start a new Codex session, then ask it to draw. The plugin adds the server and the diagram skill together:
`codex plugin marketplace add openflowkit/openflowkit`, then install **OpenFlowKit** from the Plugins Directory.

## Windsurf and other clients

Any MCP client takes the same command: `npx` with the arguments `-y openflowkit mcp`. Restart the client after
adding it.

## How drawing reaches your canvas

You never start the server yourself: your agent starts it when its session starts. The editor then pairs with it
over `127.0.0.1` on your computer.

1. **Open the editor.** Click **Connect agent** and **Connect**, or open
   [app.openflowkit.com/#/connect](https://app.openflowkit.com/#/connect): it lands on your last document (or a new
   one) with the panel open and Connect on. Copying a setup from the panel turns Connect on too. The link never
   carries a token or a port.
2. **Waiting.** The panel says "Waiting for your agent…" until the agent's server answers. That is normal, not an
   error. After 30 seconds it asks whether OpenFlowKit is added and whether you restarted the agent.
3. **Connected.** The panel says "Your agent is on the canvas." and shows **Live over MCP** with the address and
   the agents drawing. Ask your agent for a diagram.

If the agent tries to draw before any editor is paired, it is told to ask you to open the `#/connect` link, or to
work on a `.openflow.json` file and hand you a link to open it.

### One tab at a time

One tab in your browser talks to the agent. Any other tab shows "Connect is on in another tab." with a **Use this
tab** button that moves the connection there. The tab you open from the `#/connect` link takes it at once. When the
tab holding it closes, a waiting tab takes over by itself. A tab in a different browser can take it too: the old one
then says "Another OpenFlowKit tab has the agent connection." and waits for **Use this tab**.

### Several agents, one canvas

Two Claude Code windows, or Claude Code and Cursor, can draw on the same canvas. The first server to start holds
the connection and the others send their changes through it; the panel lists each agent under **Live over MCP**.
If the first one quits, the next takes over. Sessions share when both run a current OpenFlowKit and hold the same
token. With an older version or a different token, the later session says why and edits files only, until you
restart the older one.
`whoami` tells the agent which case it is in.

### The activity line

While a request runs, the panel says what the agent is doing: "Claude Code is drawing…" or "Claude Code is reading
the canvas…". Afterwards it says what the agent did, for example "Claude Code added Cache", with an **Undo**
button. The line stays only while that change is your latest undo step: undo it, or edit something yourself, and
it goes away, so Undo never acts on the wrong change. A client that sends no name shows as "Your agent".

### Undo

Every change an agent makes is one undo step, like an edit of your own: ⌘Z or Ctrl+Z, or **Undo** in the panel.
When two agents draw, each change is its own step. Threads are the exception: an agent's comment or a new thread is
not an undo step, and undoing a drawing change never removes a thread.

## Live comments

By default an agent sees your threads only when it asks: tell it "check the comments" and it calls `list_threads`
(`unanswered: true` returns only the threads whose last comment is yours; `threadId` returns one). Nothing is pushed,
so nothing costs tokens until you ask. It can add a comment to a thread (`reply_to_thread`), resolve it
(`resolve_thread`) or start one (`start_thread`). Its comments carry its name, such as "Claude Code". Threads are
not drawing, so they never become an undo step.

Live comments is opt-in. Turn it on in the editor (the **Live comments** toggle, available while an agent is
connected) and each comment you write, in a new thread or an existing one, is pushed into your running Claude Code session as it
arrives. Claude Code shows it as a channel message, and the agent answers with `reply_to_thread` in the same thread.
Start Claude Code with the channel flag:

```bash
claude --dangerously-load-development-channels plugin:openflowkit@openflowkit
```

This needs the plugin installed (see [Claude Code](#claude-code)), Claude Code 2.1.80 or newer, an interactive session
(not `-p`), and, on Team and Enterprise plans, an organization that allows channels. Channels are a research preview;
OpenFlowKit is not on the approved list yet, which is why the flag is needed.

Only the session that owns the connection to the editor receives live comments: when several agent sessions share one
canvas, that is the first one that started. A session started without the flag, or one that does not own the
connection, drops the comment silently and the editor shows no error. Nothing else changes: all the tools work as
before, and agent comments are never pushed back.

## Troubleshooting

| The panel or your agent says | What to do |
| --- | --- |
| "Waiting for your agent…" for a long time, then "Still waiting on 127.0.0.1:43119…" | The agent has not started the server. Check it is added (`claude mcp list` in Claude Code), then start a new session or restart the app. If the browser asks to let the page reach devices on your local network, allow it. Brave's shields and Safari may block a web page from reaching `127.0.0.1`; if so, try Chrome |
| "Something other than OpenFlowKit answers on 127.0.0.1:43119…" | Another program uses the port. Disconnect, open **Connection settings**, pick another port, copy the setup again (it carries the port) and restart your agent |
| "Another program already owns port 43119; this one can only edit files" (from the agent) | The same clash, seen from the agent's side. Fix it as above |
| "The agent server did not accept this token…" | The agent's server holds a different token from this browser, for example a setup copied in another browser. Copy the setup again from this panel and restart your agent. The setups on this page carry no token, and a server without one accepts any OpenFlowKit tab |
| "…refused this server's token" or "…cannot share its canvas with this one" (from the agent) | Two agent sessions disagree on token or version. Restart the older session, or give both the same setup |
| "Connect is on in another tab." or "Another OpenFlowKit tab has the agent connection." | Press **Use this tab**, or close the other tab |
| "No editor is paired. Ask the user to open https://app.openflowkit.com/#/connect and press Connect…" (from the agent) | Open that link. The agent can also work on a file and give you a link to it |
| "The editor tab was closed or reloaded. Reopen it and press Connect." (from the agent) | Reopen the editor, or the `#/connect` link |

The port is `43119` unless you change it. To change it, disconnect, set it under **Connection settings**, and copy
the setup again: the server reads it from `OPENFLOWKIT_BRIDGE_PORT`, and both sides must match.
