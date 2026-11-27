import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// `.iconButton:disabled { opacity: 0.4 }` (src/ui/Button.module.css) outranks a bare `.rowButton`, so a
// disabled row button (program running, list outdated) would show on every row unless hidden again.
describe.each(["MemoryView", "InstancesPane"])("%s row buttons", (name) => {
  const css = readFileSync(`src/features/debugger/memory/${name}.module.css`, "utf8");

  it("stay hidden when disabled, outside the hovered or lead row", () => {
    expect(css).toMatch(/\.row \.rowButton:disabled \{[^}]*opacity: 0;/);
  });

  it("show disabled ones faded on the hovered row", () => {
    expect(css).toMatch(/\.row:hover \.rowButton:disabled[^{]*\{[^}]*opacity: 0\.4;/);
  });
});

// The pane has a fixed height: in a short Debug tool window it squeezed the class table to nothing,
// whose header and footer then painted over the pane, and the pane's last rows fell out of view.
describe("instances pane in a short Memory view", () => {
  const read = (name: string) => readFileSync(`src/features/debugger/memory/${name}.module.css`, "utf8");

  it("takes at most 60% of the view", () => {
    expect(read("InstancesPane")).toMatch(/\.pane \{[^}]*height: min\([^;]*, 60%\);/);
  });

  it("keeps the squeezed class table from painting over it", () => {
    expect(read("MemoryView")).toMatch(/\.table \{[^}]*overflow: hidden;/);
  });

  it("shrinks before the class table, which keeps a few rows", () => {
    expect(read("InstancesPane")).toMatch(/\.pane \{[^}]*flex: 0 1 auto;[^}]*min-height: calc\(/);
    expect(read("MemoryView")).toMatch(/\.table \{[^}]*min-height: calc\([^;]*3 \* 22px\);/);
    expect(read("MemoryView")).toMatch(/\.root \{[^}]*overflow-y: auto;/);
  });
});
