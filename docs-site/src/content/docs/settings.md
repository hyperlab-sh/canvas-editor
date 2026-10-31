---
title: Settings and preferences
description: Every preference OpenFlowKit keeps — appearance, grid, palette, icons from labels, usage stats, the agent bridge — and where each one lives.
---

Preferences are stored per browser in `localStorage` under one key and are validated
field by field on read; a corrupt entry falls back to the default. Nothing is synced: every
origin and browser has its own set.

## Settings popover

Open the canvas menu → **Settings**.

| Setting | Options | Effect |
| --- | --- | --- |
| Theme (under Appearance) | Light, Dark, System | The app's theme; System follows the OS |
| Interface density | Comfortable, Compact | Control sizes throughout the chrome |
| Dot grid | On, Off | The canvas grid |
| Snap to grid | On, Off | Whether drags snap to the grid (hold `⌘`/`Ctrl` to bypass) |
| Icons from labels | On (default), Off | Generated diagrams put a logo on nodes that name a technology; a diagram's `icons:` line wins — see [Architecture](/diagram-architecture/#icons-from-labels) |
| Share usage stats (under Privacy) | On (default), Off | Basic usage stats help us improve OpenFlowKit: which features are used, and how often. Your diagrams stay on your device. Off stops them |

## Elsewhere in the app

Some preferences live with the thing they affect:

| Preference | Where |
| --- | --- |
| Canvas background | Camera controls; reset to the theme default |
| Diagram palette (`pastel`, `paper`, `builder`, `mono`) | The code panel's palette picker; the default for generated frames, and synced from a frame you open with **Edit as code** |
| Agent bridge port, token, enable | The **Connect agent** panel — see [Connect your agent](/connect-your-agent/) |
| Tag perspectives | The [model panel](/architecture-c4/) — which tags stay bright |
| Recent emoji | The [emoji picker](/insert-media/), newest first |

## The diagram palette

The diagram palette is a browser preference (Pastel by default), not part of the document.
Every Generate uses it unless the source has its own `appearance:` line, which wins. The
compiled shapes keep the colours they were generated with. Paper and Mono exist for
print-friendly and greyscale output; see [Theming](/theming/).

## What it cannot do

- **No account or profile.** Preferences are per browser, not per person.
- **No preference import/export.** Copy them by hand if you move machines.
- **No per-document theme.** The theme is an app preference. The only per-document palette
  is an `appearance:` line in a diagram's source.

## Where to go next

- [Theming](/theming/) — palettes and the light/dark pair.
- [Canvas basics](/canvas-basics/) — how grid and snapping behave during a drag.
