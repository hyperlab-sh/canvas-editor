---
title: Map mode and repo maps
description: Browse an architecture model, or a GitHub repository, as boxes that open in place — every arrow backed by the file and line it came from.
---

Map is a second way to look at a document. Canvas is the drawing you edit; Map draws the
document's architecture model as nested boxes you open and close in place. Nothing you do while
browsing a map changes the document or adds an undo step.

## Canvas | Map

The **Canvas | Map** switch sits in the document bar, right after the title. Press `M` to flip
between them. On a model page a reload keeps your last choice, and leaving Map lands back on
Canvas with the page, the camera and the selection you had. A repo map always opens in Map; its
Canvas is the map's drawing ([below](#a-maps-drawing)).

Map is built from an architecture model. On a document without one, Map shows a start screen:
**Start an architecture model**, **Connect agent**, or map a GitHub repo (below). Your drawing is
not touched.

## Reading a map

| Do | What happens |
| --- | --- |
| Click a box | Opens it in place (or shuts it); the box and the boxes it talks to stay bright, the rest dims |
| Click an arrow | Focuses the arrow and its two ends, and lists what is behind it |
| Arrow keys | Walk between boxes; `↓` enters an open box, `↑` goes back out |
| `Enter` | Opens the selected box |
| `Esc` | Closes the box around the selection and selects it; with nothing left to close, clears the selection |
| `⌘F` | Find in map: opens the boxes around a match and selects it; `Esc` puts things back |
| Double-click a box | Opens its card in the model panel with the name ready to type |

The depth control in the Map toolbar sets how far the boxes open: **Top level** (only the
top-level boxes, shut), **One level in** (the top-level boxes open) or **All levels** (as deep as
the screen allows). A click on a single box still opens or shuts just that one.

On a C4 model, an arrow lists the model relations it stands for. On a repo map, an arrow is
evidence: it lists each import or call behind it as `file:line`, each a link to that line on
GitHub. **Connections** in the toolbar switches each kind of arrow (imports, calls, uses, builds)
on and off.

## Editing from a map

Map does not move boxes. On a model map, edits go to the model: double-click a box, use its
right-click menu, or remove it with `⌘⇧⌫`. A repo map is read from the code, so it has no model
to edit (its boxes offer no **Edit in model**). Typing, a drag or Delete on a box explains this
once per visit instead of doing something you did not mean; on a repo map the note offers
**Open Canvas**.

### A map's drawing

**Edit as drawing** (`⇧M`) copies the map as drawn now to a new page, as one undo step. A map
named *Shop* gives *Shop (drawing)*, then *Shop (drawing 2)*, and so on. The drawing keeps the map's coordinates, so
nothing jumps, and you can rearrange it and draw on it. The model is not changed.

A drawing remembers the map it came from. Its switch reads **Canvas | Map**: **Map** (or `M`)
goes back to that map with the camera where it was. Undoing a drawing you just made also lands
back on its map.

On a repo map, **Canvas** (or `M`) is the way to edit. The first time, it makes a drawing of the
map as you see it, in the same place; after that it opens that drawing again (the one you were
last on, else the newest). While the repo is still being read there is nothing to copy yet: a
note says when the map is drawn, with **Open Canvas**. **Edit as drawing** always makes another,
fresh copy.

A drawing follows the map until you edit it. Open or close boxes on the map, then **Canvas**: a
drawing nobody has changed is redrawn to match, as one undo step ("Drawing updated from the map").
Once you or an agent edit it, it is yours and stays as it is. If the map then shows boxes it has
not got, a note says how many, with **New copy** to make a fresh drawing from the map. After a
reload the app cannot tell an untouched drawing from an edited one, so it offers **New copy** then too.

## Repo maps

Paste a GitHub address into **Map a GitHub repo** (Map's start screen, or the empty canvas), or
open `#/map/github/<owner>/<repo>` (add `/tree/<branch>` for a branch). These all work:

- `owner/repo`
- `github.com/owner/repo`, with or without `https://` and `www.`
- `https://github.com/owner/repo/tree/<branch>` or a `/blob/<branch>/<file>` link (the whole repo
  is read at that branch)
- `…/repo.git` and `git@github.com:owner/repo.git`

The browser reads the repository itself — the file list from `api.github.com`, the files from
`raw.githubusercontent.com` (or, for a [private repo](#private-repos), from `api.github.com`) —
and draws it. Nothing goes through an OpenFlowKit server. The map's
parts come from what discovery finds deployable: Dockerfiles, compose files, Kubernetes and
Terraform files, package manifests and Wrangler (Cloudflare Workers) configs, with the imports
between source files as arrows. A repo built from those maps best.

Big repos are sampled to stay quick: no file over 256 KB, at most 8 MB in all. The chip on the
map says how much was read ("Read N of M files"). The map itself is read from the code and does
not change; switch to **Canvas** to edit [its drawing](#a-maps-drawing). Opening the same address
again reopens the same document, on the map.

### Rate limits and tokens

Without a token GitHub allows 60 API reads an hour per network. When that runs out the page asks
for an optional GitHub token (5,000 reads an hour). The token is kept in this tab's
sessionStorage and sent to `api.github.com` only, never to the raw file downloads.

### Private repos

A private repo can be mapped three ways:

- **In the browser, with a token.** A private repo first shows *This repo was not found, or it is
  private.* Choose **Private repo? Use a GitHub token** and paste a
  [fine-grained token](https://github.com/settings/personal-access-tokens/new) that can read it:
  pick the repos under *Repository access* and give it **Contents: read-only**. Files that
  `raw.githubusercontent.com` cannot serve are then read through `api.github.com`, one API read
  each, so a big private repo uses more of the 5,000-an-hour limit. The token stays in this tab
  and goes only to `api.github.com`. If the token can list the repo but not read its files, the
  page asks for one with Contents access.
- **From a checkout, with the CLI:** `npx openflowkit map .` ([below](#from-a-checkout-the-cli)).
  No token and no rate limit.
- **Through your agent.** With the local [MCP server](/mcp-server/), `discover_architecture`
  reads a checkout on your machine and proposes its architecture model; your agent can draw it on
  the canvas you have open (**Connect agent**), and Map browses it.

### From a checkout: the CLI

For no rate limit, or a private repo without a token, map a local checkout with the CLI in the
MCP server package:

```text
npx openflowkit map . [--depth overview|detailed|everything] [--html map.html]
```

It prints the parts, files, lines and imports; `--html` also writes the interactive map as one
offline page. In a git checkout only tracked files are mapped.

## Repo → architecture diagram

`#/from/github/<owner>/<repo>` (add `/tree/<branch>` for a branch) opens the repository as a C4
architecture model in the editor instead of a map, built by the same discovery. Its evidence
links are pinned to the commit that was read, so they keep pointing at the right lines after the
repo moves on. A [private repo](#private-repos) opens the same way, with a token. The CLI equivalent
is `openflowkit discover .`.

## What it cannot do

- **No layout of your own in Map.** Boxes are laid out for you; switch to **Canvas** (on a repo
  map) or use **Edit as drawing** to arrange them by hand.
- **GitHub only** in the browser. GitLab is not read; use the CLI on a checkout.
- **A slashed branch in a pasted URL** reads as its first segment (`release/2.0` → `release`);
  write it `release%2F2.0`.
- **Static reading.** Arrows come from imports and config files, not from running code.

## Where to go next

- [Architecture (C4)](/architecture-c4/) — the model Map draws.
- [Architecture workspace](/architecture-workspace/) — discovery and drift against a repo.
- [The openflowkit CLI](/cli/) — `map`, `discover` and `drift` on a checkout.
