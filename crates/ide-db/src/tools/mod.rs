//! Client tools of a database (`pg_dump`, `pg_restore`, `psql`): finding installed copies, the
//! arguments and environment that connect them like the data source, and running them.

mod jobs;
pub use jobs::*;

use crate::source::{DataSource, DbDriver, DbSslMode};
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DbTool {
    PgDump,
    PgRestore,
    Psql,
}

impl DbTool {
    pub fn program(self) -> &'static str {
        self.programs()[0]
    }

    /// Executable names.
    pub fn programs(self) -> &'static [&'static str] {
        match self {
            DbTool::PgDump => &["pg_dump"],
            DbTool::PgRestore => &["pg_restore"],
            DbTool::Psql => &["psql"],
        }
    }

    pub fn driver(self) -> DbDriver {
        DbDriver::Postgres
    }

    /// Whether `path` names this tool (`pg_dump`, `pg_dump.exe`, `pg_dump-17`…).
    /// The data source's password is handed only to such a program.
    pub fn is_program(self, path: &Path) -> bool {
        let Some(stem) = path.file_stem().and_then(OsStr::to_str) else { return false };
        self.programs().iter().any(|p| {
            stem.strip_prefix(p).is_some_and(|rest| {
                let digits = rest.strip_prefix(['-', '.', '_']).unwrap_or(rest);
                digits.chars().all(|c| c.is_ascii_digit())
            })
        })
    }
}

/// An installed copy of a tool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", rename = "DbToolInstall")]
pub struct ToolInstall {
    pub path: String,
    /// First line of `--version`, e.g. `pg_dump (PostgreSQL) 17.2`.
    pub version: String,
}

/// A line the tool wrote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", rename = "DbToolLine")]
pub struct ToolLine {
    pub stderr: bool,
    pub text: String,
}

/// Directories holding the tools that are often missing from `PATH`, by platform.
fn known_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if cfg!(target_os = "macos") {
        for prefix in ["/opt/homebrew", "/usr/local"] {
            dirs.push(PathBuf::from(format!("{prefix}/bin")));
            let opt = PathBuf::from(format!("{prefix}/opt"));
            for keg in ["libpq", "postgresql"] {
                dirs.extend(children(&opt, keg).into_iter().map(|d| d.join("bin")));
            }
        }
        dirs.extend(
            children(Path::new("/Applications/Postgres.app/Contents/Versions"), "").into_iter().map(|d| d.join("bin")),
        );
    } else if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(base) = std::env::var_os(var) {
                let root = PathBuf::from(base).join("PostgreSQL");
                dirs.extend(children(&root, "").into_iter().map(|d| d.join("bin")));
            }
        }
    } else {
        dirs.extend(children(Path::new("/usr/lib/postgresql"), "").into_iter().map(|d| d.join("bin")));
        dirs.extend(children(Path::new("/usr"), "pgsql-").into_iter().map(|d| d.join("bin")));
    }
    dirs
}

/// Subdirectories of `parent` whose name starts with `prefix`, newest version first.
fn children(parent: &Path, prefix: &str) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(parent) else { return Vec::new() };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_name().to_str().is_some_and(|n| n.starts_with(prefix)))
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort_by_key(|p| std::cmp::Reverse(version_key(&p.to_string_lossy())));
    dirs
}

/// The numbers in `text`, for comparing versions (`17.2` after `9.6`).
fn version_key(text: &str) -> Vec<u32> {
    text.split(|c: char| !c.is_ascii_digit()).filter_map(|n| n.parse().ok()).collect()
}

/// The installed copies of `tool` on `PATH` and in the usual install directories, newest first.
/// Blocking: runs each one's `--version`.
pub fn find_installs(tool: DbTool) -> Vec<ToolInstall> {
    let path = ide_core::process::host_var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
    dirs.extend(known_dirs());
    let mut seen = Vec::new();
    let mut out = Vec::new();
    for dir in dirs {
        for program in tool.programs() {
            let Some(found) = ide_core::process::find_executable(program, dir.as_os_str()) else { continue };
            let real = dunce::canonicalize(&found).unwrap_or_else(|_| found.clone());
            if seen.contains(&real) {
                continue;
            }
            seen.push(real);
            if let Ok(version) = version_of(&found) {
                out.push(ToolInstall { path: found.to_string_lossy().into_owned(), version });
            }
        }
    }
    out.sort_by_key(|i| std::cmp::Reverse(version_key(&i.version)));
    out
}

