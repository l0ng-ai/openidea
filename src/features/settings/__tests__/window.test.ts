import { describe, expect, it } from "vitest";
import { describeActions, settingsWindowParent } from "../window/bridge";

describe("settings window bridge", () => {
  it("maps settings window labels to their parent", () => {
    expect(settingsWindowParent("settings-main")).toBe("main");
    expect(settingsWindowParent("settings-project-2")).toBe("project-2");
    expect(settingsWindowParent("main")).toBeNull();
    expect(settingsWindowParent(null)).toBeNull();
  });

  it("describes actions without their handlers", () => {
    const [info] = describeActions([{ id: "a.b", title: "B", when: "editorFocus", run: () => {} }]);
    expect(info).toEqual({ id: "a.b", title: "B", when: "editorFocus" });
    expect(JSON.parse(JSON.stringify(info))).toEqual(info);
  });

  it("keeps the keymap flag so hidden Cut / Copy / Paste stay in the settings window's Keymap", () => {
    const [info] = describeActions([{ id: "edit.copy", title: "Copy", hidden: true, keymap: true, run: () => {} }]);
    expect(info).toMatchObject({ hidden: true, keymap: true });
  });
});
