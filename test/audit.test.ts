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

test("dispatch-object: dataIdFromObject via { Type: fieldName }[__typename] dispatch", async () => {
  const r = await runFixture("dispatch-object");
  const namesCustom = r.customButNotNode.map((c) => c.name).sort();
  // Both Organization and Workspace handled by the dispatch object; neither implements Node.
  assert.deepEqual(namesCustom, ["Organization", "Workspace"]);
});

test("map-dispatch: dataIdFromObject via new Map([[T, field], ...]).get(__typename)", async () => {
  const r = await runFixture("map-dispatch");
  const names = r.customButNotNode.map((c) => c.name).sort();
  assert.deepEqual(names, ["Card", "CollectionThumbnail"]);
});

test("as-const-types: as-const array literal unwrapped for Array.includes detection", async () => {
  const r = await runFixture("as-const-types");
  const names = r.customButNotNode.map((c) => c.name).sort();
  assert.deepEqual(names, ["PrepaidPointBalance", "UserItem"]);
});

test("template-literal-typename: `${obj.__typename}` === 'X' detected", async () => {
  const r = await runFixture("template-literal-typename");
  const names = r.customButNotNode.map((c) => c.name).sort();
  assert.deepEqual(names, ["ItemCollectContentItem"]);
});

test("array-includes: dataIdFromObject via KNOWN_TYPES.includes(__typename)", async () => {
  const r = await runFixture("array-includes");
  const names = r.customButNotNode.map((c) => c.name).sort();
  // LegacyItem is in the array list and used in schema; OtherLegacyType is in the list but
  // not in schema, so won't appear (no synth probe possible).
  assert.deepEqual(names, ["LegacyItem"]);
});

test("id-without-node: id-bearing types without Node interface bucket separately", async () => {
  const r = await runFixture("id-without-node");
  assert.deepEqual(r.nodeImplemented, ["User"]);
  assert.deepEqual(r.apolloCompatibleNotNode, ["Article"]);
  assert.equal(r.nodePromotionCandidate.length, 0);
});

test("recommendation: candidate with id-like field suggests add-id with high/medium confidence", async () => {
  const r = await runFixture("basic");
  const tag = r.nodePromotionCandidate.find((c) => c.name === "Tag");
  assert.ok(tag, "expected Tag candidate");
  assert.equal(tag.recommendation?.primary, "add-id");
  assert.ok(["medium", "high"].includes(tag.recommendation?.confidence ?? "low"));
  assert.match(tag.recommendation?.reason ?? "", /slug/);
});

test("recommendation: bug-key-collision Author classified as value-object by shape", async () => {
  const r = await runFixture("bug-key-collision");
  const author = r.nodePromotionCandidate.find((c) => c.name === "Author");
  assert.ok(author);
  assert.equal(author.recommendation?.primary, "mark-as-value-object");
  assert.match(author.recommendation?.reason ?? "", /value-object|small-flat-shape|leaf-only/);
});

test("recommendation: bug-stale-after-mutation ArticleStats votes add-suffix-rule (Stats suffix)", async () => {
  const r = await runFixture("bug-stale-after-mutation");
  const stats = r.nodePromotionCandidate.find((c) => c.name === "ArticleStats");
  assert.ok(stats);
  assert.equal(stats.recommendation?.primary, "add-suffix-rule");
  const sigNames = stats.recommendation?.signals.map((s) => s.name) ?? [];
  assert.ok(sigNames.some((n) => n.includes("Stats")), "expected Stats suffix signal");
});

test("recommendation: signals array is populated and sorted by weight", async () => {
  const r = await runFixture("basic");
  const tag = r.nodePromotionCandidate.find((c) => c.name === "Tag");
  assert.ok(tag?.recommendation);
  assert.ok(tag.recommendation.signals.length > 0);
  for (let i = 1; i < tag.recommendation.signals.length; i++) {
    const prev = tag.recommendation.signals[i - 1]!.weight;
    const cur = tag.recommendation.signals[i]!.weight;
    assert.ok(prev >= cur, "signals must be weight-descending");
  }
});

