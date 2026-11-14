/** Appearance › Background Image: stored value validation and the variables the workbench draws from. */
import { afterEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  pending: new Map<string, (url: string) => void>(),
  read: vi.fn(),
}));
vi.mock("@/platform/ipc", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  call: (p: Promise<string>) => p,
  commands: {
    fsReadImage: (path: string) => {
      ipc.read(path);
      return new Promise<string>((resolve) => ipc.pending.set(path, resolve));
    },
  },
}));

import { applyBackgroundImage } from "../appearanceRuntime";
import { validateAppearanceExtras, type BackgroundImageValid } from "../model/behaviorSchema";

const image = (patch: Partial<BackgroundImageValid> = {}): BackgroundImageValid => ({
  ...validateAppearanceExtras({}).backgroundImage,
  path: "/pics/a.png",
  ...patch,
});
const flush = () => new Promise((r) => setTimeout(r, 0));
const vars = (root: HTMLElement) =>
  Object.fromEntries(
    ["image", "opacity", "size", "repeat", "position"].map((k) => [
      k,
      root.style.getPropertyValue(k === "image" ? "--background-image" : `--background-image-${k}`),
    ]),
  );

afterEach(() => {
  applyBackgroundImage(image({ path: "" }), document.createElement("div"));
  ipc.pending.clear();
  ipc.read.mockClear();
});

describe("background image settings", () => {
  it("default to no image at 15% opacity, scaled and centred", () => {
    expect(validateAppearanceExtras({}).backgroundImage).toEqual({
      path: "",
      opacity: 15,
      fill: "scale",
      anchor: "center",
    });
  });

  it("clamp opacity and drop unknown fill and anchor values", () => {
    const bg = validateAppearanceExtras({
      backgroundImage: { path: " /a.png ", opacity: 140, fill: "stretch", anchor: "middle" },
    }).backgroundImage;
    expect(bg).toEqual({ path: "/a.png", opacity: 100, fill: "scale", anchor: "center" });
    expect(validateAppearanceExtras({ backgroundImage: "x" }).backgroundImage.path).toBe("");
  });
});

describe("applyBackgroundImage", () => {
  it("sets the layout at once and the image when it has loaded", async () => {
    const root = document.createElement("div");
    applyBackgroundImage(image({ opacity: 30, fill: "tile", anchor: "bottom-right" }), root);
    expect(vars(root)).toEqual({
      image: "",
      opacity: "0.3",
      size: "auto",
      repeat: "repeat",
      position: "bottom right",
    });
    ipc.pending.get("/pics/a.png")!("data:image/png;base64,AAA");
    await flush();
    expect(vars(root).image).toBe('url("data:image/png;base64,AAA")');
  });

  it("reads the file once per path; layout changes reuse the loaded image", async () => {
    const root = document.createElement("div");
    applyBackgroundImage(image(), root);
    ipc.pending.get("/pics/a.png")!("data:a");
    await flush();
    applyBackgroundImage(image({ opacity: 50, fill: "plain" }), root);
    expect(ipc.read).toHaveBeenCalledTimes(1);
    expect(vars(root)).toMatchObject({ image: 'url("data:a")', opacity: "0.5", size: "auto", repeat: "no-repeat" });
  });

  it("ignores an image that finishes loading after another was picked", async () => {
    const root = document.createElement("div");
    applyBackgroundImage(image(), root);
    applyBackgroundImage(image({ path: "/pics/b.png" }), root);
    ipc.pending.get("/pics/b.png")!("data:b");
    ipc.pending.get("/pics/a.png")!("data:a");
    await flush();
    expect(vars(root).image).toBe('url("data:b")');
  });

  it("clears everything without a path or at 0% opacity", async () => {
    const root = document.createElement("div");
    applyBackgroundImage(image(), root);
    ipc.pending.get("/pics/a.png")!("data:a");
    await flush();
    applyBackgroundImage(image({ opacity: 0 }), root);
    expect(Object.values(vars(root)).every((v) => v === "")).toBe(true);
    // Shown again: the file is read again.
    applyBackgroundImage(image(), root);
    expect(ipc.read).toHaveBeenCalledTimes(2);
  });
});
