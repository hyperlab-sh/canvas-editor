import type { BundleWorkspace } from './lib/agent.js';
import {
  modelFromNode,
  type ArchFlowData,
  type ArchFlowStepData,
  type ArchModelData,
} from './lib/architectureDiscovery.js';

/* ----------------------------------------------------------------- build */

interface SiteConnector {
  id: string;
  from: string;
  to: string;
}

export interface SiteView {
  slug: string;
  viewId: string;
  name: string;
  svgLight: string;
  svgDark: string;
  nodes: string[];
  connectors: SiteConnector[];
}

interface SiteFlowStep {
  kind: string;
  from?: string;
  to?: string;
  label?: string;
  depth: number;
  branch?: string;
}

export interface SiteFlow {
  name: string;
  steps: SiteFlowStep[];
}

export function slugifyViewId(viewId: string, used: Set<string>): string {
  const base = viewId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'view';
  let slug = base;
  let suffix = 2;
  while (used.has(slug)) slug = `${base}-${suffix++}`;
  used.add(slug);
  return slug;
}

export function flattenFlowSteps(flow: ArchFlowData): SiteFlowStep[] {
  const out: SiteFlowStep[] = [];
  const walk = (steps: readonly ArchFlowStepData[], depth: number, branch?: string): void => {
    for (const step of steps) {
      out.push({
        kind: step.kind,
        ...(step.from ? { from: step.from } : {}),
        ...(step.to ? { to: step.to } : {}),
        ...(step.label ? { label: step.label } : {}),
        ...(branch ? { branch } : {}),
        depth,
      });
      for (const lane of step.branches ?? []) walk(lane.steps, depth + 1, lane.label);
    }
  };
  walk(flow.steps, 0);
  return out;
}

