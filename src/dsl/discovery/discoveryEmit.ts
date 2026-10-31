import { architectureWorkspaceText } from '../families/architecture/text';
import type { ArchElement, ArchView } from '../model/types';
import { dirname } from './rules';
import type { ArchitectureDiscovery, DiscoveredRelation, DiscoveredUnit, DiscoveryEvidence } from './discoveryTypes';
import { KIND_RANK, kindGroup, slugDiscoveryId, systemSegment } from './discoveryShared';

/* --------------------------------------------------------------- emission */

interface EmitGroup {
  id: string;
  name: string;
  units: DiscoveredUnit[];
}

/**
 * Single-token system names: `view container of Docs-Site` resolves, while the
 * parser joins a multi-word reference with dots (`Docs.Site`) and loses it.
 */
function prettify(segment: string): string {
  const words = segment.split(/[-_.\s]+/).filter(Boolean);
  if (words.length === 0) return segment;
  return words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join('-');
}

function systemName(value: string): string {
  const trimmed = value.trim();
  return /\s/.test(trimmed) ? prettify(trimmed) : trimmed;
}

function uniqueId(candidate: string, used: Set<string>): string {
  let id = candidate;
  let suffix = 2;
  while (used.has(id)) id = `${candidate}-${suffix++}`;
  used.add(id);
  return id;
}

/** Services, then stores, queues and externals, then libraries, then sample apps. */
const capTier = (unit: DiscoveredUnit): number => (unit.example ? 6 : unit.library ? 5 : KIND_RANK[unit.kind]);

/**
 * At most `max` units for a readable first picture of a big monorepo: services
 * first, then stores, queues and externals, each in discovery order; then the
 * libraries most relations touch, then sample apps. Relations to a dropped unit
 * go with it; the caller says how many were left out.
 */
export function capUnits(result: ArchitectureDiscovery, max: number): { readonly result: ArchitectureDiscovery; readonly dropped: number } {
  if (result.units.length <= max) return { result, dropped: 0 };
  const degree = new Map<string, number>();
  for (const relation of result.relations) for (const id of [relation.from, relation.to]) degree.set(id, (degree.get(id) ?? 0) + 1);
  const touches = (unit: DiscoveredUnit) => (unit.library ? degree.get(unit.id) ?? 0 : 0);
  const kept = [...result.units]
    .map((unit, order) => ({ unit, order }))
    .sort((a, b) => capTier(a.unit) - capTier(b.unit) || touches(b.unit) - touches(a.unit) || a.order - b.order)
    .slice(0, max)
    .sort((a, b) => a.order - b.order)
    .map(({ unit }) => unit);
  const ids = new Set(kept.map((unit) => unit.id));
  const relations = result.relations.filter((relation) => ids.has(relation.from) && ids.has(relation.to));
  return {
    result: {
      ...result, units: kept, relations,
      evidenceCount: kept.reduce((total, unit) => total + unit.evidence.length, 0) + relations.reduce((total, relation) => total + relation.evidence.length, 0),
    },
    dropped: result.units.length - kept.length,
  };
}

/** What an arrow's label says, most first: the code's own use of a service, then wiring, then startup order. */
const LABEL_ORDER = ['uses', 'calls', 'imports', 'depends on', 'deploys'];
const labelRank = (label: string | undefined): number => (label && LABEL_ORDER.includes(label) ? LABEL_ORDER.indexOf(label) : LABEL_ORDER.length);

/**
 * The discovered units as a compiling OFK architecture workspace: one system per
 * top-level directory (or one named after the repo), `view landscape` plus a
 * container view per system, `tags: discovered` on everything. Each relation
 * carries its first evidence line as a `link` (`file:line`, or what `evidenceLink`
 * makes of it, such as a GitHub line URL), so an arrow says where it came from.
 */
