import type { DslDiagnostic } from '../../dsl/ast';
import { quote, slugifyDslId } from '../../dsl/text';
import { detectMermaidDiagramType } from '../mermaid/detectDiagramType';
import { parseMermaidByType } from '../mermaid/parseMermaidByType';
import { architectureDsl, flowchartDsl, mindmapDsl, gitgraphDsl } from './mermaidToDslGraph';
import { sequenceDsl } from './mermaidToDslSequence';
import { classDsl, erDsl, stateDsl } from './mermaidToDslStructure';
import { lossDiagnostic, styleLosses } from './mermaidToDslShared';
import type { Converted, FlowEdge, FlowNode, MermaidConversion, MermaidConversionError } from './mermaidToDslTypes';

// Mermaid → OFK DSL. The existing per-family parsers (DOM-free, corpus-tested)
// produce the graph model; this adapter turns that model back into text. Losses
// are reported as W180 diagnostics so the code panel lists them like any other.

export type { MermaidConversion, MermaidConversionError } from './mermaidToDslTypes';

/**
 * A line that opens with a Mermaid shape — `root((x))`, `id[Label]`, `::icon(…)`,
 * `service api(server)[API]`. Our DSL puts a space before `[attrs]` and keeps
 * brackets inside quoted labels, so it never starts a line like this.
 */
