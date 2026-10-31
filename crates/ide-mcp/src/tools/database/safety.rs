//! What a statement does to the database, for the consent the database tools ask.
//!
//! DDL statements (create, alter, drop, truncate) modify the schema; DML (insert, update,
//! delete, merge), statements nobody knows and `KILL` modify data; everything else reads.
//! The first statement (in text order) that is not a read decides. Each statement is
//! classified by its leading keyword, looking inside for nested data-modifying statements
//! (CTE bodies, `EXPLAIN` targets); calling a routine (`CALL`, `EXEC`) counts as modifying
//! data, since a routine may have side effects.

use ide_db::DbDriver;

/// What a statement does to the database.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DbOperationType {
    ReadData,
    WriteData,
    ReadSchema,
    WriteSchema,
    Unknown,
}

impl DbOperationType {
    /// Needs a consent shown as a warning (writes, or kind unknown).
    pub fn is_unsafe(self) -> bool {
        !matches!(self, Self::ReadSchema | Self::ReadData)
    }

    /// The schema may differ afterwards.
    pub fn may_change_schema(self) -> bool {
        matches!(self, Self::WriteSchema | Self::Unknown)
    }
}

/// A token of SQL text: a word (keyword or unquoted identifier, upper-cased), a quoted
/// name or string (opaque), or a punctuation character.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Token {
    Word(String),
    Quoted,
    Punct(char),
}

/// Splits `text` into tokens, skipping comments and whitespace.
fn tokens(text: &str, driver: DbDriver) -> Vec<Token> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if c.is_whitespace() {
            i += 1;
        } else if c == '-' && next == Some('-') || (c == '#' && driver == DbDriver::Mysql) {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && next == Some('*') {
            i += 2;
            let mut depth = 1;
            while i < chars.len() && depth > 0 {
                if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    i += 2;
                } else if chars[i] == '/' && chars.get(i + 1) == Some(&'*') && driver == DbDriver::Postgres {
                    depth += 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
        } else if matches!(c, '\'' | '"' | '`') || (c == '[' && driver == DbDriver::SqlServer) {
            let close = if c == '[' { ']' } else { c };
            i += 1;
            while i < chars.len() {
                if chars[i] == close {
                    if chars.get(i + 1) == Some(&close) {
                        i += 2;
                        continue;
                    }
                    break;
                }
                if chars[i] == '\\' && c == '\'' && driver == DbDriver::Mysql {
                    i += 1;
                }
                i += 1;
            }
            i += 1;
            out.push(Token::Quoted);
        } else if c == '$' && driver == DbDriver::Postgres && dollar_tag(&chars, i).is_some() {
            let tag = dollar_tag(&chars, i).expect("checked");
            i += tag.len();
            let tag: Vec<char> = tag.chars().collect();
            while i < chars.len() && !chars[i..].starts_with(&tag) {
                i += 1;
            }
            i = (i + tag.len()).min(chars.len());
            out.push(Token::Quoted);
        } else if c.is_alphanumeric() || c == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_alphanumeric() || matches!(chars[i], '_' | '$')) {
                i += 1;
            }
            out.push(Token::Word(chars[start..i].iter().collect::<String>().to_uppercase()));
        } else {
            out.push(Token::Punct(c));
            i += 1;
        }
    }
    out
}

/// The `$tag$` opening a PostgreSQL dollar-quoted string at `i`.
fn dollar_tag(chars: &[char], i: usize) -> Option<String> {
    let mut j = i + 1;
    while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_') {
        j += 1;
    }
    (chars.get(j) == Some(&'$') && !chars.get(i + 1).is_some_and(|c| c.is_ascii_digit()))
        .then(|| chars[i..=j].iter().collect())
}

const DDL: &[&str] = &["CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME", "COMMENT"];
const DML: &[&str] = &["INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE", "UPSERT"];
/// Statements a parser knows that neither read nor change anything we classify, or only read.
const READS: &[&str] = &[
    "SELECT",
    "VALUES",
    "TABLE",
    "SHOW",
    "DESCRIBE",
    "DESC",
    "EXPLAIN",
    "WITH",
    "SET",
    "RESET",
    "USE",
    "BEGIN",
    "START",
    "COMMIT",
    "END",
    "ROLLBACK",
    "SAVEPOINT",
    "RELEASE",
    "PRAGMA",
    "DECLARE",
    "FETCH",
    "CLOSE",
    "OPEN",
    "LISTEN",
    "UNLISTEN",
    "PREPARE",
    "DEALLOCATE",
    "HANDLER",
    "CHECKSUM",
    "HELP",
    "PRINT",
    "WAITFOR",
];

