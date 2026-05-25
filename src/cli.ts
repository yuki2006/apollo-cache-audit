#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { Command } from "commander";
import { audit } from "./index.js";
import {
  buildBaseline,
  loadBaseline,
  writeBaseline,
} from "./core/baseline.js";
import { formatGithub } from "./formatters/github.js";
import { formatJson } from "./formatters/json.js";
import { formatText } from "./formatters/text.js";
import type { CliOptions, FailOn } from "./types.js";

const program = new Command();

program
  .name("apollo-cache-audit")
  .description(
    "Audit a GraphQL schema for entity-shaped types missing an id field, " +
      "which would silently break Apollo Client cache normalization.",
  )
  .requiredOption("--schema <path>", "Path to GraphQL SDL")
  .requiredOption("--cache-config <path>", "Path to TS/JS file with `new InMemoryCache(...)`")
  .option("--ts-config <path>", "tsconfig.json for cross-file resolution")
  .option("--node-interface <name>", "Interface name marking entities", "Node")
  .option("--ignore-suffixes <list>", "Comma-separated suffixes treated as value objects")
  .option("--ignore-types <list>", "Comma-separated type names to skip")
  .option("--baseline <path>", "Baseline JSON of known candidates")
  .option("--update-baseline", "Write current candidates to --baseline path")
  .option("--format <text|json|github>", "Output format", "text")
  .option(
    "--fail-on <none|new|suspect|all>",
    "Fail conditions: none=never, new=baseline-new, suspect=any candidate, all=any finding",
    "none",
  )
  .option("--fail-on-custom-without-node", "Exit non-zero on customButNotNode findings")
  .option("--fail-on-invalid-keyfields", "Exit non-zero when typePolicies.keyFields references missing schema fields")
  .option("--fail-on-not-node", "Exit non-zero on types that normalize via id but do not implement the Node interface")
  .option("--strict-recommend", "Omit recommendations with low confidence (only emit medium/high)")
  .option("--multi-hop", "Traverse transitively through non-normalized intermediates (may surface more candidates)")
  .option("--report <path>", "Write report to file (in --format)")
  .option("--verbose", "Verbose logging")
  .action(async (opts: CliOptions) => {
    try {
      await run(opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`apollo-cache-audit: ${msg}\n`);
      process.exit(2);
    }
  });

async function run(opts: CliOptions) {
  const ignoreSuffixes = splitList(opts.ignoreSuffixes);
  const ignoreTypes = splitList(opts.ignoreTypes);

  const result = await audit({
    schema: opts.schema,
    cacheConfig: opts.cacheConfig,
    tsConfigPath: opts.tsConfig,
    nodeInterface: opts.nodeInterface,
    ignoreSuffixes,
    ignoreTypes,
    baseline: opts.baseline,
    multiHop: opts.multiHop,
  });

  if (opts.strictRecommend) {
    for (const c of result.nodePromotionCandidate) {
      if (c.recommendation && c.recommendation.confidence === "low") {
        delete (c as { recommendation?: unknown }).recommendation;
      }
    }
  }

  if (opts.updateBaseline) {
    if (!opts.baseline) {
      throw new Error("--update-baseline requires --baseline <path>");
    }
    let prev;
    try {
      prev = loadBaseline(opts.baseline);
    } catch {
      prev = undefined;
    }
    const next = buildBaseline(
      result.nodePromotionCandidate,
      result.customButNotNode,
      result.schemaHash,
      prev,
    );
    writeBaseline(opts.baseline, next);
    process.stderr.write(`Updated baseline: ${opts.baseline}\n`);
  }

  const format = opts.format ?? "text";
  const baselineUsed = Boolean(opts.baseline) && !opts.updateBaseline;

  let rendered: string;
  switch (format) {
    case "json":
      rendered = formatJson(result);
      break;
    case "github":
      rendered = formatGithub(result, { baselineUsed, schemaFile: opts.schema });
      break;
    case "text":
    default:
      rendered = formatText(result, { baselineUsed });
      break;
  }

  if (opts.report) {
    writeFileSync(opts.report, rendered, "utf8");
  } else {
    process.stdout.write(rendered);
  }

  const failOn: FailOn = (opts.failOn ?? "none") as FailOn;
  let code = 0;
  switch (failOn) {
    case "all":
      if (
        result.nodePromotionCandidate.length > 0 ||
        result.customButNotNode.length > 0 ||
        result.invalidKeyFields.length > 0
      )
        code = 1;
      break;
    case "suspect":
      if (result.nodePromotionCandidate.length > 0) code = 1;
      break;
    case "new":
      if (baselineUsed && result.newSinceBaseline.length > 0) code = 1;
      break;
    case "none":
      break;
  }
  if (opts.failOnCustomWithoutNode && result.customButNotNode.length > 0) {
    code = 1;
  }
  if (opts.failOnInvalidKeyfields && result.invalidKeyFields.length > 0) {
    code = 1;
  }
  if (opts.failOnNotNode && result.apolloCompatibleNotNode.length > 0) {
    code = 1;
  }
  process.exit(code);
}

function splitList(s: string | undefined): string[] | undefined {
  if (!s) return undefined;
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

program.parseAsync(process.argv).catch((e) => {
  process.stderr.write(`apollo-cache-audit: ${String(e)}\n`);
  process.exit(2);
});
