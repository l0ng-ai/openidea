//! POSIX shell command lines for the remote side.

use std::collections::BTreeMap;

/// Quotes `s` for a POSIX shell (`'…'`, with `'\''` for quotes inside).
pub fn quote(s: &str) -> String {
    if !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_./=:,+@%".contains(&b)) {
        return s.to_owned();
    }
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// `script` as the command of an exec request, run by POSIX `sh` whatever the account's login
/// shell is. sshd hands every exec request to the login shell, and fish (like csh) rejects POSIX
/// syntax such as `if …; then`, `${VAR:-}`, `X=$(…)` or a glob that matches nothing; `sh -c`
/// with the script as one argument is a plain command to every shell.
pub fn posix_command(script: &str) -> String {
    format!("sh -c {}", login_shell_quote(script))
}

/// Single-quotes `s` so that POSIX shells and fish read the same text. Inside `'…'` fish still
/// takes `\\` and `\'` as escapes, so quotes and backslashes are written outside the quotes, where
/// every shell reads `\'` and `\\` alike.
fn login_shell_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        match c {
            '\'' => out.push_str(r"'\''"),
            '\\' => out.push_str(r"'\\'"),
            c => out.push(c),
        }
    }
    out.push('\'');
    out
}

/// The script of a [`posix_command`] (the test server runs what the client asked for).
#[cfg(any(test, feature = "testing"))]
pub(crate) fn posix_script(command: &str) -> Option<String> {
    let quoted = command.strip_prefix("sh -c ")?;
    let (mut out, mut chars, mut inside) = (String::new(), quoted.chars(), false);
    while let Some(c) = chars.next() {
        match (inside, c) {
            (_, '\'') => inside = !inside,
            (false, '\\') => out.push(chars.next()?),
            (true, c) => out.push(c),
            (false, _) => return None,
        }
    }
    (!inside).then_some(out)
}

/// `cd <cwd> && exec env K=V … <program> <args…>`. A program starting with `~/`
/// is left to the shell's tilde expansion.
pub fn command_line(cwd: Option<&str>, env: &BTreeMap<String, String>, program: &str, args: &[String]) -> String {
    let mut s = String::new();
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        s.push_str("cd ");
        s.push_str(&tilde_quote(dir));
        s.push_str(" && ");
    }
    s.push_str("exec ");
    if !env.is_empty() {
        s.push_str("env");
        for (k, v) in env {
            s.push(' ');
            s.push_str(&quote(&format!("{k}={v}")));
        }
        s.push(' ');
    }
    s.push_str(&tilde_quote(program));
    for a in args {
        s.push(' ');
        s.push_str(&quote(a));
    }
    s
}

/// [`quote`], except that a leading `~/` stays open to tilde expansion.
pub fn tilde_quote(path: &str) -> String {
    match path.strip_prefix("~/") {
        Some(rest) => format!("~/{}", quote(rest)),
        None if path == "~" => "~".into(),
        None => quote(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::process::{Command, Stdio};

    #[test]
    fn quotes_only_when_needed() {
        assert_eq!(quote("plain/path-1.txt"), "plain/path-1.txt");
        assert_eq!(quote("a b"), "'a b'");
        assert_eq!(quote("it's"), r"'it'\''s'");
        assert_eq!(quote(""), "''");
    }

    #[test]
    fn a_posix_command_round_trips_through_sh() {
        for script in
            ["echo hi", "it's", r"a\b", r"printf '%s\n' \'x\'", "if [ -x ~/bin ]; then echo ${HOME:-/x}; fi", ""]
        {
            let command = posix_command(script);
            assert_eq!(posix_script(&command).as_deref(), Some(script), "{command}");
            // Send the POSIX syntax verbatim through stdin on every platform.
            let mut sh = Command::new("sh")
                .arg("-s")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            writeln!(sh.stdin.take().unwrap(), "printf %s {}", login_shell_quote(script)).unwrap();
            let out = sh.wait_with_output().unwrap();
            assert!(
                out.status.success(),
                "sh failed for {command} with {}\n{}",
                out.status,
                String::from_utf8_lossy(&out.stderr)
            );
            assert_eq!(out.stdout.as_slice(), script.as_bytes(), "{command}");
        }
        assert_eq!(posix_command("it's"), r"sh -c 'it'\''s'");
        assert_eq!(posix_command(r"a\b"), r"sh -c 'a'\\'b'");
    }

    #[test]
    fn builds_a_command_line() {
        let env = BTreeMap::from([("A".to_owned(), "1 2".to_owned())]);
        assert_eq!(
            command_line(Some("~/proj dir"), &env, "python3", &["-u".into(), "main.py".into()]),
            "cd ~/'proj dir' && exec env 'A=1 2' python3 -u main.py"
        );
        assert_eq!(command_line(None, &BTreeMap::new(), "ls", &[]), "exec ls");
    }
}
