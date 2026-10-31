import { canonicalColorWord, DIRECTIONS, isHexColor } from '../../dsl/vocabulary';
import {
  classifyRuleAtom, derivedSid, normalizeName, positional, readDeclaration, readRelation, splitOnKeywords, splitTags, STYLE_KEYWORDS, VIEW_KEYWORDS,
} from './structurizrSyntax';
import {
  APPROXIMATE_SHAPES, DROP_STATEMENTS, SHAPE_WORDS, VIEW_BY_WORD,
  type Declaration, type DraftElement, type DraftFlow, type DraftInstance, type DraftRelation, type DraftRule, type DraftView,
  type ElementStyle, type Loss, type RulePart, type StStatement,
} from './structurizrTypes';

export class StructurizrReader {
  protected elements: DraftElement[] = [];
  protected modelElements: DraftElement[] = [];
  protected readonly deployment = new Map<string, DraftElement[]>();
  protected readonly envOrder: string[] = [];
  protected readonly envAliases = new Map<string, string>();
  protected readonly bySid = new Map<string, DraftElement>();
  protected readonly bySidLower = new Map<string, DraftElement>();
  protected readonly byPath = new Map<string, DraftElement>();
  protected readonly byNamePath = new Map<string, DraftElement>();
  protected readonly nameCounts = new Map<string, number>();
  protected readonly relations: DraftRelation[] = [];
  protected readonly instances: DraftInstance[] = [];
  protected readonly views: DraftView[] = [];
  protected readonly flows: DraftFlow[] = [];
  protected readonly styles: ElementStyle[] = [];
  protected readonly losses: Loss[] = [];
  protected readonly definedAt = new Map<string, number>();
  protected name: string | undefined;

  walk(roots: readonly StStatement[]): void {
    for (const statement of roots) {
      const first = statement.tokens[0]?.value ?? '';
      const lower = first.toLowerCase();
      if (lower === 'workspace') {
        const strings = statement.tokens.filter((token) => token.kind === 'string').map((token) => token.value);
        if (strings[0] && !this.name) this.name = normalizeName(strings[0]);
        if (strings[1]) this.loss(statement.line, 'workspace description dropped');
        this.walk(statement.children);
        continue;
      }
      if (lower === 'model') {
        this.walkStatements(statement.children, null, null);
        continue;
      }
      if (lower === 'views') {
        this.readViews(statement.children);
        continue;
      }
      if (lower === 'styles') {
        this.readStyles(statement);
        continue;
      }
      if (first.startsWith('!')) {
        this.readDirective(statement);
        continue;
      }
      this.walkStatements([statement], null, null);
    }
  }

  protected walkStatements(statements: readonly StStatement[], parent: DraftElement | null, env: string | null): void {
    for (const written of statements) {
      // `live = deploymentEnvironment "Live"`: the identifier only names the block; views may use it.
      const assigned = written.tokens[1]?.value === '=' && /^(?:deploymentenvironment|group|deploymentgroup)$/i.test(written.tokens[2]?.value ?? '');
      const statement = assigned ? { ...written, tokens: written.tokens.slice(2) } : written;
      if (assigned && /^deploymentenvironment$/i.test(statement.tokens[0]!.value)) {
        const name = statement.tokens[1]?.kind === 'string' ? statement.tokens[1].value : '';
        if (name) this.envAliases.set(written.tokens[0]!.value.toLowerCase(), normalizeName(name));
      }
      const first = statement.tokens[0]?.value ?? '';
      const lower = first.toLowerCase();
      if (first === '') continue;
      if (first.startsWith('!')) {
        this.readDirective(statement);
        continue;
      }
      if (DROP_STATEMENTS.has(lower)) {
        this.loss(statement.line, `${lower} dropped`);
        continue;
      }
      if (lower === 'properties' || lower === 'perspectives') {
        this.loss(statement.line, `${lower} dropped`);
        continue;
      }
      if (lower === 'styles') {
        this.readStyles(statement);
        continue;
      }
      if (lower === 'deploymentenvironment') {
        this.readEnvironment(statement);
        continue;
      }
      if (lower === 'group' || lower === 'deploymentgroup') {
        const name = statement.tokens.find((token) => token.kind === 'string')?.value ?? statement.tokens[1]?.value ?? '';
        this.loss(statement.line, `${lower === 'group' ? 'group' : 'deploymentGroup'} "${name}" flattened`);
        this.walkStatements(statement.children, parent, env);
        continue;
      }
      if ((lower === 'tags' || lower === 'url') && parent) {
        this.readElementStatement(statement, parent);
        continue;
      }
      const declaration = readDeclaration(statement.tokens);
      if (declaration) {
        if (env) {
          if (declaration.kind === 'instance') {
            const instance = this.declareInstance(declaration, parent, env, statement.line);
            this.walkStatements(statement.children, instance, env);
          } else if (declaration.kind === 'node') {
            const element = this.declareElement(declaration, parent, env, statement.line);
            this.walkStatements(statement.children, element, env);
          } else {
            this.loss(statement.line, `${declaration.kindWord} is not valid in a deployment environment; dropped`);
          }
          continue;
        }
        if (declaration.kind === 'node' || declaration.kind === 'instance') {
          this.loss(statement.line, `${declaration.kindWord} outside a deployment environment dropped`);
          continue;
        }
        const element = this.declareElement(declaration, parent, null, statement.line);
        this.walkStatements(statement.children, element, null);
        continue;
      }
      const relation = readRelation(statement.tokens);
      if (relation) {
        this.relations.push({
          from: relation.from,
          to: relation.to,
          scope: parent,
          env,
          line: statement.line,
          tags: splitTags(relation.strings[2]),
          ...(relation.strings[0] ? { label: relation.strings[0] } : {}),
          ...(relation.strings[1] ? { tech: relation.strings[1] } : {}),
        });
        if (statement.children.length > 0) {
          this.loss(statement.line, `relationship block ${relation.from ?? '->'} -> ${relation.to} flattened`);
        }
        continue;
      }
      this.loss(statement.line, `statement "${first}" dropped`);
    }
  }

