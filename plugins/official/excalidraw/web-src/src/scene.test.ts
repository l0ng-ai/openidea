import { describe, expect, it } from "vitest";
import { SOURCE, exportName, parseScene, serializeScene } from "./scene";

const scene = (text: string) => {
  const parsed = parseScene(text);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.scene;
};

describe("scene files", () => {
  it("keeps the file's source and writes ours, never the page's address, when it had none", () => {
    const own = JSON.parse(
      serializeScene(scene('{"type":"excalidraw","source":"https://excalidraw.com","elements":[]}')),
    );
    expect(own.source).toBe("https://excalidraw.com");
    const none = JSON.parse(serializeScene(scene('{"type":"excalidraw","elements":[]}')));
    expect(none.source).toBe(SOURCE);
    for (const page of ["openidea-plugin://localhost", "http://openidea-plugin.localhost"]) {
      const fixed = JSON.parse(serializeScene(scene(`{"type":"excalidraw","source":"${page}","elements":[]}`)));
      expect(fixed.source).toBe(SOURCE);
    }
  });

  it("reads element skeletons and refuses what isn't a drawing", () => {
    // (Labels become text elements in the browser; jsdom can't measure text.)
    const s = scene('[{"type":"rectangle","x":0,"y":0,"width":10,"height":10}]');
    expect(s.elements[0]).toMatchObject({ type: "rectangle", width: 10 });
    expect(typeof s.elements[0]!.seed).toBe("number");
    expect(parseScene("{not json")).toHaveProperty("error");
    expect(parseScene('{"type":"other"}')).toHaveProperty("error");
    expect(parseScene("")).toHaveProperty("scene");
  });

  it("names exports after the file", () => {
    expect(exportName("diagram.excalidraw")).toBe("diagram");
    expect(exportName("Flow.Excalidraw.json")).toBe("Flow");
    expect(exportName("notes.v2.excalidraw")).toBe("notes.v2");
    expect(exportName("")).toBe("drawing");
  });
});
