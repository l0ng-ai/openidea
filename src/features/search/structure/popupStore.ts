import { create } from "zustand";

/** Whether the File Structure popup is open. */
export const useFileStructurePopup = create<{ open: boolean }>(() => ({ open: false }));
