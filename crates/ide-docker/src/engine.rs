//! The Docker Engine API served directly over a unix socket or TCP, for
//! connections that must work without the local docker CLI: an SSH connection
//! is resolved to its tunnel's local TCP end before it reaches here, a socket
//! or TCP endpoint is used as saved, and the default daemon is the unix socket.
//! Only request/response calls are covered; features the CLI alone provides
//! (compose, streaming, registry logins) still run `docker`.

use crate::{
    COMPOSE_DIR, COMPOSE_FILES, COMPOSE_PROJECT, COMPOSE_SERVICE, ContainerOp, DockerAvailability, DockerContainer,
    DockerEndpoint, DockerImage, DockerImageLayer, DockerLogLine, DockerNetwork, DockerObject, DockerProcessList,
    DockerSnapshot, DockerVolume, split_csv,
};
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::net::UnixStream;

/// The port the Docker Engine listens on when an endpoint's host gives none.
const DEFAULT_PORT: u16 = 2375;

/// Where the daemon can be reached without the docker CLI.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Address {
    UnixSocket(String),
    Tcp { host: String, port: u16 },
}

impl Address {
    fn display(&self) -> String {
        match self {
            Self::UnixSocket(path) => path.clone(),
            Self::Tcp { host, port } => format!("tcp://{host}:{port}"),
        }
    }
}

/// The daemon address of `ep` when the Engine API can serve it: TLS endpoints
/// and docker contexts need the CLI to be read, an SSH endpoint reaches here
/// only after being resolved to its tunnel, and a named pipe needs the CLI.
pub(crate) fn address(ep: &DockerEndpoint) -> Option<Address> {
    match ep {
        DockerEndpoint::Socket { path } if !cfg!(windows) => {
            let path = path.trim().strip_prefix("unix://").unwrap_or(path.trim()).trim();
            (!path.is_empty()).then(|| Address::UnixSocket(path.to_owned()))
        }
        DockerEndpoint::Tcp { host, tls_cert_dir } => {
            if tls_cert_dir.as_deref().map(str::trim).filter(|d| !d.is_empty()).is_some() {
                return None;
            }
            let host = host.trim();
            let (scheme, rest) = host.split_once("://").unwrap_or(("tcp", host));
            match scheme {
                "tcp" | "http" => host_port(rest).map(|(host, port)| Address::Tcp { host, port }),
                _ => None,
            }
        }
        DockerEndpoint::Default => {
            default_address(ide_core::process::host_var_os("DOCKER_HOST").as_deref().and_then(|v| v.to_str()))
        }
        _ => None,
    }
}

/// The default endpoint's daemon: `DOCKER_HOST` when it is a plain socket or
/// TCP address, else the unix socket (Windows named pipes need the CLI).
fn default_address(docker_host: Option<&str>) -> Option<Address> {
    if let Some(host) = docker_host.map(str::trim).filter(|h| !h.is_empty()) {
        return match host.split_once("://") {
            Some(("unix", rest)) if !cfg!(windows) && !rest.is_empty() => Some(Address::UnixSocket(rest.to_owned())),
            Some(("tcp", rest)) | Some(("http", rest)) => {
                host_port(rest).map(|(host, port)| Address::Tcp { host, port })
            }
            _ => None,
        };
    }
    if cfg!(unix) { Some(Address::UnixSocket("/var/run/docker.sock".into())) } else { None }
}

/// `host:port` (or a bracketed IPv6 host) with the default port filled in.
fn host_port(rest: &str) -> Option<(String, u16)> {
    let rest = rest.trim();
    if let Some(rest) = rest.strip_prefix('[') {
        let (host, tail) = rest.split_once(']')?;
        if host.is_empty() {
            return None;
        }
        let port = tail.strip_prefix(':').unwrap_or("").trim();
        return Some((host.to_owned(), port_of(port)?));
    }
    if rest.is_empty() {
        return None;
    }
    match rest.rsplit_once(':') {
        Some((host, "")) => Some((host.to_owned(), DEFAULT_PORT)),
        Some((host, tail)) if tail.bytes().all(|b| b.is_ascii_digit()) => Some((host.to_owned(), port_of(tail)?)),
        _ => Some((rest.to_owned(), DEFAULT_PORT)),
    }
}

fn port_of(port: &str) -> Option<u16> {
    match port {
        "" => Some(DEFAULT_PORT),
        p => p.parse().ok(),
    }
}

/// A connection to the daemon: a unix socket or a TCP stream.
enum Conn {
    #[cfg(unix)]
    Unix(UnixStream),
    Tcp(TcpStream),
}

impl Conn {
    fn connect(addr: &Address, timeout: Duration) -> IdeResult<Conn> {
        let conn = match addr {
            #[cfg(unix)]
            Address::UnixSocket(path) => UnixStream::connect(path).map(Conn::Unix),
            #[cfg(windows)]
            Address::UnixSocket(_) => Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "the Docker daemon socket needs the docker CLI on this platform",
            )),
            Address::Tcp { host, port } => TcpStream::connect((host.as_str(), *port)).map(Conn::Tcp),
        }
        .map_err(|e| {
            IdeError::unavailable(format!("cannot connect to the Docker daemon at {}: {e}", addr.display()))
        })?;
        conn.set_timeouts(timeout);
        Ok(conn)
    }

    fn set_timeouts(&self, timeout: Duration) {
        let (read, write) = (Some(timeout), Some(timeout));
        match self {
            #[cfg(unix)]
            Self::Unix(s) => {
                let _ = s.set_read_timeout(read);
                let _ = s.set_write_timeout(write);
            }
            Self::Tcp(s) => {
                let _ = s.set_read_timeout(read);
                let _ = s.set_write_timeout(write);
            }
        }
    }
}

impl Read for Conn {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            #[cfg(unix)]
            Self::Unix(s) => s.read(buf),
            Self::Tcp(s) => s.read(buf),
        }
    }
}

impl std::io::Write for Conn {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            #[cfg(unix)]
            Self::Unix(s) => s.write(buf),
            Self::Tcp(s) => s.write(buf),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Unix(s) => s.flush(),
            Self::Tcp(s) => s.flush(),
        }
    }
}

