//! Decodes the recorder list read back from the debuggee and the E1 evaluate result (spec §10).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::generate::TracePlan;
use crate::model::{BoxKind, Record, StepKind, TraceValue};
use crate::resolve::sorted_pass_through;

/// The recorder list as read from the debuggee.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    /// Alternating marker and value; may be shorter than `total_len` when reading was cut off.
    pub entries: Vec<TraceValue>,
    /// The list's real `size()`.
    pub total_len: usize,
}

/// DAP `evaluate` body of E1: `type` and `result`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct E1Value {
    pub type_name: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DecodedTrace {
    pub records: Vec<Record>,
    pub outcome: Outcome,
    pub banners: Vec<Banner>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Outcome {
    /// `result` is `None` when the recording was cut off before the terminator.
    Completed {
        result: Option<TraceValue>,
    },
    Threw {
        message: String,
    },
    BudgetExceeded,
    WrongThread,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Banner {
    /// `count()` on a sized source skips the pipeline, so nothing was recorded.
    CountFromSize,
    SortedPassThrough {
        step: u16,
    },
    /// Only `read` of `total` list entries could be read back.
    Truncated {
        read: usize,
        total: usize,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DecodeError {
    /// `at` is the index of the offending list entry.
    #[error("malformed recording at entry {at}")]
    Malformed { at: usize },
}

/// A marker value of `-1` closes a complete recording.
const TERMINATOR: i32 = -1;

/// A truncated recording is cut by reading limits, so it ends mid-list and its outcome
/// comes from `e1` alone.
pub fn decode(plan: &TracePlan, recording: &Recording, e1: &E1Value) -> Result<DecodedTrace, DecodeError> {
    let entries = &recording.entries;
    let truncated = entries.len() < recording.total_len;
    let usable = if truncated { entries.len() & !1 } else { entries.len() };

    let mut records = Vec::with_capacity(usable / 2);
    let mut result = None;
    for (n, pair) in entries[..usable].chunks_exact(2).enumerate() {
        let at = n * 2;
        match marker(&pair[0], plan.steps.len()).ok_or(DecodeError::Malformed { at })? {
            Marker::Step(step) => records.push(Record { step, value: pair[1].clone() }),
            // The terminator is the last list entry pair, and a truncated list never reaches its end.
            Marker::End if !truncated && at + 2 == entries.len() => result = Some(pair[1].clone()),
            Marker::End => return Err(DecodeError::Malformed { at: if truncated { at } else { at + 2 } }),
        }
    }
    if !truncated && usable % 2 == 1 {
        return Err(DecodeError::Malformed { at: usable - 1 });
    }

    let mut banners = Vec::new();
    if truncated {
        banners.push(Banner::Truncated { read: usable, total: recording.total_len });
    }
    let outcome = match result {
        Some(result) => Outcome::Completed { result: Some(result) },
        None => unfinished_outcome(plan, e1, truncated),
    };
    if matches!(outcome, Outcome::Completed { .. })
        && plan.terminal == "count"
        && plan.steps.len() > 1
        && records.is_empty()
    {
        banners.push(Banner::CountFromSize);
    }
    for step in plan.steps.iter().filter(|s| s.kind == StepKind::Reorder) {
        if sorted_pass_through(&records, step.index) {
            banners.push(Banner::SortedPassThrough { step: step.index });
        }
    }
    Ok(DecodedTrace { records, outcome, banners })
}

enum Marker {
    Step(u16),
    End,
}

fn marker(value: &TraceValue, steps: usize) -> Option<Marker> {
    let TraceValue::Boxed { class: BoxKind::Int, value, .. } = value else {
        return None;
    };
    match value.parse::<i32>().ok()? {
        TERMINATOR => Some(Marker::End),
        k => usize::try_from(k).ok().filter(|&k| k < steps).map(|k| Marker::Step(k as u16)),
    }
}

/// The outcome when the recording has no usable terminator. The recorder's own
/// messages are matched with `contains` because ForkJoin wraps exceptions thrown in
/// parallel streams.
fn unfinished_outcome(plan: &TracePlan, e1: &E1Value, truncated: bool) -> Outcome {
    if e1.text.contains(&format!("oi-budget:{}", plan.nonce)) {
        Outcome::BudgetExceeded
    } else if e1.text.contains(&format!("oi-thread:{}", plan.nonce)) {
        Outcome::WrongThread
    } else if !truncated || is_throwable(&e1.type_name) {
        Outcome::Threw { message: exception_message(&e1.text) }
    } else {
        Outcome::Completed { result: None }
    }
}

fn is_throwable(type_name: &str) -> bool {
    type_name.ends_with("Exception") || type_name.ends_with("Error") || type_name == "Throwable"
}

/// The quoted detail of a `Type@id "…"` rendering, else the text unchanged.
fn exception_message(text: &str) -> String {
    let quoted = text.find('"').and_then(|first| {
        let (head, rest) = text.split_at(first);
        let object_ref = head.trim_end().rsplit_once('@').is_some_and(|(ty, id)| {
            !ty.is_empty()
                && !ty.contains(char::is_whitespace)
                && !id.is_empty()
                && id.bytes().all(|b| b.is_ascii_digit())
        });
        let last = rest.rfind('"')?;
        (object_ref && last > 0).then(|| rest[1..last].to_string())
    });
    quoted.unwrap_or_else(|| text.to_string())
}

/// Why JDT's evaluator refused an expression, from its error message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum EvalFailure {
    /// The evaluator cannot parse a generic type in a captured declaration.
    GenericCapture,
    /// JDT fails on an unqualified static call from a frame without a module.
    UnqualifiedStatic,
    /// Lambdas cannot be compiled inside local or anonymous classes.
    UnsupportedFrame,
    NotVisible {
        member: String,
    },
    UnresolvedName {
        name: String,
    },
    Other {
        message: String,
    },
}

pub fn classify_eval_error(message: &str) -> EvalFailure {
    if message.contains("<java cannot be resolved to a type") {
        return EvalFailure::GenericCapture;
    }
    if message.contains("ModuleBinding.canAccess") {
        return EvalFailure::UnqualifiedStatic;
    }
    if message.contains("Functional expressions cannot be evaluated inside local and or anonymous classes") {
        return EvalFailure::UnsupportedFrame;
    }
    if let Some(member) = not_visible_member(message) {
        return EvalFailure::NotVisible { member };
    }
    if let Some(name) = unresolved_name(message) {
        return EvalFailure::UnresolvedName { name };
    }
    EvalFailure::Other { message: message.to_string() }
}

fn not_visible_member(message: &str) -> Option<String> {
    let (_, rest) = message.split_once("The method ")?;
    let (member, rest) = rest.split_once('(')?;
    (rest.contains(") from the type ") && rest.contains(" is not visible") && !member.is_empty())
        .then(|| member.to_string())
}

fn unresolved_name(message: &str) -> Option<String> {
    let head = &message[..message.find(" cannot be resolved")?];
    let name = head.rsplit(|c: char| c.is_whitespace() || c == '[').next()?;
    (!name.is_empty()).then(|| name.to_string())
}
