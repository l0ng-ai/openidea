//! Data sources: per-project connection settings in `.openidea/data-sources.toml`.
//! Passwords never go there: saved ones live in [`crate::secrets`], the others
//! only in memory for the session.

use ide_core::{IdeError, IdeResult, IpcPath, project_dir};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

const FILE: &str = "data-sources.toml";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DbDriver {
    Sqlite,
    Postgres,
    /// MySQL and MariaDB.
    Mysql,
    /// Microsoft SQL Server.
    SqlServer,
}

impl DbDriver {
    pub fn default_port(self) -> Option<u16> {
        match self {
            DbDriver::Sqlite => None,
            DbDriver::Postgres => Some(5432),
            DbDriver::Mysql => Some(3306),
            DbDriver::SqlServer => Some(1433),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DbSslMode {
    Disable,
    #[default]
    Prefer,
    Require,
    /// Require, and check the server certificate against the CA file.
    VerifyCa,
    /// [`DbSslMode::VerifyCa`], and check that the certificate names the host.
    VerifyFull,
}

/// IDEA's data source colours (tree node and console tab tint), e.g. red for production.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DbColor {
    Red,
    Orange,
    Yellow,
    Green,
    Blue,
    Violet,
}

/// Transaction control of the data source's consoles.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DbTxMode {
    #[default]
    Auto,
    Manual,
}

/// Options tab: session settings applied to every connection.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct DbOptions {
    pub transaction: DbTxMode,
    /// PostgreSQL `search_path` (unqualified names resolve there).
    pub default_schema: String,
    /// Session time zone (`TimeZone` / `time_zone`); empty keeps the default.
    pub time_zone: String,
    /// Statements run on every new connection.
    pub startup_script: String,
    /// Run `SELECT 1` this often while connected.
    pub keep_alive_secs: Option<u32>,
    /// Disconnect after this long without statements (enforced by the UI, which sees the activity).
    pub auto_disconnect_secs: Option<u32>,
    /// PostgreSQL: show only the configured database, its schemas right under the data source.
    pub single_database: bool,
}

/// Schemas tab: the databases / schemas the tree shows. Names may use `*` and `?`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct DbIntrospection {
    pub all_databases: bool,
    pub databases: Vec<String>,
    pub all_schemas: bool,
    pub schemas: Vec<String>,
    /// `pg_catalog`, `information_schema`, `mysql`…, and service databases (`rdsadmin`…).
    pub show_system: bool,
    /// PostgreSQL template databases (`template0`, `template1`).
    pub show_templates: bool,
    /// Object filter: the tree lists only tables, views, routines and sequences matching
    /// one of these patterns (`*`, `?`; separated by commas or spaces). Empty: all.
    pub object_filter: String,
}

impl Default for DbIntrospection {
    fn default() -> Self {
        Self {
            all_databases: true,
            databases: Vec::new(),
            all_schemas: true,
            schemas: Vec::new(),
            show_system: false,
            show_templates: false,
            object_filter: String::new(),
        }
    }
}

/// Advanced tab: a driver property. PostgreSQL: run-time parameters (and
/// `application_name`); MySQL: session variables (and `charset`, `collation`);
/// SQLite: pragmas. See [`crate::conn`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct DbProperty {
    pub name: String,
    pub value: String,
}

/// How the SSH tunnel authenticates (shared with Settings › SSH Configurations).
pub use ide_core::remote_settings::SshAuth as DbSshAuth;

/// Connect through an SSH tunnel: the database host and port are reached from `host`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct DbSsh {
    pub enabled: bool,
    /// A Settings › SSH Configurations id to connect with; empty = the fields below.
    pub config: String,
    /// Host name, or a `Host` alias of `~/.ssh/config` with [`DbSshAuth::OpenSsh`].
    pub host: String,
    pub port: Option<u16>,
    pub user: String,
    pub auth: DbSshAuth,
    /// Private key for [`DbSshAuth::KeyPair`]; `~/` is the home directory.
    pub key_file: String,
    /// Keep the SSH password / key passphrase in the saved passwords.
    pub save_secret: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct DataSource {
    pub id: String,
    pub name: String,
    pub driver: DbDriver,
    pub host: String,
    pub port: Option<u16>,
    pub database: String,
    pub user: String,
    /// SQLite database file (absolute, or relative to the project root).
    pub file: Option<IpcPath>,
    pub ssl: DbSslMode,
    /// Keep the password in the saved passwords.
    pub save_password: bool,
    /// Refuse statements other than queries (enforced by the database session where possible).
    pub read_only: bool,
    /// SSH tunnel settings (`None`: never configured; kept but unused when not `enabled`).
    pub ssh: Option<DbSsh>,
    /// Wire-compatible product preset (`cockroachdb`, `tidb`…; empty: the driver itself).
    pub vendor: String,
    pub color: Option<DbColor>,
    pub comment: String,
    /// Connect with [`DataSource::url`] instead of the host / port / database fields.
    pub url_only: bool,
    pub url: String,
    /// PEM files; `~/` is the home directory.
    pub ssl_ca_file: String,
    pub ssl_cert_file: String,
    pub ssl_key_file: String,
    pub options: DbOptions,
    pub introspection: DbIntrospection,
    pub properties: Vec<DbProperty>,
}

