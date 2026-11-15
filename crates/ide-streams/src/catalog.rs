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

/// The class declaring a stream-producing method, which decides what the
/// debugger must watch to catch the stream when it is created.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SourceFamily {
    /// Factories in `java.util.stream`, already covered by the stream filter.
    StreamPackage,
    /// `Collection.stream()`, `Random.ints()`, `Scanner.tokens()`.
    Util,
    Arrays,
    String,
    Reader,
    Files,
    Pattern,
}

impl SourceFamily {
    /// Class filter beyond `java.util.stream.*` that sees the source call exit.
    pub fn class_filter(self) -> Option<&'static str> {
        match self {
            Self::StreamPackage => None,
            Self::Util => Some("java.util.*"),
            Self::Arrays => Some("java.util.Arrays"),
            Self::String => Some("java.lang.String"),
            Self::Reader => Some("java.io.BufferedReader"),
            Self::Files => Some("java.nio.file.Files"),
            Self::Pattern => Some("java.util.regex.Pattern"),
        }
    }
}

const STREAM: &[&str] = &["of", "ofNullable", "iterate", "concat", "empty", "generate"];
const PRIMITIVE_RANGE: &[&str] = &["range", "rangeClosed", "of", "iterate", "concat", "empty", "generate"];
const DOUBLE_STREAM: &[&str] = &["of", "iterate", "concat", "empty", "generate"];
const STREAM_SUPPORT: &[&str] = &["stream", "intStream", "longStream", "doubleStream"];

use SourceFamily::{Arrays, Files, StreamPackage};

const STATIC_SOURCES: &[(&str, SourceFamily, &[&str])] = &[
    ("Stream", StreamPackage, STREAM),
    ("IntStream", StreamPackage, PRIMITIVE_RANGE),
    ("LongStream", StreamPackage, PRIMITIVE_RANGE),
    ("DoubleStream", StreamPackage, DOUBLE_STREAM),
    ("Arrays", Arrays, &["stream"]),
    ("StreamSupport", StreamPackage, STREAM_SUPPORT),
    ("Files", Files, &["lines", "list", "walk", "find"]),
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
) -> Option<SourceFamily> {
    let receiver = receiver?;
    if let Some((_, family, methods)) = STATIC_SOURCES.iter().find(|(class, ..)| names_class(receiver, class)) {
        return methods.contains(&method).then_some(*family);
    }
    match method {
        "stream" | "parallelStream" | "tokens" | "ints" | "longs" | "doubles" => Some(SourceFamily::Util),
        "chars" | "codePoints" => Some(SourceFamily::String),
        "splitAsStream" => Some(SourceFamily::Pattern),
        "lines" if receiver_is_string_literal => Some(SourceFamily::String),
        "lines" => Some(SourceFamily::Reader),
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
        use SourceFamily::*;
        let family = |receiver, method| classify_source(Some(receiver), method, false);
        assert_eq!(family("nums", "stream"), Some(Util));
        assert_eq!(family("myStream", "stream"), Some(Util));
        assert_eq!(family("rnd", "ints"), Some(Util));
        assert_eq!(family("java.util.stream.Stream", "generate"), Some(StreamPackage));
        assert_eq!(family("IntStream", "range"), Some(StreamPackage));
        assert_eq!(family("Arrays", "stream"), Some(Arrays));
        assert_eq!(family("Files", "walk"), Some(Files));
        assert_eq!(family("reader", "lines"), Some(Reader));
        assert_eq!(family("text", "chars"), Some(String));
        assert_eq!(family("pattern", "splitAsStream"), Some(Pattern));
        assert_eq!(classify_source(Some("\"a\\nb\""), "lines", true), Some(String));
        assert_eq!(classify_source(None, "stream", false), None);
        assert_eq!(family("repo", "findAll"), None);
        assert_eq!(family("Stream", "builder"), None);
        assert_eq!(family("Files", "readAllLines"), None);
    }

    #[test]
    fn class_filters() {
        assert_eq!(SourceFamily::StreamPackage.class_filter(), None);
        assert_eq!(SourceFamily::Util.class_filter(), Some("java.util.*"));
        assert_eq!(SourceFamily::Reader.class_filter(), Some("java.io.BufferedReader"));
    }
}
