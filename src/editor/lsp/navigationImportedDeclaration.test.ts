import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { commands, Location } from "@/platform/ipc";

// A name imported from an attached project: the server analyses one root, so it answers the
// import statement instead of the declaration the module holds.
const { lspGoto, navResolveModule, navIndexDefinitions, fsReadText } = vi.hoisted(() => ({
  lspGoto: vi.fn<typeof commands.lspGoto>(),
  navResolveModule: vi.fn<typeof commands.navResolveModule>(),
  navIndexDefinitions: vi.fn<typeof commands.navIndexDefinitions>(),
  fsReadText: vi.fn<typeof commands.fsReadText>(async () => ({
    status: "error" as const,
    error: { kind: "notFound" as const, message: "not found" },
  })),
}));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: { ...real.commands, lspGoto, navResolveModule, navIndexDefinitions, fsReadText },
  };
});
vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<object>()),
  Channel: class {
    onmessage = () => {};
  },
}));

const { gotoTargets } = await import("./navigation");
const { lspDoc } = await import("./lsp");
const { closePopup } = await import("./popupStore");
const { provideEditorService } = await import("@/workbench/contributions");
const openFile = vi.fn(async () => {});
provideEditorService({ openFile } as never);

const span = (line: number, col: number) => ({ start: { line, col }, end: { line, col } });
const at = (path: string, line: number): Location => ({ path, range: span(line, 0) });

let view: EditorView;
/** Opens `text` and keeps it; returns the offset of the `occurrence`-th `name` in it. */
const openAt = (text: string, name: string, occurrence = 0) => {
  view?.destroy();
  view = new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: [lspDoc.of({ doc: 1, path: "/p/x.py", language: "python", uiMode: "Python", readOnly: false })],
    }),
    parent: document.body,
  });
  let from = -1;
  for (let i = 0; i <= occurrence; i++) from = text.indexOf(name, from + 1);
  view.dispatch({ selection: { anchor: from + 1 } });
};

beforeEach(() => {
  vi.clearAllMocks();
  lspGoto.mockResolvedValue({ status: "ok", data: [at("/p/x.py", 0)] });
  navResolveModule.mockResolvedValue({ status: "ok", data: "/dep/base.py" });
  navIndexDefinitions.mockResolvedValue({
    status: "ok",
    data: [{ path: "/dep/base.py", range: span(0, 6), name: "Base", kind: "class", container: null }],
  } as never);
});
afterEach(() => {
  closePopup();
  view?.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("go to declaration on a Python name imported from another project", () => {
  it("resolves a class base name to the class, not the import", async () => {
    openAt("from dep.base import Base\n\nclass X(Base):\n    pass\n", "Base", 1);
    await gotoTargets(view, "definition");
    expect(openFile).toHaveBeenCalledWith("/dep/base.py", { selection: { line: 0, col: 6 }, focus: true });
  });

  it("resolves a plain usage to the class, not the import", async () => {
    openAt("from dep.base import Base\n\n\ndef make():\n    return Base()\n", "Base", 1);
    await gotoTargets(view, "definition");
    expect(openFile).toHaveBeenCalledWith("/dep/base.py", { selection: { line: 0, col: 6 }, focus: true });
  });

  it("resolves a base name written with an import alias", async () => {
    openAt("from dep.base import Base as Parent\n\nclass X(Parent):\n    pass\n", "Parent", 1);
    await gotoTargets(view, "definition");
    expect(openFile).toHaveBeenCalledWith("/dep/base.py", { selection: { line: 0, col: 6 }, focus: true });
  });

  it("resolves a subscripted base to the class it parameterises", async () => {
    openAt("from dep.base import Base\n\nclass X(Base[int]):\n    pass\n", "Base", 1);
    await gotoTargets(view, "definition");
    expect(openFile).toHaveBeenCalledWith("/dep/base.py", { selection: { line: 0, col: 6 }, focus: true });
  });

  it("opens the module when the index has no symbol of that name", async () => {
    navIndexDefinitions.mockResolvedValue({ status: "ok", data: [] } as never);
    openAt("from dep.base import Thing\n\nclass X(Thing):\n    pass\n", "Thing", 1);
    await gotoTargets(view, "definition");
    expect(openFile).toHaveBeenCalledWith("/dep/base.py", { selection: { line: 0, col: 0 }, focus: true });
  });

  it("keeps a server answer that is not the import statement", async () => {
    lspGoto.mockResolvedValue({ status: "ok", data: [at("/dep/other.py", 3)] });
    openAt("from dep.base import Base\n\nvalue = Base\n", "Base", 1);
    await gotoTargets(view, "definition");
    expect(openFile).toHaveBeenCalledWith("/dep/other.py", { selection: { line: 3, col: 0 }, focus: true });
  });
});
