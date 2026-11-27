//! What a dump or restore dialog asks for, as typed options, and the arguments that do it.
//! The connection arguments come from [`super::connection`]; these are the rest.

use super::DbTool;
use ide_core::{IdeError, IdeResult};
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
    /// Creates the database the archive names; the target is only connected to.
    pub create: bool,
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

/// Switches that `mysqldump` turns on by default (`--opt`) only take a flag when turned off.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DbMysqldumpOptions {
    /// Empty: every database.
    pub databases: Vec<String>,
    /// Only with exactly one database.
    pub tables: Vec<String>,
    pub add_drop_table: bool,
    pub disable_keys: bool,
    pub add_locks: bool,
    pub add_drop_trigger: bool,
    pub no_data: bool,
    pub complete_insert: bool,
    pub create_options: bool,
    pub routines: bool,
    pub events: bool,
    /// A consistent InnoDB snapshot without locks; needs no RELOAD privilege.
    pub single_transaction: bool,
    /// Wins over `single_transaction`.
    pub lock_all_tables: bool,
    /// `None`: the client has no `--masking-policies`.
    pub masking_policies: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DbMysqlOptions {
    /// Empty: the databases the dump names.
    pub database: String,
    /// Runs the remaining statements after an error.
    pub force: bool,
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
    Mysqldump {
        file: String,
        options: DbMysqldumpOptions,
    },
    /// `file` goes to the standard input.
    Mysql {
        file: String,
        options: DbMysqlOptions,
    },
}

impl DbToolJob {
    pub fn tool(&self) -> DbTool {
        match self {
            DbToolJob::PgDump { .. } => DbTool::PgDump,
            DbToolJob::PgRestore { .. } => DbTool::PgRestore,
            DbToolJob::Psql { .. } => DbTool::Psql,
            DbToolJob::Mysqldump { .. } => DbTool::Mysqldump,
            DbToolJob::Mysql { .. } => DbTool::Mysql,
        }
    }

    /// The file piped to the tool's standard input.
    pub fn input(&self) -> Option<&str> {
        match self {
            DbToolJob::Mysql { file, .. } if !file.is_empty() => Some(file),
            _ => None,
        }
    }

    /// Refuses names that the tool would read as options: `mysqldump` takes databases and tables
    /// as plain arguments.
    pub fn check(&self) -> IdeResult<()> {
        if let DbToolJob::Mysqldump { options, .. } = self
            && let Some(name) = options.databases.iter().chain(&options.tables).find(|n| n.trim().starts_with('-'))
        {
            return Err(IdeError::invalid(format!("mysqldump cannot dump a database or table named {name}")));
        }
        Ok(())
    }