  protected readDirective(statement: StStatement): void {
    const keyword = statement.tokens[0]!.value.toLowerCase();
    const value = statement.tokens.slice(1).map((token) => token.value).join(' ');
    if (keyword === '!identifiers') {
      if (value.toLowerCase() === 'flat') this.loss(statement.line, 'identifiers: flat ids rewritten to paths');
      return;
    }
    if (keyword === '!impliedrelationships') {
      if (value.toLowerCase() === 'false') this.loss(statement.line, '!impliedRelationships false: implied relations are always derived');
      return;
    }
    this.loss(statement.line, `${statement.tokens[0]!.value}${value ? ` ${value}` : ''} dropped`);
  }

  protected readEnvironment(statement: StStatement): void {
    const env = normalizeName(statement.tokens[1]?.kind === 'string'
      ? statement.tokens[1]!.value
      : statement.tokens.slice(1).filter((token) => token.kind === 'word').map((token) => token.value).join(' '))
      || 'Deployment';
    this.ensureEnv(env);
    this.walkStatements(statement.children, null, env);
  }

  protected ensureEnv(env: string): void {
    if (this.deployment.has(env)) return;
    this.deployment.set(env, []);
    this.envOrder.push(env);
  }

  protected readElementStatement(statement: StStatement, element: DraftElement): void {
    const first = statement.tokens[0]!.value.toLowerCase();
    if (first === 'tags') {
      for (const token of statement.tokens) if (token.kind === 'string') element.tags.push(...splitTags(token.value));
      return;
    }
    // `url` would map to `[link:]`, but an unquoted `://` survives canonical format as a
    // comment (`//`) and drops the declaration, so the link is reported and dropped.
    const value = statement.tokens.slice(1).map((token) => token.value).join(' ');
    this.loss(statement.line, `url ${value} dropped`);
  }

  protected declareElement(declaration: Declaration, parent: DraftElement | null, env: string | null, line: number): DraftElement {
    const name = normalizeName(declaration.name) || declaration.sid || 'element';
    const element: DraftElement = {
      sid: declaration.sid ?? derivedSid(name),
      explicitSid: declaration.sid !== undefined,
      structurizrKind: declaration.kindWord,
      name,
      kind: declaration.kind,
      parent,
      children: [],
      tags: [],
      ofkId: '',
      ...(env ? { env } : {}),
    };
    if (element.explicitSid) {
      const key = `${env ?? ''}:${this.sidPath(element)}`;
      const first = this.definedAt.get(key);
      if (first !== undefined) this.loss(line, `Identifier \`${element.sid}\` is defined twice (lines ${first}, ${line}); the second wins.`);
      else this.definedAt.set(key, line);
    }
    const values = positional(declaration.strings, declaration.kind);
    if (values.desc) element.desc = values.desc;
    if (values.tech) element.tech = values.tech;
    for (const tag of values.tags) if (!element.tags.includes(tag)) element.tags.push(tag);
    parent?.children.push(element);
    this.elements.push(element);
    if (env) this.deployment.get(env)!.push(element);
    else this.modelElements.push(element);
    return element;
  }