export function discoveryToDsl(
  result: ArchitectureDiscovery,
  name: string,
  evidenceLink: (evidence: DiscoveryEvidence) => string = ({ file, line }) => `${file}:${line}`,
): string {
  const repoName = name.trim() || 'System';
  // A library nothing uses and that uses nothing (a workspace root, a config package) is a lone box that says
  // nothing, unless the repo has nothing else to draw.
  const linked = new Set(result.relations.flatMap((relation) => [relation.from, relation.to]));
  const shown = result.units.filter((unit) => !unit.library || linked.has(unit.id));
  const units = shown.some((unit) => kindGroup(unit.kind) === 'app') ? shown : result.units;
  const containers = units.filter((unit) => unit.kind === 'container' || unit.kind === 'system');
  const dependencies = units.filter((unit) => unit.kind !== 'container' && unit.kind !== 'system');
  // A top-level folder is a product only if it holds 2+ services; a lone service (web/, api/) is
  // part of the repo's one system. The repo splits only when 2+ products exist.
  const perSegment = new Map<string, number>();
  for (const unit of containers) {
    const segment = systemSegment(unit.dir);
    if (segment) perSegment.set(segment, (perSegment.get(segment) ?? 0) + 1);
  }
  const products = new Set([...perSegment].filter(([, count]) => count >= 2).map(([segment]) => segment));
  const grouped = products.size >= 2;

  const groups: EmitGroup[] = [];
  const byKey = new Map<string, EmitGroup>();
  const groupFor = (key: string, displayName: string): EmitGroup => {
    const existing = byKey.get(key);
    if (existing) return existing;
    const group: EmitGroup = { id: '', name: displayName, units: [] };
    byKey.set(key, group);
    groups.push(group);
    return group;
  };
  for (const unit of containers) {
    const segment = systemSegment(unit.dir);
    const key = grouped && products.has(segment) ? segment : '';
    groupFor(key, key ? prettify(key) : systemName(repoName)).units.push(unit);
  }
  for (const unit of dependencies) {
    const evidence = unit.evidence[0];
    const segment = evidence ? systemSegment(dirname(evidence.file) === '.' ? '' : dirname(evidence.file)) : '';
    const key = segment && byKey.has(segment) ? segment : '';
    groupFor(key, key ? prettify(key) : systemName(repoName)).units.push(unit);
  }

  const usedIds = new Set<string>();
  for (const group of groups) group.id = uniqueId(slugDiscoveryId(group.name), usedIds);
  const elementId = new Map<string, string>();
  for (const group of groups) {
    for (const unit of group.units) {
      // A local id never contains a dot: the serializer writes `x = kind Name`
      // and the parser rejects dots there (W120). A unit named like its group
      // (`api` inside group `api`) nests as `api.api`.
      const local = slugDiscoveryId(unit.id.split('.').pop()!);
      elementId.set(unit.id, uniqueId(`${group.id}.${local}`, usedIds));
    }
  }

  const elements: ArchElement[] = [];
  for (const group of groups) {
    elements.push({
      id: group.id, kind: 'system', name: group.name, parent: null,
      tags: ['discovered'], links: [],
    });
    for (const unit of group.units) {
      elements.push({
        id: elementId.get(unit.id)!, kind: unit.kind, name: unit.name, parent: group.id,
        ...(unit.tech ? { tech: unit.tech } : {}),
        tags: ['discovered'], links: [],
      });
    }
  }

  // One arrow per pair: compose's `depends on` and the code's client for the same store are one line, labelled by
  // what the code does, in the place of the first relation that named the pair.
  const strongest = new Map<string, DiscoveredRelation>();
  for (const relation of result.relations) {
    const from = elementId.get(relation.from);
    const to = elementId.get(relation.to);
    if (!from || !to || from === to) continue;
    const key = `rel:${from}->${to}`;
    const held = strongest.get(key);
    if (!held || labelRank(relation.label) < labelRank(held.label)) strongest.set(key, relation);
  }
  const relations = [...strongest].map(([id, relation]) => {
    const evidence = relation.evidence[0];
    return {
      id, from: elementId.get(relation.from)!, to: elementId.get(relation.to)!,
      ...(relation.label ? { label: relation.label } : {}),
      ...(evidence ? { attrs: [{ key: 'link', value: evidenceLink(evidence) }] } : {}),
      tags: [],
    };
  });

  // One system: the services are the diagram. A landscape would be that one box (discovery
  // emits no external people or systems), so it is not emitted and the container view lands first.
  const views: ArchView[] = groups.length === 1 ? [] : [{
    id: 'view:landscape', kind: 'landscape', name: `${repoName} landscape`, rules: [],
  }];
  for (const group of groups) {
    views.push({
      id: `view:container:${group.id}`, kind: 'container', name: `${group.name} containers`,
      of: group.id, rules: [],
    });
  }

  const text = architectureWorkspaceText({
    name: repoName, elements, relations, views, flows: [],
  });
  const header = [
    `// discovered by openflowkit — ${units.length} units, ${result.relations.length} relations, ${result.evidenceCount} evidence lines`,
    '// heuristics read manifests, imports and line matches; review names, tech and grouping before committing',
  ];
  const lines = text.split('\n');
  const anchor = lines.findIndex((line) => line === 'model {');
  if (anchor === -1) return `${text.trimEnd()}\n${header.join('\n')}\n`;
  lines.splice(anchor, 0, ...header);
  return lines.join('\n');
}
