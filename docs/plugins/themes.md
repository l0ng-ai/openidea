# Theme plugins

OpenIDEA ships seven [built-in themes](../themes.md): Islands Light, Islands Dark,
High Contrast, Solarized Light, Solarized Dark, One Light and One Dark. Additional
themes come from **theme plugins**, the same model as
IntelliJ IDEA, where most themes are plugins rather than part of the IDE.

A theme plugin is data only. Like an IntelliJ theme (a `.theme.json` plus an
optional `.icls` editor scheme) it has no code: no WebAssembly, nothing to
compile, no permissions.

```
my-theme/
├─ plugin.toml                    # manifest
└─ themes/
   ├─ my-theme.theme.json         # UI colours (IntelliJ: .theme.json)
   └─ my-theme.scheme.json        # editor colours, optional (IntelliJ: .icls)
```

The quickest way to start is to copy [`templates/theme-plugin`](../../templates/theme-plugin).
It contains *Harbor Night*, a complete example dark theme that sets every
themeable token. The rest of this page covers the file format, the token
reference, porting themes from IntelliJ IDEA and VS Code, and testing.

## The manifest

```toml
id = "theme-harbor-night"          # [a-z0-9][a-z0-9_-]*, unique among plugins
name = "Harbor Night Theme"
version = "1.0.0"
description = "..."
authors = ["You <you@example.com>"]
openidea-api = "0.1"

[[contributes.themes]]             # one entry per theme; a plugin may ship several
path = "themes/harbor-night.theme.json"
editor-scheme = "themes/harbor-night.scheme.json"   # optional
```

Paths are relative to the package directory and may not leave it. The other
manifest fields are described in [`plugins/README.md`](../../plugins/README.md).

## The theme file

```jsonc
{
  "id": "harbor-night",            // [a-z0-9][a-z0-9._-]*, unique within the plugin
  "name": "Harbor Night",          // shown in Settings › Plugins
  "kind": "dark",                  // "dark" or "light": the built-in base
  "tokens": {
    "--bg-app": "#14171c",
    "--accent": "#2b9e93"
  }
}
```

