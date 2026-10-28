/**
 * Editor › General and its sub-pages, after IntelliJ IDEA / PyCharm 2025:
 * Auto Import, Appearance, Breadcrumbs, Code Completion, Code Folding, Editor
 * Tabs, Gutter Icons, Rich-Text Copy, Smart Keys, Sticky Lines; plus Code
 * Editing and Inlay Hints. Every option is read by `editor/core` or
 * `editor/lsp` through `platform/editorSettings`.
 */
import { useEffect, useId, useState } from "react";
import clsx from "clsx";
import { commands, isTauri } from "@/platform/ipc";
import { Checkbox } from "@/ui";
import { SearchLabel, Select } from "../../components/Form";
import { useLabelMatch, useSetting } from "../../components/context";
import { editorPage, type Item } from "./kit";
import styles from "./Editor.module.css";
import { tx } from "@/platform/i18n";

const P = "editor";
const ms = (key: string, max = 5000) => ({ kind: "number" as const, key, min: 0, max, unit: "ms" });

/** Language names for per-language lists (Breadcrumbs, Inlay Hints). */
export function useLanguages(): Array<{ id: string; name: string }> {
  const [langs, setLangs] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    void commands
      .languages()
      .then(
        (list) =>
          live && setLangs(list.map((l) => ({ id: l.id, name: l.name })).sort((a, b) => a.name.localeCompare(b.name))),
      )
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return langs;
}

