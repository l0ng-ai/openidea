//! Name suggestions for Extract variable / constant, after IDEA and the
//! frontend's `src/editor/refactor/names.ts` (the same conventions, read
//! from the syntax tree instead of the text): from the callee
//! (`getUser()` → `user`), the instantiated class (`new StringBuilder()` →
//! `stringBuilder`, `builder`), the accessed property or variable, the
//! literal kind (`s`, `i`, `b`…). Variables are camelCase, constants
//! UPPER_SNAKE_CASE.

use mago_syntax::cst::{
    Access, ArrayAccess, Binary, Call, ClassLikeConstantSelector, ClassLikeMemberSelector, CompositeString, Construct,
    Expression, Identifier, Literal, Variable,
};

const KEYWORDS: &str = "abstract and as assert async await begin bool boolean break byte case catch char class const \
continue def default defer del delete do double elif else elsif end ensure enum except export extends extern false \
final finally float fn for from func function global go goto if impl import in instanceof int interface is lambda let \
local long loop match mod module mut native new nil none not null of or package pass private protected public raise \
rescue return self short static struct super switch synchronized then this throw throws trait true try typeof \
undefined unless until use val var void volatile when where while with yield";

const STRIP_PREFIXES: [&str; 13] =
    ["get", "to", "as", "create", "new", "make", "build", "find", "fetch", "load", "read", "compute", "calculate"];
const BOOL_PREFIXES: [&str; 4] = ["is", "has", "can", "should"];

pub(crate) fn is_keyword(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    KEYWORDS.split(' ').any(|k| k == lower)
}

/// PHP's reserved words that [`KEYWORDS`] misses: not valid constant
/// names (variables may use them).
const RESERVED: [&str; 16] = [
    "array", "callable", "clone", "die", "echo", "empty", "eval", "exit", "include", "isset", "list", "print",
    "require", "unset", "parent", "xor",
];

fn is_reserved(name: &str) -> bool {
    RESERVED.iter().any(|r| r.eq_ignore_ascii_case(name))
}

pub(crate) fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `getUserName` / `get_user_name` / `UserName` → `["get", "user", "name"]`.
pub(crate) fn split_words(identifier: &str) -> Vec<String> {
    let chars: Vec<char> = identifier.trim_start_matches(['$', '@']).chars().collect();
    let mut words: Vec<String> = Vec::new();
    let mut current = String::new();
    for (i, &c) in chars.iter().enumerate() {
        if c == '_' || c == '-' || c.is_whitespace() {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            continue;
        }
        if c.is_ascii_uppercase() && !current.is_empty() {
            let prev = chars[i - 1];
            let next_lower = chars.get(i + 1).is_some_and(|n| n.is_ascii_lowercase());
            // `userName` → `user|Name`, `HTTPServer` → `HTTP|Server`.
            if prev.is_ascii_lowercase() || prev.is_ascii_digit() || (prev.is_ascii_uppercase() && next_lower) {
                words.push(std::mem::take(&mut current));
            }
        }
        current.push(c);
    }
    if !current.is_empty() {
        words.push(current);
    }
    words.into_iter().map(|w| w.to_lowercase()).collect()
}

fn join(words: &[String], constant: bool) -> String {
    if constant {
        return words.iter().map(|w| w.to_uppercase()).collect::<Vec<_>>().join("_");
    }
    words
        .iter()
        .enumerate()
        .map(|(i, w)| {
            if i == 0 {
                w.clone()
            } else {
                let mut chars = w.chars();
                chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
            }
        })
        .collect()
}

/// Every suffix of the word list, longest first.
fn suffixes(words: &[String]) -> Vec<Vec<String>> {
    (0..words.len()).map(|i| words[i..].to_vec()).collect()
}

fn singular(word: &str) -> Option<String> {
    if let Some(stem) = word.strip_suffix("ies") {
        return Some(format!("{stem}y"));
    }
    if word.ends_with("ss") || word.ends_with("us") {
        return None;
    }
    for ending in ["shes", "ches", "xes"] {
        if word.ends_with(ending) {
            return Some(word[..word.len() - 2].to_owned());
        }
    }
    if word.len() > 2
        && let Some(stem) = word.strip_suffix('s')
    {
        return Some(stem.to_owned());
    }
    None
}

