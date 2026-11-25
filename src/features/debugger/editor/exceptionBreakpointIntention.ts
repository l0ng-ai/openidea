/**
 * IDEA's Create / Enable / Disable exception breakpoint intention (ControlExceptionBreakpointIntentionAction)
 * on a reference to a Java exception class, its declaration or a throw of it. The language server
 * names the class; the breakpoint is one of the Java Exception Breakpoints, never removed here.
 */
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { asyncIntentionProviders, whenSynced, type ContributedIntention, type EditorDocContext } from "@/editor/api";
import { call, commands, nextRequestId, type ExceptionClassRef } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { addExceptionClass, updateExceptionClass, useExceptionClasses } from "../breakpoints/exceptionClasses";

const firstNamed = (qualifiedName: string) =>
  useExceptionClasses.getState().list.find((b) => b.className.trim() === qualifiedName);

/** IDEA decides between creating and switching when it offers the action, and applies that on run. */
function controlExceptionClass(qualifiedName: string, enable: boolean) {
  const existing = firstNamed(qualifiedName);
  if (existing) updateExceptionClass(existing.id, { enabled: enable });
  else if (enable) addExceptionClass(qualifiedName);
}

function intentionFor(found: ExceptionClassRef): ContributedIntention {
  const name = found.displayName;
  const existing = firstNamed(found.qualifiedName);
  const enable = !existing?.enabled;
  return {
    id: "debugger.controlExceptionBreakpoint",
    label: !existing
      ? tx`Create exception breakpoint on ${name}`
      : existing.enabled
        ? tx`Disable exception breakpoint on ${name}`
        : tx`Enable exception breakpoint on ${name}`,
    icon: "breakpoint-exception",
    run: () => controlExceptionClass(found.qualifiedName, enable),
  };
}

async function exceptionClassAt(ctx: EditorDocContext, view: EditorView, signal: AbortSignal) {
  await whenSynced(view);
  if (signal.aborted) return null;
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const request = nextRequestId();
  const abandoned = new Promise<null>((resolve) =>
    signal.addEventListener(
      "abort",
      () => {
        void commands.cancelRequest(request).catch(() => undefined);
        resolve(null);
      },
      { once: true },
    ),
  );
  const asked = call(commands.lspExceptionClassAt(request, ctx.doc, { line: line.number - 1, col: head - line.from }));
  // No Java server, an untrusted project, a cancelled request: no intention.
  return Promise.race([asked.catch(() => null), abandoned]);
}

export function exceptionBreakpointIntention(ctx: EditorDocContext): Extension {
  if (ctx.language !== "java") return [];
  return asyncIntentionProviders.of(async (view, signal) => {
    const found = await exceptionClassAt(ctx, view, signal);
    return found && !signal.aborted ? [intentionFor(found)] : [];
  });
}
