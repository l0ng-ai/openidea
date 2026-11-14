//! Syntax check for `when` clauses in UI declarations. The client evaluates
//! them (`src/platform/context.ts`); validating here keeps the client's
//! projection from failing. Grammar (same as the client):
//!
//! ```text
//! expr := or ; or := and ("||" and)* ; and := unary ("&&" unary)*
//! unary := "!" unary | "(" expr ")" | cmp ; cmp := key (("==" | "!=") value)?
//! ```

const MAX_LEN: usize = 512;

#[derive(Debug, PartialEq)]
enum Tok<'a> {
    Id(&'a str),
    Str,
    Op(&'a str),
}

fn tokenize(src: &str) -> Result<Vec<Tok<'_>>, String> {
    let mut out = Vec::new();
    let b = src.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let c = b[i] as char;
        if c.is_whitespace() {
            i += 1;
        } else if ["&&", "||", "==", "!="].iter().any(|op| src[i..].starts_with(op)) {
            out.push(Tok::Op(&src[i..i + 2]));
            i += 2;
        } else if matches!(c, '!' | '(' | ')') {
            out.push(Tok::Op(&src[i..i + 1]));
            i += 1;
        } else if c == '\'' || c == '"' {
            let end = src[i + 1..].find(c).ok_or_else(|| format!("unterminated string in when clause: {src}"))?;
            out.push(Tok::Str);
            i += end + 2;
        } else {
            let len = src[i..]
                .find(|ch: char| !(ch.is_alphanumeric() || matches!(ch, '_' | '.' | '-' | ':' | '/')))
                .unwrap_or(src.len() - i);
            if len == 0 {
                return Err(format!("unexpected '{c}' in when clause: {src}"));
            }
            out.push(Tok::Id(&src[i..i + len]));
            i += len;
        }
    }
    Ok(out)
}

/// Checks a `when` clause; empty means "always".
pub fn validate_when(src: &str) -> Result<(), String> {
    if src.len() > MAX_LEN {
        return Err(format!("when clause longer than {MAX_LEN} bytes"));
    }
    if src.trim().is_empty() {
        return Ok(());
    }
    let toks = tokenize(src)?;
    let mut p = 0;
    parse_or(&toks, &mut p, src)?;
    if p != toks.len() {
        return Err(format!("unexpected token in when clause: {src}"));
    }
    Ok(())
}

fn parse_or(t: &[Tok], p: &mut usize, src: &str) -> Result<(), String> {
    parse_and(t, p, src)?;
    while t.get(*p) == Some(&Tok::Op("||")) {
        *p += 1;
        parse_and(t, p, src)?;
    }
    Ok(())
}

fn parse_and(t: &[Tok], p: &mut usize, src: &str) -> Result<(), String> {
    parse_unary(t, p, src)?;
    while t.get(*p) == Some(&Tok::Op("&&")) {
        *p += 1;
        parse_unary(t, p, src)?;
    }
    Ok(())
}

fn parse_unary(t: &[Tok], p: &mut usize, src: &str) -> Result<(), String> {
    match t.get(*p) {
        Some(Tok::Op("!")) => {
            *p += 1;
            parse_unary(t, p, src)
        }
        Some(Tok::Op("(")) => {
            *p += 1;
            parse_or(t, p, src)?;
            if t.get(*p) != Some(&Tok::Op(")")) {
                return Err(format!("missing ')' in when clause: {src}"));
            }
            *p += 1;
            Ok(())
        }
        Some(Tok::Id(id)) => {
            if let Some(path) = id.strip_prefix("workspaceContains:")
                && (path.is_empty()
                    || path.starts_with('/')
                    || path.contains('\\')
                    || path.split('/').any(|s| s == ".."))
            {
                return Err(format!("workspaceContains: needs a relative path inside the project: {src}"));
            }
            *p += 1;
            if matches!(t.get(*p), Some(Tok::Op("==" | "!="))) {
                *p += 1;
                match t.get(*p) {
                    Some(Tok::Id(_) | Tok::Str) => *p += 1,
                    _ => return Err(format!("missing value after comparison in when clause: {src}")),
                }
            }
            Ok(())
        }
        _ => Err(format!("expected a context key in when clause: {src}")),
    }
}

#[cfg(test)]
mod tests {
    use super::validate_when;

    #[test]
    fn accepts_the_client_grammar() {
        for ok in [
            "",
            "editorFocus",
            "editorLang == rust",
            "editorLang != 'rust' && !readOnly",
            "(a || b) && toolWindow.project.active",
            "resourceScheme == file:/x",
        ] {
            assert!(validate_when(ok).is_ok(), "{ok}");
        }
        for bad in ["a &&", "(a", "a == ", "== a", "a b", "a $ b", "'x", "!()"] {
            assert!(validate_when(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn workspace_contains_paths_stay_in_the_project() {
        for ok in [
            "workspaceContains:pom.xml",
            "workspaceContains:.devcontainer/devcontainer.json",
            "!workspaceContains:a/b && editorFocus",
        ] {
            assert!(validate_when(ok).is_ok(), "{ok}");
        }
        for bad in [
            "workspaceContains:",
            "workspaceContains:/etc/passwd",
            "workspaceContains:../x",
            "workspaceContains:a/../../x",
        ] {
            assert!(validate_when(bad).unwrap_err().contains("workspaceContains"), "{bad}");
        }
    }
}
