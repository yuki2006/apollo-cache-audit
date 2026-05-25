import type { AuditResult, NodeCandidateInfo, CustomCacheInfo } from "../types.js";

export function formatGithub(
  result: AuditResult,
  opts: { baselineUsed: boolean; schemaFile?: string },
): string {
  const lines: string[] = [];

  for (const i of result.invalidKeyFields) {
    lines.push(
      annotate(
        "error",
        opts.schemaFile,
        undefined,
        `typePolicies.keyFields for "${i.type}" references field(s) not in schema: ${i.missingFields.join(", ")} — Apollo will throw at runtime`,
      ),
    );
  }

  for (const c of result.customButNotNode) {
    lines.push(
      annotate(
        "error",
        opts.schemaFile,
        undefined,
        `Type "${c.name}" has custom cache key (${c.via}) but does not implement Node — schema declares no id`,
      ),
    );
  }

  const candidates = opts.baselineUsed ? result.newSinceBaseline : result.nodePromotionCandidate;
  for (const c of candidates) {
    lines.push(
      annotate(
        "warning",
        c.file ?? opts.schemaFile,
        c.line,
        candidateMessage(c),
      ),
    );
  }

  return lines.length > 0 ? lines.join("\n") + "\n" : "";
}

function candidateMessage(c: NodeCandidateInfo): string {
  const parents = c.referencedFrom.length > 0 ? c.referencedFrom.join(", ") : "(none)";
  return `Type "${c.name}" should likely implement the Node interface (referenced by Node entity: ${parents})`;
}

function annotate(
  level: "warning" | "error",
  file: string | undefined,
  line: number | undefined,
  message: string,
): string {
  const parts: string[] = [];
  if (file) parts.push(`file=${file}`);
  if (line) parts.push(`line=${line}`);
  parts.push(`title=apollo-cache-audit`);
  const params = parts.join(",");
  return `::${level} ${params}::${escapeMessage(message)}`;
}

function escapeMessage(msg: string): string {
  return msg.replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
