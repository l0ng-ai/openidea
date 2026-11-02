use ide_core::{IdeError, IdeResult};
use parking_lot::RwLock;
use percent_encoding::{AsciiSet, CONTROLS, percent_decode_str, utf8_percent_encode};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

/// IDEA's built-in server port, tried first so bookmarked URLs keep working.
const PREFERRED_PORT: u16 = 63342;
const MAX_HEAD: usize = 16 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(10);

/// Characters escaped in one URL path segment.
const SEGMENT: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'/')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

struct Shared {
    token: String,
    /// URL key (`/<token>/<key>/…`) → served directory.
    roots: RwLock<HashMap<String, PathBuf>>,
}

/// The built-in web server; started on the first [`WebServer::url_for`].
pub struct WebServer {
    shared: Arc<Shared>,
    port: tokio::sync::OnceCell<u16>,
}

impl Default for WebServer {
    fn default() -> Self {
        Self::new()
    }
}

impl WebServer {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Shared { token: uuid::Uuid::new_v4().simple().to_string(), roots: RwLock::default() }),
            port: tokio::sync::OnceCell::new(),
        }
    }

    /// The URL serving `file`: under `root` (the project) when it contains the
    /// file, else under the file's directory. Starts the server if needed.
    pub async fn url_for(&self, root: Option<&Path>, file: &Path) -> IdeResult<String> {
        let base = match root {
            Some(r) if file.starts_with(r) && file != r => r,
            _ => file.parent().ok_or_else(|| IdeError::invalid(format!("no directory: {}", file.display())))?,
        };
        let rel = file.strip_prefix(base).map_err(|e| IdeError::internal(e.to_string()))?;
        let port = self.port().await?;
        let key = self.register(base);
        let mut url = format!("http://127.0.0.1:{port}/{}/{}", self.shared.token, enc(&key));
        for c in rel.components() {
            url.push('/');
            url.push_str(&enc(&c.as_os_str().to_string_lossy()));
        }
        Ok(url)
    }

    /// The key `dir` is served under: its name, made unique.
    fn register(&self, dir: &Path) -> String {
        let mut roots = self.shared.roots.write();
        if let Some((k, _)) = roots.iter().find(|(_, d)| d.as_path() == dir) {
            return k.clone();
        }
        let name: String = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
            .chars()
            .map(|c| if c.is_alphanumeric() || "._-".contains(c) { c } else { '_' })
            .collect();
        let name = if name.is_empty() || name == "." || name == ".." { "root".to_string() } else { name };
        let key = (1..)
            .map(|i| if i == 1 { name.clone() } else { format!("{name}-{i}") })
            .find(|k| !roots.contains_key(k))
            .expect("unbounded");
        roots.insert(key.clone(), dir.to_path_buf());
        key
    }

    async fn port(&self) -> IdeResult<u16> {
        self.port
            .get_or_try_init(|| async {
                let listener = match TcpListener::bind(("127.0.0.1", PREFERRED_PORT)).await {
                    Ok(l) => l,
                    Err(_) => TcpListener::bind(("127.0.0.1", 0)).await?,
                };
                let port = listener.local_addr()?.port();
                let shared = self.shared.clone();
                tokio::spawn(async move {
                    loop {
                        match listener.accept().await {
                            Ok((sock, _)) => {
                                let shared = shared.clone();
                                tokio::spawn(async move {
                                    if let Err(e) = serve(sock, &shared, port).await {
                                        tracing::debug!("web server: {e}");
                                    }
                                });
                            }
                            Err(e) => {
                                tracing::warn!("web server accept: {e}");
                                tokio::time::sleep(Duration::from_millis(100)).await;
                            }
                        }
                    }
                });
                tracing::info!("built-in web server on 127.0.0.1:{port}");
                Ok::<_, std::io::Error>(port)
            })
            .await
            .copied()
            .map_err(|e| IdeError::unavailable(format!("cannot start the built-in web server: {e}")))
    }
}

fn enc(s: &str) -> String {
    utf8_percent_encode(s, SEGMENT).to_string()
}

struct Request {
    method: String,
    target: String,
    host: Option<String>,
}

