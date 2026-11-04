//! `app_root` resolves the configured tools home; this binary owns its
//! process, so setting the static here cannot leak into other tests.

use std::path::{Path, PathBuf};

#[test]
fn app_root_is_the_configured_home_else_the_fallback() {
    assert_eq!(ide_tools::app_root(Path::new("/fallback")), PathBuf::from("/fallback"));
    ide_tools::set_tools_home(PathBuf::from("/home"));
    assert_eq!(ide_tools::app_root(Path::new("/fallback")), PathBuf::from("/home"));
}
