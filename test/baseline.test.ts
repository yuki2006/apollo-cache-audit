import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { audit } from "../src/index.ts";
import { buildBaseline, writeBaseline } from "../src/core/baseline.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = (name: string) => resolve(__dirname, "fixtures", name);

test("baseline: new candidate appears in newSinceBaseline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "baseline-"));
  const baselinePath = join(dir, "baseline.json");
  writeFileSync(
    baselinePath,
    JSON.stringify({
      tool: "test",
      generated: new Date().toISOString(),
      schemaHash: "",
      nodePromotionCandidate: [],
      customButNotNode: [],
    }),
    "utf8",
  );

  const r = await audit({
    schema: resolve(fixtureDir("basic"), "schema.graphql"),
    cacheConfig: resolve(fixtureDir("basic"), "cache-config.ts"),
    baseline: baselinePath,
  });
  const newNames = r.newSinceBaseline.map((c) => c.name);
  assert.deepEqual(newNames, ["Tag"]);
});

test("baseline: existing candidate suppressed from newSinceBaseline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "baseline-"));
  const baselinePath = join(dir, "baseline.json");
  const r1 = await audit({
    schema: resolve(fixtureDir("basic"), "schema.graphql"),
    cacheConfig: resolve(fixtureDir("basic"), "cache-config.ts"),
  });
  const data = buildBaseline(
    r1.nodePromotionCandidate,
    r1.customButNotNode,
    r1.schemaHash,
  );
  writeBaseline(baselinePath, data);

  const r2 = await audit({
    schema: resolve(fixtureDir("basic"), "schema.graphql"),
    cacheConfig: resolve(fixtureDir("basic"), "cache-config.ts"),
    baseline: baselinePath,
  });
  assert.equal(r2.newSinceBaseline.length, 0);
  assert.equal(r2.resolvedSinceBaseline.length, 0);
});

test("baseline: written file is readable and has expected shape", async () => {
  const dir = mkdtempSync(join(tmpdir(), "baseline-"));
  const baselinePath = join(dir, "baseline.json");
  const r = await audit({
    schema: resolve(fixtureDir("basic"), "schema.graphql"),
    cacheConfig: resolve(fixtureDir("basic"), "cache-config.ts"),
  });
  const data = buildBaseline(
    r.nodePromotionCandidate,
    r.customButNotNode,
    r.schemaHash,
  );
  writeBaseline(baselinePath, data);

  const parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
  assert.equal(parsed.schemaHash, r.schemaHash);
  assert.equal(parsed.nodePromotionCandidate.length, 1);
  assert.equal(parsed.nodePromotionCandidate[0].type, "Tag");
  assert.ok(parsed.nodePromotionCandidate[0].addedAt);
});
