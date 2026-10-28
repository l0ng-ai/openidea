/** Editor-side styling for LSP features (CodeMirror theme; tokens only). */
import { EditorView } from "@codemirror/view";
import { RAINBOW_COLORS } from "./semantic";

const tooltipSurface = {
  backgroundColor: "var(--bg-popup)",
  border: "1px solid var(--border-popup)",
  borderRadius: "var(--radius-popup)",
  boxShadow: "var(--shadow-popup)",
  color: "var(--fg)",
};

const markdown = {
  ".cm-lsp-markdown": {
    fontFamily: "var(--font-ui)",
    fontSize: "var(--fs-ui)",
    lineHeight: "1.55",
    color: "var(--fg-strong)",
    overflowWrap: "anywhere",
    whiteSpace: "normal",
  },
  ".cm-lsp-markdown > :first-child": { marginTop: "0" },
  ".cm-lsp-markdown > :last-child": { marginBottom: "0" },
  ".cm-lsp-markdown p, .cm-lsp-markdown ul, .cm-lsp-markdown ol": { margin: "6px 0" },
  ".cm-lsp-markdown ul, .cm-lsp-markdown ol": { paddingLeft: "18px" },
  ".cm-lsp-markdown h1, .cm-lsp-markdown h2, .cm-lsp-markdown h3, .cm-lsp-markdown h4": {
    fontSize: "var(--fs-ui)",
    fontWeight: "600",
    color: "var(--fg-strong)",
    margin: "8px 0 4px",
  },
  ".cm-lsp-markdown hr": { border: "none", borderTop: "1px solid var(--border-popup)", margin: "10px -14px" },
  ".cm-lsp-markdown a": { color: "var(--link)", textDecoration: "none", cursor: "pointer" },
  ".cm-lsp-markdown a:hover": { color: "var(--link-hover)", textDecoration: "underline" },
  ".cm-lsp-markdown code": {
    fontFamily: "var(--openidea-editor-font, var(--font-mono))",
    fontWeight: "var(--fw-code, 400)",
    fontSize: "var(--fs-small)",
    color: "var(--fg-emphasis)",
  },
  ".cm-lsp-markdown pre, .cm-lsp-code": {
    fontFamily: "var(--openidea-editor-font, var(--font-mono))",
    fontWeight: "var(--fw-code, 400)",
    fontSize: "var(--fs-ui)",
    lineHeight: "1.5",
    margin: "6px 0",
    whiteSpace: "pre-wrap",
    color: "var(--fg-emphasis)",
  },
  ".cm-lsp-markdown pre": {
    backgroundColor: "var(--bg-popup-inline, var(--bg-elev))",
    borderRadius: "var(--radius-small)",
    padding: "6px 8px",
  },
  ".cm-lsp-markdown pre code": { fontSize: "inherit" },
  ".cm-lsp-plain": { whiteSpace: "pre-wrap" },
  ".cm-lsp-markdown table": { borderCollapse: "collapse" },
  ".cm-lsp-markdown td, .cm-lsp-markdown th": { border: "1px solid var(--border-strong)", padding: "2px 6px" },
  // Lezer classHighlighter tokens inside documentation code.
  ".tok-keyword, .tok-modifier, .tok-controlKeyword, .tok-operatorKeyword": { color: "var(--syn-keyword)" },
  ".tok-string, .tok-string2": { color: "var(--syn-string)" },
  ".tok-number, .tok-bool, .tok-atom": { color: "var(--syn-number)" },
  ".tok-typeName, .tok-className, .tok-namespace": { color: "var(--syn-type)" },
  ".tok-comment": { color: "var(--syn-comment)", fontStyle: "italic" },
  ".tok-meta, .tok-macroName": { color: "var(--syn-annotation)" },
  ".tok-propertyName": { color: "var(--syn-property)" },
  ".tok-variableName.tok-definition": { color: "var(--syn-function)" },
  ".tok-punctuation, .tok-operator": { color: "var(--syn-punct)" },
  ".tok-invalid": { color: "var(--syn-invalid)" },
};

