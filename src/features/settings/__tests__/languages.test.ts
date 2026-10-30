import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANGUAGES,
  folderRole,
  markFolder,
  normalizeFolder,
  validateLanguages,
  validateProjectStructure,
} from "@/platform/languageSettings";
import { buildPageTree } from "../model/pages";
import { LANGUAGE_PAGES } from "../pages/languages";
import { filterPackages } from "../languages/PythonInterpreterPage";
import { tildify } from "../languages/components";
import { validateSettings } from "../model/schema";

describe("languages settings", () => {
  it("defaults and normalises malformed values", () => {
    expect(validateLanguages(undefined)).toEqual(DEFAULT_LANGUAGES);
    const v = validateLanguages({
      python: { interpreter: " /usr/bin/python3 ", activateVirtualenv: "yes" },
      node: { packageManager: "pip" },
      rust: { checkCommand: "clippy", checkOnSave: false },
      typescript: { version: "" },
      java: { jdtlsVmArgs: " -Xmx2g ", jdk: 21, jdtlsJdk: " /opt/jdk-25 ", maven: { home: " /opt/maven " } },
    });
    expect(v.python).toEqual({ interpreter: "/usr/bin/python3", activateVirtualenv: true });
    expect(v.node.packageManager).toBe("");
    expect(v.rust.checkCommand).toBe("clippy");
    expect(v.rust.checkOnSave).toBe(false);
    expect(v.typescript.version).toBe("bundled");
    expect(v.java.jdtlsVmArgs).toBe("-Xmx2g");
    expect(v.java.jdk).toBe("");
    expect(v.java.jdtlsJdk).toBe("/opt/jdk-25");
    expect(v.java.maven).toEqual({ home: "/opt/maven", userSettings: "", localRepository: "", unlinkedProjects: [] });
    expect(validateSettings({}).languages).toEqual(DEFAULT_LANGUAGES);
  });

  it("marks folders with one role each", () => {
    expect(normalizeFolder("./src/main/")).toBe("src/main");
    let ps = validateProjectStructure({ sourceRoots: ["src/", "src", 3], excluded: ["/dist"] });
    expect(ps.sourceRoots).toEqual(["src"]);
    expect(ps.excluded).toEqual(["dist"]);
    ps = markFolder(ps, "src", "test");
    expect(ps.sourceRoots).toEqual([]);
    expect(folderRole(ps, "src/")).toBe("test");
    ps = markFolder(ps, "src", null);
    expect(folderRole(ps, "src")).toBeNull();
  });
});

describe("language pages", () => {
  it("keeps every language under Languages & Frameworks, as in IntelliJ IDEA", () => {
    const tree = buildPageTree(LANGUAGE_PAGES.map((p) => ({ ...p, component: p.component! })));
    expect(tree.map((n) => n.title)).toEqual(["Project Structure", "Languages & Frameworks"]);
    const langs = tree.find((n) => n.title === "Languages & Frameworks")!;
    expect(langs.children.map((n) => n.title)).toEqual([
      "Go",
      "Java",
      "Node.js",
      "Python Interpreter",
      "Rust",
      "TypeScript",
    ]);
  });

  it("filters packages and shortens home paths", () => {
    const pkgs = [
      { name: "Django", version: "5.1" },
      { name: "requests", version: "2.32.0" },
    ];
    expect(filterPackages(pkgs, "dj").map((p) => p.name)).toEqual(["Django"]);
    expect(filterPackages(pkgs, "")).toHaveLength(2);
    expect(tildify("/Users/me/p/.venv/bin/python")).toBe("~/p/.venv/bin/python");
    expect(tildify("C:/Users/me/.m2/wrapper/dists/apache-maven-3.9.16")).toBe(
      "~/.m2/wrapper/dists/apache-maven-3.9.16",
    );
    expect(tildify("C:/Program Files/Java/jdk-21")).toBe("C:/Program Files/Java/jdk-21");
  });
});
