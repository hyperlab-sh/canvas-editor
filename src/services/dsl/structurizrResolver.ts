import { quote, slugifyDslId } from '../../dsl/text';
import { isSafeWord, tagPredicate } from './structurizrSyntax';
import { StructurizrReader } from './structurizrReader';
import {
  DEFAULT_TAGS, KIND_BY_TAG, THEME_PROVIDER, THEME_TAG,
  type DraftElement, type DraftFlow, type ResolvedRelation, type RulePart,
} from './structurizrTypes';

export class StructurizrResolver extends StructurizrReader {
  /**
   * The official cloud themes key their icons on tags (`Amazon Web Services - EC2`);
   * the same tag becomes `icon: aws/ec2`, resolved by the editor's icon rule.
   */
  protected iconsFromThemeTags(): void {
    for (const element of this.elements) {
      if (element.icon) continue;
      for (const tag of element.tags) {
        const match = THEME_TAG.exec(tag);
        if (match) {
          element.icon = `${THEME_PROVIDER[match[1]!.toLowerCase()]}/${slugifyDslId(match[2]!)}`;
          break;
        }
      }
    }
  }

  protected kindsFromTags(): void {
    for (const element of this.elements) {
      const byTag = KIND_BY_TAG[element.kind];
      const tag = byTag && element.children.length === 0 ? element.tags.find((entry) => byTag[entry]) : undefined;
      if (tag) element.kind = byTag![tag]!;
    }
  }

  /** The OFK kinds a Structurizr `element.type==` names, once tags have refined them. */
  protected kindsOf(kind: string): string[] {
    const refined = Object.values(KIND_BY_TAG[kind] ?? {});
    return [kind, ...new Set(refined.filter((variant) => this.elements.some((element) => element.kind === variant)))];
  }

  protected wherePredicate(groups: readonly (readonly RulePart[])[]): string {
    // A refined kind multiplies its AND group out (`kind is system and tag` → one group per kind); AND binds tighter.
    return groups.flatMap((group) => group.reduce<string[][]>((combos, part) => {
      const options = part.kind === 'where-kind' ? this.kindsOf(part.value).map((kind) => `kind is ${kind}`)
        : part.kind === 'where-tag' ? [tagPredicate(part.value)] : [];
      return combos.flatMap((prefix) => options.map((option) => [...prefix, option]));
    }, [[]]).map((combo) => combo.join(' and '))).join(' or ');
  }

  protected resolveInstances(): void {
    for (const entry of this.instances) {
      const target = this.resolveRef(entry.ref, entry.scope);
      if (!target || target === entry.element || target.kind === 'instance') {
        this.loss(entry.line, `containerInstance ${entry.ref} dropped: unknown element`);
        entry.element.dropped = true;
        continue;
      }
      entry.element.instanceOf = target;
      entry.element.name = this.displayPath(target);
    }
  }

  /** `containerInstance api` → `instance Shop.API`: one token, so the OFK parser resolves it. */
  protected instanceRef(target: DraftElement): string {
    const display = this.displayPath(target);
    return display.split('.').every(isSafeWord) ? display : target.ofkId;
  }

  protected prune(): void {
    const dropped = new Set(this.elements.filter((element) => element.dropped));
    if (dropped.size === 0) return;
    for (const element of this.elements) element.children = element.children.filter((child) => !dropped.has(child));
    this.elements = this.elements.filter((element) => !element.dropped);
    this.modelElements = this.modelElements.filter((element) => !element.dropped);
    for (const [env, list] of this.deployment) this.deployment.set(env, list.filter((element) => !element.dropped));
  }

  protected indexModel(): void {
    this.bySid.clear();
    this.bySidLower.clear();
    this.byPath.clear();
    this.byNamePath.clear();
    this.nameCounts.clear();
    for (const element of this.elements) {
      if (!this.bySid.has(element.sid)) this.bySid.set(element.sid, element);
      const lower = element.sid.toLowerCase();
      if (!this.bySidLower.has(lower)) this.bySidLower.set(lower, element);
      this.byPath.set(this.sidPath(element), element);
      this.byNamePath.set(this.namePath(element).toLowerCase(), element);
      const name = element.name.toLowerCase();
      this.nameCounts.set(name, (this.nameCounts.get(name) ?? 0) + 1);
    }
  }

  protected applyStyles(): void {
    for (const element of this.elements) {
      const builtIn = DEFAULT_TAGS[element.structurizrKind];
      for (const style of this.styles) {
        const tag = style.tag.toLowerCase();
        if (tag !== 'element' && tag !== builtIn?.toLowerCase() && !element.tags.some((entry) => entry === tag)) continue;
        if (style.shape) element.shape = style.shape;
        if (style.color) element.color = style.color;
        if (style.icon) element.icon = style.icon;
      }
    }
  }

  protected resolveRef(reference: string, scope: DraftElement | null): DraftElement | null {
    const wanted = reference.trim();
    if (!wanted) return null;
    for (let current: DraftElement | null = scope; current; current = current.parent) {
      const relative = this.byPath.get(`${this.sidPath(current)}.${wanted}`);
      if (relative) return relative;
    }
    const direct = this.byPath.get(wanted) ?? this.bySid.get(wanted) ?? this.bySidLower.get(wanted.toLowerCase());
    if (direct) return direct;
    const lower = wanted.toLowerCase();
    const byNamePath = this.byNamePath.get(lower);
    if (byNamePath) return byNamePath;
    const bySlugPath = this.byPath.get(wanted.split('.').map((segment) => slugifyDslId(segment)).join('.'));
    if (bySlugPath) return bySlugPath;
    const byName = this.elements.filter((element) => element.name.toLowerCase() === lower);
    return byName.length === 1 ? byName[0]! : null;
  }

