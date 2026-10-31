import type { DslDiagnostic } from '../../dsl/ast';
import type { CanonicalAttribute } from '../../dsl/sceneMeta';
import { attributeText, quote, slugifyDslId } from '../../dsl/text';
import { sortAttributes } from '../../dsl/vocabulary';
import { quoted, readStatements, tagPredicate } from './structurizrSyntax';
import { StructurizrResolver } from './structurizrResolver';
import {
  OFK_FAMILY_HEADER, STRUCTURIZR_KEYWORDS,
  type DraftElement, type DraftFlow, type DraftRule, type DraftView, type ResolvedRelation, type StructurizrConversion, type StructurizrConversionError,
} from './structurizrTypes';

// Structurizr DSL → OFK text (grammar §11.2). The reader, resolver and this emitter are one converter, a
// class chain: each stage extends the one before it.
export type { StructurizrConversion } from './structurizrTypes';

class StructurizrConverter extends StructurizrResolver {
  finish(): StructurizrConversion {
    this.indexModel();
    this.resolveInstances();
    this.prune();
    this.indexModel();
    this.applyStyles();
    this.kindsFromTags();
    this.iconsFromThemeTags();
    const relations = this.resolveRelations();
    this.resolveViews();
    const flows = this.resolveFlows();
    this.assignIds();
    const dsl = this.emit(relations, flows);
    return {
      dsl,
      losses: this.losses.map((entry) => entry.message),
      diagnostics: this.losses.map((entry): DslDiagnostic => ({
        code: 'W180',
        severity: 'warning',
        line: entry.line,
        col: 1,
        endCol: 1,
        message: entry.message,
        // ast.ts types `source` as 'parse'; importers report 'import' (grammar §10).
        source: 'import',
      } as unknown as DslDiagnostic)),
    };
  }

  protected elementAttributes(element: DraftElement): CanonicalAttribute[] {
    // `instance Shop.API` takes no attributes (grammar §9); it draws as its model element.
    if (element.instanceOf) return [];
    const entries: CanonicalAttribute[] = [];
    if (element.shape) entries.push({ value: element.shape });
    if (element.color) entries.push({ key: 'color', value: element.color });
    if (element.icon) entries.push({ key: 'icon', value: element.icon });
    if (element.tech) entries.push({ key: 'tech', value: element.tech });
    if (element.desc) entries.push({ key: 'desc', value: element.desc });
    if (element.tags.length > 0) entries.push({ key: 'tags', value: element.tags.join(', ') });
    return sortAttributes(entries);
  }

  /** `id = kind Name`, or `kind Name` when the id is the label slug (grammar §6.2/§9.2). */
  protected elementHead(element: DraftElement): string {
    const localId = element.parent ? element.ofkId.slice(element.parent.ofkId.length + 1) : element.ofkId;
    const name = element.instanceOf ? this.instanceRef(element.instanceOf) : quote(element.name);
    return slugifyDslId(element.name) === localId
      ? `${element.kind} ${name}`
      : `${localId} = ${element.kind} ${name}`;
  }

  /** The deepest deployment node above both ends, where the relation is written. */
  protected commonNode(from: DraftElement, to: DraftElement): DraftElement | null {
    const above = (element: DraftElement) => {
      const chain: DraftElement[] = [];
      for (let node = element.parent; node; node = node.parent) chain.push(node);
      return chain;
    };
    const toChain = new Set(above(to));
    return above(from).find((node) => toChain.has(node)) ?? null;
  }

  protected sharedScope(relation: ResolvedRelation): DraftElement | null {
    if (relation.from.env) return this.commonNode(relation.from, relation.to);
    const from = relation.from.parent;
    return from && from === relation.to.parent ? from : null;
  }

  protected relationText(relation: ResolvedRelation): string {
    const entries: CanonicalAttribute[] = [];
    if (relation.tech) entries.push({ key: 'tech', value: relation.tech });
    if (relation.tags.length > 0) entries.push({ key: 'tags', value: relation.tags.join(', ') });
    const label = relation.label ?? relation.tech;
    return `${this.refOf(relation.from)} -> ${this.refOf(relation.to)}${label ? ` : ${quote(label)}` : ''}${attributeText(sortAttributes(entries))}`;
  }

  protected emit(relations: readonly ResolvedRelation[], flows: readonly { flow: DraftFlow; steps: Array<{ from: DraftElement; to: DraftElement; label?: string }> }[]): string {
    const lines: string[] = ['%% ofk 1', 'architecture'];
    if (this.name) lines.push(`title: ${quote(this.name)}`);
    const body: string[] = [];
    this.emitModel(body, relations);
    this.emitDeployment(body, relations);
    this.emitViews(body);
    this.emitFlows(body, flows);
    lines.push('', ...body);
    while (lines.length > 0 && lines.at(-1) === '') lines.pop();
    return `${lines.join('\n')}\n`;
  }

  protected emitModel(lines: string[], relations: readonly ResolvedRelation[]): void {
    const roots = this.modelElements.filter((element) => !element.parent);
    const top = relations.filter((relation) => relation.env === null && this.sharedScope(relation) === null);
    if (roots.length === 0 && top.length === 0) return;
    lines.push('model {');
    for (const root of roots) this.emitElement(lines, root, '  ', relations);
    for (const relation of top) lines.push(`  ${this.relationText(relation)}`);
    lines.push('}');
  }

