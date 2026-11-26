//! PostgreSQL transaction-pool connections whose endpoint rejects the read-only startup option.

use super::{Context, Held, PgConnection, PgHandle, PgReadOnly, db_err};
use ide_core::{IdeError, IdeResult};
use sqlx::{Executor, SqlSafeStr};

// Take the first snapshot before user SQL, fixing the transaction characteristics on this backend.
pub(super) const BEGIN: &str = "BEGIN READ ONLY; SELECT 1";

fn leading_word<'a>(input: &mut &'a str) -> &'a str {
    loop {
        *input = input.trim_start_matches([' ', '\t', '\r', '\n', '\x0c', '\x0b', ';']);
        if let Some(comment) = input.strip_prefix("--") {
            *input = &comment[comment.find(['\r', '\n']).unwrap_or(comment.len())..];
        } else if let Some(mut comment) = input.strip_prefix("/*") {
            let mut depth = 1usize;
            while depth > 0 {
                let Some(at) = comment.find(['/', '*']) else { return "" };
                comment = &comment[at..];
                if let Some(rest) = comment.strip_prefix("/*") {
                    depth += 1;
                    comment = rest;
                } else if let Some(rest) = comment.strip_prefix("*/") {
                    depth -= 1;
                    comment = rest;
                } else {
                    comment = &comment[1..];
                }
            }
            *input = comment;
        } else {
            let end = input.find(|c: char| !(c.is_alphanumeric() || c == '_' || c == '$')).unwrap_or(input.len());
            let (word, rest) = input.split_at(end);
            *input = rest;
            return word;
        }
    }
}

fn control(mut sql: &str) -> Option<&'static str> {
    let first = leading_word(&mut sql);
    for name in ["BEGIN", "COMMIT", "END", "ROLLBACK", "ABORT"] {
        if first.eq_ignore_ascii_case(name) {
            return Some(name);
        }
    }
    let second = leading_word(&mut sql);
    if second.eq_ignore_ascii_case("TRANSACTION") {
        return [("START", "START TRANSACTION"), ("PREPARE", "PREPARE TRANSACTION"), ("SET", "SET TRANSACTION")]
            .into_iter()
            .find_map(|(verb, name)| first.eq_ignore_ascii_case(verb).then_some(name));
    }
    (first.eq_ignore_ascii_case("SET")
        && second.eq_ignore_ascii_case("SESSION")
        && leading_word(&mut sql).eq_ignore_ascii_case("CHARACTERISTICS"))
    .then_some("SET SESSION CHARACTERISTICS")
}

pub(crate) fn validate(sql: &str) -> Result<(), String> {
    if sql.contains('\0') {
        return Err("PostgreSQL statements cannot contain a null byte".into());
    }
    let blocked = control(sql).or_else(|| {
        sql.contains(';')
            .then(|| crate::split::split(sql, crate::DbDriver::Postgres))
            .and_then(|statements| statements.iter().find_map(|s| control(&s.text)))
    });
    if let Some(name) = blocked {
        return Err(format!("{name} is unavailable while OpenIDEA manages the read-only transaction"));
    }
    Ok(())
}

/// A startup SET must follow the client to its next backend without changing the next client's session.
pub(super) fn startup(statements: &[String]) -> Result<(Vec<String>, Vec<String>), String> {
    let mut init = Vec::with_capacity(statements.len());
    let mut settings = Vec::new();
    for sql in statements {
        validate(sql)?;
        let mut rest = sql.as_str();
        let verb = leading_word(&mut rest);
        if verb.eq_ignore_ascii_case("RESET") || verb.eq_ignore_ascii_case("DISCARD") {
            return Err(format!("{verb} in a startup script cannot be preserved across pooled read-only transactions"));
        }
        if verb.eq_ignore_ascii_case("SET") {
            let after_set = rest;
            let kind = leading_word(&mut rest);
            if !kind.eq_ignore_ascii_case("LOCAL") && !kind.eq_ignore_ascii_case("CONSTRAINTS") {
                let mut after_session = rest;
                let local = if kind.eq_ignore_ascii_case("SESSION")
                    && !leading_word(&mut after_session).eq_ignore_ascii_case("AUTHORIZATION")
                {
                    rest
                } else {
                    after_set
                };
                let sql = format!("SET LOCAL {local}");
                settings.push(sql.clone());
                init.push(sql);
                continue;
            }
        }
        init.push(sql.clone());
    }
    Ok((init, settings))
}

// Keep the text result format of raw_sql. For SQL containing a delimiter, PostgreSQL's Parse
// validates that the text denotes a single command, including under the server's quoting rules.
pub(super) async fn check_single(conn: &mut PgConnection, sql: &str) -> Result<(), sqlx::Error> {
    if sql.contains(';') {
        conn.prepare(sqlx::AssertSqlSafe(sql.to_owned()).into_sql_str()).await?;
    }
    Ok(())
}

