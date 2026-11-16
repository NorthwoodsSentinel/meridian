#!/usr/bin/env bun
// verify-gate-scope: a gate must show how much it checked (AGENTS.md "Always test new or modified code").
// Two silent-shrink failures this catches, both of which would leave the gate green while checking less:
//   1. a tracked .ts file outside the tsconfig project is never typechecked (or linted with types);
//   2. a source file under src/ missing from the coverage summary is never held to the 90% bar.
// It also refuses a glob in the coverage exclusion list (exclusions are exact paths only).
// Fix a failure by fixing the include globs, never by excusing the file.
// Runs after `vitest run --coverage`, which writes coverage/coverage-summary.json.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import config from "../vitest.config.ts";

const root = resolve(import.meta.dirname, "..");
const run = (cmd: string, args: string[]): string[] => {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean);
};

const excluded = (config.test?.coverage as { exclude?: string[] } | undefined)?.exclude ?? [];
const globbed = excluded.filter((e) => /[*?{}[\]]/.test(e));

const tracked = run("git", [
  "ls-files",
  "--cached",
  "--others",
  "--exclude-standard",
  "*.ts",
]).filter((f) => !f.startsWith("node_modules/"));
if (!tracked.length)
  throw new Error("verify-gate-scope: found no .ts files at all; the check itself is broken");

// 1. typecheck scope. Run the repo's own tsc directly, and treat an empty listing as a broken check.
const tsc = resolve(root, "node_modules/.bin/tsc");
if (!existsSync(tsc)) throw new Error(`verify-gate-scope: ${tsc} not found; run bun install`);
const listed = run(tsc, ["-p", "tsconfig.json", "--listFilesOnly"]);
if (!listed.length)
  throw new Error("verify-gate-scope: tsc listed no files; the check itself is broken");
const typed = new Set(listed.map((f) => relative(root, f)));
const untyped = tracked.filter((f) => !typed.has(f));

// 2. coverage scope
const summaryPath = resolve(root, "coverage/coverage-summary.json");
if (!existsSync(summaryPath))
  throw new Error("verify-gate-scope: no coverage summary; run vitest with --coverage first");
const measured = new Set(
  Object.keys(JSON.parse(readFileSync(summaryPath, "utf8")) as Record<string, unknown>)
    .filter((k) => k !== "total")
    .map((k) => relative(root, k)),
);
const sources = tracked.filter((f) => f.startsWith("src/") && !f.endsWith(".d.ts"));
const unmeasured = sources.filter((f) => !measured.has(f) && !excluded.includes(f));
const stale = excluded.filter((e) => !sources.includes(e));

console.log(
  `gate scope: typechecked ${tracked.length - untyped.length} of ${tracked.length} .ts files`,
);
console.log(
  `gate scope: coverage measured ${measured.size} of ${sources.length} src files, ${excluded.length} excluded by exact path`,
);
if (untyped.length || unmeasured.length || globbed.length || stale.length) {
  for (const f of untyped) console.error(`  not in the tsconfig project: ${f}`);
  for (const f of unmeasured) console.error(`  missing from coverage: ${f}`);
  for (const e of globbed) console.error(`  coverage exclusion is a glob, not an exact path: ${e}`);
  for (const e of stale) console.error(`  coverage exclusion names no tracked src file: ${e}`);
  process.exit(1);
}
