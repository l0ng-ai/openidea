import type { KnipConfig } from "knip";

const config: KnipConfig = {
  // Standalone browser fixtures are loaded by their own HTML pages.
  entry: ["e2e/*.fixture.{ts,tsx}"],
  // Entries come from the Vite (index.html), Vitest, Playwright and package.json script plugins.
  project: [
    "src/**/*.{ts,tsx,css}",
    "!src/editor/core/cm/angular/parser.terms.ts",
    "scripts/**/*.ts",
    "perf/**/*.ts",
    "e2e/**/*.ts",
  ],
  ignoreExportsUsedInFile: true,
  // lint-staged formats Rust files with the toolchain's rustfmt.
  ignoreBinaries: ["rustfmt"],
  compilers: {
    // Fonts come in through `@import` in global.css.
    css: (text: string) => [...text.matchAll(/(?<=@)import[^;]+/g)].join("\n"),
  },
};

export default config;
