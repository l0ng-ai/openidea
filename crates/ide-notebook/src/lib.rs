//! Native notebook documents and owned Jupyter kernel sessions.
pub mod document;
pub mod kernel;

pub use document::{NotebookCell, NotebookDocument, NotebookEdit, NotebookSnapshot};
