import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { audit } from "../src/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = (name: string) => resolve(__dirname, "fixtures", name);

const runFixture = (name: string) =>
  audit({
    schema: resolve(fixtureDir(name), "schema.graphql"),
    cacheConfig: resolve(fixtureDir(name), "cache-config.ts"),
  });

test("basic: identifies Tag as a candidate and ArticleAggregation as suffix-ignored", async () => {
  const r = await runFixture("basic");
  // Article is in typePolicies so it lands in customHandled, not nodeImplemented.
  assert.deepEqual(r.nodeImplemented, ["Author"]);
  assert.deepEqual(
    r.customHandled.map((c) => c.name),
    ["Article"],
  );
  const candidateNames = r.nodePromotionCandidate.map((c) => c.name);
  assert.deepEqual(candidateNames, ["Tag"]);
  const valueObjectNames = r.valueObject.map((v) => v.name).sort();
  assert.ok(valueObjectNames.includes("ArticleAggregation"));
  assert.ok(valueObjectNames.includes("PageInfo"));
  const tag = r.nodePromotionCandidate.find((c) => c.name === "Tag");
  assert.deepEqual(tag?.referencedFrom, ["Article"]);
  assert.ok(typeof tag?.line === "number" && tag.line > 0);
});

test("custom-handled: detects Organization as customButNotNode", async () => {
  const r = await runFixture("custom-handled");
  const namesCustom = r.customButNotNode.map((c) => c.name);
  assert.deepEqual(namesCustom, ["Organization"]);
  assert.equal(r.customButNotNode[0]?.via, "dataIdFromObject");
  assert.deepEqual(r.nodeImplemented, ["Workspace"]);
  assert.equal(r.nodePromotionCandidate.length, 0);
});

test("function-keyfields: handles array and function keyFields, flags Membership as customButNotNode", async () => {
  const r = await runFixture("function-keyfields");
  const membership = r.customButNotNode.find((c) => c.name === "Membership");
  assert.ok(membership, "expected Membership in customButNotNode");
  assert.equal(membership.via, "typePolicies.keyFields");
  assert.deepEqual(membership.keyFields, ["orgId", "userId"]);
});

test("interface-name-custom: respects --node-interface override", async () => {
  const r = await audit({
    schema: resolve(fixtureDir("interface-name-custom"), "schema.graphql"),
    cacheConfig: resolve(fixtureDir("interface-name-custom"), "cache-config.ts"),
    nodeInterface: "INode",
  });
  assert.deepEqual(r.nodeImplemented, ["Thing"]);
  const candidateNames = r.nodePromotionCandidate.map((c) => c.name);
  assert.deepEqual(candidateNames, ["Detail"]);
});

test("all-nodes: zero findings", async () => {
  const r = await runFixture("all-nodes");
  assert.equal(r.nodePromotionCandidate.length, 0);
  assert.equal(r.customButNotNode.length, 0);
});

test("value-objects-only: zero candidates (nothing referenced from Node)", async () => {
  const r = await runFixture("value-objects-only");
  assert.equal(r.nodePromotionCandidate.length, 0);
});

test("spread-policies: detects keyFields through spread", async () => {
  const r = await runFixture("spread-policies");
  const extra = r.customButNotNode.find((c) => c.name === "ExtraInfo");
  assert.ok(extra, "expected ExtraInfo from spread to be customButNotNode");
  assert.deepEqual(extra.keyFields, ["slug"]);
});

test("bug-stale-after-mutation: ArticleStats flagged", async () => {
  const r = await runFixture("bug-stale-after-mutation");
  const names = r.nodePromotionCandidate.map((c) => c.name);
  assert.deepEqual(names, ["ArticleStats"]);
});

test("bug-key-collision: Author flagged", async () => {
  const r = await runFixture("bug-key-collision");
  const names = r.nodePromotionCandidate.map((c) => c.name);
  assert.deepEqual(names, ["Author"]);
});

test("bug-cursorless-pagination: Item flagged", async () => {
  const r = await runFixture("bug-cursorless-pagination");
  const names = r.nodePromotionCandidate.map((c) => c.name);
  assert.deepEqual(names, ["Item"]);
});

test("id-without-node: id-bearing types without Node interface bucket separately", async () => {
  const r = await runFixture("id-without-node");
  assert.deepEqual(r.nodeImplemented, ["User"]);
  assert.deepEqual(r.apolloCompatibleNotNode, ["Article"]);
  assert.equal(r.nodePromotionCandidate.length, 0);
});

test("recommendation: candidate with id-like field suggests add-id", async () => {
  const r = await runFixture("basic");
  // Tag has 'slug' which is an id-like field — should be add-id.
  const tag = r.nodePromotionCandidate.find((c) => c.name === "Tag");
  assert.ok(tag, "expected Tag candidate");
  assert.equal(tag.recommendation?.primary, "add-id");
  assert.match(tag.recommendation?.reason ?? "", /slug/);
});

test("recommendation: bug-key-collision Author (2 fields, 1 parent) falls into value-object heuristic", async () => {
  // Author { name, bio } has no id-like field, 1 parent, 2 scalar fields — matches the
  // value-object shape heuristic. The reason text gives the user enough info to override
  // if Author is actually an entity (which a human would know but the heuristic cannot).
  const r = await runFixture("bug-key-collision");
  const author = r.nodePromotionCandidate.find((c) => c.name === "Author");
  assert.ok(author);
  assert.equal(author.recommendation?.primary, "mark-as-value-object");
  assert.match(author.recommendation?.reason ?? "", /value object|--ignore-types/);
});

test("recommendation: bug-stale-after-mutation ArticleStats suggests add-suffix-rule (Stats suffix)", async () => {
  const r = await runFixture("bug-stale-after-mutation");
  const stats = r.nodePromotionCandidate.find((c) => c.name === "ArticleStats");
  assert.ok(stats);
  assert.equal(stats.recommendation?.primary, "add-suffix-rule");
  assert.match(stats.recommendation?.reason ?? "", /Stats/);
});

test("invalid-keyfields: detects missing fields referenced by typePolicies", async () => {
  const r = await runFixture("invalid-keyfields");
  assert.equal(r.invalidKeyFields.length, 1);
  assert.equal(r.invalidKeyFields[0]?.type, "Membership");
  assert.deepEqual(r.invalidKeyFields[0]?.missingFields, ["orgId"]);
  // Should not also appear as customButNotNode or candidate
  assert.equal(r.customButNotNode.find((c) => c.name === "Membership"), undefined);
});

test("schemaHash is stable across runs of the same schema", async () => {
  const a = await runFixture("basic");
  const b = await runFixture("basic");
  assert.equal(a.schemaHash, b.schemaHash);
  assert.equal(a.schemaHash.length, 64);
});