// Mermaid glues the shape to the id (`root((Idea))`, `group api(cloud)[API]`); our DSL puts a space first.
const MERMAID_SHAPED = /^\s*([\w.-]*(\(\(|\[|\(|\{\{|\)\))|::icon\(|(service|group|junction)\s+[\w-]+[([])/m;
/**
 * A bare `architecture` header is ours unless a line is Mermaid's own architecture syntax: `service x(icon)[Title]`,
 * `group x[Title]`, or a side-pinned edge `a:L -- R:b` (a junction always has one, so `junction` alone decides
 * nothing: `junction box` is a node of ours). A glued `DB[cylinder]` alone is ours too (the DSL reads it as
 * `DB [cylinder]`), not a reason to read the whole document as another language.
 */
const MERMAID_ARCHITECTURE = /^\s*((service|group)\s+[\w-]+(\([\w:.-]*\))?\[|[\w-]+(\{group\})?:[LRTB]\s*<?-->?\s*[LRTB]:)/m;

/**
 * Mermaid YAML front matter (`---` … `---` before the header) as blank lines, so
 * detection sees the header and every later line keeps its number.
 */
function withoutFrontMatter(text: string): { body: string; title?: string; keys: string[] } {
  const match = /^(\s*---[ \t]*\r?\n)([\s\S]*?\r?\n)([ \t]*---[ \t]*)(?=\r?\n|$)/.exec(text);
  if (!match) return { body: text, keys: [] };
  const yaml = match[2]!;
  const title = /^title:\s*["']?(.*?)["']?\s*$/m.exec(yaml)?.[1];
  const keys = [...yaml.matchAll(/^([A-Za-z][\w-]*):/gm)].map((key) => key[1]!).filter((key) => key !== 'title');
  return { body: match[0].replace(/[^\n]/g, '') + text.slice(match[0].length), ...(title ? { title } : {}), keys };
}

const DSL_ONLY = /^\s*title\s*:|^\s*[\w.-]+\s+->\s/m;
const MERMAID_ONLY =/-->|-\.->|==>|~~~|subgraph|@\{|\|\w+\||-\[\||\[\[\(|\}\]/;

/** True when the text starts a Mermaid diagram (used for the panel banner). */
export function looksLikeMermaid(text: string): boolean {
  // Our own pragma is decisive: a DSL document is never Mermaid.
  if (/^\s*%%\s*ofk\b/m.test(text)) return false;
  text = withoutFrontMatter(text).body;
  const first = text.split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('%%'));
  if (!first) return false;
  if (/^(flowchart|graph)\b/i.test(first)) {
    // `-->` is our dashed edge too, so these DSL-only signals decide before MERMAID_ONLY does.
    if (/^(flowchart|graph)\s+(right|left|down|up)\b/i.test(first) || DSL_ONLY.test(text)) return false;
    // Our directions are words; `TD`/`LR`/… is Mermaid's header and needs no other hint.
    if (/^(flowchart|graph)\s+(TD|TB|LR|RL|BT)\s*;?$/.test(first)) return true;
    if (MERMAID_ONLY.test(text)) return true;
    // `A[Label]` is Mermaid shorthand; our DSL writes `A [shape]` with a space.
    if (/\w\[/.test(text) || /\|\w+\|/.test(text)) return true;
    return false;
  }
  // Three headers are also our family words; only Mermaid-only syntax makes those Mermaid.
  if (/^gitgraph\b/i.test(first)) return first.startsWith('gitGraph');
  if (/^mindmap\s*$/i.test(first)) return MERMAID_SHAPED.test(text);
  if (/^architecture\s*$/i.test(first)) return MERMAID_ARCHITECTURE.test(text);
  return /^(sequenceDiagram|stateDiagram(-v2)?|classDiagram|erDiagram|journey|architecture-beta|gantt|pie|timeline|sankey-beta|C4Context|quadrantChart|requirementDiagram|xychart-beta|block-beta|packet-beta|kanban|radar-beta|treemap)\b/i.test(first);
}

const CONVERTIBLE = 'flowchart, sequenceDiagram, stateDiagram, classDiagram, erDiagram, mindmap, architecture, gitGraph';

/**
 * Mermaid ids are case-sensitive; ours are slugs. `A` and `a` would both slug to `a` and
 * merge, so the later one is renamed (`a-2`) everywhere it is referenced. Ids that do not
 * collide are left exactly as parsed (the state writer reads `state_start…` prefixes).
 */
function distinctIds(nodes: FlowNode[], edges: FlowEdge[]): { nodes: FlowNode[]; edges: FlowEdge[]; rename: (id: string) => string } {
  const taken = new Set<string>();
  const renamed = new Map<string, string>();
  for (const { id } of nodes) {
    const slug = slugifyDslId(id) || 'n';
    if (!taken.has(slug)) {
      taken.add(slug);
      continue;
    }
    let suffix = 2;
    while (taken.has(`${slug}-${suffix}`)) suffix += 1;
    taken.add(`${slug}-${suffix}`);
    renamed.set(id, `${slug}-${suffix}`);
  }
  const rename = (id: string) => renamed.get(id) ?? id;
  if (renamed.size === 0) return { nodes, edges, rename };
  const to = (id: unknown) => (typeof id === 'string' ? rename(id) : id);
  return {
    rename,
    nodes: nodes.map((node) => ({
      ...node,
      id: to(node.id) as string,
      ...(node.parentId ? { parentId: to(node.parentId) as string } : {}),
      ...(node.data ? {
        data: {
          ...node.data,
          ...(node.data.mindmapParentId ? { mindmapParentId: to(node.data.mindmapParentId) } : {}),
          ...(node.data.seqNoteTarget ? { seqNoteTarget: to(node.data.seqNoteTarget) } : {}),
          ...(Array.isArray(node.data.seqNoteTargets) ? { seqNoteTargets: node.data.seqNoteTargets.map(to) } : {}),
        },
      } : {}),
    })) as FlowNode[],
    edges: edges.map((edge) => ({ ...edge, source: to(edge.source) as string, target: to(edge.target) as string })),
  };
}

/** Mermaid text → OFK DSL, or an error explaining why it cannot be converted. */
export function mermaidToDsl(source: string): MermaidConversion | MermaidConversionError {
  const front = withoutFrontMatter(source);
  const text = front.body;
  const header = /^\s*([A-Za-z][\w-]*)/m.exec(text.split('\n').filter((line) => !line.trim().startsWith('%%')).join('\n'))?.[1] ?? '';
  // Asked explicitly, a shared header (`mindmap`) is taken as Mermaid even without Mermaid-only syntax.
  const shared = /^(mindmap|architecture|gitgraph)$/i.test(header) && !/^\s*%%\s*ofk\b/m.test(text);
  if (!shared && !looksLikeMermaid(text)) return { error: 'No Mermaid diagram header found' };
  const unsupported = { error: `Mermaid "${header}" cannot be converted. Convertible: ${CONVERTIBLE}.` };
  const conversion = (() => {
    if (/^gitGraph$/i.test(header)) return gitgraphDsl(text);
    // journey parses but has no DSL family: say so before the parser complains about its steps.
    const detected = detectMermaidDiagramType(text);
    if (!detected || detected === 'journey') return unsupported;
    const parsed = parseMermaidByType(text);
    if (parsed.error) return { error: parsed.error };
    // The parser's model is structurally wider; the adapter reads these fields only.
    const { nodes, edges, rename } = distinctIds(parsed.nodes as unknown as FlowNode[], parsed.edges as unknown as FlowEdge[]);
    const converted = (() => {
      switch (parsed.diagramType) {
        case 'flowchart': return flowchartDsl(nodes, edges, parsed.direction);
        case 'sequence': return sequenceDsl(text, nodes, edges);
        case 'stateDiagram': return stateDsl(text, nodes, edges, parsed.direction, rename);
        case 'erDiagram': return erDsl(nodes, edges);
        case 'classDiagram': return classDsl(nodes, edges);
        case 'mindmap': return mindmapDsl(nodes);
        case 'architecture': return architectureDsl(nodes, edges);
        default: return null;
      }
    })();
    if (!converted) return unsupported;
    // Parser findings keep their Mermaid line; adapter losses are about the whole diagram (line 1).
    // An edge the parser could not read is an error: converting around it would invent or drop nodes.
    const all = (parsed.structuredDiagnostics ?? []).filter((item) => item.message);
    const isBrokenEdge = (item: (typeof all)[number]) => /invalid mermaid edge/i.test(item.message);
    const found = [...all.filter((item) => !isBrokenEdge(item)), ...styleLosses(text)];
    return {
      dsl: converted.dsl,
      losses: [...converted.losses, ...found.map((item) => item.message)],
      lossLines: [...converted.losses.map(() => 1), ...found.map((item) => item.line ?? 1)],
      errors: all.filter(isBrokenEdge).map((item): DslDiagnostic => ({
        code: 'E004', severity: 'error', line: item.line ?? 1, col: 1, endCol: 1, source: 'parse',
        message: `Mermaid line ${item.line ?? 1}: ${item.message.replace(/ at line \d+/, '')}; fix it, then convert`,
      })),
    };
  })();
  if ('error' in conversion) return conversion;
  const { losses, lossLines = [], errors = [] }: Converted = conversion;
  // Front matter's title, or a diagram's own `title …` line, becomes our `title:` directive; config has no DSL form.
  const title = front.title ?? (/^(flowchart|graph)\b/i.test(header) ? undefined : /^\s*title:?\s+(.+?)\s*$/m.exec(text)?.[1]);
  const dsl = title && !/^title:/m.test(conversion.dsl)
    ? conversion.dsl.replace(/^.*\n/, (family) => `${family}title: ${quote(title)}\n`) : conversion.dsl;
  const dropped = front.keys.length ? [`Front matter ${front.keys.join(', ')} dropped`] : [];
  return {
    dsl,
    losses: [...dropped, ...losses],
    diagnostics: [...errors, ...dropped.map((message) => lossDiagnostic(1, message)), ...losses.map((message, index) => lossDiagnostic(lossLines[index] ?? 1, message))],
  };
}
