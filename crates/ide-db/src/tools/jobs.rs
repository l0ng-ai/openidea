//! What a dump or restore dialog asks for, as typed options, and the arguments that do it.
//! The connection arguments come from [`super::connection`]; these are the rest.

use super::DbTool;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DbDumpFormat {
    /// SQL text, restored with `psql`.
    Plain,
    Custom,
    /// A directory of files; the only format `pg_dump` writes in parallel.
    Directory,
    Tar,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DbDumpStatements {
    Copy,
    Inserts,
    ColumnInserts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DbDumpContent {
    All,
    SchemaOnly,
    DataOnly,
}

/// Name lists hold `pg_dump` patterns (`*`, `?`, quoted names).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DbPgDumpOptions {
    pub format: DbDumpFormat,
    pub statements: DbDumpStatements,
    pub content: DbDumpContent,
    pub schemas: Vec<String>,
    pub tables: Vec<String>,
    pub exclude_tables: Vec<String>,
    /// Plain format only: archives get DROP / CREATE at restore.
    pub clean: bool,
    pub if_exists: bool,
    pub create: bool,
    pub no_owner: bool,
    pub no_privileges: bool,
    /// Directory format only.
    pub jobs: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DbPgRestoreOptions {
    pub content: DbDumpContent,
    pub schemas: Vec<String>,
    pub clean: bool,
    pub if_exists: bool,
    pub no_owner: bool,
    pub no_privileges: bool,
    pub single_transaction: bool,
    pub exit_on_error: bool,
    /// Ignored with a single transaction, which `pg_restore` cannot split.
    pub jobs: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DbPsqlOptions {
    pub single_transaction: bool,
    pub stop_on_error: bool,
}

/// A run of a client tool: which one, the file it writes or reads, and its options.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "tool", rename_all = "camelCase")]
pub enum DbToolJob {
    PgDump {
        file: String,
        options: DbPgDumpOptions,
    },
    /// `file`: an archive, or a directory archive.
    PgRestore {
        file: String,
        options: DbPgRestoreOptions,
    },
    Psql {
        file: String,
        options: DbPsqlOptions,
    },
}

impl DbToolJob {
    pub fn tool(&self) -> DbTool {
        match self {
            DbToolJob::PgDump { .. } => DbTool::PgDump,
            DbToolJob::PgRestore { .. } => DbTool::PgRestore,
            DbToolJob::Psql { .. } => DbTool::Psql,
        }
    }

    /// The arguments after the connection ones.
    pub fn args(&self) -> Vec<String> {
        match self {
            DbToolJob::PgDump { file, options } => pg_dump(options, file),
            DbToolJob::PgRestore { file, options } => pg_restore(options, file),
            DbToolJob::Psql { file, options } => psql(options, file),
        }
    }
}

fn flag(on: bool, flag: &str) -> Option<String> {
    on.then(|| flag.to_owned())
}

fn content(c: DbDumpContent) -> Option<String> {
    match c {
        DbDumpContent::All => None,
        DbDumpContent::SchemaOnly => Some("--schema-only".into()),
        DbDumpContent::DataOnly => Some("--data-only".into()),
    }
}

fn each(names: &[String], option: &str) -> impl Iterator<Item = String> {
    names.iter().map(|n| n.trim()).filter(|n| !n.is_empty()).map(move |n| format!("--{option}={n}"))
}

fn pg_dump(o: &DbPgDumpOptions, file: &str) -> Vec<String> {
    let plain = o.format == DbDumpFormat::Plain;
    let format = match o.format {
        DbDumpFormat::Plain => "p",
        DbDumpFormat::Custom => "c",
        DbDumpFormat::Directory => "d",
        DbDumpFormat::Tar => "t",
    };
    let mut args = vec![format!("--format={format}"), format!("--file={file}")];
    args.extend(match o.statements {
        DbDumpStatements::Copy => None,
        DbDumpStatements::Inserts => Some("--inserts".to_owned()),
        DbDumpStatements::ColumnInserts => Some("--column-inserts".to_owned()),
    });
    args.extend(content(o.content));
    args.extend(each(&o.schemas, "schema"));
    args.extend(each(&o.tables, "table"));
    args.extend(each(&o.exclude_tables, "exclude-table"));
    args.extend(flag(plain && o.clean, "--clean"));
    args.extend(flag(plain && o.clean && o.if_exists, "--if-exists"));
    args.extend(flag(plain && o.create, "--create"));
    args.extend(flag(o.no_owner, "--no-owner"));
    args.extend(flag(o.no_privileges, "--no-privileges"));
    if o.format == DbDumpFormat::Directory && o.jobs > 1 {
        args.push(format!("--jobs={}", o.jobs));
    }
    args.push("--verbose".into());
    args
}

fn pg_restore(o: &DbPgRestoreOptions, file: &str) -> Vec<String> {
    let mut args: Vec<String> = content(o.content).into_iter().collect();
    args.extend(each(&o.schemas, "schema"));
    args.extend(flag(o.clean, "--clean"));
    args.extend(flag(o.clean && o.if_exists, "--if-exists"));
    args.extend(flag(o.no_owner, "--no-owner"));
    args.extend(flag(o.no_privileges, "--no-privileges"));
    args.extend(flag(o.single_transaction, "--single-transaction"));
    args.extend(flag(o.exit_on_error, "--exit-on-error"));
    if o.jobs > 1 && !o.single_transaction {
        args.push(format!("--jobs={}", o.jobs));
    }
    args.push("--verbose".into());
    if !file.is_empty() {
        args.push(file.to_owned());
    }
    args
}

fn psql(o: &DbPsqlOptions, file: &str) -> Vec<String> {
    // `~/.psqlrc` could switch databases or change settings before the dump runs.
    let mut args = vec!["--no-psqlrc".to_owned()];
    args.extend((!file.is_empty()).then(|| format!("--file={file}")));
    args.extend(flag(o.single_transaction, "--single-transaction"));
    args.extend(flag(o.stop_on_error, "--set=ON_ERROR_STOP=1"));
    args
}

/// The command as a shell would need it typed: the dialogs' preview.
pub fn command_line(program: &Path, args: &[String]) -> String {
    let quote = |s: &str| {
        if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "@%+=:,./-_".contains(c)) {
            s.to_owned()
        } else {
            format!("'{}'", s.replace('\'', "'\\''"))
        }
    };
    std::iter::once(program.to_string_lossy().into_owned())
        .chain(args.iter().cloned())
        .map(|a| quote(&a))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dump() -> DbPgDumpOptions {
        DbPgDumpOptions {
            format: DbDumpFormat::Plain,
            statements: DbDumpStatements::Copy,
            content: DbDumpContent::All,
            schemas: vec![],
            tables: vec![],
            exclude_tables: vec![],
            clean: false,
            if_exists: false,
            create: false,
            no_owner: false,
            no_privileges: false,
            jobs: 1,
        }
    }

    fn restore() -> DbPgRestoreOptions {
        DbPgRestoreOptions {
            content: DbDumpContent::All,
            schemas: vec![],
            clean: false,
            if_exists: false,
            no_owner: false,
            no_privileges: false,
            single_transaction: false,
            exit_on_error: true,
            jobs: 1,
        }
    }

    fn args(job: DbToolJob) -> Vec<String> {
        job.args()
    }

    #[test]
    fn dumps_plain_sql_with_copy_by_default() {
        let job = DbToolJob::PgDump { file: "/tmp/shop.sql".into(), options: dump() };
        assert_eq!(args(job), ["--format=p", "--file=/tmp/shop.sql", "--verbose"]);
    }

    #[test]
    fn turns_lists_and_switches_into_flags() {
        let options = DbPgDumpOptions {
            statements: DbDumpStatements::ColumnInserts,
            content: DbDumpContent::DataOnly,
            schemas: vec!["public".into(), "audit".into()],
            tables: vec!["public.orders".into()],
            exclude_tables: vec!["public.log_*".into()],
            clean: true,
            if_exists: true,
            create: true,
            no_owner: true,
            ..dump()
        };
        assert_eq!(
            args(DbToolJob::PgDump { file: "/tmp/x.sql".into(), options }),
            [
                "--format=p",
                "--file=/tmp/x.sql",
                "--column-inserts",
                "--data-only",
                "--schema=public",
                "--schema=audit",
                "--table=public.orders",
                "--exclude-table=public.log_*",
                "--clean",
                "--if-exists",
                "--create",
                "--no-owner",
                "--verbose",
            ]
        );
    }

    #[test]
    fn leaves_drop_and_create_to_the_restore_of_an_archive() {
        let options = DbPgDumpOptions { format: DbDumpFormat::Custom, clean: true, create: true, ..dump() };
        let a = args(DbToolJob::PgDump { file: "/tmp/x.dump".into(), options });
        assert!(!a.iter().any(|a| a == "--clean" || a == "--create"), "{a:?}");
    }

    #[test]
    fn runs_parallel_jobs_only_where_the_tool_can() {
        let dir = DbPgDumpOptions { format: DbDumpFormat::Directory, jobs: 4, ..dump() };
        assert!(args(DbToolJob::PgDump { file: "/tmp/d".into(), options: dir.clone() }).contains(&"--jobs=4".into()));
        let custom = DbPgDumpOptions { format: DbDumpFormat::Custom, ..dir };
        assert!(!args(DbToolJob::PgDump { file: "/tmp/d".into(), options: custom }).contains(&"--jobs=4".into()));
        let single = DbPgRestoreOptions { jobs: 4, single_transaction: true, ..restore() };
        let a = args(DbToolJob::PgRestore { file: "/tmp/x".into(), options: single });
        assert!(a.contains(&"--single-transaction".into()) && !a.iter().any(|a| a.starts_with("--jobs")));
    }

    #[test]
    fn restores_the_archive_named_last_and_stops_on_the_first_error() {
        assert_eq!(
            args(DbToolJob::PgRestore { file: "/tmp/shop.dump".into(), options: restore() }),
            ["--exit-on-error", "--verbose", "/tmp/shop.dump"]
        );
    }

    #[test]
    fn leaves_out_an_archive_not_chosen_yet() {
        let a = args(DbToolJob::PgRestore { file: String::new(), options: restore() });
        assert_eq!(a, ["--exit-on-error", "--verbose"]);
    }

    #[test]
    fn runs_a_sql_file_in_one_transaction_that_stops_on_error() {
        let options = DbPsqlOptions { single_transaction: true, stop_on_error: true };
        assert_eq!(
            args(DbToolJob::Psql { file: "/tmp/shop.sql".into(), options }),
            ["--no-psqlrc", "--file=/tmp/shop.sql", "--single-transaction", "--set=ON_ERROR_STOP=1"]
        );
    }

    #[test]
    fn quotes_what_a_shell_would_split() {
        let line = command_line(
            Path::new("/usr/bin/pg_dump"),
            &["--port=5432".into(), "--file=/tmp/my dump.sql".into(), "--table=it's".into()],
        );
        assert_eq!(line, r#"/usr/bin/pg_dump --port=5432 '--file=/tmp/my dump.sql' '--table=it'\''s'"#);
    }

    #[test]
    fn reads_the_job_the_dialog_sends() {
        let json = r#"{"tool":"psql","file":"/tmp/a.sql","options":{"singleTransaction":true,"stopOnError":false}}"#;
        let job: DbToolJob = serde_json::from_str(json).unwrap();
        assert_eq!(job.tool(), DbTool::Psql);
    }
}
