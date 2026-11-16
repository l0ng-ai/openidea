/**
 * JetBrains option names (as the IDE writes them to `options/editor.xml` and
 * `codestyles/*.xml`) and the OpenIDEA settings of the same meaning. Each entry
 * carries the label the option has in Settings, for the import confirmation.
 */

type Mapped = readonly [key: string, label: string];

/** `<component name="EditorSettings">`: on/off options. */
export const EDITOR_FLAGS: Record<string, Mapped> = {
  IS_WHEEL_FONTCHANGE_ENABLED: ["editor.general.wheelZoom", "Change font size with Ctrl/Command+Mouse Wheel"],
  IS_DND_ENABLED: ["editor.general.dragAndDrop", "Enable drag-and-drop functionality in editor"],
  USE_CUSTOM_SOFT_WRAP_INDENT: ["editor.general.softWrapIndent", "Use original line's indent for wrapped parts"],
  ADDITIONAL_PAGE_AT_BOTTOM: ["editor.general.scrollPastEnd", "Show virtual space at file bottom"],
  KEEP_TRAILING_SPACE_ON_CARET_LINE: ["editor.general.keepTrailingOnCaretLine", "Keep trailing spaces on caret line"],
  REMOVE_TRAILING_BLANK_LINES: [
    "editor.general.removeTrailingBlankLines",
    "Remove trailing blank lines at the end of saved files",
  ],
  IS_CARET_BLINKING: ["editor.appearance.caretBlinking", "Caret blinking (ms):"],
  IS_SMOOTH_CARET_BLINKING: ["editor.appearance.smoothCaretBlinking", "Use smooth caret blinking"],
  IS_BLOCK_CURSOR: ["editor.appearance.blockCaret", "Use block caret"],
  IS_SMOOTH_CARET_MOVEMENT: ["editor.appearance.smoothCaretMovement", "Use smooth caret movement"],
  IS_RIGHT_MARGIN_SHOWN: [
    "editor.appearance.hardWrapGuides",
    "Show hard wrap and visual guides (configured in Code Style options)",
  ],
  ARE_LINE_NUMBERS_SHOWN: ["editor.appearance.lineNumbers", "Show line numbers"],
  IS_LEADING_WHITESPACES_SHOWN: ["editor.appearance.whitespaceLeading", "Leading"],
  IS_INNER_WHITESPACES_SHOWN: ["editor.appearance.whitespaceInner", "Inner"],
  IS_TRAILING_WHITESPACES_SHOWN: ["editor.appearance.whitespaceTrailing", "Trailing"],
  IS_INDENT_GUIDES_SHOWN: ["editor.appearance.indentGuides", "Show indent guides"],
  SHOW_INTENTION_BULB: ["editor.appearance.intentionBulb", "Show intention bulb"],
  ENABLE_RENDERED_DOC: ["editor.appearance.renderDocComments", "Render documentation comments"],
  SHOW_BREADCRUMBS: ["editor.breadcrumbs.show", "Show breadcrumbs:"],
  IS_FOLDING_OUTLINE_SHOWN: ["editor.folding.showOutline", "Show code folding outline"],
  SMART_HOME: ["editor.smartKeys.smartHome", "Home moves caret to first non-whitespace character"],
  IS_CAMEL_WORDS: ["editor.smartKeys.camelHumps", 'Use "CamelHumps" words'],
  IS_HIGHLIGHT_SELECTION_OCCURRENCES: ["editor.codeEditing.highlightSelection", "Occurrences of selected text"],
  SHOW_QUICK_DOC_ON_MOUSE_OVER_ELEMENT: ["editor.codeEditing.quickDocOnHover", "Show quick documentation on hover"],
  INSERT_PARENTHESES_AUTOMATICALLY: [
    "editor.completion.insertParentheses",
    "Insert parentheses automatically when applicable",
  ],
};

/** `<component name="EditorSettings">`: numbers. */
export const EDITOR_NUMBERS: Record<string, Mapped> = {
  CARET_BLINKING_PERIOD: ["editor.appearance.caretBlinkPeriod", "Caret blinking (ms):"],
  STICKY_LINES_LIMIT: ["editor.codeEditing.stickyLinesMax", "Maximum number of lines"],
  TOOLTIPS_DELAY_MS: ["editor.codeEditing.quickDocDelay", "Tooltip delay"],
};