async fn read_head(sock: &mut TcpStream) -> std::io::Result<Option<Request>> {
    let mut reader = BufReader::new(sock).take(MAX_HEAD as u64);
    let mut line = String::new();
    if reader.read_line(&mut line).await? == 0 {
        return Ok(None);
    }
    let mut parts = line.split_whitespace();
    let (Some(method), Some(target)) = (parts.next(), parts.next()) else { return Ok(None) };
    let (method, target) = (method.to_string(), target.to_string());
    let mut host = None;
    loop {
        line.clear();
        if reader.read_line(&mut line).await? == 0 {
            return Ok(None);
        }
        let l = line.trim_end();
        if l.is_empty() {
            break;
        }
        if let Some((name, value)) = l.split_once(':')
            && name.eq_ignore_ascii_case("host")
        {
            host = Some(value.trim().to_ascii_lowercase());
        }
    }
    Ok(Some(Request { method, target, host }))
}

enum Response {
    File { path: PathBuf, len: u64 },
    Redirect(String),
    Error(u16, &'static str),
}

async fn serve(mut sock: TcpStream, shared: &Shared, port: u16) -> std::io::Result<()> {
    let Ok(head) = tokio::time::timeout(READ_TIMEOUT, read_head(&mut sock)).await else { return Ok(()) };
    let Some(req) = head? else { return Ok(()) };
    let head_only = req.method == "HEAD";
    let response = if !matches!(req.method.as_str(), "GET" | "HEAD") {
        Response::Error(405, "Method Not Allowed")
    } else if !host_allowed(req.host.as_deref(), port) {
        Response::Error(403, "Forbidden")
    } else {
        resolve(shared, &req.target).await
    };
    let mut out = String::new();
    match &response {
        Response::File { path, len } => {
            out.push_str("HTTP/1.1 200 OK\r\n");
            out.push_str(&format!("Content-Type: {}\r\nContent-Length: {len}\r\n", content_type(path)));
        }
        Response::Redirect(to) => {
            out.push_str(&format!("HTTP/1.1 301 Moved Permanently\r\nLocation: {to}\r\nContent-Length: 0\r\n"));
        }
        Response::Error(code, reason) => {
            out.push_str(&format!(
                "HTTP/1.1 {code} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\n",
                reason.len()
            ));
        }
    }
    out.push_str("Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n");
    sock.write_all(out.as_bytes()).await?;
    if !head_only {
        match response {
            Response::File { path, .. } => {
                let mut file = tokio::fs::File::open(&path).await?;
                tokio::io::copy(&mut file, &mut sock).await?;
            }
            Response::Error(_, reason) => sock.write_all(reason.as_bytes()).await?,
            Response::Redirect(_) => {}
        }
    }
    sock.shutdown().await
}

fn host_allowed(host: Option<&str>, port: u16) -> bool {
    host.is_some_and(|h| h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"))
}

async fn resolve(shared: &Shared, target: &str) -> Response {
    const NOT_FOUND: Response = Response::Error(404, "Not Found");
    let path = target.split(['?', '#']).next().unwrap_or("");
    let Some(rest) = path.strip_prefix('/') else { return NOT_FOUND };
    let mut segments = rest.split('/');
    if segments.next() != Some(shared.token.as_str()) {
        return NOT_FOUND;
    }
    let Some(key) = segments.next().and_then(dec) else { return NOT_FOUND };
    let Some(root) = shared.roots.read().get(&key).cloned() else { return NOT_FOUND };
    let mut file = root.clone();
    let mut trailing_slash = true;
    for seg in segments {
        trailing_slash = seg.is_empty();
        if seg.is_empty() {
            continue;
        }
        match dec(seg) {
            Some(s) if s != "." && s != ".." && !s.contains(['/', '\\', ':', '\0']) => file.push(s),
            _ => return NOT_FOUND,
        }
    }
    let Ok(mut meta) = tokio::fs::metadata(&file).await else { return NOT_FOUND };
    if meta.is_dir() {
        // Relative URLs in an index page resolve against the directory.
        if !trailing_slash {
            return Response::Redirect(format!("{path}/"));
        }
        file.push("index.html");
        let Ok(m) = tokio::fs::metadata(&file).await else { return NOT_FOUND };
        if !m.is_file() {
            return NOT_FOUND;
        }
        meta = m;
    }
    // Symlinks must not serve anything outside the served root (a committed
    // `x -> /` would leak the whole disk): compare the real paths, so links
    // inside the root keep working while links out are refused.
    let (Ok(real_file), Ok(real_root)) = tokio::join!(tokio::fs::canonicalize(&file), tokio::fs::canonicalize(&root))
    else {
        return NOT_FOUND;
    };
    if !real_file.starts_with(&real_root) {
        return NOT_FOUND;
    }
    Response::File { path: file, len: meta.len() }
}

fn dec(s: &str) -> Option<String> {
    percent_decode_str(s).decode_utf8().ok().map(|s| s.into_owned())
}

fn content_type(path: &Path) -> &'static str {
    let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" | "xhtml" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" | "webmanifest" => "application/json; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "txt" | "md" | "csv" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn get(url: &str, host: Option<&str>) -> String {
        let rest = url.strip_prefix("http://").unwrap();
        let (authority, path) = rest.split_at(rest.find('/').unwrap());
        let mut sock = TcpStream::connect(authority).await.unwrap();
        let host = host.unwrap_or(authority);
        sock.write_all(format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n\r\n").as_bytes()).await.unwrap();
        let mut out = String::new();
        sock.read_to_string(&mut out).await.unwrap();
        out
    }

    #[tokio::test]
    async fn serves_project_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("my app");
        std::fs::create_dir_all(root.join("web/sub")).unwrap();
        std::fs::write(root.join("web/index.html"), "<h1>hi</h1>").unwrap();
        std::fs::write(root.join("web/sub/a b.js"), "export {}").unwrap();
        std::fs::write(dir.path().join("secret.txt"), "no").unwrap();

        let server = WebServer::new();
        let url = server.url_for(Some(&root), &root.join("web/index.html")).await.unwrap();
        assert!(url.ends_with("/my_app/web/index.html"), "{url}");
        let page = get(&url, None).await;
        assert!(page.starts_with("HTTP/1.1 200"), "{page}");
        assert!(page.contains("text/html") && page.ends_with("<h1>hi</h1>"));

        let base = url.trim_end_matches("/web/index.html");
        assert!(get(&format!("{base}/web/sub/a%20b.js"), None).await.contains("text/javascript"));
        assert!(get(&format!("{base}/web"), None).await.contains("Location: /"));
        assert!(get(&format!("{base}/web/"), None).await.ends_with("<h1>hi</h1>"));
        assert!(get(&format!("{base}/../secret.txt"), None).await.starts_with("HTTP/1.1 404"));
        assert!(get(&format!("{base}/%2e%2e/secret.txt"), None).await.starts_with("HTTP/1.1 404"));
        assert!(get(&format!("{base}/web/..%2f..%2fsecret.txt"), None).await.starts_with("HTTP/1.1 404"));
        // Wrong token, foreign Host (DNS rebinding).
        let other = url.replacen(&server.shared.token, "0123", 1);
        assert!(get(&other, None).await.starts_with("HTTP/1.1 404"));
        assert!(get(&url, Some("evil.example:80")).await.starts_with("HTTP/1.1 403"));
    }