/// The operation type of one statement's tokens.
fn statement(tokens: &[Token]) -> DbOperationType {
    fn words(t: &Token) -> Option<&str> {
        match t {
            Token::Word(w) => Some(w.as_str()),
            _ => None,
        }
    }
    // A leading parenthesis: `(SELECT …) UNION …`.
    let Some(first) = tokens.iter().find_map(|t| match t {
        Token::Punct('(') => None,
        t => Some(words(t)),
    }) else {
        return DbOperationType::ReadData;
    };
    let Some(first) = first else { return DbOperationType::WriteData };
    if DDL.contains(&first) || matches!(first, "GRANT" | "REVOKE") {
        return DbOperationType::WriteSchema;
    }
    if DML.contains(&first) {
        return DbOperationType::WriteData;
    }
    if matches!(first, "SET" | "PRAGMA") {
        // `PRAGMA x = y` changes the database (SQLite); `SET` only the session.
        return if first == "PRAGMA" && tokens.contains(&Token::Punct('=')) {
            DbOperationType::WriteData
        } else {
            DbOperationType::ReadData
        };
    }
    if !READS.contains(&first) {
        // An unknown statement, `CALL`, `EXEC`, `DO`, `KILL`, `COPY`, `LOCK`, `VACUUM`…
        return DbOperationType::WriteData;
    }
    // A read: unless it contains a data-modifying statement (CTE body, EXPLAIN target).
    let mut previous: Option<&str> = None;
    for (i, t) in tokens.iter().enumerate() {
        let Some(w) = words(t) else {
            previous = None;
            continue;
        };
        let nested = DML.contains(&w)
            // `SELECT … FOR UPDATE`, `ON UPDATE`, `ON DELETE` are clauses, not statements.
            && !matches!(previous, Some("FOR" | "ON" | "KEY" | "NO"))
            && i > 0
            // `REPLACE(…)` is a function.
            && !(w == "REPLACE" && tokens.get(i + 1) == Some(&Token::Punct('(')));
        if nested {
            return DbOperationType::WriteData;
        }
        if DDL.contains(&w) && matches!(previous, Some("EXPLAIN" | "ANALYZE" | "VERBOSE")) {
            return DbOperationType::WriteSchema;
        }
        previous = Some(w);
    }
    // `SELECT … INTO new_table` creates a table (PostgreSQL, SQL Server).
    if first == "SELECT" && tokens.iter().filter_map(words).any(|w| w == "INTO") {
        let into_variable = tokens.windows(2).any(|w| {
            w[0] == Token::Word("INTO".into())
                && match &w[1] {
                    Token::Punct('@') => true,
                    Token::Word(x) => x == "OUTFILE" || x == "DUMPFILE",
                    _ => false,
                }
        });
        if !into_variable {
            return DbOperationType::WriteSchema;
        }
    }
    DbOperationType::ReadData
}

/// Classifies `text` (any number of statements): the first statement that does not only
/// read decides; text without statements reads.
pub fn classify(text: &str, driver: DbDriver) -> DbOperationType {
    let mut statements: Vec<String> = ide_db::split::split(text, driver).into_iter().map(|s| s.text).collect();
    if statements.is_empty() {
        statements.push(text.to_owned());
    }
    for s in statements {
        let kind = statement(&tokens(&s, driver));
        if kind != DbOperationType::ReadData {
            return kind;
        }
    }
    DbOperationType::ReadData
}

#[cfg(test)]
mod tests {
    use super::DbOperationType::*;
    use super::*;

    fn pg(text: &str) -> DbOperationType {
        classify(text, DbDriver::Postgres)
    }

    #[test]
    fn reads() {
        for q in [
            "select * from t",
            "  -- note\n SELECT 1",
            "/* a */ (select 1) union (select 2)",
            "with x as (select 1) select * from x",
            "explain select 1",
            "select * from t for update",
            "select replace(name, 'a', 'b') from t",
            "show search_path",
            "values (1), (2)",
            "",
            "-- only a comment",
            "select 'delete from t'",
            "select \"update\" from t",
            "select $$ drop table t $$",
            "set search_path to app",
        ] {
            assert_eq!(pg(q), ReadData, "{q}");
        }
        assert_eq!(classify("select * from t into outfile '/tmp/x'", DbDriver::Mysql), ReadData);
        assert_eq!(classify("select @a := 1 into @b", DbDriver::Mysql), ReadData);
        assert_eq!(classify("pragma table_info(t)", DbDriver::Sqlite), ReadData);
    }

    #[test]
    fn writes_data() {
        for q in [
            "insert into t values (1)",
            "UPDATE t SET a = 1",
            "delete from t",
            "merge into t using s on (t.id = s.id) when matched then delete",
            "with d as (delete from t returning *) select * from d",
            "explain analyze update t set a = 1",
            "call refresh_all()",
            "vacuum",
            "copy t from '/tmp/x'",
            "frobnicate the database",
        ] {
            assert_eq!(pg(q), WriteData, "{q}");
        }
        assert_eq!(classify("replace into t values (1)", DbDriver::Mysql), WriteData);
        assert_eq!(classify("exec dbo.cleanup", DbDriver::SqlServer), WriteData);
        assert_eq!(classify("kill 12", DbDriver::Mysql), WriteData);
        assert_eq!(classify("pragma user_version = 3", DbDriver::Sqlite), WriteData);
    }

    #[test]
    fn writes_schema() {
        for q in [
            "create table t (id int)",
            "alter table t add column b int",
            "DROP TABLE t",
            "truncate t",
            "comment on table t is 'x'",
            "select * into t2 from t",
            "grant select on t to bob",
        ] {
            assert_eq!(pg(q), WriteSchema, "{q}");
        }
    }

    #[test]
    fn the_first_statement_that_writes_decides() {
        assert_eq!(pg("insert into t values (1); drop table t"), WriteData);
        assert_eq!(pg("drop table t; insert into t values (1)"), WriteSchema);
        assert_eq!(pg("select 1; drop table t"), WriteSchema);
        assert_eq!(pg("select 1; select 2"), ReadData);
    }
}
