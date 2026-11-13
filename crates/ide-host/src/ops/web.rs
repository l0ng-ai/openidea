//! The built-in web server's URLs.

use crate::Host;
use ide_core::IdeResult;
use std::path::Path;

/// The URL serving `file`, under the window's project when it holds the file.
pub async fn url(host: &Host, window: &str, file: &Path) -> IdeResult<String> {
    let root = host.project(window).ok().map(|p| p.root.clone());
    host.web.url_for(root.as_deref(), file).await
}
