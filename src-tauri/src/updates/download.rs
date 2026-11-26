//! Resumable update downloads for the existing install-and-restart flow.

use ide_core::{IdeError, IdeResult};
use reqwest::header::{ACCEPT, ACCEPT_ENCODING, CONTENT_LENGTH, CONTENT_RANGE, RANGE};
use reqwest::{Client, StatusCode};
use std::path::{Path, PathBuf};
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;

/// How one request completed: whether it appended to the partial file, and
/// whether the response advertised a total size.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Outcome {
    pub resumed: bool,
    pub total: Option<u64>,
}

/// Appends `url` to `path`, resuming from its current length when the server
/// honours Range. An unsupported Range falls back to replacing the partial file
/// because installing bytes from different representations would be unsafe.
pub(crate) async fn fetch(
    client: &Client,
    url: &str,
    path: &Path,
    mut progress: impl FnMut(u64, Option<u64>),
) -> IdeResult<Outcome> {
    let backup = beside(path, "backup");
    if !path.exists() && backup.exists() {
        tokio::fs::rename(&backup, path).await?;
    } else if path.exists() {
        let _ = tokio::fs::remove_file(backup).await;
    }
    let mut offset = match tokio::fs::metadata(path).await {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(error.into()),
    };

    loop {
        progress(offset, None);
        let mut request = client
            .get(url)
            .header(ACCEPT, "application/octet-stream")
            // A byte offset is only meaningful for the representation the server
            // advertised. Automatic content decoding would break that contract.
            .header(ACCEPT_ENCODING, "identity");
        if offset > 0 {
            request = request.header(RANGE, format!("bytes={offset}-"));
        }
        let response = request.send().await.map_err(|error| IdeError::unavailable(error.to_string()))?;
        let status = response.status();

        if status == StatusCode::RANGE_NOT_SATISFIABLE && offset > 0 {
            let total =
                response.headers().get(CONTENT_RANGE).and_then(|value| value.to_str().ok()).and_then(unsatisfied_total);
            if total == Some(offset) {
                return Ok(Outcome { resumed: true, total });
            }
            tokio::fs::remove_file(path).await?;
            offset = 0;
            continue;
        }

        if status == StatusCode::PARTIAL_CONTENT {
            let (start, total) = response
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .and_then(partial_range)
                .ok_or_else(|| IdeError::unavailable("update server sent an invalid Content-Range header"))?;
            if start != offset {
                // This is not the byte range we asked for. Keep the partial file:
                // another mirror may resume it correctly, and this response is not
                // safe to append.
                return Err(IdeError::unavailable(format!(
                    "update server returned byte {start} while {offset} was requested"
                )));
            }
            let mut file = OpenOptions::new().append(true).open(path).await?;
            let downloaded = append_body(&mut file, response, offset, total, &mut progress).await?;
            ensure_complete(downloaded, total)?;
            return Ok(Outcome { resumed: offset > 0, total });
        }

        if status == StatusCode::OK {
            let total = response
                .headers()
                .get(CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse().ok());
            if offset > 0 {
                replace_with_full(response, path, total, &mut progress).await?;
            } else {
                let mut file = OpenOptions::new().create(true).write(true).truncate(true).open(path).await?;
                let downloaded = append_body(&mut file, response, 0, total, &mut progress).await?;
                ensure_complete(downloaded, total)?;
            }
            return Ok(Outcome { resumed: false, total });
        }

        return Err(IdeError::unavailable(format!("update download failed with HTTP {status}")));
    }
}

