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
import type { CacheConfigConflictInfo, CustomCacheInfo } from "../types.js";

export interface CacheConfigModel {
  /** Types reachable via dataIdFromObject (switch/if branches with string literals). */
  dataIdTypes: Set<string>;
  /** Types with typePolicies[T].keyFields. value omitted -> false/null/[] (un-normalized). */
  keyFieldsTypes: Map<string, readonly string[] | "fn" | false>;
  /** Combined view for downstream consumption. */
  customHandled: CustomCacheInfo[];
  /** typePolicies typenames seen, regardless of keyFields presence. */
  typePolicyTypes: Set<string>;
  /** Cross-file conflicts when multiple cache-config inputs disagree on the same type. */
  conflicts: CacheConfigConflictInfo[];
}

export interface LoadCacheConfigInput {
  /** Single path or multiple paths to merge. */
  cacheConfigPath: string | string[];
  tsConfigPath?: string;
}

export function loadCacheConfig({
  cacheConfigPath,
  tsConfigPath,
}: LoadCacheConfigInput): CacheConfigModel {
  const paths = Array.isArray(cacheConfigPath) ? cacheConfigPath : [cacheConfigPath];
  if (paths.length === 0) {
    throw new Error("cacheConfigPath must contain at least one path");
  }

  const merged: CacheConfigModel = {
    dataIdTypes: new Set(),
    keyFieldsTypes: new Map(),
    customHandled: [],
    typePolicyTypes: new Set(),
    conflicts: [],
  };

  // Track per-file extractions so we can detect cross-file conflicts on keyFields.
  const sourcesByType = new Map<
    string,
    Array<{ source: string; keyFields: readonly string[] | "fn" | false }>
  >();

  for (const p of paths) {
    const project = createProject(p, tsConfigPath);
    const entry = project.addSourceFileAtPath(resolve(p));
    const configObjects = findInMemoryCacheConfigs(entry);

    const fileModel: CacheConfigModel = {
      dataIdTypes: new Set(),
      keyFieldsTypes: new Map(),
      customHandled: [],
      typePolicyTypes: new Set(),
      conflicts: [],
    };
    for (const obj of configObjects) extractFromConfigObject(obj, fileModel);

    for (const t of fileModel.dataIdTypes) merged.dataIdTypes.add(t);
    for (const t of fileModel.typePolicyTypes) merged.typePolicyTypes.add(t);
    for (const [t, kf] of fileModel.keyFieldsTypes) {
      const prior = sourcesByType.get(t) ?? [];
      prior.push({ source: p, keyFields: kf });
      sourcesByType.set(t, prior);
      if (!merged.keyFieldsTypes.has(t)) {
        // First write wins; conflicts are reported below.
        merged.keyFieldsTypes.set(t, kf);
      }
    }
  }

  // Detect conflicts: type seen in >1 source with divergent keyFields specs.
  for (const [type, entries] of sourcesByType) {
    if (entries.length < 2) continue;
    const seen = new Set<string>();
    const unique: Array<readonly string[] | "fn" | false> = [];
    const sources: string[] = [];
    for (const e of entries) {
      const sig = signatureOfKeyFields(e.keyFields);
      if (!seen.has(sig)) {
        seen.add(sig);
        unique.push(e.keyFields);
        sources.push(e.source);
      }
    }
    if (unique.length > 1) {
      merged.conflicts.push({ type, keyFields: unique, sources });
    }
  }

  for (const t of merged.dataIdTypes) {
    merged.customHandled.push({ name: t, via: "dataIdFromObject" });
  }
  for (const [t, keyFields] of merged.keyFieldsTypes) {
    // keyFields: false is also "custom-handled" — it's an explicit user declaration that
    // this type should NOT be normalized. Surface it so we don't suggest the user add an id.
    merged.customHandled.push({
      name: t,
      via: "typePolicies.keyFields",
      keyFields,
    });
  }

  return merged;
}

