//! Command-line arguments of `openidea`.

use crate::Target;
use std::path::Path;

pub const USAGE: &str = "\
Usage: openidea [options] [[--line <n>] [--column <n>] path[:line[:column]] ...]
       openidea diff <left> <right>

Opens folders as projects and files in the editor of the running OpenIDEA,
starting it if needed. Without paths, brings OpenIDEA to the front.
Lines and columns start at 1; --line and --column apply to the next path.

Options:
  --line <n>     Put the caret on line <n> of the next file
  --column <n>   Put the caret in column <n> of that line
  -h, --help     Show this help
  -v, --version  Show the version
";

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Help,
    Version,
    Open(Vec<Target>),
    Diff(Vec<Target>),
}

/// Parses `args` (without the program name); relative paths resolve against `cwd`.
pub fn parse(args: &[String], cwd: &Path) -> Result<Command, String> {
    parse_with(args, cwd, &|p| p.exists())
}

fn parse_with(args: &[String], cwd: &Path, exists: &dyn Fn(&Path) -> bool) -> Result<Command, String> {
    if args.first().is_some_and(|arg| arg == "diff") {
        return match parse_paths(&args[1..], cwd, exists)? {
            Command::Open(targets) if targets.len() == 2 => Ok(Command::Diff(targets)),
            Command::Help => Ok(Command::Help),
            _ => Err("diff needs two files".into()),
        };
    }
    parse_paths(args, cwd, exists)
}

fn parse_paths(args: &[String], cwd: &Path, exists: &dyn Fn(&Path) -> bool) -> Result<Command, String> {
    let mut targets = Vec::new();
    let mut options = true;
    let (mut line, mut column) = (None, None);
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if options && flag.starts_with("--") => (flag, Some(value.to_owned())),
            _ => (arg.as_str(), None),
        };
        match flag {
            "--" if options => options = false,
            "-h" | "--help" if options => return Ok(Command::Help),
            "-v" | "--version" if options => return Ok(Command::Version),
            "--line" | "--column" if options => {
                let value = inline.or_else(|| args.next().cloned()).ok_or(format!("{flag} needs a number"))?;
                let n = position(&value).ok_or(format!("{flag}: not a number from 1: {value}"))?;
                *if flag == "--line" { &mut line } else { &mut column } = Some(n);
            }
            a if options && a.starts_with('-') && a != "-" => return Err(format!("unknown option: {a}")),
            _ => {
                let mut target = target(arg, cwd, exists)?;
                if line.is_some() || column.is_some() {
                    target.line = line.take().or(target.line).or(Some(1));
                    target.column = column.take();
                }
                targets.push(target);
            }
        }
    }
    if line.is_some() || column.is_some() {
        return Err("--line and --column need a file after them".into());
    }
    Ok(Command::Open(targets))
}

/// `arg` as a path, else as `path:line[:column]` when `path` exists.
fn target(arg: &str, cwd: &Path, exists: &dyn Fn(&Path) -> bool) -> Result<Target, String> {
    let path = cwd.join(arg);
    if exists(&path) {
        return Ok(Target { path, line: None, column: None });
    }
    for (base, line, column) in split_position(arg) {
        let path = cwd.join(base);
        if exists(&path) {
            return Ok(Target { path, line: Some(line), column });
        }
    }
    Err(format!("{arg}: no such file or directory"))
}

/// The readings of `arg` as `path:line:column`, then as `path:line`.
fn split_position(arg: &str) -> Vec<(&str, u32, Option<u32>)> {
    let Some((rest, last)) = arg.rsplit_once(':') else { return Vec::new() };
    let Some(last) = position(last) else { return Vec::new() };
    let mut readings = Vec::new();
    if let Some((base, line)) = rest.rsplit_once(':')
        && let Some(line) = position(line)
        && !base.is_empty()
    {
        readings.push((base, line, Some(last)));
    }
    if !rest.is_empty() {
        readings.push((rest, last, None));
    }
    readings
}

