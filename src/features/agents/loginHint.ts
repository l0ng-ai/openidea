import { useTx, useTxTemplate } from "@/platform/i18n";

const SIGN_IN_RE = /^(.+?) needs you to sign in\. ([^\n]+)([\s\S]*)$/;

export const isSignInErrorMessage = (message: string): boolean => SIGN_IN_RE.test(message);

/** Translate the IDE's sign-in guidance while preserving the agent's own errors. */
export function useAgentErrorText(message: string): string {
  const tx = useTx();
  const translate = useTxTemplate();
  const auth = SIGN_IN_RE.exec(message);
  return auth ? `${tx`${auth[1]} needs you to sign in. ${translate(auth[2]!)}`}${auth[3]}` : message;
}
