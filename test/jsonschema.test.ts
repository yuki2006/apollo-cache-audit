import { test } from "node:test";
import assert from "node:assert/strict";
import { formatJsonSchema } from "../src/formatters/jsonschema.ts";

test("jsonschema: emits draft 2020-12 schema with expected required fields", () => {
  const out = formatJsonSchema();
  const parsed = JSON.parse(out);
  assert.equal(parsed.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(parsed.title, "AuditResult");
  assert.ok(parsed.required.includes("nodePromotionCandidate"));
  assert.ok(parsed.required.includes("apolloCompatibleNotNode"));
  assert.ok(parsed.required.includes("cacheConfigConflicts"));
  assert.ok(parsed.required.includes("schemaHash"));
});

test("jsonschema: defines NodeCandidateInfo with referencedEdges and recommendation", () => {
  const parsed = JSON.parse(formatJsonSchema());
  const candidate = parsed.$defs.NodeCandidateInfo;
  assert.ok(candidate, "expected NodeCandidateInfo definition");
  assert.ok(candidate.properties.referencedEdges);
  assert.ok(candidate.properties.recommendation);
  assert.ok(candidate.properties.referencedFromChain);
});

test("jsonschema: RecommendationInfo has confidence enum", () => {
  const parsed = JSON.parse(formatJsonSchema());
  const rec = parsed.$defs.RecommendationInfo;
  assert.ok(rec);
  assert.deepEqual(rec.properties.confidence.enum, ["low", "medium", "high"]);
});