test("multi-hop (off): ArticleSource is value-object without --multi-hop", async () => {
  const r = await runFixture("multi-hop-reference");
  const candidateNames = r.nodePromotionCandidate.map((c) => c.name);
  assert.ok(!candidateNames.includes("ArticleSource"));
  const valueObjectNames = r.valueObject.map((v) => v.name);
  assert.ok(valueObjectNames.includes("ArticleSource"));
});

test("multi-hop (on): ArticleSource becomes candidate via ArticleMetadata", async () => {
  const r = await audit({
    schema: resolve(fixtureDir("multi-hop-reference"), "schema.graphql"),
    cacheConfig: resolve(fixtureDir("multi-hop-reference"), "cache-config.ts"),
    multiHop: true,
  });
  const candidateNames = r.nodePromotionCandidate.map((c) => c.name).sort();
  assert.deepEqual(candidateNames, ["ArticleMetadata", "ArticleSource"]);
  const src = r.nodePromotionCandidate.find((c) => c.name === "ArticleSource");
  assert.ok(src?.referencedFromChain);
  assert.ok(
    src.referencedFromChain.some(
      (chain) =>
        chain[0] === "ArticleSource" &&
        chain.includes("ArticleMetadata") &&
        chain.includes("Article"),
    ),
    "expected chain through ArticleMetadata to Article",
  );
});

test("union-mixed-members: Video has referencedEdges with kind=union", async () => {
  const r = await runFixture("union-mixed-members");
  const video = r.nodePromotionCandidate.find((c) => c.name === "Video");
  assert.ok(video, "expected Video candidate");
  assert.ok(video.referencedEdges.length > 0);
  const unionEdge = video.referencedEdges.find((e) => e.kind === "union");
  assert.ok(unionEdge, "expected at least one union edge");
  assert.equal(unionEdge.abstractType, "FeedItem");
  assert.equal(unionEdge.parent, "Article");
  assert.ok(r.nodeImplemented.includes("Photo"));
});

test("card-ref-pattern: switch case 'Card' with nested __ref access detects Card", async () => {
  // Real-world dataIdFromObject where the return expression reads __ref from
  // already-normalized nested references. The case label is still a string literal so
  // detection should succeed regardless of the return-side complexity.
  const r = await runFixture("card-ref-pattern");
  const names = r.customButNotNode.map((c) => c.name);
  assert.deepEqual(names, ["Card"]);
});

test("keyfields-false: explicit opt-out lands in customHandled, not candidate", async () => {
  // typePolicies[ChildItem].keyFields = false is the user explicitly saying "don't
  // normalize this type". It must not be flagged as a promotion candidate.
  const r = await runFixture("keyfields-false");
  assert.equal(r.nodePromotionCandidate.length, 0);
  const item = r.customHandled.find((c) => c.name === "ChildItem");
  assert.ok(item);
  assert.equal(item.via, "typePolicies.keyFields");
  assert.equal(item.keyFields, false);
});

test("const-case-label: switch case CONST: resolves through identifier definitions", async () => {
  // `case CARD_TYPENAME:` where CARD_TYPENAME is a const-declared string literal.
  // Without identifier resolution, Card was being mis-bucketed as nodePromotionCandidate.
  const r = await runFixture("const-case-label");
  const names = r.customButNotNode.map((c) => c.name);
  assert.deepEqual(names, ["Card"]);
  assert.equal(r.nodePromotionCandidate.length, 0);
});

test("multi-config: merges two cache files and detects conflicts", async () => {
  const r = await audit({
    schema: resolve(fixtureDir("multi-config"), "schema.graphql"),
    cacheConfig: [
      resolve(fixtureDir("multi-config"), "cache-a.ts"),
      resolve(fixtureDir("multi-config"), "cache-b.ts"),
    ],
  });
  const customNames = r.customButNotNode.map((c) => c.name).sort();
  assert.ok(customNames.includes("Organization"));
  assert.ok(customNames.includes("UserProfile"));
  assert.equal(r.cacheConfigConflicts.length, 1);
  assert.equal(r.cacheConfigConflicts[0]?.type, "Organization");
  assert.equal(r.cacheConfigConflicts[0]?.keyFields.length, 2);
  assert.equal(r.cacheConfigConflicts[0]?.sources.length, 2);
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
