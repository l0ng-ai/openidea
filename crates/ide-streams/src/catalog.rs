use crate::StepKind;
use serde::{Deserialize, Serialize};
use specta::Type;

/// What a method name means when it appears in a stream chain.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum OpRole {
    /// Intermediate operation whose elements are recorded.
    Step { link: StepKind },
    /// Intermediate operation that changes no elements (execution-mode flags).
    Modifier,
    /// Ends the chain; `void` terminals produce no result value.
    Terminal { void: bool },
    /// Terminal that hands out a lazy handle, so nothing runs inside the chain.
    LazyTerminal,
}

pub(crate) fn op_role(name: &str) -> Option<OpRole> {
    use OpRole::*;
    Some(match name {
        "filter" | "map" | "mapToInt" | "mapToLong" | "mapToDouble" | "mapToObj" | "flatMap" | "flatMapToInt"
        | "flatMapToLong" | "flatMapToDouble" | "flatMapToObj" | "mapMulti" | "mapMultiToInt" | "mapMultiToLong"
        | "mapMultiToDouble" | "mapMultiToObj" | "boxed" | "asLongStream" | "asDoubleStream" | "peek" | "distinct"
        | "skip" | "limit" | "takeWhile" | "dropWhile" => Step { link: StepKind::Sync },
        "sorted" => Step { link: StepKind::Reorder },
        "gather" => Step { link: StepKind::Unlinked },
        "parallel" | "sequential" | "unordered" | "onClose" => Modifier,
        "collect" | "toList" | "reduce" | "count" | "sum" | "average" | "min" | "max" | "summaryStatistics"
        | "anyMatch" | "allMatch" | "noneMatch" | "findFirst" | "findAny" | "toArray" => Terminal { void: false },
        "forEach" | "forEachOrdered" => Terminal { void: true },
        "iterator" | "spliterator" => LazyTerminal,
        _ => return None,
    })
}

/// `None` for names that are not intermediate steps (modifiers, terminals, unknown calls).
pub fn step_kind(op: &str) -> Option<StepKind> {
    match op_role(op)? {
        OpRole::Step { link } => Some(link),
        _ => None,
    }
}

/// Whether evaluating a stream-producing expression a second time is safe.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SourceCheck {
    /// Same elements every time.
    Fresh,
    /// Each evaluation advances shared state (generators, random streams).
    Stateful,
    /// Reads an external resource that may have changed or been consumed.
    Rereads,
}

use SourceCheck::{Fresh, Rereads, Stateful};

const STREAM: &[(&str, SourceCheck)] = &[
    ("of", Fresh),
    ("ofNullable", Fresh),
    ("iterate", Fresh),
    ("concat", Fresh),
    ("empty", Fresh),
    ("generate", Stateful),
];
const PRIMITIVE_RANGE: &[(&str, SourceCheck)] = &[
    ("range", Fresh),
    ("rangeClosed", Fresh),
    ("of", Fresh),
    ("iterate", Fresh),
    ("concat", Fresh),
    ("empty", Fresh),
    ("generate", Stateful),
];
const DOUBLE_STREAM: &[(&str, SourceCheck)] =
    &[("of", Fresh), ("iterate", Fresh), ("concat", Fresh), ("empty", Fresh), ("generate", Stateful)];
const ARRAYS: &[(&str, SourceCheck)] = &[("stream", Fresh)];
const STREAM_SUPPORT: &[(&str, SourceCheck)] =
    &[("stream", Fresh), ("intStream", Fresh), ("longStream", Fresh), ("doubleStream", Fresh)];
const FILES: &[(&str, SourceCheck)] = &[("lines", Rereads), ("list", Rereads), ("walk", Rereads), ("find", Rereads)];

const STATIC_SOURCES: &[(&str, &[(&str, SourceCheck)])] = &[
    ("Stream", STREAM),
    ("IntStream", PRIMITIVE_RANGE),
    ("LongStream", PRIMITIVE_RANGE),
    ("DoubleStream", DOUBLE_STREAM),
    ("Arrays", ARRAYS),
    ("StreamSupport", STREAM_SUPPORT),
    ("Files", FILES),
];

fn names_class(receiver: &str, class: &str) -> bool {
    receiver.strip_suffix(class).is_some_and(|rest| rest.is_empty() || rest.ends_with('.'))
}

/// `None` means `method` does not start a stream here. A receiver naming one
/// of the known factory classes only matches that class's own factories.
pub(crate) fn classify_source(
    receiver: Option<&str>,
    method: &str,
    receiver_is_string_literal: bool,
) -> Option<SourceCheck> {
    let receiver = receiver?;
    if let Some((_, table)) = STATIC_SOURCES.iter().find(|(class, _)| names_class(receiver, class)) {
        return table.iter().find(|(m, _)| *m == method).map(|&(_, c)| c);
    }
    match method {
        "stream" | "parallelStream" | "chars" | "codePoints" | "splitAsStream" => Some(Fresh),
        "lines" if receiver_is_string_literal => Some(Fresh),
        "lines" | "tokens" => Some(Rereads),
        "ints" | "longs" | "doubles" => Some(Stateful),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn op_roles() {
        assert_eq!(op_role("filter"), Some(OpRole::Step { link: StepKind::Sync }));
        assert_eq!(op_role("sorted"), Some(OpRole::Step { link: StepKind::Reorder }));
        assert_eq!(op_role("gather"), Some(OpRole::Step { link: StepKind::Unlinked }));
        assert_eq!(op_role("parallel"), Some(OpRole::Modifier));
        assert_eq!(op_role("forEach"), Some(OpRole::Terminal { void: true }));
        assert_eq!(op_role("collect"), Some(OpRole::Terminal { void: false }));
        assert_eq!(op_role("iterator"), Some(OpRole::LazyTerminal));
        assert_eq!(op_role("orElse"), None);
    }

    #[test]
    fn step_kinds() {
        assert_eq!(step_kind("mapMulti"), Some(StepKind::Sync));
        assert_eq!(step_kind("sorted"), Some(StepKind::Reorder));
        assert_eq!(step_kind("parallel"), None);
        assert_eq!(step_kind("collect"), None);
    }

    #[test]
    fn sources() {
        assert_eq!(classify_source(Some("nums"), "stream", false), Some(SourceCheck::Fresh));
        assert_eq!(classify_source(Some("java.util.stream.Stream"), "generate", false), Some(SourceCheck::Stateful));
        assert_eq!(classify_source(Some("Files"), "lines", false), Some(SourceCheck::Rereads));
        assert_eq!(classify_source(Some("reader"), "lines", false), Some(SourceCheck::Rereads));
        assert_eq!(classify_source(Some("\"a\\nb\""), "lines", true), Some(SourceCheck::Fresh));
        assert_eq!(classify_source(Some("rnd"), "ints", false), Some(SourceCheck::Stateful));
        assert_eq!(classify_source(None, "stream", false), None);
        assert_eq!(classify_source(Some("repo"), "findAll", false), None);
        assert_eq!(classify_source(Some("Files"), "walk", false), Some(SourceCheck::Rereads));
        assert_eq!(classify_source(Some("myStream"), "stream", false), Some(SourceCheck::Fresh));
        assert_eq!(classify_source(Some("Stream"), "builder", false), None);
    }
}
