// The modules that run in a 代码判定红包's sandbox beside the sender's
// judge.js, copied from kit/runtime into the API as JSON so the Worker can
// hand them to Dynamic Workers (docs/programmable-hongbao-design.md §7).
// `bun scripts/judge-runtime.ts` writes the copy; `--check` fails if stale.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SANDBOX_MODULES = [
  "main.mjs",
  "prelude.mjs",
  "tools.mjs",
  "codes.mjs",
  "hash.mjs",
  "money.mjs",
  "random.mjs",
  "text.mjs",
  "time.mjs",
  "verdict.mjs",
] as const;

const root = join(import.meta.dirname, "..");
export const RUNTIME_COPY = join(
  root,
  "apps/api/src/judge/runtime.generated.json",
);

export function runtimeCopy() {
  const modules: Record<string, string> = {};
  for (const name of SANDBOX_MODULES)
    modules[name] = readFileSync(join(root, "kit/runtime", name), "utf8");
  return `${JSON.stringify(modules, null, 2)}\n`;
}

if (import.meta.main) {
  const expected = runtimeCopy();
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(RUNTIME_COPY, "utf8");
    } catch {}
    if (current !== expected) {
      console.error(
        "apps/api/src/judge/runtime.generated.json is stale: run bun scripts/judge-runtime.ts",
      );
      process.exit(1);
    }
  } else {
    writeFileSync(RUNTIME_COPY, expected);
    console.log(
      `Wrote ${SANDBOX_MODULES.length} modules to apps/api/src/judge/runtime.generated.json`,
    );
  }
}
