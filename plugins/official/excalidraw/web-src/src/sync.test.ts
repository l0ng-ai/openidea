import { describe, expect, it, vi } from "vitest";
import { DocumentSync, type SceneCodec, type SyncPort } from "./sync";

/** Scenes are plain strings here: the text is the scene. */
const codec: SceneCodec<string> = {
  parse: (text) => (text.startsWith("!") ? { error: "bad" } : { scene: text }),
  serialize: (scene) => scene,
  signature: (scene) => scene,
};

function port(initial: string) {
  let version = 0;
  let text = initial;
  let listener: (s: { version: number; text: string }) => void = () => {};
  const p = {
    get: vi.fn(async () => ({ version, text, readOnly: false, name: "a.excalidraw" })),
    replace: vi.fn(async (at: number, next: string) => {
      if (at !== version) throw new Error("stale");
      text = next;
      return { version: ++version };
    }),
    onChange: (fn: typeof listener) => void (listener = fn),
    /** An edit made in the text editor. */
    external(next: string) {
      text = next;
      listener({ version: ++version, text });
    },
    text: () => text,
  } satisfies SyncPort & Record<string, unknown>;
  return p;
}

const hooks = () => ({ apply: vi.fn(), error: vi.fn() });

describe("DocumentSync", () => {
  it("starts from the document and writes canvas changes back, once per saved change", async () => {
    const p = port("a");
    const h = hooks();
    const sync = new DocumentSync(p, codec, h, 0);
    expect(await sync.start()).toEqual({ scene: "a", error: null, readOnly: false, name: "a.excalidraw" });
    sync.changed("a");
    await sync.flush();
    expect(p.replace).not.toHaveBeenCalled();
    sync.changed("ab");
    sync.changed("abc");
    await sync.flush();
    expect(p.replace).toHaveBeenCalledTimes(1);
    expect(p.text()).toBe("abc");
  });

  it("shows edits made elsewhere and doesn't write them back", async () => {
    const p = port("a");
    const h = hooks();
    const sync = new DocumentSync(p, codec, h, 0);
    await sync.start();
    p.external("from the text editor");
    expect(h.apply).toHaveBeenCalledWith("from the text editor");
    sync.changed("from the text editor");
    await sync.flush();
    expect(p.replace).not.toHaveBeenCalled();
    // The next canvas edit is based on the new version.
    sync.changed("canvas");
    await sync.flush();
    expect(p.text()).toBe("canvas");
  });

  it("lets the document win a race: a stale write is dropped and the canvas takes the text", async () => {
    const p = port("a");
    const h = hooks();
    const sync = new DocumentSync(p, codec, h, 0);
    await sync.start();
    sync.changed("canvas");
    // The document moved on without the sync hearing of it yet.
    p.replace.mockImplementationOnce(async () => {
      throw new Error("stale");
    });
    await sync.flush();
    expect(p.get).toHaveBeenCalledTimes(2);
    expect(p.text()).toBe("a");
  });

  it("never overwrites text that doesn't parse, and resumes when it does", async () => {
    const p = port("a");
    const h = hooks();
    const sync = new DocumentSync(p, codec, h, 0);
    await sync.start();
    p.external("!broken");
    expect(h.error).toHaveBeenLastCalledWith("bad");
    sync.changed("canvas");
    await sync.flush();
    expect(p.text()).toBe("!broken");
    p.external("fixed");
    expect(h.error).toHaveBeenLastCalledWith(null);
    sync.changed("canvas");
    await sync.flush();
    expect(p.text()).toBe("canvas");
  });

  it("starts read-only and invalid documents without writing", async () => {
    const p = port("!broken");
    const sync = new DocumentSync(p, codec, hooks(), 0);
    expect(await sync.start()).toEqual({ scene: null, error: "bad", readOnly: false, name: "a.excalidraw" });
    sync.changed("x");
    await sync.flush();
    expect(p.replace).not.toHaveBeenCalled();
  });
});
