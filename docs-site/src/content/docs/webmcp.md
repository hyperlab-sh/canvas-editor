---
title: WebMCP (experimental)
description: An agent that runs in your browser can read and edit the diagram you have open, with no install, port or token.
---

:::caution[Experimental]
[WebMCP](https://webmachinelearning.github.io/webmcp/) is a draft web standard. No browser turns it on by
default yet: Chrome has it behind a flag, and the agents that call it today are early (inspector and demo
extensions). Claude in Chrome does not use it. For an agent you use every day, run the [MCP server](/mcp-server/).
:::

WebMCP lets a web page give its tools to an agent that runs in the browser. When your browser supports it,
the OpenFlowKit editor registers its agent tools with the browser. An agent there can then read and edit the
diagram you have open, with no install, port or token. When the browser does not support it, the editor
does nothing and loads nothing extra.

## Three ways in

| Your agent runs… | How it connects | Where the tools act |
| --- | --- | --- |
| On your computer (Claude Code, Cursor, Claude Desktop…) | [MCP server](/mcp-server/), then **Connect agent** in the editor | The document open in the editor |
| On your computer, no editor open | [MCP server](/mcp-server/) in file mode | A `.openflow.json` file |
| In your browser (experimental) | WebMCP, nothing to set up | The document open in that tab |

All three run the same operations, so a change from any of them is one undo step, like an edit of your own.

## Is it on?

Open **Connect agent** on the workspace rail. When the browser supports WebMCP, the panel shows
*WebMCP (experimental): agents in this browser can use 18 tools.* When the line is missing, the browser
does not support WebMCP. The panel also shows the last change a browser agent made, with an Undo button.

## The tools

Every [MCP operation](/mcp-server/#the-operations) is a WebMCP tool with the same name, description and input
schema. Two more tools exist only in the browser, because only the open editor can answer them:

| Tool | What it does | Changes the document |
| --- | --- | --- |
| `create_diagram`, `update_diagram` | Draw or redraw a diagram from DSL, Mermaid, Structurizr or D2 | Yes |
| `move`, `style`, `delete`, `add_shape` | Edit what is already on the canvas | Yes |
| `get_document`, `get_diagram`, `list_diagrams`, `list_pages` | Read the page, a diagram's source and the page list | No |
| `get_syntax`, `search_icons`, `find_icons_for` | Look up the grammar and the icon library | No |
| `export`, `screenshot` | Return files and PNG images as data (base64 with a MIME type), not downloads. A file over 1 MB comes back as a note to use a lower scale or SVG; GIF, MP4 and WebM are refused (use `svg-animated`, or Export in the editor) | No |
| `fit_view` | Point the camera at a diagram or some shapes | No (view only) |
| `get_view` | What you are looking at: the page, Canvas or Map mode, your selection with labels, the camera and the shapes on screen | No |
| `select` | Select shapes and connectors and bring them on screen, so you can see what the agent means. Hidden ones are refused by name | No (view only) |

Tools that change nothing carry `readOnlyHint`. Tools that return your document's text (labels, names, DSL, a screenshot)
carry `untrustedContentHint`, which tells the agent to treat that text as data, not as instructions. Page tools
take an optional `pageId` (from `list_pages`) and otherwise act on the page you are looking at. A tool that fails
returns `{ "error": "…" }` with the reason.

## Read-only documents

On a document you cannot edit, such as a view-only [share link](/share-links/), the editor registers only the
tools that change nothing. A change addressed to a page that stays as it is, such as a repository's map page, is
refused with the same message the MCP server gets: *This document is read-only, so the editor did not apply the change.*

## Privacy

The editor sends nothing anywhere itself. What a tool returns (your diagram's text, a screenshot) goes to the agent
that called it, and from there to whichever model provider that agent uses.
