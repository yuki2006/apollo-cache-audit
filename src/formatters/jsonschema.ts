/**
 * JSON Schema for the AuditResult shape emitted by the `json` formatter. Downstream tooling
 * (CI dashboards, custom reporters, IDE extensions) can validate audit output against this
 * schema. Hand-maintained to match the AuditResult interface in src/types.ts.
 */
const SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/yuki2006/apollo-cache-audit/schemas/audit-result.schema.json",
  title: "AuditResult",
  description:
    "Output of apollo-cache-audit. Each top-level field is a finding category.",
  type: "object",
  required: [
    "nodeImplemented",
    "apolloCompatibleNotNode",
    "valueObject",
    "customHandled",
    "customButNotNode",
    "nodePromotionCandidate",
    "invalidKeyFields",
    "cacheConfigConflicts",
    "newSinceBaseline",
    "resolvedSinceBaseline",
    "schemaHash",
  ],
  properties: {
    nodeImplemented: { type: "array", items: { type: "string" } },
    apolloCompatibleNotNode: { type: "array", items: { type: "string" } },
    valueObject: {
      type: "array",
      items: { $ref: "#/$defs/ValueObjectInfo" },
    },
    customHandled: {
      type: "array",
      items: { $ref: "#/$defs/CustomCacheInfo" },
    },
    customButNotNode: {
      type: "array",
      items: { $ref: "#/$defs/CustomCacheInfo" },
    },
    nodePromotionCandidate: {
      type: "array",
      items: { $ref: "#/$defs/NodeCandidateInfo" },
    },
    invalidKeyFields: {
      type: "array",
      items: { $ref: "#/$defs/InvalidKeyFieldsInfo" },
    },
    cacheConfigConflicts: {
      type: "array",
      items: { $ref: "#/$defs/CacheConfigConflictInfo" },
    },
    newSinceBaseline: {
      type: "array",
      items: { $ref: "#/$defs/NodeCandidateInfo" },
    },
    resolvedSinceBaseline: { type: "array", items: { type: "string" } },
    schemaHash: {
      type: "string",
      pattern: "^[0-9a-f]{64}$",
      description: "SHA-256 of the schema SDL at audit time.",
    },
  },
  $defs: {
    ValueObjectInfo: {
      type: "object",
      required: ["name", "reason"],
      properties: {
        name: { type: "string" },
        reason: {
          type: "string",
          enum: ["suffix-match", "not-referenced-from-node", "no-fields"],
        },
      },
    },
    CustomCacheInfo: {
      type: "object",
      required: ["name", "via"],
      properties: {
        name: { type: "string" },
        via: {
          type: "string",
          enum: ["dataIdFromObject", "typePolicies.keyFields"],
        },
        keyFields: {
          oneOf: [
            { type: "array", items: { type: "string" } },
            { type: "string", const: "fn" },
          ],
        },
      },
    },
    ReferenceEdgeInfo: {
      type: "object",
      required: ["parent", "kind"],
      properties: {
        parent: { type: "string" },
        kind: { type: "string", enum: ["direct", "interface", "union"] },
        abstractType: { type: "string" },
      },
    },
    NodeCandidateInfo: {
      type: "object",
      required: ["name", "referencedFrom", "referencedEdges"],
      properties: {
        name: { type: "string" },
        referencedFrom: { type: "array", items: { type: "string" } },
        referencedEdges: {
          type: "array",
          items: { $ref: "#/$defs/ReferenceEdgeInfo" },
        },
        referencedFromChain: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
        },
        line: { type: "integer", minimum: 1 },
        file: { type: "string" },
        recommendation: { $ref: "#/$defs/RecommendationInfo" },
      },
    },
    RecommendationSignal: {
      type: "object",
      required: ["name", "weight", "votes"],
      properties: {
        name: { type: "string" },
        weight: { type: "integer", minimum: 0 },
        votes: {
          type: "string",
          enum: ["add-id", "mark-as-value-object", "add-suffix-rule"],
        },
      },
    },
    RecommendationInfo: {
      type: "object",
      required: ["primary", "confidence", "signals", "reason"],
      properties: {
        primary: {
          type: "string",
          enum: ["add-id", "mark-as-value-object", "add-suffix-rule"],
        },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
        signals: {
          type: "array",
          items: { $ref: "#/$defs/RecommendationSignal" },
        },
        reason: { type: "string" },
      },
    },
    InvalidKeyFieldsInfo: {
      type: "object",
      required: ["type", "missingFields"],
      properties: {
        type: { type: "string" },
        missingFields: { type: "array", items: { type: "string" } },
      },
    },
    CacheConfigConflictInfo: {
      type: "object",
      required: ["type", "keyFields", "sources"],
      properties: {
        type: { type: "string" },
        keyFields: {
          type: "array",
          items: {
            oneOf: [
              { type: "array", items: { type: "string" } },
              { type: "string", const: "fn" },
              { type: "boolean", const: false },
            ],
          },
        },
        sources: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const;

export function formatJsonSchema(): string {
  return JSON.stringify(SCHEMA, null, 2) + "\n";
}
