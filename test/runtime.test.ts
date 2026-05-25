/**
 * Runtime comparison tests.
 *
 * Each test pairs the audit's static prediction for a fixture with an actual Apollo Client
 * `InMemoryCache` lifecycle (writeFragment + extract) and asserts they agree. This catches:
 *   1. Probe-logic bugs where cache.identify() and the real write/normalize path diverge.
 *   2. Apollo version-bump regressions in behaviour that the probe wouldn't see.
 *   3. Edge cases around nested writes / merge where the audit's flat reachability model
 *      doesn't predict the runtime cache shape.
 *
 * Builds the real cache from the *same* typePolicies/dataIdFromObject the audit extracted,
 * so any mismatch points to either a probe bug or a divergence in Apollo's internals.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryCache, defaultDataIdFromObject } from "@apollo/client/cache/index.js";
import { gql } from "@apollo/client/core/index.js";
import { audit } from "../src/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = (name: string) => resolve(__dirname, "fixtures", name);

/**
 * Reconstruct a real InMemoryCache from a fixture's audit result. Uses the same logic the
 * apolloProbe uses, so a discrepancy here = probe bug.
 */
async function realCacheFromFixture(name: string): Promise<InMemoryCache> {
  const r = await audit({
    schema: resolve(fixtureDir(name), "schema.graphql"),
    cacheConfig: resolve(fixtureDir(name), "cache-config.ts"),
  });
  const typePolicies: Record<string, { keyFields: readonly string[] | false }> = {};
  for (const c of [...r.customHandled, ...r.customButNotNode]) {
    if (c.via === "typePolicies.keyFields" && Array.isArray(c.keyFields)) {
      typePolicies[c.name] = { keyFields: c.keyFields };
    }
  }
  const dataIdTypes = new Set<string>();
  for (const c of [...r.customHandled, ...r.customButNotNode]) {
    if (c.via === "dataIdFromObject") dataIdTypes.add(c.name);
  }
  return new InMemoryCache({
    typePolicies,
    dataIdFromObject: (obj, ctx) => {
      const tn = (obj as { __typename?: string }).__typename;
      if (tn && dataIdTypes.has(tn)) return `${tn}:__custom__`;
      return defaultDataIdFromObject(obj, ctx);
    },
  });
}

test("runtime/basic: Article normalizes via id keyFields, Author via default id, Tag inlined", async () => {
  const cache = await realCacheFromFixture("basic");
  cache.writeFragment({
    id: "Article:1",
    fragment: gql`
      fragment A on Article {
        __typename
        id
        title
        author {
          __typename
          id
          name
        }
        tags {
          __typename
          slug
          label
        }
      }
    `,
    data: {
      __typename: "Article",
      id: "1",
      title: "Hello",
      author: { __typename: "Author", id: "a", name: "Ada" },
      tags: [
        { __typename: "Tag", slug: "js", label: "JS" },
        { __typename: "Tag", slug: "graphql", label: "GraphQL" },
      ],
    },
  });

  const ext = cache.extract();

  // Audit predictions: Article=customHandled, Author=nodeImplemented → both should normalize.
  assert.ok(ext["Article:1"], "Article should normalize via keyFields=['id']");
  assert.ok(ext["Author:a"], "Author should normalize via default id");

  // Tag was a nodePromotionCandidate → no id, no keyFields → must inline.
  const tagKeys = Object.keys(ext).filter((k) => k.startsWith("Tag:"));
  assert.equal(tagKeys.length, 0, "Tag should NOT have a top-level cache entry");

  const article = ext["Article:1"] as Record<string, unknown>;
  assert.ok(article.tags, "Tag should appear inlined inside Article");
});

test("runtime/custom-handled: Organization (dataIdFromObject) is normalized despite no Node interface", async () => {
  const cache = await realCacheFromFixture("custom-handled");
  cache.writeFragment({
    id: "Workspace:w1",
    fragment: gql`
      fragment W on Workspace {
        __typename
        id
        org {
          __typename
          slug
          name
        }
      }
    `,
    data: {
      __typename: "Workspace",
      id: "w1",
      org: { __typename: "Organization", slug: "acme", name: "Acme Inc" },
    },
  });
  const ext = cache.extract();
  assert.ok(ext["Workspace:w1"], "Workspace normalized via default id");
  // Audit said customButNotNode for Organization → it claims to be an entity (custom dataIdFromObject).
  // Our reconstructed cache uses the sentinel "__custom__" so the key is Organization:__custom__.
  const orgKeys = Object.keys(ext).filter((k) => k.startsWith("Organization:"));
  assert.ok(orgKeys.length > 0, "Organization should be normalized (custom dataIdFromObject)");
});

test("runtime/bug-key-collision: Author (no id) collides on multiple Post writes", async () => {
  const cache = await realCacheFromFixture("bug-key-collision");
  cache.writeFragment({
    id: "Post:p1",
    fragment: gql`
      fragment P on Post {
        __typename
        id
        title
        author {
          __typename
          name
          bio
        }
      }
    `,
    data: {
      __typename: "Post",
      id: "p1",
      title: "First",
      author: { __typename: "Author", name: "Ada", bio: "First bio" },
    },
  });
  cache.writeFragment({
    id: "Post:p2",
    fragment: gql`
      fragment P on Post {
        __typename
        id
        title
        author {
          __typename
          name
          bio
        }
      }
    `,
    data: {
      __typename: "Post",
      id: "p2",
      title: "Second",
      author: { __typename: "Author", name: "Ada", bio: "Second bio (different!)" },
    },
  });
  const ext = cache.extract();

  // Audit prediction: Author has no id, no keyFields → inlined into each Post separately.
  // This is the bug pattern the fixture documents: two Posts both reference an "Ada" author,
  // and each Post keeps its own inlined Author copy (no shared cache entry to deduplicate).
  assert.ok(ext["Post:p1"]);
  assert.ok(ext["Post:p2"]);
  const authorKeys = Object.keys(ext).filter((k) => k.startsWith("Author:"));
  assert.equal(authorKeys.length, 0, "Author should NOT be a top-level entry (the bug)");
  const p1 = ext["Post:p1"] as Record<string, any>;
  const p2 = ext["Post:p2"] as Record<string, any>;
  // Each Post has its own inlined Author — divergent bio values are stored separately.
  assert.equal(p1.author.bio, "First bio");
  assert.equal(p2.author.bio, "Second bio (different!)");
});

test("runtime/all-nodes: every type normalizes (no candidates)", async () => {
  const cache = await realCacheFromFixture("all-nodes");
  cache.writeFragment({
    id: "A:a1",
    fragment: gql`
      fragment AA on A {
        __typename
        id
        b {
          __typename
          id
          c {
            __typename
            id
          }
        }
      }
    `,
    data: {
      __typename: "A",
      id: "a1",
      b: {
        __typename: "B",
        id: "b1",
        c: { __typename: "C", id: "c1" },
      },
    },
  });
  const ext = cache.extract();
  assert.ok(ext["A:a1"]);
  assert.ok(ext["B:b1"]);
  assert.ok(ext["C:c1"]);
});

test("runtime/id-without-node: Article (id, no Node) still normalizes via default", async () => {
  const cache = await realCacheFromFixture("id-without-node");
  cache.writeFragment({
    id: "Article:1",
    fragment: gql`
      fragment AA on Article {
        __typename
        id
        title
      }
    `,
    data: { __typename: "Article", id: "1", title: "Hello" },
  });
  const ext = cache.extract();
  assert.ok(ext["Article:1"], "id-without-Node still normalizes (apolloCompatibleNotNode bucket)");
});
