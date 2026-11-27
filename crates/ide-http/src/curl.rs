//! cURL ⇄ `.http` request: Convert to cURL and Copy, and the conversion of a pasted
//! `curl …` command into a request.

use crate::PreparedRequest;

/// `req` as a cURL command line, one option per line (POSIX shell quoting).
pub fn to_curl(req: &PreparedRequest) -> String {
    let mut parts = vec![format!("curl -X {} {}", req.method, quote(&req.url))];
    for (k, v) in &req.headers {
        parts.push(format!("-H {}", quote(&format!("{k}: {v}"))));
    }
    if let Some(body) = &req.body {
        parts.push(format!("--data-raw {}", quote(body)));
    }
    parts.join(" \\\n  ")
}

/// `s` in single quotes, as POSIX shells read it.
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// The request a `curl …` command sends, as `.http` text; `None` when `cmd` is not a cURL
/// command or names no URL.
pub fn from_curl(cmd: &str) -> Option<String> {
    let words = split_words(cmd)?;
    let mut args = words.iter().map(String::as_str);
    if args.next() != Some("curl") {
        return None;
    }
    let mut method: Option<String> = None;
    let mut url: Option<String> = None;
    let mut headers: Vec<(String, String)> = Vec::new();
    let mut data: Vec<String> = Vec::new();
    let mut form: Vec<(String, String)> = Vec::new();
    let mut get = false;
    let header = |headers: &mut Vec<(String, String)>, line: &str| {
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_owned(), v.trim().to_owned()));
        }
    };
    while let Some(arg) = args.next() {
        // `--opt=value` and `-Xvalue` forms.
        let (flag, inline) = match arg.split_once('=') {
            Some((f, v)) if arg.starts_with("--") => (f, Some(v.to_owned())),
            _ if arg.len() > 2 && arg.starts_with('-') && !arg.starts_with("--") && takes_value(&arg[..2]) => {
                (&arg[..2], Some(arg[2..].to_owned()))
            }
            _ => (arg, None),
        };
        let mut value = || inline.clone().or_else(|| args.next().map(str::to_owned));
        match flag {
            "-X" | "--request" => method = value(),
            "-H" | "--header" => header(&mut headers, &value()?),
            "-d" | "--data" | "--data-raw" | "--data-binary" | "--data-ascii" | "--data-urlencode" => {
                data.push(value()?)
            }
            "--json" => {
                data.push(value()?);
                headers.push(("Content-Type".into(), "application/json".into()));
                headers.push(("Accept".into(), "application/json".into()));
            }
            "-F" | "--form" | "--form-string" => {
                let v = value()?;
                let (k, v) = v.split_once('=')?;
                form.push((k.to_owned(), v.to_owned()));
            }
            "-u" | "--user" => {
                let v = value()?;
                let (user, pass) = v.split_once(':').unwrap_or((&v, ""));
                headers.push(("Authorization".into(), format!("Basic {user} {pass}").trim_end().to_owned()));
            }
            "-b" | "--cookie" => headers.push(("Cookie".into(), value()?)),
            "-A" | "--user-agent" => headers.push(("User-Agent".into(), value()?)),
            "-e" | "--referer" => headers.push(("Referer".into(), value()?)),
            "--url" => url = value(),
            "-G" | "--get" => get = true,
            f if f.starts_with('-') => {
                // Options with a value the request doesn't need (timeouts, output, proxy…).
                if takes_value(f) {
                    value();
                }
            }
            u => {
                if url.is_none() {
                    url = Some(u.to_owned());
                }
            }
        }
    }
    let mut url = url?;
    if get && !data.is_empty() {
        url.push(if url.contains('?') { '&' } else { '?' });
        url.push_str(&data.join("&"));
        data.clear();
    }
    let method = method.unwrap_or_else(|| if data.is_empty() && form.is_empty() { "GET" } else { "POST" }.into());
    let mut body = None;
    if !form.is_empty() {
        const BOUNDARY: &str = "WebAppBoundary";
        headers.retain(|(k, _)| !k.eq_ignore_ascii_case("content-type"));
        headers.push(("Content-Type".into(), format!("multipart/form-data; boundary={BOUNDARY}")));
        let mut text = String::new();
        for (name, value) in &form {
            text.push_str(&format!("--{BOUNDARY}\n"));
            match value.strip_prefix('@') {
                Some(file) => {
                    let file = file.split(';').next().unwrap_or(file);
                    let base = file.rsplit(['/', '\\']).next().unwrap_or(file);
                    text.push_str(&format!(
                        "Content-Disposition: form-data; name=\"{name}\"; filename=\"{base}\"\n\n< {file}\n"
                    ));
                }
                None => text.push_str(&format!("Content-Disposition: form-data; name=\"{name}\"\n\n{value}\n")),
            }
        }
        text.push_str(&format!("--{BOUNDARY}--"));
        body = Some(text);
    } else if !data.is_empty() {
        if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-type")) {
            headers.push(("Content-Type".into(), "application/x-www-form-urlencoded".into()));
        }
        body = Some(data.join("&"));
    }
    let mut out = format!("{method} {url}\n");
    for (k, v) in &headers {
        out.push_str(&format!("{k}: {v}\n"));
    }
    if let Some(body) = body {
        out.push('\n');
        out.push_str(&body);
        out.push('\n');
    }
    Some(out)
}

