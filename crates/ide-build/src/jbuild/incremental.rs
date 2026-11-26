//! Class-level incremental compilation (#4078 step 3). Each source set records, per class it
//! compiled, the source it came from, its supertypes, the classes its constant pool names and
//! fingerprints of its API and constants ([`super::classfile`]). A build compiles the changed
//! sources, then the sources of classes that refer to a class whose API changed (or to a
//! subclass of one), round after round until no API changes. Sets compiled against this one
//! read its log of API changes; a changed compile-time constant, which javac copies into the
//! classes that use it, recompiles the whole set and every set compiled against it.
use super::*;
use std::collections::BTreeSet;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub(super) struct ClassRecord {
    /// The source javac compiled it from; `None` for classes an annotation processor wrote
    /// without naming an originating source.
    pub source: Option<PathBuf>,
    pub file: PathBuf,
    pub super_name: Option<String>,
    #[serde(default)]
    pub interfaces: Vec<String>,
    #[serde(default)]
    pub refs: Vec<String>,
    pub api: u64,
    pub constants: u64,
}

impl ClassRecord {
    pub fn new(class: classfile::ClassFile, file: PathBuf, source: Option<PathBuf>) -> (String, Self) {
        let record = ClassRecord {
            source,
            file,
            super_name: class.super_name,
            interfaces: class.interfaces,
            refs: class.refs.into_iter().collect(),
            api: class.api,
            constants: class.constants,
        };
        (class.name, record)
    }

    fn has_constants(&self) -> bool {
        self.constants != NO_CONSTANTS
    }
}

/// The constant fingerprint of a class without compile-time constants.
pub(super) const NO_CONSTANTS: u64 = 0xcbf2_9ce4_8422_2325;

/// The classes whose API one compilation of a set changed.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub(super) struct ApiChange {
    /// The set's generation before and after the compilation.
    pub since: u64,
    pub generation: u64,
    pub classes: Vec<String>,
    /// Everything counts as changed: a constant changed, or there was nothing to compare with.
    pub all: bool,
}

/// How many compilations' API changes a set keeps for the sets compiled against it; one that
/// fell further behind compiles from scratch.
const CHANGE_LOG: usize = 64;

/// The inputs of a source set that, when changed, compile it from scratch.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub(super) struct SetStamp {
    pub options: Vec<String>,
    /// Classpath entries outside the reactor's outputs, with their stamps (folders have none).
    pub libraries: Vec<(PathBuf, Option<FileStamp>)>,
    /// The reactor outputs on the classpath, in order.
    pub reactor: Vec<PathBuf>,
    pub processor_path: Vec<(PathBuf, Option<FileStamp>)>,
    pub java_home: PathBuf,
}

#[derive(Debug, Default, Deserialize, Serialize)]
pub(super) struct SetState {
    pub stamp: SetStamp,
    /// The sources as of the last compilation.
    pub sources: BTreeMap<PathBuf, FileStamp>,
    /// Changes whenever the set's classes do.
    pub generation: u64,
    /// The generation of each reactor output it was compiled against.
    pub upstream: BTreeMap<PathBuf, u64>,
    pub classes: BTreeMap<String, ClassRecord>,
    /// Sources a failed compilation left uncompiled.
    pub dirty: BTreeSet<PathBuf>,
    pub changes: Vec<ApiChange>,
    /// Sources annotation processors wrote, and other files they wrote without an originating
    /// source (`META-INF/services`…): processors that aggregate. While there are any, a change
    /// compiles the set from scratch.
    pub generated: Vec<PathBuf>,
    pub unowned: Vec<PathBuf>,
    pub success: bool,
}

impl SetState {
    /// The classes whose API changed since generation `since`; `None` when unknown (the log
    /// doesn't reach back that far) or when everything counts as changed.
    pub fn changes_since(&self, since: u64) -> Option<BTreeSet<String>> {
        let mut changed = BTreeSet::new();
        let mut at = since;
        while at != self.generation {
            let change = self.changes.iter().find(|c| c.since == at)?;
            if change.all {
                return None;
            }
            changed.extend(change.classes.iter().cloned());
            at = change.generation;
        }
        Some(changed)
    }

    pub fn log(&mut self, generation: u64, classes: BTreeSet<String>, all: bool) {
        self.changes.push(ApiChange {
            since: self.generation,
            generation,
            classes: classes.into_iter().collect(),
            all,
        });
        if self.changes.len() > CHANGE_LOG {
            self.changes.drain(..self.changes.len() - CHANGE_LOG);
        }
        self.generation = generation;
    }
}

pub(super) fn load_state(path: &Path) -> Option<SetState> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// `seeds` and the classes of `classes` that extend or implement one of them, transitively:
/// a class that inherits a changed member changes for the classes that use it.
pub(super) fn with_subclasses(classes: &BTreeMap<String, ClassRecord>, seeds: &BTreeSet<String>) -> BTreeSet<String> {
    let mut out = seeds.clone();
    loop {
        let before = out.len();
        for (name, record) in classes {
            if !out.contains(name)
                && (record.super_name.as_ref().is_some_and(|s| out.contains(s))
                    || record.interfaces.iter().any(|i| out.contains(i)))
            {
                out.insert(name.clone());
            }
        }
        if out.len() == before {
            return out;
        }
    }
}

/// The sources of the classes that refer to one of `affected`.
pub(super) fn dependent_sources(
    classes: &BTreeMap<String, ClassRecord>,
    affected: &BTreeSet<String>,
) -> BTreeSet<PathBuf> {
    if affected.is_empty() {
        return BTreeSet::new();
    }
    classes
        .iter()
        .filter(|(name, r)| affected.contains(*name) || r.refs.iter().any(|x| affected.contains(x)))
        .filter_map(|(_, r)| r.source.clone())
        .collect()
}

/// The sources of the classes that refer to a class with the same simple name as one of
/// `added`: a new class can take a simple name over from an on-demand import.
pub(super) fn shadowed_sources(classes: &BTreeMap<String, ClassRecord>, added: &BTreeSet<String>) -> BTreeSet<PathBuf> {
    let names: BTreeSet<&str> = added.iter().map(|n| classfile::simple_name(n)).collect();
    if names.is_empty() {
        return BTreeSet::new();
    }
    classes
        .iter()
        .filter(|(name, r)| {
            !added.contains(*name)
                && r.refs.iter().any(|x| !added.contains(x) && names.contains(classfile::simple_name(x)))
        })
        .filter_map(|(_, r)| r.source.clone())
        .collect()
}

/// What one round's classes changed, compared with the classes the round replaced.
#[derive(Debug, Default)]
pub(super) struct RoundDiff {
    pub api: BTreeSet<String>,
    pub added: BTreeSet<String>,
    pub constants: bool,
}

pub(super) fn diff(old: &BTreeMap<String, ClassRecord>, new: &BTreeMap<String, ClassRecord>) -> RoundDiff {
    let mut out = RoundDiff::default();
    for (name, record) in new {
        match old.get(name) {
            Some(before) => {
                if before.api != record.api {
                    out.api.insert(name.clone());
                }
                if before.constants != record.constants {
                    out.constants = true;
                }
            }
            None => {
                out.api.insert(name.clone());
                out.added.insert(name.clone());
            }
        }
    }
    for (name, before) in old {
        if !new.contains_key(name) {
            out.api.insert(name.clone());
            out.constants |= before.has_constants();
        }
    }
    out
}
