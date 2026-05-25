# apollo-cache-audit

Detect GraphQL Object types that **look like entities but lack an `id` field**, so they are silently inlined by Apollo Client's `InMemoryCache` instead of being normalized — the root cause of "stale after mutation", "cache data may be lost" warnings, and infinite-loop pagination bugs.

> Community project. Not affiliated with or endorsed by Apollo GraphQL, Inc.

## Why this exists

Apollo's `InMemoryCache` normalizes any Object type whose schema declares an `id` (or `_id`) field, or whose type policy provides custom key fields. Types **without** any of those are inlined into their parent. That's correct for value objects, but **silently wrong** for types that are conceptually entities — the symptoms only appear at runtime, often after a refactor, often only in mutations.

The existing tools cover adjacent problems:

| Tool | Covers | Does not cover |
|---|---|---|
| `@graphql-eslint/require-selections` | Operation forgets to select `id` | Schema-side `id` is missing |
| `@graphql-eslint/strict-id-in-types` | All types must have `id` | False positives on value objects, suffix allowlist is too coarse |
| Apollo dev warnings | Runtime detection after a merge collision | Pre-merge static prevention, CI gating |

`apollo-cache-audit` uses **Apollo's own `InMemoryCache.identify()`** as the source of truth, combined with the **Relay `Node` convention** as the contract layer:

1. **Apollo-grounded probe.** For each Object type, the tool constructs a real `InMemoryCache` from your statically-extracted config and calls `cache.identify(synthInstance)`. This is the same logic Apollo runs at request time — if `identify()` returns `undefined`, the type will not be normalized at runtime, period.
2. **Reference graph.** Types that fail to normalize but are **referenced as a field from a normalizing parent** are reported as **promotion candidates** — the symptoms (stale-after-mutation, key collision, fetchMore loops) only manifest in this configuration.
3. **Invalid-keyFields detection.** If `typePolicies[T].keyFields` lists a field name that isn't declared on `T` in the schema, Apollo throws `InvariantError` the first time it sees that type. The audit catches this statically as a **high-confidence misconfiguration**.
4. **Node interface contract check.** Types listed in `dataIdFromObject` / `typePolicies.keyFields` that **don't** implement the `Node` interface are reported as `customButNotNode` — Apollo treats them as entities but the schema disagrees with itself.
5. **Suffix backstop.** A small allowlist (`Edge`, `Connection`, `PageInfo`, `Payload`, etc.) avoids false positives on Relay/GraphQL structural types. This is *not* the primary detection mechanism.

> What distinguishes this tool from `strict-id-in-types` is that detection is grounded in Apollo's actual normalization logic. The Node-interface and suffix lists only adjust how findings are bucketed.

## Install

```bash
npm install -D apollo-cache-audit
# or
pnpm add -D apollo-cache-audit
```

Peer dependencies: `graphql >= 16`, `@apollo/client >= 3`.

## Quickstart

```bash
npx apollo-cache-audit \
  --schema ./schema.graphql \
  --cache-config ./src/apollo/cache.ts
```

Sample output:

```
apollo-cache-audit
==================

schema sha256: 9f3a7b21c4d8…
node-implemented:        42
value-objects:           18
custom-handled:          3
custom-but-not-node:     1  ←
node-promotion-candidate:4  ←
invalid-keyfields:       1  ←

⚠ Types with custom cache config but no Node interface
   (these are treated as entities by the cache but the schema declares no id)
   - Organization  (dataIdFromObject)

⚠ Node-promotion candidates
   (referenced from a Node-implementing type; likely entities)
   - Author (./schema.graphql:42) ← Post, Comment
   - Membership (./schema.graphql:71) ← Workspace
   - Subscription (./schema.graphql:88) ← Account
   - WebhookConfig (./schema.graphql:104) ← Project
```

## CLI

```
apollo-cache-audit --schema <path> --cache-config <path> [options]
```

