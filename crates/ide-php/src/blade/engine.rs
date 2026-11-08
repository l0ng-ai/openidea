//! The engine's requests on the PHP embedded in a Blade template: the
//! template is compiled ([`super::compile`]), held as an embedded document
//! under the template's own id and path, and the request's positions are
//! mapped into the PHP and its answer's back.

use std::path::Path;

use ide_core::{CancellationToken, DocId, Pos};

use super::views::ViewPaths;
use super::{Compiled, compile_with};
use crate::complete::{CompletionData, Completions};
use crate::engine::PhpEngine;
use crate::navigate::{HoverInfo, Target};
use crate::signature::SignatureHelpInfo;

/// An open Blade template.
#[derive(Clone, Copy, Debug)]
pub struct BladeDocument<'a> {
    pub doc: DocId,
    pub path: &'a Path,
    pub version: u32,
    pub text: &'a str,
}

impl PhpEngine {
    /// Compiles the template and holds its PHP as the embedded document of
    /// `blade.doc`. In a Laravel project, the variables the view's callers
    /// pass it are declared with their types
    /// ([`PhpEngine::laravel_view_variables`]).
    pub fn blade_sync(&self, blade: &BladeDocument) -> Compiled {
        let component = ViewPaths::new(&self.root()).is_component_view(blade.path);
        let variables = self.laravel_view_variables(blade.path);
        let custom = self.laravel_blade().map(|catalog| catalog.directive_names()).unwrap_or_default();
        let compiled = compile_with(blade.text, component, &variables, &custom);
        self.embedded_document(blade.doc, blade.path, blade.version, &compiled.php);
        compiled
    }

    /// Completion in the PHP at `pos` of a template: `None` outside it.
    /// Items that would add a `use` import insert the fully qualified name
    /// instead (a template has nowhere to put the import).
    pub fn blade_completion(
        &self,
        blade: &BladeDocument,
        pos: Pos,
        trigger: Option<&str>,
        cancel: &CancellationToken,
    ) -> Option<Completions> {
        let compiled = self.blade_sync(blade);
        let at = compiled.to_php(pos)?;
        let mut found = self.completion(blade.doc, at, trigger, cancel)?;
        found.items.retain_mut(|item| {
            let Some(replace) = compiled.range_to_blade(item.replace) else { return false };
            item.replace = replace;
            item.replace_tab = item.replace_tab.and_then(|range| compiled.range_to_blade(range));
            if !item.additional_edits.is_empty() {
                item.additional_edits.clear();
                if let Some(CompletionData::ClassLike { fqn }) = &item.data
                    && item.insert_text.starts_with(&item.label)
                {
                    item.insert_text = format!("\\{fqn}{}", &item.insert_text[item.label.len()..]);
                    item.filter_text.get_or_insert_with(|| item.label.clone());
                }
            }
            true
        });
        Some(found)
    }

    /// Hover on the PHP at `pos` of a template.
    pub fn blade_hover(&self, blade: &BladeDocument, pos: Pos) -> Option<HoverInfo> {
        let compiled = self.blade_sync(blade);
        let mut hover = self.hover(blade.doc, compiled.to_php(pos)?)?;
        hover.range = compiled.range_to_blade(hover.range).unwrap_or(ide_core::Range::new(pos, pos));
        Some(hover)
    }

    /// Signature help in the PHP at `pos` of a template.
    pub fn blade_signature_help(&self, blade: &BladeDocument, pos: Pos) -> Option<SignatureHelpInfo> {
        let compiled = self.blade_sync(blade);
        self.signature_help(blade.doc, compiled.to_php(pos)?)
    }

    /// Goto definition from the PHP at `pos` of a template. Targets in the
    /// template itself are mapped back to it (dropped when the compiler
    /// wrote them).
    pub fn blade_definition(&self, blade: &BladeDocument, pos: Pos) -> Option<Vec<Target>> {
        let compiled = self.blade_sync(blade);
        let targets = self.definition(blade.doc, compiled.to_php(pos)?)?;
        let own = crate::project::normalize(blade.path);
        let targets = targets
            .into_iter()
            .filter_map(|mut target| {
                if target.path == own {
                    target.range = compiled.range_to_blade(target.range)?;
                }
                Some(target)
            })
            .collect();
        Some(targets)
    }
}
