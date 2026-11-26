---
name: OpenIDEA
description: The IDE you know, rebuilt in Rust.
colors:
  workbench-blue: "#3871e1"
  link-blue: "#2f5eb9"
  frame-grey: "#e9eaee"
  island-white: "#ffffff"
  raised-paper: "#f7f8f9"
  ink: "#000000"
  ink-secondary: "#5f6269"
  ink-muted: "#6c707e"
  ink-faint: "#9fa2a8"
  hairline: "#e9eaee"
  control-edge: "#d1d3d9"
  selection-wash: "#d0dffe"
  tab-wash: "#e3ebfe"
  danger: "#c54e58"
  warning: "#a56906"
  success: "#338555"
  frame-grey-dark: "#26282c"
  island-dark: "#191a1c"
  ink-dark: "#d1d3d9"
  ink-strong-dark: "#dfe1e5"
  ink-muted-dark: "#8c8f95"
  control-edge-dark: "#40434a"
  selection-wash-dark: "#2a4371"
typography:
  title:
    fontFamily: "Inter Variable, Inter, system-ui, -apple-system, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "Inter Variable, Inter, system-ui, -apple-system, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "Inter Variable, Inter, system-ui, -apple-system, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
  label-tiny:
    fontFamily: "Inter Variable, Inter, system-ui, -apple-system, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.4
  input-large:
    fontFamily: "Inter Variable, Inter, system-ui, -apple-system, sans-serif"
    fontSize: "15px"
    fontWeight: 400
  code:
    fontFamily: "JetBrains Mono, JetBrains Mono Variable, ui-monospace, Menlo, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "22px"
    fontFeature: "\"liga\" 0"
rounded:
  small: "4px"
  control: "4px"
  row: "4px"
  selection: "5px"
  tab: "6px"
  toolbar-button: "6px"
  tooltip: "6px"
  popup: "8px"
  island: "10px"
  popup-large: "10px"
  dialog: "10px"
spacing:
  space-0-5: "2px"
  space-1: "4px"
  space-1-5: "6px"
  space-2: "8px"
  space-3: "12px"
  space-4: "16px"
components:
  button-primary:
    backgroundColor: "{colors.workbench-blue}"
    textColor: "{colors.island-white}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "28px"
  button-secondary:
    backgroundColor: "{colors.island-white}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "28px"
  button-ghost:
    textColor: "{colors.ink-secondary}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 8px"
    height: "28px"
  icon-button:
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.toolbar-button}"
    size: "24px"
  icon-button-selected:
    backgroundColor: "{colors.selection-wash}"
    textColor: "{colors.ink}"
    rounded: "{rounded.toolbar-button}"
    size: "24px"
  input:
    backgroundColor: "{colors.island-white}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 8px"
    height: "28px"
  chip:
    textColor: "{colors.ink-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.toolbar-button}"
    padding: "0 6px"
    height: "22px"
  tooltip:
    backgroundColor: "{colors.island-white}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.tooltip}"
    padding: "6px 10px"
  list-row-selected:
    backgroundColor: "{colors.selection-wash}"
    textColor: "{colors.ink}"
    rounded: "{rounded.row}"
    height: "24px"
---

# Design System: OpenIDEA

## Overview

**Creative North Star: "The Quiet Workbench"**

The interface is a workbench, not a showroom. Code, trees, logs and diffs are the work. The chrome around them stays quiet, so the eye goes to the content and a long session stays calm.

The visual language is the JetBrains new UI in its **Islands** form, and this document records it rather than inventing one. The tokens in `src/styles/tokens.css` take their values from the Islands Light and Islands Dark theme JSON and editor schemes, at 100% zoom. Component metrics follow the matching IntelliJ theme keys (a Swing `arc` is a diameter, so the CSS radius is half of it), and component CSS names the key it follows. Behaviour follows IDEA as well, from focus and selection to dialogs and drag and drop. Users bring their JetBrains muscle memory, so a layout, metric or state that looks or behaves differently from IDEA counts as a bug, not a style choice.

Every panel sits on a grey frame as a rounded island (10px corners, 6px gaps). Depth comes from that tonal step, not from decoration. The density is that of a professional desktop tool: 13px UI text, 24px rows, 28px controls, with a compact mode that tightens all of them.

The tokens are a theming contract, not one palette. The built-in themes are Islands Light (the default), Islands Dark, High Contrast, Solarized Light and Solarized Dark. Users can also change the accent colour, give tool windows a different background from the editor, set a background image, use contrast scrollbars, or adjust colours for red-green vision deficiency. Imported IntelliJ themes and plugin themes set the same tokens at runtime. A component that looks right only in Islands Light is broken.

