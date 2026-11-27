//! External file-opening arguments, shared by cold and second-instance launches.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};

/// Guarded by WindowsState's mutex. One worker drains requests in arrival order.
#[derive(Default)]
pub struct Queue {
    requests: VecDeque<(Vec<String>, String)>,
    ready: bool,
    running: bool,
}

impl Queue {
    pub fn push(&mut self, args: Vec<String>, cwd: String) -> bool {
        self.requests.push_back((args, cwd));
        self.start()
    }

    pub fn ready(&mut self) -> bool {
        self.ready = true;
        self.start()
    }

    fn start(&mut self) -> bool {
        if self.ready && !self.running && !self.requests.is_empty() {
            self.running = true;
            true
        } else {
            false
        }
    }

    pub fn next(&mut self) -> Option<(Vec<String>, String)> {
        let request = self.requests.pop_front();
        if request.is_none() {
            self.running = false;
        }
        request
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Request {
    pub path: Option<PathBuf>,
    pub file: Option<PathBuf>,
    pub position: Option<(u32, u32)>,
}

/// Preserve the application's `diff` subcommand; a non-leading `diff` remains a path.
pub fn diff_paths(args: &[String], cwd: &Path) -> Option<Vec<PathBuf>> {
    if args.get(1).map(String::as_str) != Some("diff") {
        return None;
    }
    let mut paths = Vec::new();
    let mut args = args.iter().skip(2);
    let mut positional = false;
    while let Some(arg) = args.next() {
        if !positional && arg == "--" {
            positional = true;
        } else if !positional && matches!(arg.as_str(), "--line" | "--column") {
            args.next();
        } else if !arg.is_empty() && (positional || !arg.starts_with('-')) {
            paths.push(absolute(cwd, Path::new(arg)));
        }
    }
    Some(paths)
}

pub fn parse(args: &[String], cwd: &Path) -> Result<Request, String> {
    let (mut path, mut file, mut line, mut column) = (None, None, None, None);
    let mut positional = false;
    let mut args = args.iter().skip(1);
    while let Some(arg) = args.next() {
        if !positional && arg == "--" {
            positional = true;
            continue;
        }
        let (flag, inline) = arg.split_once('=').map_or((arg.as_str(), None), |(k, v)| (k, Some(v)));
        if !positional && matches!(flag, "--file" | "--line" | "--column") {
            let value = inline
                .or_else(|| args.next().map(String::as_str))
                .filter(|s| !s.is_empty() && !s.starts_with("--"))
                .ok_or_else(|| format!("{flag} requires a value"))?;
            match flag {
                "--file" => {
                    if file.replace(PathBuf::from(value)).is_some() {
                        return Err("--file may only be supplied once".into());
                    }
                }
                "--line" => line = coordinate(flag, value)?,
                "--column" => column = coordinate(flag, value)?,
                _ => unreachable!(),
            }
        } else if !arg.is_empty() && (positional || (!arg.starts_with('-') && !arg.starts_with("psn_"))) {
            // Preserve ordinary CLI opening: the first positional path is the target.
            if path.is_none() {
                path = Some(absolute(cwd, Path::new(arg)));
            }
        }
    }
    let base = path.as_deref().filter(|p| p.is_dir()).unwrap_or(cwd);
    let file = file.map(|p| absolute(base, &p));
    Ok(Request { path, file, position: line.map(|l| (l - 1, column.unwrap_or(1) - 1)) })
}

fn absolute(base: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() { path.to_owned() } else { base.join(path) }
}

fn coordinate(flag: &str, value: &str) -> Result<Option<u32>, String> {
    // Unity supplies 0/-1 when an asset has no source position.
    match value.parse::<i64>() {
        Ok(-1 | 0) => Ok(None),
        Ok(n @ 1..=4294967295) => Ok(Some(n as u32)),
        _ => Err(format!("{flag} expects a 1-based position (or 0/-1 for an unknown position)")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(args: &[&str]) -> Result<Request, String> {
        parse(
            &std::iter::once("openidea").chain(args.iter().copied()).map(str::to_owned).collect::<Vec<_>>(),
            Path::new("/work"),
        )
    }

    #[test]
    fn diff_paths_keep_flags_out_and_honor_end_of_options() {
        let args = |tail: &[&str]| {
            std::iter::once("openidea").chain(tail.iter().copied()).map(str::to_owned).collect::<Vec<_>>()
        };
        let cwd = Path::new("/work");
        assert_eq!(
            diff_paths(&args(&["diff", "--line", "12", "--column=3", "a.txt", "b.txt"]), cwd),
            Some(vec![cwd.join("a.txt"), cwd.join("b.txt")])
        );
        assert_eq!(
            diff_paths(&args(&["diff", "--", "-a.txt", "-b.txt"]), cwd),
            Some(vec![cwd.join("-a.txt"), cwd.join("-b.txt")])
        );
        assert_eq!(diff_paths(&args(&["--", "diff"]), cwd), None);
        assert_eq!(diff_paths(&args(&["project", "diff"]), cwd), None);
        assert_eq!(diff_paths(&args(&["diff"]), cwd), Some(vec![]));
    }

    #[test]
    fn queued_launches_stay_in_order_across_startup_and_later_arrivals() {
        let mut queue = Queue::default();
        assert!(!queue.push(vec!["first".into()], "cwd1".into()));
        assert!(!queue.push(vec!["second".into()], "cwd2".into()));
        assert!(queue.ready());
        assert!(!queue.push(vec!["third".into()], "cwd3".into()));
        assert_eq!(queue.next(), Some((vec!["first".into()], "cwd1".into())));
        assert_eq!(queue.next(), Some((vec!["second".into()], "cwd2".into())));
        assert_eq!(queue.next(), Some((vec!["third".into()], "cwd3".into())));
        assert_eq!(queue.next(), None);
        assert!(queue.push(vec!["later".into()], "cwd4".into()));
        assert!(!queue.ready());
        assert_eq!(queue.next(), Some((vec!["later".into()], "cwd4".into())));
    }

    #[test]
    fn named_files_positions_and_unicode() {
        for args in [
            vec!["--file", "Game Scripts/角色.cs", "--line", "42", "--column", "7"],
            vec!["--column=7", "--line=42", "--file=Game Scripts/角色.cs"],
        ] {
            assert_eq!(
                request(&args).unwrap(),
                Request {
                    path: None,
                    file: Some(PathBuf::from("/work/Game Scripts/角色.cs")),
                    position: Some((41, 6)),
                }
            );
        }
        assert_eq!(request(&["--line=5", "file.cs"]).unwrap().position, Some((4, 0)));
    }

    #[test]
    fn unknown_positions_and_malformed_flags() {
        for value in ["0", "-1"] {
            assert_eq!(request(&["--file", "a.cs", "--line", value, "--column", value]).unwrap().position, None);
            assert_eq!(request(&["--file", "a.cs", "--line", "5", "--column", value]).unwrap().position, Some((4, 0)));
        }
        for args in [
            vec!["--file"],
            vec!["--file="],
            vec!["--file", "--line", "2"],
            vec!["--line", "bad", "a.cs"],
            vec!["--line=4294967296", "a.cs"],
            vec!["--column=-2", "a.cs"],
            vec!["--file=a.cs", "--file=b.cs"],
        ] {
            assert!(request(&args).is_err(), "{args:?}");
        }
    }

    #[test]
    fn positional_opening_and_end_of_options() {
        assert_eq!(request(&["--verbose", "proj"]).unwrap().path, Some(PathBuf::from("/work/proj")));
        assert_eq!(request(&["--", "-notes.txt"]).unwrap().path, Some(PathBuf::from("/work/-notes.txt")));
        assert_eq!(request(&["-psn_0_123"]).unwrap(), Request::default());
        assert_eq!(request(&["--column", "7", "a.cs"]).unwrap().position, None);
    }

    #[test]
    fn project_relative_file_is_independent_of_invocation_directory() {
        let project = std::env::temp_dir();
        let args = vec!["openidea".into(), project.to_string_lossy().into_owned(), "--file=Assets/A.cs".into()];
        let r = parse(&args, Path::new("/unrelated")).unwrap();
        assert_eq!(r.path, Some(project.clone()));
        assert_eq!(r.file, Some(project.join("Assets/A.cs")));
    }

    #[test]
    #[cfg(windows)]
    fn windows_absolute_paths_are_not_prefixed() {
        for file in [r"D:\Game Scripts\角色.cs", r"\\server\share\Game\A.cs", "D:/Game Scripts/A.cs"] {
            assert_eq!(request(&["--file", file]).unwrap().file, Some(PathBuf::from(file)));
        }
    }
}
