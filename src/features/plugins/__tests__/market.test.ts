import { describe, expect, it } from "vitest";
import type { MarketPlugin } from "@/bindings";
import { formatDownloads, groupMarket, monogram, suggestedFor, suggestionPaths } from "../market";

const plugin = (id: string, more: Partial<MarketPlugin> = {}): MarketPlugin => ({
  id,
  name: id.split(".")[1]!,
  version: "1.0.0",
  description: "",
  authors: [],
  publisher: id.split(".")[0]!,
  download: `${id}.oiplugin`,
  digest: "x",
  capabilities: [],
  engine: "^1.0",
  categories: [],
  icon: null,
  installed: null,
  compatible: true,
  publisherName: null,
  ...more,
});

const ids = (list: readonly MarketPlugin[]) => list.map((m) => m.id);

describe("groupMarket", () => {
  const market = [
    plugin("openidea.checkstyle", {
      downloads: 9000,
      featured: true,
      suggest: ["pom.xml"],
    }),
    plugin("acme.rare", { downloads: 3 }),
    plugin("acme.popular", { downloads: 500, featured: true }),
    plugin("bob.maven", { suggest: ["pom.xml"] }),
    plugin("bob.done", { suggest: ["pom.xml"], installed: "1.0.0" }),
  ];
  const suggested = suggestedFor(market, new Set(["pom.xml"]));

  it("browses suggestions and picks, then community plugins by downloads, then the examples", () => {
    const g = groupMarket(market, "", true, suggested);
    expect(ids(g.suggested)).toEqual(["bob.maven"]);
    expect(ids(g.featured)).toEqual(["acme.popular"]);
    expect(ids(g.community)).toEqual(["acme.popular", "acme.rare", "bob.done", "bob.maven"]);
    expect(ids(g.examples)).toEqual(["openidea.checkstyle"]);
  });

  it("lists matches by name first when searching, examples still last", () => {
    const shown = [plugin("acme.zeta", { downloads: 100 }), plugin("acme.lint-z"), plugin("openidea.z-ex")];
    const g = groupMarket(shown, "z", false, suggested);
    expect(g.suggested).toEqual([]);
    expect(g.featured).toEqual([]);
    expect(ids(g.community)).toEqual(["acme.zeta", "acme.lint-z"]);
    expect(ids(g.examples)).toEqual(["openidea.z-ex"]);
  });

  it("never suggests an example", () => {
    expect(suggestionPaths(market)).toEqual(["pom.xml"]);
    expect([...suggested.keys()]).toEqual(["bob.maven", "bob.done"]);
  });
});

describe("helpers", () => {
  it("formats downloads compactly", () => {
    expect(formatDownloads(42)).toBe("42");
    expect(formatDownloads(1234)).toMatch(/^1\.2\s?K$/);
  });

  it("gives a plugin without an icon a stable initial and tone", () => {
    expect(monogram("acme.tool", ".env files").letter).toBe("E");
    expect(monogram("acme.tool", "x").tone).toBe(monogram("acme.tool", "renamed").tone);
  });
});
