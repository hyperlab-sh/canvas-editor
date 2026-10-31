---
title: Exporting
description: PNG, SVG, PDF and JSON — scopes, themes, scale, transparency, and what each format is actually good for.
---

**Export** at the top right (or canvas menu → **Export…**) opens one panel: format, scope, and the options that belong to the
format. Right-clicking an element and choosing **Export…** opens the same panel already scoped
to that element. Everything is produced in the browser from the same exported SVG.

## Formats

| Format | What you get | Options |
| --- | --- | --- |
| **PNG** | A raster image of the selection, page or pages | 1× or 2× resolution; light/dark/print theme; **Canvas** or **Transparent** background; **Copy PNG** to the clipboard, at the chosen resolution |
| **SVG** | Vector markup that opens in Figma, Illustrator and browsers | Light/dark/print theme; **Canvas** or **Transparent** background |
| **PDF** | The browser's print dialog over the exported SVG — choose "Save as PDF" | Light/dark/print theme; the button reads **Print / PDF** |
| **JSON** | The whole document, every page, in the canonical format | — |

## Scope

- **Selection** — the selected elements and everything inside them: a group, frame or section
  takes its whole subtree, connectors between those children come along, and a lone connection
  exports on its own. One element names the file after itself (`my-doc-login-frame.svg`).
- **Page** — everything on the current page (the default).
- **All pages** — one file per page for PNG and SVG; PDF prints one sheet per page. JSON is
  always the whole document.

Exporting an empty page is refused with a message rather than producing an empty file.

## Themes and transparency

The export theme is independent of the app theme. **Light** and **Print** export on white
(`#ffffff`) and **Dark** on `#191b19`; the on-screen canvas tint is not exported. PNG and SVG can be
transparent; a transparent PNG has no background rectangle at all, which is what you want for
slides and dark READMEs.

## JSON is the round-trip format

**Export… → JSON** writes the document in the canonical format the app itself opens; **Open
file…** reads it back, including on a different browser. It is also what `openflow_save`
writes over [MCP](/mcp-server/). JSON export always covers every page and every asset
reference — the file is the document, not a rendering of it.

## What it cannot do

- **No direct PDF file.** PDF is the print dialog; the file is written by the browser and the
  page setup (margins, headers) belongs to the print dialog, not to OpenFlowKit.
- **No ZIP of all pages.** All-pages export downloads one file per page.
- **Mermaid only for flowchart and sequence.** **Copy as Mermaid** in the panel copies a
  flowchart or sequence diagram made from code as Mermaid text; other families have no Mermaid
  form. See [Mermaid import](/mermaid-import/).
- **No embeds.** A view-only, end-to-end encrypted [share link](/share-links/) is the only
  hosted form; everything else is a file.
- **No format options beyond those above** — no JPEG, no WebP, no size presets for PNG.

## Where to go next

- [Animated export](/animated-export/) — SVG animation, GIF, MP4 and WebM.
- [Theming](/theming/) — where the light/dark/print themes come from.