impl PgHandle {
    pub(super) async fn start_read_only(&mut self) -> IdeResult<()> {
        self.in_transaction = true;
        let result = async {
            sqlx::raw_sql(BEGIN).execute(&mut **self).await.map_err(db_err)?;
            let settings = self.options.local_settings.clone();
            for sql in settings.iter() {
                check_single(self, sql).await.map_err(db_err)?;
                sqlx::raw_sql(sqlx::AssertSqlSafe(sql.clone())).execute(&mut **self).await.map_err(db_err)?;
            }
            self.apply_local_path().await
        }
        .await;
        if result.is_err() {
            self.conn.take();
        }
        result
    }

    async fn apply_local_path(&mut self) -> IdeResult<()> {
        if let Some(path) = &self.context.current {
            let path = path.clone();
            sqlx::query("SELECT pg_catalog.set_config('search_path', $1, true)")
                .bind(path)
                .execute(&mut **self)
                .await
                .map_err(db_err)?;
        }
        Ok(())
    }

    pub(super) async fn select_path(&mut self, wanted: Option<String>) -> IdeResult<()> {
        if !self.context.known || self.context.current != wanted {
            self.context.current = wanted;
            if self.in_transaction {
                self.apply_local_path().await?;
            }
            self.context.known = true;
        }
        Ok(())
    }
}

impl Held {
    pub(super) fn require_read_only_transaction(&self) -> IdeResult<()> {
        if matches!(self, Self::Postgres(c) if c.options.read_only == PgReadOnly::Transaction && (!c.in_transaction || c.conn.is_none()))
        {
            return Err(IdeError::internal("PostgreSQL read-only transaction has not started"));
        }
        Ok(())
    }

    fn guarded_postgres(&mut self) -> Option<&mut PgHandle> {
        match self {
            Self::Postgres(c) if c.options.read_only == PgReadOnly::Transaction => Some(c),
            _ => None,
        }
    }

    /// Returns true when this operation owns the transaction and must finish it.
    pub(super) async fn begin_read_only(&mut self) -> IdeResult<bool> {
        if let Some(c) = self.guarded_postgres()
            && !c.in_transaction
        {
            c.start_read_only().await?;
            return Ok(true);
        }
        Ok(false)
    }

    pub(super) async fn check_protected_statement(&mut self, sql: &str) -> IdeResult<()> {
        self.require_read_only_transaction()?;
        if let Some(c) = self.guarded_postgres() {
            validate(sql).map_err(IdeError::invalid)?;
            check_single(c, sql).await.map_err(db_err)?;
        }
        Ok(())
    }

    pub(super) async fn end_read_only(&mut self, commit: bool) -> IdeResult<()> {
        if let Some(c) = self.guarded_postgres() {
            if c.conn.is_none() {
                return Err(IdeError::invalid("The read-only PostgreSQL transaction lost its connection"));
            }
            let end = if commit { "COMMIT" } else { "ROLLBACK" };
            if let Err(error) = sqlx::raw_sql(end).execute(&mut **c).await {
                c.conn.take();
                return Err(db_err(error));
            }
            c.in_transaction = false;
            c.context = Context::new(c.context.default.clone());
        }
        Ok(())
    }

    pub(super) async fn finish_read_only<T>(&mut self, owned: bool, result: IdeResult<T>) -> IdeResult<T> {
        if owned && let Err(error) = self.end_read_only(result.is_ok()).await {
            return Err(result.err().unwrap_or(error));
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::validate;

    #[test]
    fn names_transaction_control_and_accepts_quoted_text() {
        for name in [
            "BEGIN",
            "COMMIT",
            "END",
            "ROLLBACK",
            "ABORT",
            "START TRANSACTION",
            "PREPARE TRANSACTION",
            "SET TRANSACTION",
            "SET SESSION CHARACTERISTICS",
        ] {
            let statement = name.to_lowercase().replace(' ', " /* note */ ");
            let sql = format!(" -- preceding comment\n /* outer /* nested */ block */ {statement}");
            assert!(validate(&sql).unwrap_err().contains(name), "{sql}");
        }
        assert!(validate("SELECT 1; COMMIT").unwrap_err().contains("COMMIT"));
        for sql in
            ["SELECT 'a; COMMIT'", "SELECT $$;ROLLBACK$$", "SELECT 1 /* END */", "SET LOCAL search_path TO public"]
        {
            assert!(validate(sql).is_ok(), "{sql}");
        }
    }
}
