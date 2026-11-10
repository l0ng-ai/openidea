import { afterEach, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import * as ui from "@/ui";
import { dockerGutter } from "./dockerGutter";
import { useComposeFiles } from "./compose";

afterEach(() => {
  vi.restoreAllMocks();
  useComposeFiles.setState({ overrides: {}, contentDetected: {} });
});

it("refreshes markers and menus after edits, removes non-service keys and respects exclusions", async () => {
  const menu = vi.spyOn(ui, "showContextMenu").mockImplementation(() => {});
  const view = new EditorView({
    doc: "services:\n  web:\n    image: nginx\n  x-defaults:\n    image: nginx\nvolumes:\n  data:\n",
    parent: document.body,
    extensions: dockerGutter({ doc: 1, path: "/p/stack.yml", language: "yaml", uiMode: null, readOnly: false }),
  });
  const markers = () => [...view.dom.querySelectorAll<HTMLButtonElement>(".cm-gutterElement button")];
  try {
    await vi.waitFor(() => expect(markers().map((m) => m.title)).toContain("Compose Up 'web'"));
    expect(markers().some((m) => m.title.includes("x-defaults") || m.title.includes("data"))).toBe(false);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "# moved\nservices:\n  db:\n    image: postgres\n" },
    });
    await vi.waitFor(() => expect(markers().some((m) => m.title === "Compose Up 'db'")).toBe(true));
    expect(markers().some((m) => m.title === "Compose Up 'web'")).toBe(false);
    markers()
      .find((m) => m.title === "Compose Up 'db'")!
      .click();
    expect(menu).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ label: "Compose Up 'db'" }),
        expect.objectContaining({ label: "Modify Run Configuration…" }),
      ]),
    );
    useComposeFiles.setState({ overrides: { "/p/stack.yml": "excluded" } });
    await vi.waitFor(() => expect(markers()).toHaveLength(0));
  } finally {
    view.destroy();
  }
});
