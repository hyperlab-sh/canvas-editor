---
title: OpenFlow DSL
description: The editor-native text language — write a diagram, generate it as a frame, and keep the text and canvas from lying to each other.
---

OpenFlow DSL is the hub of OpenFlowKit: the code panel, AI generation, Mermaid import and the
MCP tools all produce it, and one compiler turns it into the canvas. The grammar is versioned
and written down in full in the [DSL reference](/openflow-dsl-reference/).

## The code panel

Press `⌥C` to open **Diagram as code**. It opens with the text selected, so typing or pasting
replaces it. Press `⌘↵` anywhere in the panel (or click **Generate diagram**). Diagnostics appear under the editor as you type; **the diagram is the compiled
result of the text you see**, not a parallel copy of the canvas.

- **Generate** compiles the draft into a frame. The frame is placed after the existing
  diagrams, or in place when the panel is editing one.
- **Edit as code** (right-click a generated frame) reopens its source in the panel; generate
  again to replace that same frame.
- A **canvas edited** warning appears when the frame on screen no longer matches the text that
  produced it. Generate overwrites those canvas edits — and one undo restores them.
- The **diagram palette** picker sets the default palette for the generated frame; an
  `appearance:` line in the source wins over it.

## This text

```openflow
flowchart
Client -> API : request
API -> Database : query
```

The first line names the family (`flowchart` here; every family is listed in the
[reference](/openflow-dsl-reference/)). Names are ids: `API` in two places is the same node.
Edges declare their endpoints, so you never have to pre-declare a node you are about to use.

## Round-trip, or why dragging does not rewrite your text

Two laws hold for the whole grammar, and the test suite checks them over a fixture corpus:

- formatting the text again changes nothing: `format(format(x)) == format(x)`;
- compiling and serialising preserves structure and attributes.

The canvas is a view of the text, not its owner. Drag a node and the text is untouched — the
canvas keeps the position in the document. **Generate** compiles the text again and re-lays
the frame out from it; manual moves are discarded (except for a node pinned with
`pin: x,y`), and one undo brings them back. The
exceptions are deliberate and small: chart data and the `animate` block are written back from
their panels, because there they *are* the data.

## Every family, one grammar

[Flowchart](/diagram-flowchart/), [architecture](/diagram-architecture/),
[sequence](/diagram-sequence/), [state](/diagram-state/), [ERD](/diagram-erd/),
[class](/diagram-class/), [mindmap](/diagram-mindmap/), [gitgraph](/diagram-gitgraph/),
[chart](/diagram-chart/) and [wireframe](/diagram-wireframe/) — plus the model layer for [C4 workspaces](/architecture-c4/).

Reserved family names (`bpmn`, `org`, `gantt`, `sankey`, `journey`, `timeline`)
parse as a flowchart with warning W105; they are not rendered as their own family yet.

## Foreign syntax

Paste Mermaid, D2 or Structurizr DSL and the panel offers to [convert it](/mermaid-import/).
Structurizr becomes an architecture workspace. Every converter reports what it could not
represent instead of dropping it silently.

## What it cannot do

- **One frame per generate.** Generating replaces the bound frame; to keep a variant, duplicate
  it as a new document or edit the copy by hand.
- **Few layout controls in the text.** ELK decides the layout. `pin: x,y` fixes a node at that
  position in the frame after layout, and survives Generate. `rank` is kept in the text but does
  not change the layout yet. Canvas drags are not written back, so they are lost on regenerate
  unless the node is pinned; a C4 workspace also keeps `views/*.snap` overrides (see
  [Architecture workspace](/architecture-workspace/)).
- **No silent fixes.** A line the parser cannot read is dropped with a warning naming its
  number; it is never guessed at.

## Where to go next

- [OpenFlow DSL reference](/openflow-dsl-reference/) — the whole grammar, generated from source.
- [Mermaid import](/mermaid-import/) — bring existing text across.
- [Architecture (C4)](/architecture-c4/) — the model layer inside the same language.
