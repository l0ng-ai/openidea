use crate::qualify::erasure;
use crate::{Adjustment, Capture, ChainWarning, OpRole, Rejection, StreamChain, TextEdit};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;

/// Declared types (Java source text) by `TypeQuery` id, from jdtls hover.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TypeHints(pub HashMap<u32, String>);

/// A chain rewritten into what the JDT evaluator compiles.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedChain {
    /// Statements evaluated before the chain.
    pub prelude: String,
    pub root: String,
    /// The operations in call order, ending with the terminal.
    pub segments: Vec<Segment>,
    pub adjustments: Vec<Adjustment>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    /// Starts with `.`.
    pub text: String,
    pub role: OpRole,
    /// The operation's method name.
    pub label: String,
}

impl NormalizedChain {
    /// The chain as evaluated without recording.
    pub fn plain_text(&self) -> String {
        let mut text = format!("{}{}", self.prelude, self.root);
        for s in &self.segments {
            text.push_str(&s.text);
        }
        text
    }
}

/// The type in jdtls hover text whose first line reads `<Type> <name> - <owner>`.
pub fn parse_hover_declared_type(hover: &str, name: &str) -> Option<String> {
    let line = hover.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with("```"))?;
    let declaration = line.split_once(" - ").map_or(line, |(declaration, _)| declaration).trim_end();
    let ty = declaration.strip_suffix(name)?;
    (ty.ends_with(char::is_whitespace) && !ty.trim().is_empty()).then(|| ty.trim().to_string())
}

/// `Err` is the chain's first blocker.
pub fn normalize(chain: &StreamChain, hints: &TypeHints) -> Result<NormalizedChain, Rejection> {
    if let Some(blocker) = chain.facts.blockers.first() {
        return Err(blocker.clone());
    }
    let mut prelude = String::new();
    let mut edits = chain.facts.edits.clone();
    for capture in &chain.facts.captures {
        let Some(alias) = alias(capture, hints)? else { continue };
        let name = &capture.name;
        prelude.push_str(&format!("{} __c_{name} = {name}; ", alias.erasure));
        let read = match &alias.cast {
            Some(ty) => format!("(({ty}) __c_{name})"),
            None => format!("__c_{name}"),
        };
        for &(start, end) in &capture.uses {
            edits.push(TextEdit { start, end, text: read.clone(), adjustment: alias.adjustment.clone() });
        }
    }
    edits.sort_by_key(|e| e.start);
    debug_assert!(edits.windows(2).all(|w| w[0].end <= w[1].start), "overlapping edits {edits:?}");
    let mut adjustments = Vec::new();
    for edit in &edits {
        if !adjustments.contains(&edit.adjustment) {
            adjustments.push(edit.adjustment.clone());
        }
    }
    // The last execution-mode flag wins, so one `.sequential()` before the
    // terminal makes the recorder see a single thread.
    let sequential = chain.warnings.contains(&ChainWarning::ParallelRemoved);
    let mut segments: Vec<_> = chain
        .ops
        .iter()
        .filter(|op| !(sequential && matches!(op.name.as_str(), "parallel" | "sequential")))
        .map(|op| Segment { text: edited(chain, &edits, op.span), role: op.role, label: op.name.clone() })
        .collect();
    if sequential {
        segments.push(Segment { text: ".sequential()".into(), role: OpRole::Modifier, label: "sequential".into() });
        adjustments.push(Adjustment::ParallelRemoved);
    }
    let terminal = &chain.terminal;
    segments.push(Segment {
        text: edited(chain, &edits, terminal.span),
        role: terminal.role,
        label: terminal.name.clone(),
    });
    Ok(NormalizedChain { prelude, root: edited(chain, &edits, chain.root.span), segments, adjustments })
}

struct Alias {
    erasure: String,
    /// The type each read is cast back to; `None` reads the raw alias.
    cast: Option<String>,
    adjustment: Adjustment,
}

/// Rule 3's alias for `capture`; `None` when a hint shows it needs none.
fn alias(capture: &Capture, hints: &TypeHints) -> Result<Option<Alias>, Rejection> {
    let name = capture.name.clone();
    // jdtls names some types Java cannot write: `capture#1-of ?`, `<anonymous Foo>`.
    let writable = |h: &&str| !h.is_empty() && !h.contains('#') && !h.starts_with('<');
    let hint = capture.query.and_then(|id| hints.0.get(&id)).map(|h| h.trim()).filter(writable);
    let aliased = |ty: &str| Alias {
        erasure: capture.erasure.clone().unwrap_or_else(|| erasure(ty)),
        cast: Some(ty.into()),
        adjustment: Adjustment::CaptureAliased { name: name.clone(), as_type: ty.into() },
    };
    Ok(match (&capture.declared, hint, &capture.erasure) {
        (Some(declared), _, _) => Some(aliased(declared)),
        // Only type arguments stop the evaluator capturing a variable.
        (None, Some(hint), _) if !hint.contains('<') => None,
        (None, Some(hint), _) => Some(aliased(hint)),
        (None, None, Some(raw)) => Some(Alias {
            erasure: raw.clone(),
            cast: None,
            adjustment: Adjustment::CaptureRaw { name: name.clone(), erasure: raw.clone() },
        }),
        (None, None, None) => return Err(Rejection::MissingTypeHint { name }),
    })
}

/// The text of `span` with the edits inside it applied.
fn edited(chain: &StreamChain, edits: &[TextEdit], (start, end): (usize, usize)) -> String {
    let mut text = chain.text[start..end].to_string();
    // Back to front, so earlier offsets stay valid.
    for edit in edits.iter().rev().filter(|e| start <= e.start && e.end <= end) {
        text.replace_range(edit.start - start..edit.end - start, &edit.text);
    }
    text
}
