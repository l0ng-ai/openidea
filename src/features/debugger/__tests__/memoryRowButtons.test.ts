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
