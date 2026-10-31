import type { DslDiagnostic } from '../../dsl/ast';
import type { CanonicalAttribute } from '../../dsl/sceneMeta';
import { attributeText, quote, slugifyDslId } from '../../dsl/text';
import { sortAttributes } from '../../dsl/vocabulary';

import { Reader, type Item } from './d2Reader';
import { Converter, type D2Edge, type D2Node } from './d2Converter';
// D2 → OFK DSL (plan 13.5). D2 is a tree of `key: value { block }` statements and
// `a -> b: label` connections. The subset the public corpus uses converts: shapes,
// containers, labels, colours, dashes, links, cloud icons, `shape: sequence_diagram`
// and `sql_table`. Everything else is a W180 loss, never a throw (mermaidToDsl
// conventions). ponytail: globs, vars, layers, grids and `near` are reported, not
// emulated — add them when a real file needs one.

export interface D2Conversion {
  dsl: string;
  losses: string[];
  diagnostics: DslDiagnostic[];
}

interface D2ConversionError {
  error: string;
}

// ---------- writing ----------

/** A label that may hold a line break; DSL writes it as `\n` inside quotes (grammar §2.4). */
function labelText(value: string): string {
  return value.includes('\n') ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"` : quote(value);
}

function assignIds(nodes: Iterable<D2Node>): Map<string, string> {
  const ids = new Map<string, string>();
  const used = new Set<string>();
  // An explicit id opens with a letter (grammar §2.6): `2007` becomes `n2007`.
  const idOf = (text: string) => { const slug = slugifyDslId(text); return /^\d/.test(slug) ? `n${slug}` : slug; };
  for (const node of nodes) {
    const base = idOf(node.key);
    let id = used.has(base) ? idOf(node.path) : base;
    for (let suffix = 2; used.has(id); suffix++) id = `${idOf(node.path)}-${suffix}`;
    used.add(id);
    ids.set(node.path, id);
  }
  return ids;
}

const labelOf = (node: D2Node) => node.label?.trim() || node.key;

/** Labels that another node also carries, or that name another node's id: those need `id = Label`. */
function ambiguous(nodes: readonly D2Node[], ids: ReadonlyMap<string, string>): Set<string> {
  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(slugifyDslId(labelOf(node)), (counts.get(slugifyDslId(labelOf(node))) ?? 0) + 1);
  const idSet = new Set(ids.values());
  return new Set(nodes.filter((node) => {
    const slug = slugifyDslId(labelOf(node));
    return (counts.get(slug) ?? 0) > 1 || (idSet.has(slug) && ids.get(node.path) !== slug);
  }).map((node) => node.path));
}

function declaration(node: D2Node, id: string, forceId = false): string {
  const label = labelOf(node);
  const entries: CanonicalAttribute[] = [];
  if (node.shape && node.shape !== 'sql_table' && node.shape !== 'sequence_diagram') entries.push({ value: node.shape });
  if (node.color) entries.push({ key: 'color', value: node.color });
  if (node.shadow) entries.push({ value: 'shadow' });
  if (node.icon) entries.push({ key: 'icon', value: node.icon });
  if (node.link) entries.push({ key: 'link', value: node.link });
  if (node.width) entries.push({ key: 'width', value: node.width });
  if (node.height) entries.push({ key: 'height', value: node.height });
  const head = slugifyDslId(label) === id && !forceId ? labelText(label) : `${id} = ${labelText(label)}`;
  return `${head}${attributeText(sortAttributes(entries))}`;
}

function edgeText(edge: D2Edge, ids: ReadonlyMap<string, string>): string {
  const entries: CanonicalAttribute[] = [];
  if (edge.thick) entries.push({ value: 'thick' });
  if (edge.flow) entries.push({ value: 'flow' });
  if (edge.head) entries.push({ key: 'head', value: edge.head });
  if (edge.tail) entries.push({ key: 'tail', value: edge.tail });
  const op = edge.dashed ? ({ '->': '-->', '<-': '<--', '<->': '<-->', '--': '--' } as const)[edge.op] : edge.op;
  const label = edge.label ? ` : ${labelText(edge.label)}` : '';
  return `${ids.get(edge.from)} ${op} ${ids.get(edge.to)}${label}${attributeText(sortAttributes(entries))}`;
}

const DIRECTION_WORDS = new Set(['up', 'down', 'left', 'right']);

function writeGraph(converter: Converter): string {
  const nodes = [...converter.nodes.values()];
  const ids = assignIds(nodes);
  const force = ambiguous(nodes, ids);
  const children = (parent: string | null) => nodes.filter((node) => node.parent === parent);
  const lines = [`flowchart${converter.direction && DIRECTION_WORDS.has(converter.direction) ? ` ${converter.direction}` : ''}`];
  const emit = (node: D2Node, indent: string): void => {
    const kids = children(node.path);
    if (kids.length === 0) {
      lines.push(`${indent}${declaration(node, ids.get(node.path)!, force.has(node.path))}`);
      return;
    }
    lines.push(`${indent}group ${declaration(node, ids.get(node.path)!, force.has(node.path))} {`);
    for (const kid of kids) emit(kid, `${indent}  `);
    lines.push(`${indent}}`);
  };
  for (const root of children(null)) emit(root, '');
  for (const edge of converter.edges) lines.push(edgeText(edge, ids));
  return `${lines.join('\n')}\n`;
}

