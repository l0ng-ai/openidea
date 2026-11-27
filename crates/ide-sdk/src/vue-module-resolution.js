"use strict";
// Companion tsserver plugin for `@vue/typescript-plugin`: when TypeScript cannot resolve an
// extension-less relative import, retry it with the `.vue` extension. The Vue plugin only
// resolves specifiers that already name the `.vue` file (through a faked `.d.vue.ts`
// declaration), so a directory `index.js` re-exporting a sibling `.vue`
// (`import X from './X'`) leaves the component `any`, and with it every `@event="method"`
// handler type in the project's templates. This is the host-side equivalent of VS Code's
// `patch-tsserver.js`, which adds `.vue` to the extensions tsserver tries.
module.exports = ({ typescript }) => ({
  create(info) {
    const ts = typescript;
    const host = info.languageServiceHost;
    if (!host) {
      return info.languageService;
    }
    const VUE = ".vue";
    const DECLARATION = ".d.vue.ts";
    // Specifiers TypeScript never resolves on its own that could still name an SFC:
    // relative and without a known extension (`./ChildButton`, `./ChildButton/`).
    const withVueExtension = (moduleName) => {
      const base = moduleName.replace(/\/+$/, "");
      if (
        !ts.isExternalModuleNameRelative(base) ||
        base.endsWith(VUE) ||
        /\.[cm]?[jt]sx?$/.test(base) ||
        /\.json$/.test(base)
      ) {
        return undefined;
      }
      return base + VUE;
    };
    const fileExists = (fileName) =>
      typeof host.fileExists === "function" ? host.fileExists(fileName) : ts.sys.fileExists(fileName);
    const readFile = (fileName) => {
      try {
        return typeof host.readFile === "function" ? host.readFile(fileName) : ts.sys.readFile(fileName);
      } catch {
        return undefined;
      }
    };
    // TypeScript probes `<specifier>.d.vue.ts` for a `.vue` import under
    // `allowArbitraryExtensions`; answer `true` when the `.vue` itself is on disk.
    const moduleResolutionHost = {
      fileExists: (fileName) =>
        fileName.endsWith(DECLARATION)
          ? fileExists(fileName.slice(0, -DECLARATION.length) + VUE)
          : fileExists(fileName),
      readFile,
      directoryExists: host.directoryExists?.bind(host),
      realpath: host.realpath?.bind(host),
      getCurrentDirectory: host.getCurrentDirectory?.bind(host),
      getDirectories: host.getDirectories?.bind(host),
      useCaseSensitiveFileNames:
        typeof host.useCaseSensitiveFileNames === "function"
          ? host.useCaseSensitiveFileNames.bind(host)
          : host.useCaseSensitiveFileNames,
    };
    // The SFC's service script is TypeScript when it says `<script lang="ts">`, else JavaScript.
    const scriptExtension = (vueFileName) => {
      const head = readFile(vueFileName)?.slice(0, 4096) ?? "";
      return /<script\b[^>]*\blang\s*=\s*["']tsx?["']/i.test(head) ? ".ts" : ".js";
    };
    const resolveVue = (moduleName, containingFile, options, redirectedReference, resolutionMode) => {
      const specifier = withVueExtension(moduleName);
      if (!specifier) {
        return undefined;
      }
      const result = ts.resolveModuleName(
        specifier,
        containingFile,
        { ...options, allowArbitraryExtensions: true },
        moduleResolutionHost,
        undefined,
        redirectedReference,
        resolutionMode,
      );
      const resolved = result.resolvedModule;
      if (!resolved || !resolved.resolvedFileName.endsWith(DECLARATION)) {
        return undefined;
      }
      const vueFileName = resolved.resolvedFileName.slice(0, -DECLARATION.length) + VUE;
      resolved.resolvedFileName = vueFileName;
      resolved.extension = scriptExtension(vueFileName);
      return resolved;
    };
    // Loaded after `@vue/typescript-plugin`, so its decorated resolvers run first; the
    // retry only fills what both it and tsserver left unresolved.
    if (typeof host.resolveModuleNameLiterals === "function") {
      const resolveModuleNameLiterals = host.resolveModuleNameLiterals.bind(host);
      host.resolveModuleNameLiterals = (
        moduleLiterals,
        containingFile,
        redirectedReference,
        options,
        containingSourceFile,
        ...rest
      ) => {
        const results = resolveModuleNameLiterals(
          moduleLiterals,
          containingFile,
          redirectedReference,
          options,
          containingSourceFile,
          ...rest,
        );
        return moduleLiterals.map((literal, i) => {
          if (results[i]?.resolvedModule) {
            return results[i];
          }
          const mode = ts.getModeForUsageLocation?.(containingSourceFile, literal, options);
          const resolved = resolveVue(literal.text, containingFile, options, redirectedReference, mode);
          return resolved ? { resolvedModule: resolved } : results[i];
        });
      };
    }
    if (typeof host.resolveModuleNames === "function") {
      const resolveModuleNames = host.resolveModuleNames.bind(host);
      host.resolveModuleNames = (
        moduleNames,
        containingFile,
        reusedNames,
        redirectedReference,
        options,
        containingSourceFile,
      ) => {
        const results = resolveModuleNames(
          moduleNames,
          containingFile,
          reusedNames,
          redirectedReference,
          options,
          containingSourceFile,
        );
        const mode = containingSourceFile?.impliedNodeFormat;
        return moduleNames.map(
          (moduleName, i) => results[i] ?? resolveVue(moduleName, containingFile, options, redirectedReference, mode),
        );
      };
    }
    return info.languageService;
  },
});
