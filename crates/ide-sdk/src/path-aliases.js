"use strict";
// Adds a project's Vite / Rollup / esbuild path aliases to every tsserver project's
// `compilerOptions.paths`, below the project's own `paths`: tsserver reads only
// tsconfig.json / jsconfig.json, so `@/` imports resolved by the bundler resolve to nothing
// in the editor and complete no paths. The IDE writes the aliases of each directory holding
// a bundler configuration, as absolute `paths` entries, to `paths.json` next to this file.
const fs = require("fs");
const path = require("path");

const key = (dir) => {
  const resolved = path.resolve(dir);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

// The aliases of the configuration nearest `dir` within its package: a workspace member
// gets its own configuration's, never the monorepo root's.
function aliasesFor(packages, dir) {
  for (dir = path.resolve(dir); ; dir = path.dirname(dir)) {
    const aliases = packages.get(key(dir));
    if (aliases) return aliases;
    if (fs.existsSync(path.join(dir, "package.json")) || path.dirname(dir) === dir) return undefined;
  }
}

module.exports = () => ({
  create(info) {
    const host = info.languageServiceHost;
    let aliases;
    try {
      const packages = JSON.parse(fs.readFileSync(path.join(__dirname, "paths.json"), "utf8"));
      const byDir = new Map(Object.entries(packages).map(([dir, paths]) => [key(dir), paths]));
      aliases = aliasesFor(byDir, info.project.getCurrentDirectory());
    } catch {
      return info.languageService;
    }
    if (!aliases || !host || typeof host.getCompilationSettings !== "function") {
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
