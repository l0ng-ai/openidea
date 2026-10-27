# Theme plugin template

A complete OpenIDEA theme plugin with one worked example, **Harbor Night**: a
dark theme with slate surfaces, a teal accent and a warm syntax palette. Copy
this folder to start your own theme. Full documentation, the token reference
and porting guides are in [`docs/plugins/themes.md`](../../docs/plugins/themes.md).

```
theme-plugin/
├─ plugin.toml                          # manifest: id, name, version, the theme files
└─ themes/
   ├─ harbor-night.theme.json           # UI colours, every themeable token, grouped like tokens.css
   └─ harbor-night.scheme.json          # editor colour scheme: syntax, editor, ANSI colours
```

A theme plugin is data only: no code, no WebAssembly, no build step.

## Make your own

1. Copy the folder, for example to `~/openidea-themes/theme-my-theme`.
2. In `plugin.toml`, change `id` (lowercase, `a-z 0-9 - _`), `name`,
   `description`, `authors` and the two paths.
3. Rename the theme files. In the theme file, set `id`, `name` and `kind`
   (`"dark"` or `"light"`, the built-in base for anything you leave out).
4. Edit the colours. Each key is a CSS variable from `src/styles/tokens.css`,
   and the reference in the docs gives the Islands Dark and Light values.
   Comments (`//`, `/* */`) are allowed. Delete a line to keep the built-in value.

Porting an IntelliJ theme? `pnpm theme:import-intellij <file.theme.json> [file.icls] --out <dir>`
in the OpenIDEA repository generates a package in this layout.

## Package and install

The folder is the package. To share it, publish the folder as a Git repository
or a zip that users extract.

1. In OpenIDEA open **Settings › Plugins**, click the gear menu and choose
   **Install Plugin from Disk…** (or run the *Install Plugin from Disk…*
   action), then pick the folder that contains `plugin.toml`.
2. Select the plugin in the *Installed* tab and press **Apply** next to the theme.
3. **Use Default Theme** in the same place goes back to the built-in theme.

## Iterate

Put (or symlink) the folder in `<project>/.openidea/plugins/` of an open
project. It loads as a *dev* plugin, and **Reload** in Settings › Plugins (or
the *Reload Plugins* action) re-reads your edits without reinstalling. Invalid
JSON or values are reported in Settings › Plugins with the file and line.

## Licence

The template and Harbor Night are part of OpenIDEA (Apache-2.0). When you port
someone else's theme, keep its licence and credit its authors.