function signatureOfKeyFields(kf: readonly string[] | "fn" | false): string {
  if (kf === false) return "false";
  if (kf === "fn") return "fn";
  return JSON.stringify([...kf]);
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
    const unwrapped = unwrapTypeAnnotations(cur);
    if (unwrapped !== cur) {
      cur = unwrapped;
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

/**
 * Strip type-system wrappers (parens, `as const`, `as T`, type assertions, `satisfies T`)
 * around a value expression. Returns the original node if nothing to strip.
 */
function unwrapTypeAnnotations(n: Node): Node {
  if (Node.isParenthesizedExpression(n)) return n.getExpression();
  if (Node.isAsExpression(n)) return n.getExpression();
  if (Node.isTypeAssertion(n)) return n.getExpression();
  if (Node.isSatisfiesExpression(n)) return n.getExpression();
  return n;
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
  for (const prop of obj.getProperties()) {
    // Spread: { ...basePolicies } — recurse into the spread source object.
    if (Node.isSpreadAssignment(prop)) {
      const inner = resolveToObjectLiteral(prop.getExpression());
      if (inner) extractFromConfigObject(inner, out);
      continue;
    }

    let name: string | undefined;
    let body: Node | undefined;

    if (Node.isPropertyAssignment(prop)) {
      name = getPropertyName(prop);
      body = prop.getInitializer();
    } else if (Node.isMethodDeclaration(prop)) {
      // Method shorthand: `dataIdFromObject(o) { ... }` is the same as the property-assignment
      // form. Pass the MethodDeclaration itself; extractDataIdSwitchCases unwraps to .getBody().
      const nameNode = prop.getNameNode();
      if (Node.isIdentifier(nameNode) || Node.isStringLiteral(nameNode)) {
        name = nameNode.getText().replace(/^["']|["']$/g, "");
        body = prop;
      }
    }

    if (!name || !body) continue;

    if (name === "dataIdFromObject") {
      extractDataIdSwitchCases(body, out.dataIdTypes);
    } else if (name === "typePolicies") {
      const resolved = resolveToObjectLiteral(body as Expression);
      if (resolved) extractTypePolicies(resolved, out);
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
  // Function shapes that may carry the dataIdFromObject body:
  //   - arrow: `dataIdFromObject: (o) => {...}`
  //   - function expression: `dataIdFromObject: function(o) {...}`
  //   - method shorthand: `dataIdFromObject(o) {...}`
  const body =
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isFunctionDeclaration(node)
      ? node.getBody()
      : node;
  if (!body) return;

  // Pattern 1: `case 'X':` and `case CONST:` (where CONST resolves to a string literal)
  // in switch statements.
  for (const cc of body.getDescendantsOfKind(SyntaxKind.CaseClause)) {
    const expr = cc.getExpression();
    const literal = resolveToStringLiteral(expr);
    if (literal !== undefined) out.add(literal);
  }

  // Pattern 2: `obj.__typename === 'X'` / `'X' === obj.__typename` comparisons.
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

  // Pattern 3: object dispatch — `{ Foo: ..., Bar: ... }[obj.__typename]` or
  //                              `HANDLERS[obj.__typename]` where HANDLERS is a const map.
  for (const access of body.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
    const argument = access.getArgumentExpression();
    if (!argument || !isTypenameAccess(argument)) continue;
    const dispatchObj = resolveElementAccessTarget(access.getExpression());
    if (!dispatchObj) continue;
    for (const prop of dispatchObj.getProperties()) {
      if (Node.isPropertyAssignment(prop)) {
        const name = getPropertyName(prop);
        if (name) out.add(name);
      }
    }
  }

  // Pattern 4: array membership — `KNOWN_TYPES.includes(obj.__typename)` or
  //                                `['Foo', 'Bar'].includes(obj.__typename)`.
  for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    if (callee.getName() !== "includes") continue;
    const args = call.getArguments();
    if (args.length !== 1) continue;
    const firstArg = args[0];
    if (!firstArg || !isTypenameAccess(firstArg)) continue;
    const arr = resolveToArrayLiteral(callee.getExpression());
    if (!arr) continue;
    for (const el of arr.getElements()) {
      if (Node.isStringLiteral(el) || Node.isNoSubstitutionTemplateLiteral(el)) {
        out.add(el.getLiteralText());
      }
    }
  }

  // Pattern 5: Map dispatch — `MAP.get(obj.__typename)` where MAP is `new Map([[K, V], ...])`.
  for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    if (callee.getName() !== "get") continue;
    const args = call.getArguments();
    if (args.length !== 1) continue;
    const firstArg = args[0];
    if (!firstArg || !isTypenameAccess(firstArg)) continue;
    const tuples = resolveToNewMapInitializer(callee.getExpression());
    if (!tuples) continue;
    for (const tuple of tuples) {
      if (Node.isStringLiteral(tuple) || Node.isNoSubstitutionTemplateLiteral(tuple)) {
        out.add(tuple.getLiteralText());
      }
    }
  }
}

/**
 * For an expression that should resolve to `new Map([[K1, V1], [K2, V2], ...])`, return the
 * list of K nodes. Handles identifier indirection and as-const wrappers.
 */
function resolveToNewMapInitializer(node: Node): Node[] | undefined {
  let cur: Node = node;
  for (let i = 0; i < 8; i++) {
    const stripped = unwrapTypeAnnotations(cur);
    if (stripped !== cur) {
      cur = stripped;
      continue;
    }
    if (Node.isIdentifier(cur)) {
      const resolved = followIdentifier(cur);
      if (!resolved) return undefined;
      cur = resolved;
      continue;
    }
    break;
  }
  if (!Node.isNewExpression(cur)) return undefined;
  const ctor = cur.getExpression();
  if (ctor.getText() !== "Map") return undefined;
  const args = cur.getArguments();
  if (args.length !== 1) return undefined;
  const firstArg = args[0];
  if (!firstArg) return undefined;
  const arr = resolveToArrayLiteral(firstArg);
  if (!arr) return undefined;
  const keys: Node[] = [];
  for (const tuple of arr.getElements()) {
    const stripped = unwrapTypeAnnotations(tuple);
    const list = Node.isArrayLiteralExpression(stripped) ? stripped : undefined;
    if (!list) continue;
    const first = list.getElements()[0];
    if (first) keys.push(first);
  }
  return keys;
}

/**
 * Resolve an expression to its underlying string literal value, following identifier
 * references and stripping type wrappers (`as const`, `satisfies`, parens). Returns the
 * literal text or undefined if the value cannot be resolved statically.
 *
 * Supports `case CONST:` patterns where CONST is `const X = 'literal'` (possibly with
 * `as const`) or a member access into a const object.
 */
function resolveToStringLiteral(node: Node | undefined): string | undefined {
  let cur: Node | undefined = node;
  for (let i = 0; cur && i < 8; i++) {
    const stripped = unwrapTypeAnnotations(cur);
    if (stripped !== cur) {
      cur = stripped;
      continue;
    }
    if (Node.isStringLiteral(cur) || Node.isNoSubstitutionTemplateLiteral(cur)) {
      return cur.getLiteralText();
    }
    if (Node.isIdentifier(cur)) {
      const resolved = followIdentifier(cur);
      if (!resolved) return undefined;
      cur = resolved;
      continue;
    }
    if (Node.isPropertyAccessExpression(cur)) {
      // `Foo.TYPENAME` — look up the property in the resolved object literal.
      const obj = resolveToObjectLiteral(cur.getExpression() as Expression);
      if (!obj) return undefined;
      const propName = cur.getName();
      for (const prop of obj.getProperties()) {
        if (Node.isPropertyAssignment(prop)) {
          const name = getPropertyName(prop);
          if (name === propName) {
            const init = prop.getInitializer();
            if (init) return resolveToStringLiteral(init);
          }
        }
      }
      return undefined;
    }
    return undefined;
  }
  return undefined;
}

function isTypenameAccess(n: Node): boolean {
  if (Node.isPropertyAccessExpression(n) && n.getName() === "__typename") return true;
  if (Node.isParenthesizedExpression(n)) return isTypenameAccess(n.getExpression());
  if (Node.isAsExpression(n)) return isTypenameAccess(n.getExpression());
  if (Node.isSatisfiesExpression(n)) return isTypenameAccess(n.getExpression());
  if (Node.isTypeAssertion(n)) return isTypenameAccess(n.getExpression());
  // `obj.__typename ?? ""` or `obj.__typename || ""` — left side is what we care about.
  if (Node.isBinaryExpression(n)) {
    const op = n.getOperatorToken().getKind();
    if (op === SyntaxKind.QuestionQuestionToken || op === SyntaxKind.BarBarToken) {
      return isTypenameAccess(n.getLeft());
    }
  }
  // `obj?.__typename` — optional chain
  if (Node.isPropertyAccessExpression(n) && n.hasQuestionDotToken() && n.getName() === "__typename") {
    return true;
  }
  // `\`${obj.__typename}\`` — template literal with single __typename interpolation and
  // no surrounding text.
  if (Node.isTemplateExpression(n)) {
    const headText = n.getHead().getLiteralText();
    const spans = n.getTemplateSpans();
    if (headText === "" && spans.length === 1) {
      const span = spans[0];
      if (span) {
        const tail = span.getLiteral().getLiteralText();
        if (tail === "") return isTypenameAccess(span.getExpression());
      }
    }
  }
  return false;
}

function resolveElementAccessTarget(node: Node): ObjectLiteralExpression | undefined {
  if (Node.isObjectLiteralExpression(node)) return node;
  if (Node.isIdentifier(node)) {
    const resolved = followIdentifier(node);
    if (resolved && Node.isObjectLiteralExpression(resolved)) return resolved;
  }
  return undefined;
}

function resolveToArrayLiteral(node: Node): import("ts-morph").ArrayLiteralExpression | undefined {
  let cur: Node = node;
  for (let i = 0; i < 8; i++) {
    const stripped = unwrapTypeAnnotations(cur);
    if (stripped !== cur) {
      cur = stripped;
      continue;
    }
    if (Node.isArrayLiteralExpression(cur)) return cur;
    if (Node.isIdentifier(cur)) {
      const resolved = followIdentifier(cur);
      if (!resolved) return undefined;
      cur = resolved;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function extractTypenameLiteral(
  side: Node,
  other: Node,
): string | undefined {
  if (
    isTypenameAccess(side) &&
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
