# MCP server

OpenIDEA has a built-in [Model Context Protocol](https://modelcontextprotocol.io) server, like the one in the JetBrains IDEs. External AI agents (Claude Code, Codex, Cursor, VS Code, Windsurf, Gemini CLI, …) and the IDE's own agents can use it to work with the projects open in the IDE. They read files with unsaved editor changes, search with Find in Files and the symbol index, ask the language servers, run run configurations and build the project.

## Turning it on

Open **Settings → Tools → MCP Server**, check **Enable MCP Server** and apply. The server listens on `http://127.0.0.1:64352/mcp` by default; change the port there if another program uses it. The status bar shows an **MCP** indicator while the server is enabled, with the connected clients in its tooltip.

The server speaks the streamable HTTP transport. It only accepts connections from this machine, rejects browser pages of other origins and requests for other host names, and needs the bearer token shown in the clients' configurations. **Regenerate token…** makes a new one; configured clients then need their configuration updated.

## Connecting a client

The **Clients** section of the settings page lists the supported clients. For each one it shows whether its user configuration already has a current `openidea` entry. **Copy configuration** copies the snippet, and **Auto-Configure** writes the entry into the client's file and leaves the rest of the file alone:

| Client      | File                                              |
| ----------- | ------------------------------------------------- |
| Claude Code | `~/.claude.json` (`mcpServers`)                   |
| Codex       | `~/.codex/config.toml`                            |
| Cursor      | `~/.cursor/mcp.json`                              |
| VS Code     | `mcp.json` in the VS Code user settings directory |
| Windsurf    | `~/.codeium/windsurf/mcp_config.json`             |
| Gemini CLI  | `~/.gemini/settings.json`                         |

The snippets are JSON or TOML to paste into the file, never a command line: a command with the token would leave it in the shell history. Auto-Configure does not rewrite a file with comments (JSONC); add the entry by hand there (a current entry in such a file still shows as configured).

A project's own client configuration (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.codex/config.toml`, …) may be committed and shared, so it never gets the token. Configuring a project writes an entry that starts OpenIDEA's stdio bridge instead: the OpenIDEA executable with `mcp-stdio`, and `OPENIDEA_MCP_PORT`, `OPENIDEA_MCP_TOKEN_FILE` (the token file in your OpenIDEA data directory) and `OPENIDEA_MCP_PROJECT_PATH` in its environment. Those are paths of this machine: other machines need their own entry. Client detection counts such an entry as configured. Clients that only support stdio servers (Claude Desktop) use the same bridge in their user configuration.

The IDE's own agents (the Agents tool window) get the server automatically when **Give the IDE's agents these tools** is checked and the agent supports HTTP MCP servers. Their calls go to the project of the agent session's working directory.

## Projects

Every tool takes an optional `projectPath`: the project, or any directory inside it, the call is for. Clients should pass their working directory. Without it, a call goes to the focused project window, or to the only open project. Paths in arguments and results are relative to the project root unless they are absolute. Lines and columns are 1-based; columns count UTF-16 code units, which is the same as characters except that emoji and other astral characters count as two.

## Tools

The names and parameters follow the JetBrains MCP server (2026.2), so prompts and setups written for it work here.

| Tool                                              | Kind    | What it does                                                                   |
| ------------------------------------------------- | ------- | ------------------------------------------------------------------------------ |
| `read_file`                                       | read    | Numbered lines of a file, including unsaved changes                            |
| `list_directory_tree`                             | read    | A directory as a tree, ignored and excluded files included                     |
| `search_text`, `search_regex`                     | read    | Find in Files, with match coordinates                                          |
| `search_file`                                     | read    | Files by glob                                                                  |
| `search_symbol`                                   | read    | Classes, functions and fields from the symbol index (and the language servers) |
| `get_symbol_info`                                 | read    | Quick Documentation and the declaration at a position                          |
| `get_file_problems`, `lint_files`                 | read    | Language server diagnostics, or syntax errors without a server                 |
| `analyze_calls`                                   | read    | Incoming or outgoing call hierarchy                                            |
| `get_project_modules`, `get_project_dependencies` | read    | Modules, manifests and libraries                                               |
| `get_run_configurations`                          | read    | Run configurations, detected ones included                                     |
| `get_repositories`, `git_status`                  | read    | Git roots and porcelain-style status                                           |
| `get_all_open_file_paths`                         | read    | The active and open editors                                                    |
| `create_new_file`, `apply_patch`                  | edit    | New files; patches in the Codex `apply_patch` format or as unified diffs       |
| `reformat_file`, `rename_refactoring`             | edit    | The language server's formatter and rename                                     |
| `open_file_in_editor`                             | edit    | Opens a file in the IDE at a line and column                                   |
| `execute_run_configuration`                       | execute | Runs a run configuration and returns its output and exit code                  |
| `execute_terminal_command`                        | execute | Runs a shell command in the project root                                       |
| `build_project`                                   | execute | Build Project (Maven, Gradle, Cargo, Go, TypeScript) and its problems          |

Edits go through the editor's documents, so open editors update and the change can be undone, and are saved to disk. Before a tool reads or changes a file, an open editor without unsaved changes is reloaded from disk, so a file the agent just wrote itself is not overwritten from a stale buffer. Changes outside the project and to version control metadata (`.git`, `.hg`, `.svn`, …) are refused: hooks and configuration there would run code on the next VCS command. Changes to OpenIDEA's own project configuration (`.openidea/`: run configurations and settings, which can hold before-launch commands, environment variables, shells and language server commands) ask first, like the execute tools. The tool list on the settings page turns single tools off.

**Execute** tools ask first: the project window shows which client wants to run what (for a run configuration, with the environment variables the client sets), with **Allow** and **Deny**. Reading or opening a file outside the project and its content roots, and changing `.openidea/`, ask the same way. Check **Run shell commands and run configurations without confirmation (brave mode)** to skip the questions; only do that for clients you trust.

The questions are asked in the IDE by default. With client confirmations turned on (the `clientConfirmations` MCP setting), a client that supports MCP elicitation asks its own user instead; the IDE still asks for clients without it. Leave it off unless you trust the client to show the question to you: a client could answer its own elicitations.

The confirmation is not a sandbox. Edit tools change files without asking, and the language servers, build scripts and run configurations may run code from the edited files later (a build script, a test, a project-local tool the language server starts). Treat a connected client like a person with write access to the project.

The server serves at most 64 connections at once (more get `503`) and keeps at most 256 sessions; when they are all busy with an open stream or a running call, a new session is refused until one ends.

## Limitations

- Runs started by `execute_run_configuration` do not appear in the Run tool window, and before-launch tasks are not run.
- `get_run_configurations` with a `filePath` does not list run points (test and main markers) yet.
- `execute_terminal_command` runs the command as a child process, not in a Terminal tab.
- The Codex agent of the Agents tool window does not get the server yet.
