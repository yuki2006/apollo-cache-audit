import {
  type GraphQLObjectType,
  getNamedType,
  isScalarType,
  isEnumType,
} from "graphql";
import type { NodeCandidateInfo, RecommendationInfo } from "../types.js";

/**
 * Field name patterns that strongly indicate an identity-bearing field. If such a field exists,
 * promoting the type to Node is a low-cost edit (often just add `implements Node` and rename the
 * existing field to `id` if it isn't already).
 */
const ID_LIKE_FIELD_NAMES = new Set([
  "id",
  "_id",
  "uuid",
  "guid",
  "slug",
  "key",
  "code",
  "handle",
]);

/**
 * Type-name suffixes that, if seen on a candidate, suggest the user may want to add the suffix
 * to --ignore-suffixes globally rather than fix this one type. We only suggest this for suffixes
 * not already in the project's default ignore list.
 */
const STRUCTURAL_LOOKING_SUFFIXES = new Set([
  "State",
  "Info",
  "Meta",
  "Metadata",
  "Detail",
  "Details",
  "Stats",
  "Snapshot",
  "Summary",
  "Status",
]);

export interface RecommendInput {
  type: GraphQLObjectType;
  /** Names of parent types that reference this candidate as a field. */
  referencedFrom: string[];
  /** Suffixes already in the user's ignore list — used to avoid suggesting duplicates. */
  activeIgnoreSuffixes: string[];
}

/**
 * Produce a single best-guess recommendation for a node-promotion candidate. The output is
 * advisory: the schema author still owns the decision. Reasoning is included so the user can
 * judge whether the heuristic applies.
 */
export function recommend(input: RecommendInput): RecommendationInfo {
  const { type, referencedFrom, activeIgnoreSuffixes } = input;
  const fields = type.getFields();
  const fieldNames = Object.keys(fields);

  const idLikeMatches = fieldNames.filter((n) => ID_LIKE_FIELD_NAMES.has(n));
  const scalarLikeFieldCount = countScalarLikeFields(type);
  const parentCount = referencedFrom.length;

  const matchingSuffix = [...STRUCTURAL_LOOKING_SUFFIXES].find(
    (s) => type.name.endsWith(s) && !activeIgnoreSuffixes.includes(s),
  );

  // 1. Strongest signal: an id-like field already exists on the type.
  //    Recommending Node promotion is essentially free.
  if (idLikeMatches.length > 0) {
    const fieldList = idLikeMatches.map((n) => `\`${n}\``).join(", ");
    return {
      primary: "add-id",
      reason: `Type already has identity-bearing field(s): ${fieldList}. Promote to Node, or add typePolicies.${type.name}.keyFields to declare the existing field as the cache key.`,
    };
  }

  // 2. Type name matches a structural suffix not in the user's current allowlist.
  //    Suggest extending --ignore-suffixes — usually a global fix is preferred over per-type
  //    handling, since multiple sibling types likely share the same suffix.
  if (matchingSuffix) {
    return {
      primary: "add-suffix-rule",
      reason: `Type name ends with "${matchingSuffix}" which typically marks a structural value object. Add "${matchingSuffix}" to --ignore-suffixes to globally suppress this and similar types.`,
    };
  }

  // 3. Few fields, all scalar, referenced from a single parent — likely a genuine value object
  //    (e.g., Money { amount, currency }, GeoPoint { lat, lng }).
  if (scalarLikeFieldCount <= 3 && parentCount <= 1 && fieldNames.length === scalarLikeFieldCount) {
    return {
      primary: "mark-as-value-object",
      reason: `Small flat shape (${scalarLikeFieldCount} scalar field(s), referenced from ${parentCount} parent). Consider adding "${type.name}" to --ignore-types if it genuinely never needs identity.`,
    };
  }

  // 4. Multiple parents OR many fields — high chance this is a real entity that simply
  //    forgot its id. Recommend adding id.
  if (parentCount >= 2 || fieldNames.length > 5) {
    return {
      primary: "add-id",
      reason: `Referenced from ${parentCount} parent type(s) with ${fieldNames.length} field(s). High likelihood this is a real entity. Add \`id: ID!\` (and \`implements Node\`) to the schema.`,
    };
  }

  // Default: lean toward add-id, since the type is reachable from a normalized parent
  // and doesn't match value-object heuristics.
  return {
    primary: "add-id",
    reason: `Reachable from a normalized parent; no field clearly identifies it. Add an id field, or if "${type.name}" is intentionally a value object, add it to --ignore-types.`,
  };
}

function countScalarLikeFields(type: GraphQLObjectType): number {
  let n = 0;
  const fields = type.getFields();
  for (const fname of Object.keys(fields)) {
    const f = fields[fname];
    if (!f) continue;
    const named = getNamedType(f.type);
    if (isScalarType(named) || isEnumType(named)) n++;
  }
  return n;
}
