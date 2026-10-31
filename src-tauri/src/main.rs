// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Started by `ssh` / `git` as their askpass program: answer and exit, no UI.
    if let Some(code) = ide_ssh::askpass::run_helper() {
        std::process::exit(code);
    }
    // `openidea mcp-stdio`: the MCP bridge clients like Claude Desktop start; no UI.
    if std::env::args_os().nth(1).is_some_and(|a| a == ide_mcp::stdio::SUBCOMMAND) {
        std::process::exit(ide_mcp::stdio::main(None));
    }
    openidea_lib::run()
}
