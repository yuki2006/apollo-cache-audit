import type { AuditResult, NodeCandidateInfo } from "../types.js";

export function formatText(result: AuditResult, opts: { baselineUsed: boolean }): string {
  const lines: string[] = [];
  lines.push("apollo-cache-audit");
  lines.push("==================");
  lines.push("");
  lines.push(`schema sha256: ${result.schemaHash.slice(0, 12)}…`);
  lines.push(`node-implemented:        ${result.nodeImplemented.length}`);
  lines.push(`apollo-ok-not-node:      ${result.apolloCompatibleNotNode.length}  ${badge(result.apolloCompatibleNotNode.length, "info")}`);
  lines.push(`value-objects:           ${result.valueObject.length}`);
  lines.push(`custom-handled:          ${result.customHandled.length}`);
  lines.push(`custom-but-not-node:     ${result.customButNotNode.length}  ${badge(result.customButNotNode.length)}`);
  lines.push(`node-promotion-candidate:${result.nodePromotionCandidate.length}  ${badge(result.nodePromotionCandidate.length)}`);
  lines.push(`invalid-keyfields:       ${result.invalidKeyFields.length}  ${badge(result.invalidKeyFields.length)}`);
  lines.push(`cache-config-conflicts:  ${result.cacheConfigConflicts.length}  ${badge(result.cacheConfigConflicts.length)}`);
  if (opts.baselineUsed) {
    lines.push(`new since baseline:      ${result.newSinceBaseline.length}  ${badge(result.newSinceBaseline.length)}`);
    lines.push(`resolved since baseline: ${result.resolvedSinceBaseline.length}`);
  }
  lines.push("");

  if (result.apolloCompatibleNotNode.length > 0) {
    lines.push("ℹ Types Apollo normalizes via id/_id, but missing Node interface");
    lines.push("   (cache works; Relay Global Object Identification non-compliant)");
    for (const n of result.apolloCompatibleNotNode) {
      lines.push(`   - ${n}`);
    }
    lines.push("");
  }

  if (result.cacheConfigConflicts.length > 0) {
    lines.push("⚠ Cache-config conflicts across input files");
    lines.push("   (multiple --cache-config inputs disagree on keyFields for the same type;");
    lines.push("    first occurrence wins)");
    for (const conflict of result.cacheConfigConflicts) {
      lines.push(`   - ${conflict.type}:`);
      for (let i = 0; i < conflict.keyFields.length; i++) {
        lines.push(`       ${conflict.sources[i]} -> ${JSON.stringify(conflict.keyFields[i])}`);
      }
    }
    lines.push("");
  }

  if (result.invalidKeyFields.length > 0) {
    lines.push("✗ typePolicies.keyFields references fields not present in the schema");
    lines.push("   (Apollo throws InvariantError at runtime when these are encountered)");
    for (const i of result.invalidKeyFields) {
      lines.push(`   - ${i.type}  missing fields: ${i.missingFields.join(", ")}`);
    }
    lines.push("");
  }

  if (result.customButNotNode.length > 0) {
    lines.push("⚠ Types with custom cache config but no Node interface");
    lines.push("   (these are treated as entities by the cache but the schema declares no id)");
    for (const c of result.customButNotNode) {
      lines.push(`   - ${c.name}  (${describeCustom(c)})`);
    }
    lines.push("");
  }

  const explicitOptOut = result.customHandled.filter(
    (c) => c.via === "typePolicies.keyFields" && c.keyFields === false,
  );
  if (explicitOptOut.length > 0) {
    lines.push("ℹ Types explicitly opted out of normalization (typePolicies.keyFields = false)");
    for (const c of explicitOptOut) {
      lines.push(`   - ${c.name}`);
    }
    lines.push("");
  }

  const candidates = opts.baselineUsed ? result.newSinceBaseline : result.nodePromotionCandidate;
  if (candidates.length > 0) {
    lines.push(opts.baselineUsed
      ? "⚠ Node-promotion candidates new since baseline"
      : "⚠ Node-promotion candidates");
    lines.push("   (referenced from a Node-implementing type; likely entities)");
    for (const c of candidates) {
      const loc = c.line ? ` (${c.file ?? "schema"}:${c.line})` : "";
      const refs = formatReferences(c);
      lines.push(`   - ${c.name}${loc}${refs}`);
      if (c.referencedFromChain && c.referencedFromChain.length > 0) {
        for (const chain of c.referencedFromChain) {
          lines.push(`       via: ${chain.join(" → ")}`);
        }
      }
      if (c.recommendation) {
        const conf = c.recommendation.confidence;
        lines.push(`       suggest [${conf}]: ${c.recommendation.primary} — ${c.recommendation.reason}`);
      }
    }
    lines.push("");
  }

  if (opts.baselineUsed && result.resolvedSinceBaseline.length > 0) {
    lines.push("✓ Resolved since baseline");
    for (const n of result.resolvedSinceBaseline) {
      lines.push(`   - ${n}`);
    }
    lines.push("");
  }

  if (
    result.customButNotNode.length === 0 &&
    candidates.length === 0 &&
    result.invalidKeyFields.length === 0 &&
    result.cacheConfigConflicts.length === 0
  ) {
    lines.push("✓ No findings.");
    lines.push("");
  }

  return lines.join("\n");
}

function badge(n: number, kind: "warn" | "info" = "warn"): string {
  if (n === 0) return "";
  return kind === "info" ? "ℹ" : "←";
}

function describeCustom(c: { via: string; keyFields?: readonly string[] | "fn" | false }): string {
  if (c.via === "dataIdFromObject") return "dataIdFromObject";
  if (c.keyFields === false) return "keyFields=false (inlined)";
  return `keyFields=${JSON.stringify(c.keyFields)}`;
}

function formatReferences(c: NodeCandidateInfo): string {
  if (!c.referencedEdges || c.referencedEdges.length === 0) {
    return c.referencedFrom.length > 0 ? ` ← ${c.referencedFrom.join(", ")}` : "";
  }
  const parts = c.referencedEdges.map((e) => {
    if (e.kind === "direct") return e.parent;
    return `${e.parent} (via ${e.kind} ${e.abstractType ?? "?"})`;
  });
  return ` ← ${parts.join(", ")}`;
}
