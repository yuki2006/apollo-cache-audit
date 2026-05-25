import {
  type GraphQLObjectType,
  getNamedType,
  isScalarType,
  isEnumType,
  isObjectType,
  isInterfaceType,
} from "graphql";
import type {
  Confidence,
  Recommendation,
  RecommendationInfo,
  RecommendationSignal,
} from "../types.js";

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

const TIMESTAMP_FIELD_NAMES = new Set([
  "createdAt",
  "updatedAt",
  "deletedAt",
  "publishedAt",
  "archivedAt",
]);

/** Field names that strongly suggest a value-object shape. */
const VALUE_OBJECT_FIELD_NAMES = new Set([
  "amount",
  "currency",
  "unit",
  "lat",
  "lng",
  "latitude",
  "longitude",
  "from",
  "to",
  "min",
  "max",
  "width",
  "height",
  "ratio",
  "scale",
]);

/**
 * Type-name suffixes that, if seen on a candidate, suggest the user may want to add the suffix
 * to --ignore-suffixes globally rather than fix this one type.
 */
const STRUCTURAL_LOOKING_SUFFIXES = [
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
];

export interface RecommendInput {
  type: GraphQLObjectType;
  /** Names of parent types that reference this candidate as a field. */
  referencedFrom: string[];
  /** Suffixes already in the user's ignore list — used to avoid suggesting duplicates. */
  activeIgnoreSuffixes: string[];
  /** Names of sibling candidate types in the same audit run (for suffix grouping). */
  allCandidateNames?: string[];
}

interface ScoreState {
  signals: RecommendationSignal[];
  totals: Record<Recommendation, number>;
}

/**
 * Produce a heuristic recommendation for a node-promotion candidate. Multiple weighted signals
 * vote across the three categories; the winner is returned with the supporting signal list and
 * a confidence rating based on the margin.
 *
 * The output is advisory: schema authors retain final say. The reason text exposes the signals
 * so a reader can judge whether the recommendation matches their intent.
 */
export function recommend(input: RecommendInput): RecommendationInfo {
  const state: ScoreState = {
    signals: [],
    totals: { "add-id": 0, "mark-as-value-object": 0, "add-suffix-rule": 0 },
  };

  collectSignals(state, input);

  const sorted = (Object.entries(state.totals) as Array<[Recommendation, number]>).sort(
    (a, b) => b[1] - a[1],
  );
  const top = sorted[0]!;
  const second = sorted[1]!;
  const primary = top[1] > 0 ? top[0] : "add-id";
  const margin = top[1] - second[1];
  const confidence = computeConfidence(top[1], margin);

  state.signals.sort((a, b) => b.weight - a.weight);
  const reason = buildReason(primary, state.signals, input);

  return { primary, confidence, signals: state.signals, reason };
}

function addSignal(
  state: ScoreState,
  name: string,
  weight: number,
  votes: Recommendation,
) {
  state.signals.push({ name, weight, votes });
  state.totals[votes] += weight;
}

