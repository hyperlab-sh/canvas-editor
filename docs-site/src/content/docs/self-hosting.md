---
title: Self-hosting
description: Run your own copy of OpenFlowKit — Docker, any static host, the Content Security Policy, and the optional share-link Worker.
---

OpenFlowKit is a static web app: HTML, JavaScript and assets, with no app server of its own.
Documents live in each visitor's browser, so a self-hosted copy stores nothing on your server.
The server-side part is the optional Worker that holds encrypted [share links](/share-links/);
it also receives basic [usage stats](#usage-stats).

## Docker

```sh
docker build -t openflowkit .
docker run --rm -p 3045:3045 openflowkit      # http://localhost:3045/
```

The image builds the app with Node 22 and serves it with nginx on port 3045, using
`nginx/nginx.conf`: the same security headers as the hosted app, long-lived caching for
`/assets/`, and `index.html` never cached.

## Any static host

```sh
npm install
npm run build      # writes dist/
```

Serve `dist/` from anything that serves files. The app uses hash URLs (`/#/d/<id>`), so it needs
no rewrite rules. `public/_headers` carries the same headers for hosts that read that file;
`wrangler.toml` deploys `dist/` as Cloudflare static assets. Building needs Node 22.22 or newer.
For development, `npm run dev` serves the app at the URL Vite prints.

## The Content Security Policy decides what the browser may reach

| Directive | Allows | Why |
| --- | --- | --- |
| `connect-src` | `'self'`, any `https:`, and `http://localhost` / `http://127.0.0.1` on any port | Bring-your-own-key AI to any HTTPS provider; Ollama, LM Studio and the agent bridge on your machine; GitHub for repo maps |
| `script-src` / `frame-src` | `https://challenges.cloudflare.com` | Cloudflare Turnstile, only when someone makes a share link |
| `img-src` | `'self'`, `data:`, `blob:`, `https:` | Pasted image URLs |
| `frame-ancestors` | `'none'` | The app can't be framed |

A plain-`http` model gateway on another host (say `http://10.0.0.5:11434`) is blocked. Put it
behind HTTPS, use the [AI proxy](#ai-proxy-for-the-custom-provider), or edit `connect-src` in
`nginx/nginx.conf` and `public/_headers`.

## AI proxy for the Custom provider

The browser calls AI providers itself. That breaks for a model server only your server can see:
`127.0.0.1` in a visitor's browser is the visitor's machine, and a server without CORS headers
refuses the call. The Docker image can forward Custom provider calls through its own origin instead.
It is off unless you set one variable:

```sh
docker run --rm -p 3045:3045 \
  -e OPENFLOWKIT_AI_UPSTREAM=http://host.docker.internal:11434/v1 \
  openflowkit
```

The value is an OpenAI-compatible base URL: Ollama's `/v1`, LM Studio, vLLM, LiteLLM. On Linux,
add `--add-host=host.docker.internal:host-gateway` to reach a server on the host. Then in
**AI assistant → Custom**, set **Base URL** to `/ai-proxy`.

- **Two paths only.** `GET /ai-proxy/models` and `POST /ai-proxy/chat/completions` go to the
  upstream; every other `/ai-proxy/` path is a 404. The upstream is fixed by the server, never by the
  browser, so it is not an open proxy.
- **Streaming and Stop work.** Replies are not buffered, and a stopped reply closes the upstream call.
- **The key passes through your server.** It travels in the `Authorization` header as with any
  provider. nginx does not log headers or bodies, and the proxy paths have no access log. The dialog
  says so next to the Base URL.
- **The browser's `Origin`, `Referer` and cookies are not forwarded.**
- **A wrong value stops the container at start**, with the reason in its log: the URL must be
  `http://` or `https://`, and nginx must be able to resolve its host name.
- **Off, the paths answer 503** with how to turn the proxy on. Other providers, and a Custom
  endpoint with a full URL, work as before.

`npm run dev` and `npm run preview` honour the same variable, for trying it without Docker.

## The local service

The hosted app and the sections above keep documents in the browser. The local service is the other option, for
one machine: one long-running process that stores diagrams as `.openflow.json` files in folders you choose, serves the
app, and gives every diagram a link. Agent sessions ([MCP server](/mcp-server/)) draw on those diagrams; browsers on
the machine all show the same file. Browser storage and file mode are unchanged. The service listens on `127.0.0.1`
only.

```sh
npm run build                          # the app; the service serves dist/
npm --prefix mcp-server run build      # the service and CLI
node mcp-server/dist/cli.js serve      # http://127.0.0.1:43120/
```

```text
openflowkit serve [--port N] [--config path] [--app dir]
```

| Flag | Default |
| --- | --- |
| `--port` | the config file's `port` (43120) |
| `--config` | `OPENFLOWKIT_SERVICE_CONFIG`, else `~/.config/openflowkit/service.json` |
| `--app` | `OPENFLOWKIT_APP_DIR`, else the repository's `dist/` |

If nothing answers on the port, an agent's MCP server starts the service itself, detached, and waits until it is
healthy; a second MCP server finds the running one and never starts another. So you rarely run `serve` by hand, but `dist/` must exist. The
auto-started service takes its app folder from `OPENFLOWKIT_APP_DIR` in the MCP server's environment. If the port is
held by something that is not the service, `openflowkit serve` exits 1 naming the port; if it is another copy of the
service, it prints "already running" and exits 0. With the app folder missing, `/` answers 503 with the path it looked
for.

### Projects

A project is a name mapped to a folder. A diagram is one `.openflow.json` file in that folder (one level, no
subfolders). The config file lists them:

```json
{
  "port": 43120,
  "projects": [
    { "name": "scratch", "path": "/path/to/scratch" },
    { "name": "hyper", "path": "/path/to/app/diagrams" }
  ]
}
```

- **First run** writes this file with one project, `scratch`, in `~/.local/share/openflowkit/diagrams`. An existing
  file is never touched.
- **Names** are lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit, and unique. Paths are
  absolute, existing directories, one project each. A bad file stops the service with the reason.
- **Edit the file, then restart** the service to add a project. Files added or changed in a project folder by hand show
  up without a restart.
- The file format is the one the CLI and [file mode](/mcp-server/#two-modes) write, so a file saved by either is a
  diagram of the project.

`GET /health` answers JSON naming the service, its version, port, process id and projects.

### Pointing agents at it

The MCP server looks for the service at `http://127.0.0.1:43120`. If you changed the port, set
`OPENFLOWKIT_SERVICE_URL` (for example `http://127.0.0.1:43200`) in the MCP server's environment to match.
A diagram's link is `http://127.0.0.1:<port>/#/p/<project>/<diagram id>`; open it in any browser on the machine.
Edits in the app are written to the file. Home lists the service's diagrams by project.

The service is for one person on one machine: no accounts, no remote access, and when two tabs edit the same diagram
the later save wins.

## Share links (optional)

**Share** always offers an [editable copy](/share-links/#editable-copy) link: it needs no
server. The **view-only link** needs the share Worker and a Cloudflare Turnstile site key; without
them the option says "Not set up on this site". The Docker image passes no build variables, so a
plain Docker build has only editable links. To turn on view-only links:

1. Deploy the share Worker from `worker/` to your Cloudflare account, with an R2 bucket and a
   Turnstile secret. `worker/README.md` has the steps.
2. Build the app with `VITE_TURNSTILE_SITE_KEY=<site key>` and, for your own Worker,
   `VITE_SHARE_ORIGIN=https://share.example.com`. Without `VITE_SHARE_ORIGIN` the app uses
   `https://share.openflowkit.com`.
3. Add your app's origin to the Worker's `ALLOWED_ORIGINS` variable (comma-separated) so CORS
   lets it through.

The Worker only ever holds ciphertext: the app encrypts in the browser and the key stays in the
link's `#fragment`. Publish an abuse contact next to the feature, since you can only take a
link down by its id.

## Usage stats

The app sends basic usage stats (which features are used, and how often) to the share
Worker's origin: `https://share.openflowkit.com`, unless you build with `VITE_SHARE_ORIGIN`
pointing at your own Worker. People can turn them off in Settings.

## What it does not do

- **No accounts, sync or database.** There is nothing to back up on the server; each person's
  documents are in their own browser. Ask people to export JSON for backups.
- **No offline install.** The app registers no service worker; a browser needs your server to
  load it.
- **No server-side AI.** AI requests go from each visitor's browser to the provider they chose,
  with their own key. The opt-in [AI proxy](#ai-proxy-for-the-custom-provider) only forwards a
  Custom provider's calls to the upstream you configure.

## Where to go next

- [FAQ](/faq/): what leaves the browser, and when.
- [Share links](/share-links/): what the Worker stores and for how long.
- [MCP server](/mcp-server/): how agent sessions use the service.
- [The openflowkit CLI](/cli/): render and check diagrams without hosting anything.
