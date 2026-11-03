import type { CodeAction, CommandForm, FormAnswer, IdeError } from "@/bindings";
import { commands, IpcError, nextRequestId } from "@/platform/ipc";
import { editorService } from "@/workbench/contributions";
import { promptInput } from "@/workbench/inputDialogs";
import { ask } from "@/workbench/messages";
import { tx } from "@/platform/i18n";
import { lspRequest } from "./lsp";

type Result<T> = { status: "ok"; data: T } | { status: "error"; error: IdeError };

async function request<T>(title: string, run: (id: number) => Promise<Result<T>>, signal?: AbortSignal): Promise<T> {
  const id = nextRequestId();
  const dismiss = new AbortController();
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    void commands.cancelRequest(id).catch(() => {});
  };
  if (signal?.aborted) throw new IpcError({ kind: "cancelled", message: "cancelled" });
  signal?.addEventListener("abort", cancel, { once: true });
  // The input dialog already provides Cancel while validating an answer.
  const timer = signal
    ? undefined
    : setTimeout(() => {
        void ask({ title, body: tx("Waiting for language server…"), buttons: [], signal: dismiss.signal }).then((r) => {
          if (r.button === "cancel") cancel();
        });
      }, 400);
  try {
    const result = await lspRequest(
      () => run(id),
      () => !cancelled,
    );
    if (cancelled) throw new IpcError({ kind: "cancelled", message: "cancelled" });
    return result;
  } finally {
    clearTimeout(timer);
    dismiss.abort();
    signal?.removeEventListener("abort", cancel);
  }
}

/** Interactive resolution starts on invocation only, never while rendering a preview. */
export async function runInteractiveCodeAction(doc: number, selected: CodeAction): Promise<boolean> {
  let action = selected;
  if (!action.edit && !action.command) action = await lspRequest(() => commands.lspResolveCodeAction(doc, action));
  let answers: FormAnswer[] = [];
  if (action.command) {
    let form = await request(action.title, (r) =>
      commands.lspResolveCommand(r, doc, action.server, action.command!, answers),
    );
    while (form?.formFields.length) {
      const current: CommandForm = form;
      const field = current.formFields[0]!;
      let next: CommandForm | null = current;
      const value = await promptInput({
        title: field.description,
        label: field.description,
        initial: current.formAnswers.find((a) => a.id === field.id)?.value ?? field.default ?? "",
        error: field.error ?? undefined,
        validate: (v) => (field.required && !v.trim() ? tx("Value must not be empty") : null),
        submit: async (value, signal) => {
          const submitted = current.formAnswers.filter((a) => a.id !== field.id);
          submitted.push({ id: field.id, value });
          next = await request(
            action.title,
            (r) => commands.lspResolveCommand(r, doc, action.server, current.command, submitted),
            signal,
          );
          return next?.formFields.find((f) => f.id === field.id)?.error ?? null;
        },
      });
      if (value === null) return false;
      form = next;
    }
    if (form) {
      answers = form.formAnswers;
      action = { ...action, command: form.command };
    }
  }
  const created = await request(action.title, (r) => commands.lspExecuteCodeAction(r, doc, action, answers));
  if (created[0]) await editorService().openFile(created[0]);
  return true;
}
