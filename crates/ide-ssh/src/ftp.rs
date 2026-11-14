//! Remote files over FTP, or FTPS with `AUTH TLS`. Remote paths are POSIX strings.

use crate::sftp::{RemoteEntry, join, parent};
use ide_core::remote_settings::FtpConnection;
use ide_core::{CancellationToken, IdeError, IdeResult, error::ErrorKind};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use suppaftp::list::{File, ListParser, PosixPexQuery};
use suppaftp::tokio::{AsyncRustlsConnector, AsyncRustlsFtpStream};
use suppaftp::types::FileType;
use suppaftp::{FtpError, Mode, Status};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// Key of an FTP deployment server's password among the saved passwords.
pub fn secret_key(server: &str) -> String {
    format!("ftp:{server}")
}

/// The server's reply text (it starts with the reply code), or the error.
fn describe(e: &FtpError) -> String {
    match e {
        FtpError::UnexpectedResponse(r) => r.as_string().unwrap_or_else(|_| r.to_string()),
        FtpError::SecureError(s) => s.trim_start_matches("Secure error: ").to_owned(),
        e => e.to_string(),
    }
}

fn err(path: &str, e: FtpError) -> IdeError {
    let kind = match &e {
        FtpError::UnexpectedResponse(r) if r.status == Status::FileUnavailable => ErrorKind::NotFound,
        FtpError::UnexpectedResponse(r) if r.status == Status::NotLoggedIn => ErrorKind::PermissionDenied,
        _ => ErrorKind::Io,
    };
    IdeError::new(kind, format!("{path}: {}", describe(&e)))
}

fn tls() -> IdeResult<AsyncRustlsConnector> {
    use rustls_platform_verifier::BuilderVerifierExt;
    let fail = |e: String| IdeError::internal(format!("FTPS: {e}"));
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| fail(e.to_string()))?
        .with_platform_verifier()
        .map_err(|e| fail(e.to_string()))?
        .with_no_client_auth();
    Ok(tokio_rustls::TlsConnector::from(Arc::new(config)).into())
}

fn permissions(f: &File) -> String {
    [PosixPexQuery::Owner, PosixPexQuery::Group, PosixPexQuery::Others]
        .into_iter()
        .flat_map(|q| {
            [
                if f.can_read(q) { 'r' } else { '-' },
                if f.can_write(q) { 'w' } else { '-' },
                if f.can_execute(q) { 'x' } else { '-' },
            ]
        })
        .collect()
}

fn seconds(t: SystemTime) -> Option<u32> {
    t.duration_since(UNIX_EPOCH).ok()?.as_secs().try_into().ok()
}

/// `YYYYMMDDHHMMSS` (UTC) for `MFMT`.
fn mfmt_time(seconds: u32) -> String {
    let days = i64::from(seconds / 86_400);
    let rem = seconds % 86_400;
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}{month:02}{day:02}{:02}{:02}{:02}", rem / 3600, rem / 60 % 60, rem % 60)
}

/// One logged-in FTP control connection; operations take turns on it.
pub struct FtpFs {
    ftp: tokio::sync::Mutex<AsyncRustlsFtpStream>,
    home: String,
    /// `MLSD` listings (exact UTC times); otherwise `LIST`, with `MDTM` for times when supported.
    mlsd: bool,
    mdtm: bool,
}

impl FtpFs {
    /// Connects and logs in; an empty user logs in anonymously.
    pub async fn connect(c: &FtpConnection, secure: bool, password: Option<String>) -> IdeResult<Self> {
        let host = c.host.trim();
        if host.is_empty() {
            return Err(IdeError::invalid("the deployment server has no FTP host"));
        }
        let port = c.port.unwrap_or(21);
        let user = c.user.trim();
        let label = if user.is_empty() { format!("{host}:{port}") } else { format!("{user}@{host}:{port}") };
        let (user, password) = if user.is_empty() {
            ("anonymous", "anonymous@".to_owned())
        } else {
            let password = password.ok_or_else(|| {
                IdeError::new(ErrorKind::PermissionDenied, format!("FTP password required for {label}"))
            })?;
            (user, password)
        };
        let connect = async {
            let mut ftp = AsyncRustlsFtpStream::connect((host, port)).await.map_err(|e| err(&label, e))?;
            if secure {
                ftp = ftp.into_secure(tls()?, host).await.map_err(|e| err(&label, e))?;
            }
            IdeResult::Ok(ftp)
        };
        let mut ftp = tokio::time::timeout(CONNECT_TIMEOUT, connect)
            .await
            .map_err(|_| IdeError::new(ErrorKind::Io, format!("{label}: connection timed out")))??;
        if let Err(e) = ftp.login(user, password.as_str()).await {
            return Err(match e {
                FtpError::UnexpectedResponse(r) if r.status == Status::NotLoggedIn => {
                    let reply = describe(&FtpError::UnexpectedResponse(r));
                    IdeError::new(
                        ErrorKind::PermissionDenied,
                        format!("FTP authentication failed for {label}: {reply}"),
                    )
                }
                e => err(&label, e),
            });
        }
        ftp.transfer_type(FileType::Binary).await.map_err(|e| err(&label, e))?;
        if c.passive {
            ftp.set_mode(Mode::Passive);
            // Servers behind NAT often announce a private address; the data
            // connection goes to the host of the control connection instead.
            ftp.set_passive_nat_workaround(true);
        } else {
            ftp = ftp.active_mode(CONNECT_TIMEOUT);
        }
        let home = ftp.pwd().await.map_err(|e| err(&label, e))?;
        let features = ftp.feat().await.unwrap_or_default();
        let (mlsd, mdtm) = (features.contains_key("MLST"), features.contains_key("MDTM"));
        Ok(Self { ftp: tokio::sync::Mutex::new(ftp), home, mlsd, mdtm })
    }

