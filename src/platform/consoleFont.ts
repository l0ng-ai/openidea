import { useProject } from "./project";
import { resolveMonoFont } from "./fonts";
import { useWorkflowSettings } from "./workflowSettings";

/**
 * The font of the Run and Debug consoles: Tools › Terminal › Font (which can follow
 * Editor › Font), with the row height both consoles lay their lines out with.
 */
export function useConsoleFont(): { family: string; size: number; rowHeight: number } {
  const terminalFont = useWorkflowSettings((s) => s.terminal);
  const editorFont = useProject((s) => s.settings?.editor);
  const { family, size } = resolveMonoFont(terminalFont, editorFont);
  return { family, size, rowHeight: Math.max(16, Math.round(size * 1.5)) };
}
