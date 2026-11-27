import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocModel } from "./model/document";
import { offerMakeWritable, readOnlyQuestion, toggleReadOnly } from "./fileAttributes";

function model(readOnly: boolean, extra: Partial<{ virtual: boolean; banner: string | null }> = {}) {
  const meta = { readOnly, banner: extra.banner ?? (readOnly ? "readOnly" : null) };
  return {
    path: "/p/a.txt",
    virtual: extra.virtual ?? false,
    getMeta: () => meta,
    setReadOnly: vi.fn((ro: boolean) => void (meta.readOnly = ro)),
  } as unknown as DocModel & { setReadOnly: ReturnType<typeof vi.fn> };
}

let answer = true;
const { confirm } = vi.hoisted(() => ({ confirm: vi.fn(async () => answer) }));
vi.mock("@/workbench/messages", () => ({ confirm }));

beforeEach(() => confirm.mockClear());

describe("Toggle Read-only Attribute", () => {
  it("asks before making a read-only file writable, then toggles", async () => {
    const m = model(true);
    answer = true;
    toggleReadOnly(m);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Make File Writable", ok: "Make Writable" }));
    await vi.waitFor(() => expect(m.setReadOnly).toHaveBeenCalledWith(false));
  });

  it("Cancel leaves the file alone", async () => {
    const m = model(false);
    answer = false;
    toggleReadOnly(m);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Make File Read-only" }));
    await Promise.resolve();
    expect(m.setReadOnly).not.toHaveBeenCalled();
  });

  it("does nothing for library and binary documents", () => {
    toggleReadOnly(model(true, { virtual: true }));
    toggleReadOnly(model(true, { banner: "binary" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(readOnlyQuestion("a.txt", false).confirm).toBe("Make Read-only");
  });
});

describe("editing a read-only file", () => {
  it("offers to make it writable once, then lets edits through", async () => {
    const m = model(true);
    answer = true;
    expect(offerMakeWritable(m)).toBe(true);
    expect(offerMakeWritable(m)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Make File Writable" }));
    await vi.waitFor(() => expect(m.setReadOnly).toHaveBeenCalledWith(false));
    expect(offerMakeWritable(m)).toBe(false);
  });

  it("refuses edits without asking for library, binary and too-large documents", () => {
    for (const m of [
      model(true, { virtual: true }),
      model(true, { banner: "binary" }),
      model(true, { banner: "tooLarge" }),
    ])
      expect(offerMakeWritable(m)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(offerMakeWritable(model(false))).toBe(false);
  });
});
