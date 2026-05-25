import type {
  CustomCacheInfo,
  InvalidKeyFieldsInfo,
  NodeCandidateInfo,
  ValueObjectInfo,
} from "../types.js";
import type { SchemaModel } from "./schema.js";
import type { CacheConfigModel } from "./cacheConfig.js";
import type { ProbeResult } from "./apolloProbe.js";
import { recommend } from "./recommend.js";

export const DEFAULT_IGNORE_SUFFIXES = [
  "Response",
  "Result",
  "Payload",
  "Edge",
  "Connection",
  "PageInfo",
  "Aggregation",
  "Csv",
  "Report",
];

export interface ClassifyInput {
  schemaModel: SchemaModel;
  cacheConfig: CacheConfigModel;
  probe: ProbeResult;
  ignoreSuffixes: string[];
  ignoreTypes: Set<string>;
}

export interface Classification {
  nodeImplemented: string[];
  apolloCompatibleNotNode: string[];
  valueObject: ValueObjectInfo[];
  customHandled: CustomCacheInfo[];
  customButNotNode: CustomCacheInfo[];
  nodePromotionCandidate: NodeCandidateInfo[];
  invalidKeyFields: InvalidKeyFieldsInfo[];
}

/**
 * Classification strategy: Apollo's actual cache.identify() outcome is the source of truth for
 * "will this type be normalized?". The Node-interface convention is used only to distinguish
 * customHandled vs customButNotNode (a contract concern, not a behavioral one).
 *
 *   probe outcome              | Node implemented? | classification
 *   ---------------------------|-------------------|----------------------------------
 *   invalid-keyfields          | any               | invalidKeyFields (highest priority)
 *   normalized-with-id         | yes               | nodeImplemented
 *   normalized-with-id         | no                | nodeImplemented (de-facto entity:
 *                              |                   |   schema has id field, normalizes)
 *   normalized-with-keyfields  | yes               | customHandled
 *   normalized-with-keyfields  | no                | customButNotNode
 *   normalized-via-custom-..   | yes               | customHandled
 *   normalized-via-custom-..   | no                | customButNotNode
 *   not-normalized-no-key      | -                 | valueObject OR nodePromotionCandidate
 *                              |                   |   (depending on suffix + referenced-by)
 */
export function classify(input: ClassifyInput): Classification {
  const { schemaModel, cacheConfig, probe, ignoreSuffixes, ignoreTypes } = input;

  const suffixRegex = buildSuffixRegex(ignoreSuffixes);
  const customByName = new Map<string, CustomCacheInfo>();
  for (const c of cacheConfig.customHandled) customByName.set(c.name, c);

  const nodeImplemented: string[] = [];
  const apolloCompatibleNotNode: string[] = [];
  const valueObject: ValueObjectInfo[] = [];
  const customHandled: CustomCacheInfo[] = [];
  const customButNotNode: CustomCacheInfo[] = [];
  const nodePromotionCandidate: NodeCandidateInfo[] = [];
  const invalidKeyFields: InvalidKeyFieldsInfo[] = [...probe.invalidKeyFields];

  for (const t of schemaModel.objectTypes) {
    if (ignoreTypes.has(t.name)) continue;

    const outcome = probe.outcomes.get(t.name);
    if (outcome?.reason === "invalid-keyfields") {
      // Already collected in invalidKeyFields above; don't double-classify.
      continue;
    }

    const isNode = schemaModel.nodeImplementorNames.has(t.name);
    const custom = customByName.get(t.name);

    if (outcome?.normalizes) {
      if (custom) {
        if (isNode) customHandled.push(custom);
        else customButNotNode.push(custom);
      } else if (isNode) {
        nodeImplemented.push(t.name);
      } else {
        // Apollo cache normalizes (id/_id field present), but the schema does not
        // declare Node interface implementation. Informational — Apollo works,
        // but Relay GOI is non-compliant.
        apolloCompatibleNotNode.push(t.name);
      }
      continue;
    }

    const fields = t.getFields();
    if (Object.keys(fields).length === 0) {
      valueObject.push({ name: t.name, reason: "no-fields" });
      continue;
    }

    if (suffixRegex && suffixRegex.test(t.name)) {
      valueObject.push({ name: t.name, reason: "suffix-match" });
      continue;
    }

    const parents = schemaModel.referencedBy.get(t.name) ?? new Set<string>();
    const normalizedParents = [...parents].filter((p) => {
      const po = probe.outcomes.get(p);
      return Boolean(po?.normalizes);
    });
    if (normalizedParents.length === 0) {
      valueObject.push({ name: t.name, reason: "not-referenced-from-node" });
      continue;
    }

    const referencedFromSorted = normalizedParents.sort();
    nodePromotionCandidate.push({
      name: t.name,
      referencedFrom: referencedFromSorted,
      line: schemaModel.lineByType.get(t.name),
      file: schemaModel.schemaFilePath,
      recommendation: recommend({
        type: t,
        referencedFrom: referencedFromSorted,
        activeIgnoreSuffixes: ignoreSuffixes,
      }),
    });
  }

  nodeImplemented.sort();
  apolloCompatibleNotNode.sort();
  valueObject.sort((a, b) => a.name.localeCompare(b.name));
  customHandled.sort((a, b) => a.name.localeCompare(b.name));
  customButNotNode.sort((a, b) => a.name.localeCompare(b.name));
  nodePromotionCandidate.sort((a, b) => a.name.localeCompare(b.name));
  invalidKeyFields.sort((a, b) => a.type.localeCompare(b.type));

  return {
    nodeImplemented,
    apolloCompatibleNotNode,
    valueObject,
    customHandled,
    customButNotNode,
    nodePromotionCandidate,
    invalidKeyFields,
  };
}

function buildSuffixRegex(suffixes: string[]): RegExp | undefined {
  const trimmed = suffixes.map((s) => s.trim()).filter(Boolean);
  if (trimmed.length === 0) return undefined;
  const escaped = trimmed.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(${escaped.join("|")})$`);
}