struct Response {
    status: u16,
    body: Vec<u8>,
}

/// One Engine API call: its own connection, closed by the daemon (`Connection: close`).
fn request(addr: &Address, method: &str, path: &str, timeout: Duration) -> IdeResult<Response> {
    let mut conn = Conn::connect(addr, timeout)?;
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: docker\r\nUser-Agent: openidea\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );
    conn.write_all(head.as_bytes())?;
    read_response(&mut conn)
}

/// A response's status line and body framing.
struct Head {
    status: u16,
    chunked: bool,
    length: Option<usize>,
}

/// Reads an HTTP/1.1 response head until `\r\n\r\n`.
fn read_head(stream: &mut impl Read) -> IdeResult<Head> {
    let mut head: Vec<u8> = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let read = stream.read(&mut byte)?;
        if read == 0 {
            return Err(IdeError::internal("the Docker daemon closed the connection before answering"));
        }
        head.push(byte[0]);
        if head.ends_with(b"\r\n\r\n") {
            break;
        }
        if head.len() > 16 * 1024 {
            return Err(IdeError::internal("the Docker daemon answered with an oversized response head"));
        }
    }
    let head = String::from_utf8_lossy(&head[..head.len() - 4]).into_owned();
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let status = status_line.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or_else(|| {
        IdeError::internal(format!("the Docker daemon answered with an unexpected response: {status_line}"))
    })?;
    let (mut chunked, mut length) = (false, None);
    for line in lines {
        let Some((name, value)) = line.split_once(':') else { continue };
        let (name, value) = (name.trim().to_ascii_lowercase(), value.trim());
        if name == "transfer-encoding" && value.eq_ignore_ascii_case("chunked") {
            chunked = true;
        }
        if name == "content-length" {
            length = value.parse().ok();
        }
    }
    Ok(Head { status, chunked, length })
}

/// Reads an HTTP/1.1 response: its head, then the body per its framing
/// (chunked, `Content-Length`, or until the connection closes).
fn read_response(stream: &mut impl Read) -> IdeResult<Response> {
    let head = read_head(stream)?;
    let body = read_body(stream, &head)?;
    Ok(Response { status: head.status, body })
}

fn read_body(stream: &mut impl Read, head: &Head) -> IdeResult<Vec<u8>> {
    Ok(if head.chunked {
        read_chunked(stream)?
    } else if let Some(n) = head.length {
        read_exact_n(stream, n)?
    } else {
        let mut body = Vec::new();
        stream.read_to_end(&mut body)?;
        body
    })
}

/// Reads one `\n`-terminated line (returned without it).
fn read_line(stream: &mut impl Read) -> IdeResult<Vec<u8>> {
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let read = stream.read(&mut byte)?;
        if read == 0 {
            break;
        }
        if byte[0] == b'\n' {
            break;
        }
        if byte[0] != b'\r' {
            line.push(byte[0]);
        }
    }
    Ok(line)
}

fn read_exact_n(stream: &mut impl Read, n: usize) -> IdeResult<Vec<u8>> {
    let mut body = vec![0u8; n];
    stream.read_exact(&mut body)?;
    Ok(body)
}

fn read_chunked(stream: &mut impl Read) -> IdeResult<Vec<u8>> {
    let mut body = Vec::new();
    loop {
        let line = read_line(stream)?;
        let line = String::from_utf8_lossy(&line).into_owned();
        let size = line.split(';').next().unwrap_or_default().trim().to_owned();
        let Some(size) = usize::from_str_radix(&size, 16).ok() else {
            return Err(IdeError::internal("the Docker daemon answered with a malformed chunked response"));
        };
        if size == 0 {
            while !read_line(stream)?.is_empty() {}
            return Ok(body);
        }
        body.extend(read_exact_n(stream, size)?);
        read_line(stream)?;
    }
}

#[derive(Deserialize, Default)]
struct ApiError {
    #[serde(default)]
    message: String,
}

