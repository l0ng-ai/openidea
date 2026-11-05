import { beforeEach, describe, expect, it } from "vitest";
import type { LanguageInfo_Serialize as LanguageInfo, Settings } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { effectivePatterns, removePattern, userFileType, validateFileTypes, wildcardMatch } from "@/platform/fileTypes";
import { DEFAULT_SETTINGS, validateSettings } from "../model/schema";
import { openSettings, stage, stagedValue, useSettingsDialog } from "../model/staging";
import { applyPatternEdit } from "../pages/FileTypes";
import { CODE_STYLE_KEYS, copyScheme } from "../pages/editor/codeStyleScheme";
import { overrideKey } from "../fileTypesRuntime";

const lang = (id: string, extensions: string[], filenames: string[] = []): LanguageInfo => ({
  id,
  name: id,
  extensions,
  filenames,
  uiMode: null,
  lineComment: null,
  blockComment: null,
  indent: null,
});

const python = lang("python", ["py", "pyi"], ["SConstruct"]);
const groovy = lang("groovy", ["groovy"], ["Jenkinsfile"]);
const shell = lang("shellscript", ["sh"]);
const langs = [python, groovy, shell];

describe("file type associations", () => {
  it("adds, removes and restores patterns of a language", () => {
    let a = applyPatternEdit({}, langs, python, ["*.py", "*.pyi", "SConstruct", "*.foo"]);
    expect(a).toEqual({ python: { patterns: ["*.foo"], removedPatterns: [], hashbangs: [] } });
    a = applyPatternEdit(a, langs, python, ["*.py", "*.foo"]);
    expect(a.python).toEqual({ patterns: ["*.foo"], removedPatterns: ["*.pyi", "SConstruct"], hashbangs: [] });
    expect(effectivePatterns(python, a).map((p) => p.pattern)).toEqual(["*.py", "*.foo"]);
    // Re-adding a built-in pattern restores it; removing the last change drops the entry.
    a = applyPatternEdit(a, langs, python, ["*.py", "*.pyi", "SConstruct"]);
    expect(a).toEqual({});
  });

  it("moves a pattern from the language that had it", () => {
    const a = applyPatternEdit({}, langs, shell, ["*.sh", "Jenkinsfile"]);
    expect(a.shellscript?.patterns).toEqual(["Jenkinsfile"]);
    expect(a.groovy?.removedPatterns).toEqual(["Jenkinsfile"]);
    expect(effectivePatterns(groovy, a).map((p) => p.pattern)).toEqual(["*.groovy"]);
    expect(removePattern(a, shell, "Jenkinsfile").shellscript).toBeUndefined();
  });

  it("matches user patterns for icons", () => {
    const a = {
      python: { patterns: ["*.foo", "build_*.cfg"], removedPatterns: [], hashbangs: [] },
      shellscript: { patterns: ["Jenkinsfile"], removedPatterns: [], hashbangs: [] },
    };
    expect(userFileType(a, "x.FOO")).toBe("python");
    expect(userFileType(a, "build_dev.cfg")).toBe("python");
    expect(userFileType(a, "Jenkinsfile")).toBe("shellscript");
    expect(userFileType(a, "x.py")).toBeNull();
    expect(wildcardMatch("file?.txt", "file1.txt")).toBe(true);
    expect(wildcardMatch("file?.txt", "file.txt")).toBe(false);
  });

  it("validates stored associations and keeps them in the settings", () => {
    expect(validateFileTypes({ python: { patterns: [" *.foo ", 3, "*.foo"] }, "": {}, x: 1 })).toEqual({
      python: { patterns: ["*.foo"], removedPatterns: [], hashbangs: [] },
    });
    const s = validateSettings({
      files: { fileTypes: { go: { hashbangs: ["gorun"] } }, fileTypeOverrides: { "a/b.txt": "markdown", bad: 1 } },
      projectStructure: { contentRoots: ["/data/shared", "/data/shared"], excludeFiles: "*.log;tmp*" },
    });
    expect(s.files.fileTypes.go?.hashbangs).toEqual(["gorun"]);
    expect(s.files.fileTypeOverrides).toEqual({ "a/b.txt": "markdown" });
    expect(s.projectStructure.contentRoots).toEqual(["/data/shared"]);
    expect(s.projectStructure.excludeFiles).toBe("*.log;tmp*");
  });

  it("keys overrides by project-relative path inside the project", () => {
    expect(overrideKey("/p/src/a.txt", "/p")).toBe("src/a.txt");
    expect(overrideKey("/elsewhere/a.txt", "/p")).toBe("/elsewhere/a.txt");
    expect(overrideKey("/p2/a.txt", "/p")).toBe("/p2/a.txt");
  });
});

describe("code style scheme", () => {
  beforeEach(() => {
    useProject.setState({ settings: structuredClone(DEFAULT_SETTINGS) as Settings, project: null });
    openSettings("editor.codeStyle");
  });

  it("copies every Code Style value to the other scheme", () => {
    stage("editor.codeStyle", "global", "editor.codeStyle.hardWrapAt", 100);
    stage("editor.codeStyle", "global", "editor.codeStyle.formatterTagsEnabled", true);
    stage("editor.codeStyle", "global", "editor.codeStyle.languages", {
      java: { formatter: "custom", formatterPath: "config/formatter.xml" },
    });
    copyScheme("editor.codeStyle", "global", "project");
    const s = useSettingsDialog.getState();
    expect(stagedValue(s, "project", "editor.codeStyle.hardWrapAt")).toBe(100);
    expect(stagedValue(s, "project", "editor.codeStyle.formatterTagsEnabled")).toBe(true);
    expect(stagedValue(s, "project", "editor.codeStyle.formatterOffTag")).toBe("@formatter:off");
    for (const key of CODE_STYLE_KEYS) expect(stagedValue(s, "project", key)).toEqual(stagedValue(s, "global", key));
  });
});