fn position(s: &str) -> Option<u32> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok().filter(|n| *n > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    fn parse_in(list: &[&str], existing: &[&str]) -> Result<Command, String> {
        let existing: Vec<PathBuf> = existing.iter().map(PathBuf::from).collect();
        parse_with(&args(list), Path::new("/work"), &|p| existing.iter().any(|e| e == p))
    }

    fn at(path: &str, line: Option<u32>, column: Option<u32>) -> Target {
        Target { path: path.into(), line, column }
    }

    #[test]
    fn paths_resolve_against_cwd() {
        assert_eq!(
            parse_in(&["src", "/abs/a.rs"], &["/work/src", "/abs/a.rs"]),
            Ok(Command::Open(vec![at("/work/src", None, None), at("/abs/a.rs", None, None)]))
        );
        assert_eq!(parse_in(&[], &[]), Ok(Command::Open(vec![])));
    }

    #[test]
    fn positions_split_only_when_the_whole_arg_is_missing() {
        let files = ["/work/a.rs"];
        assert_eq!(parse_in(&["a.rs:12"], &files), Ok(Command::Open(vec![at("/work/a.rs", Some(12), None)])));
        assert_eq!(parse_in(&["a.rs:12:5"], &files), Ok(Command::Open(vec![at("/work/a.rs", Some(12), Some(5))])));
        assert!(parse_in(&["a.rs:0"], &files).is_err());
        assert!(parse_in(&["a.rs:x"], &files).is_err());
        assert!(parse_in(&["missing.rs:3"], &files).is_err());
    }

    // Windows file names cannot contain `:`, and `b:2` reads as a path on drive B.
    #[cfg(unix)]
    #[test]
    fn an_existing_name_with_a_colon_wins_over_a_position() {
        let files = ["/work/b:2"];
        assert_eq!(parse_in(&["b:2"], &files), Ok(Command::Open(vec![at("/work/b:2", None, None)])));
        assert_eq!(parse_in(&["b:2:7"], &files), Ok(Command::Open(vec![at("/work/b:2", Some(7), None)])));
    }

    #[test]
    fn windows_drive_colon_is_not_a_position() {
        assert_eq!(split_position(r"C:\a.rs:10"), vec![(r"C:\a.rs", 10, None)]);
        assert_eq!(split_position(r"C:\a.rs:10:2"), vec![(r"C:\a.rs", 10, Some(2)), (r"C:\a.rs:10", 2, None)]);
        assert!(split_position(r"C:\a.rs").is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn windows_absolute_and_unc_targets_keep_spaces_and_unicode() {
        let local = PathBuf::from(r"C:\项目\my file.rs");
        let network = PathBuf::from(r"\\server\share\folder name");
        let command = parse_with(
            &args(&[r"C:\项目\my file.rs:12:5", r"\\server\share\folder name"]),
            Path::new(r"D:\work"),
            &|path| path == local || path == network,
        );
        assert_eq!(
            command,
            Ok(Command::Open(vec![
                Target { path: local, line: Some(12), column: Some(5) },
                Target { path: network, line: None, column: None },
            ]))
        );
    }

    #[test]
    fn line_and_column_flags_apply_to_the_next_path() {
        let files = ["/work/a.rs", "/work/b.rs"];
        assert_eq!(
            parse_in(&["--line", "12", "--column=5", "a.rs", "b.rs"], &files),
            Ok(Command::Open(vec![at("/work/a.rs", Some(12), Some(5)), at("/work/b.rs", None, None)]))
        );
        assert_eq!(
            parse_in(&["--line=3", "a.rs:9:9"], &files),
            Ok(Command::Open(vec![at("/work/a.rs", Some(3), None)]))
        );
        assert!(parse_in(&["--line", "0", "a.rs"], &files).is_err());
        assert!(parse_in(&["--line"], &files).is_err());
        assert!(parse_in(&["a.rs", "--line", "2"], &files).is_err());
    }

    #[test]
    fn options() {
        assert_eq!(parse_in(&["-h"], &[]), Ok(Command::Help));
        assert_eq!(parse_in(&["--version"], &[]), Ok(Command::Version));
        assert!(parse_in(&["--nope"], &[]).is_err());
        assert_eq!(parse_in(&["--", "-h"], &["/work/-h"]), Ok(Command::Open(vec![at("/work/-h", None, None)])));
    }

    #[test]
    fn existing_diff_command_is_supported() {
        let files = ["/work/a.rs", "/work/b.rs"];
        assert_eq!(
            parse_in(&["diff", "a.rs", "b.rs"], &files),
            Ok(Command::Diff(vec![at("/work/a.rs", None, None), at("/work/b.rs", None, None),]))
        );
        assert!(parse_in(&["diff", "a.rs"], &files).is_err());
        assert_eq!(
            parse_in(&["diff", "diff", "b.rs"], &["/work/diff", "/work/b.rs"]),
            Ok(Command::Diff(vec![at("/work/diff", None, None), at("/work/b.rs", None, None),]))
        );
        assert_eq!(parse_in(&["--", "diff"], &["/work/diff"]), Ok(Command::Open(vec![at("/work/diff", None, None)])));
        assert_eq!(
            parse_in(&["--column=4", "a.rs", "b.rs"], &files),
            Ok(Command::Open(vec![at("/work/a.rs", Some(1), Some(4)), at("/work/b.rs", None, None),]))
        );
    }
}
