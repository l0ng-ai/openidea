import { afterEach, expect, it } from "vitest";
import { useProject } from "@/platform/project";
import { outsideProjectNotice } from "./outsideProject";

const text = (message: string) => outsideProjectNotice(message)?.text ?? null;

it("recognizes each server's report that a file is outside its projects", () => {
  const cases: [string, RegExp | null][] = [
    // jdtls: a file outside the module's source folders, and one outside every project.
    [
      "Extra.java is not on the classpath of project service, only syntax errors are reported",
      /source folders of its Java module/,
    ],
    ["Scratch.java is a non-project file, only syntax errors are reported", /imported Java project/],
    // gopls: build constraints win over the generic "no package".
    ["No packages found for open file x.go.\nThis file may be excluded due to its build tags", /build constraints/],
    ["This file may be excluded due to its GOOS/GOARCH, or other build constraints.", /build constraints/],
    ["No packages found for open file x.go.", /no package of the workspace/],
    // rust-analyzer `unlinked-file`.
    [
      "This file is not included in any crates, so rust-analyzer can't offer IDE services.",
      /not included in any crate/,
    ],
    // Ordinary errors are not such reports.
    ["undefined: missingSymbol", null],
    ["invalid build tags syntax", null],
    ["ActionDTO cannot be resolved to a type", null],
    ["Missing artifact demo:api:jar:1.0", null],
  ];
  for (const [message, expected] of cases) {
    const got = text(message);
    if (expected) expect(got, message).toMatch(expected);
    else expect(got, message).toBeNull();
  }
  // A build reload is offered only where it can bring the file into a project.
  expect(outsideProjectNotice("A.java is a non-project file, only syntax errors are reported")?.reload).toBe(true);
  expect(outsideProjectNotice("No packages found for open file x.go.")?.reload).toBeFalsy();
});

afterEach(() => useProject.setState({ project: null }));

const openProject = (root: string, projects?: string[]) =>
  useProject.setState({
    project: {
      root,
      name: "p",
      trusted: true,
      isGit: false,
      settings: {},
      ...(projects && { workspace: { version: 1, name: "p", projects } }),
    },
  });

it("shows a banner while the server reports the file, with the build reloads available", async () => {
  openProject("/p");
  const { renderHook, act } = await import("@testing-library/react");
  const { setFileDiagnostics } = await import("./diagnostics");
  const { registerActions } = await import("@/platform/actions");
  const { outsideProjectBanner } = await import("./outsideProject");
  const off = registerActions([{ id: "maven.reload", title: "Reload All Maven Projects", run: () => {} }]);
  const path = "/p/service/src/extra/Extra.java";
  try {
    const { result } = renderHook(() => outsideProjectBanner.useBanner(path));
    expect(result.current).toBeNull();
    const warning = {
      range: { start: { line: 0, col: 0 }, end: { line: 0, col: 1 } },
      severity: "warning" as const,
      message: "Extra.java is not on the classpath of project service, only syntax errors are reported",
      source: "Java",
      code: "32",
    };
    act(() => setFileDiagnostics(path, "jdtls", [warning]));
    expect(result.current?.level).toBe("warning");
    expect(result.current?.text).toMatch(/source folders of its Java module/);
    expect(result.current?.actions?.map((a) => a.label)).toEqual(["Reload Maven Projects"]);
    act(() => setFileDiagnostics(path, "jdtls", []));
    expect(result.current).toBeNull();
  } finally {
    off();
    setFileDiagnostics(path, "jdtls", []);
  }
});

it("offers a build reload only for files of the open project", async () => {
  const { renderHook, act } = await import("@testing-library/react");
  const { setFileDiagnostics } = await import("./diagnostics");
  const { registerActions } = await import("@/platform/actions");
  const { outsideProjectBanner } = await import("./outsideProject");
  const off = registerActions([{ id: "maven.reload", title: "Reload All Maven Projects", run: () => {} }]);
  openProject("/ws", ["/p"]);
  // A scratch lives in the app data dir; a module the import missed lives in the project.
  const cases: [string, string[]][] = [
    ["/data/scratches/scratch.java", []],
    ["/p/tools/Gen.java", ["Reload Maven Projects"]],
    ["/ws/Gen.java", ["Reload Maven Projects"]],
  ];
  try {
    for (const [path, labels] of cases) {
      const { result } = renderHook(() => outsideProjectBanner.useBanner(path));
      const warning = {
        range: { start: { line: 0, col: 0 }, end: { line: 0, col: 1 } },
        severity: "warning" as const,
        message: `${path.split("/").pop()} is a non-project file, only syntax errors are reported`,
        source: "Java",
        code: "32",
      };
      act(() => setFileDiagnostics(path, "jdtls", [warning]));
      expect(result.current?.text, path).toMatch(/only JDK classes resolve/);
      expect(
        result.current?.actions?.map((a) => a.label),
        path,
      ).toEqual(labels);
      act(() => setFileDiagnostics(path, "jdtls", []));
    }
  } finally {
    off();
  }
});
