//! Builds Arthas commands (watch / trace / monitor / stack) from the Java file
//! text and the caret line, mirroring the "Arthas Command" submenu of the
//! IntelliJ Arthas plugin. The command is only copied to the clipboard; the
//! user pastes it into an already attached Arthas console.

/// Which Arthas command the menu item asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Watch,
    Trace,
    Monitor,
    Stack,
}

/// The class and method under the caret.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    /// Fully qualified class name, nested classes separated by `$`.
    pub class_name: String,
    /// Method name (`<init>` for constructors).
    pub method: String,
}

/// Words that can never be the method name of a declaration.
const NOT_A_METHOD: &[&str] = &[
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "try",
    "do",
    "return",
    "new",
    "throw",
    "assert",
    "synchronized",
    "super",
    "this",
    "else",
    "case",
    "instanceof",
    "yield",
    "class",
    "interface",
    "enum",
    "record",
];

const TYPE_KEYWORDS: &[&str] = &["class", "interface", "enum", "record"];

fn is_ident(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$'
}

/// Removes comments and string/char literals so brace counting works.
fn code_only(line: &str, in_block_comment: bool) -> (String, bool) {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut block = in_block_comment;
    let mut i = 0;
    while i < chars.len() {
        if block {
            if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                block = false;
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }
        if chars[i] == '/' && chars.get(i + 1) == Some(&'/') {
            break;
        }
        if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
            block = true;
            i += 2;
            continue;
        }
        let ch = chars[i];
        if ch == '"' || ch == '\'' {
            let quote = ch;
            i += 1;
            while i < chars.len() {
                if chars[i] == '\\' {
                    i += 2;
                } else if chars[i] == quote {
                    i += 1;
                    break;
                } else {
                    i += 1;
                }
            }
            out.push('"');
            continue;
        }
        out.push(ch);
        i += 1;
    }
    (out, block)
}

