use ide_core::{IdeError, IdeResult};
use percent_encoding::{AsciiSet, CONTROLS, percent_decode_str, utf8_percent_encode};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

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

/// A served directory, at `http://127.0.0.1:<port>/<token>/<key>/…`. The port and the token
/// are its own. The port makes it another origin to a browser, which does not let a page of
/// one root read a response of another. The token keeps such a page from naming a file of
/// another root at all: a port can be found by scanning and a key guessed, a token cannot.
///
/// Storage is not isolated for good: cookies are per host, not per port, and a port may
/// serve another root on a later run.
struct Root {
    key: String,
    token: String,
    dir: PathBuf,
    port: u16,
    serves: Serves,
}

/// What of its directory a root serves.
#[derive(PartialEq)]
enum Serves {
    /// A project: all of it.
    All,
    /// Everything below the folder of a file outside the project, so the page loads its
    /// scripts and styles, except what has a dot name on the way to it (`.ssh`, `.env`).
    Folder,
    /// This one file outside the project, resolved. Its folder is the home folder or lies
    /// above it, where credentials have names anyone knows, with a dot or without
    /// (`AppData`, `Library`); or that cannot be told; or its own name starts with a dot.
    File(PathBuf),
}

/// The built-in web server; a root starts being served on the first [`WebServer::url_for`] in it.
pub struct WebServer {
    /// URL key → what is served under it.
    roots: tokio::sync::Mutex<HashMap<String, Arc<Root>>>,
    /// The home folder, resolved.
    home: Option<PathBuf>,
}

impl Default for WebServer {
    fn default() -> Self {
        Self::new()
    }
}

impl WebServer {
    pub fn new() -> Self {
        let home = dirs::home_dir().and_then(|home| std::fs::canonicalize(home).ok());
        if home.is_none() {
            tracing::warn!("built-in web server: no home folder, so files outside a project are served alone");
        }
        Self { roots: Default::default(), home }
    }

    /// The URL serving `file`: under `root` (the project) when it contains the
    /// file, else under the file's directory. Starts the server if needed.
    ///
    /// A project that is the home folder, or holds it, is no boundary to serve whole: its
    /// files are served like files outside a project.
    pub async fn url_for(&self, root: Option<&Path>, file: &Path) -> IdeResult<String> {
        let (base, serves) = match root {
            Some(r) if file.starts_with(r) && file != r && self.holds_home(r).await != Some(true) => (r, Serves::All),
            _ => {
                let dir =
                    file.parent().ok_or_else(|| IdeError::invalid(format!("no directory: {}", file.display())))?;
                (dir, self.outside(dir, file).await?)
            }
        };
        let rel = file.strip_prefix(base).map_err(|e| IdeError::internal(e.to_string()))?;
        let root = self.root(base, serves).await?;
        let mut url = format!("http://127.0.0.1:{}/{}/{}", root.port, root.token, enc(&root.key));
        for c in rel.components() {
            url.push('/');
            url.push_str(&enc(&c.as_os_str().to_string_lossy()));
        }
        Ok(url)
    }

    /// Whether `dir` is the home folder or lies above it; `None` when that cannot be told.
    async fn holds_home(&self, dir: &Path) -> Option<bool> {
        let dir = tokio::fs::canonicalize(dir).await.ok()?;
        Some(self.home.as_ref()?.starts_with(dir))
    }

    /// How much of `dir` is served for `file` in it, a file outside the project: the folder
    /// only when it is known not to hold the home folder.
    async fn outside(&self, dir: &Path, file: &Path) -> IdeResult<Serves> {
        let dot_file = file.file_name().is_some_and(|name| name.to_string_lossy().starts_with('.'));
        if self.holds_home(dir).await == Some(false) && !dot_file {
            return Ok(Serves::Folder);
        }
        let resolved = tokio::fs::canonicalize(file).await;
        Ok(Serves::File(resolved.map_err(|e| IdeError::invalid(format!("cannot serve {}: {e}", file.display())))?))
    }

