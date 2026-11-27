import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@/bindings";
import { _provideDocumentAttacher } from "@/editor/api";
import { createMemoryBackend } from "@/editor/core/backend";
import { attachDocument } from "@/editor/core/model/attachment";
import { DocumentManager, useDocMeta } from "@/editor/core/model/document";
import { EditorSlot, type SlotHost } from "@/editor/core/model/slot";
import { writeFileText } from "../ops";

const host: SlotHost = {
  onFocus: () => {},
  onBlur: () => {},
  onSelection: () => {},
  onUserEdit: () => {},
  onContextMenu: () => {},
};

const PATH = "/r/pom.xml";
const CONFLICT = "<<<<<<< HEAD\n<v>ours</v>\n=======\n<v>theirs</v>\n>>>>>>> other\n";
let backend: ReturnType<typeof createMemoryBackend>;
let manager: DocumentManager;

function setup(settings: Settings = {}) {
  backend = createMemoryBackend({ [PATH]: CONFLICT });
  manager = new DocumentManager(backend, { settings: () => settings, notify: vi.fn() });
  manager.start();
  _provideDocumentAttacher((p, options) => attachDocument(manager, p, options));
}

const saved = (path: string) => backend.files.get(path);

async function settle() {
  // oxlint-disable-next-line no-await-in-loop -- each tick flushes work scheduled during the previous tick
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => setup());
afterEach(() => {
  manager.stop();
  _provideDocumentAttacher(null);
  useDocMeta.setState({}, true);
});

// A tab in the background of its pane (behind the merge editor): shown once, then hidden, so it
// keeps a detached view and isn't among the editors.
async function backgroundTab() {
  const tab = new EditorSlot(await manager.acquire(PATH), "t1", host);
  tab.mount(document.createElement("div"));
  tab.unmount();
  return tab;
}

/** What the tab shows when brought back to the front. */
const shown = (tab: EditorSlot) => tab.mount(document.createElement("div")).state.doc.toString();

describe("writeFileText without an editor view of the file", () => {
  it("shows the written text in a background tab of the file", async () => {
    const tab = await backgroundTab();
    try {
      await writeFileText(PATH, "<v>ours</v>\n", { save: true, exact: true });
      expect(saved(PATH)).toBe("<v>ours</v>\n");
      expect(shown(tab)).toBe("<v>ours</v>\n");
      expect(useDocMeta.getState()[PATH]?.dirty).toBeFalsy();
    } finally {
      tab.dispose();
    }
  });

  it("replaces the unsaved text of a background tab, not the text on disk", async () => {
    const tab = await backgroundTab();
    try {
      tab.dispatchLocal({ changes: { from: 0, insert: "<!-- unsaved, longer than the file -->\n" } });
      await writeFileText(PATH, "<v>theirs</v>\n", { save: true, exact: true });
      expect(saved(PATH)).toBe("<v>theirs</v>\n");
      expect(shown(tab)).toBe("<v>theirs</v>\n");
    } finally {
      tab.dispose();
    }
  });

  it("writes a file that no tab shows as is and leaves nothing open", async () => {
    manager.stop();
    setup({ files: { ensureFinalNewline: true, trimTrailingWhitespace: true } });
    await writeFileText(PATH, "<v>kept</v>  ", { save: true });
    expect(saved(PATH)).toBe("<v>kept</v>  ");
    await settle();
    expect(manager.get(PATH)).toBeUndefined();
    expect([...backend.docs.values()].some((d) => d.path === PATH)).toBe(false);
  });

  it("a background tab follows a change the backend made to its document", async () => {
    // Accept Yours / Theirs resolve through Git; the backend reloads the open document.
    const tab = await backgroundTab();
    try {
      backend.patch(manager.get(PATH)!.doc, [{ from: 0, to: CONFLICT.length, insert: "<v>ours</v>\n" }]);
      await settle();
      expect(shown(tab)).toBe("<v>ours</v>\n");
    } finally {
      tab.dispose();
    }
  });
});