    pub fn home(&self) -> String {
        self.home.clone()
    }

    /// Absolute form of `path`; `~` and `~/…` are relative to the login directory.
    pub fn resolve(&self, path: &str) -> String {
        let path = path.trim();
        if path.is_empty() || path == "~" {
            return self.home.clone();
        }
        if let Some(rest) = path.strip_prefix("~/") {
            return join(&self.home, rest);
        }
        if path.starts_with('/') { path.to_owned() } else { join(&self.home, path) }
    }

    async fn is_dir(&self, path: &str) -> bool {
        self.ftp.lock().await.cwd(path).await.is_ok()
    }

    /// The entry of `path` as its parent lists it (FTP has no portable stat).
    pub async fn stat(&self, path: &str) -> IdeResult<Option<RemoteEntry>> {
        let path = path.trim_end_matches('/');
        let Some(dir) = parent(path) else {
            return Ok(self.is_dir("/").await.then(|| RemoteEntry {
                name: "/".into(),
                path: "/".into(),
                is_dir: true,
                is_symlink: false,
                size: 0,
                mtime: None,
                permissions: String::new(),
            }));
        };
        let name = &path[dir.len()..].trim_start_matches('/');
        match self.list(dir).await {
            Ok(entries) => Ok(entries.into_iter().find(|e| e.name == *name)),
            Err(e) if e.kind == ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Entries of `dir`, folders first, then by name; symlinks to folders count as folders.
    pub async fn list(&self, dir: &str) -> IdeResult<Vec<RemoteEntry>> {
        let lines = {
            let mut ftp = self.ftp.lock().await;
            if self.mlsd { ftp.mlsd(Some(dir)).await } else { ftp.list(Some(dir)).await }.map_err(|e| err(dir, e))?
        };
        let mut out = Vec::new();
        for line in lines {
            // Permissions only when the listing has them (MLSD's optional `unix.mode`, a POSIX `LIST` line).
            let parsed = if self.mlsd {
                ListParser::parse_mlsd(&line).map(|f| (f, line.to_ascii_lowercase().contains("unix.mode=")))
            } else {
                ListParser::parse_posix(&line)
                    .map(|f| (f, true))
                    .or_else(|_| ListParser::parse_dos(&line).map(|f| (f, false)))
            };
            let Ok((f, has_mode)) = parsed else { continue };
            let name = f.name().to_owned();
            // A name with `/` (from a hostile server) would point elsewhere once joined.
            if name.is_empty() || name == "." || name == ".." || name.contains('/') {
                continue;
            }
            let path = join(dir, &name);
            let is_dir = f.is_directory() || (f.is_symlink() && self.is_dir(&path).await);
            // `LIST` times are to the minute at best, in the server's time zone.
            let mtime = if self.mlsd {
                seconds(f.modified())
            } else if self.mdtm && !is_dir {
                let exact = self.ftp.lock().await.mdtm(&path).await;
                exact.ok().and_then(|t| t.and_utc().timestamp().try_into().ok())
            } else {
                None
            };
            out.push(RemoteEntry {
                is_dir,
                is_symlink: f.is_symlink(),
                size: f.size() as u64,
                mtime,
                permissions: if has_mode { permissions(&f) } else { String::new() },
                name,
                path,
            });
        }
        out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(out)
    }

    pub async fn read(&self, path: &str) -> IdeResult<Vec<u8>> {
        let mut ftp = self.ftp.lock().await;
        let mut stream = ftp.retr_as_stream(path).await.map_err(|e| err(path, e))?;
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).await?;
        stream.finish().await.map_err(|e| err(path, e))?;
        Ok(buf)
    }

    async fn store(
        &self,
        path: &str,
        input: &mut (impl tokio::io::AsyncRead + Unpin),
        cancel: Option<&CancellationToken>,
    ) -> IdeResult<()> {
        if let Some(dir) = parent(path) {
            self.mkdir_all(dir).await?;
        }
        let mut ftp = self.ftp.lock().await;
        let mut stream = ftp.put_with_stream(path).await.map_err(|e| err(path, e))?;
        match cancel {
            Some(cancel) => crate::filesystem::copy_stream(input, &mut stream, cancel).await?,
            None => {
                tokio::io::copy(input, &mut stream).await?;
            }
        }
        stream.finish().await.map_err(|e| err(path, e))
    }

    async fn set_mtime(&self, path: &str, seconds: u32) {
        let command = format!("MFMT {} {path}", mfmt_time(seconds));
        if let Err(e) = self.ftp.lock().await.custom_command(command, &[Status::File]).await {
            tracing::debug!("FTP: cannot set the time of {path}: {e}");
        }
    }

    /// Writes `data`, creating missing parent folders.
    pub async fn write(&self, path: &str, data: &[u8], mtime: Option<u32>) -> IdeResult<()> {
        self.store(path, &mut &data[..], None).await?;
        if let Some(t) = mtime {
            self.set_mtime(path, t).await;
        }
        Ok(())
    }

    pub async fn upload(&self, local: &Path, remote: &str, preserve_time: bool) -> IdeResult<()> {
        let mut input = tokio::fs::File::open(local).await?;
        self.store(remote, &mut input, None).await?;
        if let Some(t) = preserve_time.then(|| crate::sftp::mtime_of(local)).flatten() {
            self.set_mtime(remote, t).await;
        }
        Ok(())
    }

    /// Uploads unless `remote` exists (FTP has no exclusive create: checked first).
    pub async fn upload_new(&self, local: &Path, remote: &str, cancel: &CancellationToken) -> IdeResult<()> {
        if self.stat(remote).await?.is_some() {
            return Err(IdeError::new(ErrorKind::AlreadyExists, format!("{remote} already exists")));
        }
        let mut input = tokio::fs::File::open(local).await?;
        let result = self.store(remote, &mut input, Some(cancel)).await;
        if result.is_err() {
            let _ = self.ftp.lock().await.rm(remote).await;
        }
        result
    }

    pub async fn create_dir(&self, path: &str) -> IdeResult<()> {
        self.ftp.lock().await.mkdir(path).await.map_err(|e| err(path, e))
    }

    /// Downloads into a new temporary file beside `local` and replaces `local` (keeping its
    /// permissions) only once the server confirmed the transfer, so a failed one leaves an
    /// existing file as it was.
    pub async fn download(&self, remote: &str, local: &Path) -> IdeResult<()> {
        let dir = match local.parent() {
            Some(dir) if !dir.as_os_str().is_empty() => dir,
            _ => Path::new("."),
        };
        tokio::fs::create_dir_all(dir).await?;
        // A fresh, unpredictable name created exclusively: never an existing file or link.
        let partial = tempfile::Builder::new().prefix(".download-").tempfile_in(dir)?;
        let mut output = tokio::fs::File::from_std(partial.reopen()?);
        {
            let mut ftp = self.ftp.lock().await;
            let mut stream = ftp.retr_as_stream(remote).await.map_err(|e| err(remote, e))?;
            tokio::io::copy(&mut stream, &mut output).await?;
            output.flush().await?;
            drop(output);
            stream.finish().await.map_err(|e| err(remote, e))?;
        }
        if let Ok(existing) = tokio::fs::metadata(local).await {
            tokio::fs::set_permissions(partial.path(), existing.permissions()).await?;
        }
        partial.persist(local).map_err(|e| e.error)?;
        Ok(())
    }

    /// `mkdir -p`.
    pub async fn mkdir_all(&self, dir: &str) -> IdeResult<()> {
        if dir.is_empty() || dir == "/" || self.is_dir(dir).await {
            return Ok(());
        }
        if let Some(p) = parent(dir) {
            Box::pin(self.mkdir_all(p)).await?;
        }
        // The connection's lock is released before `is_dir` takes it again.
        let made = self.ftp.lock().await.mkdir(dir).await;
        match made {
            Ok(()) => Ok(()),
            Err(e) => {
                if self.is_dir(dir).await {
                    Ok(())
                } else {
                    Err(err(dir, e))
                }
            }
        }
    }

    /// Deletes a file, or a folder with its contents (a symlink itself, never its target).
    pub async fn remove(&self, path: &str) -> IdeResult<()> {
        let entry = self.stat(path).await?.ok_or_else(|| IdeError::not_found(format!("{path} does not exist")))?;
        if entry.is_dir && !entry.is_symlink {
            for e in self.list(path).await? {
                if e.is_dir && !e.is_symlink {
                    Box::pin(self.remove(&e.path)).await?;
                } else {
                    self.ftp.lock().await.rm(&e.path).await.map_err(|x| err(&e.path, x))?;
                }
            }
            self.ftp.lock().await.rmdir(path).await.map_err(|e| err(path, e))
        } else {
            self.ftp.lock().await.rm(path).await.map_err(|e| err(path, e))
        }
    }

    pub async fn rename(&self, from: &str, to: &str) -> IdeResult<()> {
        self.ftp.lock().await.rename(from, to).await.map_err(|e| err(from, e))
    }

    pub async fn close(&self) {
        let _ = self.ftp.lock().await.quit().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_mfmt_times_in_utc() {
        assert_eq!(mfmt_time(0), "19700101000000");
        assert_eq!(mfmt_time(951_782_400), "20000229000000");
        assert_eq!(mfmt_time(1_794_484_245), "20261112115045");
    }
}