/// Downloads a full response beside the existing partial file. The old bytes
/// stay resumable if the replacement connection fails before completion.
async fn replace_with_full(
    response: reqwest::Response,
    path: &Path,
    total: Option<u64>,
    progress: &mut impl FnMut(u64, Option<u64>),
) -> IdeResult<()> {
    let temporary = beside(path, "full");
    let backup = beside(path, "backup");
    let result = async {
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&temporary)
            .await
            .map_err(IdeError::from)?;
        let downloaded = append_body(&mut file, response, 0, total, progress).await?;
        ensure_complete(downloaded, total)?;
        let _ = tokio::fs::remove_file(&backup).await;
        let had_old = path.exists();
        if had_old {
            tokio::fs::rename(path, &backup).await.map_err(IdeError::from)?;
        }
        if let Err(error) = tokio::fs::rename(&temporary, path).await {
            if had_old {
                let _ = tokio::fs::rename(&backup, path).await;
            }
            return Err(IdeError::from(error));
        }
        if had_old {
            let _ = tokio::fs::remove_file(&backup).await;
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

/// Returns a sibling of `path` whose name has `suffix` appended after its full
/// extension sequence, e.g. `update.part` and `full` → `update.part.full`.
fn beside(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{suffix}"));
    path.with_file_name(name)
}

/// Copies one response body into the persistent file and reports absolute
/// progress, including bytes recovered from an earlier process.
async fn append_body(
    file: &mut tokio::fs::File,
    mut response: reqwest::Response,
    offset: u64,
    total: Option<u64>,
    progress: &mut impl FnMut(u64, Option<u64>),
) -> IdeResult<u64> {
    let mut downloaded = offset;
    while let Some(chunk) = response.chunk().await.map_err(|error| IdeError::unavailable(error.to_string()))? {
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;
        progress(downloaded, total);
    }
    file.flush().await?;
    file.sync_all().await?;
    Ok(downloaded)
}

/// Rejects a body that ended before the advertised length instead of promoting
/// a truncated installer to the ready state.
fn ensure_complete(downloaded: u64, total: Option<u64>) -> IdeResult<()> {
    match total {
        Some(total) if downloaded != total => {
            Err(IdeError::unavailable(format!("update download ended at {downloaded} of {total} bytes")))
        }
        _ => Ok(()),
    }
}

/// Parses `bytes start-end/total`, returning the start and known total.
fn partial_range(value: &str) -> Option<(u64, Option<u64>)> {
    let value = value.strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let (start, _) = range.split_once('-')?;
    let start = start.parse().ok()?;
    let total = (total != "*").then(|| total.parse().ok()).flatten();
    Some((start, total))
}

/// Parses the total from a `bytes */total` unsatisfied-range response.
fn unsatisfied_total(value: &str) -> Option<u64> {
    value.strip_prefix("bytes */")?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    /// Starts a one-request HTTP server and returns its URL plus the request line.
    fn serve(response: Vec<u8>) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            socket.write_all(&response).unwrap();
            String::from_utf8(request).unwrap()
        });
        (format!("http://{address}/update"), handle)
    }

    /// Builds a complete HTTP response with a fixed body.
    fn http(status: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
        let mut response = format!("HTTP/1.1 {status}\r\nConnection: close\r\n");
        for (name, value) in headers {
            response.push_str(&format!("{name}: {value}\r\n"));
        }
        response.push_str("\r\n");
        response.into_bytes().into_iter().chain(body.iter().copied()).collect()
    }

    /// Drops a body early, then resumes from the bytes already on disk.
    #[tokio::test]
    async fn a_broken_download_resumes_with_range() {
        let client = ide_http::client::shared().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("update.part");
        let (url, first) = serve(http("200 OK", &[("Content-Length", "10")], b"abcd"));
        assert!(fetch(&client, &url, &path, |_, _| {}).await.is_err());
        first.join().unwrap();
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"abcd");

        let (url, second) = serve(http(
            "206 Partial Content",
            &[("Content-Range", "bytes 4-9/10"), ("Content-Length", "6")],
            b"efghij",
        ));
        let outcome = fetch(&client, &url, &path, |_, _| {}).await.unwrap();
        let request = second.join().unwrap().to_ascii_lowercase();
        assert!(request.contains("range: bytes=4-"), "{request}");
        assert_eq!(outcome, Outcome { resumed: true, total: Some(10) });
        assert_eq!(tokio::fs::read(path).await.unwrap(), b"abcdefghij");
    }

    /// Replaces a stale partial file when a proxy or mirror ignores Range.
    #[tokio::test]
    async fn a_full_response_after_a_partial_replaces_the_file() {
        let client = ide_http::client::shared().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("update.part");
        tokio::fs::write(&path, b"stale").await.unwrap();
        let (url, request) = serve(http("200 OK", &[("Content-Length", "7")], b"fresh!!"));
        let outcome = fetch(&client, &url, &path, |_, _| {}).await.unwrap();
        assert!(request.join().unwrap().to_ascii_lowercase().contains("range: bytes=5-"));
        assert_eq!(outcome, Outcome { resumed: false, total: Some(7) });
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"fresh!!");
        assert!(!path.with_file_name("update.part.full").exists());
    }

    /// Keeps the older checkpoint when a proxy ignores Range and its full
    /// replacement download breaks before completion.
    #[tokio::test]
    async fn a_broken_full_fallback_preserves_the_previous_partial() {
        let client = ide_http::client::shared().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("update.part");
        tokio::fs::write(&path, b"stale").await.unwrap();
        let (url, _) = serve(http("200 OK", &[("Content-Length", "10")], b"fresh"));
        assert!(fetch(&client, &url, &path, |_, _| {}).await.is_err());
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"stale");
        assert!(!path.with_file_name("update.part.full").exists());
    }

    /// Accepts `bytes */length` as the only completion signal for an already
    /// complete partial file after a process restart.
    #[tokio::test]
    async fn an_already_complete_partial_file_is_returned_on_416() {
        let client = ide_http::client::shared().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("update.part");
        tokio::fs::write(&path, b"done").await.unwrap();
        let (url, _) = serve(http("416 Range Not Satisfiable", &[("Content-Range", "bytes */4")], b""));
        assert_eq!(fetch(&client, &url, &path, |_, _| {}).await.unwrap(), Outcome { resumed: true, total: Some(4) });
    }

    /// A close-delimited response has no length to prove a clean EOF; the caller
    /// uses this signal to resume instead of discarding a failed checkpoint.
    #[tokio::test]
    async fn a_close_delimited_response_reports_an_unknown_total() {
        let client = ide_http::client::shared().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("update.part");
        let (url, _) = serve(http("200 OK", &[], b"body"));
        assert_eq!(fetch(&client, &url, &path, |_, _| {}).await.unwrap(), Outcome { resumed: false, total: None });
        assert_eq!(tokio::fs::read(path).await.unwrap(), b"body");
    }

    /// A crash during the full-response swap leaves the old checkpoint in the
    /// backup name; the next fetch restores it before calculating Range.
    #[tokio::test]
    async fn a_backup_checkpoint_is_restored_before_resuming() {
        let client = ide_http::client::shared().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("update.part");
        tokio::fs::write(beside(&path, "backup"), b"old").await.unwrap();
        let (url, request) = serve(http("416 Range Not Satisfiable", &[("Content-Range", "bytes */3")], b""));
        let outcome = fetch(&client, &url, &path, |_, _| {}).await.unwrap();
        assert!(request.join().unwrap().to_ascii_lowercase().contains("range: bytes=3-"));
        assert_eq!(outcome, Outcome { resumed: true, total: Some(3) });
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"old");
        assert!(!beside(&path, "backup").exists());
    }

    /// Rejects malformed range metadata instead of appending to an unknown slice.
    #[test]
    fn content_range_parser_only_accepts_byte_ranges() {
        assert_eq!(partial_range("bytes 4-9/10"), Some((4, Some(10))));
        assert_eq!(partial_range("bytes 0-0/*"), Some((0, None)));
        assert_eq!(partial_range("items 4-9/10"), None);
        assert_eq!(unsatisfied_total("bytes */10"), Some(10));
        assert_eq!(unsatisfied_total("bytes 0-1/10"), None);
    }
}