    /// The arguments after the connection ones.
    pub fn args(&self) -> Vec<String> {
        match self {
            DbToolJob::PgDump { file, options } => pg_dump(options, file),
            DbToolJob::PgRestore { file, options } => pg_restore(options, file),
            DbToolJob::Psql { file, options } => psql(options, file),
            DbToolJob::Mysqldump { file, options } => mysqldump(options, file),
            DbToolJob::Mysql { options, .. } => mysql(options),
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
    args.extend(flag(o.create, "--create"));
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

fn names(list: &[String]) -> impl Iterator<Item = String> {
    list.iter().map(|n| n.trim()).filter(|n| !n.is_empty()).map(str::to_owned)
}

fn mysqldump(o: &DbMysqldumpOptions, file: &str) -> Vec<String> {
    let skip = |on: bool, option: &str| (!on).then(|| format!("--skip-{option}"));
    let mut args = vec![format!("--result-file={file}")];
    args.extend(skip(o.add_drop_table, "add-drop-table"));
    args.extend(skip(o.disable_keys, "disable-keys"));
    args.extend(skip(o.add_locks, "add-locks"));
    args.extend(skip(o.create_options, "create-options"));
    args.extend(flag(o.add_drop_trigger, "--add-drop-trigger"));
    args.extend(flag(o.no_data, "--no-data"));
    args.extend(flag(o.complete_insert, "--complete-insert"));
    args.extend(flag(o.routines, "--routines"));
    args.extend(flag(o.events, "--events"));
    args.extend(flag(o.lock_all_tables, "--lock-all-tables"));
    args.extend(flag(!o.lock_all_tables && o.single_transaction, "--single-transaction"));
    // On by default where it exists; reading the policies needs privileges most users lack.
    args.extend(flag(o.masking_policies == Some(false), "--skip-masking-policies"));
    // Tablespace statements need the PROCESS privilege and rarely matter in a dump.
    args.push("--no-tablespaces".into());
    args.push("--verbose".into());
    let databases: Vec<String> = names(&o.databases).collect();
    match databases.as_slice() {
        [] => args.push("--all-databases".into()),
        [one] => {
            args.push(one.clone());
            args.extend(names(&o.tables));
        }
        _ => {
            args.push("--databases".into());
            args.extend(databases);
        }
    }
    args
}

fn mysql(o: &DbMysqlOptions) -> Vec<String> {
    let database = o.database.trim();
    let mut args: Vec<String> = (!database.is_empty()).then(|| format!("--database={database}")).into_iter().collect();
    args.extend(flag(o.force, "--force"));
    args
}

/// The command as a shell would need it typed: the dialogs' preview. `input` is piped in.
pub fn command_line(program: &Path, args: &[String], input: Option<&str>) -> String {
    let quote = |s: &str| {
        if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "@%+=:,./-_".contains(c)) {
            s.to_owned()
        } else {
            format!("'{}'", s.replace('\'', "'\\''"))
        }
    };
    let line = std::iter::once(program.to_string_lossy().into_owned())
        .chain(args.iter().cloned())
        .map(|a| quote(&a))
        .collect::<Vec<_>>()
        .join(" ");
    match input {
        Some(file) => format!("{line} < {}", quote(file)),
        None => line,
    }
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
            create: false,
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
    fn creates_the_database_of_the_archive_when_asked() {
        let options = DbPgRestoreOptions { create: true, ..restore() };
        let a = args(DbToolJob::PgRestore { file: "/tmp/shop.dump".into(), options });
        assert_eq!(a, ["--create", "--exit-on-error", "--verbose", "/tmp/shop.dump"]);
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
            None,
        );
        assert_eq!(line, r#"/usr/bin/pg_dump --port=5432 '--file=/tmp/my dump.sql' '--table=it'\''s'"#);
        let line = command_line(Path::new("mysql"), &["--force".into()], Some("/tmp/my dump.sql"));
        assert_eq!(line, "mysql --force < '/tmp/my dump.sql'");
    }

    fn mysqldump_options() -> DbMysqldumpOptions {
        DbMysqldumpOptions {
            databases: vec!["shop".into()],
            tables: vec![],
            add_drop_table: true,
            disable_keys: true,
            add_locks: true,
            add_drop_trigger: false,
            no_data: false,
            complete_insert: false,
            create_options: true,
            routines: false,
            events: false,
            single_transaction: true,
            lock_all_tables: false,
            masking_policies: None,
        }
    }

    #[test]
    fn mysqldump_flags_only_what_differs_from_its_defaults() {
        let job = DbToolJob::Mysqldump { file: "/tmp/shop.sql".into(), options: mysqldump_options() };
        assert_eq!(
            args(job),
            ["--result-file=/tmp/shop.sql", "--single-transaction", "--no-tablespaces", "--verbose", "shop"]
        );
        let options = DbMysqldumpOptions {
            add_drop_table: false,
            create_options: false,
            routines: true,
            lock_all_tables: true,
            masking_policies: Some(false),
            ..mysqldump_options()
        };
        let a = args(DbToolJob::Mysqldump { file: "/tmp/x.sql".into(), options });
        for expected in ["--skip-add-drop-table", "--skip-create-options", "--routines", "--lock-all-tables"] {
            assert!(a.contains(&expected.to_owned()), "{expected} missing from {a:?}");
        }
        assert!(a.contains(&"--skip-masking-policies".to_owned()), "{a:?}");
        assert!(!a.contains(&"--single-transaction".to_owned()), "{a:?}");
    }

    #[test]
    fn mysqldump_names_tables_only_of_a_single_database() {
        let tables = vec!["orders".to_owned(), "items".to_owned()];
        let one = DbMysqldumpOptions { tables: tables.clone(), ..mysqldump_options() };
        assert!(args(DbToolJob::Mysqldump { file: "f".into(), options: one }).ends_with(&[
            "shop".into(),
            "orders".into(),
            "items".into()
        ]));
        let two = DbMysqldumpOptions { databases: vec!["a".into(), "b".into()], tables, ..mysqldump_options() };
        assert!(args(DbToolJob::Mysqldump { file: "f".into(), options: two }).ends_with(&[
            "--databases".into(),
            "a".into(),
            "b".into()
        ]));
        let all = DbMysqldumpOptions { databases: vec![], ..mysqldump_options() };
        assert_eq!(args(DbToolJob::Mysqldump { file: "f".into(), options: all }).last().unwrap(), "--all-databases");
    }

    #[test]
    fn mysqldump_refuses_names_it_would_read_as_options() {
        let options = DbMysqldumpOptions { tables: vec!["--result-file=/etc/x".into()], ..mysqldump_options() };
        assert!(DbToolJob::Mysqldump { file: "f".into(), options }.check().is_err());
        assert!(DbToolJob::Mysqldump { file: "f".into(), options: mysqldump_options() }.check().is_ok());
    }

    #[test]
    fn mysql_reads_the_dump_from_its_standard_input() {
        let job = DbToolJob::Mysql {
            file: "/tmp/shop.sql".into(),
            options: DbMysqlOptions { database: " shop ".into(), force: true },
        };
        assert_eq!(args(job.clone()), ["--database=shop", "--force"]);
        assert_eq!(job.input(), Some("/tmp/shop.sql"));
        let none =
            DbToolJob::Mysql { file: String::new(), options: DbMysqlOptions { database: String::new(), force: false } };
        assert!(args(none.clone()).is_empty() && none.input().is_none());
    }

    #[test]
    fn reads_the_job_the_dialog_sends() {
        let json = r#"{"tool":"psql","file":"/tmp/a.sql","options":{"singleTransaction":true,"stopOnError":false}}"#;
        let job: DbToolJob = serde_json::from_str(json).unwrap();
        assert_eq!(job.tool(), DbTool::Psql);
    }
}
