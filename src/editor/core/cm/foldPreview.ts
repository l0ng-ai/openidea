import { foldedRanges } from "@codemirror/language";
import { closeHoverTooltip, Direction, EditorView, hoverTooltip, repositionTooltips } from "@codemirror/view";
import { tx } from "@/platform/i18n";
import { navigationModifierHeld, pointerTarget } from "@/platform/navigationModifier";
import { editorLineNumber } from "./relativeLineNumbers";
import { renderLineContent } from "./renderLineContent";
import styles from "./FoldPreview.module.css";

const MAX_LINES = 80;

function previewContent(view: EditorView, from: number, to: number) {
  const { state } = view;
  const { doc } = state;
  const header = doc.lineAt(from);
  const end = doc.lineAt(to).number;
  const start = Math.min(from === header.to ? header.number + 1 : header.number, end);
  const last = Math.min(end, start + MAX_LINES - 1);
  const numbers = view.dom.querySelector(".cm-lineNumbers")?.getClientRects().length;
  const dom = document.createElement("div");
  dom.className = styles.preview!;
  if (numbers) dom.classList.add(styles.numbered!);
  dom.setAttribute("role", "tooltip");
  dom.setAttribute("aria-label", tx("Folded code"));

  const font = getComputedStyle(view.contentDOM);
  dom.style.fontFamily = font.fontFamily;
  dom.style.fontSize = font.fontSize;
  dom.style.lineHeight = font.lineHeight;
  dom.style.tabSize = font.tabSize;
  dom.style.fontVariantLigatures = font.fontVariantLigatures;
  dom.style.setProperty("--fold-preview-line-height", font.lineHeight);

  for (let line = start; line <= last; line++) {
    if (numbers) {
      const number = document.createElement("span");
      number.className = styles.number!;
      number.textContent = editorLineNumber(state, line);
      number.setAttribute("aria-hidden", "true");
      dom.append(number);
    }
    const code = document.createElement("code");
    renderLineContent(state, line, code);
    dom.append(code);
  }
  if (last < end) {
    const overflow = document.createElement("span");
    overflow.className = styles.more!;
    overflow.textContent = "…";
    dom.append(overflow);
  }
  return dom;
}

const preview = hoverTooltip(
  (view, pos) => {
    if (navigationModifierHeld()) return null;
    const chip = pointerTarget()?.closest(".cm-foldPlaceholder");
    if (!chip || !view.contentDOM.contains(chip) || view.posAtDOM(chip) !== pos) return null;
    let end = pos;
    foldedRanges(view.state).between(pos, pos, (from, to) => {
      if (from === pos) end = Math.max(end, to);
    });
    if (end === pos) return null;
    return {
      pos,
      end,
      create() {
        const dom = previewContent(view, pos, end);
        const offset = { x: 0, y: 2 };
        const window = view.dom.ownerDocument.defaultView;
        const onKeyDown = (event: KeyboardEvent) => {
          if (event.key === "Escape") view.dispatch({ effects: closeHoverTooltip(preview) });
        };
        const fit = ({ left, right }: { left: number; right: number }) => {
          const width = `${Math.max(0, Math.floor(right - left) - 2)}px`;
          if (dom.style.getPropertyValue("--fold-preview-width") === width) return;
          dom.style.setProperty("--fold-preview-width", width);
          repositionTooltips(view);
        };
        return {
          dom,
          offset,
          getCoords: () => {
            const bounds = chip.getBoundingClientRect();
            const { left, right } = view.scrollDOM.getBoundingClientRect();
            // Use the chip for visibility and the pane edge for horizontal alignment.
            offset.x = view.textDirection === Direction.LTR ? left - bounds.left : bounds.left - right;
            return bounds;
          },
          mount() {
            fit(view.dom.getBoundingClientRect());
            window?.addEventListener("keydown", onKeyDown, true);
          },
          positioned: fit,
          destroy: () => window?.removeEventListener("keydown", onKeyDown, true),
        };
      },
    };
  },
  {
    hoverTime: 300,
    hideOnChange: true,
    hideOn: (tr) => foldedRanges(tr.startState) !== foldedRanges(tr.state),
  },
);

export const foldPreviewExtension = [
  preview,
  EditorView.domEventObservers({
    scroll(event, view) {
      if (event.target === view.scrollDOM && view.state.field(preview.active).length) {
        view.dispatch({ effects: closeHoverTooltip(preview) });
      }
    },
  }),
];
