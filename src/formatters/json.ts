import type { AuditResult } from "../types.js";

export function formatJson(result: AuditResult): string {
  return JSON.stringify(result, null, 2) + "\n";
}
