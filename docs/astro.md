# Astro

OpenIDEA recognizes `.astro` files automatically, with an Astro file icon and
language entry in the status bar. The editor lazily loads an Astro CodeMirror mode for TypeScript
frontmatter, HTML, component tags, JSX/TypeScript expressions, scripts and CSS.
Commenting, indentation, folding and bracket matching use the editor's existing
language support. Custom file associations still take precedence.

## Language server

Install your project's dependencies, then open an `.astro` file. If the official
`@astrojs/language-server` is missing, use the installation notification or open
**Settings › Languages & Frameworks › Language Servers**, select **Astro Language
Server**, and click **Install**. Installation is explicit, just as for other
languages. OpenIDEA installs the server and `typescript@6` into its managed tools
directory; it does not add dependencies to your project.

Node.js and npm (or a supported package manager) are required for installation.
Node.js is also required to run the server. Use a Node.js version supported by
your Astro project (Node.js 22 is suitable for the fixture). You can select the
runtime in **Settings › Languages & Frameworks › Node.js**. Missing Node.js or a
TypeScript language-service library produces an actionable server error.

You can instead install the tools locally:

```sh
npm install --save-dev @astrojs/language-server typescript@6
```

OpenIDEA prefers `node_modules/.bin/astro-ls` in the server workspace or its
ancestors within the opened project, then searches its usual managed/system
tool path. An explicitly configured executable takes precedence. A global
installation also works:

```sh
npm install --global @astrojs/language-server typescript@6
```

The built-in command is **astro-ls**, with arguments **--stdio**. Settings exposes
the normal executable, arguments, environment, initialization options, workspace
configuration and enable switch, with the existing global/project scopes.
**Astro** is also available in **Add Language Server › Languages**.

The server receives language ID `astro`, the workspace root, and ordinary LSP
document synchronization. It is started only for Astro documents and shares the
existing per-workspace server lifecycle, restart and shutdown controls. HTML's
server does not attach to Astro documents unless a user explicitly changes their
association or server configuration.

## TypeScript and project dependencies

Astro requires `initializationOptions.typescript.tsdk` to point to a TypeScript
`lib` directory containing `typescript.js` or `tsserverlibrary.js`. OpenIDEA
resolves it in this order:

1. An explicit Astro server `typescript.tsdk` initialization option, or the
   version selected in **Settings › Languages & Frameworks › TypeScript**.
2. The workspace's TypeScript installation, searching ancestors within the
   opened project (including a hoisted workspace installation).
3. TypeScript installed alongside the managed or global Astro server.

Use an absolute directory for an explicit `typescript.tsdk` initialization
option. An invalid selected SDK is reported rather than silently replaced.
TypeScript 5 and 6 provide the required JavaScript language-service API;
TypeScript 7's native compiler does not. The managed installer pins TypeScript
to major version 6 for this reason.

The official server reads the project's `tsconfig.json`, Astro installation and
dependencies. Install these in the project; installing a managed language server
does not install Astro for you. Open the Astro package as the project root when
working with an independent nested package whose tools are not hoisted.

## Features and formatting

The official server supplies completion, diagnostics, hover, definitions,
references, rename, document symbols, signature help, code actions and semantic
tokens through OpenIDEA's shared LSP client. Availability depends on the server's
capabilities and the project. A diagnostic does not always have a quick fix.

For formatting, the official server requires project-local Prettier and its
Astro plugin:

```sh
npm install --save-dev prettier prettier-plugin-astro
```

Add `"prettier-plugin-astro"` to your Prettier configuration's `plugins` array.
Use the normal Reformat action or format-on-save. No separate formatter or LSP
client is started for Astro.

## Validation fixture and parser maintenance

[`fixtures/astro-app`](../fixtures/astro-app) contains a layout, mixed-language
page and formatter configuration. Copy it outside this checkout and run
`npm install`. The opt-in real-server regression test runs against that copy:

```sh
OPENIDEA_TEST_ASTRO_PROJECT=/absolute/path/to/astro-app \
  cargo test -p ide-lsp --test real_servers astro_language_server_end_to_end -- --ignored
```

The editor uses `@fazelstudio/codemirror-lang-astro` 0.2.0 (MIT), with a pnpm
patch in `patches/` to preserve resumable HTML parsing and reuse unchanged Lezer
tree fragments, parse TypeScript expressions/scripts, and read script attributes
from their containing tag. The existing parser still scans the source to mask
Astro regions; it does not incrementally scan that mask. Astro directives use
ordinary HTML attribute colors. Regression tests cover the supplied fixture,
language boundaries, highlighting after edits, actual subtree reuse, and
unaffected HTML, TypeScript, JavaScript, CSS, Vue and Angular modes.
