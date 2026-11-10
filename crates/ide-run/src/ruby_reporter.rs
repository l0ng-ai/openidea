//! A Minitest reporter the IDE loads into test runs (see `ruby_reporter/`): it prints one record per
//! test on stdout, which the IDE strips from the console and turns into the test tree. Tests then
//! report their real source file and line, and the output no longer needs `-v` to be parsed.
use crate::RunConfig;
use std::io;
use std::path::Path;

/// The Ruby file `RUBYOPT` loads first (`<dir>/openidea_test_hook.rb`).
pub const FEATURE: &str = "openidea_test_hook";

const FILES: [(&str, &str); 2] = [
    ("openidea_test_hook.rb", include_str!("ruby_reporter/openidea_test_hook.rb")),
    ("openidea/minitest_reporter.rb", include_str!("ruby_reporter/minitest_reporter.rb")),
];

/// Whether a run takes the reporter: Minitest-style test runs through `ruby` or `rake`, with their output
/// in the console (a terminal would show the records).
pub fn applies(config: &RunConfig) -> bool {
    config.is_test && matches!(config.kind.as_str(), "ruby" | "rake") && !config.extras.emulate_terminal
}

/// Writes the reporter files under `dir` (unchanged files stay).
pub fn install(dir: &Path) -> io::Result<()> {
    for (name, text) in FILES {
        let path = dir.join(name);
        if std::fs::read_to_string(&path).is_ok_and(|current| current == text) {
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, text)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs_the_files_once_and_only_for_ruby_test_runs() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("ruby reporter");
        install(&dir).unwrap();
        install(&dir).unwrap();
        for (name, text) in FILES {
            assert_eq!(std::fs::read_to_string(dir.join(name)).unwrap(), text);
        }
        assert!(FILES[0].1.contains("OPENIDEA_TEST_REPORT") && FILES[1].1.contains("@@OPENIDEA@@"));
    }
}
