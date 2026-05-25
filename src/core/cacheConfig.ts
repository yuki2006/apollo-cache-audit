import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  Node,
  Project,
  SyntaxKind,
  type CallExpression,
  type Expression,
  type Identifier,
  type NewExpression,
  type ObjectLiteralExpression,
  type PropertyAssignment,
  type SourceFile,
} from "ts-morph";
import type { CustomCacheInfo } from "../types.js";

export interface CacheConfigModel {
  /** Types reachable via dataIdFromObject (switch/if branches with string literals). */
  dataIdTypes: Set<string>;
  /** Types with typePolicies[T].keyFields. value omitted -> false/null/[] (un-normalized). */
  keyFieldsTypes: Map<string, readonly string[] | "fn" | false>;
  /** Combined view for downstream consumption. */
  customHandled: CustomCacheInfo[];
  /** typePolicies typenames seen, regardless of keyFields presence. */
  typePolicyTypes: Set<string>;
}

export interface LoadCacheConfigInput {
  cacheConfigPath: string;
  tsConfigPath?: string;
}

export function loadCacheConfig({
  cacheConfigPath,
  tsConfigPath,
}: LoadCacheConfigInput): CacheConfigModel {
  const project = createProject(cacheConfigPath, tsConfigPath);
  const entry = project.addSourceFileAtPath(resolve(cacheConfigPath));

  const configObjects = findInMemoryCacheConfigs(entry);
  const merged: CacheConfigModel = {
    dataIdTypes: new Set(),
    keyFieldsTypes: new Map(),
    customHandled: [],
    typePolicyTypes: new Set(),
  };

  for (const obj of configObjects) {
    extractFromConfigObject(obj, merged);
  }

  for (const t of merged.dataIdTypes) {
    merged.customHandled.push({ name: t, via: "dataIdFromObject" });
  }
  for (const [t, keyFields] of merged.keyFieldsTypes) {
    if (keyFields === false) continue;
    merged.customHandled.push({
      name: t,
      via: "typePolicies.keyFields",
      keyFields,
    });
  }

  return merged;
}

function createProject(cacheConfigPath: string, tsConfigPath?: string): Project {
  const resolvedTsConfig =
    tsConfigPath ?? findNearestTsConfig(dirname(resolve(cacheConfigPath)));
  if (resolvedTsConfig) {
    return new Project({
      tsConfigFilePath: resolvedTsConfig,
      skipAddingFilesFromTsConfig: true,
    });
  }
  return new Project({
    compilerOptions: {
      allowJs: true,
      target: 99 /* ESNext */,
      module: 99 /* ESNext */,
      moduleResolution: 100 /* Bundler */,
    },
  });
}

