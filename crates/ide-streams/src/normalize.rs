use crate::{Adjustment, ChainWarning, OpRole, Rejection, StreamChain};
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

/// `Err` is the chain's first blocker.
pub fn normalize(chain: &StreamChain, _hints: &TypeHints) -> Result<NormalizedChain, Rejection> {
    if let Some(blocker) = chain.facts.blockers.first() {
        return Err(blocker.clone());
    }
    let mut adjustments = Vec::new();
    for edit in &chain.facts.edits {
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
        .filter(|op| !(op.role == OpRole::Modifier && matches!(op.name.as_str(), "parallel" | "sequential")))
        .map(|op| Segment { text: edited(chain, op.span), role: op.role, label: op.name.clone() })
        .collect();
    if sequential {
        segments.push(Segment { text: ".sequential()".into(), role: OpRole::Modifier, label: "sequential".into() });
        adjustments.push(Adjustment::ParallelRemoved);
    }
    let terminal = &chain.terminal;
    segments.push(Segment { text: edited(chain, terminal.span), role: terminal.role, label: terminal.name.clone() });
    Ok(NormalizedChain { prelude: String::new(), root: edited(chain, chain.root.span), segments, adjustments })
}

/// The text of `span` with the edits inside it applied.
fn edited(chain: &StreamChain, (start, end): (usize, usize)) -> String {
    let mut text = chain.text[start..end].to_string();
    // Back to front, so earlier offsets stay valid.
    for edit in chain.facts.edits.iter().rev().filter(|e| start <= e.start && e.end <= end) {
        text.replace_range(edit.start - start..edit.end - start, &edit.text);
    }
    text
}
