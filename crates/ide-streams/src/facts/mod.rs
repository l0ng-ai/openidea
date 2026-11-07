//! Normalisation facts, gathered while the chain's syntax tree is at hand.

mod boxing;
mod captures;
mod generic;
mod locals;
mod members;
mod pattern;
mod rules;
mod types;

use crate::qualify::FileImports;
use crate::{FrameShape, Rejection};
use ide_core::Pos;
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
    /// Frame variables of generic or `var` type read inside the chain's lambdas, in order of first use.
    pub captures: Vec<Capture>,
    /// Declared types to ask jdtls hover for; answers come back as [`crate::TypeHints`].
    pub queries: Vec<TypeQuery>,
}

/// A frame variable the evaluator cannot capture in a lambda as declared.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    pub name: String,
    /// The declared type's text; `None` for `var`. In a record frame its type names are fully qualified.
    pub declared: Option<String>,
    /// The raw type for the alias: the declared type without type arguments,
    /// or the class of a `new X<>(..)` initializer.
    pub erasure: Option<String>,
    /// Byte ranges in [`crate::StreamChain::text`] of the reads inside lambda bodies.
    pub uses: Vec<(usize, usize)>,
    /// The [`TypeQuery`] asking for the declared type.
    pub query: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TypeQuery {
    pub id: u32,
    pub name: String,
    /// The variable's name where it is declared.
    pub pos: Pos,
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

/// `chain` is the chain's terminal call, `root` the call creating its stream,
/// `scope` the frame scope it was found in.
pub(crate) fn collect<'t>(
    t: &SyntaxTree<'t>,
    chain: Node<'t>,
    root: Node<'t>,
    scope: Node<'t>,
    frame: &FrameShape,
) -> ChainFacts {
    let member = members::member_of(scope);
    let mut classes = members::enclosing_classes(t, chain, frame);
    let mut type_params: Vec<_> = frame.type_params.iter().map(|(name, _)| name.clone()).collect();
    let imports = frame.record.then(|| FileImports::of(t));
    if frame.record {
        // Rule 4's qualifiers are type names too.
        if let Some(package) = &frame.package {
            classes.iter_mut().for_each(|c| c.path = format!("{package}.{}", c.path));
        }
        types::declared_type_params(t, chain, &mut type_params);
    }
    let mut collector = rules::Collector {
        t,
        chain,
        member,
        frame,
        imports,
        type_params,
        classes,
        declared: members::declared_names(t, member),
        facts: ChainFacts::default(),
    };
    collector.visit(chain, rules::Ctx::Chain);
    collector.cast_generic_elements(root);
    let mut facts = collector.facts;
    facts.edits.sort_by_key(|e| e.start);
    facts.edits.dedup();
    debug_assert!(facts.edits.windows(2).all(|w| w[0].end <= w[1].start), "overlapping edits {:?}", facts.edits);
    facts
}
