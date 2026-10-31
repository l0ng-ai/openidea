import { describe, expect, it } from "vitest";
import { DEFAULT_LANGUAGES, validateLanguages } from "@/platform/languageSettings";
import { LANGUAGE_PAGES } from "../pages/languages";

describe("Go build tags", () => {
  it("keeps old project settings unchanged and ignores malformed values", () => {
    expect(validateLanguages({ go: { goroot: "/go" } }).go).toEqual({ ...DEFAULT_LANGUAGES.go, goroot: "/go" });
    expect(validateLanguages({ go: { buildTags: { os: false, arch: [], custom: 42 } } }).go.buildTags).toEqual(
      DEFAULT_LANGUAGES.go.buildTags,
    );
  });
  it("preserves independent project constraints", () => {
    expect(
      validateLanguages({
        go: {
          buildTags: {
            os: " linux ",
            arch: "arm64",
            cgo: "0",
            version: "go1.22",
            compiler: "gc",
            custom: "integration debug",
            experiments: "loopvar",
          },
        },
      }).go.buildTags,
    ).toEqual({
      os: "linux",
      arch: "arm64",
      cgo: "0",
      version: "go1.22",
      compiler: "gc",
      custom: "integration debug",
      experiments: "loopvar",
    });
    const page = LANGUAGE_PAGES.find((p) => p.id === "languages.go.buildTags")!;
    expect(page.defaultScope).toBe("project");
    expect(page.ownScopeSwitch).toBe(true);
  });
});
