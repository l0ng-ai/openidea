//! What a file tells the Laravel type provider about the rest of the
//! project ([`LaravelFacts`]): the container bindings service providers
//! register, the columns migrations create, and the casts of models.
//!
//! These are recorded for any file (a summary can't know whether Laravel
//! is installed); the index lists the files that have some, and the
//! provider only reads them when it is active.

use serde::{Deserialize, Serialize};

use super::DocType;
use crate::types::LazyType;

/// See the module documentation.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaravelFacts {
    /// `$app->bind('id', …)` and the like, in source order.
    pub bindings: Vec<Binding>,
    /// `Schema::create('table', …)` and `Schema::table('table', …)`, in
    /// source order.
    pub tables: Vec<Table>,
    /// The `$casts` property or `casts()` method of a class.
    pub casts: Vec<ModelCasts>,
}

impl LaravelFacts {
    pub fn is_empty(&self) -> bool {
        self.bindings.is_empty() && self.tables.is_empty() && self.casts.is_empty()
    }

    /// The facts of several files, in order.
    pub fn merge<'a>(facts: impl IntoIterator<Item = &'a LaravelFacts>) -> Self {
        let mut out = Self::default();
        for facts in facts {
            out.bindings.extend(facts.bindings.iter().cloned());
            out.tables.extend(facts.tables.iter().cloned());
            out.casts.extend(facts.casts.iter().cloned());
        }
        out
    }

    /// The columns migrations give `table`, later ones overriding earlier
    /// ones of the same name.
    pub fn columns(&self, table: &str) -> Vec<&Column> {
        let mut out: Vec<&Column> = Vec::new();
        for column in self.tables.iter().filter(|t| t.name.eq_ignore_ascii_case(table)).flat_map(|t| &t.columns) {
            match out.iter_mut().find(|known| known.name == column.name) {
                Some(known) => *known = column,
                None => out.push(column),
            }
        }
        out
    }
}

/// A container binding registered under a string id (`'payments'`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Binding {
    pub id: String,
    /// What the binding makes: the class named (`Foo::class`, a class-name
    /// string), what a closure returns, or the instance given.
    pub target: LazyType,
}

/// The columns one migration call creates (or adds to) a table.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Table {
    pub name: String,
    pub columns: Vec<Column>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Column {
    pub name: String,
    /// The type a model attribute reading the column has (before casts).
    pub ty: DocType,
    /// `->nullable()`, or a column Laravel creates nullable
    /// (`timestamps()`).
    pub nullable: bool,
}

/// The casts a class declares.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelCasts {
    /// The class (FQN).
    pub class: String,
    pub casts: Vec<Cast>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cast {
    pub attribute: String,
    /// A built-in cast as written (`'datetime:Y-m-d'`, `'decimal:2'`), or
    /// a cast class, fully qualified with a leading `\` (its `:arguments`
    /// dropped).
    pub cast: String,
}
