import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  buildSchema,
  GraphQLInterfaceType,
  GraphQLObjectType,
  GraphQLSchema,
  isInterfaceType,
  isObjectType,
  type GraphQLNamedType,
} from "graphql";

const ROOT_TYPE_NAMES = new Set(["Query", "Mutation", "Subscription"]);

export interface SchemaModel {
  schema: GraphQLSchema;
  schemaHash: string;
  schemaFilePath?: string;
  /** All Object types except introspection (__*) and root operation types. */
  objectTypes: GraphQLObjectType[];
  /** Object types that implement the Node interface. */
  nodeImplementorNames: Set<string>;
  /** typeName -> set of parent type names that reference it as a field. */
  referencedBy: Map<string, Set<string>>;
  /** typeName -> 1-indexed line number from SDL location (if available). */
  lineByType: Map<string, number>;
  nodeInterface: GraphQLInterfaceType | undefined;
}

export interface LoadSchemaInput {
  schema: string;
  nodeInterface: string;
}

/**
 * Accepts either:
 *   - a filesystem path to a .graphql / .graphqls file
 *   - raw SDL text (detected by presence of `type ` / `schema ` / `interface ` keywords
 *     when the path doesn't exist on disk)
 */
export function loadSchema({ schema, nodeInterface }: LoadSchemaInput): SchemaModel {
  let sdl: string;
  let schemaFilePath: string | undefined;
  try {
    sdl = readFileSync(schema, "utf8");
    schemaFilePath = schema;
  } catch {
    sdl = schema;
  }

  const built = buildSchema(sdl, { assumeValidSDL: true });
  return analyzeSchema(built, sdl, nodeInterface, schemaFilePath);
}

export function analyzeSchema(
  schema: GraphQLSchema,
  sdl: string,
  nodeInterfaceName: string,
  schemaFilePath?: string,
): SchemaModel {
  const schemaHash = createHash("sha256").update(sdl).digest("hex");

  const typeMap = schema.getTypeMap();
  const objectTypes: GraphQLObjectType[] = [];
  for (const name of Object.keys(typeMap)) {
    if (name.startsWith("__")) continue;
    if (ROOT_TYPE_NAMES.has(name)) continue;
    const t = typeMap[name];
    if (t && isObjectType(t)) objectTypes.push(t);
  }

  const nodeIface = findNodeInterface(typeMap, nodeInterfaceName);

  const nodeImplementorNames = new Set<string>();
  if (nodeIface) {
    for (const obj of objectTypes) {
      if (obj.getInterfaces().some((i) => i.name === nodeIface.name)) {
        nodeImplementorNames.add(obj.name);
      }
    }
  }

  const referencedBy = buildReferenceGraph(objectTypes, schema);
  const lineByType = collectLineNumbers(objectTypes);

  return {
    schema,
    schemaHash,
    schemaFilePath,
    objectTypes,
    nodeImplementorNames,
    referencedBy,
    lineByType,
    nodeInterface: nodeIface,
  };
}

function findNodeInterface(
  typeMap: Record<string, GraphQLNamedType | undefined>,
  nodeInterfaceName: string,
): GraphQLInterfaceType | undefined {
  const t = typeMap[nodeInterfaceName];
  if (t && isInterfaceType(t)) return t;
  return undefined;
}

/**
 * For each Object type T, collect the set of parent Object types whose fields
 * return T (directly, through NonNull/List wrappers, or via an interface/union
 * whose member is T).
 */
function buildReferenceGraph(
  objectTypes: GraphQLObjectType[],
  schema: GraphQLSchema,
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();

  const addEdge = (child: string, parent: string) => {
    let set = graph.get(child);
    if (!set) {
      set = new Set<string>();
      graph.set(child, set);
    }
    set.add(parent);
  };

  for (const parent of objectTypes) {
    const fields = parent.getFields();
    for (const fieldName of Object.keys(fields)) {
      const field = fields[fieldName];
      if (!field) continue;
      const named = unwrapNamedTypeName(field.type);
      if (!named) continue;
      const namedType = schema.getType(named);
      if (!namedType) continue;
      if (isObjectType(namedType)) {
        addEdge(namedType.name, parent.name);
      } else if (isInterfaceType(namedType)) {
        for (const impl of schema.getImplementations(namedType).objects) {
          addEdge(impl.name, parent.name);
        }
      }
    }
  }

  return graph;
}

function unwrapNamedTypeName(type: unknown): string | undefined {
  let cur: any = type;
  while (cur && typeof cur === "object" && "ofType" in cur) {
    cur = cur.ofType;
  }
  if (cur && typeof cur === "object" && typeof cur.name === "string") {
    return cur.name;
  }
  return undefined;
}

function collectLineNumbers(objectTypes: GraphQLObjectType[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of objectTypes) {
    const loc = t.astNode?.loc;
    if (loc && loc.source && typeof loc.start === "number") {
      const line = loc.source.body.slice(0, loc.start).split("\n").length;
      out.set(t.name, line);
    }
  }
  return out;
}