export const EMPTY_SVG = (label: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120" width="320" height="120" data-theme="light"><rect width="320" height="120" fill="#ffffff"/><text x="160" y="64" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" fill="#64748b">${label}</text></svg>`;

export function renderIndexHtml(name: string, model: ArchModelData, views: readonly SiteView[], flows: readonly SiteFlow[]): string {
  const viewOf: Record<string, string> = {};
  for (const view of model.views) {
    if (!view.of) continue;
    const slug = views.find((candidate) => candidate.viewId === view.id)?.slug;
    if (slug) viewOf[view.of] = slug;
  }
  const ofByView = new Map(model.views.map((view) => [view.id, view.of ?? null]));
  const data = {
    name,
    views: views.map(({ slug, viewId, name: viewName }) => ({ slug, viewId, name: viewName, of: ofByView.get(viewId) ?? null })),
    viewOf,
    parents: Object.fromEntries(model.elements.map((element) => [element.id, element.parent])),
    elements: Object.fromEntries(model.elements.map((element) => [element.id, element.name])),
    pages: Object.fromEntries(views.map((view) => [view.slug, { nodes: view.nodes, connectors: view.connectors }])),
    flows: flows.map((flow) => ({ name: flow.name, steps: flow.steps })),
  };
  const sections = views.map((view) => `<section class="view" id="view-${view.slug}" data-view="${view.slug}">
        <div class="light">${view.svgLight}</div>
        <div class="dark">${view.svgDark}</div>
      </section>`).join('\n      ');
  const navItems = views.map((view) => `<button type="button" data-view="${view.slug}">${escapeHtml(view.name)}</button>`).join('\n        ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)} — OpenFlowKit</title>
<style>
:root{color-scheme:light dark;--bg:#f8fafc;--panel:#fff;--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#020617;--panel:#0f172a;--ink:#e2e8f0;--muted:#94a3b8;--line:#1e293b;--accent:#60a5fa}}
*{box-sizing:border-box}
body{margin:0;height:100vh;display:flex;flex-direction:column;font:14px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--ink)}
header{display:flex;align-items:center;gap:16px;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
h1{font-size:15px;margin:0;white-space:nowrap}
nav.breadcrumb{display:flex;align-items:center;gap:2px;color:var(--muted);overflow:auto}
nav.breadcrumb button{border:0;background:none;color:var(--accent);cursor:pointer;font:inherit;padding:2px 4px}
nav.breadcrumb button:hover{text-decoration:underline}
.shell{flex:1;display:flex;min-height:0}
nav.views{width:220px;flex:none;overflow:auto;border-right:1px solid var(--line);background:var(--panel);padding:8px}
nav.views button{display:block;width:100%;text-align:left;border:0;border-radius:6px;background:none;color:var(--ink);font:inherit;padding:7px 10px;cursor:pointer}
nav.views button:hover{background:var(--bg)}
nav.views button[aria-current="true"]{background:var(--accent);color:#fff}
main{flex:1;overflow:auto;padding:20px}
.view{display:none}.view.active{display:block}
.view svg{max-width:100%;height:auto;border-radius:10px;box-shadow:0 1px 3px rgba(15,23,42,.12)}
.view .dark{display:none}
@media (prefers-color-scheme:dark){.view .light{display:none}.view .dark{display:block}}
[data-node-id],[data-connector-id]{transition:opacity .18s ease}
svg.ofk-dim [data-node-id]:not(.ofk-active),svg.ofk-dim [data-connector-id]:not(.ofk-active){opacity:.12}
svg:not(.ofk-dim) [data-node-id].ofk-active,svg:not(.ofk-dim) [data-connector-id].ofk-active{filter:drop-shadow(0 0 5px var(--accent))}
#stage [data-node-id]{cursor:pointer}
footer{display:flex;align-items:center;gap:10px;padding:8px 16px;border-top:1px solid var(--line);background:var(--panel)}
footer[hidden]{display:none}
footer button{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:6px;font:inherit;padding:4px 10px;cursor:pointer}
footer button:hover{border-color:var(--accent)}
#step-label{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(name)}</h1>
  <nav class="breadcrumb" id="breadcrumb" aria-label="Breadcrumb"></nav>
</header>
<div class="shell">
  <nav class="views" id="views" aria-label="Views">
        ${navItems}
  </nav>
  <main id="stage" aria-label="Diagrams">
      ${sections}
  </main>
</div>
<footer id="player" role="group" aria-label="Flow player" hidden>
  <button type="button" id="prev" aria-label="Previous flow step">←</button>
  <button type="button" id="play" aria-label="Play or pause the flow" aria-pressed="false">▶</button>
  <button type="button" id="next" aria-label="Next flow step">→</button>
  <span id="step-label" role="status" aria-live="polite"></span>
</footer>
<script>
(function () {
  var DATA = ${JSON.stringify(data).replace(/</g, '\\u003c')};
  var stage = document.getElementById('stage');
  var views = DATA.views;
  var current = views.length ? views[0].slug : null;

  function el(id) { return document.getElementById(id); }
  function cssEscape(value) { return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/"/g, '\\\\"'); }
  function svgOf(slug) { var section = el('view-' + slug); return section ? section.querySelector('svg') : null; }

  function show(slug) {
    if (!slug) return;
    current = slug;
    views.forEach(function (view) { el('view-' + view.slug).classList.toggle('active', view.slug === slug); });
    document.querySelectorAll('#views button').forEach(function (button) {
      button.setAttribute('aria-current', button.getAttribute('data-view') === slug ? 'true' : 'false');
    });
    renderBreadcrumb(slug);
  }

  function renderBreadcrumb(slug) {
    var crumb = el('breadcrumb');
    crumb.textContent = '';
    var view = views.filter(function (candidate) { return candidate.slug === slug; })[0];
    var chain = [{ label: DATA.name, slug: views.length ? views[0].slug : null }];
    if (view && view.of) {
      var ids = [];
      for (var id = view.of; id; id = DATA.parents[id] || null) ids.unshift(id);
      ids.forEach(function (elementId) {
        chain.push({ label: DATA.elements[elementId] || elementId, slug: DATA.viewOf[elementId] || null });
      });
    }
    chain.forEach(function (step, index) {
      if (index) crumb.appendChild(document.createTextNode(' / '));
      if (step.slug) {
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = step.label;
        button.addEventListener('click', function () { show(step.slug); });
        crumb.appendChild(button);
      } else {
        var span = document.createElement('span');
        span.textContent = step.label;
        crumb.appendChild(span);
      }
    });
  }

  stage.addEventListener('click', function (event) {
    var node = event.target.closest ? event.target.closest('[data-node-id]') : null;
    if (!node) return;
    var id = node.getAttribute('data-node-id');
    if (id && DATA.viewOf[id]) show(DATA.viewOf[id]);
  });

  var steps = [];
  (DATA.flows || []).forEach(function (flow) {
    flow.steps.forEach(function (step) { step.flow = flow.name; steps.push(step); });
  });
  var index = -1;
  var timer = null;

  function pageOf(slug) { return DATA.pages[slug] || { nodes: [], connectors: [] }; }
  function shownId(slug, id) {
    var nodes = pageOf(slug).nodes;
    if (nodes.indexOf(id) !== -1) return id;
    var ancestor = nodes.filter(function (node) { return id.indexOf(node + '.') === 0; })
      .sort(function (a, b) { return b.length - a.length; })[0];
    return ancestor || null;
  }
  function bestView(step) {
    var best = current;
    var bestScore = -1;
    views.forEach(function (view) {
      var score = (shownId(view.slug, step.from) ? 1 : 0) + (shownId(view.slug, step.to) ? 1 : 0);
      if (score > bestScore) { bestScore = score; best = view.slug; }
    });
    return best;
  }
  function connectorFor(slug, from, to) {
    var shownFrom = shownId(slug, from);
    var shownTo = shownId(slug, to);
    if (!shownFrom || !shownTo) return null;
    return pageOf(slug).connectors.filter(function (connector) {
      return (connector.from === shownFrom && connector.to === shownTo)
        || (connector.from === shownTo && connector.to === shownFrom);
    })[0] || null;
  }
  function setCaption(step) {
    var label = el('step-label');
    if (!step) { label.textContent = ''; return; }
    var parts = ['Flow: ' + step.flow, 'step ' + (index + 1) + '/' + steps.length];
    if (step.label) parts.push(step.label);
    label.textContent = parts.join(' · ');
  }
  function activate(step) {
    views.forEach(function (view) { var svg = svgOf(view.slug); if (svg) svg.classList.remove('ofk-dim'); });
    document.querySelectorAll('.ofk-active').forEach(function (node) { node.classList.remove('ofk-active'); });
    if (!step || !step.from || !step.to) { setCaption(step); return; }
    var slug = bestView(step);
    if (slug !== current) show(slug);
    var svg = svgOf(slug);
    if (!svg) { setCaption(step); return; }
    var connector = connectorFor(slug, step.from, step.to);
    var selectors = [];
    if (connector) selectors.push('[data-connector-id="' + cssEscape(connector.id) + '"]');
    [step.from, step.to].forEach(function (id) {
      var shown = shownId(slug, id);
      if (shown) selectors.push('[data-node-id="' + cssEscape(shown) + '"]');
    });
    if (selectors.length === 0) { setCaption(step); return; }
    svg.classList.add('ofk-dim');
    selectors.forEach(function (selector) {
      svg.querySelectorAll(selector).forEach(function (node) { node.classList.add('ofk-active'); });
    });
    setCaption(step);
  }
  function goto(delta) {
    if (steps.length === 0) return;
    index = Math.max(0, Math.min(steps.length - 1, index + delta));
    activate(steps[index]);
  }
  function togglePlay() {
    var button = el('play');
    if (timer) {
      clearInterval(timer);
      timer = null;
      button.textContent = '▶';
      button.setAttribute('aria-pressed', 'false');
      return;
    }
    if (index >= steps.length - 1) index = -1;
    button.textContent = '⏸';
    button.setAttribute('aria-pressed', 'true');
    timer = setInterval(function () { goto(1); }, 1400);
    goto(1);
  }

  if (steps.length > 0) {
    el('player').hidden = false;
    el('prev').addEventListener('click', function () { goto(-1); });
    el('next').addEventListener('click', function () { goto(1); });
    el('play').addEventListener('click', togglePlay);
  }
  document.addEventListener('keydown', function (event) {
    if (event.target && event.target.tagName === 'BUTTON' && event.key === ' ') return;
    if (event.key === 'ArrowRight') { goto(1); event.preventDefault(); }
    else if (event.key === 'ArrowLeft') { goto(-1); event.preventDefault(); }
    else if (event.key === ' ' && steps.length > 0) { togglePlay(); event.preventDefault(); }
  });

  if (current) show(current);
})();
</script>
</body>
</html>
`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

export function firstModel(workspace: BundleWorkspace): ArchModelData | null {
  for (const view of workspace.views) {
    const model = modelFromNode(view.result.frame);
    if (model) return model;
  }
  return null;
}

