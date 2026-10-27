//! An in-process SSH server for tests (feature `testing`): password `dev` /
//! `secret`, commands answered by a closure, and SFTP served from a local
//! folder (remote `/x` is `<root>/x`).

use russh::server::{self, Auth, ChannelOpenHandle, Msg, Server as _, Session};
use russh::{Channel, ChannelId};
use russh_sftp::protocol::{Attrs, Data, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode, Version};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::Mutex;

/// Reply of a command: (stdout, exit status).
pub type ExecFn = Arc<dyn Fn(&str) -> (String, u32) + Send + Sync>;

/// Starts the server; returns its port. `root` backs SFTP.
pub async fn sshd(root: PathBuf, exec: ExecFn) -> u16 {
    let config = Arc::new(server::Config {
        keys: vec![russh::keys::decode_secret_key(include_str!("../tests/fixtures/ssh/host"), None).expect("host key")],
        auth_rejection_time: std::time::Duration::from_millis(10),
        auth_rejection_time_initial: Some(std::time::Duration::ZERO),
        ..Default::default()
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let mut server = Sshd { root, exec };
    tokio::spawn(async move {
        let _ = server.run_on_socket(config, &listener).await;
    });
    port
}

#[derive(Clone)]
struct Sshd {
    root: PathBuf,
    exec: ExecFn,
}

impl server::Server for Sshd {
    type Handler = Conn;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Conn {
        Conn { root: self.root.clone(), exec: self.exec.clone(), channels: Arc::default() }
    }
}

struct Conn {
    root: PathBuf,
    exec: ExecFn,
    channels: Arc<Mutex<HashMap<ChannelId, Channel<Msg>>>>,
}

impl server::Handler for Conn {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if user == "dev" && password == "secret" { Auth::Accept } else { Auth::reject() })
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.lock().await.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let (out, code) = (self.exec)(&String::from_utf8_lossy(data));
        session.channel_success(channel)?;
        session.data(channel, out.into_bytes())?;
        session.exit_status_request(channel, code)?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let Some(ch) = self.channels.lock().await.remove(&channel).filter(|_| name == "sftp") else {
            session.channel_failure(channel)?;
            return Ok(());
        };
        session.channel_success(channel)?;
        let sftp = Sftp { root: self.root.clone(), files: HashMap::new(), dirs: HashMap::new(), next: 0 };
        tokio::spawn(russh_sftp::server::run(ch.into_stream(), sftp));
        Ok(())
    }
}

struct Sftp {
    root: PathBuf,
    files: HashMap<String, std::fs::File>,
    /// Open directories: entries not yet sent.
    dirs: HashMap<String, Option<Vec<File>>>,
    next: u64,
}

fn ok(id: u32) -> Status {
    Status { id, status_code: StatusCode::Ok, error_message: "Ok".into(), language_tag: "en-US".into() }
}

fn code(e: std::io::Error) -> StatusCode {
    match e.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NoSuchFile,
        std::io::ErrorKind::PermissionDenied => StatusCode::PermissionDenied,
        _ => StatusCode::Failure,
    }
}

impl Sftp {
    fn local(&self, path: &str) -> PathBuf {
        path.split('/').filter(|s| !s.is_empty() && *s != "." && *s != "..").fold(self.root.clone(), |p, s| p.join(s))
    }

    fn handle(&mut self) -> String {
        self.next += 1;
        format!("h{}", self.next)
    }

    fn attrs(path: &Path) -> Result<FileAttributes, StatusCode> {
        std::fs::symlink_metadata(path).map(|m| FileAttributes::from(&m)).map_err(code)
    }
}

impl russh_sftp::server::Handler for Sftp {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(&mut self, _version: u32, _ext: HashMap<String, String>) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let p = if path == "." || path.is_empty() { "/home/dev".to_owned() } else { path };
        Ok(Name { id, files: vec![File::dummy(p)] })
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let path = self.local(&filename);
        let file = std::fs::OpenOptions::new()
            .read(pflags.contains(OpenFlags::READ))
            .write(pflags.contains(OpenFlags::WRITE))
            .create(pflags.contains(OpenFlags::CREATE))
            .truncate(pflags.contains(OpenFlags::TRUNCATE))
            .open(path)
            .map_err(code)?;
        let handle = self.handle();
        self.files.insert(handle.clone(), file);
        Ok(Handle { id, handle })
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.files.remove(&handle);
        self.dirs.remove(&handle);
        Ok(ok(id))
    }

    async fn read(&mut self, id: u32, handle: String, offset: u64, len: u32) -> Result<Data, Self::Error> {
        let file = self.files.get_mut(&handle).ok_or(StatusCode::Failure)?;
        file.seek(SeekFrom::Start(offset)).map_err(code)?;
        let mut buf = vec![0; len as usize];
        let n = file.read(&mut buf).map_err(code)?;
        if n == 0 {
            return Err(StatusCode::Eof);
        }
        buf.truncate(n);
        Ok(Data { id, data: buf })
    }

    async fn write(&mut self, id: u32, handle: String, offset: u64, data: Vec<u8>) -> Result<Status, Self::Error> {
        let file = self.files.get_mut(&handle).ok_or(StatusCode::Failure)?;
        file.seek(SeekFrom::Start(offset)).map_err(code)?;
        file.write_all(&data).map_err(code)?;
        Ok(ok(id))
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let p = self.local(&path);
        let attrs = std::fs::metadata(&p).map(|m| FileAttributes::from(&m)).map_err(code)?;
        Ok(Attrs { id, attrs })
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        Ok(Attrs { id, attrs: Self::attrs(&self.local(&path))? })
    }

    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
        let file = self.files.get(&handle).ok_or(StatusCode::Failure)?;
        Ok(Attrs { id, attrs: FileAttributes::from(&file.metadata().map_err(code)?) })
    }

    async fn setstat(&mut self, id: u32, path: String, attrs: FileAttributes) -> Result<Status, Self::Error> {
        if let Some(t) = attrs.mtime {
            let time = std::time::UNIX_EPOCH + std::time::Duration::from_secs(t.into());
            let f = std::fs::File::options().write(true).open(self.local(&path)).map_err(code)?;
            f.set_modified(time).map_err(code)?;
        }
        Ok(ok(id))
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        let dir = self.local(&path);
        let mut files = Vec::new();
        for e in std::fs::read_dir(&dir).map_err(code)?.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            files.push(File::new(name, Self::attrs(&e.path())?));
        }
        let handle = self.handle();
        self.dirs.insert(handle.clone(), Some(files));
        Ok(Handle { id, handle })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        match self.dirs.get_mut(&handle).and_then(Option::take) {
            Some(files) if !files.is_empty() => Ok(Name { id, files }),
            _ => Err(StatusCode::Eof),
        }
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        std::fs::remove_file(self.local(&filename)).map_err(code)?;
        Ok(ok(id))
    }

    async fn mkdir(&mut self, id: u32, path: String, _attrs: FileAttributes) -> Result<Status, Self::Error> {
        std::fs::create_dir(self.local(&path)).map_err(code)?;
        Ok(ok(id))
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        std::fs::remove_dir(self.local(&path)).map_err(code)?;
        Ok(ok(id))
    }

    async fn rename(&mut self, id: u32, oldpath: String, newpath: String) -> Result<Status, Self::Error> {
        std::fs::rename(self.local(&oldpath), self.local(&newpath)).map_err(code)?;
        Ok(ok(id))
    }
}