/// Identifier following `keyword` (`package`/`class`/…): the word after it, skipping whitespace.
fn keyword_name(code: &str, keywords: &[&str]) -> Option<String> {
    let chars: Vec<char> = code.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if !is_ident(chars[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && is_ident(chars[i]) {
            i += 1;
        }
        let word: String = chars[start..i].iter().collect();
        if !keywords.contains(&word.as_str()) || i == start {
            continue;
        }
        let mut j = i;
        while j < chars.len() && chars[j].is_whitespace() {
            j += 1;
        }
        let name_start = j;
        while j < chars.len() && is_ident(chars[j]) {
            j += 1;
        }
        if name_start < j {
            return Some(chars[name_start..j].iter().collect());
        }
    }
    None
}

/// Package of a `package com.example;` line, dots included.
fn package_decl(code: &str) -> Option<String> {
    let chars: Vec<char> = code.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if !is_ident(chars[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && is_ident(chars[i]) {
            i += 1;
        }
        if chars[start..i].iter().collect::<String>() != "package" {
            continue;
        }
        let mut j = i;
        while j < chars.len() && chars[j].is_whitespace() {
            j += 1;
        }
        let name_start = j;
        while j < chars.len() {
            let c = chars[j];
            if is_ident(c) || c == '.' {
                j += 1;
            } else {
                break;
            }
        }
        let name: String = chars[name_start..j].iter().collect();
        if !name.is_empty() {
            return Some(name.trim_end_matches('.').to_owned());
        }
    }
    None
}

/// Fully qualified package + enclosing type chain (outermost first) at `line`.
fn enclosing_types(lines: &[&str], line: usize) -> Option<(String, Vec<String>)> {
    if lines.is_empty() {
        return None;
    }
    let mut package = String::new();
    let mut stack: Vec<Option<String>> = Vec::new();
    let mut pending: Option<String> = None;
    let mut block = false;
    for text in lines.iter().take(line.min(lines.len() - 1) + 1) {
        let (code, next_block) = code_only(text, block);
        block = next_block;
        if let Some(p) = package_decl(&code) {
            package = p;
        }
        if let Some(name) = keyword_name(&code, TYPE_KEYWORDS) {
            pending = Some(name);
        }
        for ch in code.chars() {
            match ch {
                '{' => stack.push(pending.take()),
                '}' => {
                    stack.pop();
                }
                _ => {}
            }
        }
    }
    let types: Vec<String> = stack.into_iter().flatten().collect();
    if types.is_empty() { None } else { Some((package, types)) }
}

/// Declarations (`void foo(`) with their identifier index; calls are filtered later.
fn call_or_decl(code: &str) -> Vec<(String, usize)> {
    let chars: Vec<char> = code.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if !is_ident(chars[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && is_ident(chars[i]) {
            i += 1;
        }
        let mut j = i;
        while j < chars.len() && chars[j].is_whitespace() {
            j += 1;
        }
        if chars.get(j) == Some(&'(') {
            out.push((chars[start..i].iter().collect(), start));
        }
    }
    out
}

/// True when `name` at `index` is in a declaration-like context (`void foo(`), not a call.
fn looks_like_declaration(code: &str, index: usize) -> bool {
    let before: String = code.chars().take(index).collect();
    let before = before.trim_end();
    let Some(last) = before.chars().last() else { return false };
    if !(last.is_ascii_alphanumeric() || matches!(last, '_' | '$' | '>' | ']')) {
        return false;
    }
    let token = before.split([' ', '\t', '(']).next_back().unwrap_or("");
    !token.is_empty() && !NOT_A_METHOD.contains(&token)
}

/// Nearest method declaration at or above `line`; constructors become `<init>`.
fn method_at(lines: &[&str], line: usize, innermost_type: &str) -> Option<String> {
    if lines.is_empty() {
        return None;
    }
    let mut i = line.min(lines.len() - 1);
    loop {
        let (code, _) = code_only(lines[i], false);
        let mut method: Option<String> = None;
        for (name, index) in call_or_decl(&code) {
            if NOT_A_METHOD.contains(&name.as_str()) || !looks_like_declaration(&code, index) {
                continue;
            }
            method = Some(name);
        }
        if let Some(name) = method {
            return Some(if name == innermost_type { "<init>".to_owned() } else { name });
        }
        if i == 0 {
            return None;
        }
        i -= 1;
    }
}

/// Resolves the class and method to target from the document text and 0-based caret line.
pub fn target(text: &str, line: usize) -> Option<Target> {
    let lines: Vec<&str> = text.split('\n').collect();
    let (package, types) = enclosing_types(&lines, line)?;
    let nested = types.join("$");
    let class_name = if package.is_empty() { nested } else { format!("{package}.{nested}") };
    let innermost = types.last()?;
    let method = method_at(&lines, line, innermost)?;
    Some(Target { class_name, method })
}

/// The command line to paste into an attached Arthas console.
pub fn command(kind: Kind, target: &Target) -> String {
    let base = format!("{} {}", target.class_name, target.method);
    match kind {
        Kind::Watch => format!("watch {base} '{{params, returnObj, throwException}}' -x 3"),
        Kind::Trace => format!("trace {base} -n 5"),
        Kind::Monitor => format!("monitor -c 5 {base}"),
        Kind::Stack => format!("stack {base}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIMPLE: &str = "package com.example.demo;\n\npublic class OrderService {\n    public Order create(String id) {\n        if (id == null) {\n            return null;\n        }\n        return new Order(id);\n    }\n}";
    const NESTED: &str = "package com.example.demo;\n\npublic class Outer {\n    static class Inner {\n        void run() {\n            System.out.println(\"{}\");\n        }\n    }\n}";
    const CONSTRUCTOR: &str = "package com.example.demo;\n\npublic class Foobar {\n    public Foobar(int size) {\n        this.size = size;\n    }\n}";

    fn line_of(text: &str, needle: &str) -> usize {
        text.split('\n').position(|l| l.contains(needle)).unwrap()
    }

    #[test]
    fn resolves_package_class_and_method() {
        let t = target(SIMPLE, line_of(SIMPLE, "return null")).unwrap();
        assert_eq!(t.class_name, "com.example.demo.OrderService");
        assert_eq!(t.method, "create");
    }

    #[test]
    fn joins_nested_types_with_dollar() {
        let t = target(NESTED, line_of(NESTED, "System.out")).unwrap();
        assert_eq!(t.class_name, "com.example.demo.Outer$Inner");
        assert_eq!(t.method, "run");
    }

    #[test]
    fn maps_constructors_to_init() {
        let t = target(CONSTRUCTOR, line_of(CONSTRUCTOR, "this.size")).unwrap();
        assert_eq!(t.class_name, "com.example.demo.Foobar");
        assert_eq!(t.method, "<init>");
    }

    #[test]
    fn ignores_braces_in_strings_and_comments() {
        assert_eq!(target(NESTED, line_of(NESTED, "System.out")).unwrap().class_name, "com.example.demo.Outer$Inner");
        assert!(target(SIMPLE, SIMPLE.split('\n').count() - 1).is_none());
    }

    #[test]
    fn none_outside_a_type() {
        assert!(target("package com.example.demo;\n", 0).is_none());
    }

    #[test]
    fn builds_the_four_commands() {
        let t = Target { class_name: "com.example.demo.OrderService".into(), method: "create".into() };
        assert_eq!(
            command(Kind::Watch, &t),
            "watch com.example.demo.OrderService create '{params, returnObj, throwException}' -x 3"
        );
        assert_eq!(command(Kind::Trace, &t), "trace com.example.demo.OrderService create -n 5");
        assert_eq!(command(Kind::Monitor, &t), "monitor -c 5 com.example.demo.OrderService create");
        assert_eq!(command(Kind::Stack, &t), "stack com.example.demo.OrderService create");
    }
}
