use super::*;
use std::fs;
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const CONTENT: &[u8] = b"a complete archive with enough bytes to interrupt and resume";
const PARTIAL: usize = 13;

struct Server {
    url: String,
    ranges: Arc<Mutex<Vec<Option<usize>>>>,
    stopped: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Server {
    fn new(supports_range: bool, interrupt_first: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/archive", listener.local_addr().unwrap());
        let ranges = Arc::new(Mutex::new(Vec::new()));
        let stopped = Arc::new(AtomicBool::new(false));
        let requests = ranges.clone();
        let stop = stopped.clone();
        let thread = std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let (mut stream, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(e) => panic!("accept: {e}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                stream.set_write_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut request = String::new();
                let mut reader = BufReader::new(&stream);
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                        break;
                    }
                    request.push_str(&line);
                }
                let range = request.lines().find_map(|line| {
                    line.to_ascii_lowercase().strip_prefix("range: bytes=")?.strip_suffix('-')?.parse::<usize>().ok()
                });
                let mut requests = requests.lock().unwrap();
                let interrupted = interrupt_first && requests.is_empty();
                requests.push(range);
                drop(requests);
                let (status, content_range, body) = match range.filter(|_| supports_range) {
                    Some(start) if start >= CONTENT.len() => {
                        ("416 Range Not Satisfiable", format!("Content-Range: bytes */{}\r\n", CONTENT.len()), &b""[..])
                    }
                    Some(start) => (
                        "206 Partial Content",
                        format!("Content-Range: bytes {start}-{}/{}\r\n", CONTENT.len() - 1, CONTENT.len()),
                        &CONTENT[start..],
                    ),
                    None => ("200 OK", String::new(), CONTENT),
                };
                let header = format!(
                    "HTTP/1.1 {status}\r\n{content_range}Content-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(if interrupted { &body[..PARTIAL] } else { body });
            }
        });
        Self { url, ranges, stopped, thread: Some(thread) }
    }

    fn ranges(&self) -> Vec<Option<usize>> {
        self.ranges.lock().unwrap().clone()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Relaxed);
        let result = self.thread.take().unwrap().join();
        if !std::thread::panicking() {
            result.unwrap();
        }
    }
}

fn http() -> Option<Http> {
    let Ok(curl) = which::which("curl") else {
        eprintln!("skipping download test: curl is not installed");
        return None;
    };
    Some(Http { curl, gh: None, explicit_github_token: None, https_only: false, revoke_best_effort: false })
}

#[test]
fn interrupted_download_resumes_with_range() {
    let Some(http) = http() else { return };
    let server = Server::new(true, true);
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("archive.tar.gz");
    let cancel = CancellationToken::new();
    assert!(http.download(&server.url, &dest, None, &cancel, &|_| {}).is_err());
    assert_eq!(fs::read(&dest).unwrap(), &CONTENT[..PARTIAL]);
    assert_eq!(fs::read_to_string(dir.path().join("archive.tar.gz.url")).unwrap(), server.url);
    http.download(&server.url, &dest, None, &cancel, &|_| {}).unwrap();
    assert_eq!(fs::read(&dest).unwrap(), CONTENT);
    assert_eq!(server.ranges(), vec![None, Some(PARTIAL)]);
    assert!(!dir.path().join("archive.tar.gz.url").exists());
}

#[test]
fn interrupted_download_restarts_without_range_support() {
    let Some(http) = http() else { return };
    let server = Server::new(false, true);
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("archive");
    let cancel = CancellationToken::new();
    assert!(http.download(&server.url, &dest, None, &cancel, &|_| {}).is_err());
    http.download(&server.url, &dest, None, &cancel, &|_| {}).unwrap();
    assert_eq!(fs::read(&dest).unwrap(), CONTENT);
    assert_eq!(server.ranges(), vec![None, Some(PARTIAL), None]);
    assert!(!dir.path().join("archive.url").exists());
}

#[test]
fn different_or_unknown_url_discards_stale_bytes_including_same_size_files() {
    let Some(http) = http() else { return };
    for previous_url in [Some("https://example.test/older-version"), None] {
        for length in [PARTIAL, CONTENT.len()] {
            let server = Server::new(true, false);
            let dir = tempfile::tempdir().unwrap();
            let dest = dir.path().join("archive");
            fs::write(&dest, vec![b'x'; length]).unwrap();
            if let Some(url) = previous_url {
                fs::write(dir.path().join("archive.url"), url).unwrap();
            }
            http.download(&server.url, &dest, None, &CancellationToken::new(), &|_| {}).unwrap();
            assert_eq!(fs::read(&dest).unwrap(), CONTENT);
            assert_eq!(server.ranges(), vec![None]);
            assert!(!dir.path().join("archive.url").exists());
        }
    }
}

#[test]
fn oversized_partial_restarts_after_http_416() {
    let Some(http) = http() else { return };
    let server = Server::new(true, false);
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("archive");
    let length = CONTENT.len() + 10;
    fs::write(&dest, vec![b'x'; length]).unwrap();
    fs::write(dir.path().join("archive.url"), &server.url).unwrap();
    http.download(&server.url, &dest, None, &CancellationToken::new(), &|_| {}).unwrap();
    assert_eq!(fs::read(&dest).unwrap(), CONTENT);
    assert_eq!(server.ranges(), vec![Some(length), None]);
    assert!(!dir.path().join("archive.url").exists());
}

#[test]
fn complete_file_for_same_url_succeeds() {
    let Some(http) = http() else { return };
    let server = Server::new(true, false);
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("archive");
    fs::write(&dest, CONTENT).unwrap();
    fs::write(dir.path().join("archive.url"), &server.url).unwrap();
    http.download(&server.url, &dest, None, &CancellationToken::new(), &|_| {}).unwrap();
    assert_eq!(fs::read(&dest).unwrap(), CONTENT);
    assert_eq!(server.ranges()[0], Some(CONTENT.len()));
    assert!(!dir.path().join("archive.url").exists());
}