  protected resolveRelations(): ResolvedRelation[] {
    const resolved: ResolvedRelation[] = [];
    for (const draft of this.relations) {
      const from = draft.from === null ? draft.scope : this.resolveRef(draft.from, draft.scope);
      const to = this.resolveRef(draft.to, draft.scope);
      if (!from || !to) {
        this.loss(draft.line, `relation ${draft.from ?? '->'} -> ${draft.to} dropped: unknown element`);
        continue;
      }
      if ((from.env ?? null) !== (to.env ?? null)) {
        this.loss(draft.line, `relation ${draft.from ?? '->'} -> ${draft.to} dropped: endpoints in different environments`);
        continue;
      }
      let tags = draft.tags;
      if (!draft.label && !draft.tech && tags.length > 0) {
        this.loss(draft.line, `relation ${from.name} -> ${to.name} tags dropped: no description to carry them`);
        tags = [];
      }
      if (!draft.label && draft.tech) {
        this.loss(draft.line, `relation ${from.name} -> ${to.name} technology shown as the label: Structurizr had no description`);
      }
      resolved.push({
        from, to, tags, env: draft.env,
        ...(draft.label ? { label: draft.label } : {}),
        ...(draft.tech ? { tech: draft.tech } : {}),
      });
    }
    return resolved;
  }

  protected resolveViews(): void {
    for (const view of this.views) {
      if (view.key) this.loss(view.line, `view key "${view.key}" dropped`);
      if (view.kind === 'landscape') continue;
      const scope = view.scopeRef ? this.resolveRef(view.scopeRef, null) : null;
      if (!scope) {
        this.loss(view.line, `${view.kind} view scope ${view.scopeRef ?? '?'} unresolved; view dropped`);
        view.dropped = true;
      } else {
        view.scope = scope;
      }
    }
  }

  protected resolveFlows(): Array<{ flow: DraftFlow; steps: Array<{ from: DraftElement; to: DraftElement; label?: string }> }> {
    const resolved: Array<{ flow: DraftFlow; steps: Array<{ from: DraftElement; to: DraftElement; label?: string }> }> = [];
    for (const flow of this.flows) {
      const scope = flow.scopeRef ? this.resolveRef(flow.scopeRef, null) : null;
      if (flow.scopeRef && !scope) this.loss(flow.line, `dynamic view scope ${flow.scopeRef} unresolved; steps kept without a scope`);
      flow.scope = scope ?? undefined;
      const steps: Array<{ from: DraftElement; to: DraftElement; label?: string }> = [];
      let previous: DraftElement | null = null;
      let folded = false;
      for (const step of flow.steps) {
        const from = step.from === null ? previous ?? scope : this.resolveRef(step.from, scope);
        const to = this.resolveRef(step.to, scope);
        if (!from || !to) {
          this.loss(step.line, `flow step ${step.from ?? '->'} -> ${step.to} dropped: unknown element`);
          continue;
        }
        const label = [step.label, step.tech ? `(${step.tech})` : '', step.tags.length ? `[${step.tags.join('/')}]` : '']
          .filter(Boolean).join(' ');
        if (step.tech || step.tags.length > 0) folded = true;
        steps.push({ from, to, ...(label ? { label } : {}) });
        previous = to;
      }
      if (folded) this.loss(flow.line, 'flow step technology/tags folded into the labels');
      resolved.push({ flow, steps });
    }
    return resolved;
  }

  protected assignIds(): void {
    const used = new Set<string>();
    const visit = (element: DraftElement): void => {
      element.ofkId = this.uniquePath(element.parent?.ofkId ?? null, this.localId(element), used);
      for (const child of element.children) visit(child);
    };
    for (const root of this.modelElements.filter((element) => !element.parent)) visit(root);
    for (const env of this.envOrder) {
      for (const root of this.deployment.get(env)!.filter((element) => !element.parent)) visit(root);
    }
  }

  /** Structurizr ids are the OFK ids, as written (`webApi`; ids are case-sensitive, §2.6); display names stay labels. */
  protected localId(element: DraftElement): string {
    if (element.kind === 'instance') return slugifyDslId(element.name);
    if (element.explicitSid) {
      if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(element.sid)) return element.sid;
      const slug = slugifyDslId(element.sid);
      if (/^[A-Za-z_]/.test(slug)) return slug;
    }
    return slugifyDslId(element.name);
  }

  protected uniquePath(parent: string | null, localId: string, used: Set<string>): string {
    const base = parent ? `${parent}.${localId}` : localId;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${base}-${suffix++}`;
    used.add(candidate);
    return candidate;
  }

  protected refOf(element: DraftElement): string {
    return (this.nameCounts.get(element.name.toLowerCase()) ?? 0) === 1 ? quote(element.name) : element.ofkId;
  }

  protected scopeRefOf(element: DraftElement): string {
    const segments: string[] = [];
    for (let current: DraftElement | null = element; current; current = current.parent) segments.unshift(current.name);
    return segments.every(isSafeWord) ? segments.join('.') : element.ofkId;
  }
}
