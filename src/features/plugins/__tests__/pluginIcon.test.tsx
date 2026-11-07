import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Icon } from "@/ui/icons";
import { pluginIconName } from "../pluginIcon";

const svg = (shape: string, root = "") => `<svg viewBox="0 0 16 16"${root}>${shape}</svg>`;
const rendered = (name: string) => render(<Icon name={name} size={20} />).container;
const markup = (name: string) => rendered(name).innerHTML;

describe("pluginIconName", () => {
  it("gives plugins without an icon the generic one", () => {
    expect(pluginIconName("a.b", null)).toBe("plugin");
    expect(pluginIconName("a.b", undefined)).toBe("plugin");
  });

  it("renders a plugin's icon under a name of its own", () => {
    const name = pluginIconName("a.b", { light: svg('<rect width="16" height="16"/>'), dark: null });
    expect(name).toMatch(/^ext:pluginIcon\/a\.b\//);
    expect(markup(name)).toContain("<rect");
  });

  it("keeps two icons of the same plugin id apart (a marketplace and a local copy)", () => {
    const published = pluginIconName("a.b", { light: svg('<rect width="16" height="16"/>'), dark: null });
    const local = pluginIconName("a.b", { light: svg('<circle cx="8" cy="8" r="8"/>'), dark: null });
    expect(local).not.toBe(published);
    expect(markup(published)).toContain("<rect");
    expect(markup(local)).toContain("<circle");
  });

  it("registers the dark variant with it", () => {
    const name = pluginIconName("c.d", {
      light: svg('<rect width="16" height="16"/>'),
      dark: svg('<circle cx="8" cy="8" r="8"/>'),
    });
    expect(markup(name)).toContain("<circle");
  });

  it("keeps the icons of plugins whose ids differ by _dark apart", () => {
    const plain = pluginIconName("g", { light: svg('<rect width="16" height="16"/>'), dark: null });
    const other = pluginIconName("g_dark", { light: svg('<circle cx="8" cy="8" r="8"/>'), dark: null });
    expect(markup(plain)).not.toContain("<circle");
    expect(markup(other)).toContain("<circle");
  });

  it("gives a changed icon without a dark variant none", () => {
    pluginIconName("e.f", { light: svg('<rect width="16" height="16"/>'), dark: svg('<circle cx="8" cy="8" r="8"/>') });
    const name = pluginIconName("e.f", { light: svg('<rect width="16" height="16"/>'), dark: null });
    expect(markup(name)).not.toContain("<circle");
  });

  it("keeps the root's fill and stroke, and SVG's default black fill", () => {
    const filled = rendered(
      pluginIconName("h.i", {
        light: svg('<circle cx="8" cy="8" r="7"/>', ' fill="#E5A50A" stroke="#FFFFFF"'),
        dark: null,
      }),
    );
    const group = filled.querySelector("circle")?.closest("g");
    expect(group?.getAttribute("fill")).toBe("#E5A50A");
    expect(group?.getAttribute("stroke")).toBe("#FFFFFF");
    const plain = rendered(pluginIconName("j.k", { light: svg('<circle cx="8" cy="8" r="7"/>'), dark: null }));
    expect(plain.querySelector("circle")?.closest("g")?.getAttribute("fill")).toBe("#000");
  });
});
