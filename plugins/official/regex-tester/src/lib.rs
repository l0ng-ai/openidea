//! Regex Tester for OpenIDEA: a tool window whose page (an `html` body) sends
//! the pattern, flags, text and replacement as you type; the plugin matches
//! them with Rust's `regex` (linear time, so no pattern can hang it) and posts
//! the matches back, in UTF-16 offsets the page can highlight. *Use Selection*
//! takes the focused editor's selection as the text.

use openidea_plugin::host;
use openidea_plugin::views::{Body, Button, View, ViewEvent, Viewport, Views};
use openidea_plugin::{Error, Invocation, Plugin, register_plugin};
use regex::RegexBuilder;
use serde_json::{Value, json};

pub const VIEW: &str = "regex";
/// Longest text matched (bytes).
const MAX_TEXT: usize = 1 << 20;
/// Most matches sent back (all are counted).
const MAX_MATCHES: usize = 1000;
/// Longest replacement preview sent back (bytes).
const MAX_REPLACED: usize = 256 << 10;
const PAGE: &str = include_str!("page.html");

#[derive(Default)]
pub struct RegexTester;

/// A request from the page.
#[derive(Debug, PartialEq)]
pub struct Run {
    pub seq: u64,
    pub pattern: String,
    pub flags: String,
    pub text: String,
    pub replace: Option<String>,
}

impl Run {
    pub fn parse(v: &Value) -> Option<Run> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
        Some(Run {
            seq: v.get("seq").and_then(Value::as_u64).unwrap_or(0),
            pattern: s("pattern")?,
            flags: s("flags").unwrap_or_default(),
            text: s("text").unwrap_or_default(),
            replace: s("replace"),
        })
    }
}

/// UTF-16 offset of every byte offset that starts a char (and the end).
fn utf16_offsets(text: &str) -> Vec<u32> {
    let mut map = vec![0u32; text.len() + 1];
    let mut at = 0u32;
    for (i, c) in text.char_indices() {
        map[i] = at;
        at += c.len_utf16() as u32;
    }
    map[text.len()] = at;
    map
}

/// Matches `run` and returns the page's result message.
pub fn evaluate(run: &Run) -> Value {
    let fail = |e: String| json!({ "op": "result", "seq": run.seq, "error": e, "matches": [], "count": 0 });
    if run.text.len() > MAX_TEXT {
        return fail(format!("the text is longer than {} KiB", MAX_TEXT >> 10));
    }
    let flag = |c: char| run.flags.contains(c);
    let re = match RegexBuilder::new(&run.pattern)
        .case_insensitive(flag('i'))
        .multi_line(flag('m'))
        .dot_matches_new_line(flag('s'))
        .ignore_whitespace(flag('x'))
        .size_limit(8 << 20)
        .build()
    {
        Ok(re) => re,
        // The parser's message names the position; keep it, minus the repeated pattern.
        Err(e) => return fail(e.to_string()),
    };
    if run.pattern.is_empty() {
        return json!({ "op": "result", "seq": run.seq, "error": null, "matches": [], "count": 0, "groups": [] });
    }
    let at = utf16_offsets(&run.text);
    let names: Vec<Value> = re.capture_names().skip(1).map(|n| n.map_or(Value::Null, |n| json!(n))).collect();
    let mut matches = Vec::new();
    let mut count = 0usize;
    for caps in re.captures_iter(&run.text) {
        count += 1;
        if matches.len() < MAX_MATCHES {
            let groups: Vec<Value> = (1..caps.len())
                .map(|i| caps.get(i).map_or(Value::Null, |g| json!([at[g.start()], at[g.end()]])))
                .collect();
            let m = caps.get(0).expect("group 0");
            matches.push(json!({ "s": at[m.start()], "e": at[m.end()], "groups": groups }));
        }
    }
    let replaced = run.replace.as_ref().map(|r| {
        let mut out = re.replace_all(&run.text, r.as_str()).into_owned();
        if out.len() > MAX_REPLACED {
            let mut cut = MAX_REPLACED;
            while !out.is_char_boundary(cut) {
                cut -= 1;
            }
            out.truncate(cut);
            out.push('…');
        }
        out
    });
    json!({
        "op": "result",
        "seq": run.seq,
        "error": null,
        "matches": matches,
        "count": count,
        "groups": names,
        "replaced": replaced,
    })
}

/// The flags the page starts with, from the settings.
fn default_flags() -> String {
    let mut f = String::new();
    if host::setting_bool("ignoreCase").unwrap_or(false) {
        f.push('i');
    }
    if host::setting_bool("multiLine").unwrap_or(true) {
        f.push('m');
    }
    f
}

/// The focused editor's first non-empty selection, else its whole text.
fn selection_text(ctx: &Invocation) -> Result<String, Error> {
    let editor = ctx.editor().ok_or_else(|| Error::Invalid("focus an editor first".into()))?;
    let doc = editor.document()?;
    let selected = editor.selections()?.into_iter().filter_map(|r| doc.text_in(r)).find(|t| !t.is_empty());
    let text = selected.map(str::to_owned).unwrap_or(doc.text);
    Ok(if text.len() > MAX_TEXT {
        let mut cut = MAX_TEXT;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text[..cut].to_owned()
    } else {
        text
    })
}

fn post(message: &Value) -> Result<(), Error> {
    host::post_view_message(VIEW, &message.to_string())
}

impl Plugin for RegexTester {
    fn run_command(&mut self, id: &str, ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            // To the open tool window (its page ignores it until it has loaded).
            "test-selection" => post(&json!({ "op": "text", "text": selection_text(ctx)? })).map(|()| None),
            _ => Err(Error::NotFound(format!("command {id}"))),
        }
    }
}

