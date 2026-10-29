import { expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { remeasureWhenFontsLoad, terminalFont } from "./theme";
import { DEFAULT_SETTINGS } from "@/features/settings/model/schema";

it("remeasures and fits after normal/bold faces load, but ignores a stale selection", async () => {
  let finish!: () => void;
  const loaded = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const load = vi.fn(() => loaded);
  const previous = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", { configurable: true, value: { load } });
  try {
    const font = terminalFont(DEFAULT_SETTINGS.terminal, { fontFamily: "Maple Mono NF", fontSize: 14, lineHeight: 20 });
    const updates: string[] = [];
    let current = font.family;
    const term = {
      options: {
        get fontFamily() {
          return current;
        },
        set fontFamily(value: string) {
          current = value;
          updates.push(value);
        },
      },
    } as unknown as Terminal;
    const fit = vi.fn();
    remeasureWhenFontsLoad(term, font, () => true, fit);
    expect(load).toHaveBeenCalledTimes(2);
    expect(fit).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(fit).toHaveBeenCalledOnce());
    expect(updates).toEqual(["monospace", font.family]);
    current = "Another Font";
    remeasureWhenFontsLoad(term, font, () => true, fit);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fit).toHaveBeenCalledOnce();
  } finally {
    if (previous) Object.defineProperty(document, "fonts", previous);
    else Reflect.deleteProperty(document, "fonts");
  }
});