/// Options that take a value, so it isn't read as the URL.
fn takes_value(flag: &str) -> bool {
    matches!(
        flag,
        "-X" | "-H"
            | "-d"
            | "-F"
            | "-u"
            | "-b"
            | "-A"
            | "-e"
            | "-o"
            | "-x"
            | "-m"
            | "-c"
            | "-E"
            | "-T"
            | "-w"
            | "-r"
            | "-K"
            | "--output"
            | "--proxy"
            | "--max-time"
            | "--connect-timeout"
            | "--cookie-jar"
            | "--cert"
            | "--key"
            | "--cacert"
            | "--upload-file"
            | "--write-out"
            | "--range"
            | "--config"
            | "--retry"
            | "--resolve"
            | "--interface"
    )
}

/// Shell words of `cmd`: single and double quotes, backslash escapes and line continuations
/// (also `^` / backtick continuations from Windows shells). `None` for an unclosed quote.
fn split_words(cmd: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    let mut chars = cmd.trim().chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                in_word = true;
                loop {
                    match chars.next()? {
                        '\'' => break,
                        c => cur.push(c),
                    }
                }
            }
            '"' => {
                in_word = true;
                loop {
                    match chars.next()? {
                        '"' => break,
                        '\\' if matches!(chars.peek(), Some('"' | '\\' | '$' | '`')) => cur.push(chars.next()?),
                        c => cur.push(c),
                    }
                }
            }
            '\\' | '^' | '`' if matches!(chars.peek(), Some('\n' | '\r')) => {
                while matches!(chars.peek(), Some('\n' | '\r')) {
                    chars.next();
                }
            }
            '\\' => {
                in_word = true;
                if let Some(n) = chars.next() {
                    cur.push(n);
                }
            }
            c if c.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut cur));
                    in_word = false;
                }
            }
            c => {
                in_word = true;
                cur.push(c);
            }
        }
    }
    if in_word {
        words.push(cur);
    }
    Some(words)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_prepared_request_becomes_a_quoted_curl_command() {
        let req = PreparedRequest {
            name: None,
            method: "POST".into(),
            url: "https://api.example.com/users?q=a b".into(),
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: Some("{\"name\": \"O'Brien\"}".into()),
        };
        assert_eq!(
            to_curl(&req),
            "curl -X POST 'https://api.example.com/users?q=a b' \\\n  -H 'Content-Type: application/json' \\\n  --data-raw '{\"name\": \"O'\\''Brien\"}'"
        );
        // And back.
        let http = from_curl(&to_curl(&req)).unwrap();
        assert_eq!(
            http,
            "POST https://api.example.com/users?q=a b\nContent-Type: application/json\n\n{\"name\": \"O'Brien\"}\n"
        );
    }

    #[test]
    fn a_browser_copied_command_becomes_a_request() {
        let cmd = r#"curl 'https://example.com/api/items' \
  -H 'accept: application/json' \
  -H "authorization: Bearer abc" \
  --data-raw '{"a":1}' \
  --compressed -k -s"#;
        assert_eq!(
            from_curl(cmd).unwrap(),
            "POST https://example.com/api/items\naccept: application/json\nauthorization: Bearer abc\nContent-Type: application/x-www-form-urlencoded\n\n{\"a\":1}\n"
        );
    }

    #[test]
    fn options_map_to_headers_query_and_multipart() {
        assert_eq!(
            from_curl("curl -G https://x.dev/s -d q=1 -d page=2 -u bob:secret -A agent --max-time 5").unwrap(),
            "GET https://x.dev/s?q=1&page=2\nAuthorization: Basic bob secret\nUser-Agent: agent\n"
        );
        assert_eq!(
            from_curl("curl -XPUT --url=https://x.dev/a --json '{}'").unwrap(),
            "PUT https://x.dev/a\nContent-Type: application/json\nAccept: application/json\n\n{}\n"
        );
        assert_eq!(
            from_curl("curl https://x.dev/up -F name=doc -F file=@/tmp/a.txt").unwrap(),
            "POST https://x.dev/up\nContent-Type: multipart/form-data; boundary=WebAppBoundary\n\n--WebAppBoundary\nContent-Disposition: form-data; name=\"name\"\n\ndoc\n--WebAppBoundary\nContent-Disposition: form-data; name=\"file\"; filename=\"a.txt\"\n\n< /tmp/a.txt\n--WebAppBoundary--\n"
        );
        // Windows `cmd` continuation.
        assert_eq!(from_curl("curl ^\n  \"https://x.dev\"").unwrap(), "GET https://x.dev\n");
    }

    #[test]
    fn other_text_is_not_a_curl_command() {
        assert_eq!(from_curl("GET https://x.dev"), None);
        assert_eq!(from_curl("curl -H 'a: b'"), None, "no URL");
        assert_eq!(from_curl("curl 'https://x.dev"), None, "unclosed quote");
    }
}