/// The first line `path --version` prints. Blocking.
pub fn version_of(path: &Path) -> IdeResult<String> {
    let (ok, text) = capture(path, "--version")?;
    match text.lines().next().map(str::trim).filter(|l| !l.is_empty()) {
        Some(line) if ok => Ok(line.to_owned()),
        _ => Err(IdeError::invalid(format!("{} is not a working executable", path.display()))),
    }
}

/// Runs `path arg` for at most five seconds; whether it succeeded, and its standard output.
fn capture(path: &Path, arg: &str) -> IdeResult<(bool, String)> {
    if !path.is_file() {
        return Err(IdeError::not_found(format!("{} does not exist", path.display())));
    }
    let mut cmd = std::process::Command::new(path);
    cmd.arg(arg).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    ide_core::process::prepare(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| IdeError::invalid(format!("cannot run {}: {e}", path.display())))?;
    let mut stdout = child.stdout.take().expect("piped");
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = std::io::Read::read_to_end(&mut stdout, &mut buf);
        buf
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(IdeError::invalid(format!("{} {arg} did not finish", path.display())));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let out = reader.join().unwrap_or_default();
    Ok((status.success(), String::from_utf8_lossy(&out).into_owned()))
}

/// What made a dump, read from its first bytes (a directory: its `toc.dat`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DbDumpKind {
    /// `pg_dump` custom or tar archive, or a directory archive: `pg_restore`.
    PostgresArchive,
    /// Plain SQL from `pg_dump`: `psql`.
    PostgresSql,
    /// `mysqldump` / `mariadb-dump`: not for the PostgreSQL tools.
    MysqlSql,
    Unknown,
}

/// Blocking: reads at most the first 4 KiB.
pub fn dump_kind(path: &Path) -> IdeResult<DbDumpKind> {
    use std::io::Read;
    if path.is_dir() {
        return Ok(if path.join("toc.dat").is_file() { DbDumpKind::PostgresArchive } else { DbDumpKind::Unknown });
    }
    let mut head = Vec::with_capacity(4096);
    std::fs::File::open(path)
        .map_err(|e| IdeError::not_found(format!("cannot read {}: {e}", path.display())))?
        .take(4096)
        .read_to_end(&mut head)?;
    Ok(kind_of(&head))
}

fn kind_of(head: &[u8]) -> DbDumpKind {
    // A tar archive keeps `toc.dat` first; its name starts the 512-byte header.
    if head.starts_with(b"PGDMP") || head.starts_with(b"toc.dat\0") {
        return DbDumpKind::PostgresArchive;
    }
    let text = String::from_utf8_lossy(head);
    let comments: Vec<&str> = text.lines().take(20).filter(|l| l.starts_with("--")).collect();
    if comments.iter().any(|l| l.contains("PostgreSQL database dump")) {
        DbDumpKind::PostgresSql
    } else if comments.iter().any(|l| l.starts_with("-- MySQL dump") || l.starts_with("-- MariaDB dump")) {
        DbDumpKind::MysqlSql
    } else {
        DbDumpKind::Unknown
    }
}

/// Arguments and environment that connect `tool` to `source` (already resolved, through its
/// tunnel when it has one). The password is left to [`prepare`].
pub fn connection(tool: DbTool, source: &DataSource) -> (Vec<String>, Vec<(String, String)>) {
    let mut args = Vec::new();
    let host = source.host.trim();
    if !host.is_empty() {
        args.push(format!("--host={host}"));
    }
    args.push(format!("--port={}", source.port.or(source.driver.default_port()).unwrap_or(5432)));
    if !source.user.trim().is_empty() {
        args.push(format!("--username={}", source.user.trim()));
    }
    if !source.database.is_empty() {
        args.push(format!("--dbname={}", source.database));
    }
    // Without a terminal a password prompt would wait forever: fail instead.
    args.push("--no-password".into());

    let mut env = vec![
        ("PGAPPNAME".to_owned(), format!("OpenIDEA {}", tool.program())),
        (
            "PGSSLMODE".to_owned(),
            match source.ssl {
                DbSslMode::Disable => "disable",
                DbSslMode::Prefer => "prefer",
                DbSslMode::Require => "require",
                DbSslMode::VerifyCa => "verify-ca",
                DbSslMode::VerifyFull => "verify-full",
            }
            .to_owned(),
        ),
    ];
    for (var, file) in [
        ("PGSSLROOTCERT", &source.ssl_ca_file),
        ("PGSSLCERT", &source.ssl_cert_file),
        ("PGSSLKEY", &source.ssl_key_file),
    ] {
        if !file.trim().is_empty() {
            env.push((var.to_owned(), ide_ssh::expand(file.trim()).to_string_lossy().into_owned()));
        }
    }
    if source.read_only {
        env.push(("PGOPTIONS".to_owned(), "-c default_transaction_read_only=on".to_owned()));
    }
    (args, env)
}

