//! `base()` is process-global (an `OnceLock`), so its pointer-file wiring is
//! verified in this binary's own process, which no other test shares.

use openidea_lib::paths;
use std::fs;

#[cfg(unix)]
#[test]
fn base_reads_the_pointer_file_from_its_fixed_location() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let target = tmp.path().join("moved-base");
    fs::create_dir_all(&target).unwrap();

    paths::write_pointer(&home, &target).unwrap();

    // SAFETY: the only test in this binary; nothing reads the variable concurrently.
    unsafe { std::env::set_var("HOME", &home) };
    assert_eq!(paths::base(), target);
}