| Option | Default | Description |
|---|---|---|
| `--schema <path>` | (required) | GraphQL SDL file |
| `--cache-config <path>` | (required) | TS/JS file with `new InMemoryCache({...})` |
| `--ts-config <path>` | auto-detected | `tsconfig.json` for cross-file resolution |
| `--node-interface <name>` | `Node` | Entity-marker interface name |
| `--ignore-suffixes <list>` | `Response,Result,Payload,Edge,Connection,PageInfo,Aggregation,Csv,Report` | Suffix list for value-object backstop |
| `--ignore-types <list>` | (empty) | Type names to skip entirely (third-party/legacy) |
| `--baseline <path>` | (none) | Known-violation JSON; only new findings beyond this are surfaced as new |
| `--update-baseline` | `false` | Rewrite the `--baseline` file with current findings |
| `--format <text\|json\|github>` | `text` | Output format. `github` emits `::warning::` annotations |
| `--fail-on <none\|new\|suspect\|all>` | `none` | Exit non-zero condition |
| `--fail-on-custom-without-node` | `false` | Exit non-zero on `customButNotNode` findings (high-confidence) |
| `--fail-on-invalid-keyfields` | `false` | Exit non-zero when `typePolicies.keyFields` references a missing schema field |
| `--report <path>` | (none) | Write rendered output to a file instead of stdout |
| `--verbose` | `false` | Verbose logging |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success / no failure condition triggered |
| 1 | Findings exist and a `--fail-on*` condition triggered |
| 2 | Invocation error (missing args, file not found, etc.) |

### `--fail-on` semantics

| Value | Triggers exit 1 when… |
|---|---|
| `none` | never |
| `new` | a `--baseline` is provided and there are candidates outside the baseline |
| `suspect` | any `nodePromotionCandidate` exists (with or without baseline) |
| `all` | any candidate **or** any `customButNotNode` finding exists |

`--fail-on-custom-without-node` independently triggers exit 1 when `customButNotNode` is non-empty — useful as a hard gate even when adopting the candidate list gradually.

## Programmatic API

```ts
import { audit } from "apollo-cache-audit";

const result = await audit({
  schema: "./schema.graphql",      // path or SDL string
  cacheConfig: "./src/cache.ts",   // path to TS/JS file
  nodeInterface: "Node",
  ignoreSuffixes: ["Edge", "Connection"],
  ignoreTypes: ["LegacyType"],
  baseline: "./apollo-cache-audit.baseline.json",
});

// Shape:
// {
//   nodeImplemented: string[]
//   valueObject: { name, reason }[]
//   customHandled: { name, via, keyFields? }[]
//   customButNotNode: { name, via, keyFields? }[]
//   nodePromotionCandidate: { name, referencedFrom, line?, file? }[]
//   newSinceBaseline: NodeCandidateInfo[]
//   resolvedSinceBaseline: string[]
//   schemaHash: string
// }
```

`buildBaseline`, `writeBaseline`, and `loadBaseline` are also exported for custom CI setups.

## Baseline workflow

New projects rarely start clean. Adopt incrementally:

1. Run once to discover all current candidates:
   ```bash
   apollo-cache-audit --schema ./schema.graphql --cache-config ./src/cache.ts \
     --baseline ./apollo-cache-audit.baseline.json --update-baseline
   ```
2. Commit the baseline JSON.
3. In CI, fail only on new candidates:
   ```bash
   apollo-cache-audit --schema ./schema.graphql --cache-config ./src/cache.ts \
     --baseline ./apollo-cache-audit.baseline.json --fail-on new \
     --fail-on-custom-without-node
   ```
4. As types are migrated to `Node`, rerun with `--update-baseline` to shrink the file.

The baseline records the schema SHA-256; when the schema changes substantially, `schemaChanged: true` is included in JSON output so reviewers know to revisit.

### Baseline JSON shape

