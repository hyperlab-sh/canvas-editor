---
title: Connect your agent
description: Add Canvas to Claude Code, Claude Desktop, Cursor, VS Code, Codex, claude.ai or ChatGPT, then pair it with the canvas you have open.
---

There are two ways in. Pick by where your agent runs.

| | Local MCP server | Hosted connector |
| --- | --- | --- |
| **For** | Claude Code, Claude Desktop, Cursor, VS Code, Codex, Windsurf | claude.ai, Claude Desktop, ChatGPT |
| **Install** | One command or one click. Your agent runs `npx -y @hyperlab.sh/canvas mcp` on your computer (Node 20.11 or newer) | Paste `https://mcp.canvas.hyperlab.sh/mcp`. Nothing to install |
| **Draws** | On the canvas you have open, one undo step per change. With no editor open, in `.openflow.json` files in your repo | A diagram card in the chat, with **Open in Canvas**. Not on your open canvas |
| **Tools** | All of them: see [MCP server](/mcp-server/) | Drawing and the grammar only. No files, no live canvas, no repo tools |

The app has the same steps. Open **Connect agent** in the editor and pick your client under **Your agent**. Step 1
has two ways: **Prompt**, a message you paste into the agent so it adds Canvas itself, or the command, config or
one-click link to do it by hand (**Terminal**, **Config file**, **One click**). Whichever you copy carries this
browser's pairing token. The prompt reaches your agent's model with the token in it; the token only pairs a server
on your own machine with this browser.
[canvas.hyperlab.sh/#/connect](https://canvas.hyperlab.sh/#/connect) opens the editor with that panel open and
Connect on.

## Claude Code

The terminal and the Claude Code extension for VS Code share this setup. Run it once:

```bash
claude mcp add -s user canvas -- npx -y @hyperlab.sh/canvas mcp
```

`-s user` adds it for every project, not only the folder you are in. Start a new Claude Code session (or run `/mcp`
to reconnect), then ask it to draw. `claude mcp list` shows `canvas` once it is added.

Or install the plugin, which adds the server and the diagram skill together:

```bash
claude plugin marketplace add hyperlab-sh/canvas-editor
claude plugin install canvas@canvas
```

## Claude Desktop

### Local server: draws on your canvas

Open Settings → Developer → Edit Config. That opens `claude_desktop_config.json`:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add Canvas to it:

```json
{
  "mcpServers": {
    "canvas": {
      "command": "npx",
      "args": ["-y", "@hyperlab.sh/canvas", "mcp"]
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
instead. Each card has **Open in Canvas**, which opens an editable copy in the app. To have an agent draw on
the canvas you have open, use one of the local clients on this page.
:::

The URL for both:

```text
https://mcp.canvas.hyperlab.sh/mcp
```

### claude.ai

1. Open Settings → Connectors (Customize → Connectors on newer accounts) and choose **Add custom connector**.
2. Paste the whole URL, ending in `/mcp`.
3. When it asks how to sign in, choose **No sign-in**. Canvas has no account. This choice cannot be changed
   later: to fix it, remove the connector and add it again.
4. In a chat, press **+** → **Connectors** and turn Canvas on.
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

- Shows the diagram with zoom, Download and **Open in Canvas**.
- Where the host supports it, the card draws itself while the model is still writing, and sends Claude a small
  picture of the result so it can see what it drew.
- When a newer diagram card appears, older ones grey out with an **Earlier version** label. Hovering brings one
  back, and it still opens.
- The endpoint stores nothing. The diagram travels to the app inside the Open link itself.

### If the connector does not work

| What you see | Usual cause and fix |
| --- | --- |
| "Couldn't reach the MCP server" | Check the URL is exactly `https://mcp.canvas.hyperlab.sh/mcp`. If it is, [open an issue](https://github.com/hyperlab-sh/canvas-editor/issues) with the full error text, including its `ofid_…` code |
| "Couldn't register with … sign-in service", or a sign-in prompt | **Sign in now** or **Sign in when needed** was chosen. Remove the connector and add it again with **No sign-in** |
| The connector is added but Claude never draws | Turn it on in that chat: **+** → **Connectors** → Canvas |
| No **Add custom connector** button | On Team or Enterprise, ask an Owner to add it. On Free, the one custom connector is already used |

## Cursor

[Add to Cursor](https://cursor.com/en/install-mcp?name=canvas&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm9wZW5mbG93a2l0IiwibWNwIl19),
then approve it in Cursor. Or put the same JSON as Claude Desktop's above in `~/.cursor/mcp.json`. Then open a new
Agent chat and ask it to draw.

## VS Code

This is for VS Code's own agent mode (Copilot). Using the Claude Code extension instead? Follow
[Claude Code](#claude-code).

[Install in VS Code](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522canvas%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522canvas%2522%252C%2522mcp%2522%255D%257D),
then in Copilot Chat switch to **Agent** mode and ask it to draw.

## Codex

Run it once:

```bash
codex mcp add canvas -- npx -y @hyperlab.sh/canvas mcp
```

Or add it to `~/.codex/config.toml` by hand:

```toml
[mcp_servers.canvas]
command = "npx"
args = ["-y", "@hyperlab.sh/canvas", "mcp"]
```

Start a new Codex session, then ask it to draw. The plugin adds the server and the diagram skill together:
`codex plugin marketplace add hyperlab-sh/canvas-editor`, then install **Canvas** from the Plugins Directory.

## Windsurf and other clients

Any MCP client takes the same command: `npx` with the arguments `-y canvas mcp`. Restart the client after
adding it.

## How drawing reaches your canvas

You never start the server yourself: your agent starts it when its session starts. The editor then pairs with it
over `127.0.0.1` on your computer.

1. **Open the editor.** Click **Connect agent** and **Connect**, or open
   [canvas.hyperlab.sh/#/connect](https://canvas.hyperlab.sh/#/connect): it lands on your last document (or a new
   one) with the panel open and Connect on. Copying a setup from the panel turns Connect on too. The link never
   carries a token or a port.
2. **Waiting.** The panel says "Waiting for your agent…" until the agent's server answers. That is normal, not an
   error. After 30 seconds it asks whether Canvas is added and whether you restarted the agent.
3. **Connected.** The panel says "Your agent is on the canvas." and shows **Live over MCP** with the address and
   the agents drawing. Ask your agent for a diagram.

If the agent tries to draw before any editor is paired, it is told to ask you to open the `#/connect` link, or to
work on a `.openflow.json` file and hand you a link to open it.

### One tab at a time

One tab in your browser talks to the agent. Any other tab shows "Connect is on in another tab." with a **Use this
tab** button that moves the connection there. The tab you open from the `#/connect` link takes it at once. When the
tab holding it closes, a waiting tab takes over by itself. A tab in a different browser can take it too: the old one
then says "Another Canvas tab has the agent connection." and waits for **Use this tab**.

### Several agents, one canvas

Two Claude Code windows, or Claude Code and Cursor, can draw on the same canvas. The first server to start holds
the connection and the others send their changes through it; the panel lists each agent under **Live over MCP**.
If the first one quits, the next takes over. Sessions share when both run a current Canvas and hold the same
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

## The Threads panel

A thread is a conversation pinned to the canvas; a comment is one message in it. Every thread gets a number, `#1`,
`#2`, and so on, unique in the diagram and kept when a thread is resolved or another is deleted. The agent sees the
number as `number` in `list_threads` and as `thread_number` on a live-comment channel event.

Press **C**, or choose **Threads** in the workspace rail, second after the AI assistant (it shows how many threads are open), to open the panel. It
shares its place with the AI assistant: one is open at a time. It lists the threads of every page, the one with the
latest comment first.

- **Search** reads every comment of every thread, on every page, ignoring case. Empty search shows all.
- **Filter** has two switches. **Show resolved** (off by default) adds resolved threads, dimmed. **Unanswered only**
  keeps threads whose last comment was written by a person, not by the agent. The panel remembers both.
- **Live comments** has its switch in the panel header, with a **?** beside it ("Automatically send new comments to
  your agent"). It is one setting for the whole editor, not per thread.
- A card shows the first comment's author, `#3 · Page 1`, the first lines, and how many replies follow. A dot means
  there is something you have not read. Hover it (or tab to it) for **Resolve**, and **⋯** for **Mark as read** or
  **Mark as unread**, **Copy link** and **Delete thread…** (it asks first).
- **Click a card** to go to its page, bring the pin into view (the zoom stays unless the pin would be off screen) and
  open the thread. Clicking a pin on the canvas highlights its card.

Drag a pin to move its thread, with the comment tool or the select tool. Dropped on a shape, the thread follows that
shape; dropped on empty canvas, it stays where it is on the page. A move under a few pixels is a click and opens the
thread. Moving a thread is not an undo step, and a read-only view cannot move pins.

Text you have typed in a new comment or a reply is not lost to a stray click: the first click outside the box only
shakes it (with reduced motion, flashes its outline), and a second one closes it and discards the text. Typing starts
the count over; an empty box closes at once; **Esc** closes as before.

Unread is kept in this browser only, not in the diagram and not shared: a thread is unread when it has a comment newer
than the last time you opened it that you did not write. A thread you never opened counts the comments of others.
Opening a thread marks it read, and **Mark as unread** keeps it unread until you open it again.

**Copy link** puts a line like `#3 · Page 1 · on "Session updateComments" — https://…/#/d/<id>?thread=<id>` on the
clipboard. Opening the link loads the diagram, opens the panel and the thread, then removes `?thread=` from the
address. If the thread is gone, you get a short message and nothing else changes. Links open the diagram in the
browser that holds it, so they are for you and your own devices, not a share link.

In a read-only view (a shared link) the panel lists, searches, opens and copies links; resolving and deleting are
hidden. Pins are not drawn in Map mode: a card for a thread on a page leaves Map to the canvas, then opens the thread.

## Live comments

By default an agent sees your threads only when it asks: tell it "check the comments" and it calls `list_threads`
(`unanswered: true` returns only the threads whose last comment is yours; `threadId` returns one). Nothing is pushed,
so nothing costs tokens until you ask. It can add a comment to a thread (`reply_to_thread`), resolve it
(`resolve_thread`) or start one (`start_thread`). Its comments carry its name, such as "Claude Code". Threads are
not drawing, so they never become an undo step.

**Live comments work with Claude Code only.** Pushing a comment into a running session uses Claude Code's
[channels](https://code.claude.com/docs/en/channels-reference), a Claude Code feature with no counterpart in
other agents yet: Codex, OpenCode, Pi, Gemini CLI and the rest have no way for an MCP server to put a message in
front of the model between turns. With those agents everything above still works: the agent reads your threads
with `list_threads` when you ask, and answers with `reply_to_thread`. Support for other agents is tracked upstream;
see [other agents](#other-agents) below.

Live comments is opt-in. Turn it on in the editor (the **Live comments** toggle in the Threads panel) and each comment
you write, in a new thread or an existing one, is pushed into your running Claude Code session as it arrives. Claude
Code shows it as a channel message, and the agent answers with `reply_to_thread` in the same thread. Start Claude Code
with the channel flag, and tell Canvas so with `CANVAS_CHANNEL=1` in the environment the MCP server
starts in (Claude Code does not announce its channels to the server):

```bash
CANVAS_CHANNEL=1 claude --dangerously-load-development-channels plugin:canvas@canvas
```

This needs the plugin installed (see [Claude Code](#claude-code)), Claude Code 2.1.80 or newer, an interactive session
(not `-p`), and, on Team and Enterprise plans, an organization that allows channels. Channels are a research preview;
Canvas is not on the approved list yet, which is why the flag is needed.

The editor knows whether the connected session can hear comments. The switch and the **Send … to agent** button are
enabled only while an agent is connected whose session has a channel; otherwise both are off, and their tooltip says
whether to connect an agent or to restart Claude Code with the flag. The MCP server tells the editor when it pairs
(`channel` in the bridge's hello and health, and in the service's holder events); `server_info` and `whoami` show the
agent the same flag.

Only the session that owns the connection to the editor receives live comments: when several agent sessions share one
canvas, that is the first one that started. A session that owns the connection but was started without the flag shows
in the editor as unable to receive comments. Nothing else changes: all the tools work as before, and agent comments
are never pushed back.

### Other agents

Pi and OpenCode could get live comments through a plugin of their own, since both can inject a message into a running
session from an extension (Pi's `sendUserMessage`, OpenCode's `session.prompt`); Codex and Gemini CLI cannot today.
Until such plugins exist, use **Send … to agent**'s pull side instead: ask the agent to check the comments, and it
calls `list_threads` with `unanswered: true`.

## Troubleshooting

| The panel or your agent says | What to do |
| --- | --- |
| "Waiting for your agent…" for a long time, then "Still waiting on 127.0.0.1:43119…" | The agent has not started the server. Check it is added (`claude mcp list` in Claude Code), then start a new session or restart the app. If the browser asks to let the page reach devices on your local network, allow it. Brave's shields and Safari may block a web page from reaching `127.0.0.1`; if so, try Chrome |
| "Something other than Canvas answers on 127.0.0.1:43119…" | Another program uses the port. Disconnect, open **Connection settings**, pick another port, copy the setup again (it carries the port) and restart your agent |
| "Another program already owns port 43119; this one can only edit files" (from the agent) | The same clash, seen from the agent's side. Fix it as above |
| "The agent server did not accept this token…" | The agent's server holds a different token from this browser, for example a setup copied in another browser. Copy the setup again from this panel and restart your agent. The setups on this page carry no token, and a server without one accepts any Canvas tab |
| "…refused this server's token" or "…cannot share its canvas with this one" (from the agent) | Two agent sessions disagree on token or version. Restart the older session, or give both the same setup |
| "Connect is on in another tab." or "Another Canvas tab has the agent connection." | Press **Use this tab**, or close the other tab |
| "No editor is paired. Ask the user to open https://canvas.hyperlab.sh/#/connect and press Connect…" (from the agent) | Open that link. The agent can also work on a file and give you a link to it |
| "The editor tab was closed or reloaded. Reopen it and press Connect." (from the agent) | Reopen the editor, or the `#/connect` link |

The port is `43119` unless you change it. To change it, disconnect, set it under **Connection settings**, and copy
the setup again: the server reads it from `CANVAS_BRIDGE_PORT`, and both sides must match.
