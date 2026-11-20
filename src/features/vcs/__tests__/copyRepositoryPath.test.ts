import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAction, registerActions } from "@/platform/actions";
import { clearContext, setContext } from "@/platform/context";
import { menuGroupItems, provideNotificationService } from "@/workbench/contributions";
import type { MenuItem } from "@/ui";
import { copyRepositoryPathActions, registerCopyRepositoryPath } from "../copyRepositoryPath";
import { useVcs } from "../store";

const writeText = vi.fn(async (_text: string) => undefined);
const hint = vi.fn();
const notify = vi.fn();
const disposers: Array<() => void> = [];

type Item = Extract<MenuItem, { kind?: "item" }>;
const items = (paths: string[]) =>
  menuGroupItems("copyPath", { paths }).filter(
    (i): i is Item => i.kind !== "separator" && "run" in i && i.id === "vcs.copyRepositoryPath",
  );
const preview = (paths: string[]) => items(paths)[0]?.preview;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("navigator", { clipboard: { writeText }, userAgent: navigator.userAgent });
  provideNotificationService({ notify });
  setContext("vcsAvailable", true);
  useVcs.setState({ roots: ["/w/api", "/w/web", "/w/api/third_party/lib"] });
  disposers.push(
    registerActions(copyRepositoryPathActions),
    registerCopyRepositoryPath(),
    registerAction({ id: "editor.showHint", title: "Hint", run: ({ arg }) => hint(arg) }),
  );
});

afterEach(() => {
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  useVcs.setState({ roots: [] });
  clearContext("vcsAvailable");
  vi.unstubAllGlobals();
});

describe("Copy Path/Reference… › Path From Repository Root", () => {
  it("offers the file's path from its repository's root and copies it", async () => {
    const [item] = items(["/w/api/internal/server.go"]);
    expect(item).toMatchObject({
      id: "vcs.copyRepositoryPath",
      label: "Path From Repository Root",
      preview: "internal/server.go",
    });
    item!.run!();
    await vi.waitFor(() => expect(hint).toHaveBeenCalledWith({ text: "Copied internal/server.go" }));
    expect(writeText).toHaveBeenCalledExactlyOnceWith("internal/server.go");
  });

  it("uses the innermost repository and gives each path its own repository, one per line", () => {
    expect(preview(["/w/api/third_party/lib/a.go"])).toBe("a.go");
    expect(preview(["/w/api/main.go", "/w/web/src/app.ts"])).toBe("main.go\nsrc/app.ts");
  });

  it("copies a repository's root as '.' and ignores a trailing slash", () => {
    expect(preview(["/w/api"])).toBe(".");
    expect(preview(["/w/api/"])).toBe(".");
    expect(preview(["/w/api/third_party/lib"])).toBe(".");
    expect(preview(["/w/web/src/"])).toBe("src");
  });

  it("leaves out paths outside every repository, and offers nothing when none is inside one", () => {
    expect(preview(["/w/api/a.go", "/w/notes.md", "/w/web/b.ts"])).toBe("a.go\nb.ts");
    expect(items(["/w/notes.md"])).toEqual([]);
    expect(items(["/w/api2/a.go"])).toEqual([]);
    expect(items(["/w/notes.md", "/w/api2/a.go"])).toEqual([]);
    expect(items([])).toEqual([]);
    useVcs.setState({ roots: [] });
    expect(items(["/w/api/a.go"])).toEqual([]);
  });

  it("reports a clipboard it cannot write to", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    items(["/w/api/a.go"])[0]!.run!();
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ level: "error", title: "Cannot access the clipboard", body: "denied" }),
      ),
    );
    expect(hint).not.toHaveBeenCalled();
  });
});
