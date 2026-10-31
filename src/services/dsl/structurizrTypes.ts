import type { DslDiagnostic, DslDirection } from '../../dsl/ast';
import type { ElementKind } from '../../dsl/model/types';

// Structurizr DSL → OFK text (grammar §11.2). Structurizr files are line-oriented
// with `{}` blocks; every construct the DSL cannot express is reported as a W180
// `source: 'import'` diagnostic and never throws (mermaidToDsl conventions).

export interface StructurizrConversion {
  dsl: string;
  /** One line per construct the DSL cannot express. */
  losses: string[];
  diagnostics: DslDiagnostic[];
}

export interface StructurizrConversionError {
  error: string;
}

export interface StToken {
  readonly kind: 'word' | 'string';
  readonly value: string;
  readonly line: number;
}

export interface StStatement {
  readonly tokens: readonly StToken[];
  readonly children: StStatement[];
  readonly line: number;
}

export const THEME_TAG = /^(amazon web services|microsoft azure|google cloud platform) - (.+)$/i;
export const THEME_PROVIDER: Readonly<Record<string, string>> = { 'amazon web services': 'aws', 'microsoft azure': 'azure', 'google cloud platform': 'gcp' };

/** Structurizr keywords that do not exist in OFK; used by the detector. */
export const STRUCTURIZR_KEYWORDS = /\b(?:person|softwareSystem|container|component|deploymentEnvironment|containerInstance|infrastructureNode|systemLandscape|systemContext)\b|\bdynamic\s|!identifiers|!include|!impliedRelationships/;
export const OFK_FAMILY_HEADER = /^\s*(architecture|flowchart|sequence|state|erd|class|mindmap|gitgraph)\b/m;

export const KIND_BY_WORD: Readonly<Record<string, ElementKind>> = {
  person: 'person',
  softwaresystem: 'system',
  container: 'container',
  component: 'component',
  deploymentnode: 'node',
  infrastructurenode: 'node',
  containerinstance: 'instance',
  softwaresysteminstance: 'instance',
};

export const VIEW_BY_WORD: Readonly<Record<string, DraftView['kind']>> = {
  systemlandscape: 'landscape',
  systemcontext: 'context',
  container: 'container',
  component: 'component',
  deployment: 'deployment',
};

export const STRUCTURIZR_TYPES: Readonly<Record<string, string>> = {
  person: 'person',
  softwaresystem: 'system',
  container: 'container',
  component: 'component',
  deploymentnode: 'node',
  infrastructurenode: 'node',
  containerinstance: 'instance',
  softwaresysteminstance: 'instance',
};

/** Structurizr default tags, which `styles` may target even though we never emit them. */
export const DEFAULT_TAGS: Readonly<Record<string, string>> = {
  person: 'Person',
  softwaresystem: 'Software System',
  container: 'Container',
  component: 'Component',
  deploymentnode: 'Deployment Node',
  infrastructurenode: 'Infrastructure Node',
  containerinstance: 'Container Instance',
  softwaresysteminstance: 'Software System Instance',
};

/** Structurizr shape names → OFK shape vocabulary (grammar §5.1). */
export const SHAPE_WORDS: Readonly<Record<string, string>> = {
  box: 'rect',
  roundedbox: 'rounded',
  circle: 'circle',
  ellipse: 'ellipse',
  cylinder: 'cylinder',
  pipe: 'cylinder',
  bucket: 'cylinder',
  database: 'cylinder',
  folder: 'doc',
  person: 'person',
  webbrowser: 'browser',
  mobiledevicebrowser: 'mobile',
  mobiledeviceportrait: 'mobile',
  mobiledevicelandscape: 'mobile',
  component: 'component',
  cloud: 'cloud',
  hexagon: 'hexagon',
};

/** Structurizr shapes OFK draws as something close but not the same; each is reported. */
export const APPROXIMATE_SHAPES = new Set(['pipe', 'bucket', 'folder', 'mobiledevicelandscape']);

/**
 * Structurizr's conventional tags that name an OFK kind (`External` system → `external`,
 * `Database` container → `store`). Only leaves change: these kinds hold no children.
 */
export const KIND_BY_TAG: Readonly<Record<string, Readonly<Record<string, ElementKind>>>> = {
  system: { external: 'external' },
  container: { database: 'store', queue: 'queue' },
};

export const DROP_STATEMENTS = new Set(['theme', 'themes', 'branding', 'terminology', 'configuration']);

export interface DraftElement {
  sid: string;
  explicitSid: boolean;
  structurizrKind: string;
  name: string;
  kind: ElementKind;
  parent: DraftElement | null;
  children: DraftElement[];
  desc?: string;
  tech?: string;
  tags: string[];
  shape?: string;
  color?: string;
  icon?: string;
  env?: string;
  ofkId: string;
  dropped?: boolean;
  /** A deployment instance's model element; its reference is written once ids exist. */
  instanceOf?: DraftElement;
}

export interface DraftRelation {
  readonly from: string | null;
  readonly to: string;
  readonly scope: DraftElement | null;
  readonly label?: string;
  readonly tech?: string;
  readonly tags: readonly string[];
  readonly env: string | null;
  readonly line: number;
}

export interface ResolvedRelation {
  readonly from: DraftElement;
  readonly to: DraftElement;
  readonly label?: string;
  readonly tech?: string;
  readonly tags: readonly string[];
  readonly env: string | null;
}

export interface DraftInstance {
  readonly element: DraftElement;
  readonly ref: string;
  readonly scope: DraftElement | null;
  readonly line: number;
}

export type RulePart =
  | { readonly kind: 'all' }
  | { readonly kind: 'ref'; readonly ref: string }
  | { readonly kind: 'successors'; readonly ref: string }
  | { readonly kind: 'predecessors'; readonly ref: string }
  | { readonly kind: 'pair'; readonly from: string; readonly to: string }
  | { readonly kind: 'where-kind'; readonly value: string }
  | { readonly kind: 'where-tag'; readonly value: string }
  /** `a && b || c`: OR of AND groups, written once the kinds are final. */
  | { readonly kind: 'where-compound'; readonly groups: readonly (readonly RulePart[])[] };

export interface DraftRule {
  readonly op: 'include' | 'exclude';
  readonly parts?: readonly RulePart[];
  /** Source line kept verbatim when the expression has no OFK equivalent. */
  readonly raw?: string;
}

export interface DraftView {
  readonly kind: 'landscape' | 'context' | 'container' | 'component' | 'deployment';
  readonly scopeRef?: string;
  scope?: DraftElement;
  readonly env?: string;
  readonly key?: string;
  direction?: DslDirection;
  readonly rules: DraftRule[];
  readonly line: number;
  dropped?: boolean;
}

export interface DraftStep {
  readonly from: string | null;
  readonly to: string;
  readonly label?: string;
  readonly tech?: string;
  readonly tags: readonly string[];
  readonly line: number;
}

export interface DraftFlow {
  readonly name?: string;
  scopeRef?: string;
  scope?: DraftElement;
  readonly steps: DraftStep[];
  readonly line: number;
}

export interface ElementStyle {
  readonly tag: string;
  shape?: string;
  color?: string;
  icon?: string;
}

export interface Loss {
  readonly message: string;
  readonly line: number;
}

export interface Declaration {
  readonly sid?: string;
  readonly kind: ElementKind;
  readonly kindWord: string;
  readonly name: string;
  readonly strings: readonly string[];
}
