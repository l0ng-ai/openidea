"use strict";
// Adds a project's Vite / Rollup / esbuild path aliases to every tsserver project's
// `compilerOptions.paths`, below the project's own `paths`: tsserver reads only
// tsconfig.json / jsconfig.json, so `@/` imports resolved by the bundler resolve to nothing
// in the editor and complete no paths. The IDE writes the aliases, as absolute `paths`
// entries, to `paths.json` next to this file.
const fs = require("fs");
const path = require("path");

module.exports = () => ({
  create(info) {
    const host = info.languageServiceHost;
    let aliases;
    try {
      aliases = JSON.parse(fs.readFileSync(path.join(__dirname, "paths.json"), "utf8"));
    } catch {
      return info.languageService;
    }
    if (!host || typeof host.getCompilationSettings !== "function") {
      return info.languageService;
    }
    const getCompilationSettings = host.getCompilationSettings.bind(host);
    // The same options object while the project's own stay the same, so the program is kept.
    let own;
    let merged;
    host.getCompilationSettings = () => {
      const options = getCompilationSettings();
      if (options !== own) {
        own = options;
        merged = { ...options, paths: { ...aliases, ...options.paths } };
      }
      return merged;
    };
    return info.languageService;
  },
});
