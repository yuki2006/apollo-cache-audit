export interface AuditOptions {
  /** Path to .graphql SDL, raw SDL string, or pre-built GraphQLSchema. */
  schema: string;
  /** Path to .ts/.js file containing `new InMemoryCache({...})`. */
  cacheConfig: string;
  /** tsconfig.json path for cross-file resolution. Auto-detected if omitted. */
  tsConfigPath?: string;
  /** Interface name used to mark entities. Default: "Node". */
  nodeInterface?: string;
  /** Type-name suffixes treated as value objects. */
  ignoreSuffixes?: string[];
  /** Type names excluded from audit entirely. */
  ignoreTypes?: string[];
  /** Path to baseline JSON, or pre-loaded baseline data. */
  baseline?: string | BaselineData;
}

export interface ValueObjectInfo {
  name: string;
  reason: "suffix-match" | "not-referenced-from-node" | "no-fields";
}

export interface CustomCacheInfo {
  name: string;
  via: "dataIdFromObject" | "typePolicies.keyFields";
  keyFields?: readonly string[] | "fn";
}

export type Recommendation =
  | "add-id"
  | "mark-as-value-object"
  | "add-suffix-rule";

export interface RecommendationInfo {
  primary: Recommendation;
  reason: string;
}

export interface NodeCandidateInfo {
  name: string;
  /** Parent Node-implementing types that reference this type as a field. */
  referencedFrom: string[];
  /** Source SDL location (1-indexed line) when available. */
  line?: number;
  /** Source SDL file path when known. */
  file?: string;
  /** Heuristic-based suggestion for how to resolve this finding. */
  recommendation?: RecommendationInfo;
}

export interface InvalidKeyFieldsInfo {
  /** Type name whose typePolicy.keyFields references a non-existent field. */
  type: string;
  /** keyField names not declared on the schema type. */
  missingFields: string[];
}

export interface AuditResult {
  /** Object types that implement the Node interface AND normalize via default id. */
  nodeImplemented: string[];
  /**
   * Object types that Apollo normalizes via default id/_id but do NOT implement the Node interface.
   * Apollo cache works fine, but the schema is Relay-non-compliant. Informational by default;
   * gate strict Relay adoption via --fail-on-not-node.
   */
  apolloCompatibleNotNode: string[];
  valueObject: ValueObjectInfo[];
  customHandled: CustomCacheInfo[];
  customButNotNode: CustomCacheInfo[];
  nodePromotionCandidate: NodeCandidateInfo[];
  /**
   * typePolicies.keyFields configurations that reference fields not declared on the schema type.
   * These cause runtime InvariantError from Apollo on identify() — high-confidence misconfiguration.
   */
  invalidKeyFields: InvalidKeyFieldsInfo[];
  /** Populated only when a baseline is provided. */
  newSinceBaseline: NodeCandidateInfo[];
  /** Candidates present in baseline but no longer detected. */
  resolvedSinceBaseline: string[];
  /** SHA-256 of the schema SDL at audit time. */
  schemaHash: string;
}

export interface BaselineEntry {
  type: string;
  referencedFrom: string[];
  /** ISO-8601 timestamp of first inclusion. */
  addedAt: string;
}

export interface BaselineData {
  /** Free-text version of the tool that wrote the baseline. */
  tool: string;
  /** ISO-8601 timestamp of last write. */
  generated: string;
  /** SHA-256 of the schema SDL when the baseline was written. */
  schemaHash: string;
  nodePromotionCandidate: BaselineEntry[];
  customButNotNode: BaselineEntry[];
}

export type OutputFormat = "text" | "json" | "github";

export type FailOn = "none" | "new" | "suspect" | "all";

export interface CliOptions {
  schema: string;
  cacheConfig: string;
  tsConfig?: string;
  nodeInterface?: string;
  ignoreSuffixes?: string;
  ignoreTypes?: string;
  baseline?: string;
  updateBaseline?: boolean;
  format?: OutputFormat;
  failOn?: FailOn;
  failOnCustomWithoutNode?: boolean;
  failOnInvalidKeyfields?: boolean;
  failOnNotNode?: boolean;
  report?: string;
  verbose?: boolean;
}
