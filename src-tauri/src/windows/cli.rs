//! External editor arguments. Positions are 1-based, as sent by Unity.
use super::{FileLocation, Launch, path_launch};
use std::path::{Path, PathBuf};

pub fn parse(args: &[String], cwd: &Path) -> Result<Option<Launch>, String> {
    let (mut file, mut positional, mut line, mut column) = (None, None, None, None);
    let mut args = args.iter().skip(1).map(String::as_str);
    while let Some(arg) = args.next() {
        if arg == "--" {
            positional = positional.or_else(|| args.next().map(str::to_owned));
            break;
        }
        let (flag, inline) = arg.split_once('=').map_or((arg, None), |(k, v)| (k, Some(v)));
        match flag {
            "--file" | "--line" | "--column" => {
                let value = inline.or_else(|| args.next()).ok_or_else(|| format!("{flag} requires a value"))?;
                if value.is_empty() || value.starts_with("--") {
                    return Err(format!("{flag} requires a value"));
                }
                match flag {
                    "--file" => {
                        if file.replace(value.to_owned()).is_some() {
                            return Err("--file can only be specified once".into());
                        }
                    }
                    "--line" => line = position(flag, value)?,
                    "--column" => column = position(flag, value)?,
                    _ => unreachable!(),
                }
            }
            _ if !arg.starts_with('-') && !arg.is_empty() && !arg.starts_with("psn_") => {
                positional.get_or_insert_with(|| arg.to_owned());
            }
            _ => {} // Keep accepting existing flags (including macOS's -psn_*).
        }
    }
    let explicit = file.is_some();
    let Some(path) = file.or(positional) else { return Ok(None) };
    let path = PathBuf::from(path);
    let path = if path.is_absolute() { path } else { cwd.join(path) };
    let path = dunce::canonicalize(&path).unwrap_or(path);
    if explicit && path.is_dir() {
        return Err("--file expects a file, not a directory".into());
    }
    let mut launch = path_launch(path.clone());
    if !launch.files.is_empty() {
        // A Unity script should open with its project, even before .sln generation.
        launch.project =
            path.parent().and_then(|p| p.ancestors().find(|p| ide_workspace::unity::is_project(p))).map(Into::into);
        if line.is_some() || column.is_some() {
            launch.location =
                Some(FileLocation { path: path.into(), line: line.unwrap_or(1), column: column.unwrap_or(1) });
        }
    }
    Ok(Some(launch))
}

fn position(flag: &str, value: &str) -> Result<Option<u32>, String> {
    // Unity uses 0 or -1 when it has no source position (e.g. double-clicking a script).
    let number = value.parse::<i64>().map_err(|_| format!("{flag} expects an integer"))?;
    match number {
        -1 | 0 => Ok(None),
        1..=4294967295 => Ok(Some(number as u32)),
        _ => Err(format!("{flag} is outside the supported range")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn parse_args(args: &[&str], cwd: &Path) -> Result<Option<Launch>, String> {
        parse(&std::iter::once("openidea").chain(args.iter().copied()).map(str::to_owned).collect::<Vec<_>>(), cwd)
    }

    #[test]
    fn parses_positions_in_any_order_and_both_argument_forms() {
        let cwd = Path::new("/work");
        let launch =
            parse_args(&["--column=7", "--line", "42", "--file", "Game Scripts/Player.cs"], cwd).unwrap().unwrap();
        let path = cwd.join("Game Scripts/Player.cs");
        assert_eq!(launch.files, vec![path.clone()]);
        assert_eq!(launch.location, Some(FileLocation { path: path.into(), line: 42, column: 7 }));
        assert!(launch.project.is_none());
        let launch = parse_args(&["--file=a.cs", "--line=5"], cwd).unwrap().unwrap();
        assert_eq!((launch.location.as_ref().unwrap().line, launch.location.unwrap().column), (5, 1));
    }

    #[test]
    fn unknown_positions_do_not_jump_and_invalid_values_do_not_become_paths() {
        for value in ["0", "-1"] {
            let launch = parse_args(&["--file", "a.cs", "--line", value, "--column", value], Path::new("/work"))
                .unwrap()
                .unwrap();
            assert!(launch.location.is_none());
        }
        for args in [
            vec!["--file"],
            vec!["--file="],
            vec!["--file", "--line", "2"],
            vec!["--file", "a.cs", "--line", "bad"],
            vec!["--line=4294967296", "a.cs"],
            vec!["--column=-2", "a.cs"],
            vec!["--file=a.cs", "--file=b.cs"],
        ] {
            assert!(parse_args(&args, Path::new("/work")).is_err(), "{args:?}");
        }
        assert!(parse_args(&["--line=4"], Path::new("/work")).unwrap().is_none());
    }

    #[test]
    fn keeps_positional_paths_and_finds_unity_project_without_solution() {
        let temp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(temp.path()).unwrap();
        let game = root.join("My Game");
        std::fs::create_dir_all(game.join("Assets/Scripts")).unwrap();
        std::fs::create_dir(game.join("ProjectSettings")).unwrap();
        std::fs::write(game.join("ProjectSettings/ProjectVersion.txt"), "m_EditorVersion: 2022.3.40f1c1").unwrap();
        let file = game.join("Assets/Scripts/角色.cs");
        std::fs::write(&file, "class Player {}\n").unwrap();
        let launch = parse_args(&["--file", file.to_str().unwrap(), "--line", "12"], &root).unwrap().unwrap();
        assert_eq!(launch.project, Some(game.clone().into()));
        assert_eq!(launch.files, vec![file]);
        let launch = parse_args(&["--verbose", "My Game"], &root).unwrap().unwrap();
        assert_eq!(launch.project, Some(game.into()));
        assert!(launch.location.is_none());
        assert!(parse_args(&["--file", "My Game"], &root).is_err());
        assert_eq!(parse_args(&["-psn_0_123"], &root).unwrap(), None);
        assert_eq!(parse_args(&["--", "-notes.txt"], &root).unwrap().unwrap().files, vec![root.join("-notes.txt")]);
    }
}
