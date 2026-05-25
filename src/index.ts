import { loadSchema } from "./core/schema.js";
import { loadCacheConfig } from "./core/cacheConfig.js";
import { classify, DEFAULT_IGNORE_SUFFIXES } from "./core/classifier.js";
import { diffBaseline, loadBaseline } from "./core/baseline.js";
import { buildProbe } from "./core/apolloProbe.js";
import type { AuditOptions, AuditResult, BaselineData } from "./types.js";

export async function audit(options: AuditOptions): Promise<AuditResult> {
  const nodeInterface = options.nodeInterface ?? "Node";
  const ignoreSuffixes = options.ignoreSuffixes ?? DEFAULT_IGNORE_SUFFIXES;
  const ignoreTypes = new Set(options.ignoreTypes ?? []);

  const schemaModel = loadSchema({ schema: options.schema, nodeInterface });
  const cacheConfig = loadCacheConfig({
    cacheConfigPath: options.cacheConfig,
    tsConfigPath: options.tsConfigPath,
  });

  const probe = buildProbe(schemaModel, cacheConfig);
  const cls = classify({
    schemaModel,
    cacheConfig,
    probe,
    ignoreSuffixes,
    ignoreTypes,
    multiHop: options.multiHop,
  });

  const baseline = resolveBaseline(options.baseline);
  let newSinceBaseline: AuditResult["newSinceBaseline"] = [];
  let resolvedSinceBaseline: AuditResult["resolvedSinceBaseline"] = [];
  if (baseline) {
    const diff = diffBaseline(
      baseline,
      cls.nodePromotionCandidate,
      cls.customButNotNode,
      schemaModel.schemaHash,
    );
    newSinceBaseline = diff.newCandidates;
    resolvedSinceBaseline = diff.resolvedCandidates;
  }

  return {
    ...cls,
    cacheConfigConflicts: cacheConfig.conflicts,
    newSinceBaseline,
    resolvedSinceBaseline,
    schemaHash: schemaModel.schemaHash,
  };
}

function resolveBaseline(input: AuditOptions["baseline"]): BaselineData | undefined {
  if (!input) return undefined;
  if (typeof input === "string") return loadBaseline(input);
  return input;
}

export type { AuditOptions, AuditResult } from "./types.js";
export { DEFAULT_IGNORE_SUFFIXES } from "./core/classifier.js";
export { buildBaseline, writeBaseline, loadBaseline } from "./core/baseline.js";