export const lspTheme = EditorView.theme({
  // --- completion (IDEA lookup: icon column, bold blue match, grey tail/type, advertiser) ---
  ".cm-tooltip.cm-tooltip-autocomplete.cm-lsp-completion": {
    ...tooltipSurface,
    fontFamily: "var(--openidea-editor-font, var(--font-mono))",
    fontWeight: "var(--fw-code, 400)",
    fontSize: "var(--fs-code)",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete.cm-lsp-completion > ul": {
    fontFamily: "var(--openidea-editor-font, var(--font-mono))",
    fontWeight: "var(--fw-code, 400)",
    minWidth: "420px",
    maxWidth: "min(720px, 80vw)",
    maxHeight: "calc(var(--h-list-row) * 11 + 8px)",
    padding: "4px 0",
  },
  ".cm-tooltip.cm-tooltip-autocomplete.cm-lsp-completion > ul > li": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    height: "var(--h-list-row)",
    lineHeight: "var(--h-list-row)",
    margin: "0 4px",
    padding: "0 8px 0 6px",
    borderRadius: "var(--radius-small)",
    color: "var(--fg-editor, var(--fg-strong))",
    whiteSpace: "nowrap",
  },
  ".cm-tooltip.cm-tooltip-autocomplete.cm-lsp-completion > ul > li[aria-selected]": {
    backgroundColor: "var(--bg-list-selected, var(--bg-tree-selected, var(--bg-selected-strong)))",
    color: "var(--fg-editor, var(--fg-strong))",
  },
  ".cm-tooltip.cm-tooltip-autocomplete.cm-lsp-completion > ul > completion-section": {
    color: "var(--fg-subtle)",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--fs-small)",
    padding: "4px 12px 2px",
    borderBottom: "none",
  },
  ".cm-lsp-completion .cm-lsp-kind": {
    flex: "none",
    width: "16px",
    height: "16px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  },
  ".cm-lsp-completion .cm-completionLabel": { flex: "none", overflow: "hidden", textOverflow: "ellipsis" },
  ".cm-lsp-completion .cm-completionDetail": {
    flex: "0 1 auto",
    marginLeft: "0",
    fontStyle: "normal",
    color: "var(--fg-subtle)",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  ".cm-lsp-completion .cm-completionMatchedText": {
    textDecoration: "none",
    fontWeight: "var(--fw-code-bold, 700)",
    color: "var(--fg-completion-match, var(--link))",
  },
  // A server's label detail (`(a: string)`) hugs the name; template descriptions keep the gap.
  ".cm-lsp-completion .cm-lsp-option .cm-completionDetail": { marginLeft: "-6px" },
  ".cm-lsp-completion .cm-lsp-type": {
    flex: "1 0 auto",
    maxWidth: "60%",
    marginLeft: "auto",
    paddingLeft: "16px",
    textAlign: "right",
    color: "var(--fg-subtle)",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  ".cm-lsp-completion .cm-lsp-keyword-option .cm-completionLabel": { fontWeight: "var(--fw-code-bold, 700)" },
  ".cm-lsp-completion .cm-lsp-deprecated-option .cm-completionLabel": {
    textDecoration: "line-through",
    color: "var(--fg-muted)",
  },
  ".cm-lsp-completion-footer": {
    display: "flex",
    alignItems: "center",
    padding: "5px 12px",
    backgroundColor: "var(--bg-popup-inline, var(--bg-elev))",
    color: "var(--fg-subtle)",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--fs-small)",
    whiteSpace: "nowrap",
    gap: "12px",
    justifyContent: "space-between",
  },
  ".cm-lsp-completion-sort": {
    padding: "0",
    border: "none",
    background: "none",
    color: "var(--fg-subtle)",
    font: "inherit",
    cursor: "pointer",
  },
  ".cm-lsp-completion-sort:hover": { color: "var(--fg)" },
  '.cm-lsp-completion-sort[aria-pressed="true"]': { color: "var(--link)" },
  ".cm-tooltip.cm-completionInfo": {
    ...tooltipSurface,
    padding: "8px 12px",
    maxWidth: "440px",
    maxHeight: "320px",
    overflow: "auto",
  },
  ".cm-lsp-completion-doc": { whiteSpace: "normal" },
  ".cm-lsp-doc-signature": { marginTop: "0", color: "var(--fg-emphasis)" },

  // --- hover / quick documentation / signature / hints ---------------------
  ".cm-tooltip.cm-tooltip-hover": { ...tooltipSurface },
  ".cm-lsp-hover": { maxWidth: "580px", maxHeight: "380px", overflow: "auto", padding: "10px 14px" },
  ".cm-lsp-hover-diagnostics + .cm-lsp-markdown": {
    borderTop: "1px solid var(--border-popup)",
    margin: "10px -14px 0",
    padding: "10px 14px 0",
  },
  ".cm-lsp-diag": {
    display: "flex",
    flexDirection: "column",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--fs-ui)",
    paddingLeft: "22px",
    position: "relative",
  },
  ".cm-lsp-diag-icon": { position: "absolute", left: "0", top: "1px", display: "inline-flex" },
  ".cm-lsp-diag + .cm-lsp-diag": { marginTop: "8px" },
  ".cm-lsp-diag-error .cm-lsp-diag-icon": { color: "var(--danger)" },
  ".cm-lsp-diag-warning .cm-lsp-diag-icon": { color: "var(--warning)" },
  ".cm-lsp-diag-info .cm-lsp-diag-icon, .cm-lsp-diag-hint .cm-lsp-diag-icon": { color: "var(--info)" },
  ".cm-lsp-diag-message": { color: "var(--fg-strong)", whiteSpace: "pre-wrap", lineHeight: "18px" },
  ".cm-lsp-diag-meta": {
    display: "flex",
    flexWrap: "wrap",
    columnGap: "12px",
    rowGap: "2px",
    marginTop: "6px",
    alignItems: "baseline",
  },
  ".cm-lsp-diag-meta > *": { whiteSpace: "nowrap" },
  ".cm-lsp-diag-source": { color: "var(--fg-subtle)", fontSize: "var(--fs-small)" },
  ".cm-lsp-link-button": {
    border: "none",
    background: "none",
    padding: "0",
    font: "inherit",
    fontSize: "var(--fs-ui)",
    color: "var(--link)",
    cursor: "pointer",
  },
  ".cm-lsp-link-button:hover": { color: "var(--link-hover)", textDecoration: "underline" },
  ".cm-lsp-signature": {
    fontFamily: "var(--openidea-editor-font, var(--font-mono))",
    fontWeight: "var(--fw-code, 400)",
    fontSize: "var(--fs-code)",
    padding: "6px 10px",
    maxWidth: "640px",
  },
  ".cm-lsp-signature-row": { color: "var(--fg-subtle)", whiteSpace: "pre-wrap", lineHeight: "20px" },
  ".cm-lsp-signature-active": {
    color: "var(--fg-strong)",
    backgroundColor: "var(--bg-identifier-under-caret, color-mix(in srgb, var(--accent) 14%, transparent))",
    margin: "0 -10px",
    padding: "0 10px",
  },
  ".cm-lsp-signature-disabled": { opacity: "0.55" },
  ".cm-lsp-signature b": { fontWeight: "var(--fw-code-bold, 700)", color: "var(--fg-strong)" },
  ".cm-lsp-signature-doc": {
    borderTop: "1px solid var(--border-popup)",
    marginTop: "6px",
    paddingTop: "6px",
    maxHeight: "160px",
    overflow: "auto",
  },
  ".cm-tooltip:has(> .cm-lsp-hint)": { background: "none", border: "none", boxShadow: "none" },
  ".cm-lsp-hint": {
    backgroundColor: "var(--bg-popup)",
    color: "var(--fg-strong)",
    border: "1px solid var(--border-popup)",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--fs-ui)",
    padding: "6px 10px",
    borderRadius: "var(--radius-popup)",
    boxShadow: "var(--shadow-popup)",
    maxWidth: "480px",
    whiteSpace: "pre-wrap",
  },
  ".cm-lsp-hint-error": {
    backgroundColor: "var(--bg-feedback-error, color-mix(in srgb, var(--danger) 8%, var(--bg-popup)))",
    borderColor: "color-mix(in srgb, var(--danger) 35%, var(--border-popup))",
  },
  ".cm-lsp-hint-warning": {
    backgroundColor: "var(--bg-feedback-warning, color-mix(in srgb, var(--warning) 9%, var(--bg-popup)))",
    borderColor: "color-mix(in srgb, var(--warning) 35%, var(--border-popup))",
  },

  // --- navigation ---------------------------------------------------------
  ".cm-lsp-link": {
    color: "var(--link)",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
    cursor: "pointer",
  },
  ".cm-lsp-occurrence": {
    backgroundColor: "var(--bg-identifier-under-caret, color-mix(in srgb, var(--accent) 14%, transparent))",
  },
  ".cm-lsp-occurrence-write": {
    backgroundColor: "var(--bg-identifier-under-caret-write, color-mix(in srgb, var(--danger) 12%, transparent))",
  },
  ".cm-lsp-nav-info": { padding: "4px 8px" },
  // Chooser highlight (tempHighlight.ts): the expression / occurrences a choice would take.
  ".cm-lsp-chooser-highlight": { backgroundColor: "var(--bg-text-search-result)" },

  // --- in-place rename (inplaceRename.ts) ------------------------------------
  ".cm-lsp-inplace": {
    backgroundColor: "var(--bg-identifier-under-caret, color-mix(in srgb, var(--accent) 14%, transparent))",
  },
  ".cm-lsp-inplace-primary": {
    outline: "1px solid var(--focus-ring)",
    outlineOffset: "-1px",
    borderRadius: "2px",
  },
  ".cm-lsp-inplace-hint": { color: "var(--fg-secondary)", fontSize: "var(--fs-small)", padding: "3px 8px" },
  ".cm-lsp-inplace-suggestions": {
    listStyle: "none",
    margin: "0 -8px 4px",
    padding: "0",
    fontFamily: "var(--openidea-editor-font, var(--font-mono))",
    fontWeight: "var(--fw-code, 400)",
    fontSize: "var(--fs-ui)",
    color: "var(--fg)",
  },
  ".cm-lsp-inplace-suggestions li": { padding: "1px 8px", cursor: "pointer" },
  ".cm-lsp-inplace-suggestions li:hover": { backgroundColor: "var(--bg-hover)" },
  ".cm-lsp-inplace-suggestion-active": { backgroundColor: "var(--bg-selected)" },

  // --- floating lightbulb (intentions.ts) -----------------------------------
  ".cm-lsp-bulb": {
    position: "absolute",
    zIndex: "2",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "18px",
    color: "var(--fg-bulb, var(--warning))",
    cursor: "pointer",
  },
  // Above the sticky gutters (z-index 200).
  ".cm-lsp-bulb-gutter": { zIndex: "201", backgroundColor: "var(--bg-editor-gutter, var(--bg-editor))" },
  ".cm-lsp-bulb .cm-openidea-icon": { display: "inline-flex", borderRadius: "var(--radius-small)", padding: "1px" },
  ".cm-lsp-bulb:hover .cm-openidea-icon": { backgroundColor: "var(--bg-toolbar-hover)" },
  ".cm-lsp-bulb .cm-lsp-bulb-fix-icon, .cm-lsp-bulb-fix .cm-openidea-icon:first-child": { display: "none" },
  ".cm-lsp-bulb-fix .cm-lsp-bulb-fix-icon": { display: "inline-flex" },

  // --- inlay hints (rounded grey chips) -------------------------------------
  ".cm-lsp-inlay": {
    color: "var(--fg-inlay, var(--syn-inline-value))",
    backgroundColor: "var(--bg-inlay, color-mix(in srgb, var(--fg-subtle) 12%, transparent))",
    borderRadius: "var(--radius-small)",
    padding: "0 4px",
    fontSize: "0.9em",
    fontFamily: "var(--font-ui)",
    verticalAlign: "1px",
    WebkitUserSelect: "none",
    userSelect: "none",
  },
  // A part naming a declaration (⌘-click navigates there).
  ".cm-lsp-navigation-modifier .cm-lsp-inlay-part:hover": {
    textDecoration: "underline",
    textUnderlineOffset: "2px",
    cursor: "pointer",
  },
  // Inline completion: the suggestion as gray text at the caret.
  ".cm-inline-ghost": { color: "var(--fg-subtle)", whiteSpace: "pre" },
  ".cm-lsp-inlay-pl": { marginLeft: "4px" },
  ".cm-lsp-inlay-pr": { marginRight: "4px" },

  // --- semantic tokens -----------------------------------------------------
  ".cm-sem-type, .cm-sem-typeParameter": { color: "var(--syn-type)" },
  // IDEA colours declarations, calls stay (nearly) plain text.
  ".cm-sem-function": { color: "var(--syn-function-call, var(--syn-function))" },
  ".cm-sem-function.cm-sem-declaration": { color: "var(--syn-function)" },
  ".cm-sem-function.cm-sem-builtin": { color: "var(--syn-builtin, var(--syn-function))" },
  ".cm-sem-macro": { color: "var(--syn-annotation)" },
  ".cm-sem-annotation": { color: "var(--syn-decorator, var(--syn-annotation))" },
  ".cm-sem-constant": { color: "var(--syn-constant)" },
  ".cm-sem-property": { color: "var(--syn-property)" },
  ".cm-sem-parameter": { color: "var(--syn-param, var(--syn-variable))" },
  ".cm-sem-self": { color: "var(--syn-self, var(--syn-keyword))" },
  ".cm-sem-keyword": { color: "var(--syn-keyword)", fontWeight: "var(--syn-keyword-bold, inherit)" },
  ".cm-sem-builtin:not(.cm-sem-function)": { color: "var(--syn-builtin, inherit)" },
  ".cm-sem-static": { fontStyle: "var(--syn-static-italic, italic)" },
  ".cm-sem-python-static": { fontStyle: "var(--syn-python-static-italic, normal)" },
  ".cm-sem-mutable": {
    textDecoration: "underline",
    textDecorationColor: "var(--fg-faint)",
    textUnderlineOffset: "3px",
  },
  ".cm-sem-deprecated": { textDecoration: "line-through" },
  // Semantic highlighting: after the base classes so a parameter's colour gives way, and over the
  // syntax highlighter's span inside.
  ...Object.fromEntries(
    Array.from({ length: RAINBOW_COLORS }, (_, i) => [
      `.cm-sem-rainbow-${i + 1}, .cm-sem-rainbow-${i + 1} *`,
      {
        color: `var(--syn-rainbow-${i + 1})`,
        fontWeight: `var(--syn-rainbow-${i + 1}-bold, inherit)`,
        fontStyle: `var(--syn-rainbow-${i + 1}-italic, inherit)`,
      },
    ]),
  ),
  // After the semantic classes: the link wraps their (innermost) spans, and its colour must win.
  ".cm-lsp-link *": { color: "var(--link)" },

  ...markdown,
});
