/** State `index.ts`'s registrations read before `runtime.ts` has loaded. */
import { create } from "zustand";
import type { MenuItem } from "@/ui";

export const useGithubShell = create<{ headerMenu: MenuItem[] }>(() => ({ headerMenu: [] }));