  protected emitElement(lines: string[], element: DraftElement, indent: string, relations: readonly ResolvedRelation[]): void {
    const head = `${this.elementHead(element)}${attributeText(this.elementAttributes(element))}`;
    const scoped = relations.filter((relation) => this.sharedScope(relation) === element);
    if (element.children.length === 0 && scoped.length === 0) {
      lines.push(`${indent}${head}`);
      return;
    }
    lines.push(`${indent}${head} {`);
    for (const child of element.children) this.emitElement(lines, child, `${indent}  `, relations);
    for (const relation of scoped) lines.push(`${indent}  ${this.relationText(relation)}`);
    lines.push(`${indent}}`);
  }

  protected emitDeployment(lines: string[], relations: readonly ResolvedRelation[]): void {
    for (const env of this.envOrder) {
      const elements = this.deployment.get(env) ?? [];
      const roots = elements.filter((element) => !element.parent);
      if (roots.length === 0) continue;
      lines.push(`deployment ${quote(env)} {`);
      for (const root of roots) this.emitElement(lines, root, '  ', relations);
      for (const relation of relations) if (relation.from.env === env && !this.sharedScope(relation)) lines.push(`  ${this.relationText(relation)}`);
      lines.push('}');
    }
  }

  protected emitViews(lines: string[]): void {
    const views = this.views.filter((view) => !view.dropped);
    if (views.length === 0) return;
    lines.push('views {');
    for (const view of views) {
      const head = this.viewHead(view);
      if (view.rules.length === 0) {
        lines.push(`  ${head}`);
        continue;
      }
      lines.push(`  ${head} {`);
      for (const rule of view.rules) for (const line of this.ruleLines(rule)) lines.push(`    ${line}`);
      lines.push('  }');
    }
    lines.push('}');
  }

  protected viewHead(view: DraftView): string {
    // ponytail: direction rides the header as a bare trailing word — `[right]` after
    // `of X` corrupts the scope ref in parseView today; move it into brackets once
    // parseView skips bracket tokens when reading `of`.
    const direction = view.direction ? ` ${view.direction}` : '';
    switch (view.kind) {
      case 'landscape':
        return `view landscape${direction}`;
      case 'context':
        return `view context of ${this.scopeRefOf(view.scope!)}${direction}`;
      case 'container':
        return `view container of ${this.scopeRefOf(view.scope!)}${direction}`;
      case 'component':
        return `view component of ${this.scopeRefOf(view.scope!)}${direction}`;
      case 'deployment':
        return `view deployment of ${this.scopeRefOf(view.scope!)} in ${quote(view.env ?? '')}${direction}`;
    }
  }

  protected ruleLines(rule: DraftRule): string[] {
    if (rule.raw !== undefined) return [rule.raw];
    return (rule.parts ?? []).flatMap((part): string[] => {
      switch (part.kind) {
        case 'all':
          return [`${rule.op} *`];
        case 'ref':
          return [`${rule.op} ${this.ruleRef(part.ref)}`];
        case 'successors':
          return [`${rule.op} ${this.ruleRef(part.ref)} ->`];
        case 'predecessors':
          return [`${rule.op} -> ${this.ruleRef(part.ref)}`];
        case 'pair':
          return [`${rule.op} ${this.ruleRef(part.from)} -> ${this.ruleRef(part.to)}`];
        case 'where-compound':
          return [`${rule.op} * where ${this.wherePredicate(part.groups)}`];
        case 'where-kind':
          return [`${rule.op} * where ${this.wherePredicate([[part]])}`];
        case 'where-tag':
          return [`${rule.op} * where ${tagPredicate(part.value)}`];
      }
    });
  }

  protected ruleRef(reference: string): string {
    const element = this.resolveRef(reference, null);
    return element ? this.refOf(element) : reference;
  }

  protected emitFlows(
    lines: string[],
    flows: readonly { flow: DraftFlow; steps: Array<{ from: DraftElement; to: DraftElement; label?: string }> }[],
  ): void {
    for (const { flow, steps } of flows) {
      const name = flow.name ?? (flow.scope ? flow.scope.name : 'Dynamic view');
      if (steps.length === 0) {
        lines.push(`flow ${quoted(name)}`);
        continue;
      }
      lines.push(`flow ${quoted(name)} {`);
      for (const step of steps) {
        lines.push(`  step ${this.refOf(step.from)} -> ${this.refOf(step.to)}${step.label ? ` : ${quote(step.label)}` : ''}`);
      }
      lines.push('}');
    }
  }
}

/** True when the text starts a Structurizr workspace (used for the paste banner). */
export function looksLikeStructurizr(text: string): boolean {
  if (/^\s*%%\s*ofk\b/m.test(text)) return false;
  const stripped = text.replace(/^\s*#[^\n]*$/gm, '').replace(/\/\/[^\n]*/g, '');
  const first = stripped.split('\n').map((line) => line.trim()).find(Boolean);
  if (first && OFK_FAMILY_HEADER.test(first)) return false;
  if (/^\s*workspace\b[^{\n]*\{/m.test(stripped)) return true;
  if (!/^\s*model\b[^{}\n]*\{/m.test(stripped)) return false;
  return STRUCTURIZR_KEYWORDS.test(stripped);
}

/** Structurizr DSL → OFK DSL, or an error explaining why it cannot be converted. */
export function structurizrToDsl(text: string): StructurizrConversion | StructurizrConversionError {
  const roots = readStatements(text);
  const headed = roots.some((statement) => ['workspace', 'model'].includes(statement.tokens[0]?.value ?? ''));
  if (!headed) return { error: 'No Structurizr workspace or model block found' };
  const converter = new StructurizrConverter();
  converter.walk(roots);
  return converter.finish();
}
