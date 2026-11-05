import type { KnipConfig } from "knip";

const config: KnipConfig = {
  // Entries come from the Vite (index.html), Vitest, Playwright and package.json script plugins.
  project: [
    "src/**/*.{ts,tsx,css}",
    "!src/editor/core/cm/angular/parser.terms.ts",
    "!src/editor/core/cm/jsp/parser.terms.ts",
    "scripts/**/*.ts",
    "perf/**/*.ts",
    "e2e/**/*.ts",
    "smoke/**/*.ts",
  ],
  // Plugins' web pages are projects of their own (own package.json, checked by plugins/build.sh and CI).
  ignore: ["plugins/**/web-src/**"],
  ignoreExportsUsedInFile: true,
  // lint-staged formats Rust files with the toolchain's rustfmt.
  ignoreBinaries: ["rustfmt"],
  compilers: {
    // Fonts come in through `@import` in global.css.
    css: (text: string) => [...text.matchAll(/(?<=@)import[^;]+/g)].join("\n"),
  },
};

export default config;
