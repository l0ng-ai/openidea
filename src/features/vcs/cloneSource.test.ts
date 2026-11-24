import { describe, expect, it } from "vitest";
import { cloneUrlFromSource, pluginCloneSources } from "./cloneSource";

describe("cloneUrlFromSource", () => {
  it("reads the URL a source's page posts", () => {
    expect(cloneUrlFromSource('{"op":"clone-url","url":"https://gitee.com/acme/widgets.git"}')).toBe(
      "https://gitee.com/acme/widgets.git",
    );
    expect(cloneUrlFromSource('{"op":"clone-url","url":"  git@gitee.com:acme/widgets.git  "}')).toBe(
      "git@gitee.com:acme/widgets.git",
    );
  });

  it("ignores everything else the page posts", () => {
    for (const text of [
      "",
      "not json",
      "[]",
      "null",
      '{"op":"other","url":"https://gitee.com/acme/widgets.git"}',
      '{"op":"clone-url"}',
      '{"op":"clone-url","url":42}',
      '{"op":"clone-url","url":"   "}',
      '{"op":"clone-url","url":"https://gitee.com/a b"}',
    ]) {
      expect(cloneUrlFromSource(text), text).toBeNull();
    }
  });
});

describe("pluginCloneSources", () => {
  it("turns a declaration into a sidebar entry", () => {
    expect(
      pluginCloneSources([
        {
          pluginId: "code2y6m.gitee-plugin",
          key: "cloneSources/gitee",
          point: "cloneSources",
          decl: { label: "Gitee", icon: "branch" },
        },
        { pluginId: "p", key: "greetings", point: "views", decl: {} },
      ]),
    ).toEqual([
      {
        id: "code2y6m.gitee-plugin/cloneSources/gitee",
        label: "Gitee",
        icon: "branch",
        pluginId: "code2y6m.gitee-plugin",
        view: "cloneSources/gitee",
      },
    ]);
  });

  it("falls back to the key and a generic icon", () => {
    const [entry] = pluginCloneSources([
      { pluginId: "p", key: "cloneSources/gitee", point: "cloneSources", decl: null },
    ]);
    expect(entry).toMatchObject({ label: "cloneSources/gitee", icon: "branch" });
  });
});
