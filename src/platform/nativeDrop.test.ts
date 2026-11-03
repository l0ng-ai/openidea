import { describe, expect, it } from "vitest";
import { nativeDropPoint } from "./nativeDrop";

describe("native drop coordinates", () => {
  for (const os of ["macos", "linux", "windows"]) {
    for (const scale of [1, 1.5, 2, 3]) {
      for (const zoom of [0.5, 1, 1.25, 2, 3]) {
        it(`${os}, display scale ${scale}, zoom ${zoom}`, () => {
          // Native Cocoa/GTK locations are unzoomed logical points; Win32 is physical.
          const unit = os === "windows" ? scale * zoom : zoom;
          const dpr = os === "windows" ? scale * zoom : scale;
          for (const point of [
            { x: 122, y: 116 },
            { x: 122, y: 236 },
            { x: 700, y: 800 },
          ]) {
            const native = { x: point.x * unit, y: point.y * unit };
            expect(nativeDropPoint(native, os, dpr, zoom)).toEqual(point);
          }
        });
      }
    }
  }

  it("matches measured Retina macOS positions at 100% and 125%", () => {
    expect(nativeDropPoint({ x: 122, y: 236 }, "macos", 2, 1)).toEqual({ x: 122, y: 236 });
    expect(nativeDropPoint({ x: 152, y: 295 }, "macos", 2, 1.25)).toEqual({ x: 121.6, y: 236 });
  });
});
