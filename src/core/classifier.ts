import type {
  CustomCacheInfo,
  InvalidKeyFieldsInfo,
  NodeCandidateInfo,
  ReferenceEdgeInfo,
  ValueObjectInfo,
} from "../types.js";
import type { ReferenceEdge, SchemaModel } from "./schema.js";
import type { CacheConfigModel } from "./cacheConfig.js";
import type { ProbeResult } from "./apolloProbe.js";
import { recommend } from "./recommend.js";

export const DEFAULT_IGNORE_SUFFIXES = [
  "Response",
  "Result",
  "Payload",
  "Edge",
  "Connection",
  "PageInfo",
  "Aggregation",
  "Csv",
  "Report",
];

export interface ClassifyInput {
  schemaModel: SchemaModel;
  cacheConfig: CacheConfigModel;
  probe: ProbeResult;
  ignoreSuffixes: string[];
  ignoreTypes: Set<string>;
  /** Walk transitively through non-normalized intermediates when computing reachability. */
  multiHop?: boolean;
}

export interface Classification {
  nodeImplemented: string[];
  apolloCompatibleNotNode: string[];
  valueObject: ValueObjectInfo[];
  customHandled: CustomCacheInfo[];
  customButNotNode: CustomCacheInfo[];
  nodePromotionCandidate: NodeCandidateInfo[];
  invalidKeyFields: InvalidKeyFieldsInfo[];
}

export function classify(input: ClassifyInput): Classification {
  const { schemaModel, cacheConfig, probe, ignoreSuffixes, ignoreTypes, multiHop } =
    input;

  const suffixRegex = buildSuffixRegex(ignoreSuffixes);
  const customByName = new Map<string, CustomCacheInfo>();
  for (const c of cacheConfig.customHandled) customByName.set(c.name, c);

  const isNormalized = (name: string) => {
    const po = probe.outcomes.get(name);
    return Boolean(po?.normalizes);
  };

  const nodeImplemented: string[] = [];
  const apolloCompatibleNotNode: string[] = [];
  const valueObject: ValueObjectInfo[] = [];
  const customHandled: CustomCacheInfo[] = [];
  const customButNotNode: CustomCacheInfo[] = [];
  const nodePromotionCandidate: NodeCandidateInfo[] = [];
  const invalidKeyFields: InvalidKeyFieldsInfo[] = [...probe.invalidKeyFields];

  for (const t of schemaModel.objectTypes) {
    if (ignoreTypes.has(t.name)) continue;

    const outcome = probe.outcomes.get(t.name);
    if (outcome?.reason === "invalid-keyfields") continue;

    const isNode = schemaModel.nodeImplementorNames.has(t.name);
    const custom = customByName.get(t.name);

    // Explicit opt-out: typePolicies[T].keyFields = false. The user has declared this type
    // should NOT be normalized. Surface in customHandled so the audit doesn't flag it as a
    // promotion candidate (the user has already made the decision).
    if (
      custom &&
      custom.via === "typePolicies.keyFields" &&
      custom.keyFields === false
    ) {
      customHandled.push(custom);
      continue;
    }

    if (outcome?.normalizes) {
      if (custom) {
        if (isNode) customHandled.push(custom);
        else customButNotNode.push(custom);
      } else if (isNode) {
        nodeImplemented.push(t.name);
      } else {
        apolloCompatibleNotNode.push(t.name);
      }
      continue;
    }

    const fields = t.getFields();
    if (Object.keys(fields).length === 0) {
      valueObject.push({ name: t.name, reason: "no-fields" });
      continue;
    }

    if (suffixRegex && suffixRegex.test(t.name)) {
      valueObject.push({ name: t.name, reason: "suffix-match" });
      continue;
    }

    const edges = schemaModel.referencedBy.get(t.name) ?? [];
    const directNormalizedEdges = edges.filter((e) => isNormalized(e.parent));

    let candidateEdges: ReferenceEdge[] = directNormalizedEdges;
    let chains: string[][] | undefined;

    if (candidateEdges.length === 0 && multiHop) {
      chains = findIndirectChains(t.name, schemaModel.referencedBy, isNormalized);
      if (chains.length === 0) {
        valueObject.push({ name: t.name, reason: "not-referenced-from-node" });
        continue;
      }
      // Multi-hop: synthesize edges from the last hop of each chain (parent before the
      // normalized ancestor) so referencedFrom still resolves to a useful set.
      const lastHops = new Map<string, ReferenceEdge>();
      for (const chain of chains) {
        // chain is [Candidate, Intermediate..., NormalizedAncestor]; last hop is the parent
        // that bridges to the normalized ancestor.
        const ancestor = chain[chain.length - 1]!;
        const parent = chain[chain.length - 2]!;
        if (!lastHops.has(ancestor)) {
          lastHops.set(ancestor, { parent: ancestor, kind: "direct" });
        }
        // Also include the intermediate parent that referenced this candidate directly.
        if (chain.length >= 2) {
          const directParent = chain[1]!;
          if (!lastHops.has(directParent)) {
            lastHops.set(directParent, { parent: directParent, kind: "direct" });
          }
        }
      }
      candidateEdges = [...lastHops.values()];
    } else if (candidateEdges.length === 0) {
      valueObject.push({ name: t.name, reason: "not-referenced-from-node" });
      continue;
    }

    const referencedFrom = [...new Set(candidateEdges.map((e) => e.parent))].sort();
    const referencedEdges: ReferenceEdgeInfo[] = candidateEdges
      .map((e) => ({ parent: e.parent, kind: e.kind, abstractType: e.abstractType }))
      .sort(compareEdge);

    nodePromotionCandidate.push({
      name: t.name,
      referencedFrom,
      referencedEdges,
      referencedFromChain: chains,
      line: schemaModel.lineByType.get(t.name),
      file: schemaModel.schemaFilePath,
    });
  }

  nodeImplemented.sort();
  apolloCompatibleNotNode.sort();
  valueObject.sort((a, b) => a.name.localeCompare(b.name));
  customHandled.sort((a, b) => a.name.localeCompare(b.name));
  customButNotNode.sort((a, b) => a.name.localeCompare(b.name));
  nodePromotionCandidate.sort((a, b) => a.name.localeCompare(b.name));
  invalidKeyFields.sort((a, b) => a.type.localeCompare(b.type));

  const allCandidateNames = nodePromotionCandidate.map((c) => c.name);
  for (const c of nodePromotionCandidate) {
    const objType = schemaModel.schema.getType(c.name);
    if (!objType || !("getFields" in objType)) continue;
    c.recommendation = recommend({
      type: objType as import("graphql").GraphQLObjectType,
      referencedFrom: c.referencedFrom,
      activeIgnoreSuffixes: ignoreSuffixes,
      allCandidateNames,
    });
  }

  return {
    nodeImplemented,
    apolloCompatibleNotNode,
    valueObject,
    customHandled,
    customButNotNode,
    nodePromotionCandidate,
    invalidKeyFields,
  };
}