    #[tokio::test]
    async fn files_outside_the_project_get_their_own_root() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("x/site"), dir.path().join("y/site"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let server = WebServer::new();
        let ua = server.url_for(None, &a.join("p.html")).await.unwrap();
        let ub = server.url_for(Some(&a), &b.join("p.html")).await.unwrap();
        assert!(ua.ends_with("/site/p.html") && ub.ends_with("/site-2/p.html"), "{ua} {ub}");
        assert_eq!(server.url_for(None, &a.join("q.html")).await.unwrap(), ua.replace("p.html", "q.html"));
    }

    fn symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link)
        }
        #[cfg(windows)]
        {
            if target.is_dir() {
                std::os::windows::fs::symlink_dir(target, link)
            } else {
                std::os::windows::fs::symlink_file(target, link)
            }
        }
    }

    #[tokio::test]
    async fn symlinks_may_not_leave_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("index.html"), "<h1>hi</h1>").unwrap();
        std::fs::write(dir.path().join("secret.txt"), "SECRET").unwrap();
        let outside_file = symlink(&dir.path().join("secret.txt"), &root.join("leak")).is_ok();
        let outside_dir = symlink(&dir.path(), &root.join("rootlink")).is_ok();
        let inside = symlink(&root.join("index.html"), &root.join("copy.html")).is_ok();
        if !(outside_file && outside_dir && inside) {
            eprintln!("skipped: this account cannot create symlinks");
            return;
        }

        let server = WebServer::new();
        let url = server.url_for(Some(&root), &root.join("index.html")).await.unwrap();
        let base = url.trim_end_matches("/index.html");
        // Links out of the root are refused, links inside it keep working.
        assert!(get(&format!("{base}/leak"), None).await.starts_with("HTTP/1.1 404"));
        assert!(get(&format!("{base}/rootlink/secret.txt"), None).await.starts_with("HTTP/1.1 404"));
        let page = get(&format!("{base}/copy.html"), None).await;
        assert!(page.starts_with("HTTP/1.1 200") && page.ends_with("<h1>hi</h1>"));
    }
}
