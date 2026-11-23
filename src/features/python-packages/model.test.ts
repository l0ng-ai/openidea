import { describe, expect, it } from "vitest";
import { isPackageName, listRows, normalize, requirementOf, rowKey } from "./model";

const INSTALLED = [
  { name: "requests", version: "2.31.0" },
  { name: "typing_extensions", version: "4.12.0" },
];
const found = (name: string) => ({ name, summary: "", latest: "1.0", versions: ["1.0"] });

describe("package rows", () => {
  it("lists the installed packages with their newer release", () => {
    const rows = listRows(INSTALLED, new Map([["requests", "2.34.2"]]), null, "");
    expect(rows.map(rowKey)).toEqual(["section:installed", "installed:requests", "installed:typing_extensions"]);
    expect(rows[1]).toMatchObject({ version: "2.31.0", latest: "2.34.2" });
    expect(rows[2]).toMatchObject({ latest: null });
  });

  it("filters the installed packages and adds the PyPI project the query names", () => {
    const rows = listRows(INSTALLED, null, found("six"), " SIX ");
    expect(rows.map(rowKey)).toEqual(["section:pypi", "pypi:six"]);
    expect(listRows(INSTALLED, null, null, "quest").map(rowKey)).toEqual(["section:installed", "installed:requests"]);
  });

  it("filters the installed packages by their normalised names", () => {
    for (const query of ["typing-extensions", "Typing.Extensions", "typing_ext"]) {
      expect(listRows(INSTALLED, null, found("typing-extensions"), query).map(rowKey)).toEqual([
        "section:installed",
        "installed:typing_extensions",
      ]);
    }
  });

  it("does not list an installed package again under PyPI, however its name is spelled", () => {
    const rows = listRows(INSTALLED, null, found("typing-extensions"), "typing");
    expect(rows.map(rowKey)).toEqual(["section:installed", "installed:typing_extensions"]);
  });
});

describe("names and requirements", () => {
  it("compares names as PEP 503 does", () => {
    expect(normalize("Typing_Extensions")).toBe("typing-extensions");
    expect(normalize("zope.interface")).toBe("zope-interface");
  });

  it("asks PyPI only for text that can be a name", () => {
    for (const ok of ["six", "zope.interface", "a", "Django"]) expect(isPackageName(ok)).toBe(true);
    for (const bad of ["", "-e", "pip-", "requests==2.0", "a b", "git+https://x", "a".repeat(129)]) {
      expect(isPackageName(bad)).toBe(false);
    }
  });

  it("pins a chosen version", () => {
    expect(requirementOf("six", "1.16.0")).toBe("six==1.16.0");
    expect(requirementOf("six", null)).toBe("six");
  });
});
