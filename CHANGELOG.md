# Changelog

## 0.2.0

### Features

- **New finding bucket `apolloCompatibleNotNode`**. Types that have an `id` field and normalize correctly under Apollo's default `dataIdFromObject`, but do not implement the `Node` interface, are now reported separately from `nodeImplemented`. Apollo cache works for these types; they are flagged as informational so teams adopting Relay Global Object Identification can see them. New CLI flag `--fail-on-not-node` for strict-Relay enforcement.
- **Recommendations on candidates.** `nodePromotionCandidate` entries now include a heuristic `recommendation: { primary: 'add-id' | 'mark-as-value-object' | 'add-suffix-rule', reason: string }`. The reason text explains the signals the heuristic used so the schema author can override informed.
- **dataIdFromObject extraction extended.** `cacheConfig` now detects two additional patterns in custom `dataIdFromObject` bodies:
  - Object dispatch: `const HANDLERS = { Foo: ..., Bar: ... }; HANDLERS[obj.__typename]`
  - Array membership: `const TYPES = ['Foo', 'Bar']; TYPES.includes(obj.__typename ?? '')`
  
  Wrappers (`??`, `||`, optional chaining, parentheses) around `__typename` are unwrapped.

### Internal

- New module `src/core/recommend.ts` with the heuristic logic; covered by dedicated tests.
- New fixtures: `id-without-node`, `dispatch-object`, `array-includes`.
- Test count: 16 → 21.

## 0.1.0

Initial release.

- Apollo-grounded probe via `InMemoryCache.identify()` as the source of truth for normalization.
- Five finding categories: `nodeImplemented`, `customHandled`, `customButNotNode`, `nodePromotionCandidate`, `invalidKeyFields`.
- Static cache-config parsing via `ts-morph` (factory calls, spread, cross-file resolution).
- Baseline workflow with schema SHA and per-entry `addedAt`.
- text / json / github-actions output formats.
- 15 tests, including bug-pattern reproductions (stale-after-mutation, key-collision, cursorless-pagination, invalid-keyfields).
