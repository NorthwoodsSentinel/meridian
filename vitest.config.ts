// Test and coverage configuration. The coverage bar is the source's (Cliff Hall's
// inspector): >= 90 on all four dimensions (lines, statements, functions, branches),
// per file, enforced here and therefore in `bun run test` and CI. The owner's ruling:
// the source's way stands until there is a reason to depart. Never lower it to pass.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // Every source file is gated, including ones no test imports yet: a new file
      // under src/ lands in the gate automatically.
      include: ["src/**/*.ts"],
      // Exact paths only, one per entry, never a glob, so an exclusion can never
      // hide a new file. Each entry names its reason or follow-up.
      exclude: [],
      thresholds: {
        perFile: true,
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
      },
    },
  },
});
