//! Parameter info and inlay hints.
//!
//! - [`PhpEngine::signature_help`]: the signature of the function, method or
//!   constructor call the caret is in, with the active parameter (the one a
//!   named argument names, else the argument's position, the variadic
//!   parameter for the rest). The call is found in the text (the innermost
//!   `(` not closed before the caret, with commas counted at its level) and
//!   typed in a copy of the file where the unfinished call is closed, as
//!   completion probes it.
//! - [`PhpEngine::inlay_hints`] ([`inlay`]): parameter names before literal
//!   arguments, and the types of variables and closure returns that the
//!   code doesn't spell out.
//!
//! The callee of a call ([`callee`]) and its parameters ([`callee_params`])
//! are shared with completion's named arguments.

mod inlay;
#[cfg(test)]
mod tests;

pub use inlay::{InlayHintInfo, InlayHintKind};

use ide_core::{DocId, Pos};
use mago_span::HasSpan;
use mago_syntax::cst::{Argument, ArgumentList, Call, ClassLikeMemberSelector, Expression};
use mago_syntax::walker::Walker;

use crate::engine::PhpEngine;
use crate::names::{FileNames, NameKind};
use crate::navigate::hover::{method_defaults, signature_param_text};
use crate::navigate::short_name;
use crate::navigate::symbol::{Member, MemberKind};
use crate::summary::FileSummary;
use crate::syntax::ParsedFile;
use crate::types::{Context, ExprTypes, Frame, Resolver, SignatureParam, Type};

/// What a call calls.
pub(crate) enum Callee {
    Function(String),
    /// A method; `__construct` for `new`.
    Method {
        receiver: Type,
        name: String,
    },
}

/// The argument list of a call or `new`.
pub(crate) fn argument_list<'a>(call: &'a Expression<'a>) -> Option<&'a ArgumentList<'a>> {
    match call {
        Expression::Call(Call::Function(call)) => Some(&call.argument_list),
        Expression::Call(Call::Method(call)) => Some(&call.argument_list),
        Expression::Call(Call::NullSafeMethod(call)) => Some(&call.argument_list),
        Expression::Call(Call::StaticMethod(call)) => Some(&call.argument_list),
        Expression::Instantiation(instantiation) => instantiation.argument_list.as_ref(),
        _ => None,
    }
}

pub(crate) fn method_name(selector: &ClassLikeMemberSelector<'_>) -> Option<String> {
    match selector {
        ClassLikeMemberSelector::Identifier(name) => Some(String::from_utf8_lossy(name.value).into_owned()),
        _ => None,
    }
}

/// The callee of `call` (inside `frames`): a function by its FQN (the
/// namespaced one when it exists, else the global fallback), or a method on
/// the receiver's type.
pub(crate) fn callee<'a>(
    types: &ExprTypes<'a, '_>,
    names: &FileNames,
    resolver: &Resolver<'_>,
    call: &'a Expression<'a>,
    frames: &[Frame<'a>],
) -> Option<Callee> {
    match call {
        Expression::Call(Call::Function(call)) => match call.function {
            Expression::Identifier(identifier) => {
                let name = String::from_utf8_lossy(identifier.value()).into_owned();
                let resolved = names.scope_at(identifier.span().start.offset).resolve(NameKind::Function, &name);
                let candidates: Vec<String> = resolved.resolution.candidates().map(str::to_owned).collect();
                let fqn = candidates
                    .iter()
                    .find(|fqn| resolver.declarations().function(fqn).is_some())
                    .or(candidates.first())
                    .cloned();
                fqn.map(Callee::Function)
            }
            _ => None,
        },
        Expression::Call(Call::Method(call)) => {
            method_name(&call.method).map(|name| Callee::Method { receiver: types.type_of(call.object, frames), name })
        }
        Expression::Call(Call::NullSafeMethod(call)) => method_name(&call.method)
            .map(|name| Callee::Method { receiver: types.type_of(call.object, frames).without_null(), name }),
        Expression::Call(Call::StaticMethod(call)) => {
            method_name(&call.method).map(|name| Callee::Method { receiver: types.class_ref(call.class, frames), name })
        }
        Expression::Instantiation(instantiation) => Some(Callee::Method {
            receiver: types.class_ref(instantiation.class, frames),
            name: "__construct".to_owned(),
        }),
        _ => None,
    }
}

/// The parameters of `callee` (methods bound to the receiver's generic
/// arguments); empty when it isn't known.
pub(crate) fn callee_params(
    resolver: &Resolver<'_>,
    here: &FileSummary,
    callee: &Callee,
    context: &Context,
) -> Vec<SignatureParam> {
    match callee {
        Callee::Function(fqn) => resolver
            .declarations()
            .function(fqn)
            .or_else(|| here.function(fqn).cloned())
            .map(|function| {
                let doc = function.doc.as_deref();
                let templates: Vec<&str> = doc.iter().flat_map(|doc| doc.local_type_names()).collect();
                crate::types::resolve::declared_params(&function.params, doc, &templates)
            })
            .unwrap_or_default(),
        Callee::Method { receiver, name } => resolver.method_params_on(receiver, name, context).unwrap_or_default(),
    }
}

