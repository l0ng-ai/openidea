---
name: openidea-ide
description: Work on a project that is open in the OpenIDEA IDE through its MCP server (the `openidea` tools). Use it to read, search, navigate, refactor, check, build and run code with the IDE's language servers, index and run configurations instead of shell tools.
---

# Working through OpenIDEA

OpenIDEA's MCP server (`openidea`, or `openidea-dev` for development builds) exposes the
project open in the IDE: its files including unsaved editor changes, the project index,
the language servers, run configurations, the terminal and git. Prefer these tools over
shell commands when the IDE can answer: results match what the user sees in the IDE.

## Choosing the project

- Every tool takes an optional `projectPath`. Without it, calls go to the project in the
  focused window, or the only open one. When several projects are open, pass the project
  root (or any path inside it).
- Paths are project-relative unless absolute. Reading outside the project asks the user.

## Positions

Lines and columns are 1-based; columns count UTF-16 code units, as editors do.

## Reading and finding

- `read_file` returns numbered lines (`<line>\t<text>`), with `offset` / `limit` paging.
- `list_directory_tree` shows the layout without ignored and excluded files.
- `search_file` finds files by glob or name; `search_text` and `search_regex` search
  contents like Find in Files; `search_symbol` finds classes, functions and other
  declarations in the project index.
- `get_symbol_info` gives the signature, docs and declaration of the symbol at a position;
  `analyze_calls` shows callers and callees.
- `get_project_modules` and `get_project_dependencies` describe the build structure;
  `get_repositories` and `git_status` the version control state.

## Changing code

- Edit with `apply_patch` (`*** Begin Patch` ... `*** End Patch`, the same format as the
  apply_patch tool) and create files with `create_new_file`. Edits go through the IDE's
  documents, so open editors update and the files are saved.
- Rename symbols with `rename_refactoring`, not text replacement: it updates every
  reference and leaves unrelated same-named text alone.
- `reformat_file` applies the language's formatter.
- After editing, check the files with `get_file_problems` (one file) or `lint_files`
  (several) and fix what you broke.

## Building and running

- `build_project` builds the project; `get_run_configurations` lists what can run and
  `execute_run_configuration` runs one and returns its output.
- `execute_terminal_command` runs a shell command in the project. Running commands asks the
  user first unless they turned on brave mode; say what you run and why.

## Showing the user

- `open_file_in_editor` opens a file at a line, so the user can follow along.
- `get_all_open_file_paths` tells which files the user has open and which one is active:
  start there when the request refers to "this file".
