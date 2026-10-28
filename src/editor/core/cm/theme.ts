/**
 * Editor look & feel after PyCharm's new UI (Islands): white editor island,
 * right-aligned muted line numbers (caret row darker), a hairline between the
 * gutter and the text, thin VCS bars, fold chevrons on gutter hover, caret
 * row tint across gutter and text. Colours only via tokens; editor-specific
 * ones are read through `--editor-*` locals with fallbacks to the base tokens.
 */
import { EditorView } from "@codemirror/view";
import { BRACKET_COLORS } from "./rainbowBrackets";

/** The `--editor-*` locals of `findStyles`, for the `&` rule. */
export const findLocals = {
  "--editor-search": "var(--bg-search-match, color-mix(in srgb, var(--warning) 30%, transparent))",
  "--editor-search-current": "var(--bg-search-match-current, color-mix(in srgb, var(--warning) 48%, transparent))",
};

/** Find in file highlights (cm/find.ts), also for viewers with their own theme (diff). */
export const findStyles = {
  ".cm-openidea-findMatch": {
    backgroundColor: "var(--editor-search)",
    borderRadius: "2px",
  },
  ".cm-openidea-findExcluded": {
    textDecoration: "line-through",
    textDecorationColor: "var(--fg-muted)",
  },
  ".cm-openidea-findScope": {
    backgroundColor: "var(--editor-selection-inactive, var(--bg-editor-selection-inactive))",
  },
  ".cm-openidea-findMatch-current": {
    backgroundColor: "var(--editor-search-current)",
    outline: "1px solid color-mix(in srgb, var(--editor-search-current) 60%, var(--fg-strong))",
  },
};

/** The caret and Settings › Editor › General › Appearance caret options (`caretExtension`), also for viewers. */
export const caretStyles = {
  ".cm-cursor, .cm-dropCursor": {
    borderLeft: "2px solid var(--caret, var(--fg-strong))",
    marginLeft: "-1px",
  },
  // Use block caret (Settings › Editor › General › Appearance)
  "&.cm-openidea-blockCaret .cm-cursor": {
    borderLeft: "none",
    width: "1ch",
    marginLeft: "0",
    background: "color-mix(in srgb, var(--caret, var(--fg-strong)) 55%, transparent)",
  },
  // Use smooth caret blinking: fade through CodeMirror's blink keyframes instead of stepping; rounded caret.
  "&.cm-openidea-smoothCaretBlink.cm-focused > .cm-scroller > .cm-cursorLayer": {
    animationTimingFunction: "cubic-bezier(0.7, 0, 0.3, 1)",
  },
  "&.cm-openidea-smoothCaretBlink .cm-cursor": { borderRadius: "1px" },
  "&.cm-openidea-smoothCaretBlink.cm-openidea-blockCaret .cm-cursor": { borderRadius: "2px" },
  // Use smooth caret movement: Snappy lands at once and settles, Gliding travels visibly.
  "&.cm-openidea-caretMotion-snappy": { "--openidea-caret-motion": "110ms cubic-bezier(0.16, 1, 0.3, 1)" },
  "&.cm-openidea-caretMotion-gliding": { "--openidea-caret-motion": "180ms cubic-bezier(0.45, 0, 0.25, 1)" },
  ".cm-cursorLayer.cm-openidea-caretGlide > .cm-cursor": {
    transition:
      "left var(--openidea-caret-motion), top var(--openidea-caret-motion), width var(--openidea-caret-motion), height var(--openidea-caret-motion)",
  },
  "@media (prefers-reduced-motion: reduce)": {
    ".cm-cursorLayer.cm-openidea-caretGlide > .cm-cursor": { transition: "none" },
  },
};

