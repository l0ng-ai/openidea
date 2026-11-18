//! Timed evidence for the bounded build-output capture (issue #3936). Not an assertion:
//! run it on both revisions of `process.rs` and compare the printed numbers.
//!
//! ```text
//! cargo test -p ide-build --release --lib -- --ignored --nocapture numbers
//! ```

use crate::process;
use ide_core::CancellationToken;
use std::collections::BTreeMap;
use std::time::Instant;

/// 256 MiB of 17-byte lines from `yes`, drained by `process::run` with a counting callback.
#[test]
#[ignore = "prints elapsed time and retained bytes; see the module docs"]
fn high_output_process_numbers() {
    if cfg!(windows) {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let args = ["-c".into(), "yes 0123456789abcdef | head -c 268435456".into()];
    let start = Instant::now();
    let mut lines = 0u64;
    let mut fed = 0usize;
    let out = process::run_bounded("sh", &args, tmp.path(), &BTreeMap::new(), &CancellationToken::new(), |_, line| {
        lines += 1;
        fed += line.len() + 1;
    })
    .unwrap();
    println!(
        "elapsed {:?} | success {} | retained {} bytes | fed {lines} lines / {fed} bytes",
        start.elapsed(),
        out.success,
        out.text.len()
    );
}
