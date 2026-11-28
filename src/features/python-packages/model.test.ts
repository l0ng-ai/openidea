import { describe, expect, it } from "vitest";
import {
  isPackageName,
  listRows,
  normalize,
  requirementOf,
  rowKey,
  vcsRequirement,
  diskRequirement,
  isArchive,
  isVcsUrl,
  withoutMedia,
} from "./model";

const INSTALLED = [
  { name: "requests", version: "2.31.0" },
  { name: "typing_extensions", version: "4.12.0" },
];
const found = (name: string) => ({
  name,
  summary: "",
  latest: "1.0",
  versions: ["1.0"],
  description: "",
  markdown: false,
  links: [],
});

describe("package rows", () => {
  it("lists the installed packages with their newer release", () => {
    const rows = listRows(INSTALLED, new Map([["requests", "2.34.2"]]), null, [], "");
    expect(rows.map(rowKey)).toEqual(["section:installed", "installed:requests", "installed:typing_extensions"]);
    expect(rows[1]).toMatchObject({ version: "2.31.0", latest: "2.34.2" });
    expect(rows[2]).toMatchObject({ latest: null });
  });

  it("filters the installed packages and adds the PyPI project the query names", () => {
    const rows = listRows(INSTALLED, null, found("six"), [], " SIX ");
    expect(rows.map(rowKey)).toEqual(["section:pypi", "pypi:six"]);
    expect(listRows(INSTALLED, null, null, [], "quest").map(rowKey)).toEqual([
      "section:installed",
      "installed:requests",
    ]);
  });

  it("lists the search results after the exact match, without what is installed or repeated", () => {
    const rows = listRows(INSTALLED, null, found("six"), ["Six", "sixer", "typing.extensions", "django-six"], "six");
    expect(rows.map(rowKey)).toEqual(["section:pypi", "pypi:six", "pypi:sixer", "pypi:django-six"]);
    expect(rows[1]).toMatchObject({ latest: "1.0" });
    expect(rows[2]).toMatchObject({ latest: null });
  });

  it("filters the installed packages by their normalised names", () => {
    for (const query of ["typing-extensions", "Typing.Extensions", "typing_ext"]) {
      expect(listRows(INSTALLED, null, found("typing-extensions"), [], query).map(rowKey)).toEqual([
        "section:installed",
        "installed:typing_extensions",
      ]);
    }
  });

  it("does not list an installed package again under PyPI, however its name is spelled", () => {
    const rows = listRows(INSTALLED, null, found("typing-extensions"), [], "typing");
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

describe("vcsRequirement", () => {
  it("installs a repository URL with Git unless it names a VCS", () => {
    expect(vcsRequirement(" https://github.com/psf/requests.git ")).toBe("git+https://github.com/psf/requests.git");
    expect(vcsRequirement("git@github.com:psf/requests.git")).toBe("git+ssh://git@github.com/psf/requests.git");
    expect(vcsRequirement("git+https://github.com/psf/requests@v2.32.0#egg=requests")).toBe(
      "git+https://github.com/psf/requests@v2.32.0#egg=requests",
    );
    expect(vcsRequirement("hg+https://hg.example.org/demo")).toBe("hg+https://hg.example.org/demo");
  });
});

describe("install from version control or disk", () => {
  it("accepts only version control URLs", () => {
    expect(isVcsUrl(vcsRequirement("https://github.com/psf/requests.git"))).toBe(true);
    expect(isVcsUrl("hg+https://hg.example.org/demo")).toBe(true);
    expect(isVcsUrl(vcsRequirement("requests"))).toBe(false);
    expect(isVcsUrl(vcsRequirement("file:///tmp/pkg"))).toBe(false);
    for (const url of [
      "git+ssh://git@github.com/psf/requests.git",
      "git+file:///work/repo",
      "hg+https://hg.example.org/demo",
      "svn+svn://svn.example.org/demo/trunk",
      "bzr+lp:demo",
      "git+https://github.com/psf/requests.git@v2.32.0",
      "git+https://github.com/o/r.git#egg=demo&subdirectory=pkgs/demo",
      "requests @ git+https://github.com/psf/requests.git",
      "demo[cli] @ git+https://github.com/o/r.git",
    ])
      expect(isVcsUrl(url), url).toBe(true);
    expect(isVcsUrl("requests @ https://example.org/requests.zip")).toBe(false);
    for (const url of ["git+https:foo", "git+ssh:git@host:o/r", "requests @ git+https:foo"])
      expect(isVcsUrl(url), url).toBe(false);
  });

  it("never lets a typed path read as a PyPI name", () => {
    expect(diskRequirement(" mylib ")).toBe("./mylib");
    expect(diskRequirement("pkgs/mylib")).toBe("./pkgs/mylib");
    expect(diskRequirement("src\\mylib")).toBe("./src\\mylib");
    for (const path of ["./mylib", "../lib", "/work/lib", "~/lib", "C:\\work\\lib", "\\\\server\\lib"]) {
      expect(diskRequirement(path)).toBe(path);
    }
    expect(isArchive("dist/demo-1.0.tar.gz")).toBe(true);
    expect(isArchive("dist/demo-1.0-py3-none-any.whl")).toBe(true);
    expect(isArchive("pkgs/demo")).toBe(false);
    expect(isArchive(" dist/demo-1.0-py3-none-any.whl ")).toBe(true);
  });
});

describe("withoutMedia", () => {
  it("takes out what would load from other sites, keeping an image's alt text", () => {
    const { html, count } = withoutMedia(
      '<p><img src="https://img.shields.io/b.svg" alt="build"> ok</p><picture><source srcset="https://x/a.png"><img src="https://x/b.png"></picture><video src="https://x/v.mp4"></video>',
    );
    expect(html).toBe("<p>build ok</p>");
    expect(count).toBe(3);
    expect(withoutMedia("<p>text</p>")).toEqual({ html: "<p>text</p>", count: 0 });
  });
});
