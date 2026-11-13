//! Every SQL command of Snowflake's reference
//! (<https://docs.snowflake.com/en/sql-reference/sql-all>) through the parts of the client a
//! statement passes: the script splitter, the read-only guard and the wire. The samples are in
//! `tests/fixtures/snowflake/commands.json`, one per documented command; the SQL assistance of
//! the UI reads the same file (`src/features/database/sql/snowflakeCommands.test.ts`).
//!
//! The samples exercise the client, not Snowflake's grammar: a server is needed to prove a
//! statement valid, which the ignored live test does for the commands that only read.

use super::tests::{CLOSED_OK, LOGIN_OK, bind, ok, result, serve, source};
use super::{first_word, is_write};
use crate::conn::Pool;
use crate::source::DbDriver;
use crate::split::split;
use ide_core::CancellationToken;
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
pub(crate) struct Command {
    pub command: String,
    pub sql: String,
    /// Runs on a read-only data source: it reads, or changes the session only.
    pub reads: bool,
}

#[derive(Deserialize)]
struct Fixture {
    commands: Vec<Command>,
}

pub(crate) fn commands() -> Vec<Command> {
    let fixture: Fixture =
        serde_json::from_str(include_str!("../../tests/fixtures/snowflake/commands.json")).expect("the fixture parses");
    fixture.commands
}

/// `PUT` and `GET` move files on the client's side.
fn transfers(c: &Command) -> bool {
    matches!(first_word(&c.sql).as_str(), "PUT" | "GET")
}

#[test]
fn the_fixture_covers_the_reference() {
    let commands = commands();
    assert!(commands.len() >= 786, "{} commands", commands.len());
    let mut names: Vec<&str> = commands.iter().map(|c| c.command.as_str()).collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), commands.len(), "a command is listed twice");
    for family in ["ALTER", "CREATE", "DESCRIBE", "DROP", "SHOW", "UNDROP", "USE", "GRANT", "REVOKE", "EXECUTE"] {
        assert!(names.iter().any(|n| n.starts_with(family)), "no {family} command");
    }
}

#[test]
fn every_command_is_one_statement() {
    let commands = commands();
    for c in &commands {
        let alone = split(&c.sql, DbDriver::Snowflake);
        assert_eq!(alone.len(), 1, "{}: split into {} statements", c.command, alone.len());
        assert_eq!(alone[0].text, c.sql.trim(), "{}", c.command);
        // Terminated, commented and followed by another statement.
        let script = format!("-- {}; a comment\n{};\n// next; one\nselect 1;", c.command, c.sql);
        let parts: Vec<String> = split(&script, DbDriver::Snowflake).into_iter().map(|s| s.text).collect();
        assert_eq!(parts.len(), 2, "{}: {parts:?}", c.command);
        assert!(parts[0].ends_with(c.sql.trim()), "{}: {:?}", c.command, parts[0]);
        assert_eq!(parts[1].trim_start_matches("// next; one\n"), "select 1", "{}", c.command);
    }
    // The whole reference as one script.
    let script = commands.iter().map(|c| format!("{};\n", c.sql)).collect::<String>();
    let parts = split(&script, DbDriver::Snowflake);
    assert_eq!(parts.len(), commands.len());
    for (part, c) in parts.iter().zip(&commands) {
        assert_eq!(part.text, c.sql.trim(), "{}", c.command);
    }
}

#[test]
fn every_command_is_known_to_read_or_to_write() {
    for c in commands() {
        assert_eq!(!is_write(&c.sql), c.reads, "{}: {}", c.command, c.sql);
        assert!(!first_word(&c.sql).is_empty(), "{}", c.command);
        // Comments before a statement do not change what it is.
        let commented = format!("/* note; */ -- one\n// two\n{}", c.sql);
        assert_eq!(!is_write(&commented), c.reads, "{} after comments", c.command);
    }
}

#[tokio::test]
async fn every_command_reaches_the_server_as_written_and_its_answer_is_read() {
    let commands = commands();
    let (listener, port) = bind().await;
    let status = json!({ "success": true, "data": { "rowtype": [{ "name": "status", "type": "text" }],
        "rowset": [["Statement executed successfully."]], "queryResultFormat": "json", "statementTypeId": 0x5000 } })
    .to_string();
    let rows = result(
        json!([{ "name": "name", "type": "text" }, { "name": "n", "type": "fixed", "scale": 0 }]),
        json!([["a", "1"], ["b", null]]),
    );
    let changed =
        json!({ "success": true, "data": { "rowtype": [{ "name": "number of rows inserted", "type": "fixed" }],
        "rowset": [["3"]], "queryResultFormat": "json", "statementTypeId": 0x3100, "total": 1 } })
        .to_string();
    // Login (which names the schema), then one answer per command.
    let mut replies = vec![ok(LOGIN_OK)];
    let mut entered = true;
    for c in commands.iter().filter(|c| !transfers(c)) {
        if !entered && first_word(&c.sql) != "USE" {
            replies.push(ok(status.clone()));
        }
        // These leave the session wherever they went: its schema is entered again afterwards.
        entered = !matches!(first_word(&c.sql).as_str(), "USE" | "CALL" | "EXECUTE");
        let dml = matches!(first_word(&c.sql).as_str(), "INSERT" | "UPDATE" | "DELETE" | "MERGE");
        replies.push(ok(if c.reads && first_word(&c.sql) != "USE" {
            rows.clone()
        } else if dml {
            changed.clone()
        } else {
            status.clone()
        }));
    }
    replies.push(ok(CLOSED_OK));
    let server = serve(listener, replies);
    let pool = Pool::connect(&source(port), None, None).await.unwrap();
    let cancel = CancellationToken::new();
    for c in &commands {
        if transfers(c) {
            // Refused before anything is sent: the files would not move.
            let refused = pool.execute(&c.sql, 100, &cancel).await.unwrap_err();
            assert!(refused.message.contains("Snowflake CLI"), "{}: {}", c.command, refused.message);
            continue;
        }
        let answer = pool.execute(&c.sql, 100, &cancel).await;
        let answer = answer.unwrap_or_else(|e| panic!("{}: {}", c.command, e.message));
        let word = first_word(&c.sql);
        if c.reads && word != "USE" {
            assert_eq!(
                answer.rows,
                [[Some("a".to_owned()), Some("1".to_owned())], [Some("b".to_owned()), None]],
                "{}",
                c.command
            );
            assert_eq!(answer.affected, None, "{}", c.command);
        } else if matches!(word.as_str(), "INSERT" | "UPDATE" | "DELETE" | "MERGE") {
            assert_eq!(answer.affected, Some(3.0), "{}", c.command);
        } else {
            assert!(answer.columns.is_empty() && answer.rows.is_empty(), "{}: a command shows no grid", c.command);
        }
    }
    pool.close().await;
    let seen = server.await.unwrap();
    let sent = seen[1..seen.len() - 1]
        .iter()
        .map(|r| r.json()["sqlText"].as_str().unwrap_or_default().to_owned())
        .collect::<Vec<_>>();
    let sent: Vec<&str> = sent.iter().map(String::as_str).collect();
    let context = "USE SCHEMA \"ANALYTICS\".\"PUBLIC\"";
    let written: Vec<&str> = sent.iter().copied().filter(|sql| *sql != context).collect();
    assert_eq!(written, commands.iter().filter(|c| !transfers(c)).map(|c| c.sql.as_str()).collect::<Vec<_>>());
}