function findNearestTsConfig(startDir: string): string | undefined {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

function findInMemoryCacheConfigs(entry: SourceFile): ObjectLiteralExpression[] {
  const news = entry.getDescendantsOfKind(SyntaxKind.NewExpression);
  const out: ObjectLiteralExpression[] = [];
  for (const ne of news) {
    if (!isInMemoryCacheCtor(ne)) continue;
    const arg = ne.getArguments()[0];
    if (!arg) continue;
    const obj = resolveToObjectLiteral(arg as Expression);
    if (obj) out.push(obj);
  }
  return out;
}

function isInMemoryCacheCtor(ne: NewExpression): boolean {
  const expr = ne.getExpression();
  if (Node.isIdentifier(expr)) return expr.getText() === "InMemoryCache";
  if (Node.isPropertyAccessExpression(expr)) {
    return expr.getName() === "InMemoryCache";
  }
  return false;
}

/**
 * Reduce an arbitrary expression to an ObjectLiteralExpression by walking through
 * common patterns: identifier references, factory calls returning literals, parens.
 * Returns undefined when the value cannot be resolved statically.
 */
function resolveToObjectLiteral(expr: Expression): ObjectLiteralExpression | undefined {
  let cur: Node | undefined = expr;
  const seen = new Set<Node>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (Node.isParenthesizedExpression(cur)) {
      cur = cur.getExpression();
      continue;
    }
    if (Node.isAsExpression(cur) || Node.isTypeAssertion(cur)) {
      cur = cur.getExpression();
      continue;
    }
    if (Node.isObjectLiteralExpression(cur)) return cur;
    if (Node.isIdentifier(cur)) {
      const next = followIdentifier(cur);
      if (!next) return undefined;
      cur = next;
      continue;
    }
    if (Node.isCallExpression(cur)) {
      const ret = followCallReturn(cur);
      if (!ret) return undefined;
      cur = ret;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function followIdentifier(id: Identifier): Node | undefined {
  const defs = id.getDefinitionNodes();
  for (const def of defs) {
    if (Node.isVariableDeclaration(def)) {
      const init = def.getInitializer();
      if (init) return init;
    }
    if (Node.isExportSpecifier(def)) {
      const local = def.getLocalTargetSymbol() ?? def.getSymbol();
      const decls = local?.getDeclarations() ?? [];
      for (const d of decls) {
        if (Node.isVariableDeclaration(d)) {
          const init = d.getInitializer();
          if (init) return init;
        }
      }
    }
    if (Node.isImportSpecifier(def)) {
      const local = def.getSymbol();
      const decls = local?.getDeclarations() ?? [];
      for (const d of decls) {
        if (Node.isVariableDeclaration(d)) {
          const init = d.getInitializer();
          if (init) return init;
        }
      }
    }
    if (Node.isFunctionDeclaration(def) || Node.isFunctionExpression(def) || Node.isArrowFunction(def)) {
      return def;
    }
  }
  return undefined;
}

function followCallReturn(call: CallExpression): Node | undefined {
  const callee = call.getExpression();
  if (!Node.isIdentifier(callee)) return undefined;
  const defs = callee.getDefinitionNodes();
  for (const def of defs) {
    const fn = unwrapToFunction(def);
    if (!fn) continue;
    const body = (fn as any).getBody?.();
    if (!body || !Node.isBlock(body)) {
      const eq = (fn as any).getEqualsGreaterThan?.();
      const arrowBody = Node.isArrowFunction(fn) ? fn.getBody() : undefined;
      if (arrowBody && !Node.isBlock(arrowBody)) return arrowBody;
      if (eq) continue;
    }
    if (body && Node.isBlock(body)) {
      const returns = body.getDescendantsOfKind(SyntaxKind.ReturnStatement);
      for (const r of returns) {
        const e = r.getExpression();
        if (e) return e;
      }
    }
  }
  return undefined;
}

function unwrapToFunction(def: Node): Node | undefined {
  if (Node.isFunctionDeclaration(def)) return def;
  if (Node.isArrowFunction(def) || Node.isFunctionExpression(def)) return def;
  if (Node.isVariableDeclaration(def)) {
    const init = def.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      return init;
    }
  }
  return undefined;
}

function extractFromConfigObject(obj: ObjectLiteralExpression, out: CacheConfigModel) {
  for (const prop of getAllProperties(obj)) {
    const name = getPropertyName(prop);
    if (!name) continue;
    if (name === "dataIdFromObject") {
      const init = prop.getInitializer();
      if (init) extractDataIdSwitchCases(init, out.dataIdTypes);
    } else if (name === "typePolicies") {
      const init = prop.getInitializer();
      if (init) {
        const resolved = resolveToObjectLiteral(init as Expression);
        if (resolved) extractTypePolicies(resolved, out);
      }
    }
  }
}

/**
 * Walk a possibly-spread object literal: { ...A, b: 1, ...C } -> [b:1] plus
 * the properties of A and C resolved recursively.
 */
function getAllProperties(obj: ObjectLiteralExpression): PropertyAssignment[] {
  const out: PropertyAssignment[] = [];
  for (const p of obj.getProperties()) {
    if (Node.isPropertyAssignment(p)) {
      out.push(p);
    } else if (Node.isSpreadAssignment(p)) {
      const spread = p.getExpression();
      const inner = resolveToObjectLiteral(spread);
      if (inner) out.push(...getAllProperties(inner));
    }
    // ShorthandPropertyAssignment / MethodDeclaration intentionally ignored:
    // dataIdFromObject is normally a property assignment; if it's a method,
    // we still handle below via getInitializer fallback.
  }
  return out;
}

function getPropertyName(p: PropertyAssignment): string | undefined {
  const nameNode = p.getNameNode();
  if (Node.isIdentifier(nameNode) || Node.isStringLiteral(nameNode)) {
    return nameNode.getText().replace(/^["']|["']$/g, "");
  }
  return undefined;
}

function extractDataIdSwitchCases(node: Node, out: Set<string>) {
  // Function: arrow/expression/declaration — walk into its body.
  const body =
    Node.isArrowFunction(node) || Node.isFunctionExpression(node)
      ? node.getBody()
      : node;
  if (!body) return;

  // Find case clauses with string literal labels.
  for (const cc of body.getDescendantsOfKind(SyntaxKind.CaseClause)) {
    const expr = cc.getExpression();
    if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
      out.add(expr.getLiteralText());
    }
  }
  // Find `obj.__typename === 'X'` / `'X' === obj.__typename` comparisons.
  for (const bin of body.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    const op = bin.getOperatorToken().getKind();
    if (
      op !== SyntaxKind.EqualsEqualsEqualsToken &&
      op !== SyntaxKind.EqualsEqualsToken
    ) {
      continue;
    }
    const left = bin.getLeft();
    const right = bin.getRight();
    const tname = extractTypenameLiteral(left, right) ?? extractTypenameLiteral(right, left);
    if (tname) out.add(tname);
  }
}

function extractTypenameLiteral(
  side: Node,
  other: Node,
): string | undefined {
  if (
    Node.isPropertyAccessExpression(side) &&
    side.getName() === "__typename" &&
    (Node.isStringLiteral(other) || Node.isNoSubstitutionTemplateLiteral(other))
  ) {
    return other.getLiteralText();
  }
  return undefined;
}

function extractTypePolicies(obj: ObjectLiteralExpression, out: CacheConfigModel) {
  for (const prop of getAllProperties(obj)) {
    const typeName = getPropertyName(prop);
    if (!typeName) continue;
    out.typePolicyTypes.add(typeName);

    const init = prop.getInitializer();
    if (!init) continue;
    const policyObj = resolveToObjectLiteral(init as Expression);
    if (!policyObj) continue;

    const keyFields = extractKeyFields(policyObj);
    if (keyFields !== undefined) {
      out.keyFieldsTypes.set(typeName, keyFields);
    }
  }
}

function extractKeyFields(policy: ObjectLiteralExpression): readonly string[] | "fn" | false | undefined {
  for (const prop of getAllProperties(policy)) {
    if (getPropertyName(prop) !== "keyFields") continue;
    const init = prop.getInitializer();
    if (!init) return undefined;

    if (Node.isArrayLiteralExpression(init)) {
      const fields: string[] = [];
      for (const el of init.getElements()) {
        if (Node.isStringLiteral(el) || Node.isNoSubstitutionTemplateLiteral(el)) {
          fields.push(el.getLiteralText());
        }
      }
      return fields;
    }
    if (Node.isFalseLiteral(init)) return false;
    if (init.getKind() === SyntaxKind.NullKeyword) return false;
    if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) return "fn";
    if (Node.isIdentifier(init)) {
      const resolved = followIdentifier(init);
      if (resolved && (Node.isArrowFunction(resolved) || Node.isFunctionExpression(resolved))) {
        return "fn";
      }
      if (resolved && Node.isArrayLiteralExpression(resolved)) {
        const fields: string[] = [];
        for (const el of resolved.getElements()) {
          if (Node.isStringLiteral(el) || Node.isNoSubstitutionTemplateLiteral(el)) {
            fields.push(el.getLiteralText());
          }
        }
        return fields;
      }
    }
  }
  return undefined;
}
