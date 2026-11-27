import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_STRUCTURE, effectiveContentRoots } from "@/platform/languageSettings";
import { DEFAULT_SETTINGS, validateSettings } from "../model/schema";
import { dependencyCandidates } from "../languages/ProjectStructurePage";

describe("project dependencies", () => {
  it("validates stored dependencies like content roots", () => {
    const s = validateSettings({ projectStructure: { dependencies: ["/deps/lib", "/deps/lib", ""] } });
    expect(s.projectStructure.dependencies).toEqual(["/deps/lib"]);
    expect(DEFAULT_SETTINGS.projectStructure.dependencies).toEqual([]);
    expect(DEFAULT_SETTINGS.projectStructure.memberDependencies).toEqual({});
  });

  it("keeps per-root dependencies and drops empty ones", () => {
    const s = validateSettings({
      projectStructure: {
        memberDependencies: { "/w/app": ["/w/lib", "/w/lib", ""], "/w/lib": [], "": ["/w/app"] },
      },
    });
    expect(s.projectStructure.memberDependencies).toEqual({ "/w/app": ["/w/lib"] });
  });

  it("merges dependencies into the effective content roots", () => {
    expect(
      effectiveContentRoots({
        ...DEFAULT_PROJECT_STRUCTURE,
        contentRoots: ["/shared"],
        dependencies: ["/deps/lib", "/shared"],
      }),
    ).toEqual(["/shared", "/deps/lib"]);
  });

  it("builds the checklist of one root from its configured projects", () => {
    const rows = dependencyCandidates("/p/root", ["/deps/lib", "/deps/lib", "/p/root", "/p/root/sub"]);
    expect(rows).toEqual([{ path: "/deps/lib", name: "lib", checked: true, disabled: false }]);
  });
});