function collectSignals(state: ScoreState, input: RecommendInput) {
  const { type, referencedFrom, activeIgnoreSuffixes, allCandidateNames } = input;
  const fields = type.getFields();
  const fieldNames = Object.keys(fields);

  // ---- ENTITY-LEANING SIGNALS (vote add-id) ----

  const idLikeMatches = fieldNames.filter((n) => ID_LIKE_FIELD_NAMES.has(n));
  if (idLikeMatches.length > 0) {
    addSignal(state, `id-like-field:${idLikeMatches.join(",")}`, 8, "add-id");
  }

  const timestampMatches = fieldNames.filter((n) => TIMESTAMP_FIELD_NAMES.has(n));
  if (timestampMatches.length > 0) {
    addSignal(state, `timestamp-field:${timestampMatches.join(",")}`, 5, "add-id");
  }

  const foreignKeyMatches = fieldNames.filter((n) => /^[a-z][a-zA-Z0-9]*Id$/.test(n));
  if (foreignKeyMatches.length > 0) {
    addSignal(state, `foreign-key-field:${foreignKeyMatches.join(",")}`, 4, "add-id");
  }

  if (referencedFrom.length >= 2) {
    addSignal(state, `parents-count:${referencedFrom.length}`, 3, "add-id");
  }

  const hasNameOrTitle = fieldNames.some((n) =>
    ["name", "title", "label", "displayName"].includes(n),
  );
  if (hasNameOrTitle && fieldNames.length >= 4) {
    addSignal(state, "has-name-and-multiple-fields", 2, "add-id");
  }

  const nonNodeInterfaces = type
    .getInterfaces()
    .filter((i) => i.name !== "Node");
  if (nonNodeInterfaces.length > 0) {
    addSignal(
      state,
      `implements-interfaces:${nonNodeInterfaces.map((i) => i.name).join(",")}`,
      3,
      "add-id",
    );
  }

  // ---- VALUE-OBJECT-LEANING SIGNALS (vote mark-as-value-object) ----

  const valueObjectNameMatches = fieldNames.filter((n) =>
    VALUE_OBJECT_FIELD_NAMES.has(n),
  );
  if (valueObjectNameMatches.length > 0) {
    addSignal(
      state,
      `value-object-field-name:${valueObjectNameMatches.join(",")}`,
      5,
      "mark-as-value-object",
    );
  }

  const allFieldsLeaf = fieldNames.every((n) => {
    const f = fields[n];
    if (!f) return false;
    const named = getNamedType(f.type);
    return isScalarType(named) || isEnumType(named);
  });
  if (allFieldsLeaf && fieldNames.length <= 4 && referencedFrom.length === 1) {
    addSignal(state, "small-flat-shape", 4, "mark-as-value-object");
  }

  const hasNestedObject = fieldNames.some((n) => {
    const f = fields[n];
    if (!f) return false;
    const named = getNamedType(f.type);
    return isObjectType(named) || isInterfaceType(named);
  });
  if (!hasNestedObject && idLikeMatches.length === 0 && fieldNames.length <= 3) {
    addSignal(state, "leaf-only-tiny", 2, "mark-as-value-object");
  }

  // ---- SUFFIX-RULE SIGNALS (vote add-suffix-rule) ----

  const matchingSuffix = STRUCTURAL_LOOKING_SUFFIXES.find(
    (s) => type.name.endsWith(s) && !activeIgnoreSuffixes.includes(s),
  );
  if (matchingSuffix) {
    // Suffix-based suggestions are a global fix (one --ignore-suffixes entry can cover many
    // sibling types), so we weight them above per-type value-object detection (4+2=6 max).
    addSignal(state, `structural-suffix:${matchingSuffix}`, 7, "add-suffix-rule");

    if (allCandidateNames) {
      const siblings = allCandidateNames.filter(
        (n) => n !== type.name && n.endsWith(matchingSuffix),
      );
      if (siblings.length >= 2) {
        addSignal(
          state,
          `suffix-shared-with:${siblings.length}-siblings`,
          4,
          "add-suffix-rule",
        );
      }
    }
  }
}

function computeConfidence(topScore: number, margin: number): Confidence {
  if (topScore === 0) return "low";
  if (margin >= 4 && topScore >= 5) return "high";
  if (margin >= 2) return "medium";
  return "low";
}

function buildReason(
  primary: Recommendation,
  signals: RecommendationSignal[],
  input: RecommendInput,
): string {
  const positiveSignals = signals
    .filter((s) => s.votes === primary)
    .slice(0, 3)
    .map((s) => s.name);

  if (positiveSignals.length === 0) {
    return primary === "add-id"
      ? `No strong signal either way. Defaulting to add-id since "${input.type.name}" is reachable from a normalized parent and the heuristic cannot rule it in as a value object.`
      : `No strong signal either way. Defaulting to ${primary} by elimination.`;
  }

  switch (primary) {
    case "add-id":
      return `Entity-leaning signals: ${positiveSignals.join(", ")}. Consider adding \`id: ID!\` and \`implements Node\`, or use \`typePolicies.${input.type.name}.keyFields\` if the type already has a unique field.`;
    case "mark-as-value-object":
      return `Value-object signals: ${positiveSignals.join(", ")}. If "${input.type.name}" genuinely has no identity, add to --ignore-types or use \`typePolicies.${input.type.name}.keyFields = false\` to suppress normalization explicitly.`;
    case "add-suffix-rule":
      return `Structural-type signals: ${positiveSignals.join(", ")}. Adding the suffix to --ignore-suffixes globally is usually cleaner than per-type handling.`;
  }
}
