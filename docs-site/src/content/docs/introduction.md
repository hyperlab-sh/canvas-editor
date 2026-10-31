---
title: Introduction
description: OpenFlowKit is a free, local-first canvas for architecture diagrams you draw, write as code, or hand to your agent.
---

OpenFlowKit is an infinite canvas for technical diagrams that treats text as the source of
truth. A small line-oriented language — OpenFlow DSL — compiles to shapes, connectors and
layout; the canvas edits the same document; and an agent can drive either through MCP.

<figure class="ofk-screen">
  <img class="ofk-screen-light" src="/screens/editor-light.webp" width="2560" height="1600" loading="lazy" alt="The OpenFlowKit editor: an architecture diagram on the canvas, generated from the OpenFlow DSL in the code panel beside it" />
  <img class="ofk-screen-dark" src="/screens/editor-dark.webp" width="2560" height="1600" loading="lazy" alt="The OpenFlowKit editor in dark mode: an architecture diagram generated from the OpenFlow DSL in the code panel" />
</figure>

## Three ways in

- **Draw it.** Shapes, connectors, ink, images and charts, with the [canvas](/canvas-basics/)
  shortcuts a drawing tool should have.
- **Write it.** [OpenFlow DSL](/openflow-dsl/) in the code panel: ten diagram families
  (flowchart, architecture, sequence, state, ERD, class, gitgraph, mindmap, chart and
  wireframe), one forgiving grammar, per-line diagnostics.
- **Delegate it.** Connect an [MCP client](/mcp-server/) or bring your own key to
  [generate from a prompt](/ai-generation/); both paths produce the same DSL through the same
  compiler.

All three land in the same document. Code generates a frame; dragging on the canvas never
rewrites the text; **Generate** makes the text authoritative again as one undo step.

## Smallest example

```openflow
flowchart
Client -> API : request
API -> Database : query
```

## What local-first means here

Your diagrams stay in your browser. Something leaves it only when you choose: AI with your own
key goes to that provider, a share link uploads an encrypted copy, a repo map reads from GitHub.
There is no account, exports are files you download, and basic usage stats can be turned off in Settings. See
[Local-first diagramming](/local-first-diagramming/) for crash recovery and what "opening a
file" does, and the [FAQ](/faq/) for every network request the app makes.

## Where to go next

- [Quick start](/quick-start/) — five minutes from empty canvas to exported diagram.
- [Home and templates](/templates/) — start from one of twelve real diagrams.
- [OpenFlow DSL](/openflow-dsl/) — the text language and its workflow.
- [Connect your agent](/connect-your-agent/) — put an agent on the canvas.
- [MCP Server](/mcp-server/) — every tool it gets.
- [Keyboard shortcuts](/keyboard-shortcuts/) — every key, generated from the app's map.
