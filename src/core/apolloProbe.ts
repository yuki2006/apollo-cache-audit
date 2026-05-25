import {
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLEnumType,
  isEnumType,
  isScalarType,
  getNamedType,
} from "graphql";
// Apollo's package.json subpath export resolution differs across bundlers; load via
// the runtime-resolved entry file directly to avoid ESM dir-import issues.
import { InMemoryCache, defaultDataIdFromObject } from "@apollo/client/cache/index.js";
import type { SchemaModel } from "./schema.js";
import type { CacheConfigModel } from "./cacheConfig.js";

export type ProbeReason =
  | "normalized-with-id"
  | "normalized-with-keyfields"
  | "normalized-via-custom-dataidfromobject"
  | "not-normalized-no-key"
  | "invalid-keyfields";

export interface ProbeOutcome {
  typeName: string;
  normalizes: boolean;
  key?: string;
  reason: ProbeReason;
  /** When invalid-keyfields, the missing field names. */
  missingKeyFields?: string[];
}

export interface ProbeResult {
  outcomes: Map<string, ProbeOutcome>;
  /** Type policies whose keyFields reference schema fields that do not exist. */
  invalidKeyFields: Array<{ type: string; missingFields: string[] }>;
}

interface ProbeOptions {
  /** Sentinel value used by our synthetic dataIdFromObject for types in the static dataIdTypes set. */
  customSentinel?: string;
}

/**
 * Build a real InMemoryCache from the statically-extracted cache config, then probe each schema
 * Object type with a synthetic instance to determine whether Apollo would normalize it.
 *
 * - Types whose schema has an `id` or `_id` field will normalize via the default dataIdFromObject.
 * - Types with array-form `typePolicies[T].keyFields` will normalize iff the schema declares those
 *   fields; if a referenced field is missing on the schema type, Apollo throws an InvariantError
 *   at identify() time, which we surface as `invalid-keyfields`.
 * - Types listed in the static `dataIdFromObject` switch are treated as normalizable via the
 *   custom-handler path (we cannot reproduce arbitrary user code, but we know the user intends
 *   it to be normalized).
 * - Function-form `keyFields` are also treated as custom-handled.
 */
export function buildProbe(
  schemaModel: SchemaModel,
  cacheConfig: CacheConfigModel,
  opts: ProbeOptions = {},
): ProbeResult {
  const customSentinel = opts.customSentinel ?? "__probe__";
  const arrayKeyFields = new Map<string, readonly string[]>();
  const functionKeyFields = new Set<string>();
  const falseKeyFields = new Set<string>();
  for (const [t, kf] of cacheConfig.keyFieldsTypes) {
    if (Array.isArray(kf)) arrayKeyFields.set(t, kf);
    else if (kf === "fn") functionKeyFields.add(t);
    else if (kf === false) falseKeyFields.add(t);
  }

  const typePolicies: Record<string, { keyFields: readonly string[] | false }> = {};
  for (const [t, kf] of arrayKeyFields) {
    typePolicies[t] = { keyFields: kf };
  }
  for (const t of falseKeyFields) {
    typePolicies[t] = { keyFields: false };
  }

  const dataIdTypes = cacheConfig.dataIdTypes;
  const cache = new InMemoryCache({
    typePolicies,
    // Apollo replaces the default with whatever we pass; preserve default id/_id
    // behavior by delegating to defaultDataIdFromObject for types we don't
    // explicitly claim as custom-handled.
    dataIdFromObject: (obj, context) => {
      const tn = (obj as { __typename?: string }).__typename;
      if (tn && (dataIdTypes.has(tn) || functionKeyFields.has(tn))) {
        return `${tn}:${customSentinel}`;
      }
      return defaultDataIdFromObject(obj, context);
    },
  });

  const outcomes = new Map<string, ProbeOutcome>();
  const invalidKeyFields: ProbeResult["invalidKeyFields"] = [];

  // Pre-validate keyFields against schema (statically) for clearer error messages.
  for (const [t, fields] of arrayKeyFields) {
    const type = schemaModel.schema.getType(t);
    if (!(type instanceof GraphQLObjectType)) continue;
    const schemaFields = type.getFields();
    const missing = fields.filter((f) => !(f in schemaFields));
    if (missing.length > 0) {
      invalidKeyFields.push({ type: t, missingFields: [...missing] });
    }
  }

  const invalidTypes = new Map<string, string[]>();
  for (const i of invalidKeyFields) invalidTypes.set(i.type, [...i.missingFields]);

  for (const t of schemaModel.objectTypes) {
    // Skip Apollo identify() for types we already know would throw — avoids both the throw
    // and Apollo's stderr noise from its invariant() helper.
    if (invalidTypes.has(t.name)) {
      outcomes.set(t.name, {
        typeName: t.name,
        normalizes: false,
        reason: "invalid-keyfields",
        missingKeyFields: invalidTypes.get(t.name),
      });
      continue;
    }

    const synth = buildSyntheticInstance(t);
    let key: string | undefined;
    let reason: ProbeReason = "not-normalized-no-key";
    try {
      key = cache.identify(synth as Parameters<InMemoryCache["identify"]>[0]);
    } catch (err) {
      outcomes.set(t.name, {
        typeName: t.name,
        normalizes: false,
        reason: "invalid-keyfields",
        missingKeyFields: [],
      });
      continue;
    }

    if (!key) {
      reason = "not-normalized-no-key";
    } else if (key.endsWith(`:${customSentinel}`)) {
      reason = "normalized-via-custom-dataidfromobject";
    } else if (arrayKeyFields.has(t.name)) {
      reason = "normalized-with-keyfields";
    } else {
      reason = "normalized-with-id";
    }

    outcomes.set(t.name, {
      typeName: t.name,
      normalizes: Boolean(key),
      key,
      reason,
    });
  }

  return { outcomes, invalidKeyFields };
}

/**
 * Build a probe object containing __typename plus every scalar/enum field declared on the type.
 * Object/interface/union/list fields are omitted; what we need is whether keyFields and id/_id
 * resolve, and those are always scalar/enum.
 */
function buildSyntheticInstance(type: GraphQLObjectType): Record<string, unknown> {
  const out: Record<string, unknown> = { __typename: type.name };
  const fields = type.getFields();
  for (const fname of Object.keys(fields)) {
    const f = fields[fname];
    if (!f) continue;
    const named = getNamedType(f.type);
    if (isScalarType(named) || isEnumType(named)) {
      out[fname] = probeValue(fname, named);
    }
  }
  return out;
}

function probeValue(
  fieldName: string,
  named: GraphQLScalarType | GraphQLEnumType,
): unknown {
  if (isEnumType(named)) {
    const v = named.getValues()[0];
    return v?.value ?? "probe";
  }
  switch (named.name) {
    case "Int":
    case "Float":
      return 1;
    case "Boolean":
      return true;
    case "ID":
    case "String":
    default:
      return fieldName === "id" || fieldName === "_id" ? "probe-id" : "probe";
  }
}