  protected declareInstance(declaration: Declaration, parent: DraftElement | null, env: string, line: number): DraftElement {
    const element: DraftElement = {
      sid: declaration.sid ?? `instance-${this.instances.length + 1}`,
      explicitSid: false,
      structurizrKind: declaration.kindWord,
      name: declaration.name,
      kind: 'instance',
      parent,
      children: [],
      tags: [],
      ofkId: '',
      env,
    };
    parent?.children.push(element);
    this.elements.push(element);
    this.deployment.get(env)!.push(element);
    this.instances.push({ element, ref: declaration.name, scope: parent, line });
    return element;
  }

  protected readStyles(statement: StStatement): void {
    let copied = false;
    for (const child of statement.children) {
      if (child.tokens[0]?.value.toLowerCase() !== 'element') continue;
      const tag = child.tokens.find((token) => token.kind === 'string')?.value ?? child.tokens[1]?.value ?? '';
      if (!tag) continue;
      const style: ElementStyle = { tag };
      for (const property of child.children.flatMap((entry) => splitOnKeywords(entry, STYLE_KEYWORDS))) {
        const key = property.tokens[0]?.value.toLowerCase() ?? '';
        const value = property.tokens.slice(1).map((token) => token.value).join(' ');
        if (key === 'background' && (isHexColor(value) || canonicalColorWord(value))) style.color = value.toLowerCase();
        else if (key === 'shape' && SHAPE_WORDS[value.toLowerCase()]) {
          style.shape = SHAPE_WORDS[value.toLowerCase()];
          if (APPROXIMATE_SHAPES.has(value.toLowerCase())) this.loss(property.line, `styles: shape ${value} drawn as a ${style.shape}`);
        } else if (key === 'icon' && /^[A-Za-z][\w-]*[/:][\w./-]+$/.test(value)) style.icon = value.replace(':', '/');
        // The label colour follows the fill (readable on any background); an authored one has no DSL home.
        else if (key === 'color') this.loss(property.line, `styles: element "${tag}" color (text colour) dropped`);
      }
      if (!style.shape && !style.color && !style.icon) continue;
      this.styles.push(style);
      copied = true;
    }
    this.loss(statement.line, copied
      ? 'styles: colour/shape/icon copied onto tagged elements; other style properties dropped'
      : 'styles block dropped');
  }

  protected readViews(statements: readonly StStatement[]): void {
    for (const statement of statements) {
      const first = statement.tokens[0]?.value ?? '';
      const lower = first.toLowerCase();
      if (first.startsWith('!')) {
        this.readDirective(statement);
        continue;
      }
      if (lower === 'styles') {
        this.readStyles(statement);
        continue;
      }
      if (DROP_STATEMENTS.has(lower) || lower === 'properties' || lower === 'perspectives') {
        this.loss(statement.line, `${lower} dropped`);
        continue;
      }
      if (lower === 'dynamic') {
        this.readDynamic(statement);
        continue;
      }
      const kind = VIEW_BY_WORD[first] ?? VIEW_BY_WORD[lower];
      if (!kind) {
        this.loss(statement.line, `view "${first}" dropped`);
        continue;
      }
      this.readView(statement, kind);
    }
  }

  protected readView(statement: StStatement, kind: DraftView['kind']): void {
    const args = statement.tokens.slice(1);
    const scopeRef = kind === 'landscape' ? undefined : args[0]?.value;
    const envWord = kind === 'deployment' ? args[1]?.value : undefined;
    const env = envWord ? this.envAliases.get(envWord.toLowerCase()) ?? envWord : undefined;
    // `systemLandscape [key] [description]`, `systemContext <scope> [key] [description]`, `deployment <scope> <env> [key] [description]`.
    const keyAt = kind === 'landscape' ? 0 : kind === 'deployment' ? 2 : 1;
    const key = args[keyAt]?.value;
    const description = args[keyAt + 1]?.kind === 'string' ? args[keyAt + 1]!.value : undefined;
    if (description) this.loss(statement.line, `view description "${description}" dropped`);
    const view: DraftView = {
      kind,
      rules: [],
      line: statement.line,
      ...(scopeRef ? { scopeRef } : {}),
      ...(env ? { env } : {}),
      ...(key ? { key } : {}),
    };
    if (kind === 'deployment' && !env) {
      this.loss(statement.line, 'deployment view needs an environment; view dropped');
      return;
    }
    if (kind === 'deployment' && env) this.ensureEnv(env);
    for (const child of statement.children) {
      for (const part of splitOnKeywords(child, VIEW_KEYWORDS)) this.readViewStatement(part, view);
    }
    this.views.push(view);
  }

