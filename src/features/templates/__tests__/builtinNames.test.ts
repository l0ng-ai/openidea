import { describe, expect, it } from "vitest";
import zh from "@/platform/locales/text/zh.json";
import { BUILTIN_CODE_TEMPLATES, BUILTIN_FILE_TEMPLATES } from "../files/builtins";

/** Names that read the same in Chinese. */
const AS_WRITTEN = new Set(["Dockerfile", "Jupyter Notebook"]);

describe("built-in template names", () => {
  it("are translated where the New menu and dialog show them", () => {
    const texts = zh as Record<string, string>;
    const names = [...BUILTIN_FILE_TEMPLATES, ...BUILTIN_CODE_TEMPLATES].map((t) => t.name);
    expect(names.filter((name) => !AS_WRITTEN.has(name) && !texts[name])).toEqual([]);
  });
});
