# Changelog

## 0.3.0

Real-world feedback-driven release: a user reported that v0.2 still missed several `dataIdFromObject` patterns common in production code, and that the single-tier recommendation didn't scale to ~93 candidates. Both issues are addressed here.

### Features

- **`dataIdFromObject` extraction extended** (closes #1)
  - `new Map([['Foo', 'slug'], ...]).get(obj.__typename)` dispatch
  - `as const` and `satisfies` annotated arrays/objects now resolved transparently
  - `` `${obj.__typename}` `` template-literal equality
  - `as`/`satisfies`/parentheses around the `__typename` argument also unwrapped
- **Score-based recommendation engine** (closes #2)
  - Replaced the single-best-guess heuristic with a weighted signal engine.
  - Signals: id-like field name, timestamp field, foreign-key field name (`xxxId`), parent count, value-object field names (amount/lat/...), small-flat-shape, structural suffix, sibling-suffix grouping, non-Node interface implementation.
  - `RecommendationInfo` now carries `confidence: 'low' | 'medium' | 'high'` and `signals[]`.
  - New CLI flag `--strict-recommend` to omit low-confidence recommendations.

### Tests

- New fixtures: `map-dispatch/`, `as-const-types/`, `template-literal-typename/`.
- Test count: 21 → 25.

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