/// The body of a successful response, or the daemon's error message.
fn check(resp: Response) -> IdeResult<String> {
    if (200..300).contains(&resp.status) {
        return Ok(String::from_utf8_lossy(&resp.body).into_owned());
    }
    let message = serde_json::from_slice::<ApiError>(&resp.body)
        .ok()
        .map(|e| e.message)
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| format!("the Docker daemon answered with HTTP {}", resp.status));
    let lower = message.to_ascii_lowercase();
    if lower.contains("no such") || lower.contains("not found") {
        Err(IdeError::not_found(message))
    } else {
        Err(IdeError::internal(message))
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct ApiVersion {
    version: String,
}

/// Whether the daemon of `ep` can be used right now, without the CLI.
pub(crate) fn availability(ep: &DockerEndpoint, timeout: Duration) -> Option<DockerAvailability> {
    Some(availability_of(&address(ep)?, timeout))
}

fn availability_of(addr: &Address, timeout: Duration) -> DockerAvailability {
    match server_version(addr, timeout) {
        Ok(v) if !v.is_empty() => {
            DockerAvailability::Ready { client_version: String::new(), server_version: v, context: None }
        }
        Ok(_) => DockerAvailability::DaemonDown {
            message: "the Docker daemon did not report its version".into(),
            context: None,
        },
        Err(e) => DockerAvailability::DaemonDown { message: e.message, context: None },
    }
}

fn server_version(addr: &Address, timeout: Duration) -> IdeResult<String> {
    let body = check(request(addr, "GET", "/version", timeout)?)?;
    serde_json::from_str::<ApiVersion>(&body)
        .map(|v| v.version)
        .map_err(|e| IdeError::internal(format!("the Docker daemon version is not JSON: {e}")))
}

/// Everything the Services tree shows, fetched straight from the Engine API.
pub(crate) fn snapshot(ep: &DockerEndpoint, timeout: Duration) -> Option<DockerSnapshot> {
    let addr = address(ep)?;
    let mut snap = DockerSnapshot {
        availability: availability_of(&addr, timeout),
        executable: None,
        containers: Vec::new(),
        images: Vec::new(),
        volumes: Vec::new(),
        networks: Vec::new(),
        errors: Vec::new(),
        global_args: ep.global_args(),
    };
    if !matches!(snap.availability, DockerAvailability::Ready { .. }) {
        return Some(snap);
    }
    let (containers, images, volumes, networks) = std::thread::scope(|s| {
        let c = s.spawn(|| list_containers(&addr, timeout));
        let i = s.spawn(|| list_images(&addr, timeout));
        let v = s.spawn(|| list_volumes(&addr, timeout));
        let n = s.spawn(|| list_networks(&addr, timeout));
        (
            c.join().unwrap_or_else(|_| Err(IdeError::internal("docker listing panicked"))),
            i.join().unwrap_or_else(|_| Err(IdeError::internal("docker listing panicked"))),
            v.join().unwrap_or_else(|_| Err(IdeError::internal("docker listing panicked"))),
            n.join().unwrap_or_else(|_| Err(IdeError::internal("docker listing panicked"))),
        )
    });
    match containers {
        Ok(items) => snap.containers = items,
        Err(e) => snap.errors.push(format!("Containers: {}", e.message)),
    }
    match images {
        Ok(items) => snap.images = items,
        Err(e) => snap.errors.push(format!("Images: {}", e.message)),
    }
    match volumes {
        Ok(items) => snap.volumes = items,
        Err(e) => snap.errors.push(format!("Volumes: {}", e.message)),
    }
    match networks {
        Ok(items) => snap.networks = items,
        Err(e) => snap.errors.push(format!("Networks: {}", e.message)),
    }
    Some(snap)
}

fn list_containers(addr: &Address, timeout: Duration) -> IdeResult<Vec<DockerContainer>> {
    let body = check(request(addr, "GET", "/containers/json?all=1", timeout)?)?;
    Ok(map_containers(&body))
}

fn list_images(addr: &Address, timeout: Duration) -> IdeResult<Vec<DockerImage>> {
    let body = check(request(addr, "GET", "/images/json", timeout)?)?;
    Ok(map_images(&body))
}

fn list_volumes(addr: &Address, timeout: Duration) -> IdeResult<Vec<DockerVolume>> {
    let body = check(request(addr, "GET", "/volumes", timeout)?)?;
    Ok(map_volumes(&body))
}

fn list_networks(addr: &Address, timeout: Duration) -> IdeResult<Vec<DockerNetwork>> {
    let body = check(request(addr, "GET", "/networks", timeout)?)?;
    Ok(map_networks(&body))
}

/// Starts / stops / … the containers `ids` on `ep`'s daemon.
pub(crate) fn container_op(
    ep: &DockerEndpoint,
    ids: &[String],
    op: ContainerOp,
    timeout: Duration,
) -> Option<IdeResult<()>> {
    let addr = address(ep)?;
    Some((|| -> IdeResult<()> {
        for id in ids {
            let path = match op {
                ContainerOp::Start => format!("/containers/{}/start", path_segment(id)),
                ContainerOp::Stop => format!("/containers/{}/stop?t=10", path_segment(id)),
                ContainerOp::Restart => format!("/containers/{}/restart?t=10", path_segment(id)),
                ContainerOp::Pause => format!("/containers/{}/pause", path_segment(id)),
                ContainerOp::Unpause => format!("/containers/{}/unpause", path_segment(id)),
                ContainerOp::Kill => format!("/containers/{}/kill", path_segment(id)),
            };
            check(request(&addr, "POST", &path, timeout)?)?;
        }
        Ok(())
    })())
}

/// Removes `ids` of `object` (`force` as the CLI's `--force`).
pub(crate) fn remove(
    ep: &DockerEndpoint,
    object: DockerObject,
    ids: &[String],
    force: bool,
    timeout: Duration,
) -> Option<IdeResult<()>> {
    let addr = address(ep)?;
    Some((|| -> IdeResult<()> {
        for id in ids {
            let mut path = format!(
                "{}{}",
                match object {
                    DockerObject::Container => "/containers/",
                    DockerObject::Image => "/images/",
                    DockerObject::Volume => "/volumes/",
                    DockerObject::Network => "/networks/",
                },
                path_segment(id)
            );
            if force && matches!(object, DockerObject::Container | DockerObject::Image | DockerObject::Volume) {
                path.push_str("?force=1");
            }
            check(request(&addr, "DELETE", &path, timeout)?)?;
        }
        Ok(())
    })())
}

/// The daemon's `inspect` of one object, pretty-printed.
pub(crate) fn inspect(
    ep: &DockerEndpoint,
    object: DockerObject,
    id: &str,
    timeout: Duration,
) -> Option<IdeResult<String>> {
    let addr = address(ep)?;
    Some((|| {
        let path = match object {
            DockerObject::Container => format!("/containers/{}/json", path_segment(id)),
            DockerObject::Image => format!("/images/{}/json", path_segment(id)),
            DockerObject::Volume => format!("/volumes/{}", path_segment(id)),
            DockerObject::Network => format!("/networks/{}", path_segment(id)),
        };
        let body = check(request(&addr, "GET", &path, timeout)?)?;
        match serde_json::from_str::<serde_json::Value>(&body) {
            Ok(v) => serde_json::to_string_pretty(&v).map_err(|e| IdeError::internal(e.to_string())),
            Err(_) => Ok(body),
        }
    })())
}

/// The processes running in a container (`docker top`).
pub(crate) fn container_top(ep: &DockerEndpoint, id: &str, timeout: Duration) -> Option<IdeResult<DockerProcessList>> {
    let addr = address(ep)?;
    Some((|| {
        let body = check(request(&addr, "GET", &format!("/containers/{}/top", path_segment(id)), timeout)?)?;
        serde_json::from_str::<ApiTop>(&body)
            .map(|t| DockerProcessList { titles: t.titles, processes: t.processes })
            .map_err(|e| IdeError::internal(format!("the Docker daemon's process list is not JSON: {e}")))
    })())
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct ApiTop {
    titles: Vec<String>,
    processes: Vec<Vec<String>>,
}

/// An image's layers, newest first (`docker image history`).
pub(crate) fn image_history(
    ep: &DockerEndpoint,
    id: &str,
    timeout: Duration,
) -> Option<IdeResult<Vec<DockerImageLayer>>> {
    let addr = address(ep)?;
    Some((|| {
        let body = check(request(&addr, "GET", &format!("/images/{}/history", path_segment(id)), timeout)?)?;
        let layers = serde_json::from_str::<Vec<ApiLayer>>(&body)
            .map_err(|e| IdeError::internal(format!("the Docker daemon's image history is not JSON: {e}")))?;
        Ok(map_layers(layers, unix_now()))
    })())
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct ApiLayer {
    id: String,
    created: i64,
    created_by: String,
    size: i64,
    comment: String,
}

fn map_layers(layers: Vec<ApiLayer>, now: i64) -> Vec<DockerImageLayer> {
    layers
        .into_iter()
        .map(|l| DockerImageLayer {
            id: l.id,
            created_by: l.created_by,
            size: human_size(l.size),
            created_since: human_duration((now - l.created).max(0)),
            created_at: unix_utc(l.created),
            comment: l.comment,
        })
        .collect()
}

fn unix_now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// How often a log stream that has nothing to read checks for cancellation.
const LOG_POLL: Duration = Duration::from_millis(200);

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct ApiContainerInspect {
    config: ApiContainerConfig,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct ApiContainerConfig {
    tty: bool,
}

/// Streams a container's logs (`tail` last lines, then follows while `follow`)
/// from `ep`'s daemon until they end or `cancel` fires.
#[allow(clippy::too_many_arguments)]
pub(crate) fn logs(
    ep: &DockerEndpoint,
    id: &str,
    tail: u32,
    follow: bool,
    timestamps: bool,
    timeout: Duration,
    cancel: &CancellationToken,
    on_line: &dyn Fn(DockerLogLine),
) -> Option<IdeResult<()>> {
    let addr = address(ep)?;
    Some((|| {
        // A TTY container's log is one raw stream; otherwise it is framed per stream.
        let body = check(request(&addr, "GET", &format!("/containers/{}/json", path_segment(id)), timeout)?)?;
        let tty = serde_json::from_str::<ApiContainerInspect>(&body).map(|c| c.config.tty).unwrap_or(false);
        let path = format!(
            "/containers/{}/logs?stdout=1&stderr=1&tail={tail}&follow={}&timestamps={}",
            path_segment(id),
            u8::from(follow),
            u8::from(timestamps),
        );
        let mut conn = Conn::connect(&addr, timeout)?;
        conn.write_all(
            format!("GET {path} HTTP/1.1\r\nHost: docker\r\nUser-Agent: openidea\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )?;
        let head = read_head(&mut conn)?;
        if !(200..300).contains(&head.status) {
            let body = read_body(&mut conn, &head)?;
            check(Response { status: head.status, body })?;
        }
        conn.set_timeouts(LOG_POLL);
        let mut decoder = LogDecoder::new(&head, tty);
        let mut buf = [0u8; 8192];
        while !decoder.done() {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            match conn.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => decoder.feed(&buf[..n], &mut |line| on_line(line))?,
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut | std::io::ErrorKind::Interrupted
                    ) => {}
                Err(e) => return Err(e.into()),
            }
        }
        decoder.finish(&mut |line| on_line(line));
        Ok(())
    })())
}

/// Turns a log response body, as it arrives, into lines: undoes the chunked
/// transfer encoding, then the per-stream frames (8-byte header: stream, 3 zero
/// bytes, big-endian length) unless the container has a TTY.
struct LogDecoder {
    body: BodyFraming,
    tty: bool,
    header: Vec<u8>,
    frame_left: usize,
    frame_stderr: bool,
    /// Partial lines of stdout and stderr.
    partial: [Vec<u8>; 2],
}

enum BodyFraming {
    Chunked { state: ChunkState, line: Vec<u8> },
    Length(usize),
    Close,
}

#[derive(Clone, Copy, PartialEq)]
enum ChunkState {
    Size,
    Data(usize),
    DataEnd,
    Trailer,
    Done,
}

impl LogDecoder {
    fn new(head: &Head, tty: bool) -> Self {
        let body = if head.chunked {
            BodyFraming::Chunked { state: ChunkState::Size, line: Vec::new() }
        } else if let Some(n) = head.length {
            BodyFraming::Length(n)
        } else {
            BodyFraming::Close
        };
        Self { body, tty, header: Vec::new(), frame_left: 0, frame_stderr: false, partial: [Vec::new(), Vec::new()] }
    }

    fn done(&self) -> bool {
        matches!(self.body, BodyFraming::Chunked { state: ChunkState::Done, .. } | BodyFraming::Length(0))
    }

    fn feed(&mut self, mut bytes: &[u8], emit: &mut dyn FnMut(DockerLogLine)) -> IdeResult<()> {
        let mut payload = Vec::new();
        match &mut self.body {
            BodyFraming::Close => payload.extend_from_slice(bytes),
            BodyFraming::Length(left) => {
                let take = (*left).min(bytes.len());
                payload.extend_from_slice(&bytes[..take]);
                *left -= take;
            }
            BodyFraming::Chunked { state, line } => {
                while !bytes.is_empty() {
                    match *state {
                        ChunkState::Done => break,
                        ChunkState::Data(n) => {
                            let take = n.min(bytes.len());
                            payload.extend_from_slice(&bytes[..take]);
                            bytes = &bytes[take..];
                            *state = if take == n { ChunkState::DataEnd } else { ChunkState::Data(n - take) };
                        }
                        _ => {
                            let b = bytes[0];
                            bytes = &bytes[1..];
                            if b != b'\n' {
                                if b != b'\r' {
                                    line.push(b);
                                }
                                continue;
                            }
                            let text = String::from_utf8_lossy(line).into_owned();
                            line.clear();
                            *state = match *state {
                                ChunkState::Size => {
                                    let size = text.split(';').next().unwrap_or_default().trim();
                                    match usize::from_str_radix(size, 16) {
                                        Ok(0) => ChunkState::Trailer,
                                        Ok(n) => ChunkState::Data(n),
                                        Err(_) => {
                                            return Err(IdeError::internal(
                                                "the Docker daemon answered with a malformed chunked response",
                                            ));
                                        }
                                    }
                                }
                                ChunkState::DataEnd => ChunkState::Size,
                                _ if text.is_empty() => ChunkState::Done,
                                other => other,
                            };
                        }
                    }
                }
            }
        }
        self.frames(&payload, emit);
        Ok(())
    }

    fn frames(&mut self, mut bytes: &[u8], emit: &mut dyn FnMut(DockerLogLine)) {
        if self.tty {
            self.lines(false, bytes, emit);
            return;
        }
        while !bytes.is_empty() {
            if self.frame_left == 0 {
                let take = (8 - self.header.len()).min(bytes.len());
                self.header.extend_from_slice(&bytes[..take]);
                bytes = &bytes[take..];
                if self.header.len() == 8 {
                    self.frame_stderr = self.header[0] == 2;
                    self.frame_left =
                        u32::from_be_bytes([self.header[4], self.header[5], self.header[6], self.header[7]]) as usize;
                    self.header.clear();
                }
                continue;
            }
            let take = self.frame_left.min(bytes.len());
            self.lines(self.frame_stderr, &bytes[..take], emit);
            self.frame_left -= take;
            bytes = &bytes[take..];
        }
    }

    fn lines(&mut self, stderr: bool, bytes: &[u8], emit: &mut dyn FnMut(DockerLogLine)) {
        let partial = &mut self.partial[usize::from(stderr)];
        for &b in bytes {
            if b == b'\n' {
                emit(DockerLogLine { stderr, text: line_text(partial) });
                partial.clear();
            } else {
                partial.push(b);
            }
        }
    }

    /// Emits the last lines that ended without a newline.
    fn finish(&mut self, emit: &mut dyn FnMut(DockerLogLine)) {
        for stderr in [false, true] {
            let partial = &mut self.partial[usize::from(stderr)];
            if !partial.is_empty() {
                emit(DockerLogLine { stderr, text: line_text(partial) });
                partial.clear();
            }
        }
    }
}

fn line_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes.strip_suffix(b"\r").unwrap_or(bytes)).into_owned()
}

/// One URL path segment, percent-encoded so an id cannot change the path.
fn path_segment(id: &str) -> String {
    let mut out = String::with_capacity(id.len());
    for b in id.trim().bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct ApiContainer {
    #[serde(rename = "Id")]
    id: String,
    names: Vec<String>,
    image: String,
    command: String,
    created: i64,
    state: String,
    status: String,
    ports: Vec<ApiPort>,
    labels: BTreeMap<String, String>,
    mounts: Vec<ApiMount>,
    network_settings: ApiNetworkSettings,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct ApiPort {
    #[serde(rename = "IP")]
    ip: Option<String>,
    private_port: u16,
    public_port: Option<u16>,
    #[serde(rename = "Type")]
    kind: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct ApiMount {
    #[serde(rename = "Type")]
    kind: String,
    name: String,
    source: String,
    destination: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct ApiNetworkSettings {
    networks: BTreeMap<String, serde_json::Value>,
}

/// `/containers/json?all=1` as the Services tree's container rows.
fn map_containers(body: &str) -> Vec<DockerContainer> {
    let mut out: Vec<DockerContainer> = serde_json::from_str::<Vec<ApiContainer>>(body)
        .unwrap_or_default()
        .into_iter()
        .map(|r| DockerContainer {
            name: r.names.first().map(|n| n.trim_start_matches('/')).unwrap_or_default().to_owned(),
            id: r.id.clone(),
            image: r.image.clone(),
            command: r.command.clone(),
            state: r.state.to_ascii_lowercase(),
            status: r.status.clone(),
            ports: r.ports.iter().map(port_text).collect::<Vec<_>>().join(", "),
            created_at: unix_utc(r.created),
            compose_project: r.labels.get(COMPOSE_PROJECT).filter(|s| !s.is_empty()).cloned(),
            compose_service: r.labels.get(COMPOSE_SERVICE).filter(|s| !s.is_empty()).cloned(),
            compose_working_dir: r.labels.get(COMPOSE_DIR).filter(|s| !s.is_empty()).cloned(),
            compose_files: r.labels.get(COMPOSE_FILES).map(|f| split_csv(f)).unwrap_or_default(),
            mounts: r.mounts.iter().filter_map(mount_text).collect(),
            networks: r.network_settings.networks.keys().cloned().collect(),
            labels: r.labels.clone(),
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// One `Ports` column entry, as `docker ps` prints it.
fn port_text(p: &ApiPort) -> String {
    let kind = if p.kind.is_empty() { "tcp" } else { &p.kind };
    match (p.ip.as_deref().filter(|ip| !ip.is_empty()), p.public_port) {
        (Some(ip), Some(public)) => format!("{ip}:{public}->{}/{kind}", p.private_port),
        (None, Some(public)) => format!("{public}->{}/{kind}", p.private_port),
        _ => format!("{}/{kind}", p.private_port),
    }
}

/// One `Mounts` column entry: a volume's name, else the host path.
fn mount_text(m: &ApiMount) -> Option<String> {
    match m.kind.as_str() {
        "volume" if !m.name.is_empty() => Some(m.name.clone()),
        _ if !m.source.is_empty() => Some(m.source.clone()),
        _ if !m.destination.is_empty() => Some(m.destination.clone()),
        _ => None,
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct ApiImage {
    #[serde(rename = "Id")]
    id: String,
    repo_tags: Vec<String>,
    created: i64,
    size: i64,
}

/// `/images/json` as the Services tree's image rows (one per tag).
fn map_images(body: &str) -> Vec<DockerImage> {
    let now =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let mut out: Vec<DockerImage> = Vec::new();
    for image in serde_json::from_str::<Vec<ApiImage>>(body).unwrap_or_default() {
        let row = |repository: &str, tag: &str| DockerImage {
            id: image.id.clone(),
            repository: repository.to_owned(),
            tag: tag.to_owned(),
            size: human_size(image.size),
            created_since: human_duration((now - image.created).max(0)),
        };
        let tags: Vec<&String> =
            image.repo_tags.iter().filter(|t| !t.is_empty() && t.as_str() != "<none>:<none>").collect();
        if tags.is_empty() {
            out.push(row("<none>", "<none>"));
        } else {
            for tag in tags {
                let (repository, tag) = tag.rsplit_once(':').map_or((tag.as_str(), ""), |(r, t)| (r, t));
                out.push(row(repository, tag));
            }
        }
    }
    out.sort_by(|a, b| {
        (a.repository == "<none>", &a.repository, &a.tag).cmp(&(b.repository == "<none>", &b.repository, &b.tag))
    });
    out
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct ApiVolumes {
    volumes: Vec<ApiVolume>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct ApiVolume {
    name: String,
    driver: String,
    mountpoint: String,
    scope: String,
    labels: BTreeMap<String, String>,
}

/// `/volumes` as the Services tree's volume rows.
fn map_volumes(body: &str) -> Vec<DockerVolume> {
    let mut out: Vec<DockerVolume> = serde_json::from_str::<ApiVolumes>(body)
        .unwrap_or_default()
        .volumes
        .into_iter()
        .map(|r| DockerVolume {
            compose_project: r.labels.get(COMPOSE_PROJECT).filter(|s| !s.is_empty()).cloned(),
            name: r.name,
            driver: r.driver,
            mountpoint: r.mountpoint,
            scope: r.scope,
            labels: r.labels,
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct ApiNetwork {
    name: String,
    #[serde(rename = "Id")]
    id: String,
    created: String,
    scope: String,
    driver: String,
    #[serde(rename = "EnableIPv6")]
    ipv6: bool,
    internal: bool,
    labels: BTreeMap<String, String>,
}

/// `/networks` as the Services tree's network rows.
fn map_networks(body: &str) -> Vec<DockerNetwork> {
    let mut out: Vec<DockerNetwork> = serde_json::from_str::<Vec<ApiNetwork>>(body)
        .unwrap_or_default()
        .into_iter()
        .map(|r| DockerNetwork {
            compose_project: r.labels.get(COMPOSE_PROJECT).filter(|s| !s.is_empty()).cloned(),
            id: r.id,
            name: r.name,
            driver: r.driver,
            scope: r.scope,
            created_at: r.created,
            ipv6: r.ipv6,
            internal: r.internal,
            labels: r.labels,
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Bytes as the docker CLI prints them: decimal units, three significant digits.
fn human_size(bytes: i64) -> String {
    let units = ["B", "kB", "MB", "GB", "TB", "PB"];
    if bytes <= 0 {
        return "0B".into();
    }
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1000.0 && unit < units.len() - 1 {
        value /= 1000.0;
        unit += 1;
    }
    if unit == 0 {
        return format!("{bytes}B");
    }
    let mut text = format!("{value:.3}");
    if let Some(dot) = text.find('.') {
        let bytes = text.as_bytes();
        let mut end = text.len();
        while end > dot + 1 && bytes[end - 1] == b'0' {
            end -= 1;
        }
        text.truncate(end);
        if text.ends_with('.') {
            text.pop();
        }
    }
    format!("{text}{}", units[unit])
}

/// A duration as the docker CLI prints it, e.g. `About a minute ago`.
fn human_duration(seconds: i64) -> String {
    if seconds < 1 {
        return "Less than a second ago".into();
    }
    if seconds == 1 {
        return "1 second ago".into();
    }
    if seconds < 60 {
        return format!("{seconds} seconds ago");
    }
    let minutes = seconds / 60;
    if minutes == 1 {
        return "About a minute ago".into();
    }
    if minutes < 60 {
        return format!("{minutes} minutes ago");
    }
    let hours = seconds / 3600;
    if hours == 1 {
        return "About an hour ago".into();
    }
    if hours < 48 {
        return format!("{hours} hours ago");
    }
    let days = hours / 24;
    if days < 14 {
        return format!("{days} days ago");
    }
    let weeks = days / 7;
    if days < 60 {
        return format!("{weeks} weeks ago");
    }
    let months = days / 30;
    if months == 1 {
        return "1 month ago".into();
    }
    if days < 365 {
        return format!("{months} months ago");
    }
    let years = days / 365;
    if years == 1 {
        return "1 year ago".into();
    }
    format!("{years} years ago")
}

/// Unix seconds as the docker CLI prints a `CreatedAt`: `YYYY-MM-DD HH:MM:SS +0000 UTC`.
fn unix_utc(unix: i64) -> String {
    let (y, m, d) = civil_from_days(unix.div_euclid(86_400));
    let secs = unix.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02} +0000 UTC", secs / 3600, secs % 3600 / 60, secs % 60)
}

/// Days since 1970-01-01 as a civil UTC date.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    ((if m <= 2 { y + 1 } else { y }), m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses_are_read_per_framing() {
        let plain = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\nOK";
        let resp = read_response(&mut &plain[..]).unwrap();
        assert_eq!((resp.status, resp.body), (200, b"OK".to_vec()));

        let chunked =
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\nX-T: v\r\n\r\n";
        let resp = read_response(&mut &chunked[..]).unwrap();
        assert_eq!((resp.status, resp.body), (200, b"abcde".to_vec()));

        let empty = b"HTTP/1.1 204 No Content\r\n\r\n";
        let resp = read_response(&mut &empty[..]).unwrap();
        assert_eq!((resp.status, resp.body), (204, Vec::new()));

        let garbage = b"not http\r\n\r\n";
        assert!(read_response(&mut &garbage[..]).is_err());
    }

    /// Feeds `body` one byte at a time, as a slow connection delivers it.
    fn decode(head: Head, tty: bool, body: &[u8]) -> (Vec<(bool, String)>, bool) {
        let mut lines = Vec::new();
        let mut decoder = LogDecoder::new(&head, tty);
        for b in body {
            decoder.feed(std::slice::from_ref(b), &mut |l| lines.push((l.stderr, l.text))).unwrap();
        }
        let done = decoder.done();
        decoder.finish(&mut |l| lines.push((l.stderr, l.text)));
        (lines, done)
    }

    fn frame(stream: u8, text: &str) -> Vec<u8> {
        let mut f = vec![stream, 0, 0, 0];
        f.extend((text.len() as u32).to_be_bytes());
        f.extend(text.as_bytes());
        f
    }

    #[test]
    fn engine_image_history_reads_like_the_cli() {
        let layers: Vec<ApiLayer> = serde_json::from_str(
            r#"[{"Id":"sha256:abc","Created":1000,"CreatedBy":"CMD [\"python3\"]","Size":20500,"Comment":"buildkit","Tags":["py:3"]},
                {"Id":"<missing>","Created":940,"CreatedBy":"RUN x","Size":0,"Comment":""}]"#,
        )
        .unwrap();
        let rows = map_layers(layers, 1000 + 2 * 7 * 86_400);
        assert_eq!(
            rows.iter().map(|l| (l.id.as_str(), l.size.as_str(), l.created_since.as_str())).collect::<Vec<_>>(),
            [("sha256:abc", "20.5kB", "2 weeks ago"), ("<missing>", "0B", "2 weeks ago")]
        );
        assert_eq!(rows[0].created_by, "CMD [\"python3\"]");
        let top: ApiTop = serde_json::from_str(r#"{"Titles":["PID","CMD"],"Processes":[["1","sh"]]}"#).unwrap();
        assert_eq!(
            (top.titles, top.processes),
            (vec!["PID".to_owned(), "CMD".to_owned()], vec![vec!["1".to_owned(), "sh".to_owned()]])
        );
    }

    #[test]
    fn container_logs_split_into_stream_lines_across_chunks_and_frames() {
        // Frames split mid-line, a CRLF line, and a stderr line between stdout parts.
        let mut framed = frame(1, "tick 1\r\ntick");
        framed.extend(frame(2, "oops\n"));
        framed.extend(frame(1, " 2\nlast"));
        let mut chunked = Vec::new();
        for part in framed.chunks(7) {
            chunked.extend(format!("{:x}\r\n", part.len()).as_bytes());
            chunked.extend(part);
            chunked.extend(b"\r\n");
        }
        chunked.extend(b"0\r\n\r\n");
        let (lines, done) = decode(Head { status: 200, chunked: true, length: None }, false, &chunked);
        assert!(done);
        let expected = [(false, "tick 1"), (true, "oops"), (false, "tick 2"), (false, "last")];
        assert_eq!(lines, expected.map(|(e, t)| (e, t.to_owned())));

        // A TTY container's log is one raw stream; the body may end with the connection.
        let (lines, done) = decode(Head { status: 200, chunked: false, length: None }, true, b"a\r\nb\n");
        assert!(!done);
        assert_eq!(lines, [(false, "a".to_owned()), (false, "b".to_owned())]);

        // A Content-Length body ends after its length.
        let body = frame(1, "one\n");
        let (lines, done) = decode(Head { status: 200, chunked: false, length: Some(body.len()) }, false, &body);
        assert!(done);
        assert_eq!(lines, [(false, "one".to_owned())]);
    }

    #[test]
    fn daemon_errors_carry_their_message() {
        let resp = Response { status: 404, body: br#"{"message":"No such container: missing"}"#.to_vec() };
        assert!(check(resp).is_err());

        let resp = Response { status: 500, body: br#"{"message":"driver failed"}"#.to_vec() };
        assert!(check(resp).is_err());

        let resp = Response { status: 200, body: b"{}".to_vec() };
        assert_eq!(check(resp).unwrap(), "{}");
    }

    #[test]
    fn endpoints_resolve_to_daemon_addresses() {
        #[cfg(unix)]
        assert_eq!(
            address(&DockerEndpoint::Socket { path: "/var/run/docker.sock".into() }),
            Some(Address::UnixSocket("/var/run/docker.sock".into()))
        );
        #[cfg(unix)]
        assert_eq!(
            address(&DockerEndpoint::Socket { path: "unix:///tmp/d.sock".into() }),
            Some(Address::UnixSocket("/tmp/d.sock".into()))
        );
        assert_eq!(
            address(&DockerEndpoint::Tcp { host: "build:2376".into(), tls_cert_dir: None }),
            Some(Address::Tcp { host: "build".into(), port: 2376 })
        );
        assert_eq!(
            address(&DockerEndpoint::Tcp { host: "tcp://127.0.0.1:2375".into(), tls_cert_dir: None }),
            Some(Address::Tcp { host: "127.0.0.1".into(), port: 2375 })
        );
        assert_eq!(address(&DockerEndpoint::Tcp { host: "ssh://me@box".into(), tls_cert_dir: None }), None);
        assert_eq!(
            address(&DockerEndpoint::Tcp { host: "build:2376".into(), tls_cert_dir: Some("/certs".into()) }),
            None
        );
        assert_eq!(
            address(&DockerEndpoint::Tcp { host: "build:2376".into(), tls_cert_dir: Some(" ".into()) }),
            Some(Address::Tcp { host: "build".into(), port: 2376 })
        );
        assert_eq!(address(&DockerEndpoint::Context { name: "orbstack".into() }), None);
        assert_eq!(address(&DockerEndpoint::Ssh { config: "box".into() }), None);
    }

    #[test]
    fn the_default_daemon_comes_from_docker_host_or_the_socket() {
        assert_eq!(default_address(Some("tcp://h:1")), Some(Address::Tcp { host: "h".into(), port: 1 }));
        assert_eq!(default_address(Some("ssh://me@box")), None);
        assert_eq!(default_address(Some("https://h:2376")), None);
        #[cfg(unix)]
        assert_eq!(default_address(Some("unix:///tmp/d.sock")), Some(Address::UnixSocket("/tmp/d.sock".into())));
        #[cfg(unix)]
        assert_eq!(default_address(None), Some(Address::UnixSocket("/var/run/docker.sock".into())));
    }

    #[test]
    fn host_ports_accept_the_usual_shapes() {
        assert_eq!(host_port("build:2376"), Some(("build".into(), 2376)));
        assert_eq!(host_port("build"), Some(("build".into(), DEFAULT_PORT)));
        assert_eq!(host_port("build:"), Some(("build".into(), DEFAULT_PORT)));
        assert_eq!(host_port("[::1]:2375"), Some(("::1".into(), 2375)));
        assert_eq!(host_port("[::1]"), Some(("::1".into(), DEFAULT_PORT)));
        assert_eq!(host_port(""), None);
    }

    #[test]
    fn engine_containers_fill_the_service_rows() {
        let body = r#"[
            {"Id":"c2","Names":["/web"],"Image":"nginx","Command":"nginx -g 'daemon off;'",
             "Created":1700000000,"State":"running","Status":"Up 2 hours",
             "Ports":[{"IP":"0.0.0.0","PrivatePort":80,"PublicPort":8080,"Type":"tcp"},
                      {"PrivatePort":443,"Type":"tcp"}],
             "Labels":{"com.docker.compose.project":"demo","com.docker.compose.project.working_dir":"/w",
                       "com.docker.compose.project.config_files":"/w/x.yml,/w/y.yml",
                       "com.docker.compose.service":"web"},
             "Mounts":[{"Type":"volume","Name":"data","Source":"/v/data","Destination":"/data"},
                       {"Type":"bind","Source":"/home/me/app","Destination":"/app"}],
             "NetworkSettings":{"Networks":{"bridge":{},"webnet":{}}}},
            {"Id":"c1","Names":["/db"],"Image":"postgres","Command":"postgres","Created":1700000001,
             "State":"exited","Status":"Exited (0) 5 minutes ago","Ports":[],
             "Labels":{},"Mounts":[],"NetworkSettings":{"Networks":{}}}
        ]"#;
        let rows = map_containers(body);
        assert_eq!(rows.len(), 2);
        let db = rows.iter().find(|c| c.name == "db").unwrap();
        assert_eq!(db.state, "exited");
        assert_eq!(db.ports, "");
        assert!(db.networks.is_empty());
        let web = rows.iter().find(|c| c.name == "web").unwrap();
        assert_eq!(web.ports, "0.0.0.0:8080->80/tcp, 443/tcp");
        assert_eq!(web.networks, vec!["bridge", "webnet"]);
        assert_eq!(web.mounts, vec!["data", "/home/me/app"]);
        assert_eq!(web.compose_project.as_deref(), Some("demo"));
        assert_eq!(web.compose_service.as_deref(), Some("web"));
        assert_eq!(web.compose_working_dir.as_deref(), Some("/w"));
        assert_eq!(web.compose_files, vec!["/w/x.yml", "/w/y.yml"]);
        assert_eq!(web.created_at, "2023-11-14 22:13:20 +0000 UTC");
    }

    #[test]
    fn engine_images_list_one_row_per_tag_and_dangling_last() {
        let body = r#"[
            {"Id":"sha256:feedfacecafe0000","RepoTags":["localhost:5000/app:1","app:latest"],
             "Created":1700000000,"Size":45600000},
            {"Id":"sha256:deadbeef00000000","RepoTags":["<none>:<none>"],"Created":1699990000,"Size":123000000},
            {"Id":"sha256:cafebabef0000000","RepoTags":[],"Created":1699980000,"Size":0}
        ]"#;
        let rows = map_images(body);
        assert_eq!(rows.len(), 4);
        let dangling: Vec<&DockerImage> = rows.iter().filter(|i| i.repository == "<none>").collect();
        assert_eq!(dangling.len(), 2);
        assert!(
            rows[..2].iter().all(|i| i.repository != "<none>") && rows[2..].iter().all(|i| i.repository == "<none>"),
            "dangling rows sort last"
        );
        let app = rows.iter().find(|i| i.repository == "localhost:5000/app").unwrap();
        assert_eq!(app.tag, "1");
        assert_eq!(app.size, "45.6MB");
        let latest = rows.iter().find(|i| i.repository == "app").unwrap();
        assert_eq!(latest.tag, "latest");
        assert_eq!(latest.size, "45.6MB");
        assert_eq!(dangling[0].size, "123MB");
        assert_eq!(dangling[1].size, "0B");
    }

    #[test]
    fn engine_volumes_and_networks_fill_the_service_rows() {
        let volumes = map_volumes(
            r#"{"Volumes":[{"Name":"data","Driver":"local","Mountpoint":"/v/data","Scope":"local",
                "Labels":{"com.docker.compose.project":"demo"}}],"Warnings":[]}"#,
        );
        assert_eq!(volumes.len(), 1);
        assert_eq!(volumes[0].compose_project.as_deref(), Some("demo"));
        assert_eq!(volumes[0].scope, "local");

        let networks = map_networks(
            r#"[{"Name":"bridge","Id":"n1","Created":"2023-11-14T22:13:20Z","Scope":"local","Driver":"bridge",
                 "EnableIPv6":false,"Internal":false,"Labels":{}},
                {"Name":"webnet","Id":"n2","Created":"2023-11-14T22:13:21Z","Scope":"local","Driver":"bridge",
                 "EnableIPv6":true,"Internal":true,"Labels":{}}]"#,
        );
        assert_eq!(networks.len(), 2);
        assert_eq!(networks[0].name, "bridge");
        assert!(!networks[0].ipv6);
        let webnet = &networks[1];
        assert!(webnet.ipv6 && webnet.internal);
    }

    #[test]
    fn sizes_and_durations_read_like_the_cli_prints_them() {
        for (bytes, text) in
            [(0, "0B"), (999, "999B"), (123_000, "123kB"), (45_600_000, "45.6MB"), (1_234_000_000, "1.234GB")]
        {
            assert_eq!(human_size(bytes), text);
        }
        for (seconds, text) in [
            (0, "Less than a second ago"),
            (1, "1 second ago"),
            (59, "59 seconds ago"),
            (60, "About a minute ago"),
            (119, "About a minute ago"),
            (3_600, "About an hour ago"),
            (7_200, "2 hours ago"),
            (86_400, "24 hours ago"),
            (49 * 3_600, "2 days ago"),
            (3 * 86_400, "3 days ago"),
            (8 * 86_400, "8 days ago"),
            (14 * 86_400, "2 weeks ago"),
            (400 * 86_400, "1 year ago"),
        ] {
            assert_eq!(human_duration(seconds), text);
        }
    }

    #[test]
    fn ids_are_safe_as_url_path_segments() {
        assert_eq!(path_segment("abc123-x_y.z"), "abc123-x_y.z");
        assert_eq!(path_segment("postgres:16"), "postgres%3A16");
        assert_eq!(path_segment("a/b"), "a%2Fb");
        assert_eq!(path_segment(" sha256:ab "), "sha256%3Aab");
    }
}