impl Views for RegexTester {
    fn render(&mut self, view: &str, _viewport: Option<Viewport>, _ctx: &Invocation) -> Result<View, Error> {
        if view != VIEW {
            return Err(Error::NotFound(view.into()));
        }
        // The page keeps its own state: the plugin only answers its messages,
        // and never re-renders it (that would reload the frame).
        let start = json!({ "flags": default_flags() }).to_string().replace('<', "\\u003c");
        let page = PAGE.replacen(r#""__START__""#, &start, 1);
        Ok(View::new(Body::Html(page)).button(Button::new("selection", "Use Selection").icon("text")))
    }

    fn handle(&mut self, view: &str, event: ViewEvent, ctx: &Invocation) -> Result<(), Error> {
        if view != VIEW {
            return Err(Error::NotFound(view.into()));
        }
        match event {
            ViewEvent::Button(b) if b == "selection" => post(&json!({ "op": "text", "text": selection_text(ctx)? })),
            ViewEvent::Message(text) => {
                let Ok(v) = serde_json::from_str::<Value>(&text) else { return Ok(()) };
                match v.get("op").and_then(Value::as_str) {
                    Some("run") => match Run::parse(&v) {
                        Some(run) => post(&evaluate(&run)),
                        None => Ok(()),
                    },
                    Some("selection") => post(&json!({ "op": "text", "text": selection_text(ctx)? })),
                    _ => Ok(()),
                }
            }
            _ => Ok(()),
        }
    }
}

register_plugin!(RegexTester, views);

#[cfg(test)]
mod tests {
    use super::*;
    use openidea_plugin::mock::MockHost;

    fn run(pattern: &str, flags: &str, text: &str, replace: Option<&str>) -> Value {
        evaluate(&Run {
            seq: 7,
            pattern: pattern.into(),
            flags: flags.into(),
            text: text.into(),
            replace: replace.map(str::to_owned),
        })
    }

    #[test]
    fn matches_with_groups_in_utf16_offsets() {
        // "é" is one UTF-16 unit but two bytes; "😀" two units, four bytes.
        let r = run(r"(?P<word>\w+)@(\d+)", "", "é😀 ab@12 cd@3", None);
        assert_eq!(r["error"], Value::Null);
        assert_eq!(r["count"], 2);
        assert_eq!(r["seq"], 7);
        assert_eq!(r["groups"], json!(["word", null]));
        assert_eq!(r["matches"][0], json!({ "s": 4, "e": 9, "groups": [[4, 6], [7, 9]] }));
        assert_eq!(r["matches"][1]["s"], 10);
    }

    #[test]
    fn flags_change_the_match() {
        let text = "One\none";
        assert_eq!(run("^one$", "", text, None)["count"], 0);
        assert_eq!(run("^one$", "m", text, None)["count"], 1);
        assert_eq!(run("^one$", "im", text, None)["count"], 2);
        assert_eq!(run("e.o", "", text, None)["count"], 0);
        assert_eq!(run("e.o", "s", text, None)["count"], 1);
        assert_eq!(run("o n e", "x", text, None)["count"], 1);
    }

    #[test]
    fn replacement_preview_and_errors() {
        let r = run(r"(\w+)@(\d+)", "", "ab@12, cd@3", Some("$2:$1"));
        assert_eq!(r["replaced"], "12:ab, 3:cd");
        let bad = run("(unclosed", "", "x", None);
        assert!(bad["error"].as_str().unwrap().contains("unclosed"), "{bad}");
        assert_eq!(bad["count"], 0);
        assert_eq!(run("", "", "x", None)["count"], 0);
    }

    #[test]
    fn counts_every_match_but_sends_a_bounded_number() {
        let text = "a".repeat(5000);
        let r = run("a", "", &text, None);
        assert_eq!(r["count"], 5000);
        assert_eq!(r["matches"].as_array().unwrap().len(), MAX_MATCHES);
    }

    #[test]
    fn answers_the_page_and_reads_the_selection() {
        let host = MockHost::install().with_capabilities(&["editor.read"]);
        host.set_setting("ignoreCase", "true");
        let mut p = RegexTester;
        let View { body: Body::Html(page), toolbar, .. } = p.render(VIEW, None, &host.invocation()).unwrap() else {
            panic!("an html body")
        };
        assert!(page.contains(r#"{"flags":"im"}"#), "the settings' flags start the page");
        assert_eq!(toolbar[0].id, "selection");

        let msg = json!({ "op": "run", "seq": 1, "pattern": "b+", "flags": "", "text": "abbc" }).to_string();
        p.handle(VIEW, ViewEvent::Message(msg), &host.invocation()).unwrap();
        let (view, reply) = host.view_messages().pop().unwrap();
        assert_eq!(view, VIEW);
        let reply: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!((reply["count"].clone(), reply["matches"][0]["s"].clone()), (json!(1), json!(1)));

        host.open_editor("/p/a.txt", "plaintext", "first line\nsecond", &[(1, 0, 1, 6)]);
        p.handle(VIEW, ViewEvent::Button("selection".into()), &host.invocation()).unwrap();
        let reply: Value = serde_json::from_str(&host.view_messages().pop().unwrap().1).unwrap();
        assert_eq!(reply, json!({ "op": "text", "text": "second" }));

        // Garbage from the page is ignored.
        p.handle(VIEW, ViewEvent::Message("not json".into()), &host.invocation()).unwrap();
    }
}