/// How a tool is started: connection arguments, then the job's, and the environment.
pub struct Prepared {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// The command for `job` against `source`. The password goes in `PGPASSWORD`, never in the
/// arguments, which other users of the machine can read in the process list.
pub fn prepare(job: &DbToolJob, source: &DataSource, password: Option<&str>) -> Prepared {
    let (mut args, mut env) = connection(job.tool(), source);
    args.extend(job.args());
    if let Some(p) = password.filter(|p| !p.is_empty()) {
        env.push(("PGPASSWORD".into(), p.to_owned()));
    }
    Prepared { args, env }
}

/// Runs `program` until it exits, passing its output in batches. Returns the exit code
/// (`None`: ended by a signal). Cancelling kills it and everything it started.
pub async fn run(
    program: &Path,
    args: &[String],
    env: &[(String, String)],
    cancel: &CancellationToken,
    mut on_output: impl FnMut(Vec<ToolLine>),
) -> IdeResult<Option<i32>> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    ide_core::process::prepare(cmd.as_std_mut());
    ide_core::process::own_group(cmd.as_std_mut());
    let mut child = cmd.spawn().map_err(|e| IdeError::invalid(format!("cannot start {}: {e}", program.display())))?;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    if let Some(out) = child.stdout.take() {
        forward(out, false, tx.clone());
    }
    if let Some(err) = child.stderr.take() {
        forward(err, true, tx);
    }

    let mut batch = Vec::new();
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    loop {
        tokio::select! {
            line = rx.recv() => match line {
                Some(line) => {
                    batch.push(line);
                    if batch.len() >= 500 {
                        on_output(std::mem::take(&mut batch));
                    }
                }
                None => break,
            },
            _ = tick.tick() => {
                if !batch.is_empty() {
                    on_output(std::mem::take(&mut batch));
                }
            }
            _ = cancel.cancelled() => {
                if let Some(pid) = child.id() {
                    ide_core::process::kill_tree_of(pid);
                }
                let _ = child.kill().await;
                return Err(IdeError::cancelled());
            }
        }
    }
    if !batch.is_empty() {
        on_output(batch);
    }
    let status = tokio::select! {
        status = child.wait() => status?,
        _ = cancel.cancelled() => {
            if let Some(pid) = child.id() {
                ide_core::process::kill_tree_of(pid);
            }
            let _ = child.kill().await;
            return Err(IdeError::cancelled());
        }
    };
    Ok(status.code())
}

