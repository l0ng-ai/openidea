import { useSyncExternalStore } from "react";

function subscribe(changed: () => void): () => void {
  const observer = new MutationObserver(changed);
  observer.observe(document.head, { subtree: true, childList: true, characterData: true });
  return () => observer.disconnect();
}

/** The window title as `features/app/title.ts` writes it to `document.title`. */
export function useDocumentTitle(): string {
  return useSyncExternalStore(subscribe, () => document.title);
}
