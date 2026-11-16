import { afterEach, describe, expect, it } from "vitest";
import type { DocBackend, LanguageInfo } from "@/editor/core/backend";
import { _resetLanguages, loadLanguageInfos } from "@/editor/core/cm/languages";
import { firstLineOf, languageFor } from "../cm";

const shell = {
  id: "shellscript",
  name: "Shell Script",
  extensions: ["sh"],
  uiMode: "Shell",
  lineComment: "#",
  blockComment: null,
  indent: null,
} as LanguageInfo;

afterEach(() => _resetLanguages());

describe("diff viewer language (#3799)", () => {
  it("highlights a script recognised by the shown side's hashbang, as the editor does", async () => {
    const asked: Array<string | undefined> = [];
    const backend = {
      languages: async () => [shell],
      languageOf: async (_path: string, firstLine?: string) => {
        asked.push(firstLine);
        return { language: firstLine?.startsWith("#!/usr/bin/env bash") ? "shellscript" : "plaintext" };
      },
    } as Partial<DocBackend> as DocBackend;
    await loadLanguageInfos(backend);

    const text = "#!/usr/bin/env bash\r\necho deployed\n";
    expect((await languageFor("/r/bin/deploy", firstLineOf(text)))?.language.name).toBe("shell");
    expect(await languageFor("/r/bin/notes", "plain words")).toBeNull();
    expect(asked).toEqual(["#!/usr/bin/env bash", "plain words"]);
  });

  it.each([
    ["#!/bin/sh\necho", "#!/bin/sh"],
    ["#!/bin/sh\r\necho", "#!/bin/sh"],
    ["one line", "one line"],
    ["", ""],
  ])("takes the first line of %j", (text, line) => {
    expect(firstLineOf(text)).toBe(line);
  });
});