/**
 * BFS from a candidate through non-normalized intermediate parents until a normalized
 * ancestor is found. Returns all such paths up to a depth limit. Each path is
 * [Candidate, ParentHop1, ..., NormalizedAncestor].
 */
function findIndirectChains(
  start: string,
  referencedBy: Map<string, ReferenceEdge[]>,
  isNormalized: (name: string) => boolean,
  maxDepth = 4,
): string[][] {
  const chains: string[][] = [];
  type Frame = { node: string; path: string[] };
  const queue: Frame[] = [{ node: start, path: [start] }];
  const visited = new Set<string>([start]);

  while (queue.length > 0) {
    const { node, path } = queue.shift()!;
    if (path.length > maxDepth + 1) continue;
    const edges = referencedBy.get(node) ?? [];
    for (const e of edges) {
      if (path.includes(e.parent)) continue; // cycle guard
      const nextPath = [...path, e.parent];
      if (isNormalized(e.parent)) {
        chains.push(nextPath);
        continue;
      }
      // Don't traverse THROUGH a normalized ancestor — only continue through non-normalized
      // intermediates. Also limit revisits.
      if (visited.has(e.parent)) continue;
      visited.add(e.parent);
      queue.push({ node: e.parent, path: nextPath });
    }
  }

  return chains;
}

function compareEdge(a: ReferenceEdgeInfo, b: ReferenceEdgeInfo): number {
  return (
    a.parent.localeCompare(b.parent) ||
    a.kind.localeCompare(b.kind) ||
    (a.abstractType ?? "").localeCompare(b.abstractType ?? "")
  );
}

function buildSuffixRegex(suffixes: string[]): RegExp | undefined {
  const trimmed = suffixes.map((s) => s.trim()).filter(Boolean);
  if (trimmed.length === 0) return undefined;
  const escaped = trimmed.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(${escaped.join("|")})$`);
}
