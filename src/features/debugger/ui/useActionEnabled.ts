import { getAction, isActionEnabled } from "@/platform/actions";
import { useContextKeys } from "@/platform/context";

/** Whether action `id` would run now with `arg`; a button bound to it shows disabled otherwise. */
export function useActionEnabled(id: string, arg?: unknown): boolean {
  const ctx = useContextKeys();
  const a = getAction(id);
  return !!a && isActionEnabled(a, ctx, arg);
}
