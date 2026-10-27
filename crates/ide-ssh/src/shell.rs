//! POSIX shell command lines for the remote side.

use std::collections::BTreeMap;

/// Quotes `s` for a POSIX shell (`'…'`, with `'\''` for quotes inside).
pub fn quote(s: &str) -> String {
    if !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_./=:,+@%".contains(&b)) {
        return s.to_owned();
    }
    format!("'{}'", s.replace('\'', r"'\''"))
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

    #[test]
    fn quotes_only_when_needed() {
        assert_eq!(quote("plain/path-1.txt"), "plain/path-1.txt");
        assert_eq!(quote("a b"), "'a b'");
        assert_eq!(quote("it's"), r"'it'\''s'");
        assert_eq!(quote(""), "''");
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