/// The parameter argument `index` of `list` goes to: the one a named
/// argument names, else the one at its position (the variadic parameter
/// for the rest). `None` when there is none.
pub(crate) fn parameter_index(params: &[SignatureParam], list: &ArgumentList<'_>, index: usize) -> Option<usize> {
    if let Some(Argument::Named(named)) = list.arguments.get(index) {
        let name = String::from_utf8_lossy(named.name.value);
        return params.iter().position(|param| param.name.as_deref() == Some(&*name));
    }
    if index < params.len() {
        return Some(index);
    }
    params.last().filter(|param| param.variadic).map(|_| params.len() - 1)
}

// ------------------------------------------------------------ signature help

/// One signature: a label like `checkout(string $isbn): Book`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignatureInfo {
    pub label: String,
    /// The docblock as Markdown (inherited ones included), as hover shows it.
    pub documentation: Option<String>,
    /// The UTF-16 range of each parameter in `label`.
    pub parameters: Vec<(u32, u32)>,
}

/// The answer to a signature help request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignatureHelpInfo {
    pub signatures: Vec<SignatureInfo>,
    /// Out of range when the argument goes to no parameter.
    pub active_parameter: u32,
}

impl PhpEngine {
    /// Signature help at `pos` of an open document: `None` when the engine
    /// doesn't hold it or the caret isn't in the arguments of a call it
    /// knows.
    pub fn signature_help(&self, doc: DocId, pos: Pos) -> Option<SignatureHelpInfo> {
        let parsed = self.parsed_document(doc)?;
        let path = self.document_path(doc)?;
        let offset = parsed.line_index().byte(pos) as usize;
        let open = open_call(parsed.text().as_bytes(), offset)?;
        let probe = ParsedFile::parse("signature.php", open.probe_text(parsed.text(), offset));
        let names = FileNames::resolve(&probe);
        let here = FileSummary::extract(&probe);
        let resolver = self.resolver();
        let types = ExprTypes::new(&probe, &names, &here, &resolver);
        let mut finder = CallFinder { paren: open.paren as u32, call: None };
        CallWalker.walk_program(probe.program(), &mut finder);
        let call = finder.call?;
        let list = argument_list(call)?;
        let frames = types.locate(call.span().start.offset).expression.map(|(_, f)| f).unwrap_or_default();
        let context = types.context(&frames);
        let callee = callee(&types, &names, &resolver, call, &frames)?;
        let (signature, params) = match &callee {
            Callee::Function(fqn) => {
                let (path, function) = self.function_source(fqn, &path, &here)?;
                let doc = function.doc.as_deref();
                let templates: Vec<&str> = doc.iter().flat_map(|doc| doc.local_type_names()).collect();
                let params = crate::types::resolve::declared_params(&function.params, doc, &templates);
                let defaults: Vec<(String, String)> =
                    function.params.iter().filter_map(|p| Some((p.name.clone(), p.default.clone()?))).collect();
                let returns = resolver.function_return(fqn).unwrap_or(Type::Mixed);
                let documentation = self.doc_text(&path, function.loc.start).map(|doc| doc.markdown());
                (signature(&function.name, &params, &defaults, Some(&returns), documentation), params)
            }
            Callee::Method { receiver, name } => {
                let model =
                    resolver.class_models(receiver, &context).into_iter().find(|model| model.method(name).is_some())?;
                let method = model.method(name)?;
                let params = resolver.method_params_on(receiver, name, &context).unwrap_or_default();
                let defaults = method_defaults(method);
                let constructor = name.eq_ignore_ascii_case("__construct");
                let label = if constructor { short_name(model.fqn()).to_owned() } else { method.name.clone() };
                let returns = resolver.method_return(receiver, name, &context);
                let member = Member {
                    kind: MemberKind::Method,
                    model: model.clone(),
                    name: name.clone(),
                    receiver: receiver.clone(),
                    context: context.clone(),
                    ty: returns.clone(),
                };
                let documentation = self.member_doc(&member, &resolver, &path, &here).map(|doc| doc.markdown());
                let returns = (!constructor).then_some(&returns);
                (signature(&label, &params, &defaults, returns, documentation), params)
            }
        };
        let active = parameter_index(&params, list, open.commas).unwrap_or(params.len());
        Some(SignatureHelpInfo { signatures: vec![signature], active_parameter: active as u32 })
    }
}

