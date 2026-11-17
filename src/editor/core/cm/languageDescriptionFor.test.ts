import { afterEach, describe, expect, it } from "vitest";
import type { DocBackend, LanguageInfo } from "../backend";
import { _resetLanguages, languageDescriptionFor, loadLanguageInfos } from "./languages";

const language = (id: string, uiMode: string | null, extensions: string[]) =>
  ({ id, name: id, extensions, uiMode, lineComment: null, blockComment: null, indent: null }) as LanguageInfo;

const LANGUAGES = [language("shellscript", "Shell", ["sh", "bash"]), language("python", "Python", ["py"])];

/** A backend detecting like the IDE's: File Types patterns, then the extension, then hashbangs. */
function backend(): DocBackend & { asked: Array<[string, string | undefined]> } {
  const asked: Array<[string, string | undefined]> = [];
  return {
    asked,
    languages: async () => LANGUAGES,
    languageOf: async (path: string, firstLine?: string) => {
      asked.push([path, firstLine]);
      if (path.endsWith(".sh.orig")) return { language: "shellscript" };
      if (path.endsWith(".py")) return { language: "python" };
      if (firstLine?.startsWith("#!/usr/bin/env bash")) return { language: "shellscript" };
      if (firstLine?.startsWith("#!/usr/bin/env python")) return { language: "python" };
      return { language: "plaintext" };
    },
  } as Partial<DocBackend> as DocBackend & { asked: Array<[string, string | undefined]> };
}

afterEach(() => _resetLanguages());

describe("languageDescriptionFor (#3799)", () => {
  it.each([
    ["/r/bin/deploy", "#!/usr/bin/env bash", "Shell"],
    ["/r/bin/tool", "#!/usr/bin/env python3", "Python"],
    ["/r/deploy.sh.orig", "echo hi", "Shell"],
    ["/r/main.py", "print(1)", "Python"],
    ["/r/notes", "just text", null],
  ])("resolves %s (first line %j) as the editor does", async (path, firstLine, mode) => {
    const b = backend();
    await loadLanguageInfos(b);
    expect((await languageDescriptionFor(path, firstLine, b))?.name ?? null).toBe(mode);
    expect(b.asked).toEqual([[path, firstLine]]);
  });

  it("asks the backend that loaded the languages when none is given", async () => {
    const b = backend();
    await loadLanguageInfos(b);
    expect((await languageDescriptionFor("/r/bin/deploy", "#!/usr/bin/env bash"))?.name).toBe("Shell");
  });

  it("falls back to the extension without a backend", async () => {
    expect((await languageDescriptionFor("/r/a.py", undefined, null))?.name).toBe("Python");
  });

  it("falls back to the extension when the backend fails", async () => {
    const b = backend();
    await loadLanguageInfos(b);
    b.languageOf = async () => Promise.reject(new Error("no project"));
    expect((await languageDescriptionFor("/r/a.sh", undefined, b))?.name).toBe("Shell");
  });
});