Expression is kept to precise details: one blue accent, controls with no frame until they're hovered, hairline frames on fields and secondary buttons, and fast state transitions. Three things are rejected outright. It must not look like a web app: no big rounded cards, airy marketing whitespace, decorative gradients or illustrations. It has no second accent colour. And it has no eye-catching animation.

### Named Rules

**The IDEA Reference Rule.** When tokens and this document don't answer a question, the answer is what IntelliJ IDEA does in the Islands theme, with the same metric and the same state behaviour. Take the value from the theme key, add it as a token, and name the key in a CSS comment.

**Key Characteristics:**

- JetBrains new UI (Islands): metrics and behaviour follow IntelliJ's theme keys.
- Grey frame, rounded content islands, tonal layering only.
- A single accent (Workbench Blue) for primary actions, focus, selection and the active tool window.
- High density on a 4px grid. Compact mode is a first-class variant.
- Controls are quiet at rest: toolbar buttons and chips have no frame until hover.
- Semantic colour (status, VCS, diff, syntax) carries meaning and is never decoration.
- Every colour and metric is a token in `src/styles/tokens.css`. Tokens are the public theme API for plugins.

## Colors

A near-neutral grey ramp with one cool blue accent. Status, VCS and syntax colours are functional vocabularies with fixed meanings. Values in the frontmatter are Islands Light (the default), and `-dark` keys are the Islands Dark counterparts. High Contrast, the Solarized themes, imported IntelliJ themes and plugin themes override the same tokens, so the names describe roles, not hexes.

### Project colour

- **Project wash** (`--project-color`): a radial tint of the project's colour (22% strength, 600 × 300px) that fades in from the frame's top-left corner, as the IDEA project gradient does. It identifies the project window. It is the one gradient in the chrome.

### Primary

- **Workbench Blue** (`--accent`): primary buttons, the focus ring, the selected-and-active stripe button, and search-match emphasis. The appearance setting can override it, so components reference `--accent`, never the hex.
- **Link Blue** (`--link`): inline links. In Dark it lightens to stay readable on the dark islands.

### Neutral

- **Frame Grey** (`--bg-frame`): the window frame behind the islands, and the stripes (the tool window button bars).
- **Island White** (`--bg-island`, `--bg-app`): editor and tool window surfaces. This is where the work lives.
- **Raised Paper** (`--bg-elev`, `--bg-dialog`): dialog bodies and inline popups, one tonal step off the island.
- **Ink** (`--fg`, `--fg-strong`): primary text. **Ink Secondary / Muted / Faint** (`--fg-secondary`, `--fg-muted`, `--fg-faint`): metadata, icons and placeholders, then disabled text.
- **Hairline** (`--border`): dividers between regions inside an island. **Control Edge** (`--border-button`, `--border-strong`): the 1px inset frame of fields and secondary buttons.
- **Selection Wash** (`--bg-tree-selected`, `--bg-selected`, `--bg-toolbar-selected`): the selected row in focused trees and lists, and pressed-on toolbar toggles. When the tree loses focus, the selection drops to the neutral `--bg-tree-selected-inactive`.

### Functional vocabularies

- **Status:** `--danger`, `--warning`, `--success` and `--info`, each with `--bg-feedback-*` and `--border-feedback-*` pairs for banners.
- **VCS and diff:** `--vcs-*` for file status in trees and tabs, `--gutter-*` for gutter marks, and `--diff-*` for diff fills and their error-stripe marks.
- **Syntax:** `--syn-*`, from the editor colour scheme. Users and plugins replace these per scheme.

### Named Rules

**The One Accent Rule.** Workbench Blue is the only accent. Every other hue in the UI belongs to a functional vocabulary (status, VCS, diff, syntax, charts) and means something specific. If a new colour has no meaning to carry, it doesn't ship.

**The Token Only Rule.** Components never contain hex, `rgb()` or named colour literals. A new colour is a new token with a value in every theme variant, named for its purpose. Run `pnpm gen:theme-docs` afterwards.

## Typography

**UI Font:** Inter Variable (with system-ui and -apple-system fallbacks)
**Code Font:** JetBrains Mono (with ui-monospace and Menlo fallbacks)
**Key Glyph Font:** the system UI font (`--font-keys`), so shortcut glyphs such as ⌘⇧⌥⌃↵ render as they do in native menus

**Character:** a neutral sans for chrome and a coding mono for content. Neither performs. Hierarchy comes from weight and colour, not size.

### Hierarchy

