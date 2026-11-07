use crate::{NormalizedChain, OpRole, StepKind};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};

/// Recorder capacity in list entries; one record takes two.
pub const DEFAULT_BUDGET_ENTRIES: usize = 100_000;

/// The three expressions the debugger evaluates to trace one chain, plus what
/// is needed to read the recording back.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TracePlan {
    pub nonce: String,
    /// The system property holding the recorder list.
    pub key: String,
    /// Installs the recorder.
    pub e0: String,
    /// The chain with a recording `peek` after the source and each step.
    pub e1: String,
    /// Removes the recorder.
    pub e3: String,
    pub steps: Vec<StepInfo>,
    /// The terminal operation's method name.
    pub terminal: String,
    pub void_terminal: bool,
    pub budget: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StepInfo {
    /// `0` is the source; it equals the `k` the step's `peek` records.
    pub index: u16,
    /// The source's own text for index 0, else the operation's method name.
    pub label: String,
    pub kind: StepKind,
}

/// `budget` counts recorder list entries; going over it makes the chain throw
/// `oi-budget:<nonce>`. `chain` must end with a terminal segment.
pub fn build_plan(chain: &NormalizedChain, nonce: &str, budget: usize) -> TracePlan {
    let mut steps = vec![StepInfo { index: 0, label: chain.root.clone(), kind: StepKind::Sync }];
    let mut traced = format!("{}{}", chain.root, peek(0, nonce, budget));
    let mut terminal = String::new();
    let mut void_terminal = false;
    for segment in &chain.segments {
        traced.push_str(&segment.text);
        match segment.role {
            OpRole::Step { link } => {
                let index = steps.len() as u16;
                steps.push(StepInfo { index, label: segment.label.clone(), kind: link });
                traced.push_str(&peek(index, nonce, budget));
            }
            OpRole::Terminal { void } => {
                terminal = segment.label.clone();
                void_terminal = void;
            }
            OpRole::Modifier | OpRole::LazyTerminal => {}
        }
    }
    let result =
        if void_terminal { format!("{traced}; Object __r = null;") } else { format!("Object __r = {traced};") };
    let e1 = format!(
        "java.util.ArrayList __oi = (java.util.ArrayList) System.getProperties().get(\"oi.{nonce}\"); \
         Thread __oiT = Thread.currentThread(); {}{result} \
         __oi.add(Integer.valueOf(-1)); __oi.add(__r); return __r;",
        chain.prelude
    );
    TracePlan {
        nonce: nonce.to_string(),
        key: format!("oi.{nonce}"),
        e0: format!("System.getProperties().put(\"oi.{nonce}\", new java.util.ArrayList())"),
        e1,
        e3: format!("System.getProperties().remove(\"oi.{nonce}\")"),
        steps,
        terminal,
        void_terminal,
        budget,
    }
}

/// 16 lowercase hex characters, unique per call within a process.
pub fn fresh_nonce() -> String {
    format!("{:016x}", RandomState::new().build_hasher().finish())
}

/// The thread check keeps a `parallel` chain that slipped through from racing
/// on the unsynchronised recorder list.
fn peek(k: u16, nonce: &str, budget: usize) -> String {
    format!(
        ".peek(__oiX -> {{ if (__oi.size() >= {budget}) throw new IllegalStateException(\"oi-budget:{nonce}\"); \
         if (Thread.currentThread() != __oiT) throw new IllegalStateException(\"oi-thread:{nonce}\"); \
         __oi.add(Integer.valueOf({k})); __oi.add(__oiX); }})"
    )
}
