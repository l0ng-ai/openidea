import { expect, it } from "vitest";
import type { MarketPlugin } from "@/bindings";
import { JETBRAINS_PLUGINS, planJetBrainsPlugins } from "../jetbrainsPlugins";

const entry = (id: string, name: string, extra: Partial<MarketPlugin> = {}) =>
  ({ id, name, installed: null, compatible: true, ...extra }) as MarketPlugin;

const market = [
  entry("ruyimg.codeglance-pro", "CodeGlance Pro"),
  entry("aritti.ignore", ".ignore", { installed: "1.0.0" }),
  entry("xirf.dart", "Dart", { compatible: false }),
  entry("solhovoy.grep-console", "Grep Console"),
];

it("offers the marketplace counterparts and reports the rest", () => {
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
  expect(planJetBrainsPlugins(installed, "GrepConsole\r\nDocker\n", market)).toEqual({
    install: [{ id: "ruyimg.codeglance-pro", name: "CodeGlance Pro" }],
    vim: true,
    builtIn: ["GraphQL"],
    disabled: ["Grep Console"],
    // Dart's counterpart does not run on this version.
    unmapped: ["Dart", "org.example.unknown"],
  });
});

it("keeps a disabled IdeaVim off, and reports everything when the marketplace is unreachable", () => {
  expect(planJetBrainsPlugins("IdeaVIM\nGrepConsole", "IdeaVIM", null)).toEqual({
    install: [],
    vim: false,
    builtIn: [],
    disabled: ["IdeaVim"],
    unmapped: ["GrepConsole"],
  });
});

it("maps to distinct plugins", () => {
  const targets = Object.values(JETBRAINS_PLUGINS);
  expect(new Set(targets).size).toBe(targets.length);
});
