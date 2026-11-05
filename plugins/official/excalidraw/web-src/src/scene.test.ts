import { describe, expect, it } from "vitest";
import {
  SOURCE,
  codec,
  exportName,
  isSvgFile,
  parseScene,
  parseSvgScene,
  sceneSignature,
  serializeScene,
  serializeSvgScene,
} from "./scene";

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

  it("reads and writes .excalidraw.svg files with embedded scene metadata", async () => {
    expect(isSvgFile("tachyon-architecture.excalidraw.svg")).toBe(true);
    expect(isSvgFile("diagram.excalidraw")).toBe(false);

    const original = scene(
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "https://excalidraw.com",
        elements: [{ type: "rectangle", x: 10, y: 20, width: 120, height: 60 }],
        appState: { viewBackgroundColor: "#f8fafc", gridSize: 20, gridStep: 5, gridModeEnabled: false },
      }),
    );

    const svg = await serializeSvgScene(original);
    expect(svg).toContain("<svg ");
    expect(svg).toContain("<!-- svg-source:excalidraw -->");
    expect(svg).toContain("<!-- payload-type:application/vnd.excalidraw+json -->");
    expect(svg).toContain("<!-- payload-version:2 -->");
    expect(svg).toContain("<!-- payload-start -->");
    expect(svg).toContain("<!-- payload-end -->");

    const parsed = await parseSvgScene(svg);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.scene.source).toBe("https://excalidraw.com");
    expect(parsed.scene.appState.viewBackgroundColor).toBe("#f8fafc");
    expect(parsed.scene.elements).toHaveLength(1);
    expect(parsed.scene.elements[0]).toMatchObject({ type: "rectangle", x: 10, y: 20, width: 120, height: 60 });
    expect(sceneSignature(parsed.scene)).toBe(sceneSignature(original));

    // Codec dispatches by filename for .excalidraw.svg and handles empty new SVG files.
    const emptySvg = await codec.parse("", "new.excalidraw.svg");
    expect(emptySvg).toHaveProperty("scene");
    const serializedByCodec = await codec.serialize(original, "arch.excalidraw.svg");
    expect(serializedByCodec).toContain("<svg ");
    const reparsedByCodec = await codec.parse(serializedByCodec, "arch.excalidraw.svg");
    expect(reparsedByCodec).toHaveProperty("scene");

    // Plain SVGs without embedded Excalidraw scene data or corrupt payloads are rejected.
    expect(await parseSvgScene('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toHaveProperty("error");
    expect(
      await parseSvgScene(
        "<svg><!-- payload-type:application/vnd.excalidraw+json --><!-- payload-start -->!bad!<!-- payload-end --></svg>",
      ),
    ).toHaveProperty("error");
  });

  it("names exports after the file", () => {
    expect(exportName("diagram.excalidraw")).toBe("diagram");
    expect(exportName("Flow.Excalidraw.json")).toBe("Flow");
    expect(exportName("tachyon-architecture.excalidraw.svg")).toBe("tachyon-architecture");
    expect(exportName("notes.v2.excalidraw")).toBe("notes.v2");
    expect(exportName("")).toBe("drawing");
  });
});
