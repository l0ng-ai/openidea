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
    /// `chars()` / `codePoints()`: `String`, `StringBuilder` and the `CharSequence` default methods.
    Chars,
    /// `lines()`: `String` and `BufferedReader`; the receiver's type is not known here.
    Lines,
    Files,
    Pattern,
}

impl SourceFamily {
    /// Class filters beyond `java.util.stream.*` that see the source call exit:
    /// every class that can declare the method.
    pub fn class_filters(self) -> &'static [&'static str] {
        match self {
            Self::StreamPackage => &[],
            Self::Util => &["java.util.*"],
            Self::Arrays => &["java.util.Arrays"],
            Self::Chars => &["java.lang.String", "java.lang.AbstractStringBuilder", "java.lang.CharSequence"],
            Self::Lines => &["java.lang.String", "java.io.BufferedReader"],
            Self::Files => &["java.nio.file.Files"],
            Self::Pattern => &["java.util.regex.Pattern"],
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

/// The parameter count the JVM sees, which differs from the written arguments
/// for the varargs `of` of the stream interfaces: it takes one array.
pub(crate) fn jvm_arg_count(receiver: Option<&str>, method: &str, written: usize) -> usize {
    let stream_interface =
        |r: &str| ["Stream", "IntStream", "LongStream", "DoubleStream"].iter().any(|c| names_class(r, c));
    if method == "of" && receiver.is_some_and(stream_interface) { 1 } else { written }
}

/// `None` means `method` does not start a stream here. A receiver naming one
/// of the known factory classes only matches that class's own factories.
pub(crate) fn classify_source(receiver: Option<&str>, method: &str) -> Option<SourceFamily> {
    let receiver = receiver?;
    if let Some((_, family, methods)) = STATIC_SOURCES.iter().find(|(class, ..)| names_class(receiver, class)) {
        return methods.contains(&method).then_some(*family);
    }
    match method {
        "stream" | "parallelStream" | "tokens" | "ints" | "longs" | "doubles" => Some(SourceFamily::Util),
        "chars" | "codePoints" => Some(SourceFamily::Chars),
        "splitAsStream" => Some(SourceFamily::Pattern),
        "lines" => Some(SourceFamily::Lines),
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
        let family = |receiver, method| classify_source(Some(receiver), method);
        assert_eq!(family("nums", "stream"), Some(Util));
        assert_eq!(family("myStream", "stream"), Some(Util));
        assert_eq!(family("rnd", "ints"), Some(Util));
        assert_eq!(family("java.util.stream.Stream", "generate"), Some(StreamPackage));
        assert_eq!(family("IntStream", "range"), Some(StreamPackage));
        assert_eq!(family("Arrays", "stream"), Some(Arrays));
        assert_eq!(family("Files", "walk"), Some(Files));
        assert_eq!(family("reader", "lines"), Some(Lines));
        assert_eq!(family("\"a\\nb\"", "lines"), Some(Lines));
        assert_eq!(family("text", "chars"), Some(Chars));
        assert_eq!(family("pattern", "splitAsStream"), Some(Pattern));
        assert_eq!(classify_source(None, "stream"), None);
        assert_eq!(family("repo", "findAll"), None);
        assert_eq!(family("Stream", "builder"), None);
        assert_eq!(family("Files", "readAllLines"), None);
    }

    #[test]
    fn class_filters() {
        assert!(SourceFamily::StreamPackage.class_filters().is_empty());
        assert_eq!(SourceFamily::Util.class_filters(), ["java.util.*"]);
        assert_eq!(SourceFamily::Lines.class_filters(), ["java.lang.String", "java.io.BufferedReader"]);
        assert_eq!(
            SourceFamily::Chars.class_filters(),
            ["java.lang.String", "java.lang.AbstractStringBuilder", "java.lang.CharSequence"]
        );
    }

    #[test]
    fn varargs_of_takes_one_parameter() {
        assert_eq!(jvm_arg_count(Some("Stream"), "of", 3), 1);
        assert_eq!(jvm_arg_count(Some("java.util.stream.IntStream"), "of", 2), 1);
        assert_eq!(jvm_arg_count(Some("List"), "of", 3), 3);
        assert_eq!(jvm_arg_count(Some("Stream"), "iterate", 2), 2);
        assert_eq!(jvm_arg_count(None, "of", 2), 2);
    }
}