fn words(list: &[&str]) -> Vec<String> {
    list.iter().map(|w| (*w).to_owned()).collect()
}

fn utf8(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn short(identifier: &Identifier<'_>) -> String {
    let name = utf8(identifier.value());
    name.rsplit('\\').next().unwrap_or_default().to_owned()
}

/// The name a receiver reads as: `$users` → `users`, `$this->items` →
/// `items`, `Foo\Bar` → `Bar`.
fn receiver_name(expr: &Expression<'_>) -> Option<String> {
    match expr {
        Expression::Parenthesized(inner) => receiver_name(inner.expression),
        Expression::Variable(Variable::Direct(var)) => {
            Some(utf8(var.name.strip_prefix(b"$").unwrap_or(var.name))).filter(|n| n != "this")
        }
        Expression::Identifier(identifier) => Some(short(identifier)),
        Expression::Access(Access::Property(access)) => member_name(&access.property),
        Expression::Access(Access::NullSafeProperty(access)) => member_name(&access.property),
        Expression::Access(Access::StaticProperty(access)) => match &access.property {
            Variable::Direct(var) => Some(utf8(var.name.strip_prefix(b"$").unwrap_or(var.name))),
            _ => None,
        },
        _ => None,
    }
}

fn member_name(selector: &ClassLikeMemberSelector<'_>) -> Option<String> {
    match selector {
        ClassLikeMemberSelector::Identifier(identifier) => Some(utf8(identifier.value)),
        _ => None,
    }
}

fn bool_words() -> Vec<Vec<String>> {
    vec![words(&["b"]), words(&["flag"])]
}

/// Word lists, best first.
fn candidates(expr: &Expression<'_>) -> Vec<Vec<String>> {
    match expr {
        Expression::Parenthesized(inner) => candidates(inner.expression),
        Expression::Clone(clone) => candidates(clone.object),
        Expression::UnaryPrefix(unary) if unary.operator.is_error_control() => candidates(unary.operand),
        Expression::UnaryPrefix(unary) if unary.operator.is_not() => bool_words(),
        Expression::Literal(Literal::String(string)) => {
            let raw = utf8(string.raw);
            let content = raw.get(1..raw.len().saturating_sub(1)).unwrap_or_default().trim().to_owned();
            let readable = !content.is_empty()
                && content.len() <= 41
                && content.starts_with(|c: char| c.is_ascii_alphabetic())
                && content.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '-'));
            let mut out = Vec::new();
            if readable {
                let split = split_words(&content);
                if !split.is_empty() && split.len() <= 3 {
                    out.push(split);
                }
            }
            out.extend([words(&["s"]), words(&["text"])]);
            out
        }
        Expression::CompositeString(CompositeString::Interpolated(_) | CompositeString::Document(_)) => {
            vec![words(&["s"]), words(&["text"])]
        }
        Expression::Literal(Literal::Integer(_)) => vec![words(&["i"]), words(&["value"])],
        Expression::Literal(Literal::Float(_)) => vec![words(&["value"]), words(&["v"])],
        Expression::Literal(Literal::True(_) | Literal::False(_)) => bool_words(),
        Expression::ConstantAccess(access)
            if ["true", "false"].iter().any(|b| access.name.value().eq_ignore_ascii_case(b.as_bytes())) =>
        {
            bool_words()
        }
        Expression::Array(_) | Expression::LegacyArray(_) => vec![words(&["list"]), words(&["items"])],
        Expression::Closure(_) | Expression::ArrowFunction(_) => vec![words(&["fn"]), words(&["callback"])],
        Expression::Construct(Construct::Isset(_) | Construct::Empty(_)) => bool_words(),
        Expression::Instantiation(new) => match new.class {
            Expression::Identifier(identifier) => {
                let split: Vec<String> = split_words(&short(identifier)).into_iter().filter(|w| w != "new").collect();
                if split.is_empty() { vec![words(&["value"])] } else { suffixes(&split) }
            }
            _ => vec![words(&["value"])],
        },
        Expression::Call(call) => call_candidates(call),
        Expression::ArrayAccess(ArrayAccess { array, .. }) => {
            let mut out = Vec::new();
            if let Some(sing) =
                receiver_name(array).and_then(|base| split_words(&base).pop()).and_then(|w| singular(&w))
            {
                out.push(vec![sing]);
            }
            out.extend([words(&["item"]), words(&["element"])]);
            out
        }
        Expression::Binary(Binary { operator, .. })
            if operator.is_comparison()
                || operator.is_equality()
                || operator.is_identity()
                || operator.is_logical()
                || operator.is_instanceof() =>
        {
            bool_words()
        }
        Expression::Binary(Binary { operator, .. }) if operator.is_concatenation() => {
            vec![words(&["s"]), words(&["text"])]
        }
        Expression::Variable(_) | Expression::Access(_) => {
            let name = match expr {
                Expression::Access(Access::ClassConstant(access)) => match &access.constant {
                    ClassLikeConstantSelector::Identifier(identifier) => Some(utf8(identifier.value)),
                    _ => None,
                },
                _ => receiver_name(expr),
            };
            let split = name.map(|n| split_words(&n)).unwrap_or_default();
            let mut out = if split.len() > 1 && STRIP_PREFIXES.contains(&split[0].as_str()) {
                suffixes(&split[1..])
            } else {
                suffixes(&split)
            };
            out.push(words(&["value"]));
            out
        }
        _ => vec![words(&["value"])],
    }
}

