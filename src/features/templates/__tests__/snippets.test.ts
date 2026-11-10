import { describe, expect, it } from "vitest";
import { addContributedSnippets } from "@/workbench/contributions";
import { liveTemplates, saveTemplate, removeTemplate } from "../live/store";
import { snippetTemplates } from "../live/snippets";
import { expandTemplate } from "../live/model";
const snippet = {
  id: "plugin-snippet:p:s:0",
  pluginName: "Plugin",
  language: "sql",
  prefixes: ["sel", "select"],
  body: "${2:table} ${1:column} $1 $0 \\$",
  description: "Select rows",
};
describe("plugin snippets", () => {
  it("preserves defaults, linked stops, numeric tab order and escaped dollars", () => {
    const ts = snippetTemplates(snippet);
    expect(ts.map((t) => t.abbrev)).toEqual(["sel", "select"]);
    expect(ts[0]!.variables?.map((v) => v.name)).toEqual(["P1", "P2"]);
    const expanded = expandTemplate(ts[0]!);
    expect(expanded.preview).toBe("table column column  $");
    expect(expanded.snippet).toBe("${2:table} ${1:column} ${1:column} ${0} $");
  });
  it("withdraws read-only plugin entries without persisting customizations", () => {
    const off = addContributedSnippets([snippet]);
    const t = liveTemplates().find((t) => t.id.startsWith(snippet.id))!;
    expect(t.pluginOrigin).toBe("Plugin");
    saveTemplate({ ...t, body: "changed" });
    removeTemplate(t.id);
    expect(liveTemplates().find((x) => x.id === t.id)?.body).toBe(t.body);
    off();
    expect(liveTemplates().some((t) => t.id.startsWith(snippet.id))).toBe(false);
  });
});
