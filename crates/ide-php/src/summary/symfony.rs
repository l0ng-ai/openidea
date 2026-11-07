//! What a file tells the Symfony type provider about the rest of the
//! project ([`SymfonyFacts`]): the routes its `#[Route]` attributes name,
//! and which entity each Doctrine repository is for.
//!
//! Recorded for any file (a summary can't know whether Symfony is
//! installed); the index lists the files that have some, and the provider
//! only reads them when it is active. The YAML configuration is read
//! separately ([`crate::symfony::SymfonyConfig`]).

use serde::{Deserialize, Serialize};

use super::Loc;

/// See the module documentation.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SymfonyFacts {
    /// The named routes of `#[Route]` attributes on methods (with the name
    /// prefix of the class's `#[Route]`), in source order.
    pub routes: Vec<RouteAttribute>,
    pub repositories: Vec<RepositoryEntity>,
}

impl SymfonyFacts {
    pub fn is_empty(&self) -> bool {
        self.routes.is_empty() && self.repositories.is_empty()
    }
}

/// A route a `#[Route(…, name: 'blog_show')]` attribute names.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteAttribute {
    /// The full name (class prefix included).
    pub name: String,
    /// The full path (class prefix included), when written as a string.
    pub path: Option<String>,
    /// The name argument's string.
    pub loc: Loc,
}

/// A Doctrine repository and its entity: from the entity's
/// `#[ORM\Entity(repositoryClass: …)]`, or from the repository's
/// `parent::__construct($registry, Product::class)`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepositoryEntity {
    /// FQN, no leading `\`.
    pub repository: String,
    /// FQN, no leading `\`.
    pub entity: String,
}
