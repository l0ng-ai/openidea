import { useProject } from "./project";
import { resolveMonoFont, type EditorFontChoice, type MonoFontChoice } from "./fonts";
import { useWorkflowSettings } from "./workflowSettings";
import { fontWeightOf } from "./editorSettings";

export interface ConsoleFont {
  family: string;
  size: number;
  rowHeight: number;
  weight: number;
  boldWeight: number;
}

/**
 * The font of the Run and Debug consoles: Tools › Terminal › Font (which can follow
 * Editor › Font), with the row height both consoles lay their lines out with. The
 * weights match the terminal's: the editor's main and bold weights when the terminal
 * uses the editor font, else regular and bold.
 */
export function consoleFontOf(
  terminal: MonoFontChoice | undefined,
  editor: (EditorFontChoice & { fontWeight?: number | null; boldFontWeight?: number | null }) | undefined,
): ConsoleFont {
  const { family, size } = resolveMonoFont(terminal, editor);
  const useEditor = !!terminal?.useEditorFont;
  return {
    family,
    size,
    rowHeight: Math.max(16, Math.round(size * 1.5)),
    weight: useEditor ? fontWeightOf(editor?.fontWeight, 400) : 400,
    boldWeight: useEditor ? fontWeightOf(editor?.boldFontWeight, 700) : 700,
  };
}

export function useConsoleFont(): ConsoleFont {
  const terminalFont = useWorkflowSettings((s) => s.terminal);
  const editorFont = useProject((s) => s.settings?.editor);
  return consoleFontOf(terminalFont, editorFont);
}
