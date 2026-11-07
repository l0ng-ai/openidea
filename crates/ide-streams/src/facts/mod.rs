//! Normalisation facts, gathered while the chain's syntax tree is at hand.

mod members;
mod pattern;
mod rules;

use crate::{FrameShape, Rejection};
use ide_syntax::SyntaxTree;
use serde::{Deserialize, Serialize};
use specta::Type;
use tree_sitter::Node;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChainFacts {
    /// Sorted by `start`, never overlapping.
    pub edits: Vec<TextEdit>,
    /// Reasons to refuse the chain that only the tree reveals, in source order.
    pub blockers: Vec<Rejection>,
}

/// Replaces `start..end`, byte offsets in [`crate::StreamChain::text`], with `text`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextEdit {
    pub start: usize,
    pub end: usize,
    pub text: String,
    pub adjustment: Adjustment,
}

/// A change normalisation made to the user's chain, shown before tracing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Adjustment {
    LambdaParamTypesRemoved,
    StaticQualified {
        name: String,
        with: String,
    },
    /// An `instanceof` pattern variable replaced by a cast of the tested variable.
    PatternRewritten {
        name: String,
    },
    ParallelRemoved,
    /// A generic capture read through an alias cast back to its declared type.
    CaptureAliased {
        name: String,
        as_type: String,
    },
    /// A capture of unknown declared type read through a raw alias.
    CaptureRaw {
        name: String,
        erasure: String,
    },
    PrimitiveBoxed {
        text: String,
    },
    TypeQualified {
        name: String,
        with: String,
    },
    GenericCast {
        name: String,
        to: String,
    },
}

/// `chain` is the chain's terminal call, `scope` the frame scope it was found in.
pub(crate) fn collect<'t>(t: &SyntaxTree<'t>, chain: Node<'t>, scope: Node<'t>, frame: &FrameShape) -> ChainFacts {
    let mut collector = rules::Collector {
        t,
        chain,
        classes: members::enclosing_classes(t, chain, frame),
        declared: members::declared_names(t, members::member_of(scope)),
        facts: ChainFacts::default(),
    };
    collector.visit(chain, rules::Ctx::Chain);
    let mut facts = collector.facts;
    facts.edits.sort_by_key(|e| e.start);
    facts.edits.dedup();
    facts
}