fn call_candidates(call: &Call<'_>) -> Vec<Vec<String>> {
    let (name, receiver) = match call {
        Call::Function(call) => match call.function {
            Expression::Identifier(identifier) => (Some(short(identifier)), None),
            _ => (None, None),
        },
        Call::Method(call) => (member_name(&call.method), Some(call.object)),
        Call::NullSafeMethod(call) => (member_name(&call.method), Some(call.object)),
        Call::StaticMethod(call) => (member_name(&call.method), Some(call.class)),
    };
    let Some(name) = name else { return vec![words(&["value"])] };
    let split = split_words(&name);
    let mut out = Vec::new();
    let first = split.first().map(String::as_str).unwrap_or_default();
    if split.len() > 1 && BOOL_PREFIXES.contains(&first) {
        out.extend(suffixes(&split[1..]));
        out.push(split.clone());
    } else if split.len() > 1 && STRIP_PREFIXES.contains(&first) {
        out.extend(suffixes(&split[1..]));
    } else if split.len() == 1 && (STRIP_PREFIXES.contains(&first) || first == "new") {
        // `$users->find(1)`, `Foo::create()`: named after the receiver.
        let receiver = receiver.and_then(receiver_name);
        let sing = receiver.as_deref().and_then(|r| split_words(r).pop()).and_then(|w| singular(&w));
        if let Some(sing) = sing {
            out.push(vec![sing]);
        } else if let Some(receiver) = receiver.filter(|r| r.starts_with(|c: char| c.is_ascii_uppercase())) {
            out.extend(suffixes(&split_words(&receiver)));
        } else if !["get", "new", "to", "as"].contains(&first) {
            out.push(split.clone());
        }
    } else {
        out.extend(suffixes(&split));
    }
    out.push(words(&["value"]));
    out
}

/// Suggested names, best first and distinct; at least one. Keywords and
/// non-identifiers are dropped; `constant` gives UPPER_SNAKE_CASE.
pub(crate) fn suggest(expr: &Expression<'_>, constant: bool) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for words in candidates(expr) {
        if words.is_empty() {
            continue;
        }
        let name = join(&words, constant);
        if !is_identifier(&name) || is_keyword(&name) || (constant && is_reserved(&name)) || out.contains(&name) {
            continue;
        }
        out.push(name);
    }
    if out.is_empty() {
        out.push(if constant { "VALUE" } else { "value" }.to_owned());
    }
    out
}

/// The first suggestion `taken` doesn't report as used; when all are,
/// the first one numbered (`user1`, `user2`…).
pub(crate) fn unique(names: &[String], taken: impl Fn(&str) -> bool) -> String {
    if let Some(free) = names.iter().find(|n| !taken(n)) {
        return free.clone();
    }
    let base = &names[0];
    (1..1000).map(|i| format!("{base}{i}")).find(|n| !taken(n)).unwrap_or_else(|| base.clone())
}