/** Checkbox list over the languages, storing the unchecked ones in `key`. */
function LanguageChecks({ k, label, disabled }: { k: string; label: string; disabled?: boolean }) {
  const [off, setOff] = useSetting<string[]>(k);
  const langs = useLanguages().filter((l) => !["plaintext", "log", "diff"].includes(l.id));
  const matched = useLabelMatch(label);
  if (!langs.length) return null;
  return (
    <div className={matched ? styles.matched : undefined}>
      <div className={styles.note}>
        <SearchLabel text={label} />
      </div>
      <div className={styles.grid}>
        {[0, 1].map((col) => (
          <div key={col} className={styles.column}>
            {langs
              .filter((_, i) => i % 2 === col)
              .map((l) => (
                <div key={l.id} className={styles.check}>
                  <Checkbox
                    checked={!off.includes(l.id)}
                    disabled={disabled}
                    label={l.name}
                    onChange={(on) => setOff(on ? off.filter((x) => x !== l.id) : [...off, l.id])}
                  />
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function BreadcrumbLanguages() {
  const [show] = useSetting<boolean>(`${P}.breadcrumbs.show`);
  return <LanguageChecks k={`${P}.breadcrumbs.disabledLanguages`} label="Show breadcrumbs for:" disabled={!show} />;
}

function InlayLanguages() {
  const [on] = useSetting<boolean>(`${P}.inlayHints`);
  return <LanguageChecks k={`${P}.inlay.disabledLanguages`} label="Show inlay hints for:" disabled={!on} />;
}

function InlineCompletionLanguages() {
  const [on] = useSetting<boolean>(`${P}.inlineCompletion.enabled`);
  return (
    <LanguageChecks k={`${P}.inlineCompletion.disabledLanguages`} label="Show inline completion for:" disabled={!on} />
  );
}

const GENERAL = editorPage({
  id: "editor.general",
  title: "General",
  order: 20,
  projectScope: true,
  keywords: ["mouse", "scroll", "wrap", "trailing spaces", "save"],
  sections: [
    {
      title: "Mouse Control",
      items: [
        { t: "check", key: `${P}.general.wheelZoom`, label: "Change font size with Command+Mouse Wheel" },
        { t: "check", key: `${P}.general.dragAndDrop`, label: "Enable drag-and-drop functionality in editor" },
      ],
    },
    {
      title: "Scrolling",
      items: [
        {
          t: "radio",
          key: `${P}.general.caretScroll`,
          label: "When caret is moved",
          options: [
            { value: "center", label: "Prefer scrolling editor canvas to keep caret line centered" },
            { value: "minimize", label: "Prefer moving caret line to minimize editor scrolling" },
          ],
        },
      ],
    },
    {
      title: "Soft Wraps",
      items: [
        {
          t: "check",
          key: `${P}.softWrap`,
          label: "Soft-wrap files",
          children: [
            {
              t: "text",
              key: `${P}.general.softWrapFiles`,
              label: "File patterns",
              placeholder: "*.md; *.txt",
              hint: "Use ; to separate patterns. * matches every file.",
            },
            { t: "check", key: `${P}.general.softWrapIndent`, label: "Use original line's indent for wrapped parts" },
          ],
        },
      ],
    },
    {
      title: "Virtual Space",
      items: [{ t: "check", key: `${P}.general.scrollPastEnd`, label: "Show virtual space at file bottom" }],
    },
    {
      title: "Save Files",
      items: [
        {
          t: "check",
          key: "files.trimTrailingWhitespace",
          label: "Remove trailing spaces on:",
          inline: {
            kind: "select",
            key: `${P}.general.stripTrailingScope`,
            options: [
              { value: "modified", label: "Modified lines" },
              { value: "all", label: "All lines" },
            ],
          },
          children: [
            { t: "check", key: `${P}.general.keepTrailingOnCaretLine`, label: "Keep trailing spaces on caret line" },
          ],
        },
        {
          t: "check",
          key: `${P}.general.removeTrailingBlankLines`,
          label: "Remove trailing blank lines at the end of saved files",
        },
        { t: "check", key: "files.ensureFinalNewline", label: "Ensure every saved file ends with a line break" },
        {
          t: "check",
          key: `${P}.formatOnSave`,
          label: "Reformat code on save",
          hint: "Runs the language server's formatter before an explicit save (Actions on Save).",
        },
      ],
    },
  ],
});

const AUTO_IMPORT = editorPage({
  id: "editor.general.autoImport",
  title: "Auto Import",
  order: 0,
  keywords: ["import", "organize imports", "unambiguous"],
  sections: [
    {
      items: [
        {
          t: "check",
          key: `${P}.autoImport.addUnambiguous`,
          label: "Add unambiguous imports on the fly",
          hint: "Applies the import quick fix of an unresolved reference when the language server offers exactly one.",
        },
        {
          t: "check",
          key: `${P}.autoImport.optimizeOnTheFly`,
          label: "Optimize imports on the fly",
          hint: "Runs Optimize Imports when the file has no errors, unless it would change the caret line.",
        },
      ],
    },
  ],
});

const APPEARANCE = editorPage({
  id: "editor.general.appearance",
  title: "Appearance",
  order: 1,
  keywords: ["caret", "line numbers", "whitespace", "indent guides", "distraction free", "zen"],
  sections: [
    {
      items: [
        {
          t: "check",
          key: `${P}.appearance.caretBlinking`,
          label: "Caret blinking (ms):",
          inline: { kind: "number", key: `${P}.appearance.caretBlinkPeriod`, min: 100, max: 2000 },
        },
        { t: "check", key: `${P}.appearance.smoothCaretBlinking`, label: "Use smooth caret blinking" },
        { t: "check", key: `${P}.appearance.blockCaret`, label: "Use block caret" },
        {
          t: "check",
          key: `${P}.appearance.smoothCaretMovement`,
          label: "Use smooth caret movement",
          inline: {
            kind: "select",
            key: `${P}.appearance.caretMovementStyle`,
            options: [
              { value: "snappy", label: "Snappy" },
              { value: "gliding", label: "Gliding" },
            ],
          },
        },
        {
          t: "check",
          key: `${P}.appearance.hardWrapGuides`,
          label: "Show hard wrap and visual guides (configured in Code Style options)",
        },
        { t: "check", key: `${P}.appearance.lineNumbers`, label: "Show line numbers" },
        { t: "check", key: `${P}.appearance.methodSeparators`, label: "Show method separators" },
        {
          t: "check",
          key: `${P}.showWhitespace`,
          label: "Show whitespaces",
          children: [
            { t: "check", key: `${P}.appearance.whitespaceLeading`, label: "Leading" },
            { t: "check", key: `${P}.appearance.whitespaceInner`, label: "Inner" },
            { t: "check", key: `${P}.appearance.whitespaceTrailing`, label: "Trailing" },
          ],
        },
        { t: "check", key: `${P}.appearance.indentGuides`, label: "Show indent guides" },
        { t: "check", key: `${P}.appearance.intentionBulb`, label: "Show intention bulb" },
        {
          t: "number",
          key: `${P}.appearance.distractionFreeWidth`,
          label: "Distraction free mode text width:",
          min: 20,
          max: 500,
          unit: "chars",
        },
      ],
    },
  ],
});

const BREADCRUMBS = editorPage({
  id: "editor.general.breadcrumbs",
  title: "Breadcrumbs",
  order: 2,
  sections: [
    {
      items: [
        {
          t: "check",
          key: `${P}.breadcrumbs.show`,
          label: "Show breadcrumbs:",
          hint: "The project path is always shown in the status bar navigation bar.",
          children: [
            {
              t: "radio",
              key: `${P}.breadcrumbs.placement`,
              label: "",
              options: [
                { value: "top", label: "Top" },
                { value: "bottom", label: "Bottom" },
              ],
            },
          ],
        },
        { t: "custom", label: "Show breadcrumbs for:", keywords: ["languages"], component: BreadcrumbLanguages },
      ],
    },
  ],
});

const COMPLETION = editorPage({
  id: "editor.general.codeCompletion",
  title: "Code Completion",
  order: 3,
  keywords: ["autocomplete", "suggestions", "case sensitive", "parameter info", "popup", "sort", "parentheses"],
  sections: [
    {
      items: [
        {
          t: "check",
          key: `${P}.completion.matchCase`,
          label: "Match case:",
          inline: {
            kind: "select",
            key: `${P}.completion.caseSensitivity`,
            options: [
              { value: "first", label: "First letter only" },
              { value: "all", label: "All letters" },
            ],
          },
        },
        {
          t: "check",
          key: `${P}.completion.autoInsertSingle`,
          label: "Automatically insert single suggestions",
          hint: "When Basic Completion (⌃Space) finds only one suggestion.",
        },
        {
          t: "check",
          key: `${P}.completion.sortAlphabetically`,
          label: "Sort suggestions alphabetically",
          hint: "Also toggled by Sort by name in the completion popup.",
        },
        {
          t: "check",
          key: `${P}.completion.autoPopup`,
          label: "Show suggestions as you type",
          children: [
            {
              t: "check",
              key: `${P}.completion.insertOnSpecialKeys`,
              label: "Insert selected suggestion by pressing space, dot, or other context-dependent keys",
            },
          ],
        },
        {
          t: "check",
          key: `${P}.completion.showDocumentation`,
          label: "Show the documentation popup in",
          inline: ms(`${P}.completion.documentationDelay`),
        },
        {
          t: "check",
          key: `${P}.completion.insertParentheses`,
          label: "Insert parentheses automatically when applicable",
          hint: "Function and method suggestions get (); the caret goes inside unless there are no parameters.",
        },
      ],
    },
    {
      title: "Parameter Info",
      items: [
        {
          t: "check",
          key: `${P}.completion.parameterInfo`,
          label: "Show the parameter info popup in",
          inline: ms(`${P}.completion.parameterInfoDelay`),
        },
      ],
    },
  ],
});

const FOLDING = editorPage({
  id: "editor.general.codeFolding",
  title: "Code Folding",
  order: 4,
  keywords: ["fold", "collapse"],
  sections: [
    { items: [{ t: "check", key: `${P}.folding.showOutline`, label: "Show code folding outline" }] },
    {
      title: "Fold by default:",
      items: [
        {
          t: "grid",
          columns: [
            [
              { t: "check", key: `${P}.folding.fileHeader`, label: "File header" },
              { t: "check", key: `${P}.folding.imports`, label: "Imports" },
            ],
            [{ t: "check", key: `${P}.folding.docComments`, label: "Documentation comments" }],
          ],
        },
      ],
    },
  ],
});

const TABS = editorPage({
  id: "editor.general.editorTabs",
  title: "Editor Tabs",
  order: 5,
  keywords: ["tab limit", "preview tab", "close button", "pinned", "squeeze", "rows"],
  sections: [
    {
      title: "Appearance",
      items: [
        {
          t: "select",
          key: `${P}.tabs.placement`,
          label: "Tab placement",
          options: [
            { value: "top", label: "Top" },
            { value: "bottom", label: "Bottom" },
            { value: "left", label: "Left" },
            { value: "right", label: "Right" },
            { value: "none", label: "None" },
          ],
        },
        {
          t: "custom",
          label: "Show tabs in:",
          keywords: ["One row", "Scroll the tabs panel", "Squeeze tabs", "Multiple rows"],
          component: TabRows,
        },
        { t: "check", key: `${P}.tabs.pinnedSeparateRow`, label: "Show pinned tabs in a separate row" },
        { t: "check", key: `${P}.tabs.showFileIcon`, label: "Show file icon" },
        { t: "check", key: `${P}.tabs.showExtension`, label: "Show file extension" },
        {
          t: "check",
          key: `${P}.tabs.showDirectoryForNonUnique`,
          label: "Show directory for non-unique file names",
        },
        { t: "check", key: `${P}.tabs.markModified`, label: "Mark modified (*)" },
        { t: "check", key: `${P}.tabs.showFullPathOnHover`, label: "Show full path on mouse hover" },
        {
          t: "custom",
          label: "Close button position:",
          keywords: ["Right", "Left", "None"],
          component: CloseButtonPosition,
        },
      ],
    },
    {
      title: "Tab Order",
      items: [
        { t: "check", key: `${P}.tabs.sortAlphabetically`, label: "Sort tabs alphabetically" },
        { t: "check", key: `${P}.tabs.openAtEnd`, label: "Open new tabs at the end" },
      ],
    },
    {
      title: "Opening Policy",
      items: [{ t: "check", key: `${P}.tabs.previewTab`, label: "Enable preview tab" }],
    },
    {
      title: "Closing Policy",
      items: [
        { t: "number", key: `${P}.tabs.tabLimit`, label: "Tab limit", min: 1, max: 100 },
        {
          t: "radio",
          key: `${P}.tabs.closingPolicy`,
          label: "When the tab limit is reached",
          options: [
            { value: "unchanged", label: "Close non-modified files first" },
            { value: "lru", label: "Close least recently used files" },
          ],
        },
        {
          t: "radio",
          key: `${P}.tabs.activateOnClose`,
          label: "When the current tab is closed, activate",
          options: [
            { value: "left", label: "The tab on the left" },
            { value: "right", label: "The tab on the right" },
            { value: "mru", label: "Most recently opened tab" },
          ],
        },
      ],
    },
  ],
});

/** Show tabs in: one row (scroll or squeeze when they don't fit) or multiple rows. */
function TabRows() {
  const [multiple, setMultiple] = useSetting<boolean>(`${P}.tabs.multipleRows`);
  const [overflow, setOverflow] = useSetting<string>(`${P}.tabs.oneRowOverflow`);
  const [placement] = useSetting<string>(`${P}.tabs.placement`);
  const matched = useLabelMatch("Show tabs in:");
  const name = useId();
  // Vertical (left / right) tabs always scroll in one column.
  const disabled = placement === "none" || placement === "left" || placement === "right";
  const radio = (label: string, checked: boolean, onChange: () => void, off = disabled) => (
    <label className={clsx(styles.radio, off && styles.dim)}>
      <input type="radio" name={name} checked={checked} disabled={off} onChange={onChange} />
      <SearchLabel text={label} />
    </label>
  );
  return (
    <div
      className={clsx(styles.radioBlock, matched && styles.matched)}
      role="radiogroup"
      aria-label={tx("Show tabs in")}
    >
      <div className={clsx(styles.radioLabel, disabled && styles.dim)}>
        <SearchLabel text="Show tabs in" />:
      </div>
      <div className={styles.radios}>
        {radio("One row, and if tabs don't fit:", !multiple, () => setMultiple(false))}
        <div className={styles.children} role="radiogroup" aria-label={tx("If tabs don't fit")}>
          {radio(
            "Scroll the tabs panel",
            !multiple && overflow !== "squeeze",
            () => setOverflow("scroll"),
            disabled || multiple,
          )}
          {radio(
            "Squeeze tabs",
            !multiple && overflow === "squeeze",
            () => setOverflow("squeeze"),
            disabled || multiple,
          )}
        </div>
        {radio("Multiple rows", multiple, () => setMultiple(true))}
      </div>
    </div>
  );
}

const CLOSE_POSITIONS = [
  { value: "right", label: "Right" },
  { value: "left", label: "Left" },
  { value: "none", label: "None" },
];

/** Close button position: `showCloseButton` off is "None", else `closeButtonPosition`. */
function CloseButtonPosition() {
  const [show, setShow] = useSetting<boolean>(`${P}.tabs.showCloseButton`);
  const [position, setPosition] = useSetting<string>(`${P}.tabs.closeButtonPosition`);
  const matched = useLabelMatch("Close button position:");
  return (
    <div className={clsx(styles.check, matched && styles.matched)}>
      <span>
        <SearchLabel text="Close button position:" />
      </span>
      <Select
        value={show ? (position === "left" ? "left" : "right") : "none"}
        options={CLOSE_POSITIONS}
        aria-label="Close button position"
        onChange={(v) => {
          setShow(v !== "none");
          if (v !== "none") setPosition(v);
        }}
      />
    </div>
  );
}

const GUTTER = editorPage({
  id: "editor.general.gutterIcons",
  title: "Gutter Icons",
  order: 6,
  sections: [
    {
      items: [
        {
          t: "check",
          key: `${P}.showGutterIcons`,
          label: "Show gutter icons",
          children: [
            {
              t: "custom",
              label: "Run",
              keywords: ["run configurations", "test"],
              component: () => <GutterGroup id="run" label="Run configurations and tests" />,
            },
            { t: "custom", label: "Bookmarks", component: () => <GutterGroup id="bookmarks" label="Bookmarks" /> },
            {
              t: "custom",
              label: "Implemented and overridden",
              keywords: ["implementations", "subclasses", "inheritors"],
              component: () => <GutterGroup id="inheritors" label="Implemented and overridden declarations" />,
            },
            {
              t: "custom",
              label: "Implementing and overriding",
              keywords: ["super method", "overrides", "implements"],
              component: () => <GutterGroup id="supers" label="Implementing and overriding methods" />,
            },
          ],
        },
      ],
    },
  ],
});

function GutterGroup({ id, label }: { id: string; label: string }) {
  const [disabled, set] = useSetting<string[]>(`${P}.gutterIconsDisabled`);
  const [master] = useSetting<boolean>(`${P}.showGutterIcons`);
  const matched = useLabelMatch(label);
  return (
    <div className={matched ? `${styles.check} ${styles.matched}` : styles.check}>
      <Checkbox
        checked={!disabled.includes(id)}
        disabled={!master}
        label={<SearchLabel text={label} />}
        onChange={(on) => set(on ? disabled.filter((x) => x !== id) : [...disabled, id])}
      />
    </div>
  );
}

const RICH_COPY = editorPage({
  id: "editor.general.richTextCopy",
  title: "Rich-Text Copy",
  order: 8,
  sections: [
    {
      items: [
        {
          t: "check",
          key: `${P}.general.richTextCopy`,
          label: "Copy as rich text by default",
          hint: "Copied code keeps the editor's syntax colors and font when pasted into documents and mail.",
        },
      ],
    },
  ],
});

const SMART_KEYS = editorPage({
  id: "editor.general.smartKeys",
  title: "Smart Keys",
  order: 9,
  keywords: ["brackets", "quotes", "home", "camel humps", "paste", "indent"],
  sections: [
    {
      items: [
        { t: "check", key: `${P}.smartKeys.smartHome`, label: "Home moves caret to first non-whitespace character" },
        {
          t: "check",
          key: `${P}.smartKeys.camelHumps`,
          label: 'Use "CamelHumps" words',
          hint: "⌥← / ⌥→ and ⌥⌫ stop at humps of camelCase names.",
        },
        { t: "check", key: `${P}.smartKeys.pairBrackets`, label: "Insert paired brackets (), [], {}" },
        { t: "check", key: `${P}.smartKeys.pairQuotes`, label: "Insert pair quote" },
        { t: "check", key: `${P}.smartKeys.surroundSelection`, label: "Surround selection on typing quote or brace" },
        { t: "check", key: `${P}.smartKeys.tabOutOfPair`, label: "Jump outside closing bracket/quote with Tab" },
        {
          t: "select",
          key: `${P}.smartKeys.reformatOnPaste`,
          label: "Reformat on paste",
          options: [
            { value: "none", label: "None" },
            { value: "indentBlock", label: "Indent Block" },
            { value: "indentEachLine", label: "Indent Each Line" },
          ],
        },
      ],
    },
    {
      title: "Enter",
      items: [{ t: "check", key: `${P}.smartKeys.smartIndent`, label: "Smart indent" }],
    },
    {
      title: "Backspace",
      items: [
        {
          t: "select",
          key: `${P}.smartKeys.backspaceUnindent`,
          label: "Unindent",
          options: [
            { value: "autoindent", label: "To proper indent position" },
            { value: "nearest", label: "To nearest indent position" },
            { value: "none", label: "Disabled" },
          ],
        },
      ],
    },
  ],
});

const INLINE_COMPLETION = editorPage({
  id: "editor.general.inlineCompletion",
  title: "Inline Completion",
  order: 7,
  keywords: ["ghost text", "inline suggestions", "full line completion", "copilot"],
  sections: [
    {
      items: [
        {
          t: "note",
          text: "Gray suggestions at the caret from language servers that support inline completion. Tab accepts a suggestion, Escape dismisses it.",
        },
        {
          t: "check",
          key: `${P}.inlineCompletion.enabled`,
          label: "Enable inline completion",
          children: [
            {
              t: "check",
              key: `${P}.inlineCompletion.onlyOnPause`,
              label: "Show only when typing pauses for",
              inline: ms(`${P}.inlineCompletion.pauseMs`, 3000),
            },
          ],
        },
      ],
    },
    {
      title: "Languages",
      items: [{ t: "custom", label: "Show inline completion for:", component: InlineCompletionLanguages }],
    },
  ],
});

const STICKY = editorPage({
  id: "editor.general.stickyLines",
  title: "Sticky Lines",
  order: 10,
  keywords: ["sticky scroll"],
  sections: [
    {
      items: [
        {
          t: "check",
          key: `${P}.stickyScroll`,
          label: "Show sticky lines while scrolling",
          children: [
            { t: "number", key: `${P}.codeEditing.stickyLinesMax`, label: "Maximum number of lines", min: 1, max: 20 },
          ],
        },
      ],
    },
  ],
});

const CODE_EDITING = editorPage({
  id: "editor.codeEditing",
  title: "Code Editing",
  order: 21,
  keywords: ["highlight", "quick documentation", "hover", "error"],
  sections: [
    {
      title: "Highlight on Caret Movement",
      items: [
        { t: "check", key: `${P}.codeEditing.highlightUsages`, label: "Usages of element at caret" },
        { t: "check", key: `${P}.codeEditing.highlightBraces`, label: "Matched brace" },
        { t: "check", key: `${P}.codeEditing.highlightSelection`, label: "Occurrences of selected text" },
      ],
    },
    {
      title: "Quick Documentation",
      items: [
        {
          t: "check",
          key: `${P}.codeEditing.quickDocOnHover`,
          label: "Show quick documentation on hover",
          children: [
            {
              t: "number",
              key: `${P}.codeEditing.quickDocDelay`,
              label: "Tooltip delay",
              min: 100,
              max: 5000,
              unit: "ms",
            },
          ],
        },
      ],
    },
    {
      title: "Error Highlighting",
      items: [
        {
          t: "check",
          key: `${P}.codeEditing.nextErrorErrorsOnly`,
          label: "Next error action goes to high priority problems only",
        },
      ],
    },
  ],
});

const INLAY: Item[] = [
  {
    t: "check",
    key: `${P}.inlayHints`,
    label: "Show inlay hints",
    children: [
      { t: "check", key: `${P}.inlay.types`, label: "Types" },
      { t: "check", key: `${P}.inlay.parameters`, label: "Parameter names" },
      { t: "check", key: `${P}.inlay.other`, label: "Other hints (chaining, closing labels…)" },
    ],
  },
];

const INLAY_HINTS = editorPage({
  id: "editor.inlayHints",
  title: "Inlay Hints",
  order: 33,
  keywords: ["hints", "code vision", "usages", "parameter hints", "type hints"],
  sections: [
    { items: INLAY },
    {
      title: "Code Vision",
      items: [
        { t: "check", key: `${P}.inlay.codeVisionUsages`, label: "Usages" },
        { t: "check", key: `${P}.inlay.codeVisionAuthor`, label: "Code author" },
      ],
    },
    { title: "Languages", items: [{ t: "custom", label: "Show inlay hints for:", component: InlayLanguages }] },
  ],
});

export const GENERAL_PAGES = [
  GENERAL,
  AUTO_IMPORT,
  APPEARANCE,
  BREADCRUMBS,
  COMPLETION,
  FOLDING,
  TABS,
  GUTTER,
  INLINE_COMPLETION,
  RICH_COPY,
  SMART_KEYS,
  STICKY,
  CODE_EDITING,
  INLAY_HINTS,
];