```json
{
  "tool": "apollo-cache-audit@0.1.0",
  "generated": "2026-05-25T00:00:00.000Z",
  "schemaHash": "9f3a7b…",
  "nodePromotionCandidate": [
    { "type": "Author", "referencedFrom": ["Post"], "addedAt": "2026-05-25T00:00:00.000Z" }
  ],
  "customButNotNode": [
    { "type": "Organization", "referencedFrom": [], "addedAt": "2026-05-25T00:00:00.000Z" }
  ]
}
```

`addedAt` is preserved across `--update-baseline` runs to track aging.

## CI integration

### GitHub Actions

```yaml
- name: Apollo cache audit
  run: |
    npx apollo-cache-audit \
      --schema ./schema.graphql \
      --cache-config ./src/apollo/cache.ts \
      --baseline ./apollo-cache-audit.baseline.json \
      --fail-on new \
      --fail-on-custom-without-node \
      --format github
```

`--format github` emits `::warning file=...::` annotations rendered inline in the PR diff.

### GitLab CI

```yaml
apollo-cache-audit:
  script:
    - npx apollo-cache-audit --schema schema.graphql --cache-config src/cache.ts --fail-on suspect
  artifacts:
    when: always
    reports:
      junit: apollo-cache-audit.report.json
```

## FAQ

**Q: How is this different from `@graphql-eslint/strict-id-in-types`?**
`strict-id-in-types` flags every Object without an `id` field and asks you to disable it for value objects via suffix. This tool inverts the rule: a type only earns a warning if it is **reachable as a field from a Node entity** — so genuine value objects produce no noise. The suffix list is a small final filter, not the primary mechanism.

**Q: My schema has no `node(id: ID!)` query — can I still use this?**
Yes. The tool only requires the `Node` interface (or whatever you name via `--node-interface`). The Relay query field is unrelated.

**Q: Does this work with urql / Relay framework / GraphQL Yoga?**
This audit targets `@apollo/client`'s `InMemoryCache` normalization rules specifically. urql's Graphcache has its own keying model; Relay enforces Node by design. We may add adapters in future versions.

**Q: My cache config is split across many files.**
Supported. `apollo-cache-audit` uses the TypeScript Compiler API (via `ts-morph`) and follows identifier references and object spread through imports, as long as your `tsconfig.json` resolves them. Use `--ts-config` to point at the right project.

**Q: Should I always promote every candidate to a `Node`?**
No. The list is "candidates for review" — a multi-field nested object that genuinely never needs identity (a `Money { amount, currency }` value object) should stay un-normalized. Add such types to `--ignore-types` or accept them in the baseline.

**Q: A `customButNotNode` finding — what does it mean?**
You added a type to `dataIdFromObject` or `typePolicies.keyFields`, meaning at runtime Apollo treats it as an entity, but the schema declares no `id` / `Node` membership. This is almost always a missed schema update.

**Q: An `invalidKeyFields` finding — what does it mean?**
Your `typePolicies[T].keyFields` references a field name that doesn't exist on `T` in the schema. Apollo throws `InvariantError` the first time it tries to normalize a `T` (e.g. `Missing field 'orgId' while extracting keyFields`). This is the **highest-confidence** finding — it's not a heuristic, it's a runtime crash the tool reproduces ahead of time.

**Q: Function-form `keyFields`?**
Detected. The fields list will be reported as `"fn"` since static analysis can't enumerate the keys, but the type is correctly recognized as custom-handled.

## Limitations (v0.1)

- Apollo Client only. urql / Relay framework / Graphcache out of scope.
- Static analysis of cache config: dynamic property names (`[CONST]: {...}`) and conditional keyFields based on runtime values aren't resolved.
- Reference graph is 1-hop. A type reachable only through an intermediate value object (Normalized → ValueObject → Candidate) is currently treated as a value object.
- `addTypename: false` configurations or per-query `cacheRedirects` (Apollo Client v2 only) are out of scope.
- Function-form `keyFields` are treated as opaque "custom-handled": the tool cannot enumerate which fields the function reads, so it cannot validate them against the schema.

## License

MIT