/// `name(T $a, U $b = 1): R` with the UTF-16 range of each parameter.
fn signature(
    name: &str,
    params: &[SignatureParam],
    defaults: &[(String, String)],
    returns: Option<&Type>,
    documentation: Option<String>,
) -> SignatureInfo {
    let utf16 = |text: &str| text.encode_utf16().count() as u32;
    let mut label = format!("{name}(");
    let mut ranges = Vec::new();
    for (i, param) in params.iter().enumerate() {
        if i > 0 {
            label.push_str(", ");
        }
        let default = defaults
            .iter()
            .find(|(name, _)| Some(name.as_str()) == param.name.as_deref())
            .map(|(_, default)| default.as_str());
        let start = utf16(&label);
        label.push_str(&signature_param_text(param, default));
        ranges.push((start, utf16(&label)));
    }
    label.push(')');
    if let Some(returns) = returns {
        label.push_str(&format!(": {returns}"));
    }
    SignatureInfo { label, documentation: documentation.filter(|d| !d.trim().is_empty()), parameters: ranges }
}

/// Finds the call whose argument list opens at `paren`.
struct CallFinder<'a> {
    paren: u32,
    call: Option<&'a Expression<'a>>,
}

struct CallWalker;

impl<'a> Walker<'a, 'a, CallFinder<'a>> for CallWalker {
    fn walk_in_expression(&self, expr: &'a Expression<'a>, cx: &mut CallFinder<'a>) {
        if cx.call.is_none() && argument_list(expr).is_some_and(|list| list.left_parenthesis.start.offset == cx.paren) {
            cx.call = Some(expr);
        }
    }
}

// --------------------------------------------------------------- text scan

/// Words before `(` that don't make a call.
const NOT_CALLS: &[&str] = &[
    "if",
    "elseif",
    "while",
    "for",
    "foreach",
    "switch",
    "match",
    "catch",
    "function",
    "fn",
    "array",
    "list",
    "isset",
    "empty",
    "unset",
    "eval",
    "exit",
    "die",
    "declare",
    "use",
    "class",
    "return",
    "echo",
    "print",
    "and",
    "or",
    "xor",
    "include",
    "require",
    "include_once",
    "require_once",
    "new",
    "clone",
    "yield",
    "throw",
    "case",
    "else",
    "do",
];

fn is_ident(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte >= 0x80
}

/// What the lexer is in.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Lex {
    Code,
    /// A string opened by this quote.
    Quoted(u8),
    LineComment,
    BlockComment,
}

/// Steps over byte `i` in state `state`: the next index and state, and the
/// byte when it is code (outside strings and comments).
fn step(bytes: &[u8], i: usize, state: Lex) -> (usize, Lex, Option<u8>) {
    let byte = bytes[i];
    let next = bytes.get(i + 1).copied();
    match state {
        Lex::Code => match byte {
            b'\'' | b'"' | b'`' => (i + 1, Lex::Quoted(byte), None),
            b'#' if next != Some(b'[') => (i + 1, Lex::LineComment, None),
            b'/' if next == Some(b'/') => (i + 2, Lex::LineComment, None),
            b'/' if next == Some(b'*') => (i + 2, Lex::BlockComment, None),
            _ => (i + 1, Lex::Code, Some(byte)),
        },
        Lex::Quoted(_) if byte == b'\\' => (i + 2, state, None),
        Lex::Quoted(quote) if byte == quote => (i + 1, Lex::Code, None),
        Lex::Quoted(_) => (i + 1, state, None),
        Lex::LineComment if byte == b'\n' => (i + 1, Lex::Code, None),
        Lex::LineComment if byte == b'?' && next == Some(b'>') => (i, Lex::Code, None),
        Lex::LineComment => (i + 1, state, None),
        Lex::BlockComment if byte == b'*' && next == Some(b'/') => (i + 2, Lex::Code, None),
        Lex::BlockComment => (i + 1, state, None),
    }
}

fn closer(open: u8) -> u8 {
    match open {
        b'(' => b')',
        b'[' => b']',
        _ => b'}',
    }
}

/// The call around the caret.
#[derive(Debug, PartialEq, Eq)]
struct OpenCall {
    /// The byte offset of its `(`.
    paren: usize,
    /// The commas at its level before the caret: the argument's position.
    commas: usize,
    /// The string quote the caret is in.
    quote: Option<u8>,
    /// What closes the brackets from the `(` to the caret (innermost
    /// first), when they aren't closed after it.
    closers: Option<String>,
    /// The caret follows an operator: an operand is missing.
    operand_missing: bool,
}

