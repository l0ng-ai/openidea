import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Icon } from "@/ui/icons";
import { pluginIconName } from "../pluginIcon";

const svg = (shape: string) => `<svg viewBox="0 0 16 16">${shape}</svg>`;
const markup = (name: string) => render(<Icon name={name} size={20} />).container.innerHTML;

describe("pluginIconName", () => {
  it("gives plugins without an icon the generic one", () => {
    expect(pluginIconName("a.b", null)).toBe("plugin");
    expect(pluginIconName("a.b", undefined)).toBe("plugin");
  });

  it("renders a plugin's icon, and a changed icon replaces it", () => {
    const name = pluginIconName("a.b", { light: svg('<rect width="16" height="16"/>'), dark: null });
    expect(name).toBe("ext:pluginIcon/a.b/icon");
    expect(markup(name)).toContain("<rect");
    pluginIconName("a.b", { light: svg('<circle cx="8" cy="8" r="8"/>'), dark: null });
    expect(markup(name)).toContain("<circle");
    expect(markup(name)).not.toContain("<rect");
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
    pluginIconName("g", { light: svg('<rect width="8" height="8"/>'), dark: null });
    expect(markup(other)).toContain("<circle");
  });

  it("drops a dark variant the plugin no longer has", () => {
    pluginIconName("e.f", { light: svg('<rect width="16" height="16"/>'), dark: svg('<circle cx="8" cy="8" r="8"/>') });
    const name = pluginIconName("e.f", { light: svg('<rect width="16" height="16"/>'), dark: null });
    expect(markup(name)).not.toContain("<circle");
  });
});