fn forward(
    pipe: impl AsyncRead + Unpin + Send + 'static,
    stderr: bool,
    tx: tokio::sync::mpsc::UnboundedSender<ToolLine>,
) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(pipe);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let text = String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']).to_owned();
                    if tx.send(ToolLine { stderr, text }).is_err() {
                        break;
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pg() -> DataSource {
        DataSource {
            driver: DbDriver::Postgres,
            host: "db.example.test".into(),
            port: Some(6543),
            user: "app".into(),
            database: "shop".into(),
            ..DataSource::default()
        }
    }

    #[test]
    fn connects_like_the_data_source_without_prompting() {
        let (args, env) = connection(DbTool::PgDump, &pg());
        assert_eq!(args, ["--host=db.example.test", "--port=6543", "--username=app", "--dbname=shop", "--no-password"]);
        assert!(env.contains(&("PGSSLMODE".into(), "prefer".into())));
        assert!(!env.iter().any(|(k, _)| k == "PGPASSWORD" || k == "PGOPTIONS"));
    }

    #[test]
    fn default_port_and_optional_fields() {
        let source = DataSource { port: None, user: String::new(), database: String::new(), ..pg() };
        let (args, _) = connection(DbTool::Psql, &source);
        assert_eq!(args, ["--host=db.example.test", "--port=5432", "--no-password"]);
    }

    #[test]
    fn read_only_sources_refuse_writes() {
        let source = DataSource { read_only: true, ssl: DbSslMode::VerifyFull, ..pg() };
        let (_, env) = connection(DbTool::PgRestore, &source);
        assert!(env.contains(&("PGOPTIONS".into(), "-c default_transaction_read_only=on".into())));
        assert!(env.contains(&("PGSSLMODE".into(), "verify-full".into())));
    }

    #[test]
    fn only_the_tool_itself_is_accepted() {
        for ok in ["/usr/bin/pg_dump", "/pg/bin/pg_dump.exe", "/usr/bin/pg_dump-17", "/opt/pg_dump17"] {
            assert!(DbTool::PgDump.is_program(Path::new(ok)), "{ok}");
        }
        for bad in ["/usr/bin/pg_dumpall", "/bin/sh", "/usr/bin/pg_restore", "/tmp/evil"] {
            assert!(!DbTool::PgDump.is_program(Path::new(bad)), "{bad}");
        }
    }

    #[test]
    fn tells_dumps_apart_by_their_header() {
        assert_eq!(kind_of(b"PGDMP\x01\x0f"), DbDumpKind::PostgresArchive);
        assert_eq!(kind_of(b"toc.dat\0\0\0"), DbDumpKind::PostgresArchive);
        assert_eq!(kind_of(b"--\n-- PostgreSQL database dump\n--\n"), DbDumpKind::PostgresSql);
        assert_eq!(kind_of(b"-- MySQL dump 10.13  Distrib 8.4.6\n--\n"), DbDumpKind::MysqlSql);
        assert_eq!(kind_of(b"-- MariaDB dump 10.19  Distrib 11.4.2\n"), DbDumpKind::MysqlSql);
        assert_eq!(kind_of(b"CREATE TABLE t (id int);\n"), DbDumpKind::Unknown);
    }

    #[test]
    fn newer_versions_sort_first() {
        assert!(version_key("pg_dump (PostgreSQL) 17.2") > version_key("pg_dump (PostgreSQL) 9.6.24"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn streams_both_pipes_and_reports_the_exit_code() {
        let mut lines = Vec::new();
        let code = run(
            Path::new("/bin/sh"),
            &["-c".into(), "echo out; echo err >&2; exit 3".into()],
            &[],
            &CancellationToken::new(),
            |batch| lines.extend(batch),
        )
        .await
        .unwrap();
        assert_eq!(code, Some(3));
        assert!(lines.contains(&ToolLine { stderr: false, text: "out".into() }));
        assert!(lines.contains(&ToolLine { stderr: true, text: "err".into() }));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelling_stops_the_process() {
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            stop.cancel();
        });
        let result = run(Path::new("/bin/sh"), &["-c".into(), "sleep 30".into()], &[], &cancel, |_| {}).await;
        assert!(result.is_err());
    }

    /// A stand-in for `tool` that prints each argument on a line, then whether `PGPASSWORD`
    /// holds the expected password.
    #[cfg(unix)]
    fn echo_tool(dir: &Path, tool: DbTool) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(tool.program());
        std::fs::write(
            &path,
            "#!/bin/sh\nfor a in \"$@\"; do echo \"arg:$a\"; done\necho \"env:${PGPASSWORD:+set}\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_password_never_reaches_the_arguments() {
        const SECRET: &str = "s3cret-pass-do-not-leak";
        let dir = std::env::temp_dir().join(format!("openidea-tools-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("out.sql").to_string_lossy().into_owned();
        let jobs = [
            DbToolJob::PgDump {
                file: file.clone(),
                options: DbPgDumpOptions {
                    format: DbDumpFormat::Plain,
                    statements: DbDumpStatements::Copy,
                    content: DbDumpContent::All,
                    schemas: vec!["public".into()],
                    tables: vec![],
                    exclude_tables: vec![],
                    clean: true,
                    if_exists: true,
                    create: false,
                    no_owner: false,
                    no_privileges: false,
                    jobs: 1,
                },
            },
            DbToolJob::Psql {
                file: file.clone(),
                options: DbPsqlOptions { single_transaction: true, stop_on_error: true },
            },
        ];
        for job in jobs {
            let program = echo_tool(&dir, job.tool());
            let prepared = prepare(&job, &pg(), Some(SECRET));
            assert!(!prepared.args.iter().any(|a| a.contains(SECRET)), "{:?}", prepared.args);
            let mut lines = Vec::new();
            run(&program, &prepared.args, &prepared.env, &CancellationToken::new(), |b| lines.extend(b)).await.unwrap();
            let text: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
            assert!(text.contains(&"arg:--dbname=shop"), "{text:?}");
            assert!(!text.iter().any(|l| l.contains(SECRET)), "{text:?}");
            assert!(text.contains(&"env:set"), "the tool gets the password from PGPASSWORD: {text:?}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
