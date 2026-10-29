import { describe, expect, it, vi } from "vitest";
import {
  registerFileEditorProvider,
  registerTextEditorWrapper,
  resolveFileEditor,
  textEditorWrapperFor,
  useTextEditorWrappers,
} from "./contributions";

describe("file editor providers", () => {
  it("asks providers in order; failures fall through; disposal removes them", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const disposers = [
      registerFileEditorProvider({
        id: "late",
        order: 50,
        resolve: (p) => ({ kind: "late", key: `late:${p}`, path: p }),
      }),
      registerFileEditorProvider({
        id: "broken",
        order: 5,
        resolve: () => Promise.reject(new Error("no backend")),
      }),
      registerFileEditorProvider({
        id: "png",
        order: 10,
        resolve: (p) => (p.endsWith(".png") ? { kind: "image", key: p, path: p } : null),
      }),
    ];
    expect((await resolveFileEditor("/a.png"))?.input.kind).toBe("image");
    expect((await resolveFileEditor("/a.txt"))?.input.kind).toBe("late");
    disposers.forEach((d) => d());
    expect(await resolveFileEditor("/a.png")).toBeNull();
  });

  it("releases a failed provider's acquisition before trying the next provider", async () => {
    const live = new Set(["failed", "winner"]);
    const disposers = [
      registerFileEditorProvider({
        id: "acquired-failure",
        order: 1,
        resolve: (_path, context) => {
          context.onAdmission(
            () => {},
            async () => {
              live.delete("failed");
            },
          );
          throw new Error("probe failed after acquisition");
        },
      }),
      registerFileEditorProvider({
        id: "acquired-winner",
        order: 2,
        resolve: (_path, context) => {
          context.onAdmission(
            () => {},
            async () => {
              live.delete("winner");
            },
          );
          return { kind: "viewer", key: "winner" };
        },
      }),
    ];
    try {
      const resolution = (await resolveFileEditor("/a"))!;
      expect(live).toEqual(new Set(["winner"]));
      await resolution.rollback();
      expect(live).toEqual(new Set());
    } finally {
      disposers.forEach((dispose) => dispose());
    }
  });

  it("finds the text editor wrapper of a path", () => {
    const dispose = registerTextEditorWrapper({ id: "md", matches: (p) => p.endsWith(".md"), component: () => null });
    const wrappers = useTextEditorWrappers.getState().wrappers;
    expect(textEditorWrapperFor(wrappers, "/r/README.md")?.id).toBe("md");
    expect(textEditorWrapperFor(wrappers, "/r/a.ts")).toBeUndefined();
    dispose();
    expect(useTextEditorWrappers.getState().wrappers.size).toBe(0);
  });
});
