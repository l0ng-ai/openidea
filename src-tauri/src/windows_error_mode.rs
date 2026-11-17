use windows_sys::Win32::System::Diagnostics::Debug::{
    GetErrorMode, SEM_FAILCRITICALERRORS, SEM_NOOPENFILEERRORBOX, SetErrorMode,
};

/// Call before starting threads or tools. Children inherit this mode, so a missing DLL
/// (for example in a broken Python install) produces an exit code instead of a modal dialog.
pub(super) fn quiet_error_dialogs() {
    // SAFETY: these APIs only read/write this process's error mode. Preserve inherited policy.
    unsafe { SetErrorMode(GetErrorMode() | SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX) };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use windows_sys::Win32::System::Diagnostics::Debug::SEM_NOGPFAULTERRORBOX;

    #[test]
    fn preserves_policy_and_children_inherit_quiet_errors() {
        const STAGE: &str = "OPENIDEA_ERROR_MODE_TEST_STAGE";
        const SEED: &str = "OPENIDEA_ERROR_MODE_TEST_SEED";
        let child = || {
            let mut cmd = Command::new(std::env::current_exe().unwrap());
            cmd.args(["--exact", "windows_error_mode::tests::preserves_policy_and_children_inherit_quiet_errors"])
                .creation_flags(0x0800_0000);
            cmd
        };
        if let Ok(stage) = std::env::var(STAGE) {
            let seed: u32 = std::env::var(SEED).unwrap().parse().unwrap();
            if stage == "configure" {
                // SAFETY: only this dedicated subprocess's error mode is changed.
                unsafe { SetErrorMode(seed) };
                quiet_error_dialogs();
                quiet_error_dialogs();
            }
            let expected = seed | SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX;
            // SAFETY: GetErrorMode has no preconditions.
            assert_eq!(unsafe { GetErrorMode() } & expected, expected);
            if stage == "configure" {
                assert!(child().env(STAGE, "inherited").status().unwrap().success());
            }
            return;
        }
        // Keep process-wide state changes out of the parallel test runner.
        for seed in [0, SEM_NOGPFAULTERRORBOX, SEM_NOOPENFILEERRORBOX | SEM_NOGPFAULTERRORBOX] {
            assert!(child().env(STAGE, "configure").env(SEED, seed.to_string()).status().unwrap().success());
        }
    }
}
