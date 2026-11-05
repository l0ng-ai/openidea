import { expect, test } from "@playwright/test";

test("local terminal stores clipboard media and pastes one shell-quoted argument", async ({ page }) => {
  await page.goto("/");
  const observed = await page.evaluate(async () => {
    const ipcPath = "/src/platform/ipc.ts";
    const sessionPath = "/src/features/terminal/session.ts";
    const { commands } = await import(ipcPath);
    const { TerminalSession } = await import(sessionPath);
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: { transformCallback: () => 1 },
    });
    const stored: { id: number; data: number[]; mime: string }[] = [];
    const writes: string[] = [];
    commands.termSpawn = async () => ({ status: "ok", data: { id: 838, title: "pwsh", pid: 1 } });
    commands.clipboardFileList = async () => ({ status: "ok", data: [] });
    commands.termStoreImage = async (id: number, data: number[], mime: string) => {
      stored.push({ id, data, mime });
      return { status: "ok", data: "C:\\Temp\\a'b c\\image.png" };
    };
    commands.termWrite = async (_id: number, data: string) => writes.push(data);
    commands.termResize = async () => undefined;
    commands.termKill = async () => undefined;
    const container = document.createElement("div");
    container.style.cssText = "position:fixed;inset:0;z-index:99999";
    document.body.append(container);
    const session = new TerminalSession({ key: "clipboard", cwd: "C:/Temp", onChange() {}, onFocus() {} });
    try {
      session.attach(container);
      await session.start();
      // xterm opens on a later frame, once the pane has a size.
      const openDeadline = Date.now() + 5000;
      while (!container.querySelector("textarea") && Date.now() < openDeadline) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" }));
      const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer });
      container.querySelector("textarea")!.dispatchEvent(event);
      const deadline = Date.now() + 5000;
      while (!writes.length && Date.now() < deadline) await new Promise((resolve) => requestAnimationFrame(resolve));
      return { stored, writes, claimed: event.defaultPrevented };
    } finally {
      session.dispose();
      container.remove();
    }
  });
  expect(observed.claimed).toBe(true);
  expect(observed.stored).toEqual([{ id: 838, data: [137, 80, 78, 71], mime: "image/png" }]);
  expect(observed.writes).toEqual(["'C:\\Temp\\a''b c\\image.png'"]);
});
