---
title: Sharing
description: The two kinds of link — a view-only link to the whole document, encrypted in your browser, and an editable copy that carries a diagram's code in the link — how each works, what each sends, and the rules.
---

**Share** (top right, or **Share…** in the canvas menu) makes one of two links. Pick one and
click **Copy link**.

| | View-only link | Editable copy |
| --- | --- | --- |
| What it carries | The whole document, every page | One diagram's code |
| Who can change it | Nobody; viewers look, pan and zoom | Whoever opens it, in their own new copy |
| What is uploaded | The document, encrypted in your browser first | Nothing |
| Where it lives | On the share server until you delete it | Only in the link itself |
| Size limit | 1 MB | About 32 KB of compressed code |
| Needs | The share server (on for app.openflowkit.com) | Nothing; works on any copy of OpenFlowKit |

Use a **view-only link** to show someone the finished document. Use an **editable copy** to
hand someone a diagram they will change: a teammate, an issue, a pull request.

## View-only link

1. Your browser encrypts the document (AES-GCM, a fresh 256-bit key each time).
2. It uploads only the ciphertext. The server returns a random id and a delete token.
3. The link is `<app>/#/s/<id>/<key>`. The key sits in the part after `#`. Browsers never send
   that part to a server.
4. Whoever opens the link downloads the ciphertext and decrypts it in their browser.

What follows from that:

- **The server cannot read your diagram.** It stores ciphertext and has no key. It also
  stores a hash of the delete token, not the token.
- **Anyone with the whole link can read the diagram.** The key is part of it. Share it like a
  password. If the key is cut off, the link does not open.
- **1 MB cap.** The editor refuses a larger document before it uploads, and offers the file
  instead. The server rejects it too.
- **You can delete it.** Once you have shared a link, **Delete link** appears under **Copy
  link**. It removes the newest link made in this browser, using the delete token that browser
  kept. A deleted link stops opening. Clearing your browser data loses the token, so keep it in
  mind before you do.
- **No expiry today.** A link stays until it is deleted.
- **Edit in OpenFlowKit** in a shared view copies the document into the viewer's own browser.
  Their changes never reach yours.
- Only our own encrypted format is stored. It is not general file hosting.
- Uploads need a human check and are rate limited per network.

## Editable copy

The link holds the diagram's [OpenFlow DSL](/openflow-dsl-reference/), compressed:
`<app>/#/from/dsl?d=<code>`. Opening it starts a new document in the opener's browser with that
code in **Diagram as code**, drawn and ready to change.

- **Nothing is uploaded, not even to us.** The code sits after `#`, which browsers never send to
  a server. Anyone with the link can read the code, so share it like you would the code itself.
- **One diagram.** It carries the code diagram that holds your selection, or the first one on the
  page. Other pages, and shapes you drew by hand outside a code diagram, stay behind. For the
  whole document, use a view-only link or send the file.
- **Your canvas edits come along.** If you moved or renamed things on the canvas after
  generating, the link carries the canvas written back as code.
- **Code diagrams only.** On a page with no diagram made from code, the option says so. Draw one
  with **Diagram as code**, or [import Mermaid, Structurizr or D2](/mermaid-import/).
- **Long diagrams don't fit.** Chat apps and browsers cut very long links, so a diagram whose
  compressed code is over about 32 KB gets a message instead. Use a view-only link or send the
  file.
- **The link never changes.** It is the code at the moment you copied it. Copy again after you
  edit.

Your agent's MCP viewer uses the same link for **Open in OpenFlowKit**.

## What is not allowed

Do not share links to:

- illegal content;
- malware or anything built to harm a device;
- harassment, threats or content that targets a person.

## Report a link

Send the full link, or just its id (the 32 characters after `#/s/`), to
hello@openflowkit.com with "Report a link" in the subject.

We cannot read the diagram, so we act on the link you send. We remove the link by its id. After
that it no longer opens for anyone.

## Where to go next

- [Exporting](/exporting/) — files instead of links.
- [Self-hosting](/self-hosting/) — turn on view-only links on your own copy.
- [Local-first diagramming](/local-first-diagramming/) — what stays on your machine.
