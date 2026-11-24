import { defineConfig } from "vitest/config";

// Plain Node tests: the Worker's dependencies are Effect services, so unit
// tests provide fakes (test/support/fakes.ts) instead of running inside
// workerd. The HTTP contract tests (test/contract) start the real Worker in
// workerd themselves, through wrangler's test harness.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
