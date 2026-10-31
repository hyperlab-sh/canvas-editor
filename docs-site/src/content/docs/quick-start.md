---
title: Quick start
description: From an empty canvas to an exported diagram in five minutes — shapes, connectors, code, export.
---

Open [app.openflowkit.com](https://app.openflowkit.com). There is nothing to install and no
account. To run your own copy instead, see [Self-hosting](/self-hosting/).

## 1. Draw something

1. Press `R` and click the canvas. A rectangle appears, selected, with no label yet.
2. Type `Client`. Typing on a selected shape that has no label starts its label. Press `Enter`
   to finish.
3. Press `O` and click to the right of the rectangle. Once a shape has a label, letters are
   tool shortcuts again, so `O` picks the ellipse. Type `API`, then `Enter`.
4. Hover the rectangle and four side handles appear. Drag from the right one onto the ellipse
   to connect them.

To rename a shape that already has a label, select it and press `Enter` (or double-click it).
The canvas is infinite: `Space + drag` pans and `⌘`/`Ctrl + scroll` zooms at the pointer.

Every edit is autosaved in your browser. The cloud icon in the document bar shows the save
state. Press `?` at any time for the shortcut cheatsheet.

## 2. Or write it

Press `⌥C`. The code panel opens with its text already selected, so pasting replaces it. Paste
this, then press `⌘↵` (or click **Generate diagram**):

```openflow
flowchart
Start [ellipse]
Check [diamond]
Ship [rounded]

Start -> Check : submit
Check -> Ship : yes
Check -> Start : no
```

`⌘↵` works anywhere in the panel. The text compiles into one frame. Edit the text and
generate again: the frame is replaced in place, and one undo brings back what was there.
Right-click a generated frame and choose **Edit as code** to get its source back.

## 3. Export

Click **Export** at the top right. Pick a format (PNG, SVG, PDF or JSON) and a scope
(selection, page or all pages). PNG has a 1× or 2× resolution. Images and PDF take a theme
(light, dark or print), and PNG and SVG can drop the background with **Transparent**.

## 4. Put an agent on it

- **MCP**: click **Connect agent** in the right-hand rail, pick your client under **Your agent**,
  copy its setup, and restart the agent. The panel connects by itself, and every tool then acts on
  the document you see. See [Connect your agent](/connect-your-agent/).
- **Bring your own key**: press `⌘J`, add a provider key in the assistant panel and describe
  the diagram you want. You review the proposal before it lands, and it applies as one undo
  step. See [AI generation](/ai-generation/).

## Where to go next

- [Home and templates](/templates/): twelve starter diagrams, and every way to begin.
- [OpenFlow DSL](/openflow-dsl/): the language behind **Generate**.
- [Keyboard shortcuts](/keyboard-shortcuts/): the full map.
- [Exporting](/exporting/): every format and option.
