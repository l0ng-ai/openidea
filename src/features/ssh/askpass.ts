/**
 * Credential prompts of `ssh` / `git` child processes (backend askpass), shown
 * one at a time; prompts arriving meanwhile wait in order.
 */
import { create } from "zustand";
import { commands, type AskpassKind } from "@/platform/ipc";

export interface AskpassPrompt {
  id: number;
  prompt: string;
  kind: AskpassKind;
  /** The dialog offers "Remember" (git HTTPS passwords). */
  remember: boolean;
}

export const useAskpass = create<{ queue: AskpassPrompt[] }>(() => ({ queue: [] }));

export function enqueueAskpass(p: AskpassPrompt) {
  useAskpass.setState((s) => (s.queue.some((q) => q.id === p.id) ? s : { queue: [...s.queue, p] }));
}

/** Drops prompt `id` (answered in another window, or the process gave up). */
export function dropAskpass(id: number) {
  useAskpass.setState((s) => (s.queue.some((q) => q.id === id) ? { queue: s.queue.filter((q) => q.id !== id) } : s));
}

/** The answer sent back: the typed text, `yes` / `no` for a confirmation, null when cancelled. */
export function askpassAnswer(
  kind: AskpassKind,
  choice: { text: string } | { confirm: boolean } | null,
): string | null {
  if (choice === null) return null;
  if ("confirm" in choice) return kind === "confirm" ? (choice.confirm ? "yes" : "no") : null;
  return kind === "confirm" ? null : choice.text;
}

export function answerAskpass(
  p: AskpassPrompt,
  answer: string | null,
  remember: boolean,
  send = commands.sshAskpassAnswer,
) {
  dropAskpass(p.id);
  // The backend ties `remember` to this prompt; the git command saves it only
  // on success and drops it again when authentication fails.
  void send(p.id, answer, remember).catch(() => {});
}
