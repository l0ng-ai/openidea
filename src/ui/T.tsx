import { useGivenTx, useTx } from "@/platform/i18n";

/** English UI text, translated through the source-text catalog; re-renders on locale change. */
export function T({ children }: { children: string }) {
  return useTx()(children);
}

/** Text a component was given: translated like `T`, shown as written below plugin UI. */
export function Given({ children }: { children: string }) {
  return useGivenTx()(children);
}
