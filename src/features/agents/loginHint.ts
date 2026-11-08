import { useTx, useTxTemplate } from "@/platform/i18n";

/** Translate the IDE's sign-in guidance while preserving the agent's own errors. */
export function useAgentErrorText(message: string): string {
  const tx = useTx();
  const translate = useTxTemplate();
  const auth = /^(.+?) needs you to sign in\. ([^\n]+)([\s\S]*)$/.exec(message);
  return auth ? `${tx`${auth[1]} needs you to sign in. ${translate(auth[2]!)}`}${auth[3]}` : message;
}