impl Default for DataSource {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            driver: DbDriver::Sqlite,
            host: "localhost".into(),
            port: None,
            database: String::new(),
            user: String::new(),
            file: None,
            ssl: DbSslMode::Prefer,
            save_password: false,
            read_only: false,
            ssh: None,
            vendor: String::new(),
            color: None,
            comment: String::new(),
            url_only: false,
            url: String::new(),
            ssl_ca_file: String::new(),
            ssl_cert_file: String::new(),
            ssl_key_file: String::new(),
            options: DbOptions::default(),
            introspection: DbIntrospection::default(),
            properties: Vec::new(),
        }
    }
}

/// The connection settings of a URL (`jdbc:` prefix allowed).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedUrl {
    pub driver: Option<DbDriver>,
    pub host: String,
    pub port: Option<u16>,
    pub database: String,
    pub user: String,
    pub password: Option<String>,
    /// Query parameters, in order.
    pub params: Vec<(String, String)>,
    /// SQLite file.
    pub file: Option<String>,
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    let hex = |i: usize| b.get(i).and_then(|&c| (c as char).to_digit(16));
    while i < b.len() {
        if b[i] == b'%'
            && let (Some(h), Some(l)) = (hex(i + 1), hex(i + 2))
        {
            out.push((h * 16 + l) as u8);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The driver speaking the protocol of URL scheme `scheme` (wire-compatible products included).
pub fn scheme_driver(scheme: &str) -> Option<DbDriver> {
    match scheme.to_ascii_lowercase().as_str() {
        "postgres" | "postgresql" | "pgsql" | "redshift" | "cockroachdb" | "cockroach" | "yugabytedb"
        | "timescaledb" | "greenplum" => Some(DbDriver::Postgres),
        "mysql" | "mariadb" | "tidb" | "singlestore" | "memsql" | "oceanbase" => Some(DbDriver::Mysql),
        "sqlserver" | "mssql" | "mssqlserver" => Some(DbDriver::SqlServer),
        "sqlite" | "sqlite3" => Some(DbDriver::Sqlite),
        _ => None,
    }
}

/// Parses `scheme://[user[:password]@]host[:port][/database][?k=v&…]`, `jdbc:` forms
/// included, and `sqlite:path`.
pub fn parse_url(raw: &str) -> IdeResult<ParsedUrl> {
    let bad = || IdeError::invalid(format!("not a database URL: {raw}"));
    let url = raw.trim();
    let url = url.strip_prefix("jdbc:").or_else(|| url.strip_prefix("JDBC:")).unwrap_or(url);
    let (scheme, rest) = url.split_once(':').ok_or_else(bad)?;
    let driver = scheme_driver(scheme).ok_or_else(bad)?;
    if driver == DbDriver::Sqlite {
        let file = rest.strip_prefix("//").unwrap_or(rest);
        let file = file.split('?').next().unwrap_or_default();
        if file.is_empty() {
            return Err(bad());
        }
        return Ok(ParsedUrl { driver: Some(driver), file: Some(percent_decode(file)), ..Default::default() });
    }
    let rest = rest.strip_prefix("//").ok_or_else(bad)?;
    let (main, query) = rest.split_once('?').unwrap_or((rest, ""));
    let (authority, database) = main.split_once('/').unwrap_or((main, ""));
    let (userinfo, hostport) = match authority.rsplit_once('@') {
        Some((u, h)) => (Some(u), h),
        None => (None, authority),
    };
    // Several hosts (failover lists): the first.
    let hostport = hostport.split(',').next().unwrap_or_default();
    let (host, port) = if let Some(v6) = hostport.strip_prefix('[') {
        let (h, after) = v6.split_once(']').ok_or_else(bad)?;
        (h.to_owned(), after.strip_prefix(':'))
    } else {
        match hostport.rsplit_once(':') {
            Some((h, p)) => (h.to_owned(), Some(p)),
            None => (hostport.to_owned(), None),
        }
    };
    let port = match port.filter(|p| !p.is_empty()) {
        Some(p) => Some(p.parse::<u16>().map_err(|_| bad())?),
        None => None,
    };
    let mut parsed = ParsedUrl {
        driver: Some(driver),
        host,
        port,
        database: percent_decode(database.trim_end_matches('/')),
        ..Default::default()
    };
    if let Some(u) = userinfo {
        let (user, password) = match u.split_once(':') {
            Some((u, p)) => (u, Some(percent_decode(p))),
            None => (u, None),
        };
        parsed.user = percent_decode(user);
        parsed.password = password;
    }
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let (k, v) = (percent_decode(k), percent_decode(v));
        match k.as_str() {
            "user" if parsed.user.is_empty() => parsed.user = v,
            "password" if parsed.password.is_none() => parsed.password = Some(v),
            _ => parsed.params.push((k, v)),
        }
    }
    Ok(parsed)
}

impl DataSource {
    /// The settings to connect with: with [`DataSource::url_only`], host, port,
    /// database, user, SSL and driver properties come from the URL (properties
    /// of the Advanced tab still apply after the URL's).
    pub fn resolved(&self) -> IdeResult<DataSource> {
        if !self.url_only {
            return Ok(self.clone());
        }
        let u = parse_url(&self.url)?;
        let mut s = self.clone();
        if let Some(d) = u.driver
            && d != s.driver
        {
            return Err(IdeError::invalid(format!("the URL is not for the {:?} driver", s.driver)));
        }
        if s.driver == DbDriver::Sqlite {
            s.file = u.file.map(IpcPath::from);
            return Ok(s);
        }
        s.host = u.host;
        s.port = u.port;
        s.database = u.database;
        if !u.user.is_empty() {
            s.user = u.user;
        }
        let mut properties = Vec::new();
        for (k, v) in u.params {
            match k.to_ascii_lowercase().as_str() {
                "sslmode" | "ssl-mode" => {
                    s.ssl = match v.to_ascii_lowercase().replace('-', "_").as_str() {
                        "disable" | "disabled" => DbSslMode::Disable,
                        "require" | "required" => DbSslMode::Require,
                        "verify_ca" => DbSslMode::VerifyCa,
                        "verify_full" | "verify_identity" => DbSslMode::VerifyFull,
                        _ => DbSslMode::Prefer,
                    }
                }
                "sslrootcert" | "ssl-ca" | "sslca" => s.ssl_ca_file = v,
                "sslcert" | "ssl-cert" => s.ssl_cert_file = v,
                "sslkey" | "ssl-key" => s.ssl_key_file = v,
                _ => properties.push(DbProperty { name: k, value: v }),
            }
        }
        properties.append(&mut s.properties);
        s.properties = properties;
        Ok(s)
    }

    /// The password written in the URL of a [`DataSource::url_only`] data source.
    pub fn url_password(&self) -> Option<String> {
        if !self.url_only {
            return None;
        }
        parse_url(&self.url).ok()?.password
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SourcesFile {
    #[serde(default, rename = "data-source")]
    sources: Vec<DataSource>,
}

pub fn load(root: &Path) -> IdeResult<Vec<DataSource>> {
    let path = project_dir::path(root, FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let file: SourcesFile = toml::from_str(&text).map_err(|e| IdeError::invalid(format!("{}: {e}", path.display())))?;
    Ok(file.sources)
}

pub fn save(root: &Path, sources: &[DataSource]) -> IdeResult<()> {
    for s in sources {
        if s.id.is_empty() || s.name.trim().is_empty() {
            return Err(IdeError::invalid("every data source needs an id and a name"));
        }
    }
    let path = project_dir::path(root, FILE);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let text = toml::to_string_pretty(&SourcesFile { sources: sources.to_vec() })
        .map_err(|e| IdeError::internal(e.to_string()))?;
    std::fs::write(path, text)?;
    Ok(())
}

/// Credential store access. Blocking (may show an OS prompt): call off the async runtime.
/// Keys are data source ids; [`secrets::ssh_key`] names the SSH password / passphrase.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_without_passwords() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(load(tmp.path()).unwrap().is_empty());
        let s = DataSource {
            id: "a1".into(),
            name: "local".into(),
            driver: DbDriver::Postgres,
            port: Some(5433),
            database: "app".into(),
            user: "me".into(),
            save_password: true,
            ..Default::default()
        };
        save(tmp.path(), std::slice::from_ref(&s)).unwrap();
        let text = std::fs::read_to_string(tmp.path().join(".openidea/data-sources.toml")).unwrap();
        assert!(!text.contains("password ="), "{text}");
        assert_eq!(load(tmp.path()).unwrap(), vec![s]);
        assert!(save(tmp.path(), &[DataSource::default()]).is_err());
    }

    #[test]
    fn reads_configs_written_before_the_new_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".openidea");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(FILE),
            "[[data-source]]\nid = \"a\"\nname = \"old\"\ndriver = \"postgres\"\nhost = \"db\"\nssl = \"require\"\n",
        )
        .unwrap();
        let s = load(tmp.path()).unwrap().remove(0);
        assert_eq!(s.ssl, DbSslMode::Require);
        assert!(s.introspection.all_databases && s.introspection.all_schemas);
        assert_eq!((s.color, s.url_only, s.options.transaction), (None, false, DbTxMode::Auto));
    }

    #[test]
    fn round_trips_the_new_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let s = DataSource {
            id: "b".into(),
            name: "prod".into(),
            driver: DbDriver::Mysql,
            vendor: "tidb".into(),
            color: Some(DbColor::Red),
            comment: "careful".into(),
            ssl: DbSslMode::VerifyFull,
            ssl_ca_file: "~/ca.pem".into(),
            options: DbOptions { time_zone: "UTC".into(), keep_alive_secs: Some(60), ..Default::default() },
            introspection: DbIntrospection { all_schemas: false, schemas: vec!["app*".into()], ..Default::default() },
            properties: vec![DbProperty { name: "sql_mode".into(), value: "ANSI".into() }],
            ..Default::default()
        };
        save(tmp.path(), std::slice::from_ref(&s)).unwrap();
        assert_eq!(load(tmp.path()).unwrap(), vec![s]);
    }

    #[test]
    fn sqlserver_defaults() {
        assert_eq!(DbDriver::SqlServer.default_port(), Some(1433));
        assert_eq!(scheme_driver("sqlserver"), Some(DbDriver::SqlServer));
        assert_eq!(scheme_driver("mssql"), Some(DbDriver::SqlServer));
        assert_eq!(scheme_driver("mssqlserver"), Some(DbDriver::SqlServer));
    }

    #[test]
    fn parses_urls() {
        let u = parse_url("jdbc:postgresql://ann:s%40cret@db.local:5433/shop?sslmode=require&search_path=app").unwrap();
        assert_eq!(u.driver, Some(DbDriver::Postgres));
        assert_eq!((u.host.as_str(), u.port, u.database.as_str()), ("db.local", Some(5433), "shop"));
        assert_eq!((u.user.as_str(), u.password.as_deref()), ("ann", Some("s@cret")));
        assert_eq!(u.params, vec![("sslmode".into(), "require".into()), ("search_path".into(), "app".into())]);
        let u = parse_url("mysql://[::1]/app?user=root").unwrap();
        assert_eq!((u.host.as_str(), u.port, u.user.as_str()), ("::1", None, "root"));
        assert_eq!(parse_url("jdbc:redshift://r:5439/dev").unwrap().driver, Some(DbDriver::Postgres));
        assert_eq!(parse_url("tidb://h:4000").unwrap().driver, Some(DbDriver::Mysql));
        assert_eq!(parse_url("sqlite:/tmp/a.db").unwrap().file.as_deref(), Some("/tmp/a.db"));
        assert!(parse_url("oracle://x").is_err());
        assert!(parse_url("postgres://h:99999/db").is_err());
    }

    #[test]
    fn url_only_sources_connect_with_the_url() {
        let s = DataSource {
            driver: DbDriver::Postgres,
            user: "fallback".into(),
            url_only: true,
            url: "postgres://ann:pw@h:6543/app?sslmode=verify-full&sslrootcert=/ca.pem&statement_timeout=5000".into(),
            properties: vec![DbProperty { name: "work_mem".into(), value: "64MB".into() }],
            ..Default::default()
        };
        let r = s.resolved().unwrap();
        assert_eq!((r.host.as_str(), r.port, r.database.as_str(), r.user.as_str()), ("h", Some(6543), "app", "ann"));
        assert_eq!((r.ssl, r.ssl_ca_file.as_str()), (DbSslMode::VerifyFull, "/ca.pem"));
        let names: Vec<_> = r.properties.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["statement_timeout", "work_mem"]);
        assert_eq!(s.url_password().as_deref(), Some("pw"));
        assert!(DataSource { url: "mysql://h/db".into(), ..s.clone() }.resolved().is_err());
        assert_eq!(DataSource { url_only: false, ..s }.resolved().unwrap().host, "localhost");
    }
}
