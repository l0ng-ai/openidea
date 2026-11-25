//! Images in agent content: ACP content blocks, `data:` URLs and image files on disk.

use crate::model::AgentImage;
use base64::Engine;
use serde_json::{Value, json};
use std::path::Path;

/// Image files larger than this are not inlined into the conversation.
const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;

/// The image an ACP content block shows: an `image` (inline or by URI), a `resource` with an
/// image blob, or a `resource_link` to an image file.
pub(crate) fn from_content(content: &Value) -> Option<AgentImage> {
    match str_of(content, "type")? {
        "image" => {
            if let (Some(data), Some(mime)) = (str_of(content, "data"), str_of(content, "mimeType"))
                && mime.starts_with("image/")
            {
                return Some(AgentImage { mime_type: mime.into(), data: data.into(), name: None });
            }
            from_uri(str_of(content, "uri")?)
        }
        "resource" => {
            let resource = content.get("resource")?;
            let (data, mime) = (str_of(resource, "blob")?, str_of(resource, "mimeType")?);
            mime.starts_with("image/").then(|| AgentImage { mime_type: mime.into(), data: data.into(), name: None })
        }
        "resource_link" => {
            let uri = str_of(content, "uri")?;
            let declared = str_of(content, "mimeType").is_some_and(|m| m.starts_with("image/"));
            if !declared && mime_of(Path::new(&uri_path(uri))).is_none() {
                return None;
            }
            let mut image = from_uri(uri)?;
            image.name = str_of(content, "name").map(str::to_owned);
            Some(image)
        }
        _ => None,
    }
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// The image at a `data:` URL or a `file://` URI.
pub(crate) fn from_uri(uri: &str) -> Option<AgentImage> {
    if let Some(rest) = uri.strip_prefix("data:") {
        let (mime, data) = rest.split_once(";base64,")?;
        return (mime.starts_with("image/") && !data.is_empty()).then(|| AgentImage {
            mime_type: mime.into(),
            data: data.into(),
            name: None,
        });
    }
    uri.starts_with("file://").then(|| from_file(Path::new(&uri_path(uri))))?
}

/// The image file at `path`, when it has an image extension and isn't too large.
pub(crate) fn from_file(path: &Path) -> Option<AgentImage> {
    let mime = mime_of(path)?;
    if std::fs::metadata(path).ok()?.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    (!bytes.is_empty()).then(|| AgentImage {
        mime_type: mime.into(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        name: path.file_name().and_then(|n| n.to_str()).map(str::to_owned),
    })
}

/// `image` as an ACP image content block.
pub(crate) fn content(image: &AgentImage) -> Value {
    json!({ "type": "image", "mimeType": image.media_type(), "data": image.data })
}

fn mime_of(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

/// The path of a `file://` URI (percent-decoded); other URIs as they are.
pub(crate) fn uri_path(uri: &str) -> String {
    let Some(rest) = uri.strip_prefix("file://") else { return uri.to_owned() };
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(b) = rest.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(b);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    let path = String::from_utf8_lossy(&out).into_owned();
    // `file:///C:/x` on Windows.
    match path.as_bytes() {
        [b'/', drive, b':', ..] if drive.is_ascii_alphabetic() => path[1..].to_owned(),
        _ => path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_blocks_inline_data_urls_blobs_and_image_files() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("shot 1.png");
        std::fs::write(&file, b"\x89PNG\r\n").unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"hi").unwrap();
        let uri = crate::file_uri(&file);
        let inline = json!({"type": "image", "mimeType": "image/png", "data": "aW1n"});
        assert_eq!(from_content(&inline).unwrap().data, "aW1n");
        let by_url = json!({"type": "image", "uri": "data:image/jpeg;base64,AAA"});
        assert_eq!(from_content(&by_url).unwrap().mime_type, "image/jpeg");
        let by_file = from_content(&json!({"type": "image", "uri": uri})).unwrap();
        assert_eq!(by_file.data, base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n"));
        let blob = json!({"type": "resource", "resource": {"uri": "x", "mimeType": "image/gif", "blob": "R0lG"}});
        assert_eq!(from_content(&blob).unwrap().mime_type, "image/gif");
        let link = from_content(&json!({"type": "resource_link", "uri": uri, "name": "shot"})).unwrap();
        assert_eq!((link.mime_type.as_str(), link.name.as_deref()), ("image/png", Some("shot")));
        let text = crate::file_uri(&dir.path().join("notes.txt"));
        assert!(from_content(&json!({"type": "resource_link", "uri": text, "name": "notes"})).is_none());
        assert!(from_content(&json!({"type": "resource", "resource": {"uri": "x", "text": "t"}})).is_none());
        assert!(from_content(&json!({"type": "image", "uri": "https://example.com/a.png"})).is_none());
        assert!(from_file(&dir.path().join("missing.png")).is_none());
    }
}
