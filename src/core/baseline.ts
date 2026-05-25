import { readFileSync, writeFileSync } from "node:fs";
import type {
  BaselineData,
  BaselineEntry,
  CustomCacheInfo,
  NodeCandidateInfo,
} from "../types.js";

export const BASELINE_TOOL_TAG = "apollo-cache-audit@0.2.0";

export function loadBaseline(path: string): BaselineData {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<BaselineData>;
  return normalize(parsed);
}

function normalize(data: Partial<BaselineData>): BaselineData {
  return {
    tool: data.tool ?? BASELINE_TOOL_TAG,
    generated: data.generated ?? new Date(0).toISOString(),
    schemaHash: data.schemaHash ?? "",
    nodePromotionCandidate: (data.nodePromotionCandidate ?? []).map(coerceEntry),
    customButNotNode: (data.customButNotNode ?? []).map(coerceEntry),
  };
}

function coerceEntry(e: unknown): BaselineEntry {
  if (typeof e === "string") {
    return { type: e, referencedFrom: [], addedAt: new Date(0).toISOString() };
  }
  const obj = e as Partial<BaselineEntry>;
  return {
    type: obj.type ?? "",
    referencedFrom: obj.referencedFrom ?? [],
    addedAt: obj.addedAt ?? new Date(0).toISOString(),
  };
}

export interface BaselineDiff {
  newCandidates: NodeCandidateInfo[];
  resolvedCandidates: string[];
  newCustomButNotNode: CustomCacheInfo[];
  resolvedCustomButNotNode: string[];
  schemaChanged: boolean;
}

export function diffBaseline(
  baseline: BaselineData,
  currentCandidates: NodeCandidateInfo[],
  currentCustomButNotNode: CustomCacheInfo[],
  currentSchemaHash: string,
): BaselineDiff {
  const baselineCandidateNames = new Set(
    baseline.nodePromotionCandidate.map((e) => e.type),
  );
  const currentCandidateNames = new Set(currentCandidates.map((c) => c.name));

  const baselineCustomNames = new Set(baseline.customButNotNode.map((e) => e.type));
  const currentCustomNames = new Set(currentCustomButNotNode.map((c) => c.name));

  return {
    newCandidates: currentCandidates.filter((c) => !baselineCandidateNames.has(c.name)),
    resolvedCandidates: [...baselineCandidateNames].filter(
      (n) => !currentCandidateNames.has(n),
    ),
    newCustomButNotNode: currentCustomButNotNode.filter(
      (c) => !baselineCustomNames.has(c.name),
    ),
    resolvedCustomButNotNode: [...baselineCustomNames].filter(
      (n) => !currentCustomNames.has(n),
    ),
    schemaChanged:
      baseline.schemaHash !== "" && baseline.schemaHash !== currentSchemaHash,
  };
}

export function buildBaseline(
  currentCandidates: NodeCandidateInfo[],
  currentCustomButNotNode: CustomCacheInfo[],
  schemaHash: string,
  prev?: BaselineData,
): BaselineData {
  const now = new Date().toISOString();
  const prevAddedAtByType = new Map<string, string>();
  if (prev) {
    for (const e of prev.nodePromotionCandidate) {
      prevAddedAtByType.set(`cand:${e.type}`, e.addedAt);
    }
    for (const e of prev.customButNotNode) {
      prevAddedAtByType.set(`custom:${e.type}`, e.addedAt);
    }
  }

  return {
    tool: BASELINE_TOOL_TAG,
    generated: now,
    schemaHash,
    nodePromotionCandidate: currentCandidates
      .map((c) => ({
        type: c.name,
        referencedFrom: c.referencedFrom,
        addedAt: prevAddedAtByType.get(`cand:${c.name}`) ?? now,
      }))
      .sort((a, b) => a.type.localeCompare(b.type)),
    customButNotNode: currentCustomButNotNode
      .map((c) => ({
        type: c.name,
        referencedFrom: [],
        addedAt: prevAddedAtByType.get(`custom:${c.name}`) ?? now,
      }))
      .sort((a, b) => a.type.localeCompare(b.type)),
  };
}

export function writeBaseline(path: string, data: BaselineData): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}