  protected readViewStatement(statement: StStatement, view: DraftView): void {
    const head = statement.tokens[0]?.value.toLowerCase() ?? '';
    if (head === 'include' || head === 'exclude') {
      view.rules.push(...this.readRule(head, statement));
      return;
    }
    if (head === 'autolayout') {
      // Bare `autoLayout` is Structurizr's default (tb): nothing to report.
      const word = statement.tokens[1]?.value.toLowerCase() ?? 'tb';
      const direction = DIRECTIONS[word];
      if (direction) view.direction = direction;
      else this.loss(statement.line, `autoLayout "${word}" dropped`);
      if (statement.tokens.length > 2) this.loss(statement.line, 'autoLayout separations dropped');
      return;
    }
    if (head === 'title') {
      const title = statement.tokens.find((token) => token.kind === 'string')?.value ?? '';
      this.loss(statement.line, `title "${title}" inside a view dropped`);
      return;
    }
    if (view.kind === 'deployment' && view.env) {
      const declaration = readDeclaration(statement.tokens);
      if (declaration && (declaration.kind === 'node' || declaration.kind === 'instance')) {
        this.walkStatements([statement], null, view.env);
        return;
      }
      if (head === 'group' || head === 'deploymentgroup') {
        this.walkStatements([statement], null, view.env);
        return;
      }
    }
    this.loss(statement.line, `view statement "${head}" dropped`);
  }

  protected readRule(op: 'include' | 'exclude', statement: StStatement): DraftRule[] {
    const raw = statement.tokens.map((token) => token.value).join(' ');
    const body = statement.tokens.slice(1).map((token) => token.value).join(' ')
      .replace(/\s*(==|!=)\s*/g, '$1')
      .replace(/\s*->\s*/g, '->')
      .replace(/\s*&&\s*/g, ' && ')
      .replace(/\s*\|\|\s*/g, ' || ')
      .trim();
    const unsupported = (): DraftRule[] => {
      this.loss(statement.line, `view expression "${body}" has no OFK equivalent; kept verbatim`);
      return [{ op, raw }];
    };
    if (!body) return unsupported();
    const parts: RulePart[] = [];
    const alternatives: RulePart[][] = [];
    for (const alternative of body.split(' || ')) {
      const group: RulePart[] = [];
      for (const atom of alternative.split(' && ')) {
        const classified = classifyRuleAtom(atom);
        if (!classified) return unsupported();
        group.push(...classified);
      }
      if (body.includes('&&')) {
        if (!group.every((part) => part.kind === 'where-kind' || part.kind === 'where-tag')) return unsupported();
        alternatives.push(group);
      } else parts.push(...group);
    }
    if (alternatives.length) parts.push({ kind: 'where-compound', groups: alternatives });
    return [{ op, parts }];
  }

  protected readDynamic(statement: StStatement): void {
    const args = statement.tokens.slice(1);
    const flow: DraftFlow = {
      steps: [],
      line: statement.line,
      ...(args[0] ? { scopeRef: args[0].value } : {}),
      ...(args[1]?.kind === 'string' ? { name: args[1].value } : {}),
    };
    if (args[2]?.kind === 'string') this.loss(statement.line, `dynamic view description "${args[2].value}" dropped`);
    for (const child of statement.children) this.readDynamicStatement(child, flow);
    this.flows.push(flow);
  }

  protected readDynamicStatement(statement: StStatement, flow: DraftFlow): void {
    const head = statement.tokens[0]?.value.toLowerCase() ?? '';
    const tokens = /^\d+\.$/.test(statement.tokens[0]?.value ?? '') ? statement.tokens.slice(1) : statement.tokens;
    const relation = readRelation(tokens);
    if (relation) {
      flow.steps.push({
        from: relation.from,
        to: relation.to,
        line: statement.line,
        tags: splitTags(relation.strings[2]),
        ...(relation.strings[0] ? { label: relation.strings[0] } : {}),
        ...(relation.strings[1] ? { tech: relation.strings[1] } : {}),
      });
      if (statement.children.length > 0) this.loss(statement.line, 'dynamic relationship block flattened');
      return;
    }
    if (statement.children.length > 0) {
      for (const child of statement.children) this.readDynamicStatement(child, flow);
      return;
    }
    this.loss(statement.line, `dynamic view statement "${head}" dropped`);
  }

  protected loss(line: number, message: string): void {
    this.losses.push({ message, line });
  }

  protected sidPath(element: DraftElement): string {
    const segments: string[] = [];
    for (let current: DraftElement | null = element; current; current = current.parent) segments.unshift(current.sid);
    return segments.join('.');
  }

  protected namePath(element: DraftElement): string {
    const segments: string[] = [];
    for (let current: DraftElement | null = element; current; current = current.parent) segments.unshift(current.name);
    return segments.join('.');
  }

  protected displayPath(element: DraftElement): string {
    const segments: string[] = [];
    for (let current: DraftElement | null = element; current; current = current.parent) segments.unshift(current.name);
    return segments.join('.');
  }
}
