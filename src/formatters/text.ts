import type { AuditResult } from "../types.js";

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
      const via = c.via === "dataIdFromObject" ? "dataIdFromObject" : `keyFields=${JSON.stringify(c.keyFields)}`;
      lines.push(`   - ${c.name}  (${via})`);
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
      const refs = c.referencedFrom.length > 0 ? ` ← ${c.referencedFrom.join(", ")}` : "";
      lines.push(`   - ${c.name}${loc}${refs}`);
      if (c.recommendation) {
        lines.push(`       suggest: ${c.recommendation.primary} — ${c.recommendation.reason}`);
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
    result.invalidKeyFields.length === 0
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
