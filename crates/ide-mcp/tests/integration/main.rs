//! The MCP server's integration tests, in one binary: each test file would link the whole IDE again.

mod common;

mod changelists;
mod code;
mod database;
mod diagnostics;
mod edit;
mod filter;
mod markdown;
mod protocol;
mod read;
mod router;
mod run;
mod search;
mod skills;
mod stdio;
mod transport;
mod vcs;