- **Title** (600, 13px, 1.4): tool window titles, section headers, dialog titles and emphasised names. Weight 600 is the system's main emphasis.
- **Body** (400, 13px, 1.4): default UI text, menus, tree and list rows, and buttons.
- **Label** (400, 12px): the most common size. It covers secondary metadata, chips, status bar items, table cells and hints.
- **Label Tiny** (400, 11px): stripe labels, counters and badges.
- **Input Large** (400, 15px): Search Everywhere and similar large query fields.
- **Code** (400, 13px, 22px line height): the editor, console, terminal and every monospace preview. Ligatures are off by default and follow the `editor.ligatures` setting. Users set the weights (`--fw-code`, `--fw-code-bold`) and the size.

### Named Rules

**The Flat Scale Rule.** The UI uses 11, 12, 13 and 15px, and nothing in between. Emphasis is weight 600 or a stronger ink colour, not a bigger size.

**The User Owns Size Rule.** Sizes are tokens because users change them (UI font size, editor font, compact mode's -1px chrome offset). Never hard-code a font size.

## Layout

The window is a grey frame holding docked islands: the editor in the centre, tool windows around it, stripes of tool window buttons on the edges (58px wide), a titlebar with the main toolbar (40px), and a status bar (30px). The status bar sits directly on the frame with no divider. Islands sit 6px apart and have 10px corners. Trees are inset 6px inside their island.

Spacing follows a 4px grid (`--space-0-5` to `--space-4`, 2–16px). It is used for gaps, with component heights doing most of the rhythm work: rows 24px, fields and buttons 28px, small controls 24px or 20px, tabs 28px in a 38px tab bar, and tool window headers 40px.

**Compact mode** (`data-compact`) is a full variant, not an afterthought. Rows drop to 22px, fields and buttons to 24px, the titlebar and headers to 32px, the status bar to 24px, the island gap to 4px and island corners to 8px, and chrome text gets 1px smaller. Every layout must hold in both modes.

The app is a desktop window. It is never a scrolling page: the document never scrolls, and every scroll region is its own scroller inside an island. Dialogs open about 10vh from the top and below the titlebar. Wide reading surfaces, such as an agent conversation, cap their width (900px) inside the island.

## Elevation & Depth

Static layout is flat and layered by tone. The grey frame sits under white islands (in Dark, a lighter frame under darker islands). Shadows exist only on surfaces that float above the layout: popups, menus, dialogs, tooltips, balloons, undocked tool windows and drag ghosts. Dialogs use a window-style shadow, because they are separate windows in spirit.

### Shadow Vocabulary

- **Popup** (`--shadow-popup`; Light `0 6px 20px rgba(0,0,0,0.12)`): popups, menus, completion and the floating editor toolbar.
- **Dialog** (`--shadow-dialog`): a hairline ring plus two soft drops, like a native window shadow.
- **Tooltip** (`--shadow-tooltip`) and **Balloon** (`--shadow-balloon`): small and medium drops for hover help and notifications.

### Named Rules

**The Flat at Rest Rule.** No docked panel, island, row or control gets a shadow. A shadow means "this floats over the workbench and will go away". Depth inside the layout is only ever a tonal step.

## Shapes

Corners scale with the size of the surface. Small controls get 4px (buttons, fields, combos, rows, small icon buttons). Toolbar buttons, chips, tabs and tooltips get 6px, and selection highlights get 5px. Popups get 8–10px, and islands and dialogs get 10px. Compact mode tightens island corners to 8px and combo corners to 2px. Frames are drawn as 1px inset box-shadows rather than borders, so they never shift layout and can double on focus. There are no pills, circles (apart from macOS window buttons and status dots), or rounding beyond 10px.

## Components

Quiet and dependable. Components don't call attention to themselves, they behave the same everywhere, and they come from `src/ui/` primitives before anything custom.

### Buttons

- **Shape:** gently rounded (4px). Minimum width 72px, 28px tall, 16px horizontal padding. The small variant is 24px tall with 10px padding.
- **Primary:** Workbench Blue fill with white text. Hover mixes it toward the strong ink colour (`--accent-hover`). Use it for one default action per dialog.
- **Secondary:** island-coloured with a 1px Control Edge inset frame. Hover darkens the fill by about 6%.
- **Ghost:** no fill or frame, secondary ink colour, 8px padding. Hover shows the toolbar hover wash and strong ink. Pressed is a stronger wash.
- **Focus:** a 2px Workbench Blue outline, 1px outside the button. **Disabled:** transparent fill, faint text and a hairline frame.
- **Motion:** background, colour and frame change over 80ms (`--dur-fast`) with `--ease`. There are no transitions under `prefers-reduced-motion`, and forced-colours mode gets a real border.

### Icon Buttons (toolbar actions)

- 20, 24 or 28px square, with 6px corners (4px at 20px). The icon is muted at rest.
- Hover shows the toolbar hover wash (`--bg-toolbar-hover`, a translucent ink) across the full hit target, and the icon turns strong ink. Pressed shows `--bg-toolbar-pressed`.
- A toggled-on button (`aria-pressed`) shows Selection Wash. The focus ring is drawn 2px inside the button.
- Tone variants (`danger`, `accent`) recolour only the icon.

### Chips

- **Style:** flat, like the main toolbar's project and branch widgets. They are 22px tall with 6px corners, have no fill or frame at rest, and use 12px secondary ink with a muted icon.
- **State:** a chip that opens a picker gets the toolbar hover wash. A read-only chip never changes on hover.

### Inputs / Fields

- **Style:** 28px tall with 8px horizontal padding and 4px corners. Island fill with a 1px Control Edge inset frame. Placeholders use the faint ink.
- **Focus:** the frame turns Workbench Blue and doubles with a 1px outer ring, drawn entirely with box-shadow.
- **Error:** the same doubled ring in `--danger`. **Disabled:** transparent fill, faint text and a hairline frame.
- Search fields have a muted leading icon. Monospace fields use the code font.

### Lists and Trees

- Rows are 24px (22px compact). The selection is a 4–5px rounded wash inset from the island edge, not a full-bleed bar.
- A focused selection uses Selection Wash, and an unfocused one drops to a neutral grey. Hover is a faint translucent wash. Search matches use `--bg-search-match`.

### Popups, Menus and Dialogs

- **Popups and menus:** `--bg-popup` with a 1px popup frame, 10px corners (`--radius-popup-large`) and the popup shadow.
- **Dialogs:** Raised Paper body with 10px corners and the dialog shadow. They behave like IDEA's dialogs, which are separate windows: the modal layer blocks the workbench but never dims it. The footer actions are right-aligned buttons. Focus returns to wherever it came from when the dialog closes.

### Tabs

- 28px tabs (24px compact) in a 38px bar, with 6px corners and 8px horizontal padding.
- As in IDEA, only the part holding focus accents its selected tab (`--bg-tab-selected` with `--border-tab-selected`). Elsewhere the selected tab drops to the neutral inactive pair.
- **Tooltips:** 6px corners with 6px × 10px padding, using `--bg-tooltip` (white in Light, dark grey in Dark) and the tooltip shadow.

### Tool Window Stripes (signature)

The edge bars of tool window buttons are 58px wide on Frame Grey, with icons over 11px labels. Hover and selected states are translucent ink washes. The selected button of the active tool window fills with Workbench Blue and white content. This is the one place the accent fills a large shape in the chrome, and it marks the active tool window.

## Do's and Don'ts

### Do:

- **Do** match IntelliJ IDEA's Islands theme for any metric or state that isn't tokenized yet. Take the value from the theme key and name the key in a CSS comment (for example `Button.arc 8 (radius 4)`).
- **Do** take every colour and metric from `src/styles/tokens.css`, and add a token for every theme variant when you need a new one.
- **Do** separate regions with a tonal step (frame against island) or a 1px hairline, never with a shadow.
- **Do** keep toolbar buttons and chips without a frame at rest, with the toolbar hover wash over the full hit target.
- **Do** draw frames and focus rings as inset box-shadows (1px at rest, doubled on focus), and keep the 2px Workbench Blue focus outline visible.
- **Do** check every surface in Islands Light and Islands Dark at least, as the contribution guidelines require. Check High Contrast and compact density whenever a change touches colour or metrics.
- **Do** keep transitions to state changes: 80ms (`--dur-fast`), 140ms (`--dur`) or at most 220ms (`--dur-slow`) with `--ease`, and none under reduced motion.
- **Do** use icons from the `src/ui/icons.tsx` registry, drawn in `currentColor`.

### Don't:

- **Don't** make it look like a web app: no large rounded cards, airy marketing whitespace, decorative gradients, hero illustrations or corners above 10px. The project wash is the one gradient in the chrome. Progress shimmer counts as activity, not decoration.
- **Don't** invent a look or behaviour where IDEA already has one. A custom variant of an IDEA pattern breaks muscle memory.
- **Don't** add a second accent. Any hue other than Workbench Blue must carry status, VCS, diff, syntax or chart meaning.
- **Don't** add attention-seeking animation: no bounces, no staggered entrances, and no state transition over 220ms. Looping animation is only for activity that is really happening (spinners, progress, loading shimmer, a running pulse, the caret), never decoration.
- **Don't** put shadows on docked panels, islands, rows or controls.
- **Don't** use sizes off the 11/12/13/15px scale, or hard-code a font size users can change.
- **Don't** use hex, `rgb()` or named colours in component CSS or inline styles.
- **Don't** use emoji as icons or decoration, or inline ad-hoc SVG in a feature.