- **`tokens`** are the CSS variables of [`src/styles/tokens.css`](../../src/styles/tokens.css),
  the IDE's single source of colours. Components never use colour literals, so
  every surface, border, text colour, syntax colour and status colour can be
  themed through them. The [reference](#token-reference) lists them all.
- **`kind`** picks the built-in base. While the theme is active the IDE runs on
  Islands Dark or Islands Light, and every token the theme leaves out keeps
  that base's value. Icons also use the light or dark set that matches the
  kind. A partial theme still looks consistent, but listing every token keeps
  it stable when the IDE's own palette changes.
- Values are plain CSS values: hex (`#rgb`, `#rrggbb`, `#rrggbbaa`), `rgb()`,
  `hsl()`, `color-mix()`, `var(--other-token)`, or for the few non-colour
  tokens a keyword (`italic`, `normal`, `none`) or shadow list. `url()`,
  `image()`, `;`, braces, `<`, `>` and `\` are rejected.
- `//` and `/* */` comments are allowed, as in VS Code theme files.
- Tokens that tokens.css derives from others (for example `--bg-editor` is
  `var(--bg-island)`, and the coverage and flame graph colours are mixed from
  the status colours) follow automatically. You may still set them.
- Metrics (`--fs-*`, `--h-*`, `--radius-*`) and fonts (`--font-ui`,
  `--font-mono`) can be overridden too, but a theme normally leaves them alone
  so that compact mode and the user's font settings keep working.

### The editor colour scheme file

```jsonc
{
  "name": "Harbor Night",
  "tokens": { "--syn-keyword": "#e0a46e", "--caret": "#5ce0d2" }
}
```

Its tokens are merged over the theme's, and the scheme wins where both set a
token. By convention it holds the *syntax*, *editor* and *ANSI palette* groups
of the reference, the parts IntelliJ keeps in an `.icls` file. The split only
organises the files: a theme can also put everything in its theme file.

### How a theme is applied

The selected theme is injected as one stylesheet on `:root` that outranks the
built-in theme blocks, and `data-theme` is switched to the theme's `kind`.
Three things still layer on top of it:

- an accent colour picked in *Settings › Appearance* (other than the default),
- an explicit scheme or attribute overrides in *Settings › Editor › Color Scheme*,
- the appearance options that change only metrics (compact mode).

The selection is remembered. When the plugin is disabled or uninstalled the
built-in theme returns.

## Building, packaging, installing

There is no build step. The package *is* the folder.

1. Copy `templates/theme-plugin` and rename `id`, `name` and the theme files.
2. Edit the colours. Keep `kind` truthful (`light` for light backgrounds).
3. **Install:** *Settings › Plugins › ⚙ › Install Plugin from Disk…* (or the
   *Install Plugin from Disk…* action) and pick the package folder. The
   manifest and the files it references are copied to
   `<app-data>/plugins/<id>/`.
4. **Apply:** in *Settings › Plugins*, select the plugin and press *Apply* next
   to the theme. *Use Default Theme* switches back.

To iterate without reinstalling, put (or symlink) the package in
`<project>/.openidea/plugins/<name>/` of an open project. It loads as a *dev*
plugin, and *Reload* (or the *Reload Plugins* action) picks up your edits.

To share a theme, publish the folder (a Git repository or a zip). Users
install it from disk.

## Porting a theme

Only port themes whose licence allows redistribution, keep their licence file,
and credit the original authors in `authors` and `description`.

### From IntelliJ IDEA (automatic)

`scripts/theme/import-intellij-theme.ts` converts an IntelliJ `.theme.json`,
and optionally its `.icls` editor scheme, into a ready-to-install plugin. It
has no dependencies beyond Node 22.

```sh
pnpm theme:import-intellij path/to/MyTheme.theme.json path/to/MyTheme.icls --out ~/my-theme --author "Original Author"
# or: node scripts/theme/import-intellij-theme.ts …
```

It maps the keys in the tables below, resolves named colours from the theme's
`colors` section and `*` wildcards, and takes `kind` from `"dark"` (or the
`.icls` `parent_scheme`). Tokens without an IntelliJ counterpart keep the
built-in values for that kind. Open the result next to the template and fill
in what matters to you. Themes that ship only a `.theme.json` with an
`editorScheme` path need that `.icls` passed as the second argument. Themes that
ship no `.icls` at all keep the built-in syntax colours.

#### `.theme.json` → UI theme

| OpenIDEA token | IntelliJ `ui` key (first present wins) |
|---|---|
| `--bg-app` | `Panel.background` |
| `--bg-frame` | `MainWindow.background`, `MainToolbar.background` |
| `--bg-island`, `--bg-elev` | `ToolWindow.background` |
| `--bg-popup` | `Popup.background`, `PopupMenu.background` |
| `--bg-hover` | `List.hoverBackground`, `Tree.hoverBackground` |
| `--bg-selected`, `--bg-tree-selected` | `List.selectionBackground`, `Tree.selectionBackground` |
| `--bg-tree-selected-inactive` | `Tree.selectionInactiveBackground` |
| `--bg-input`, `--bg-field` | `TextField.background` |
| `--border` | `Borders.color` |
| `--border-strong`, `--border-window` | `Component.borderColor`, `Borders.ContrastBorderColor` |
| `--fg`, `--fg-emphasis` | `Label.foreground` |
| `--fg-secondary`, `--fg-muted` | `Label.infoForeground`, `Component.infoForeground` |
| `--fg-subtle`, `--fg-faint` | `Label.disabledForeground` |
| `--accent` | `Button.default.startBackground`, `Component.focusColor` |
| `--fg-on-accent`, `--fg-button-primary` | `Button.default.foreground` |
| `--link`, `--link-hover` | `Link.activeForeground`, `Link.hoverForeground` |
| `--danger`, `--warning` | `Component.errorFocusColor`, `Component.warningFocusColor` |
| `--bg-tooltip`, `--fg-tooltip`, `--border-tooltip` | `ToolTip.background`, `.foreground`, `.borderColor` |
| `--bg-button`, `--border-button` | `Button.startBackground`, `Button.startBorderColor` |
| `--bg-tab-selected`, `--border-tab-selected` | `EditorTabs.underlinedTabBackground`, `EditorTabs.underlineColor` |
| `--bg-toolbar-hover`, `--bg-toolbar-pressed` | `ActionButton.hoverBackground`, `ActionButton.pressedBackground` |
| `--bg-stripe-hover`, `--bg-stripe-selected` | `ToolWindow.Button.hoverBackground`, `.selectedBackground` |
| `--scrollbar-thumb`, `--scrollbar-thumb-hover` | `ScrollBar.Mac.thumbColor`, `ScrollBar.Mac.hoverThumbColor` |
| `--bg-toggle-*` | `ToggleButton.onBackground`, `.offBackground`, `.buttonColor` |
| `--bg-feedback-*`, `--border-feedback-*` | `Banner.infoBackground`, `Banner.errorBorderColor`, … |

The full table is `UI_KEYS` in [`scripts/theme/intellij.ts`](../../scripts/theme/intellij.ts).

#### `.icls` → editor scheme

| OpenIDEA token | `.icls` option |
|---|---|
| `--fg-editor`, `--bg-editor` | attribute `TEXT` (foreground, background) |
| `--caret`, `--bg-current-line` | colour `CARET_COLOR`, `CARET_ROW_COLOR` |
| `--bg-editor-selection` | colour `SELECTION_BACKGROUND` |
| `--fg-line-number`, `--fg-line-number-current` | colour `LINE_NUMBERS_COLOR`, `LINE_NUMBER_ON_CARET_ROW_COLOR` |
| `--border-indent-guide`, `--border-right-margin`, `--fg-whitespace` | colour `INDENT_GUIDE`, `RIGHT_MARGIN_COLOR`, `WHITESPACES` |
| `--vcs-*`, `--gutter-*` | colour `FILESTATUS_*`, `MODIFIED_LINES_COLOR`, `ADDED_LINES_COLOR`, `DELETED_LINES_COLOR` |
| `--syn-keyword`, `--syn-string`, `--syn-number` | `DEFAULT_KEYWORD`, `DEFAULT_STRING`, `DEFAULT_NUMBER` |
| `--syn-comment` (+ `--syn-comment-style`), `--syn-doc-comment` | `DEFAULT_LINE_COMMENT` (+ `FONT_TYPE`), `DEFAULT_DOC_COMMENT` |
| `--syn-function`, `--syn-function-call` | `DEFAULT_FUNCTION_DECLARATION`, `DEFAULT_FUNCTION_CALL` |
| `--syn-type`, `--syn-constant`, `--syn-property` | `DEFAULT_CLASS_NAME`, `DEFAULT_CONSTANT`, `DEFAULT_INSTANCE_FIELD` |
| `--syn-variable`, `--syn-param`, `--syn-builtin` | `DEFAULT_LOCAL_VARIABLE`, `DEFAULT_PARAMETER`, `DEFAULT_PREDEFINED_SYMBOL` |
| `--syn-annotation`, `--syn-decorator` | `DEFAULT_METADATA` |
| `--syn-punct`, `--syn-escape` | `DEFAULT_OPERATION_SIGN`, `DEFAULT_VALID_STRING_ESCAPE` |
| `--syn-tag`, `--syn-attribute`, `--syn-todo`, `--syn-invalid` | `DEFAULT_TAG`, `DEFAULT_ATTRIBUTE`, `TODO_DEFAULT_ATTRIBUTES`, `BAD_CHARACTER` |
| `--syn-rainbow-1` … `--syn-rainbow-5` (Semantic highlighting) | `RAINBOW_COLOR1` … `RAINBOW_COLOR5` |
| `--wave-error`, `--wave-warning` | `ERRORS_ATTRIBUTES`, `WARNING_ATTRIBUTES` (effect colour) |
| `--bg-matched-brace`, `--bg-identifier-under-caret` | `MATCHED_BRACE_ATTRIBUTES`, `IDENTIFIER_UNDER_CARET_ATTRIBUTES` |
| `--bg-text-search-result`, `--bg-search-match` | `TEXT_SEARCH_RESULT_ATTRIBUTES`, `SEARCH_RESULT_ATTRIBUTES` |
| `--syn-self`, `--syn-keyword-arg`, `--syn-docstring`, `--syn-predefined` | `PY.SELF_PARAMETER`, `PY.KEYWORD_ARGUMENT`, `PY.DOC_COMMENT`, `PY.BUILTIN_NAME` |
| `--ansi-*` | `CONSOLE_*_OUTPUT` (`CONSOLE_DARKGRAY_OUTPUT` is bright black, `CONSOLE_GRAY_OUTPUT` white) |

The full tables are `ICLS_COLORS` and `ICLS_ATTRIBUTES` in the same file.

### From VS Code (by hand)

A VS Code theme (`themes/*.json` in the extension) has `type` (`dark` / `light`
/ `hc`), `colors` (workbench) and `tokenColors` (TextMate scopes). Set `kind`
from `type`, then map:

| OpenIDEA token | VS Code `colors` key |
|---|---|
| `--bg-frame` | `titleBar.activeBackground`, `activityBar.background` |
| `--bg-island`, `--bg-app` | `editor.background`, `sideBar.background` |
| `--bg-elev` | `sideBarSectionHeader.background`, `editorGroupHeader.tabsBackground` |
| `--bg-popup`, `--border-popup` | `editorWidget.background`, `editorWidget.border` |
| `--bg-hover` | `list.hoverBackground` |
| `--bg-selected`, `--bg-tree-selected` | `list.activeSelectionBackground` |
| `--bg-tree-selected-inactive` | `list.inactiveSelectionBackground` |
| `--border` | `panel.border`, `sideBar.border` |
| `--fg` | `foreground`, `sideBar.foreground` |
| `--fg-muted`, `--fg-subtle` | `descriptionForeground`, `disabledForeground` |
| `--accent`, `--fg-on-accent` | `button.background`, `button.foreground` |
| `--focus-ring-soft` | `focusBorder` |
| `--link` | `textLink.foreground` |
| `--bg-input`, `--bg-field` | `input.background` |
| `--bg-tab-selected`, `--border-tab-selected` | `tab.activeBackground`, `tab.activeBorderTop` |
| `--scrollbar-thumb`, `--scrollbar-thumb-hover` | `scrollbarSlider.background`, `scrollbarSlider.hoverBackground` |
| `--danger`, `--warning`, `--info` | `errorForeground`, `editorWarning.foreground`, `editorInfo.foreground` |
| `--vcs-modified`, `--vcs-added`, `--vcs-deleted`, `--vcs-untracked`, `--vcs-ignored`, `--vcs-conflict` | `gitDecoration.modifiedResourceForeground`, `.addedResourceForeground`, `.deletedResourceForeground`, `.untrackedResourceForeground`, `.ignoredResourceForeground`, `.conflictingResourceForeground` |
| `--fg-editor` | `editor.foreground` |
| `--caret` | `editorCursor.foreground` |
| `--bg-current-line` | `editor.lineHighlightBackground` |
| `--bg-editor-selection`, `--bg-editor-selection-inactive` | `editor.selectionBackground`, `editor.inactiveSelectionBackground` |
| `--fg-line-number`, `--fg-line-number-current` | `editorLineNumber.foreground`, `editorLineNumber.activeForeground` |
| `--border-indent-guide`, `--border-indent-guide-active` | `editorIndentGuide.background1`, `editorIndentGuide.activeBackground1` |
| `--fg-whitespace` | `editorWhitespace.foreground` |
| `--bg-text-search-result`, `--bg-text-search-result-current` | `editor.findMatchHighlightBackground`, `editor.findMatchBackground` |
| `--bg-matched-brace` | `editorBracketMatch.background` |
| `--syn-bracket-1` … `--syn-bracket-3` (Rainbow brackets) | `editorBracketHighlight.foreground1` … `foreground3` |
| `--bg-identifier-under-caret`, `-write` | `editor.wordHighlightBackground`, `editor.wordHighlightStrongBackground` |
| `--wave-error`, `--wave-warning` | `editorError.foreground`, `editorWarning.foreground` |
| `--gutter-modified`, `--gutter-added`, `--gutter-deleted` | `editorGutter.modifiedBackground`, `.addedBackground`, `.deletedBackground` |
| `--fg-inlay`, `--bg-inlay` | `editorInlayHint.foreground`, `editorInlayHint.background` |
| `--ansi-*` | `terminal.ansiBlack` … `terminal.ansiBrightWhite` |

`tokenColors` → syntax tokens, by TextMate scope:

| OpenIDEA token | Scope |
|---|---|
| `--syn-keyword` | `keyword`, `storage.type`, `storage.modifier` |
| `--syn-string` | `string` |
| `--syn-escape` | `constant.character.escape` |
| `--syn-number` | `constant.numeric` |
| `--syn-constant` | `constant.language`, `variable.other.constant` |
| `--syn-comment`, `--syn-doc-comment` | `comment`, `comment.block.documentation` |
| `--syn-function`, `--syn-function-call` | `entity.name.function`, `meta.function-call` |
| `--syn-type` | `entity.name.type`, `entity.name.class`, `support.class` |
| `--syn-variable`, `--syn-param` | `variable`, `variable.parameter` |
| `--syn-property` | `variable.other.property`, `variable.other.member` |
| `--syn-builtin`, `--syn-predefined` | `support.function`, `support.variable` |
| `--syn-self` | `variable.language.self`, `variable.language.this` |
| `--syn-annotation`, `--syn-decorator` | `meta.decorator`, `storage.type.annotation` |
| `--syn-punct` | `punctuation`, `keyword.operator` |
| `--syn-tag`, `--syn-attribute` | `entity.name.tag`, `entity.other.attribute-name` |
| `--syn-regexp` | `string.regexp` |
| `--syn-markup-heading`, `--syn-markup-code`, `--syn-link` | `markup.heading`, `markup.inline.raw`, `markup.underline.link` |
| `--syn-invalid` | `invalid` |

A `fontStyle: "italic"` on comments maps to `"--syn-comment-style": "italic"`.

## Testing a theme

- Install it from disk (or as a dev plugin), apply it, and walk through: the
  Project tool window with a selection, the editor with a few languages, Search
  Everywhere, a popup menu, a tooltip, Settings, the terminal (`ls --color`),
  a diff, and the VCS colours in the Commit tool window.
- *Settings › Plugins* shows a load error (with the file and line) if the JSON
  or a value is invalid. *Reload* re-reads a dev plugin.
- Text should keep at least WCAG AA contrast (4.5:1) on its surfaces. The
  built-in themes are checked by `src/features/settings/__tests__/contrast.test.ts`.
- Repository checks (for changes to this repo): `pnpm vitest run scripts/theme`
  validates the template against tokens.css and keeps this reference current,
  and `cargo test -p ide-plugin` loads the template through the plugin host.

## Token reference

Generated from `src/styles/tokens.css` (the variables of its Islands Light
block, which redefines every colour token of Islands Dark). `pnpm gen:theme-docs`
regenerates it. The `scripts/theme` tests fail when it, or the template, misses
a token.

<!-- BEGIN GENERATED TOKEN REFERENCE: pnpm gen:theme-docs -->

222 themeable tokens: 116 in the UI theme file, 106 in the editor colour scheme file.

### Surfaces (UI theme)

| Token | Islands Dark | Islands Light |
|---|---|---|
| `--bg-app` | `#191a1c` | `#ffffff` |
| `--bg-elev` | `#212326` | `#f7f8f9` |
| `--bg-popup` | `#26282c` | `#ffffff` |
| `--bg-hover` | `#2e2f30` | `#ededed` |
| `--bg-selected` | `#2a4371` | `#d0dffe` |
| `--bg-selected-strong` | `#2e4d89` | `#bdd3ff` |
| `--bg-current-line` | `#1f2024` | `#f5f8fe` |
| `--bg-debug-line` | `#2a5091` | `#d4e2ff` |
| `--bg-backdrop` | `#26282c` | `#e9eaee` |
| `--bg-input` | `#191a1c` | `#ffffff` |

### Lines (UI theme)

| Token | Islands Dark | Islands Light |
|---|---|---|
| `--border` | `#26282c` | `#e9eaee` |
| `--border-popup` | `#33353b` | `#d1d3d9` |
| `--border-strong` | `#40434a` | `#d1d3d9` |
| `--border-window` | `#40434a` | `#d1d3d9` |
| `--control-off` | `#5f6269` | `#c3c5cb` |

### Text (UI theme)

| Token | Islands Dark | Islands Light |
|---|---|---|
| `--fg-strong` | `#dfe1e5` | `#000000` |
| `--fg-emphasis` | `#d1d3d9` | `#000000` |
| `--fg` | `#d1d3d9` | `#000000` |
| `--fg-secondary` | `#9fa2a8` | `#5f6269` |
| `--fg-muted` | `#8c8f95` | `#6c707e` |
| `--fg-subtle` | `#73767c` | `#73767c` |
| `--fg-faint` | `#5f6269` | `#9fa2a8` |
| `--fg-gutter` | `#4b5059` | `#aeb3c2` |
| `--fg-icon` | `#ced0d6` | `#6c707e` |

### Accent (UI theme)

| Token | Islands Dark | Islands Light |
|---|---|---|
| `--accent` | `#3871e1` | `#3871e1` |
| `--link` | `#71a1fe` | `#2f5eb9` |
| `--link-hover` | `#92b7ff` | `#2e4d89` |

### Charts (UI theme)

| Token | Islands Dark | Islands Light |
|---|---|---|
| `--chart-series` | `#e07a7c` | `#d9686a` |

### Status (UI theme)

| Token | Islands Dark | Islands Light |
|---|---|---|
| `--danger` | `#f57e84` | `#c54e58` |
| `--warning` | `#d59637` | `#a56906` |
| `--success` | `#6db083` | `#338555` |
| `--db-connected` | `#2fe02f` | `#00ff00` |
| `--db-connected-ring` | `#1d6b1d` | `#5b995b` |
| `--info` | `#548af7` | `#3871e1` |

### Vcs (UI theme)

| Token | Islands Dark | Islands Light |
|---|---|---|
| `--vcs-modified` | `#70aeff` | `#0033b3` |
| `--vcs-added` | `#73bd79` | `#067d17` |
| `--vcs-deleted` | `#6f737a` | `#6c707e` |
| `--vcs-untracked` | `#e88f89` | `#b23247` |
| `--vcs-ignored` | `#d69a6b` | `#8c4f00` |
| `--vcs-conflict` | `#de6a66` | `#de1b2e` |
| `--gutter-modified` | `#375fad` | `#88adf7` |
| `--gutter-added` | `#549159` | `#7fc784` |
| `--gutter-deleted` | `#868a91` | `#767a8a` |
| `--diff-modified` | `#385570` | `#c2d8f2` |
| `--diff-inserted` | `#294436` | `#bee6be` |
| `--diff-deleted` | `#484a4a` | `#d6d6d6` |

### Syntax (editor scheme)

| Token | Islands Dark | Islands Light |
|---|---|---|
| `--syn-keyword` | `#cf8e6d` | `#0033b3` |
| `--syn-string` | `#6aab73` | `#067d17` |
| `--syn-type` | `#bcbec4` | `#000000` |
| `--syn-function` | `#56a8f5` | `#00627a` |
| `--syn-function-call` | `#bcbec4` | `#080808` |
| `--syn-comment` | `#7a7e85` | `#8c8c8c` |
| `--syn-comment-style` | `normal` | `italic` |
| `--syn-doc-comment` | `#5f826b` | `#8c8c8c` |
| `--syn-docstring` | `#5f826b` | `#067d17` |
| `--syn-annotation` | `#b3ae60` | `#9e880d` |
| `--syn-decorator` | `#b3ae60` | `#9e880d` |
| `--syn-number` | `#2aacb8` | `#1750eb` |
| `--syn-punct` | `#bcbec4` | `#080808` |
| `--syn-variable` | `#bcbec4` | `#080808` |
| `--syn-param` | `#bcbec4` | `#080808` |
| `--syn-property` | `#c77dbb` | `#871094` |
| `--syn-constant` | `#c77dbb` | `#871094` |
| `--syn-builtin` | `#8888c6` | `#000080` |
| `--syn-self` | `#94558d` | `#94558d` |
| `--syn-keyword-arg` | `#aa4926` | `#660099` |
| `--syn-predefined` | `#b200b2` | `#b200b2` |
| `--syn-escape` | `#cf8e6d` | `#0037a6` |
| `--syn-regexp` | `#42c3d4` | `#264eff` |
| `--syn-tag` | `#d5b778` | `#0033b3` |
| `--syn-attribute` | `#bcbec4` | `#174ad4` |
| `--syn-todo` | `#8bb33d` | `#008dde` |
| `--syn-link` | `#548af7` | `#006dcc` |
| `--syn-markup-heading` | `#cf8e6d` | `#871094` |
| `--syn-markup-code` | `#6aab73` | `#067d17` |
| `--syn-invalid` | `#f75464` | `#f50000` |
| `--syn-inline-value` | `#868a91` | `#8c8c8c` |
| `--syn-rainbow-1` | `#6fafbd` | `#9b3b6a` |
| `--syn-rainbow-2` | `#d79b6e` | `#114d77` |
| `--syn-rainbow-3` | `#9fbf6b` | `#9c6a2c` |
| `--syn-rainbow-4` | `#c98bc6` | `#005910` |
| `--syn-rainbow-5` | `#8e9cf0` | `#bc5150` |
| `--syn-bracket-1` | `#e8c25b` | `#0431fa` |
| `--syn-bracket-2` | `#d78bd6` | `#319331` |
| `--syn-bracket-3` | `#4ea7f0` | `#7b3814` |

### Editor (editor scheme)

| Token | Islands Dark | Islands Light |
|---|---|---|
| `--fg-editor` | `#bcbec4` | `#080808` |
| `--caret` | `#ced0d6` | `#000000` |
| `--fg-line-number` | `#4b5059` | `#aeb3c2` |
| `--fg-line-number-current` | `#a1a3ab` | `#767a8a` |
| `--border-gutter` | `#26282c` | `#ebecf0` |
| `--border-indent-guide` | `#323438` | `#ebecf0` |
| `--border-indent-guide-active` | `#4e5157` | `#aeb3c2` |
| `--border-right-margin` | `#323438` | `#ebecf0` |
| `--bg-editor-selection` | `#214283` | `#a6d2ff` |
| `--bg-editor-selection-inactive` | `#1d3460` | `#c9e3ff` |
| `--bg-text-search-result` | `#114957` | `#fcd47e` |
| `--bg-text-search-result-current` | `#165e70` | `#f2bf57` |
| `--bg-matched-brace` | `#43454a` | `#93d9d9` |
| `--matched-brace-weight` | `var(--fw-code-bold)` | `inherit` |
| `--bg-matched-tag` | `#3f4045` | `#c9ecec` |
| `--bg-fold-placeholder` | `#393b40` | `#e9f5e6` |
| `--fg-fold-placeholder` | `#868991` | `#414d41` |
| `--fg-fold-marker` | `#6f737a` | `#8b8e94` |
| `--fg-whitespace` | `#6f737a` | `#b5b7bd` |
| `--fg-unused` | `#6f737a` | `#8c8c8c` |
| `--bg-identifier-under-caret` | `#373b39` | `#edebfc` |
| `--bg-identifier-under-caret-write` | `#402f33` | `#fce8f4` |
| `--fg-inlay` | `#868a91` | `#73767c` |
| `--bg-inlay` | `#393b40` | `#00000012` |
| `--wave-error` | `#fa6675` | `#f50000` |
| `--wave-warning` | `#f2c55c` | `#f2bf57` |
| `--editor-error-decoration` | `underline wavy #fa6675` | `underline wavy #f50000` |
| `--editor-warning-decoration` | `underline wavy #f2c55c` | `none` |
| `--editor-warning-background` | `transparent` | `#fcf4d4` |
| `--bg-breakpoint-line` | `#40252b` | `#faeae6` |
| `--fg-completion-match` | `#538af9` | `#2f5eb9` |
| `--bg-editor-inline` | `#212326` | `#f7f8f9` |
| `--bg-editor-banner` | `#233558` | `#f7f8ff` |
| `--fg-weak-warning` | `#6f737a` | `#a8adbd` |
| `--fg-bulb` | `#f2c55c` | `#ffaf0f` |

### ANSI palette (editor scheme)

| Token | Islands Dark | Islands Light |
|---|---|---|
| `--ansi-black` | `#000000` | `#000000` |
| `--ansi-red` | `#f0524f` | `#e5372a` |
| `--ansi-green` | `#5c962c` | `#367a29` |
| `--ansi-yellow` | `#a68a0d` | `#ad8d2b` |
| `--ansi-blue` | `#3993d4` | `#3866d1` |
| `--ansi-magenta` | `#a771bf` | `#a33cae` |
| `--ansi-cyan` | `#00a3a3` | `#3c8b8d` |
| `--ansi-white` | `#808080` | `#8b8e94` |
| `--ansi-bright-black` | `#595959` | `#73767c` |
| `--ansi-bright-red` | `#ff4050` | `#f05046` |
| `--ansi-bright-green` | `#4fc414` | `#2e9b3f` |
| `--ansi-bright-yellow` | `#e5bf00` | `#b58e00` |
| `--ansi-bright-blue` | `#1fb0ff` | `#3d82f0` |
| `--ansi-bright-magenta` | `#ed7eed` | `#c04bcf` |
| `--ansi-bright-cyan` | `#00e5e5` | `#1b9ea3` |
| `--ansi-bright-white` | `#ffffff` | `#5f6269` |

### Terminal ANSI palette (editor scheme)

| Token | Islands Dark | Islands Light |
|---|---|---|
| `--terminal-ansi-black` | `#000000` | `#000000` |
| `--terminal-ansi-red` | `#f27481` | `#c93645` |
| `--terminal-ansi-green` | `#6bcc62` | `#357d1f` |
| `--terminal-ansi-yellow` | `#e0ce70` | `#b2a400` |
| `--terminal-ansi-blue` | `#5594fa` | `#225cd6` |
| `--terminal-ansi-magenta` | `#c092fa` | `#6e32e5` |
| `--terminal-ansi-cyan` | `#47ccbd` | `#007a80` |
| `--terminal-ansi-white` | `#ced0d6` | `#bec0c5` |
| `--terminal-ansi-bright-black` | `#4e5157` | `#6c707e` |
| `--terminal-ansi-bright-red` | `#ff6b7a` | `#ff5462` |
| `--terminal-ansi-bright-green` | `#67ff59` | `#3dcc3d` |
| `--terminal-ansi-bright-yellow` | `#ffec1a` | `#d4bb00` |
| `--terminal-ansi-bright-blue` | `#3399ff` | `#009dff` |
| `--terminal-ansi-bright-magenta` | `#d970ff` | `#d659ff` |
| `--terminal-ansi-bright-cyan` | `#40ffe9` | `#31c4b3` |
| `--terminal-ansi-bright-white` | `#ffffff` | `#d2d4d9` |

### Shadows and window controls (UI theme)

| Token | Islands Dark | Islands Light |
|---|---|---|
| `--shadow-popup` | `0 6px 20px rgba(0, 0, 0, 0.45)` | `0 6px 20px rgba(0, 0, 0, 0.12)` |
| `--shadow-dialog` | `0 0 0 0.5px rgba(0, 0, 0, 0.6), 0 10px 24px rgba(0, 0, 0, 0.35), 0 24px 72px rgba(0, 0, 0, 0.45)` | `0 0 0 0.5px rgba(0, 0, 0, 0.1), 0 10px 24px rgba(0, 0, 0, 0.1), 0 24px 72px rgba(0, 0, 0, 0.2)` |
| `--traffic-close` | `#ff5f57` | `#ff5f57` |
| `--traffic-close-border` | `#e0443e` | `#e0443e` |
| `--traffic-close-pressed` | `#bf4942` | `#bf4942` |
| `--traffic-glyph` | `#4d0000` | `#4d0000` |
| `--traffic-off` | `#4b4c4f` | `#dddddd` |
| `--traffic-off-border` | `#404144` | `#c8c8c8` |

### Additive (UI theme)

| Token | Islands Dark | Islands Light |
|---|---|---|
| `--bg-tooltip` | `#33353b` | `#ffffff` |
| `--fg-tooltip` | `#d1d3d9` | `#000000` |
| `--border-tooltip` | `#33353b` | `#d1d3d9` |
| `--bg-control` | `#26282c` | `#ffffff` |
| `--bg-control-hover` | `#33353b` | `#f7f8f9` |
| `--bg-active` | `#40434a` | `#dddfe4` |
| `--bg-scrim` | `rgba(0, 0, 0, 0.45)` | `rgba(0, 0, 0, 0.16)` |
| `--fg-on-accent` | `#ffffff` | `#ffffff` |
| `--shadow-tooltip` | `0 4px 12px rgba(0, 0, 0, 0.4)` | `0 4px 12px rgba(0, 0, 0, 0.12)` |
| `--shadow-balloon` | `0 8px 24px rgba(0, 0, 0, 0.45)` | `0 8px 24px rgba(0, 0, 0, 0.14)` |

### Islands contract (UI theme)

| Token | Islands Dark | Islands Light |
|---|---|---|
| `--bg-frame` | `#26282c` | `#e9eaee` |
| `--bg-island` | `#191a1c` | `#ffffff` |
| `--bg-stripe-hover` | `#ffffff17` | `#00000012` |
| `--bg-stripe-selected` | `#ffffff29` | `#00000020` |
| `--fg-stripe-selected-active` | `#ffffff` | `#ffffff` |
| `--fg-stripe-label` | `#9fa2a8` | `#5f6269` |
| `--bg-tab-selected` | `#233558` | `#e3ebfe` |
| `--border-tab-selected` | `#2e4d89` | `#a7c5ff` |
| `--bg-tab-selected-inactive` | `#26282c` | `#e9eaee` |
| `--border-tab-selected-inactive` | `#40434a` | `#d1d3d9` |
| `--bg-tab-hover` | `#ffffff17` | `#00000012` |
| `--border-editor-tabs` | `#26282c` | `#e9eaee` |
| `--bg-tree-selected` | `#2a4371` | `#d0dffe` |
| `--bg-tree-selected-inactive` | `#33353b` | `#e9eaee` |
| `--bg-tree-hover` | `#ffffff10` | `#00000008` |
| `--bg-toolbar-hover` | `#ffffff17` | `#00000012` |
| `--bg-toolbar-pressed` | `#ffffff29` | `#00000020` |
| `--bg-toolbar-selected` | `#2e4d89` | `#d0dffe` |
| `--bg-toolbar-selected-hover` | `#2f5eb9` | `#bdd3ff` |
| `--bg-button-primary-hover` | `var(--accent-hover)` | `var(--accent-hover)` |
| `--fg-button-primary` | `#ffffff` | `#ffffff` |
| `--bg-button` | `transparent` | `#ffffff` |
| `--border-button` | `#40434a` | `#d1d3d9` |
| `--bg-field` | `#191a1c` | `#ffffff` |
| `--bg-checkbox` | `#191a1c` | `#ffffff` |
| `--border-checkbox` | `#5f6269` | `#a8adbd` |
| `--bg-toggle-on` | `#338555` | `#4e9d6c` |
| `--fg-toggle-on` | `#ffffff` | `#ffffff` |
| `--bg-toggle-off` | `#191a1c` | `#f7f8f9` |
| `--fg-toggle-off` | `#73767c` | `#73767c` |
| `--border-toggle` | `#5f6269` | `#c3c5cb` |
| `--bg-toggle-knob` | `#5f6269` | `#c3c5cb` |
| `--focus-ring-soft` | `#3d6185` | `#97c3f3` |
| `--scrollbar-thumb` | `#ffffff33` | `#00000033` |
| `--scrollbar-thumb-hover` | `#ffffff59` | `#00000080` |
| `--bg-search-match` | `#ba9752` | `#fee6b1` |
| `--bg-search-match-current` | `#f2c55c` | `#fcd47e` |
| `--fg-search-match` | `#191a1c` | `#000000` |
| `--bg-dialog` | `#191a1c` | `#f7f8f9` |
| `--bg-popup-inline` | `#26282c` | `#f7f8f9` |
| `--bg-popup-advertiser` | `#26282c` | `#f7f8f9` |
| `--bg-feedback-info` | `#233558` | `#f7f8ff` |
| `--border-feedback-info` | `#2e4d89` | `#bdd3ff` |
| `--bg-feedback-error` | `#56272b` | `#fff6f5` |
| `--border-feedback-error` | `#80383e` | `#ffc4c5` |
| `--bg-feedback-warning` | `#44321d` | `#fff6e9` |
| `--border-feedback-warning` | `#694820` | `#f4cd9a` |
| `--bg-feedback-success` | `#203b2a` | `#f5faf3` |
| `--border-feedback-success` | `#29583c` | `#bbdbc2` |
| `--bg-counter` | `#73767c` | `#8b8e94` |
| `--fg-counter` | `#000000` | `#ffffff` |
| `--bg-progress-track` | `#40434a` | `#dddfe4` |

<!-- END GENERATED TOKEN REFERENCE -->
