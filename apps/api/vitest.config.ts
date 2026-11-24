import { defineConfig } from "vitest/config";

// Plain Node tests: the Worker's dependencies are Effect services, so tests
// provide fakes (test/support/fakes.ts) instead of running inside workerd.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