/** `<component name="CodeInsightSettings">`: on/off options. */
export const CODE_INSIGHT_FLAGS: Record<string, Mapped> = {
  AUTOINSERT_PAIR_BRACKET: ["editor.smartKeys.pairBrackets", "Insert paired brackets (), [], {}"],
  AUTOINSERT_PAIR_QUOTE: ["editor.smartKeys.pairQuotes", "Insert pair quote"],
  SURROUND_SELECTION_ON_QUOTE_TYPED: [
    "editor.smartKeys.surroundSelection",
    "Surround selection on typing quote or brace",
  ],
  TAB_EXITS_BRACKETS_AND_QUOTES: ["editor.smartKeys.tabOutOfPair", "Jump outside closing bracket/quote with Tab"],
  SMART_INDENT_ON_ENTER: ["editor.smartKeys.smartIndent", "Smart indent"],
  JAVADOC_STUB_ON_ENTER: ["editor.smartKeys.insertDocStub", "Insert documentation comment stub"],
  HIGHLIGHT_IDENTIFIER_UNDER_CARET: ["editor.codeEditing.highlightUsages", "Usages of element at caret"],
  HIGHLIGHT_BRACES: ["editor.codeEditing.highlightBraces", "Matched brace"],
  AUTO_POPUP_COMPLETION_LOOKUP: ["editor.completion.autoPopup", "Show suggestions as you type"],
  AUTOCOMPLETE_ON_CODE_COMPLETION: ["editor.completion.autoInsertSingle", "Automatically insert single suggestions"],
  AUTO_POPUP_JAVADOC_INFO: ["editor.completion.showDocumentation", "Show the documentation popup in"],
  AUTO_POPUP_PARAMETER_INFO: ["editor.completion.parameterInfo", "Show the parameter info popup in"],
};

/** `<component name="CodeInsightSettings">`: numbers. */
export const CODE_INSIGHT_NUMBERS: Record<string, Mapped> = {
  JAVADOC_INFO_DELAY: ["editor.completion.documentationDelay", "Show the documentation popup in"],
  PARAMETER_INFO_DELAY: ["editor.completion.parameterInfoDelay", "Show the parameter info popup in"],
};

/** `REFORMAT_ON_PASTE` (IDEA's `CodeInsightSettings` constants) → `editor.smartKeys.reformatOnPaste`, its label. */
export const REFORMAT_ON_PASTE: Record<string, Mapped> = {
  "1": ["none", "None"],
  "2": ["indentBlock", "Indent Block"],
  "3": ["indentEachLine", "Indent Each Line"],
};

/** `SMART_BACKSPACE` (IDEA's `SmartBackspaceMode` ordinals) → `editor.smartKeys.backspaceUnindent`, its label. */
export const SMART_BACKSPACE: Record<string, Mapped> = {
  "0": ["none", "Disabled"],
  "1": ["nearest", "To nearest indent position"],
  "2": ["autoindent", "To proper indent position"],
};

/** `<codeStyleSettings language=…>` → the language ids that share that code style here. */
export const CODE_STYLE_LANGUAGES: Record<string, readonly string[]> = {
  JAVA: ["java"],
  kotlin: ["kotlin"],
  Groovy: ["groovy"],
  Scala: ["scala"],
  JavaScript: ["javascript", "javascriptreact"],
  TypeScript: ["typescript", "typescriptreact"],
  Vue: ["vue"],
  HTML: ["html"],
  XML: ["xml"],
  CSS: ["css"],
  SCSS: ["scss"],
  SASS: ["sass"],
  LESS: ["less"],
  JSON: ["json", "jsonc"],
  yaml: ["yaml"],
  TOML: ["toml"],
  Markdown: ["markdown"],
  Python: ["python"],
  go: ["go"],
  Rust: ["rust"],
  PHP: ["php"],
  ruby: ["ruby"],
  Dart: ["dart"],
  Swift: ["swift"],
  "C#": ["csharp"],
  Lua: ["lua"],
  SQL: ["sql"],
  "Shell Script": ["shellscript"],
};
