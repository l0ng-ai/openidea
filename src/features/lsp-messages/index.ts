/**
 * Language-server questions with action buttons (`window/showMessageRequest`).
 * Dart uses this to ask "Rename Anyway" when a rename would be invisible in
 * another file; answering null makes the server cancel the rename.
 */
import { call, commands, onIdeEvent } from "@/platform/ipc";
import { ask } from "@/workbench/messages";

const pending = new Map<number, AbortController>();

export function activate(): () => void {
  const disposers = [
    onIdeEvent("lspMessageRequest", async (event) => {
      const controller = new AbortController();
      pending.set(event.id, controller);
      const buttons = event.actions.map((label, index) => ({ id: String(index), label, primary: index === 0 }));
      const result = await ask({
        title: event.server,
        body: event.message,
        buttons,
        // The server may already offer its own Cancel; don't add a second one.
        cancel: !event.actions.some((label) => /cancel/i.test(label)),
        verbatim: true,
        signal: controller.signal,
      });
      if (pending.get(event.id) !== controller) return;
      pending.delete(event.id);
      const index = Number(result.button);
      const choice = Number.isInteger(index) ? (event.actions[index] ?? null) : null;
      await call(commands.lspMessageRequestAnswer(event.id, choice));
    }),
    onIdeEvent("lspMessageRequestDone", (event) => {
      pending.get(event.id)?.abort();
      pending.delete(event.id);
    }),
  ];
  return () => {
    disposers.forEach((dispose) => dispose());
    pending.forEach((controller) => controller.abort());
    pending.clear();
  };
}