function writeErd(converter: Converter): string {
  const tables = [...converter.nodes.values()];
  const ids = assignIds(tables);
  const force = ambiguous(tables, ids);
  const flag = (constraint: string) => ({ primary_key: 'pk', pk: 'pk', foreign_key: 'fk', fk: 'fk', unique: 'unique', unq: 'unique' })[constraint.toLowerCase()];
  const lines = [`erd${converter.direction && DIRECTION_WORDS.has(converter.direction) ? ` ${converter.direction}` : ''}`];
  for (const table of tables) {
    lines.push(`${declaration(table, ids.get(table.path)!, force.has(table.path))} {`);
    for (const row of table.rows) {
      const flags = row.constraints.map(flag).filter(Boolean);
      const type = row.type.trim() ? slugifyDslId(row.type).replace(/-/g, '_') : '';
      lines.push(`  ${[quote(row.name), type, ...flags].filter(Boolean).join(' ')}`);
    }
    lines.push('}');
  }
  for (const edge of converter.edges) {
    lines.push(`${ids.get(edge.from)} -> ${ids.get(edge.to)}${edge.label ? ` : ${labelText(edge.label)}` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

function writeSequence(converter: Converter): string {
  const nodes = [...converter.nodes.values()];
  const actors = nodes.filter((node) => node.parent === null && !converter.groups.has(node.path));
  const ids = assignIds(actors);
  const actorOf = (path: string) => ids.get(path.split('.')[0]!);
  const used = new Set(converter.edges.flatMap((edge) => [edge.from, edge.to]));
  const lines = ['sequence'];
  for (const actor of actors) {
    const id = ids.get(actor.path)!;
    const label = actor.label?.trim() || actor.key;
    const attrs = actor.shape === 'person' ? ' [person]' : actor.shape === 'cylinder' ? ' [db]' : actor.shape === 'queue' ? ' [queue]' : '';
    lines.push(`participant ${slugifyDslId(label) === id ? labelText(label) : `${id} = ${labelText(label)}`}${attrs}`);
  }
  // Notes are children of an actor that no message names; a span (`alice.play`) is its actor.
  // Notes and messages keep their written order: in a sequence, order is meaning.
  const steps: { line: number; text: string }[] = [];
  for (const note of nodes.filter((node) => node.parent && !converter.groups.has(node.parent) && !used.has(node.path) && actorOf(node.path))) {
    steps.push({ line: note.line, text: `note over ${actorOf(note.path)} : ${labelText(note.label?.trim() || note.key)}` });
  }
  if (nodes.some((node) => node.parent && used.has(node.path))) converter.loss(1, 'spans drawn on their actor');
  for (const edge of converter.edges) {
    const from = actorOf(edge.from);
    const to = actorOf(edge.to);
    if (!from || !to) continue;
    const [source, target] = edge.op === '<-' ? [to, from] : [from, to];
    if (edge.op === '<->' || edge.op === '--') converter.loss(edge.line, `sequence ${edge.op} drawn as one message`);
    steps.push({ line: edge.line, text: `${source} ${edge.dashed ? '-->' : '->'} ${target}${edge.label ? ` : ${labelText(edge.label)}` : ''}` });
  }
  lines.push(...steps.sort((a, b) => a.line - b.line).map(({ text }) => text));
  return `${lines.join('\n')}\n`;
}

// ---------- entry points ----------

/** D2-only syntax our DSL never writes: `key.shape:`, `style.` keys, `|md`, `classes: {`. (`#` alone is markdown too.) */
const D2_MARKERS = /(?:^\s*(?:[^\n:[\]]+\.)?|[{;]\s*)(?:shape|icon|style(?:\.[\w-]+)?|near|tooltip)\s*:|\|md\b|^\s*classes\s*:\s*\{|^\s*vars\s*:\s*\{/m;
const OFK_OR_MERMAID_HEADER = /^\s*(?:%%|flowchart|graph|architecture|sequence|state|erd|class|mindmap|gitgraph|gitGraph|chart|wireframe|workspace|model\b|sequenceDiagram|stateDiagram|classDiagram|erDiagram|journey|gantt|pie)\b/;

/** True when the text reads as D2 and as nothing we already speak. */
export function looksLikeD2(text: string): boolean {
  const first = text.split('\n').find((line) => line.trim()) ?? '';
  if (OFK_OR_MERMAID_HEADER.test(first)) return false;
  // Our DSL attributes live in `[…]`; D2 never writes them on a node line.
  if (/^\s*[^\n#"]*\w \[[^\]]*\]\s*$/m.test(text)) return false;
  return D2_MARKERS.test(text) || /^\s*[^\n:#]+\s*(?:->|<-|<->|--)\s*[^\n:#]+:\s*\S/m.test(text) && /^\s*[\w ."'-]+:\s*\{\s*$/m.test(text);
}

export function d2ToDsl(text: string): D2Conversion | D2ConversionError {
  const reader = new Reader(text.replace(/\r\n?/g, '\n'));
  let items: Item[];
  try {
    items = reader.items();
  } catch (error) {
    if (error instanceof RangeError) return { error: error.message };
    throw error;
  }
  const converter = new Converter();
  for (const problem of reader.problems) converter.loss(problem.line, problem.message);
  converter.walk(items, []);
  converter.finishTables();
  if (converter.nodes.size === 0) return { error: 'No D2 shapes or connections found' };
  const tables = [...converter.nodes.values()];
  const erd = tables.every((node) => node.shape === 'sql_table');
  if (!erd && tables.some((node) => node.shape === 'sql_table')) converter.loss(1, 'sql_table shapes mixed with other shapes are drawn as boxes');
  const dsl = converter.sequence ? writeSequence(converter) : erd ? writeErd(converter) : writeGraph(converter);
  const losses = converter.lossList();
  return {
    dsl,
    losses: losses.map(({ message }) => message),
    diagnostics: losses.map(({ message, line }) => ({ code: 'W180', severity: 'warning', line, col: 1, endCol: 1, message, source: 'parse' })),
  };
}