    /// `dir` as a served root, listening from now on if it was not yet. Its key is its name,
    /// made unique.
    async fn root(&self, dir: &Path, serves: Serves) -> IdeResult<Arc<Root>> {
        let mut roots = self.roots.lock().await;
        if let Some(root) = roots.values().find(|r| r.dir == dir && r.serves == serves) {
            return Ok(root.clone());
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
        // No fixed port: it would hand the browser storage of whichever root took it on one
        // run to whichever takes it on the next.
        let unavailable =
            |e: std::io::Error| IdeError::unavailable(format!("cannot start the built-in web server: {e}"));
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(unavailable)?;
        let port = listener.local_addr().map_err(unavailable)?.port();
        let root = Arc::new(Root {
            key: key.clone(),
            token: uuid::Uuid::new_v4().simple().to_string(),
            dir: dir.to_path_buf(),
            port,
            serves,
        });
        tokio::spawn(accept(listener, root.clone()));
        tracing::info!("built-in web server on 127.0.0.1:{} for {}", root.port, dir.display());
        roots.insert(key, root.clone());
        Ok(root)
    }
}

async fn accept(listener: TcpListener, root: Arc<Root>) {
    loop {
        match listener.accept().await {
            Ok((sock, _)) => {
                let root = root.clone();
                tokio::spawn(async move {
                    if let Err(e) = serve(sock, &root).await {
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
    /// `path` is the resolved file to open; `mime` comes from the requested name.
    File {
        path: PathBuf,
        len: u64,
        mime: &'static str,
    },
    Redirect(String),
    Error(u16, &'static str),
}

async fn serve(mut sock: TcpStream, root: &Root) -> std::io::Result<()> {
    let Ok(head) = tokio::time::timeout(READ_TIMEOUT, read_head(&mut sock)).await else { return Ok(()) };
    let Some(req) = head? else { return Ok(()) };
    let head_only = req.method == "HEAD";
    let response = if !matches!(req.method.as_str(), "GET" | "HEAD") {
        Response::Error(405, "Method Not Allowed")
    } else if !host_allowed(req.host.as_deref()) {
        Response::Error(403, "Forbidden")
    } else {
        resolve(root, &req.target).await
    };
    let mut out = String::new();
    match &response {
        Response::File { len, mime, .. } => {
            out.push_str("HTTP/1.1 200 OK\r\n");
            out.push_str(&format!("Content-Type: {mime}\r\nContent-Length: {len}\r\n"));
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
    out.push_str("Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n");
    // A page of another origin (another root's too) cannot load what is served here as a
    // script, style or image. Browsers do not apply this to frames or navigations.
    out.push_str("Cross-Origin-Resource-Policy: same-origin\r\nConnection: close\r\n\r\n");
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

/// Loopback names only (DNS rebinding). Any port: a remote host's server is reached through
/// a forwarded port of the client, and a browser names the port it connected to anyway.
fn host_allowed(host: Option<&str>) -> bool {
    host.and_then(|h| h.rsplit_once(':'))
        .is_some_and(|(name, port)| matches!(name, "127.0.0.1" | "localhost") && port.parse::<u16>().is_ok())
}

async fn resolve(root: &Root, target: &str) -> Response {
    const NOT_FOUND: Response = Response::Error(404, "Not Found");
    let path = target.split(['?', '#']).next().unwrap_or("");
    let Some(rest) = path.strip_prefix('/') else { return NOT_FOUND };
    let mut segments = rest.split('/');
    // A listener answers for its own root only, to its own token only.
    if segments.next() != Some(root.token.as_str()) {
        return NOT_FOUND;
    }
    if segments.next().and_then(dec).as_deref() != Some(root.key.as_str()) {
        return NOT_FOUND;
    }
    let Ok(real_root) = tokio::fs::canonicalize(&root.dir).await else { return NOT_FOUND };
    let mut file = root.dir.clone();
    // `/<token>/<key>` names a directory too: it redirects like any other.
    let trailing_slash = path.ends_with('/');
    for seg in segments {
        if seg.is_empty() {
            continue;
        }
        match dec(seg) {
            Some(s) if s != "." && s != ".." && !s.contains(['/', '\\', ':', '\0']) => file.push(s),
            _ => return NOT_FOUND,
        }
    }
    let Some(real) = confined(root, &real_root, &file).await else { return NOT_FOUND };
    let Ok(meta) = tokio::fs::metadata(&real).await else { return NOT_FOUND };
    if meta.is_dir() {
        // Relative URLs in an index page resolve against the directory.
        if !trailing_slash {
            return Response::Redirect(format!("{path}/"));
        }
        let index = file.join("index.html");
        let Some(real_index) = confined(root, &real_root, &index).await else { return NOT_FOUND };
        return match tokio::fs::metadata(&real_index).await {
            Ok(m) if m.is_file() => Response::File { path: real_index, len: m.len(), mime: content_type(&index) },
            _ => NOT_FOUND,
        };
    }
    Response::File { path: real, len: meta.len(), mime: content_type(&file) }
}

/// `path` with every symlink resolved, if `root` serves it: it lies inside `real_root`
/// (already canonical) and is within what the root serves. Rejecting `..` segments is not
/// enough: a project can commit symlinks that point anywhere on disk. A dot is looked for
/// in the resolved path because a link or a Windows short name (`SSH~1`) names a dot folder
/// without the dot.
async fn confined(root: &Root, real_root: &Path, path: &Path) -> Option<PathBuf> {
    let real = tokio::fs::canonicalize(path).await.ok()?;
    let below = real.strip_prefix(real_root).ok()?;
    let served = match &root.serves {
        Serves::All => true,
        Serves::Folder => !below.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.')),
        Serves::File(file) => real == *file,
    };
    served.then_some(real)
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

    /// A server whose home folder is nowhere near what a test serves.
    fn server() -> WebServer {
        WebServer { home: Some("no-such-home".into()), ..WebServer::new() }
    }

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
        // The served root itself, so relative URLs of its index page resolve inside it.
        let page = get(base, None).await;
        let root_path = base.trim_start_matches("http://").split_once('/').unwrap().1;
        assert!(page.starts_with("HTTP/1.1 301") && page.contains(&format!("Location: /{root_path}/\r\n")), "{page}");
        assert!(get(&format!("{base}/web/"), None).await.ends_with("<h1>hi</h1>"));
        assert!(get(&format!("{base}/../secret.txt"), None).await.starts_with("HTTP/1.1 404"));
        assert!(get(&format!("{base}/%2e%2e/secret.txt"), None).await.starts_with("HTTP/1.1 404"));
        assert!(get(&format!("{base}/web/..%2f..%2fsecret.txt"), None).await.starts_with("HTTP/1.1 404"));
        // Wrong token, foreign Host (DNS rebinding).
        let token = url.split('/').nth(3).unwrap();
        let other = url.replacen(token, "0123", 1);
        assert!(get(&other, None).await.starts_with("HTTP/1.1 404"));
        assert!(get(&url, Some("evil.example:80")).await.starts_with("HTTP/1.1 403"));
        assert!(get(&url, Some("127.0.0.1.evil.example:80")).await.starts_with("HTTP/1.1 403"));
        // Through a forwarded port of a remote client.
        assert!(get(&url, Some("127.0.0.1:61234")).await.starts_with("HTTP/1.1 200"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinks_cannot_escape_the_served_root() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(root.join("site/escape")).unwrap();
        std::fs::create_dir_all(root.join("site/assets")).unwrap();
        std::fs::write(root.join("site/index.html"), "<h1>hi</h1>").unwrap();
        std::fs::write(root.join("site/assets/app.js"), "export {}").unwrap();
        std::fs::write(root.join("site/raw"), "<p>raw</p>").unwrap();
        std::fs::write(dir.path().join("secret.txt"), "outside").unwrap();
        symlink("index.html", root.join("site/inside.html")).unwrap();
        symlink("assets", root.join("site/lib")).unwrap();
        symlink("raw", root.join("site/raw.html")).unwrap();
        symlink("../../secret.txt", root.join("site/leak.txt")).unwrap();
        symlink("../..", root.join("site/up")).unwrap();
        symlink("/", root.join("site/fsroot")).unwrap();
        symlink("../../../secret.txt", root.join("site/escape/index.html")).unwrap();

        let server = WebServer::new();
        let url = server.url_for(Some(&root), &root.join("site/index.html")).await.unwrap();
        let base = url.trim_end_matches("index.html");
        let page = get(&format!("{base}inside.html"), None).await;
        assert!(page.starts_with("HTTP/1.1 200") && page.ends_with("<h1>hi</h1>"), "{page}");
        let page = get(&format!("{base}lib/app.js"), None).await;
        assert!(page.starts_with("HTTP/1.1 200") && page.contains("text/javascript"), "{page}");
        // The type follows the requested name, not the link target.
        let page = get(&format!("{base}raw.html"), None).await;
        assert!(page.contains("text/html") && page.ends_with("<p>raw</p>"), "{page}");

        let secret = dir.path().join("secret.txt");
        let via_fsroot = format!("fsroot{}", secret.display());
        for escape in ["leak.txt", "up/secret.txt", via_fsroot.as_str(), "escape/"] {
            let page = get(&format!("{base}{escape}"), None).await;
            assert!(page.starts_with("HTTP/1.1 404"), "{escape}: {page}");
        }
    }

    #[tokio::test]
    async fn files_outside_the_project_get_their_own_root() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("x/site"), dir.path().join("y/site"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let server = server();
        let ua = server.url_for(None, &a.join("p.html")).await.unwrap();
        let ub = server.url_for(Some(&a), &b.join("p.html")).await.unwrap();
        assert!(ua.ends_with("/site/p.html") && ub.ends_with("/site-2/p.html"), "{ua} {ub}");
        assert_eq!(server.url_for(None, &a.join("q.html")).await.unwrap(), ua.replace("p.html", "q.html"));
    }

    /// Security audit lead 1: a page served from one root must not read another root.
    #[tokio::test]
    async fn a_page_in_one_root_cannot_read_another_root() {
        let dir = tempfile::tempdir().unwrap();
        let (untrusted, victim) = (dir.path().join("untrusted"), dir.path().join("victim"));
        std::fs::create_dir_all(&untrusted).unwrap();
        std::fs::create_dir_all(&victim).unwrap();
        std::fs::write(untrusted.join("index.html"), "<script>/* attacker */</script>").unwrap();
        std::fs::write(victim.join(".env"), "DUMMY_SECRET").unwrap();
        std::fs::write(victim.join("other.html"), "<p>victim</p>").unwrap();

        let server = WebServer::new();
        let ua = server.url_for(Some(&untrusted), &untrusted.join("index.html")).await.unwrap();
        server.url_for(Some(&victim), &victim.join("other.html")).await.unwrap();
        // What a script in the untrusted page can compute from its own location.
        let cross = ua.replace("/untrusted/index.html", "/victim/.env");
        let page = get(&cross, None).await;
        assert!(!page.ends_with("DUMMY_SECRET"), "the untrusted root's origin and token read the victim root: {page}");
        assert!(page.starts_with("HTTP/1.1 404"), "{page}");
    }

    /// Security audit lead 1: the page can find the other root's port by scanning and guess its
    /// key, the folder's name. The only token it has is its own.
    #[tokio::test]
    async fn a_page_cannot_ask_another_roots_listener_with_its_own_token() {
        let dir = tempfile::tempdir().unwrap();
        let (untrusted, victim) = (dir.path().join("untrusted"), dir.path().join("victim"));
        std::fs::create_dir_all(&untrusted).unwrap();
        std::fs::create_dir_all(&victim).unwrap();
        std::fs::write(untrusted.join("index.html"), "<script>/* attacker */</script>").unwrap();
        std::fs::write(victim.join(".env"), "DUMMY_SECRET").unwrap();
        std::fs::write(victim.join("other.html"), "<p>victim</p>").unwrap();

        let server = WebServer::new();
        let ua = server.url_for(Some(&untrusted), &untrusted.join("index.html")).await.unwrap();
        let uv = server.url_for(Some(&victim), &victim.join("other.html")).await.unwrap();
        let token = |url: &str| url.split('/').nth(3).unwrap().to_string();
        let forged = uv.replacen(&token(&uv), &token(&ua), 1).replace("/other.html", "/.env");
        let page = get(&forged, None).await;
        assert!(page.starts_with("HTTP/1.1 404"), "the victim's listener answered the untrusted root's token: {page}");
        // Its own token still opens it.
        assert!(get(&uv.replace("/other.html", "/.env"), None).await.ends_with("DUMMY_SECRET"));
    }

    /// Security audit lead 1: roots do not share an origin, which is what a browser isolates
    /// (fetches, storage, service workers), and no other origin may load a served file as a
    /// script, style or image.
    #[tokio::test]
    async fn each_root_is_its_own_origin_and_keeps_its_files_from_other_origins() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("index.html"), "<h1>a</h1>").unwrap();
        std::fs::write(b.join("index.html"), "<h1>b</h1>").unwrap();
        let server = WebServer::new();
        let ua = server.url_for(Some(&a), &a.join("index.html")).await.unwrap();
        let ub = server.url_for(Some(&b), &b.join("index.html")).await.unwrap();
        let origin = |url: &str| url.split('/').take(3).collect::<Vec<_>>().join("/");
        assert_ne!(origin(&ua), origin(&ub), "{ua} {ub}");
        for (url, body) in [(&ua, "<h1>a</h1>"), (&ub, "<h1>b</h1>")] {
            let page = get(url, None).await;
            assert!(page.starts_with("HTTP/1.1 200") && page.ends_with(body), "{page}");
            assert!(page.contains("Cross-Origin-Resource-Policy: same-origin\r\n"), "{page}");
        }
        // The other root's listener does not answer for this one.
        let swapped = ub.replace(&origin(&ub), &origin(&ua));
        assert!(get(&swapped, None).await.starts_with("HTTP/1.1 404"));
    }

    /// Security audit lead 7: a file outside the project is served together with the whole
    /// folder it lies in, so a page saved to the home folder reads the keys kept there. The
    /// same page opened as `file://` reads nothing but itself.
    #[tokio::test]
    async fn a_page_outside_the_project_cannot_read_the_dot_files_of_its_folder() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        std::fs::write(home.join("saved.html"), "<script>/* attacker */</script>").unwrap();
        std::fs::write(home.join(".ssh/id_ed25519"), "DUMMY_KEY").unwrap();

        let server = server();
        let url = server.url_for(None, &home.join("saved.html")).await.unwrap();
        // What a script in the page can compute from its own location.
        let key = url.replace("/saved.html", "/.ssh/id_ed25519");
        let page = get(&key, None).await;
        assert!(!page.ends_with("DUMMY_KEY"), "a page outside the project read a key next to it: {page}");
        assert!(page.starts_with("HTTP/1.1 404"), "{page}");
        // A hidden folder is not a directory to redirect into either, however it is spelled.
        for spelling in ["/.ssh", "/.ssh/", "/%2essh/id_ed25519", "/.SSH/id_ed25519"] {
            let page = get(&url.replace("/saved.html", spelling), None).await;
            assert!(page.starts_with("HTTP/1.1 404"), "{spelling}: {page}");
        }
    }

    /// A link names a dot folder without the dot: the resolved path is what counts.
    #[tokio::test]
    async fn a_link_does_not_reach_the_dot_files_of_a_folder_outside_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("folder");
        std::fs::create_dir_all(folder.join(".ssh")).unwrap();
        std::fs::write(folder.join("saved.html"), "<script>/* attacker */</script>").unwrap();
        std::fs::write(folder.join(".ssh/id_ed25519"), "DUMMY_KEY").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(".ssh", folder.join("keys")).unwrap();
        #[cfg(windows)]
        {
            // A junction: unlike a symlink, Windows lets any user make one.
            let made = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(folder.join("keys"))
                .arg(folder.join(".ssh"))
                .output()
                .unwrap();
            assert!(made.status.success(), "{made:?}");
        }
        assert_eq!(std::fs::read_to_string(folder.join("keys/id_ed25519")).unwrap(), "DUMMY_KEY");

        let server = server();
        let url = server.url_for(None, &folder.join("saved.html")).await.unwrap();
        let page = get(&url.replace("/saved.html", "/keys/id_ed25519"), None).await;
        assert!(page.starts_with("HTTP/1.1 404"), "{page}");
    }

    /// Security audit lead 7: under the home folder lie credentials whose names anyone knows
    /// and that start with no dot (`AppData/Roaming/gcloud/credentials.db`, `Library/…`).
    #[tokio::test]
    async fn a_page_in_the_home_folder_or_above_it_is_served_alone() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(home.join("AppData/Roaming/gcloud")).unwrap();
        std::fs::create_dir_all(home.join("Downloads")).unwrap();
        std::fs::write(home.join("AppData/Roaming/gcloud/credentials.db"), "DUMMY_CREDENTIALS").unwrap();
        std::fs::write(home.join("saved.html"), "<p>saved</p>").unwrap();
        std::fs::write(home.join("notes.txt"), "DUMMY_NOTES").unwrap();
        std::fs::write(dir.path().join("top.html"), "<p>top</p>").unwrap();
        std::fs::write(home.join("Downloads/page.html"), "<p>page</p>").unwrap();
        std::fs::write(home.join("Downloads/app.js"), "export {}").unwrap();

        let server = WebServer { home: Some(std::fs::canonicalize(&home).unwrap()), ..WebServer::new() };
        let saved = server.url_for(None, &home.join("saved.html")).await.unwrap();
        assert!(get(&saved, None).await.ends_with("<p>saved</p>"));
        for other in ["/AppData/Roaming/gcloud/credentials.db", "/notes.txt", "/", "/Downloads/app.js"] {
            let page = get(&saved.replace("/saved.html", other), None).await;
            assert!(page.starts_with("HTTP/1.1 404"), "{other}: {page}");
        }
        let top = server.url_for(None, &dir.path().join("top.html")).await.unwrap();
        assert!(get(&top, None).await.ends_with("<p>top</p>"));
        let page = get(&top.replace("/top.html", "/home/AppData/Roaming/gcloud/credentials.db"), None).await;
        assert!(page.starts_with("HTTP/1.1 404"), "{page}");
        // Below the home folder a page still loads what lies beside it.
        let page = server.url_for(None, &home.join("Downloads/page.html")).await.unwrap();
        assert!(get(&page.replace("/page.html", "/app.js"), None).await.ends_with("export {}"));
    }

    /// A file outside the project whose own name starts with a dot is not refused: it is
    /// served alone.
    #[tokio::test]
    async fn a_dot_file_outside_the_project_is_served_alone() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("folder");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join(".draft.html"), "<p>draft</p>").unwrap();
        std::fs::write(folder.join("app.js"), "export {}").unwrap();

        let server = server();
        let url = server.url_for(None, &folder.join(".draft.html")).await.unwrap();
        assert!(get(&url, None).await.ends_with("<p>draft</p>"));
        assert!(get(&url.replace("/.draft.html", "/app.js"), None).await.starts_with("HTTP/1.1 404"));
    }

    #[tokio::test]
    async fn a_page_outside_the_project_loads_what_lies_beside_it() {
        let dir = tempfile::tempdir().unwrap();
        let site = dir.path().join("site");
        std::fs::create_dir_all(site.join("assets")).unwrap();
        std::fs::write(site.join("page.html"), "<h1>hi</h1>").unwrap();
        std::fs::write(site.join("app.js"), "export {}").unwrap();
        std::fs::write(site.join("assets/style.css"), "h1 {}").unwrap();

        let server = server();
        let url = server.url_for(None, &site.join("page.html")).await.unwrap();
        assert!(get(&url, None).await.ends_with("<h1>hi</h1>"));
        assert!(get(&url.replace("/page.html", "/app.js"), None).await.ends_with("export {}"));
        assert!(get(&url.replace("/page.html", "/assets/style.css"), None).await.ends_with("h1 {}"));
    }

    /// A project is served whole: build output often lies in a dot folder (`.vitepress/dist`).
    /// The same folder asked for as a file outside another project keeps its hidden files.
    #[tokio::test]
    async fn the_project_serves_its_dot_folders() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("docs");
        std::fs::create_dir_all(root.join(".vitepress/dist")).unwrap();
        std::fs::write(root.join(".vitepress/dist/index.html"), "<h1>built</h1>").unwrap();
        std::fs::write(root.join("readme.html"), "<h1>readme</h1>").unwrap();

        let server = server();
        let outside = server.url_for(None, &root.join("readme.html")).await.unwrap();
        let built = server.url_for(Some(&root), &root.join(".vitepress/dist/index.html")).await.unwrap();
        let page = get(&built, None).await;
        assert!(page.starts_with("HTTP/1.1 200") && page.ends_with("<h1>built</h1>"), "{page}");
        let hidden = get(&outside.replace("/readme.html", "/.vitepress/dist/index.html"), None).await;
        assert!(hidden.starts_with("HTTP/1.1 404"), "{hidden}");
    }

    /// Security audit lead 7: a project that is the home folder, or holds it, is not served
    /// whole. Its pages are served like pages outside a project.
    #[tokio::test]
    async fn a_project_that_holds_the_home_folder_is_not_served_whole() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        std::fs::create_dir_all(home.join("Downloads")).unwrap();
        std::fs::write(home.join(".ssh/id_ed25519"), "DUMMY_KEY").unwrap();
        std::fs::write(home.join("saved.html"), "<p>saved</p>").unwrap();
        std::fs::write(home.join("notes.txt"), "DUMMY_NOTES").unwrap();
        std::fs::write(home.join("Downloads/page.html"), "<p>page</p>").unwrap();
        std::fs::write(home.join("Downloads/app.js"), "export {}").unwrap();

        let server = WebServer { home: Some(std::fs::canonicalize(&home).unwrap()), ..WebServer::new() };
        for project in [home.as_path(), dir.path()] {
            let page = server.url_for(Some(project), &home.join("Downloads/page.html")).await.unwrap();
            assert!(get(&page, None).await.ends_with("<p>page</p>"));
            assert!(get(&page.replace("/page.html", "/app.js"), None).await.ends_with("export {}"));
            // Where the key lies when the project is served whole.
            let key = get(&page.replace("/Downloads/page.html", "/.ssh/id_ed25519"), None).await;
            assert!(key.starts_with("HTTP/1.1 404"), "{}: {key}", project.display());
            let saved = server.url_for(Some(project), &home.join("saved.html")).await.unwrap();
            assert!(get(&saved, None).await.ends_with("<p>saved</p>"));
            for other in ["/.ssh/id_ed25519", "/notes.txt"] {
                let got = get(&saved.replace("/saved.html", other), None).await;
                assert!(got.starts_with("HTTP/1.1 404"), "{} {other}: {got}", project.display());
            }
        }
    }

    /// With no home folder to compare with, a file outside the project is served alone.
    #[tokio::test]
    async fn a_page_outside_the_project_is_served_alone_when_the_home_folder_is_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let (folder, project) = (dir.path().join("folder"), dir.path().join("project"));
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        for at in [&folder, &project] {
            std::fs::write(at.join("page.html"), "<p>page</p>").unwrap();
            std::fs::write(at.join("app.js"), "export {}").unwrap();
        }

        let server = WebServer { home: None, ..WebServer::new() };
        let page = server.url_for(None, &folder.join("page.html")).await.unwrap();
        assert!(get(&page, None).await.ends_with("<p>page</p>"));
        assert!(get(&page.replace("/page.html", "/app.js"), None).await.starts_with("HTTP/1.1 404"));
        // A project is served whole all the same.
        let page = server.url_for(Some(&project), &project.join("page.html")).await.unwrap();
        assert!(get(&page.replace("/page.html", "/app.js"), None).await.ends_with("export {}"));
    }

    /// A file served alone is named by its resolved path, which a missing file has not.
    #[tokio::test]
    async fn a_missing_file_that_would_be_served_alone_has_no_url() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let server = WebServer { home: Some(std::fs::canonicalize(&home).unwrap()), ..WebServer::new() };
        assert!(server.url_for(None, &home.join("missing.html")).await.is_err());
    }
}