/// The innermost unclosed `(` of a call before `offset` (a `{` in between,
/// a closure body, ends the search).
fn open_call(bytes: &[u8], offset: usize) -> Option<OpenCall> {
    let offset = offset.min(bytes.len());
    // From the last opening tag: the HTML before it is no code.
    let start = bytes[..offset].windows(2).rposition(|w| w == b"<?").map_or(0, |at| at + 2);
    let mut stack: Vec<(u8, usize, usize)> = Vec::new();
    let mut state = Lex::Code;
    let mut i = start;
    while i < offset {
        let (next, after, code) = step(bytes, i, state);
        match code {
            Some(open @ (b'(' | b'[' | b'{')) => stack.push((open, i, 0)),
            Some(b')' | b']' | b'}') => {
                stack.pop();
            }
            Some(b',') => {
                if let Some(top) = stack.last_mut() {
                    top.2 += 1;
                }
            }
            Some(b';') => {
                // A statement ends: only blocks stay open.
                while stack.last().is_some_and(|(open, _, _)| *open != b'{') {
                    stack.pop();
                }
            }
            _ => {}
        }
        state = after;
        i = next;
    }
    let at = stack.iter().rposition(|(open, _, _)| *open != b'[')?;
    let (open, paren, commas) = stack[at];
    if open != b'(' || !is_call_paren(bytes, paren) {
        return None;
    }
    let quote = match state {
        Lex::Quoted(quote) => Some(quote),
        _ => None,
    };
    if matches!(state, Lex::LineComment | Lex::BlockComment) {
        return None;
    }
    // Closed after the caret?
    let mut expected: Vec<u8> = stack[at..].iter().map(|(open, _, _)| closer(*open)).collect();
    let depth = expected.len();
    let mut closed = false;
    let mut i = offset;
    let mut scan = state;
    while i < bytes.len() {
        let (next, after, code) = step(bytes, i, scan);
        match code {
            Some(open @ (b'(' | b'[' | b'{')) => expected.push(closer(open)),
            Some(close @ (b')' | b']' | b'}')) => {
                if expected.last() != Some(&close) {
                    break;
                }
                expected.pop();
                if expected.is_empty() {
                    closed = true;
                    break;
                }
            }
            Some(b';') if expected.len() <= depth => break,
            _ => {}
        }
        if bytes[i..].starts_with(b"?>") && scan == Lex::Code {
            break;
        }
        scan = after;
        i = next;
    }
    let closers = (!closed).then(|| stack[at..].iter().rev().map(|(open, _, _)| closer(*open) as char).collect());
    let before =
        bytes[paren + 1..offset].iter().rposition(|b| !b.is_ascii_whitespace()).map(|at| bytes[paren + 1 + at]);
    let operand_missing = quote.is_none()
        && before.is_some_and(|b| !(b == b'(' || b == b',' || is_ident(b) || matches!(b, b')' | b']' | b'\'' | b'"')));
    Some(OpenCall { paren, commas, quote, closers, operand_missing })
}

/// Whether the `(` at `paren` opens call arguments: a name (not a keyword,
/// not a declared function's), a variable, or a call/index result before it.
fn is_call_paren(bytes: &[u8], paren: usize) -> bool {
    let mut end = paren;
    while end > 0 && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    let Some(&last) = end.checked_sub(1).and_then(|at| bytes.get(at)) else { return false };
    if matches!(last, b')' | b']' | b'}') {
        return true;
    }
    if !is_ident(last) {
        return false;
    }
    let mut start = end;
    while start > 0 && is_ident(bytes[start - 1]) {
        start -= 1;
    }
    let word = String::from_utf8_lossy(&bytes[start..end]).to_ascii_lowercase();
    if start > 0 && bytes[start - 1] == b'$' {
        return true;
    }
    if NOT_CALLS.contains(&word.as_str()) {
        return false;
    }
    // `function name(`: a declaration.
    let mut before = start;
    while before > 0 && bytes[before - 1].is_ascii_whitespace() {
        before -= 1;
    }
    let mut word_start = before;
    while word_start > 0 && is_ident(bytes[word_start - 1]) {
        word_start -= 1;
    }
    let previous = String::from_utf8_lossy(&bytes[word_start..before]).to_ascii_lowercase();
    !matches!(previous.as_str(), "function" | "fn")
}

impl OpenCall {
    /// The file with the call finished at the caret: a missing operand, the
    /// open string and the open brackets closed, and `;` when the statement
    /// looks unfinished.
    fn probe_text(&self, text: &str, offset: usize) -> String {
        let offset = offset.min(text.len());
        let Some(closers) = &self.closers else {
            let filler = if self.operand_missing { crate::complete::PROBE } else { "" };
            return format!("{}{filler}{}", &text[..offset], &text[offset..]);
        };
        let mut out = String::from(&text[..offset]);
        match self.quote {
            Some(quote) => out.push(quote as char),
            None if self.operand_missing => out.push_str(crate::complete::PROBE),
            None => {}
        }
        out.push_str(closers);
        let rest = &text[offset..];
        if !rest.trim_start().starts_with([';', ')', ',', ']']) {
            out.push(';');
        }
        out.push_str(rest);
        out
    }
}
