//! Project HTTP routes for Search Everywhere and the HTTP client.
use crate::{Error, Invocation, Location};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoint {
    /// `None` accepts any HTTP method.
    pub method: Option<String>,
    pub path: String,
    pub framework: String,
    pub handler: Option<String>,
    /// Declaration range, with zero-based lines and UTF-16 columns.
    pub location: Location,
}

/// Register with `register_plugin!(MyPlugin, endpoints)` and declare
/// `[[contributes.endpoints]] files = ["config/routes.rb"]` in the manifest.
pub trait EndpointsProvider {
    fn endpoints(&mut self, ctx: &Invocation) -> Result<Vec<Endpoint>, Error>;
}
