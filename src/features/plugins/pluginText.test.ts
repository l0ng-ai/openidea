import { describe, expect, it } from "vitest";
import type { UiContribution, View } from "@/bindings";
import { localizeContributions, localizeView, pickCatalogTag, translatorOf } from "./pluginText";

const fr = { Refresh: "Actualiser", "Word Tools": "Outils de mots", Cancel: "Annuler" };

describe("pickCatalogTag", () => {
  it.each([
    [["fr", "zh-CN"], "fr", "fr"],
    [["fr", "zh-CN"], "zh", "zh-CN"],
    [["zh"], "zh", "zh"],
    [["zh-TW"], "zh", "zh-TW"],
    [["pt-br"], "pt", "pt-br"],
    [["fr"], "en", undefined],
    [[], "fr", undefined],
  ])("%j for %s is %s", (tags, locale, expected) => {
    expect(pickCatalogTag(tags, locale)).toBe(expected);
  });
});

describe("localizeContributions", () => {
  const item = (pluginId: string, point: string, decl: Record<string, unknown>): UiContribution => ({
    pluginId,
    point,
    key: String(decl.id),
    decl,
  });

  it("translates titles and setting labels of the plugin's own declarations only", () => {
    const items = [
      item("a", "commands", { id: "x", title: "Refresh", category: "Word Tools" }),
      item("a", "settings", {
        id: "s",
        title: "Word Tools",
        properties: [{ key: "k", title: "Cancel", enum: ["Refresh"] }],
      }),
      item("a", "menus", { id: "m", menu: "tools", command: "Refresh" }),
      item("b", "commands", { id: "y", title: "Refresh" }),
    ];
    const out = localizeContributions(items, { a: fr });
    expect(out[0]!.decl).toMatchObject({ title: "Actualiser", category: "Outils de mots" });
    expect(out[1]!.decl).toMatchObject({
      title: "Outils de mots",
      properties: [{ title: "Annuler", enum: ["Refresh"] }],
    });
    expect(out[2]).toBe(items[2]);
    expect(out[3]).toBe(items[3]);
  });

  it("keeps the names of secrets and translates their labels", () => {
    const secret = item("a", "secrets", { id: "k", name: "Refresh", label: "Cancel", description: "Refresh" });
    expect(localizeContributions([secret], { a: fr })[0]!.decl).toMatchObject({
      name: "Refresh",
      label: "Annuler",
      description: "Actualiser",
    });
  });

  it("gives a tools menu entry the translated title of its command", () => {
    const items = [
      item("a", "commands", { id: "x", title: "Refresh" }),
      item("a", "menus", { id: "m", menu: "tools", command: "x" }),
    ];
    expect(localizeContributions(items, { a: fr })[1]!.decl).toMatchObject({ commandTitle: "Actualiser" });
  });

  it("ignores catalog entries inherited from Object.prototype", () => {
    const items = [item("a", "commands", { id: "x", title: "constructor", category: "__proto__" })];
    expect(localizeContributions(items, { a: fr })[0]!.decl).toMatchObject({
      title: "constructor",
      category: "__proto__",
    });
    expect(translatorOf({ a: fr }, "constructor")("Refresh")).toBe("Refresh");
    expect(translatorOf({ a: fr }, "a")("toString")).toBe("toString");
  });

  it("returns the declarations as they are without a catalog", () => {
    const items = [item("a", "commands", { id: "x", title: "Refresh" })];
    expect(localizeContributions(items, {})).toBe(items);
  });
});

describe("localizeView", () => {
  const t = translatorOf({ a: fr }, "a");
  const view = (body: View["body"]): View => ({
    toolbar: [{ id: "r", label: "Refresh", icon: null, enabled: true }],
    body,
    status: "Cancel",
  });

  it("translates buttons, tree items, fields and status, and keeps unknown text", () => {
    const tree = localizeView(
      view({
        kind: "tree",
        value: [
          { key: "1", parent: null, label: "Refresh", icon: null, detail: "other", expandable: false, expanded: false },
        ],
      }),
      t,
    );
    expect(tree.toolbar[0]!.label).toBe("Actualiser");
    expect(tree.status).toBe("Annuler");
    expect(tree.body).toMatchObject({ value: [{ label: "Actualiser", detail: "other" }] });

    const form = localizeView(
      view({ kind: "form", value: [{ key: "k", label: "Cancel", value: { kind: "text", value: "Cancel" } }] }),
      t,
    );
    expect(form.body).toMatchObject({ value: [{ label: "Annuler", value: { kind: "text", value: "Cancel" } }] });
  });

  it("leaves html bodies alone", () => {
    expect(localizeView(view({ kind: "html", value: "<p>Refresh</p>" }), t).body).toEqual({
      kind: "html",
      value: "<p>Refresh</p>",
    });
  });
});