export const openideaTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--bg-editor, var(--bg-island, var(--bg-app)))",
    color: "var(--fg-editor, var(--fg))",
    "--editor-line-number": "var(--fg-line-number, var(--fg-gutter))",
    "--editor-line-number-current": "var(--fg-line-number-current, var(--fg-muted))",
    "--editor-gutter-border": "var(--border-gutter, var(--border))",
    "--editor-caret-row": "var(--bg-current-line)",
    "--editor-selection": "var(--bg-editor-selection, color-mix(in srgb, var(--accent) 24%, transparent))",
    "--editor-selection-inactive":
      "var(--bg-editor-selection-inactive, color-mix(in srgb, var(--accent) 14%, transparent))",
    "--editor-indent-guide": "var(--border-indent-guide, var(--border))",
    ...findLocals,
    "--editor-brace": "var(--bg-matched-brace, color-mix(in srgb, var(--accent) 22%, transparent))",
    "--editor-fold-chip": "var(--bg-fold-placeholder, color-mix(in srgb, var(--fg-muted) 14%, transparent))",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    // The workbench body uses the arrow cursor; the text area gets the I-beam (also past the last line).
    cursor: "text",
    fontFamily: "var(--openidea-editor-font, var(--font-mono))",
    fontWeight: "var(--fw-code, 400)",
    fontSize: "var(--openidea-editor-font-size, var(--fs-code))",
    lineHeight: "var(--openidea-editor-line-height, var(--lh-code))",
    fontVariantLigatures: "none",
    overscrollBehavior: "contain",
  },
  ".cm-content": {
    padding: "4px 0 8px 0",
    caretColor: "var(--caret, var(--fg-strong))",
  },
  ".cm-line": { padding: "0 16px 0 6px" },
  ...caretStyles,
  "&.cm-openidea-ligatures .cm-scroller, &.cm-openidea-ligatures .cm-openidea-sticky": {
    fontVariantLigatures: "normal",
  },
  "&.cm-openidea-methodSeparators .cm-openidea-methodSeparator": {
    boxShadow: "inset 0 1px 0 var(--border-method-separator, var(--border))",
  },
  "&.cm-openidea-hideGutter-run .cm-openidea-gutter-run, &.cm-openidea-hideGutter-bookmarks .cm-openidea-bookmarks": {
    display: "none",
  },
  // Inheritance markers share one gutter: each group hides its own icons.
  "&.cm-openidea-hideGutter-inheritors :is(.cm-openidea-lineMarker-implemented, .cm-openidea-lineMarker-overridden), &.cm-openidea-hideGutter-supers :is(.cm-openidea-lineMarker-implementing, .cm-openidea-lineMarker-overriding)":
    { display: "none" },
  // Distraction Free Mode: no gutter; the text column (n chars + line padding) is centred.
  "&.cm-openidea-distractionFree": { "--openidea-df-width": "calc(var(--openidea-df-columns, 80) * 1ch + 22px)" },
  "&.cm-openidea-distractionFree .cm-gutters": { display: "none" },
  "&.cm-openidea-distractionFree .cm-content": {
    marginInlineStart: "max(0px, calc((100% - var(--openidea-df-width)) / 2))",
  },
  "&.cm-openidea-distractionFree .cm-content.cm-lineWrapping": { maxWidth: "var(--openidea-df-width)" },
  ".cm-fat-cursor": { background: "color-mix(in srgb, var(--caret, var(--fg-strong)) 45%, transparent)" },
  ".cm-selectionBackground": { background: "var(--editor-selection-inactive)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    background: "var(--editor-selection)",
  },
  ".cm-activeLine": { backgroundColor: "var(--editor-caret-row)" },
  ".cm-selectionMatch": {
    backgroundColor: "var(--bg-identifier-under-caret, color-mix(in srgb, var(--fg) 9%, transparent))",
  },
  // IDEA's MATCHED_BRACE_ATTRIBUTES (bold in dark schemes only) and MATCHED_TAG_NAME (never bold).
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--editor-brace)",
    color: "inherit",
    fontWeight: "var(--matched-brace-weight, var(--fw-code-bold, 700))",
    borderRadius: "1px",
  },
  ".cm-matchingTag, &.cm-focused .cm-matchingTag": {
    backgroundColor: "var(--bg-matched-tag, var(--editor-brace))",
    fontWeight: "inherit",
  },
  ".cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket": {
    color: "var(--danger)",
    backgroundColor: "color-mix(in srgb, var(--danger) 14%, transparent)",
  },
  ".cm-specialChar": { color: "var(--danger)" },

  // Gutter: numbers | VCS bar | fold chevrons | hairline
  ".cm-gutters": {
    cursor: "default",
    backgroundColor: "var(--bg-editor-gutter, var(--bg-editor, var(--bg-island, var(--bg-app))))",
    color: "var(--editor-line-number)",
    border: "none",
    borderRight: "1px solid var(--editor-gutter-border)",
    WebkitUserSelect: "none",
    userSelect: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "32px",
    padding: "0 8px 0 10px",
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
  },
  ".cm-activeLineGutter": { backgroundColor: "var(--editor-caret-row)" },
  ".cm-lineNumbers .cm-activeLineGutter": { color: "var(--editor-line-number-current)" },
  ".cm-openidea-lane": { width: "4px" },
  ".cm-openidea-lane .cm-gutterElement": { padding: "0", position: "relative" },
  ".cm-openidea-laneBar": {
    position: "absolute",
    top: "0",
    bottom: "0",
    left: "0",
    width: "3px",
    borderRadius: "0 1px 1px 0",
    background: "var(--lane-color)",
  },
  ".cm-openidea-laneDeleted": {
    position: "absolute",
    left: "0",
    top: "-3px",
    width: "0",
    height: "0",
    borderTop: "3px solid transparent",
    borderBottom: "3px solid transparent",
    borderLeft: "6px solid var(--lane-color)",
    zIndex: "1",
  },
  ".cm-foldGutter": { width: "16px" },
  ".cm-foldGutter .cm-gutterElement": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--fg-fold-marker, var(--fg-gutter))",
    cursor: "pointer",
    transition: "opacity var(--dur-fast) var(--ease)",
  },
  ".cm-foldGutter .cm-openidea-foldOpen": { opacity: "0", display: "inline-flex" },
  ".cm-foldGutter .cm-openidea-foldClosed": { display: "inline-flex" },
  ".cm-gutters:hover .cm-foldGutter .cm-openidea-foldOpen": { opacity: "1" },
  ".cm-foldGutter .cm-gutterElement:hover": { color: "var(--fg-secondary)" },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--editor-fold-chip)",
    border: "none",
    color: "var(--fg-muted)",
    borderRadius: "var(--radius-small)",
    padding: "0 5px",
    margin: "0 2px",
    cursor: "pointer",
  },
  ".cm-foldPlaceholder:hover": { backgroundColor: "color-mix(in srgb, var(--fg-muted) 24%, transparent)" },

  // Indent guides (cm/indentGuides.ts)
  ".cm-openidea-guides": {
    backgroundImage:
      "repeating-linear-gradient(to right, var(--editor-indent-guide) 0 1px, transparent 1px calc(var(--openidea-guide-step) * 1ch))",
    backgroundSize: "calc(var(--openidea-guide-levels) * var(--openidea-guide-step) * 1ch) 100%",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "6px 0",
  },

  // Rainbow brackets (cm/rainbowBrackets.ts); `*` too: the syntax highlighter's span sits inside and would win.
  ...Object.fromEntries(
    Array.from({ length: BRACKET_COLORS }, (_, i) => [
      `.cm-rainbow-bracket-${i + 1}, .cm-rainbow-bracket-${i + 1} *`,
      {
        color: `var(--syn-bracket-${i + 1})`,
        fontWeight: `var(--syn-bracket-${i + 1}-bold, inherit)`,
        fontStyle: `var(--syn-bracket-${i + 1}-italic, inherit)`,
      },
    ]),
  ),
  ".cm-rainbow-bracket-unmatched, .cm-rainbow-bracket-unmatched *": { color: "var(--syn-invalid)" },

  // Whitespace rendering
  ".cm-highlightSpace": {
    backgroundImage: "radial-gradient(circle at 50% 55%, var(--fg-whitespace, var(--fg-faint)) 11%, transparent 12%)",
    backgroundPosition: "center",
  },
  ".cm-highlightTab": { backgroundImage: "none", position: "relative" },
  ".cm-highlightTab::before": {
    content: '"→"',
    position: "absolute",
    left: "0",
    color: "var(--fg-whitespace, var(--fg-faint))",
    pointerEvents: "none",
  },

  // Find in file (cm/find.ts)
  ...findStyles,

  // Overlays
  ".cm-tooltip": {
    backgroundColor: "var(--bg-popup)",
    color: "var(--fg)",
    border: "1px solid var(--border-popup)",
    borderRadius: "var(--radius-popup)",
    boxShadow: "var(--shadow-popup)",
  },
  ".cm-tooltip .cm-tooltip-arrow:before": {
    borderTopColor: "var(--border-popup)",
    borderBottomColor: "var(--border-popup)",
  },
  ".cm-tooltip .cm-tooltip-arrow:after": { borderTopColor: "var(--bg-popup)", borderBottomColor: "var(--bg-popup)" },
  ".cm-panels": { backgroundColor: "var(--bg-elev)", color: "var(--fg)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },

  // Error stripe over the scrollbar (cm/lanes.ts)
  ".cm-openidea-overview": {
    position: "absolute",
    top: "0",
    right: "0",
    bottom: "0",
    width: "12px",
    pointerEvents: "none",
    zIndex: "3",
  },
  ".cm-openidea-overviewMark": {
    position: "absolute",
    left: "3px",
    width: "6px",
    minHeight: "3px",
    borderRadius: "1px",
    pointerEvents: "auto",
    cursor: "pointer",
  },
  ".cm-openidea-overviewMark-thin": { left: "4px", width: "4px", minHeight: "2px" },
  ".cm-openidea-overviewCaret": {
    position: "absolute",
    left: "2px",
    right: "2px",
    height: "2px",
    background: "color-mix(in srgb, var(--fg) 30%, transparent)",
  },

  // Sticky lines (cm/stickyScroll.ts)
  ".cm-openidea-sticky": {
    position: "absolute",
    top: "0",
    left: "0",
    right: "12px",
    zIndex: "4",
    backgroundColor: "var(--bg-editor, var(--bg-island, var(--bg-app)))",
    borderBottom: "1px solid var(--editor-gutter-border)",
    boxShadow: "0 3px 6px -2px color-mix(in srgb, var(--fg-strong) 12%, transparent)",
    fontFamily: "var(--openidea-editor-font, var(--font-mono))",
    fontWeight: "var(--fw-code, 400)",
    fontSize: "var(--openidea-editor-font-size, var(--fs-code))",
    lineHeight: "var(--openidea-editor-line-height, var(--lh-code))",
    overflow: "hidden",
    cursor: "pointer",
  },
  ".cm-openidea-stickyLine": { display: "flex", whiteSpace: "pre" },
  ".cm-openidea-stickyLine:hover": { backgroundColor: "var(--editor-caret-row)" },
  ".cm-openidea-stickyNumber": {
    flex: "none",
    textAlign: "right",
    color: "var(--editor-line-number)",
    boxSizing: "border-box",
    paddingRight: "8px",
  },
  ".cm-openidea-stickyText": { flex: "1", overflow: "hidden" },

  // Soft-wrap: continuation rows indent slightly, like IDEA's wrap sign column.
  "&.cm-lineWrapping .cm-line, .cm-lineWrapping .cm-line": { paddingRight: "24px" },
});
