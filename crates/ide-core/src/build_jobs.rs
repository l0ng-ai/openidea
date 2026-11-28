//! Parallelism for build tools whose default is one compiler process at a time.
//!
//! `cmake --build` with a Makefile generator (the default) compiles one file at a
//! time unless it is given `-j N`; the IDE asks for one job per logical CPU. A count
//! the user wrote into the build arguments is left alone.

/// Jobs a native build tool gets when the user did not choose a count.
pub fn default_jobs() -> usize {
    std::thread::available_parallelism().map_or(1, |jobs| jobs.get())
}

/// Appends `-j <jobs>` unless `args` already carries the user's own count. The count
/// goes before a `--` separator, so cmake's own options stay cmake's and the native
/// build tool's options stay last.
pub fn append_default_jobs(args: &mut Vec<String>) {
    if args.iter().any(|arg| is_jobs_flag(arg)) {
        return;
    }
    let jobs = default_jobs().to_string();
    let at = args.iter().position(|arg| arg == "--").unwrap_or(args.len());
    args.splice(at..at, ["-j".to_owned(), jobs]);
}

/// `-j`, `-j8`, `--parallel`, `--parallel=8`, `--jobs`, `--jobs=8`.
fn is_jobs_flag(arg: &str) -> bool {
    let count = |rest: &str| rest.chars().all(|c| c.is_ascii_digit());
    arg.strip_prefix("-j").is_some_and(count)
        || arg.strip_prefix("--parallel=").is_some_and(count)
        || arg.strip_prefix("--jobs=").is_some_and(count)
        || arg == "--parallel"
        || arg == "--jobs"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args_of(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn the_default_is_one_job_per_logical_cpu() {
        let expected = std::thread::available_parallelism().map_or(1, |jobs| jobs.get());
        assert_eq!(default_jobs(), expected);
    }

    #[test]
    fn a_build_without_a_count_gets_one() {
        let mut argv = args_of(&["--build", "build", "--config", "Debug"]);
        append_default_jobs(&mut argv);
        assert_eq!(argv, args_of(&["--build", "build", "--config", "Debug", "-j", &default_jobs().to_string()]));
    }

    #[test]
    fn a_count_the_user_chose_is_left_alone() {
        let own: [&[&str]; 6] =
            [&["-j", "2"], &["-j8"], &["-j", "2"], &["--parallel", "2"], &["--parallel=2"], &["--jobs=2"]];
        for flags in own {
            let mut argv = args_of(&["--build", "build"]);
            argv.extend(flags.iter().map(|value| (*value).to_owned()));
            let expected = argv.clone();
            append_default_jobs(&mut argv);
            assert_eq!(argv, expected, "the build arguments set the count");
        }
    }

    #[test]
    fn the_count_stays_before_native_build_tool_options() {
        let mut argv = args_of(&["--build", "build", "--", "VERBOSE=1"]);
        append_default_jobs(&mut argv);
        assert_eq!(argv, args_of(&["--build", "build", "-j", &default_jobs().to_string(), "--", "VERBOSE=1"]));
    }
}
