/**
 * Backend smoke tests (`pnpm smoke`): the frontend's own modules driving a real
 * `openidea-server` and real toolchains. Not part of `pnpm test`: they need the server
 * built (`cargo build -p ide-host --bin openidea-server`) and each language's tools.
 */
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "../vite.config.ts";

export default mergeConfig(
  viteConfig({ command: "serve", mode: "test" }),
  defineConfig({
    test: {
      include: ["smoke/**/*.test.ts"],
      testTimeout: 10 * 60_000,
      hookTimeout: 5 * 60_000,
      // Each file starts a server and toolchains of its own.
      fileParallelism: false,
    },
  }),
);
