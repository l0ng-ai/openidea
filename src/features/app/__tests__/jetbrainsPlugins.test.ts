import { expect, it } from "vitest";
import type { MarketPlugin } from "@/bindings";
import { JETBRAINS_PLUGINS, planJetBrainsPlugins, suggestPlugins } from "../jetbrainsPlugins";

const entry = (id: string, name: string, extra: Partial<MarketPlugin> = {}) =>
  ({ id, name, installed: null, compatible: true, ...extra }) as MarketPlugin;

it("sorts the installed plugins without the marketplace", () => {
  const installed = [
    "IdeaVIM",
    "com.nasller.CodeGlancePro",
    "mobi.hsz.idea.gitignore",
    "Dart",
    "GrepConsole",
    "com.intellij.lang.jsgraphql",
    "org.example.unknown",
    "com.nasller.CodeGlancePro",
  ].join("\n");
  expect(planJetBrainsPlugins(installed, "GrepConsole\r\nDocker\n")).toEqual({
    vim: true,
    builtIn: ["GraphQL"],
    disabled: ["GrepConsole"],
    unmapped: ["org.example.unknown"],
    candidates: [
      ["com.nasller.CodeGlancePro", "ruyimg.codeglance-pro"],
      ["mobi.hsz.idea.gitignore", "aritti.ignore"],
      ["Dart", "xirf.dart"],
    ],
  });
  expect(planJetBrainsPlugins("IdeaVIM", "IdeaVIM")).toMatchObject({ vim: false, disabled: ["IdeaVIM"] });
});

it("suggests the counterparts the marketplace has for this version and that are not installed", () => {
  const market = [
    entry("ruyimg.codeglance-pro", "CodeGlance Pro"),
    entry("aritti.ignore", ".ignore", { installed: "1.0.0" }),
    entry("xirf.dart", "Dart", { compatible: false }),
  ];
  const candidates: [string, string][] = [
    ["com.nasller.CodeGlancePro", "ruyimg.codeglance-pro"],
    ["mobi.hsz.idea.gitignore", "aritti.ignore"],
    ["Dart", "xirf.dart"],
    ["GrepConsole", "solhovoy.grep-console"],
  ];
  expect(suggestPlugins(candidates, market)).toEqual({
    install: [{ id: "ruyimg.codeglance-pro", name: "CodeGlance Pro" }],
    unavailable: ["Dart", "GrepConsole"],
  });
});

it("maps to distinct plugins", () => {
  const targets = Object.values(JETBRAINS_PLUGINS);
  expect(new Set(targets).size).toBe(targets.length);
});
