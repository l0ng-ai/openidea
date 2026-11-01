//! `base()` is process-global (an `OnceLock`), so its environment wiring is
//! verified in this binary's own process, which no other test shares.

use openidea_lib::paths;

#[test]
fn base_takes_the_environment_variable() {
    let target = std::env::temp_dir().join("openidea-env-home");
    // SAFETY: the only test in this binary; nothing reads the variable concurrently.
    unsafe { std::env::set_var("OPENIDEA_HOME", &target) };
    assert_eq!(paths::base(), target);
}
