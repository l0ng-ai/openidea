//! Client tools of a database (`pg_dump`, `pg_restore`, `psql`, `mysqldump`, `mysql`): finding
//! installed copies, the arguments and environment that connect them like the data source, and
//! running them.

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
    Mysqldump,
    Mysql,
}

impl DbTool {
    pub fn program(self) -> &'static str {
        self.programs()[0]
    }

    /// Executable names, MariaDB's own after MySQL's.
    pub fn programs(self) -> &'static [&'static str] {
        match self {
            DbTool::PgDump => &["pg_dump"],
            DbTool::PgRestore => &["pg_restore"],
            DbTool::Psql => &["psql"],
            DbTool::Mysqldump => &["mysqldump", "mariadb-dump"],
            DbTool::Mysql => &["mysql", "mariadb"],
        }
    }

    pub fn driver(self) -> DbDriver {
        match self {
            DbTool::PgDump | DbTool::PgRestore | DbTool::Psql => DbDriver::Postgres,
            DbTool::Mysqldump | DbTool::Mysql => DbDriver::Mysql,
        }
    }

    /// Whether `path` names this tool (`pg_dump`, `pg_dump.exe`, `pg_dump-17`, `mariadb-dump`…).
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

/// Whether `executable` is MariaDB's client (`mariadb`, `mariadb-dump`), whose SSL options differ
/// from MySQL's.
fn is_mariadb(executable: &Path) -> bool {
    executable.file_stem().and_then(OsStr::to_str).is_some_and(|s| s.starts_with("mariadb"))
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

/// Directories holding the tools of `driver` that are often missing from `PATH`, by platform.
fn known_dirs(driver: DbDriver) -> Vec<PathBuf> {
    let mysql = driver == DbDriver::Mysql;
    let mut dirs = Vec::new();
    if cfg!(target_os = "macos") {
        for prefix in ["/opt/homebrew", "/usr/local"] {
            dirs.push(PathBuf::from(format!("{prefix}/bin")));
            let opt = PathBuf::from(format!("{prefix}/opt"));
            let kegs: &[&str] = if mysql { &["mysql-client", "mysql", "mariadb"] } else { &["libpq", "postgresql"] };
            for keg in kegs {
                dirs.extend(children(&opt, keg).into_iter().map(|d| d.join("bin")));
            }
        }
        if mysql {
            dirs.push(PathBuf::from("/usr/local/mysql/bin"));
        } else {
            dirs.extend(
                children(Path::new("/Applications/Postgres.app/Contents/Versions"), "")
                    .into_iter()
                    .map(|d| d.join("bin")),
            );
        }
    } else if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(base) = std::env::var_os(var) {
                let base = PathBuf::from(base);
                // MySQL installs to `MySQL\MySQL Server 8.4`, MariaDB to `MariaDB 11.4`.
                let roots: &[(&str, &str)] =
                    if mysql { &[("MySQL", "MySQL"), ("", "MariaDB")] } else { &[("PostgreSQL", "")] };
                for (dir, prefix) in roots {
                    dirs.extend(children(&base.join(dir), prefix).into_iter().map(|d| d.join("bin")));
                }
            }
        }
    } else if !mysql {
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
    dirs.extend(known_dirs(tool.driver()));
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

/// The long options `path --help` lists (`masking-policies` for `--masking-policies`), so a
/// dialog offers only options this copy knows. Blocking.
pub fn options_of(path: &Path) -> IdeResult<Vec<String>> {
    let (_, text) = capture(path, "--help")?;
    Ok(help_options(&text))
}

fn help_options(help: &str) -> Vec<String> {
    let mut out: Vec<String> = help
        .lines()
        .filter(|l| l.starts_with(' ') && l.trim_start().starts_with('-'))
        .filter_map(|l| {
            let at = l.find("--")?;
            let name: String =
                l[at + 2..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
            (!name.is_empty()).then_some(name)
        })
        .collect();
    out.sort();
    out.dedup();
    out
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
    /// `mysqldump` / `mariadb-dump`: `mysql`.
    MysqlSql,
    Unknown,
}

/// What a restore needs to know about a dump before it runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", rename = "DbDumpInfo")]
pub struct DumpInfo {
    pub kind: DbDumpKind,
    /// An SQL dump that runs `CREATE DATABASE` itself: `mysqldump --databases` / `--all-databases`,
    /// or `pg_dump --create`. Archives say `false`; `pg_restore --create` decides for them.
    pub creates_database: bool,
}

/// Blocking: reads at most the first 64 KiB, where both tools write their `CREATE DATABASE`.
pub fn dump_info(path: &Path) -> IdeResult<DumpInfo> {
    use std::io::Read;
    if path.is_dir() {
        let kind = if path.join("toc.dat").is_file() { DbDumpKind::PostgresArchive } else { DbDumpKind::Unknown };
        return Ok(DumpInfo { kind, creates_database: false });
    }
    let mut head = Vec::with_capacity(64 * 1024);
    std::fs::File::open(path)
        .map_err(|e| IdeError::not_found(format!("cannot read {}: {e}", path.display())))?
        .take(64 * 1024)
        .read_to_end(&mut head)?;
    Ok(info_of(&head))
}

fn info_of(head: &[u8]) -> DumpInfo {
    let kind = kind_of(head);
    let sql = matches!(kind, DbDumpKind::PostgresSql | DbDumpKind::MysqlSql);
    let creates_database = sql && String::from_utf8_lossy(head).lines().any(|l| l.starts_with("CREATE DATABASE "));
    DumpInfo { kind, creates_database }
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

/// Arguments and environment that connect `tool` at `executable` to `source` (already resolved,
/// through its tunnel when it has one). The password is left to [`prepare`].
pub fn connection(tool: DbTool, executable: &Path, source: &DataSource) -> (Vec<String>, Vec<(String, String)>) {
    if tool.driver() == DbDriver::Mysql {
        return (mysql_connection(tool, executable, source), Vec::new());
    }
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
        args.push(format!("--dbname={}", dbname_arg(&source.database)));
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

/// The database is the job's: a dump may name several.
fn mysql_connection(tool: DbTool, executable: &Path, source: &DataSource) -> Vec<String> {
    let mut args = Vec::new();
    let host = source.host.trim();
    if !host.is_empty() {
        args.push(format!("--host={host}"));
    }
    args.push(format!("--port={}", source.port.or(source.driver.default_port()).unwrap_or(3306)));
    if !source.user.trim().is_empty() {
        args.push(format!("--user={}", source.user.trim()));
    }
    // `localhost` would otherwise mean the Unix socket, not the port or the tunnel.
    args.push("--protocol=TCP".into());
    if is_mariadb(executable) {
        let flags: &[&str] = match source.ssl {
            DbSslMode::Disable => &["--skip-ssl"],
            DbSslMode::Prefer => &["--skip-ssl-verify-server-cert"],
            DbSslMode::Require => &["--ssl", "--skip-ssl-verify-server-cert"],
            DbSslMode::VerifyCa | DbSslMode::VerifyFull => &["--ssl", "--ssl-verify-server-cert"],
        };
        args.extend(flags.iter().map(|f| f.to_string()));
    } else {
        let mode = match source.ssl {
            DbSslMode::Disable => "DISABLED",
            DbSslMode::Prefer => "PREFERRED",
            DbSslMode::Require => "REQUIRED",
            DbSslMode::VerifyCa => "VERIFY_CA",
            DbSslMode::VerifyFull => "VERIFY_IDENTITY",
        };
        args.push(format!("--ssl-mode={mode}"));
    }
    for (flag, file) in
        [("--ssl-ca", &source.ssl_ca_file), ("--ssl-cert", &source.ssl_cert_file), ("--ssl-key", &source.ssl_key_file)]
    {
        if !file.trim().is_empty() {
            args.push(format!("{flag}={}", ide_ssh::expand(file.trim()).to_string_lossy()));
        }
    }
    if tool == DbTool::Mysql && source.read_only {
        args.push("--init-command=SET SESSION TRANSACTION READ ONLY".into());
    }
    args
}

/// `--dbname` reads a connection string or URI as connection parameters: such a database name
/// goes in quoted as the string's `dbname`, so it cannot pick another host or credentials.
fn dbname_arg(name: &str) -> String {
    if name.contains('=') || name.starts_with("postgresql://") || name.starts_with("postgres://") {
        format!("dbname='{}'", name.replace('\\', "\\\\").replace('\'', "\\'"))
    } else {
        name.to_owned()
    }
}

/// A MySQL client option file holding the password, readable by the user only; deleted on drop.
struct SecretFile(PathBuf);

impl SecretFile {
    fn mysql_password(password: &str) -> IdeResult<Self> {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!("openidea-mysql-{}.cnf", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&path)?;
        let secret = SecretFile(path);
        let escaped = password.replace('\\', "\\\\").replace('"', "\\\"");
        writeln!(file, "[client]\npassword=\"{escaped}\"")?;
        Ok(secret)
    }

    /// `mysqldump` / `mysql` accept it only as their first argument.
    fn arg(&self) -> String {
        format!("--defaults-extra-file={}", self.0.display())
    }
}

impl Drop for SecretFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// How a tool is started: connection arguments, then the job's, the environment, and the file
/// piped to its standard input. Keep it until the tool exits: it owns the password file.
pub struct Prepared {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub input: Option<PathBuf>,
    _secret: Option<SecretFile>,
}

/// The command for `job` at `executable` against `source`. The password goes in `PGPASSWORD` or
/// a MySQL option file, never in the arguments, which other users of the machine can read in the
/// process list.
pub fn prepare(job: &DbToolJob, executable: &Path, source: &DataSource, password: Option<&str>) -> IdeResult<Prepared> {
    job.check()?;
    let tool = job.tool();
    let (mut args, mut env) = connection(tool, executable, source);
    args.extend(job.args());
    let mut secret = None;
    match password.filter(|p| !p.is_empty()) {
        Some(p) if tool.driver() == DbDriver::Mysql => {
            let file = SecretFile::mysql_password(p)?;
            args.insert(0, file.arg());
            secret = Some(file);
        }
        Some(p) => env.push(("PGPASSWORD".into(), p.to_owned())),
        None => {}
    }
    Ok(Prepared { args, env, input: job.input().map(PathBuf::from), _secret: secret })
}

/// Runs `program` until it exits, passing its output in batches; `input` is piped to its standard
/// input. Returns the exit code (`None`: ended by a signal). Cancelling kills it and everything it
/// started.
pub async fn run(
    program: &Path,
    args: &[String],
    env: &[(String, String)],
    input: Option<&Path>,
    cancel: &CancellationToken,
    mut on_output: impl FnMut(Vec<ToolLine>),
) -> IdeResult<Option<i32>> {
    let stdin = match input {
        Some(path) => Stdio::from(
            std::fs::File::open(path)
                .map_err(|e| IdeError::not_found(format!("cannot read {}: {e}", path.display())))?,
        ),
        None => Stdio::null(),
    };
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(stdin)
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
        let (args, env) = connection(DbTool::PgDump, Path::new("pg_dump"), &pg());
        assert_eq!(args, ["--host=db.example.test", "--port=6543", "--username=app", "--dbname=shop", "--no-password"]);
        assert!(env.contains(&("PGSSLMODE".into(), "prefer".into())));
        assert!(!env.iter().any(|(k, _)| k == "PGPASSWORD" || k == "PGOPTIONS"));
    }

    #[test]
    fn a_database_named_like_connection_parameters_stays_a_name() {
        for (name, arg) in [
            ("host=evil.example dbname=p", r"--dbname=dbname='host=evil.example dbname=p'"),
            (r"it's=\x", r"--dbname=dbname='it\'s=\\x'"),
            ("postgresql://evil.example/p", "--dbname=dbname='postgresql://evil.example/p'"),
        ] {
            let (args, _) =
                connection(DbTool::PgDump, Path::new("pg_dump"), &DataSource { database: name.into(), ..pg() });
            assert!(args.contains(&arg.to_owned()), "{args:?}");
        }
    }

    #[test]
    fn default_port_and_optional_fields() {
        let source = DataSource { port: None, user: String::new(), database: String::new(), ..pg() };
        let (args, _) = connection(DbTool::Psql, Path::new("psql"), &source);
        assert_eq!(args, ["--host=db.example.test", "--port=5432", "--no-password"]);
    }

    #[test]
    fn read_only_sources_refuse_writes() {
        let source = DataSource { read_only: true, ssl: DbSslMode::VerifyFull, ..pg() };
        let (_, env) = connection(DbTool::PgRestore, Path::new("pg_restore"), &source);
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
    fn mysql_tools_accept_mariadb_names_only_for_themselves() {
        assert!(DbTool::Mysqldump.is_program(Path::new("/usr/bin/mariadb-dump")));
        assert!(DbTool::Mysql.is_program(Path::new("/opt/homebrew/opt/mysql-client/bin/mysql")));
        assert!(!DbTool::Mysql.is_program(Path::new("/usr/bin/mysqldump")));
        assert!(!DbTool::Mysql.is_program(Path::new("/usr/bin/mariadb-dump")));
        assert!(!DbTool::Mysqldump.is_program(Path::new("/usr/bin/mysqlpump")));
    }

    #[test]
    fn mysql_connects_over_tcp_with_the_ssl_flags_of_its_client() {
        let source = DataSource {
            driver: DbDriver::Mysql,
            host: "localhost".into(),
            port: None,
            user: "app".into(),
            read_only: true,
            ..DataSource::default()
        };
        let (args, env) = connection(DbTool::Mysql, Path::new("/usr/bin/mysql"), &source);
        assert_eq!(
            args,
            [
                "--host=localhost",
                "--port=3306",
                "--user=app",
                "--protocol=TCP",
                "--ssl-mode=PREFERRED",
                "--init-command=SET SESSION TRANSACTION READ ONLY"
            ]
        );
        assert!(env.is_empty());
        let (args, _) = connection(DbTool::Mysqldump, Path::new("/usr/bin/mariadb-dump"), &source);
        assert!(args.contains(&"--skip-ssl-verify-server-cert".to_owned()));
        assert!(!args.iter().any(|a| a.starts_with("--ssl-mode") || a.starts_with("--init-command")));
    }

    #[test]
    fn the_password_file_is_private_and_removed() {
        let file = SecretFile::mysql_password(r#"p"a\ss"#).unwrap();
        let path = file.arg().trim_start_matches("--defaults-extra-file=").to_owned();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text, "[client]\npassword=\"p\\\"a\\\\ss\"\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        drop(file);
        assert!(!Path::new(&path).exists());
    }

    #[test]
    fn reads_long_options_from_help() {
        let help = "Usage: mysqldump [OPTIONS]\n  -A, --all-databases Dump all.\n  --masking-policies  Dump masking\n                      policies (--not-an-option).\n  -y, --no-tablespaces \n  -f, --file=FILENAME  output file\n";
        assert_eq!(help_options(help), ["all-databases", "file", "masking-policies", "no-tablespaces"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pipes_the_input_file() {
        let file = std::env::temp_dir().join(format!("openidea-input-{}", uuid::Uuid::new_v4()));
        std::fs::write(&file, "from the file\n").unwrap();
        let mut lines = Vec::new();
        run(Path::new("/bin/cat"), &[], &[], Some(&file), &CancellationToken::new(), |b| lines.extend(b))
            .await
            .unwrap();
        std::fs::remove_file(&file).unwrap();
        assert_eq!(lines, [ToolLine { stderr: false, text: "from the file".into() }]);
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
    fn sees_a_dump_that_creates_its_own_database() {
        let one = b"-- MySQL dump 10.13\n--\n-- Host: localhost    Database: shop\nCREATE TABLE `items` (id int);\n";
        assert!(!info_of(one).creates_database);
        let several = b"-- MySQL dump 10.13\n--\n-- Current Database: `shop`\n--\n\nCREATE DATABASE /*!32312 IF NOT EXISTS*/ `shop`;\nUSE `shop`;\n";
        assert!(info_of(several).creates_database);
        let pg = b"--\n-- PostgreSQL database dump\n--\nSET client_encoding = 'UTF8';\nCREATE DATABASE shop WITH TEMPLATE = template0;\n\\connect shop\n";
        assert_eq!(info_of(pg), DumpInfo { kind: DbDumpKind::PostgresSql, creates_database: true });
        assert!(!info_of(b"CREATE DATABASE x;\n").creates_database, "only for a dump the tools wrote");
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
            None,
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
        let result = run(Path::new("/bin/sh"), &["-c".into(), "sleep 30".into()], &[], None, &cancel, |_| {}).await;
        assert!(result.is_err());
    }

    /// A stand-in for `tool` that prints each argument on a line, then whether it got a password
    /// from `PGPASSWORD` or a MySQL option file.
    #[cfg(unix)]
    fn echo_tool(dir: &Path, tool: DbTool) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(tool.program());
        std::fs::write(
            &path,
            concat!(
                "#!/bin/sh\n",
                "for a in \"$@\"; do echo \"arg:$a\"; case \"$a\" in --defaults-extra-file=*)\n",
                "  grep -q '^password=' \"${a#*=}\" && echo env:set;; esac; done\n",
                "[ -n \"$PGPASSWORD\" ] && echo env:set\n",
                "exit 0\n",
            ),
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
            DbToolJob::Mysqldump {
                file: file.clone(),
                options: DbMysqldumpOptions {
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
                },
            },
            DbToolJob::Mysql { file: String::new(), options: DbMysqlOptions { database: "shop".into(), force: false } },
        ];
        for job in jobs {
            let mysql = job.tool().driver() == DbDriver::Mysql;
            let source = if mysql { DataSource { driver: DbDriver::Mysql, ..pg() } } else { pg() };
            let program = echo_tool(&dir, job.tool());
            let prepared = prepare(&job, &program, &source, Some(SECRET)).unwrap();
            assert!(!prepared.args.iter().any(|a| a.contains(SECRET)), "{:?}", prepared.args);
            assert!(!mysql || prepared.env.is_empty(), "{:?}", prepared.env);
            let mut lines = Vec::new();
            run(&program, &prepared.args, &prepared.env, None, &CancellationToken::new(), |b| lines.extend(b))
                .await
                .unwrap();
            let text: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
            let database = if mysql { "shop" } else { "--dbname=shop" };
            assert!(text.iter().any(|l| l.strip_prefix("arg:").is_some_and(|a| a.ends_with(database))), "{text:?}");
            assert!(!text.iter().any(|l| l.contains(SECRET)), "{text:?}");
            assert!(text.contains(&"env:set"), "the tool gets the password: {text:?}");
            if mysql {
                let file = prepared.args[0].trim_start_matches("--defaults-extra-file=").to_owned();
                drop(prepared);
                assert!(!Path::new(&file).exists(), "the password file outlives the run");
            }
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
