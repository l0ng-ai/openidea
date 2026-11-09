//! SDK for OpenIDEA plugins written in Rust (plugin API 1.0).
//!
//! ```ignore
//! use openidea_plugin::{Error, Invocation, Plugin, register_plugin};
//!
//! #[derive(Default)]
//! struct Shout;
//!
//! impl Plugin for Shout {
//!     fn run_command(&mut self, id: &str, ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
//!         match id {
//!             "shout" => {
//!                 let editor = ctx.editor().ok_or("no editor is focused")?;
//!                 editor.transform_selections(|s| s.to_uppercase())?;
//!                 Ok(None)
//!             }
//!             _ => Err(Error::NotFound(format!("command {id}"))),
//!         }
//!     }
//! }
//!
//! register_plugin!(Shout);
//! ```
//!
//! On `wasm32-wasip2` the [`host`] functions and handles call the IDE through
//! the `openidea:plugin@1.0.0` WIT world. On any other target they call the
//! [`mock`] host, so plugin logic is tested with plain `cargo test`:
//!
//! ```ignore
//! let host = openidea_plugin::mock::MockHost::install();
//! host.open_editor("/project/a.txt", "rust", "hi there", &[(0, 0, 0, 2)]);
//! Shout.run_command("shout", &host.invocation(), None).unwrap();
//! assert_eq!(host.editor_text(), "HI there");
//! ```
//!
//! Instance memory is a cache: the instance is dropped after a crash or when
//! idle. Keep what must survive in [`host::storage`].
//!
//! Build with `openidea-plugin build` (or `cargo build --release --target
//! wasm32-wasip2`); see `plugins/README.md`.

pub mod commit;
pub mod details;
pub mod diagnostics;
pub mod endpoints;
pub mod file_actions;
pub mod host;
pub mod hover;
pub mod indexing;
pub mod inlay_hints;
#[cfg(not(target_arch = "wasm32"))]
pub mod mock;
pub mod providers;
pub mod semantic_tokens;
pub mod syntax;
pub mod text;
mod types;
pub mod views;

pub use host::{Invocation, Project, Task, TextEditor};
pub use types::*;

#[cfg(target_arch = "wasm32")]
#[doc(hidden)]
pub mod bindings {
    wit_bindgen::generate!({
        world: "plugin",
        path: "wit",
        pub_export_macro: true,
        export_macro_name: "__export_plugin_world",
        default_bindings_module: "openidea_plugin::bindings",
    });
}

/// The `syntax` world: only the `syntax-provider` export, merged with
/// `plugin` into one component (world `plugin-syntax`).
#[cfg(target_arch = "wasm32")]
#[doc(hidden)]
pub mod syntax_bindings {
    wit_bindgen::generate!({
        world: "syntax",
        path: "wit",
        pub_export_macro: true,
        export_macro_name: "__export_syntax_world",
        default_bindings_module: "openidea_plugin::syntax_bindings",
    });
}

/// The `editor-providers` world: only the `providers` export, merged with
/// `plugin` (world `plugin-providers`).
#[cfg(target_arch = "wasm32")]
#[doc(hidden)]
pub mod providers_bindings {
    wit_bindgen::generate!({
        world: "editor-providers",
        path: "wit",
        pub_export_macro: true,
        export_macro_name: "__export_editor_providers_world",
        default_bindings_module: "openidea_plugin::providers_bindings",
        with: {
            "openidea:plugin/types@1.4.0": crate::bindings::openidea::plugin::types,
        },
    });
}

/// The `views-provider` world: only the `view-provider` export, merged with
/// `plugin` (world `plugin-views`).
#[cfg(target_arch = "wasm32")]
#[doc(hidden)]
pub mod views_bindings {
    wit_bindgen::generate!({
        world: "views-provider",
        path: "wit",
        pub_export_macro: true,
        export_macro_name: "__export_views_world",
        default_bindings_module: "openidea_plugin::views_bindings",
        with: {
            "openidea:plugin/types@1.4.0": crate::bindings::openidea::plugin::types,
            "openidea:plugin/workspace@1.4.0": crate::bindings::openidea::plugin::workspace,
            "openidea:plugin/editor@1.4.0": crate::bindings::openidea::plugin::editor,
            "openidea:plugin/invocation@1.4.0": crate::bindings::openidea::plugin::invocation,
        },
    });
}

#[cfg(target_arch = "wasm32")]
#[doc(hidden)]
pub mod indexing_bindings {
    wit_bindgen::generate!({
        world: "indexing", path: "wit", pub_export_macro: true,
        export_macro_name: "__export_indexing_world",
        default_bindings_module: "openidea_plugin::indexing_bindings",
        with: { "openidea:plugin/types@1.4.0": crate::bindings::openidea::plugin::types },
    });
}

#[cfg(target_arch = "wasm32")]
#[doc(hidden)]
pub mod details_bindings {
    wit_bindgen::generate!({
        world: "details", path: "wit", pub_export_macro: true,
        export_macro_name: "__export_details_world",
        default_bindings_module: "openidea_plugin::details_bindings",
        with: {
            "openidea:plugin/types@1.4.0": crate::bindings::openidea::plugin::types,
            "openidea:plugin/workspace@1.4.0": crate::bindings::openidea::plugin::workspace,
            "openidea:plugin/editor@1.4.0": crate::bindings::openidea::plugin::editor,
            "openidea:plugin/invocation@1.4.0": crate::bindings::openidea::plugin::invocation,
        },
    });
}

#[cfg(target_arch = "wasm32")]
#[doc(hidden)]
pub mod semantic_bindings {
    wit_bindgen::generate!({
        world: "semantic-tokens", path: "wit", pub_export_macro: true,
        export_macro_name: "__export_semantic_tokens_world",
        default_bindings_module: "openidea_plugin::semantic_bindings",
        with: { "openidea:plugin/types@1.4.0": crate::bindings::openidea::plugin::types },
    });
}

#[cfg(target_arch = "wasm32")]
#[doc(hidden)]
pub mod diagnostics_bindings {
    wit_bindgen::generate!({
        world: "editor-diagnostics", path: "wit", pub_export_macro: true,
        export_macro_name: "__export_diagnostics_world",
        default_bindings_module: "openidea_plugin::diagnostics_bindings",
        with: {
            "openidea:plugin/types@1.4.0": crate::bindings::openidea::plugin::types,
            "openidea:plugin/diagnostics@1.4.0": crate::bindings::openidea::plugin::diagnostics,
        },
    });
}

#[cfg(target_arch = "wasm32")]
#[doc(hidden)]
pub mod hover_bindings {
    wit_bindgen::generate!({
        world: "hover", path: "wit", pub_export_macro: true,
        export_macro_name: "__export_hover_world",
        default_bindings_module: "openidea_plugin::hover_bindings",
        with: { "openidea:plugin/types@1.4.0": crate::bindings::openidea::plugin::types },
    });
}

#[cfg(target_arch = "wasm32")]
#[doc(hidden)]
pub mod commit_checks_bindings {
    wit_bindgen::generate!({
        world: "commit-checks", path: "wit", pub_export_macro: true,
        export_macro_name: "__export_commit_checks_world",
        default_bindings_module: "openidea_plugin::commit_checks_bindings",
        with: {
            "openidea:plugin/types@1.4.0": crate::bindings::openidea::plugin::types,
            "openidea:plugin/workspace@1.4.0": crate::bindings::openidea::plugin::workspace,
            "openidea:plugin/editor@1.4.0": crate::bindings::openidea::plugin::editor,
            "openidea:plugin/invocation@1.4.0": crate::bindings::openidea::plugin::invocation,
            "openidea:plugin/commit@1.4.0": crate::bindings::openidea::plugin::commit,
        },
    });
}

#[cfg(target_arch = "wasm32")]
#[doc(hidden)]
pub mod inlay_bindings {
    wit_bindgen::generate!({
        world: "inlay-hints", path: "wit", pub_export_macro: true,
        export_macro_name: "__export_inlay_hints_world",
        default_bindings_module: "openidea_plugin::inlay_bindings",
        with: { "openidea:plugin/types@1.4.0": crate::bindings::openidea::plugin::types },
    });
}

#[cfg(target_arch = "wasm32")]
#[doc(hidden)]
pub mod file_actions_bindings {
    wit_bindgen::generate!({
        world: "file-actions-provider", path: "wit", pub_export_macro: true,
        export_macro_name: "__export_file_actions_world",
        default_bindings_module: "openidea_plugin::file_actions_bindings",
        with: { "openidea:plugin/types@1.4.0": crate::bindings::openidea::plugin::types },
    });
}

#[cfg(target_arch = "wasm32")]
#[doc(hidden)]
pub mod endpoints_bindings {
    wit_bindgen::generate!({
        world: "endpoints", path: "wit", pub_export_macro: true,
        export_macro_name: "__export_endpoints_world",
        default_bindings_module: "openidea_plugin::endpoints_bindings",
        with: {
            "openidea:plugin/types@1.4.0": crate::bindings::openidea::plugin::types,
            "openidea:plugin/workspace@1.4.0": crate::bindings::openidea::plugin::workspace,
            "openidea:plugin/editor@1.4.0": crate::bindings::openidea::plugin::editor,
            "openidea:plugin/invocation@1.4.0": crate::bindings::openidea::plugin::invocation,
        },
    });
}

/// The plugin API version this SDK targets.
pub const API_VERSION: &str = "1.3";

/// A plugin. One instance lives as long as the plugin's Wasm instance (until
/// it is disabled, crashes or is reclaimed when idle).
pub trait Plugin: 'static {
    /// Called once when the instance is created: subscribe to events and
    /// restore state from [`host::storage`]. An error fails the activation.
    fn activate(&mut self, _ctx: &Context) -> Result<(), Error> {
        Ok(())
    }

    /// Called before the instance is dropped.
    fn deactivate(&mut self) {}

    /// Runs one of the plugin's commands; `Ok(Some(text))` is shown to the user.
    /// A plain message (`Err("…".into())`, or `?` on a `String` error) is
    /// [`Error::Failed`]; return [`Error::Cancelled`] when the user gave up.
    fn run_command(&mut self, id: &str, ctx: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error>;

    /// A batch of subscribed events (see [`host::subscribe`]), oldest first.
    fn handle_events(&mut self, _events: &[Event], _ctx: &Invocation) {}
}

/// Exports `T` (a [`Plugin`] + `Default`) as the plugin's component. With
/// `syntax`, `T` is also a [`syntax::SyntaxProvider`] for its languages.
#[macro_export]
macro_rules! register_plugin {
    ($plugin:ty $(, $export:ident)* $(,)?) => {
        // Natively (tests) nothing is exported; keep the type "used".
        #[cfg(not(target_arch = "wasm32"))]
        const _: fn() -> $plugin = <$plugin as ::core::default::Default>::default;
        #[cfg(target_arch = "wasm32")]
        const _: () = {
            struct __OpenideaComponent;
            $crate::__plugin_exports!($plugin, __OpenideaComponent, $crate::bindings);
            $($crate::__optional_exports!($export, $plugin, __OpenideaComponent);)*
    $crate::bindings::__export_plugin_world!(__OpenideaComponent with_types_in $crate::bindings);
        };
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __optional_exports {
    (injections, $plugin:ty, $component:ident) => { $crate::__injections_exports!($plugin, $component); };
    (language_features, $plugin:ty, $component:ident) => { $crate::__language_features_exports!($plugin, $component); };
    (mcp, $plugin:ty, $component:ident) => { $crate::__mcp_exports!($plugin, $component); };
    (run_configurations, $plugin:ty, $component:ident) => { $crate::__run_configurations_exports!($plugin, $component); };
    (test_results, $plugin:ty, $component:ident) => { $crate::__test_results_exports!($plugin, $component); };

    (providers, $plugin:ty, $component:ident) => {
        $crate::__providers_exports!($plugin, $component);
    };
    (views, $plugin:ty, $component:ident) => {
        $crate::__views_exports!($plugin, $component);
    };
    (indexing, $plugin:ty, $component:ident) => {
        $crate::__indexing_exports!($plugin, $component);
    };
    (semantic_tokens, $plugin:ty, $component:ident) => {
        $crate::__semantic_tokens_exports!($plugin, $component);
    };
    (file_actions, $plugin:ty, $component:ident) => {
        $crate::__file_actions_exports!($plugin, $component);
    };
    (endpoints, $plugin:ty, $component:ident) => {
        $crate::__endpoints_exports!($plugin, $component);
    };
    (details, $plugin:ty, $component:ident) => {
        $crate::__details_exports!($plugin, $component);
    };
    (diagnostics, $plugin:ty, $component:ident) => {
        $crate::__diagnostics_exports!($plugin, $component);
    };
    (hover, $plugin:ty, $component:ident) => {
        $crate::__hover_exports!($plugin, $component);
    };
    (commit_checks, $plugin:ty, $component:ident) => {
        $crate::__commit_checks_exports!($plugin, $component);
    };
    (inlay_hints, $plugin:ty, $component:ident) => {
        $crate::__inlay_hints_exports!($plugin, $component);
    };
    (syntax, $plugin:ty, $component:ident) => {
        impl $crate::syntax_bindings::exports::openidea::plugin::syntax_provider::Guest for $component {
            fn highlights(
                language: ::std::string::String,
                text: ::std::string::String,
            ) -> ::std::vec::Vec<$crate::syntax_bindings::exports::openidea::plugin::syntax_provider::Token>
            {
                $crate::__rt::highlights::<$plugin>(&language, &text)
            }

            fn outline(
                language: ::std::string::String,
                text: ::std::string::String,
            ) -> ::std::vec::Vec<$crate::syntax_bindings::exports::openidea::plugin::syntax_provider::Symbol>
            {
                $crate::__rt::outline::<$plugin>(&language, &text)
            }

            fn folding(
                language: ::std::string::String,
                text: ::std::string::String,
            ) -> ::std::vec::Vec<$crate::syntax_bindings::exports::openidea::plugin::syntax_provider::Fold>
            {
                $crate::__rt::folding::<$plugin>(&language, &text)
            }
        }

    $crate::syntax_bindings::__export_syntax_world!($component with_types_in $crate::syntax_bindings);
    };
}

/// `register_plugin!(T, providers)`: `T` is also a [`providers::Providers`].
#[doc(hidden)]
#[macro_export]
macro_rules! __providers_exports {
    ($plugin:ty, $component:ident) => {
        impl $crate::providers_bindings::exports::openidea::plugin::providers::Guest for $component {
            fn completion(
                doc: $crate::providers_bindings::exports::openidea::plugin::providers::Document,
                at: $crate::bindings::openidea::plugin::types::Position,
                trigger: ::core::option::Option<::std::string::String>,
            ) -> ::std::vec::Vec<$crate::providers_bindings::exports::openidea::plugin::providers::CompletionItem> {
                $crate::__rt::completion::<$plugin>(doc, at, trigger)
            }

            fn inline_completion(
                doc: $crate::providers_bindings::exports::openidea::plugin::providers::Document,
                at: $crate::bindings::openidea::plugin::types::Position,
            ) -> ::core::option::Option<$crate::providers_bindings::exports::openidea::plugin::providers::InlineSuggestion> {
                $crate::__rt::inline_completion::<$plugin>(doc, at)
            }

            fn code_actions(
                doc: $crate::providers_bindings::exports::openidea::plugin::providers::Document,
                selection: $crate::bindings::openidea::plugin::types::Range,
            ) -> ::std::vec::Vec<$crate::providers_bindings::exports::openidea::plugin::providers::CodeAction> {
                $crate::__rt::code_actions::<$plugin>(doc, selection)
            }

            fn resolve_code_action(
                doc: $crate::providers_bindings::exports::openidea::plugin::providers::Document,
                action: $crate::providers_bindings::exports::openidea::plugin::providers::CodeAction,
            ) -> ::core::result::Result<
                $crate::providers_bindings::exports::openidea::plugin::providers::CodeAction,
                $crate::bindings::openidea::plugin::types::Error,
            > {
                $crate::__rt::resolve_code_action::<$plugin>(doc, action)
            }

            fn definition(
                doc: $crate::providers_bindings::exports::openidea::plugin::providers::Document,
                at: $crate::bindings::openidea::plugin::types::Position,
            ) -> ::std::vec::Vec<$crate::bindings::openidea::plugin::types::Location> {
                $crate::__rt::definition::<$plugin>(doc, at)
            }

            fn line_markers(
                doc: $crate::providers_bindings::exports::openidea::plugin::providers::Document,
            ) -> ::std::vec::Vec<$crate::providers_bindings::exports::openidea::plugin::providers::LineMarker> {
                $crate::__rt::line_markers::<$plugin>(doc)
            }
        }

        $crate::providers_bindings::__export_editor_providers_world!($component with_types_in $crate::providers_bindings);
    };
}

/// `register_plugin!(T, views)`: `T` is also a [`views::Views`].
#[doc(hidden)]
#[macro_export]
macro_rules! __views_exports {
    ($plugin:ty, $component:ident) => {
        impl $crate::views_bindings::exports::openidea::plugin::view_provider::Guest for $component {
            fn render(
                view: ::std::string::String,
                viewport: ::core::option::Option<$crate::views_bindings::openidea::plugin::view_types::Viewport>,
                ctx: &$crate::bindings::openidea::plugin::invocation::Invocation,
            ) -> ::core::result::Result<
                $crate::views_bindings::openidea::plugin::view_types::View,
                $crate::bindings::openidea::plugin::types::Error,
            > {
                $crate::__rt::render_view::<$plugin>(view, viewport, ctx)
            }

            fn handle(
                view: ::std::string::String,
                event: $crate::views_bindings::openidea::plugin::view_types::ViewEvent,
                ctx: &$crate::bindings::openidea::plugin::invocation::Invocation,
            ) -> ::core::result::Result<(), $crate::bindings::openidea::plugin::types::Error> {
                $crate::__rt::view_event::<$plugin>(view, event, ctx)
            }
        }

        $crate::views_bindings::__export_views_world!($component with_types_in $crate::views_bindings);
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __file_actions_exports {
    ($plugin:ty, $component:ident) => {
        impl $crate::file_actions_bindings::exports::openidea::plugin::file_actions::Guest for $component {
            fn code_actions(
                doc: $crate::file_actions_bindings::exports::openidea::plugin::file_actions::Document,
                selection: $crate::bindings::openidea::plugin::types::Range,
            ) -> ::std::vec::Vec<$crate::file_actions_bindings::exports::openidea::plugin::file_actions::FileAction> {
                $crate::__rt::file_actions::<$plugin>(doc, selection)
            }

            fn resolve(
                doc: $crate::file_actions_bindings::exports::openidea::plugin::file_actions::Document,
                action: $crate::file_actions_bindings::exports::openidea::plugin::file_actions::FileAction,
            ) -> ::core::result::Result<
                $crate::file_actions_bindings::exports::openidea::plugin::file_actions::FileAction,
                $crate::bindings::openidea::plugin::types::Error,
            > {
                $crate::__rt::resolve_file_action::<$plugin>(doc, action)
            }
        }
        $crate::file_actions_bindings::__export_file_actions_world!($component with_types_in $crate::file_actions_bindings);
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __indexing_exports {
    ($plugin:ty, $component:ident) => {
        impl $crate::indexing_bindings::exports::openidea::plugin::document_indexer::Guest for $component {
            fn index(doc: $crate::indexing_bindings::exports::openidea::plugin::document_indexer::Document)
                -> $crate::indexing_bindings::exports::openidea::plugin::document_indexer::Edges {
                $crate::__rt::index_document::<$plugin>(doc)
            }
        }
        $crate::indexing_bindings::__export_indexing_world!($component with_types_in $crate::indexing_bindings);
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __endpoints_exports {
    ($plugin:ty, $component:ident) => {
        impl $crate::endpoints_bindings::exports::openidea::plugin::endpoints_provider::Guest for $component {
            fn endpoints(ctx: &$crate::bindings::openidea::plugin::invocation::Invocation) -> ::core::result::Result<
                ::std::vec::Vec<$crate::endpoints_bindings::exports::openidea::plugin::endpoints_provider::Endpoint>,
                $crate::bindings::openidea::plugin::types::Error,
            > {
                $crate::__rt::endpoints::<$plugin>(ctx)
            }
        }
        $crate::endpoints_bindings::__export_endpoints_world!($component with_types_in $crate::endpoints_bindings);
    };
}

/// `register_plugin!(T, details)`: `T` is also a [`details::Details`].
#[doc(hidden)]
#[macro_export]
macro_rules! __details_exports {
    ($plugin:ty, $component:ident) => {
        impl $crate::details_bindings::exports::openidea::plugin::detail_provider::Guest for $component {
            fn detail(
                view: ::std::string::String,
                key: ::std::string::String,
                ctx: &$crate::bindings::openidea::plugin::invocation::Invocation,
            ) -> ::core::result::Result<
                ::std::vec::Vec<$crate::details_bindings::openidea::plugin::detail_types::Tab>,
                $crate::bindings::openidea::plugin::types::Error,
            > {
                $crate::__rt::service_detail::<$plugin>(view, key, ctx)
            }
        }
        $crate::details_bindings::__export_details_world!($component with_types_in $crate::details_bindings);
    };
}

/// `register_plugin!(T, commit_checks)`: `T` is also a [`commit::CommitChecks`].
#[doc(hidden)]
#[macro_export]
macro_rules! __commit_checks_exports {
    ($plugin:ty, $component:ident) => {
        impl $crate::commit_checks_bindings::exports::openidea::plugin::commit_checker::Guest for $component {
            fn check(
                check: ::std::string::String,
                draft: $crate::bindings::openidea::plugin::commit::CommitDraft,
                ctx: &$crate::bindings::openidea::plugin::invocation::Invocation,
            ) -> ::core::result::Result<
                ::std::vec::Vec<$crate::commit_checks_bindings::exports::openidea::plugin::commit_checker::CommitProblem>,
                $crate::bindings::openidea::plugin::types::Error,
            > {
                $crate::__rt::commit_check::<$plugin>(check, draft, ctx)
            }
        }
        $crate::commit_checks_bindings::__export_commit_checks_world!($component with_types_in $crate::commit_checks_bindings);
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __semantic_tokens_exports {
    ($plugin:ty, $component:ident) => {
        impl $crate::semantic_bindings::exports::openidea::plugin::semantic_tokens_provider::Guest for $component {
            fn semantic_tokens(
                doc: $crate::semantic_bindings::exports::openidea::plugin::semantic_tokens_provider::Document,
            ) -> ::std::vec::Vec<
                $crate::semantic_bindings::exports::openidea::plugin::semantic_tokens_provider::SemanticToken,
            > {
                $crate::__rt::semantic_tokens::<$plugin>(doc)
            }
        }
        $crate::semantic_bindings::__export_semantic_tokens_world!($component with_types_in $crate::semantic_bindings);
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __diagnostics_exports {
    ($plugin:ty, $component:ident) => {
        impl $crate::diagnostics_bindings::exports::openidea::plugin::diagnostics_provider::Guest for $component {
            fn diagnostics(
                doc: $crate::diagnostics_bindings::exports::openidea::plugin::diagnostics_provider::Document,
            ) -> ::std::vec::Vec<$crate::bindings::openidea::plugin::diagnostics::Diagnostic> {
                $crate::__rt::diagnostics::<$plugin>(doc)
            }
        }
        $crate::diagnostics_bindings::__export_diagnostics_world!($component with_types_in $crate::diagnostics_bindings);
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __hover_exports {
    ($plugin:ty, $component:ident) => {
        impl $crate::hover_bindings::exports::openidea::plugin::hover_provider::Guest for $component {
            fn hover(
                doc: $crate::hover_bindings::exports::openidea::plugin::hover_provider::Document,
                at: $crate::bindings::openidea::plugin::types::Position,
            ) -> ::core::option::Option<$crate::hover_bindings::exports::openidea::plugin::hover_provider::HoverContent> {
                $crate::__rt::hover::<$plugin>(doc, at)
            }
        }
        $crate::hover_bindings::__export_hover_world!($component with_types_in $crate::hover_bindings);
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __inlay_hints_exports {
    ($plugin:ty, $component:ident) => {
        impl $crate::inlay_bindings::exports::openidea::plugin::inlay_hints_provider::Guest for $component {
            fn inlay_hints(
                doc: $crate::inlay_bindings::exports::openidea::plugin::inlay_hints_provider::Document,
                range: $crate::bindings::openidea::plugin::types::Range,
            ) -> ::std::vec::Vec<$crate::inlay_bindings::exports::openidea::plugin::inlay_hints_provider::InlayHint> {
                $crate::__rt::inlay_hints::<$plugin>(doc, range)
            }
        }
        $crate::inlay_bindings::__export_inlay_hints_world!($component with_types_in $crate::inlay_bindings);
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __plugin_exports {
    ($plugin:ty, $component:ident, $b:path) => {
        impl $crate::bindings::exports::openidea::plugin::lifecycle::Guest for $component {
            fn activate(
                ctx: $crate::bindings::openidea::plugin::types::Context,
            ) -> ::core::result::Result<(), $crate::bindings::openidea::plugin::types::Error> {
                $crate::__rt::activate::<$plugin>(ctx)
            }

            fn deactivate() {
                $crate::__rt::deactivate::<$plugin>()
            }
        }

        impl $crate::bindings::exports::openidea::plugin::commands::Guest for $component {
            fn run(
                id: ::std::string::String,
                ctx: &$crate::bindings::openidea::plugin::invocation::Invocation,
                arg: ::core::option::Option<::std::string::String>,
            ) -> ::core::result::Result<
                ::core::option::Option<::std::string::String>,
                $crate::bindings::openidea::plugin::types::Error,
            > {
                $crate::__rt::run_command::<$plugin>(id, ctx, arg)
            }
        }

        impl $crate::bindings::exports::openidea::plugin::event_handler::Guest for $component {
            fn handle(
                events: ::std::vec::Vec<$crate::bindings::openidea::plugin::events::Event>,
                ctx: &$crate::bindings::openidea::plugin::invocation::Invocation,
            ) {
                $crate::__rt::handle_events::<$plugin>(events, ctx)
            }
        }
    };
}

#[cfg(target_arch = "wasm32")]
#[doc(hidden)]
pub mod __rt {
    //! The single plugin instance behind the exports.
    use super::syntax::SyntaxProvider;
    use super::{Context, Invocation, Plugin};
    use crate::bindings::openidea::plugin as b;
    use crate::syntax_bindings::exports::openidea::plugin::syntax_provider as wit;
    use std::any::Any;
    use std::cell::RefCell;

    thread_local! {
        static INSTANCE: RefCell<Option<Box<dyn Any>>> = const { RefCell::new(None) };
    }

    pub(crate) fn with<T: Plugin + Default, R>(f: impl FnOnce(&mut T) -> R) -> R {
        INSTANCE.with(|cell| {
            let mut slot = cell.borrow_mut();
            let plugin = slot.get_or_insert_with(|| Box::new(T::default()));
            f(plugin.downcast_mut::<T>().expect("one plugin type per component"))
        })
    }

    pub fn activate<T: Plugin + Default>(ctx: b::types::Context) -> Result<(), b::types::Error> {
        let ctx = Context {
            plugin_id: ctx.plugin_id,
            plugin_version: ctx.plugin_version,
            api_version: ctx.api_version,
            capabilities: ctx.capabilities,
        };
        with::<T, _>(|p| p.activate(&ctx)).map_err(error_out)
    }

    pub fn deactivate<T: Plugin + Default>() {
        with::<T, _>(|p| p.deactivate());
        INSTANCE.with(|cell| cell.borrow_mut().take());
    }

    pub fn run_command<T: Plugin + Default>(
        id: String,
        ctx: &b::invocation::Invocation,
        arg: Option<String>,
    ) -> Result<Option<String>, b::types::Error> {
        let ctx = Invocation::__new(ctx);
        with::<T, _>(|p| p.run_command(&id, &ctx, arg.as_deref())).map_err(error_out)
    }

    // ---- providers ----

    use crate::providers as p;
    use crate::providers_bindings::exports::openidea::plugin::providers as w;

    fn doc(d: w::Document) -> p::Document {
        p::Document { path: d.path, language: d.language, version: d.version, text: d.text }
    }

    fn at(p: b::types::Position) -> crate::Position {
        crate::Position::new(p.line, p.character)
    }

    fn loc(l: crate::Location) -> b::types::Location {
        b::types::Location { path: l.path, range: crate::host::__range_to(l.range) }
    }

    pub fn completion<T: Plugin + p::Providers + Default>(
        d: w::Document,
        pos: b::types::Position,
        trigger: Option<String>,
    ) -> Vec<w::CompletionItem> {
        let d = doc(d);
        with::<T, _>(|x| x.completion(&d, at(pos), trigger.as_deref()))
            .into_iter()
            .map(|i| w::CompletionItem {
                label: i.label,
                detail: i.detail,
                kind: i.kind.map(|k| k.as_str().to_owned()),
                insert_text: i.insert_text,
                snippet: i.snippet,
                replace: i.replace.map(crate::host::__range_to),
                sort_text: i.sort_text,
                filter_text: i.filter_text,
                documentation: i.documentation,
                additional_edits: i.additional_edits.into_iter().map(edit_out).collect(),
            })
            .collect()
    }

    pub fn inline_completion<T: Plugin + p::Providers + Default>(
        d: w::Document,
        pos: b::types::Position,
    ) -> Option<w::InlineSuggestion> {
        let d = doc(d);
        with::<T, _>(|x| x.inline_completion(&d, at(pos))).map(|s| w::InlineSuggestion {
            insert_text: s.insert_text,
            replace: s.replace.map(crate::host::__range_to),
        })
    }

    pub fn code_actions<T: Plugin + p::Providers + Default>(
        d: w::Document,
        sel: b::types::Range,
    ) -> Vec<w::CodeAction> {
        let d = doc(d);
        with::<T, _>(|x| x.code_actions(&d, crate::host::__range_from(sel))).into_iter().map(action_out).collect()
    }

    pub fn resolve_code_action<T: Plugin + p::Providers + Default>(
        d: w::Document,
        action: w::CodeAction,
    ) -> Result<w::CodeAction, b::types::Error> {
        let d = doc(d);
        with::<T, _>(|x| x.resolve_code_action(&d, action_in(action))).map(action_out).map_err(error_out)
    }

    fn edit_out(e: crate::TextEdit) -> b::types::TextEdit {
        b::types::TextEdit { range: crate::host::__range_to(e.range), text: e.text }
    }

    fn action_out(a: p::CodeAction) -> w::CodeAction {
        w::CodeAction {
            title: a.title,
            kind: a.kind,
            preferred: a.preferred,
            edits: a
                .edits
                .into_iter()
                .map(|(path, edits)| w::FileEdit { path, edits: edits.into_iter().map(edit_out).collect() })
                .collect(),
            data: a.data,
        }
    }

    fn action_in(a: w::CodeAction) -> p::CodeAction {
        p::CodeAction {
            title: a.title,
            kind: a.kind,
            preferred: a.preferred,
            edits: a
                .edits
                .into_iter()
                .map(|f| {
                    let edits = f
                        .edits
                        .into_iter()
                        .map(|e| crate::TextEdit { range: crate::host::__range_from(e.range), text: e.text })
                        .collect();
                    (f.path, edits)
                })
                .collect(),
            data: a.data,
        }
    }

    pub fn definition<T: Plugin + p::Providers + Default>(
        d: w::Document,
        pos: b::types::Position,
    ) -> Vec<b::types::Location> {
        let d = doc(d);
        with::<T, _>(|x| x.definition(&d, at(pos))).into_iter().map(loc).collect()
    }

    pub fn line_markers<T: Plugin + p::Providers + Default>(d: w::Document) -> Vec<w::LineMarker> {
        let d = doc(d);
        with::<T, _>(|x| x.line_markers(&d))
            .into_iter()
            .map(|m| w::LineMarker { line: m.line, icon: m.icon, tooltip: m.tooltip, target: m.target.map(loc) })
            .collect()
    }

    pub fn index_document<T: Plugin + crate::indexing::DocumentIndexer + Default>(
        d: crate::indexing_bindings::exports::openidea::plugin::document_indexer::Document,
    ) -> crate::indexing_bindings::exports::openidea::plugin::document_indexer::Edges {
        use crate::indexing as i;
        use crate::indexing_bindings::exports::openidea::plugin::document_indexer as w;
        let doc = i::Document {
            path: d.path,
            text: d.text,
            symbols: d
                .symbols
                .into_iter()
                .map(|s| i::Symbol {
                    name: s.name,
                    kind: s.kind,
                    container: s.container,
                    range: crate::host::__range_from(s.range),
                })
                .collect(),
        };
        let e = with::<T, _>(|p| p.index(&doc));
        fn anchor(a: i::Anchor) -> w::Anchor {
            w::Anchor { key: a.key, range: crate::host::__range_to(a.range) }
        }
        w::Edges {
            definitions: e.definitions.into_iter().map(anchor).collect(),
            references: e.references.into_iter().map(anchor).collect(),
            aliases: e.aliases.into_iter().map(|a| w::Alias { prefix: a.prefix, target: a.target }).collect(),
            markers: e.markers.into_iter().map(anchor).collect(),
        }
    }

    pub fn semantic_tokens<T: Plugin + crate::semantic_tokens::SemanticTokens + Default>(
        d: crate::semantic_bindings::exports::openidea::plugin::semantic_tokens_provider::Document,
    ) -> Vec<crate::semantic_bindings::exports::openidea::plugin::semantic_tokens_provider::SemanticToken> {
        use crate::semantic_bindings::exports::openidea::plugin::semantic_tokens_provider as w;
        let doc = crate::providers::Document { path: d.path, language: d.language, version: d.version, text: d.text };
        with::<T, _>(|p| p.semantic_tokens(&doc))
            .into_iter()
            .map(|t| w::SemanticToken {
                range: crate::host::__range_to(t.range),
                kind: t.kind.as_str().into(),
                modifiers: t.modifiers.into_iter().map(|m| m.as_str().into()).collect(),
            })
            .collect()
    }

    pub fn diagnostics<T: Plugin + crate::diagnostics::DiagnosticsProvider + Default>(
        d: crate::diagnostics_bindings::exports::openidea::plugin::diagnostics_provider::Document,
    ) -> Vec<b::diagnostics::Diagnostic> {
        let doc = crate::providers::Document { path: d.path, language: d.language, version: d.version, text: d.text };
        with::<T, _>(|p| p.diagnostics(&doc)).iter().map(crate::host::__diagnostic_to).collect()
    }

    pub fn hover<T: Plugin + crate::hover::HoverProvider + Default>(
        d: crate::hover_bindings::exports::openidea::plugin::hover_provider::Document,
        pos: b::types::Position,
    ) -> Option<crate::hover_bindings::exports::openidea::plugin::hover_provider::HoverContent> {
        use crate::hover_bindings::exports::openidea::plugin::hover_provider as w;
        let doc = crate::providers::Document { path: d.path, language: d.language, version: d.version, text: d.text };
        with::<T, _>(|p| p.hover(&doc, at(pos)))
            .map(|h| w::HoverContent { markdown: h.markdown, range: h.range.map(crate::host::__range_to) })
    }

    pub fn inlay_hints<T: Plugin + crate::inlay_hints::InlayHints + Default>(
        d: crate::inlay_bindings::exports::openidea::plugin::inlay_hints_provider::Document,
        range: b::types::Range,
    ) -> Vec<crate::inlay_bindings::exports::openidea::plugin::inlay_hints_provider::InlayHint> {
        use crate::inlay_bindings::exports::openidea::plugin::inlay_hints_provider as w;
        let doc = crate::providers::Document { path: d.path, language: d.language, version: d.version, text: d.text };
        with::<T, _>(|p| p.inlay_hints(&doc, crate::host::__range_from(range)))
            .into_iter()
            .map(|h| w::InlayHint {
                position: b::types::Position { line: h.position.line, character: h.position.character },
                label: h.label,
                kind: h.kind.as_str().into(),
                tooltip: h.tooltip,
                padding_left: h.padding_left,
                padding_right: h.padding_right,
            })
            .collect()
    }

    pub fn file_actions<T: Plugin + crate::file_actions::FileActions + Default>(
        d: crate::file_actions_bindings::exports::openidea::plugin::file_actions::Document,
        sel: b::types::Range,
    ) -> Vec<crate::file_actions_bindings::exports::openidea::plugin::file_actions::FileAction> {
        let doc = file_doc(d);
        let actions = with::<T, _>(|x| x.file_actions(&doc, crate::host::__range_from(sel)));
        actions.into_iter().map(file_action_out).collect()
    }

    pub fn resolve_file_action<T: Plugin + crate::file_actions::FileActions + Default>(
        d: crate::file_actions_bindings::exports::openidea::plugin::file_actions::Document,
        action: crate::file_actions_bindings::exports::openidea::plugin::file_actions::FileAction,
    ) -> Result<crate::file_actions_bindings::exports::openidea::plugin::file_actions::FileAction, b::types::Error>
    {
        let doc = file_doc(d);
        with::<T, _>(|x| x.resolve_file_action(&doc, file_action_in(action))).map(file_action_out).map_err(error_out)
    }

    fn file_doc(d: crate::file_actions_bindings::exports::openidea::plugin::file_actions::Document) -> p::Document {
        p::Document { path: d.path, language: d.language, version: d.version, text: d.text }
    }

    fn file_action_out(
        a: crate::file_actions::FileAction,
    ) -> crate::file_actions_bindings::exports::openidea::plugin::file_actions::FileAction {
        use crate::file_actions as f;
        use crate::file_actions_bindings::exports::openidea::plugin::file_actions as w;
        w::FileAction {
            title: a.title,
            kind: a.kind,
            preferred: a.preferred,
            operations: a
                .operations
                .into_iter()
                .map(|op| match op {
                    f::FileOperation::Create { path, text, overwrite } => {
                        w::FileOperation::Create(w::CreateFile { path, text, overwrite })
                    }
                    f::FileOperation::Rename { from, to } => {
                        w::FileOperation::Rename(w::RenameFile { path: from, new_path: to })
                    }
                    f::FileOperation::Delete { path } => w::FileOperation::Delete(w::DeleteFile { path }),
                })
                .collect(),
            edits: a
                .edits
                .into_iter()
                .map(|(path, edits)| w::FileEdit { path, edits: edits.into_iter().map(edit_out).collect() })
                .collect(),
            open: a.open,
            data: a.data,
        }
    }

    fn file_action_in(
        a: crate::file_actions_bindings::exports::openidea::plugin::file_actions::FileAction,
    ) -> crate::file_actions::FileAction {
        use crate::file_actions as f;
        use crate::file_actions_bindings::exports::openidea::plugin::file_actions as w;
        f::FileAction {
            title: a.title,
            kind: a.kind,
            preferred: a.preferred,
            operations: a
                .operations
                .into_iter()
                .map(|op| match op {
                    w::FileOperation::Create(c) => {
                        f::FileOperation::Create { path: c.path, text: c.text, overwrite: c.overwrite }
                    }
                    w::FileOperation::Rename(r) => f::FileOperation::Rename { from: r.path, to: r.new_path },
                    w::FileOperation::Delete(d) => f::FileOperation::Delete { path: d.path },
                })
                .collect(),
            edits: a
                .edits
                .into_iter()
                .map(|f| {
                    let edits = f
                        .edits
                        .into_iter()
                        .map(|e| crate::TextEdit { range: crate::host::__range_from(e.range), text: e.text })
                        .collect();
                    (f.path, edits)
                })
                .collect(),
            open: a.open,
            data: a.data,
        }
    }

    // ---- views ----

    use crate::views as v;
    use crate::views_bindings::openidea::plugin::view_types as vt;

    fn error_out(e: crate::Error) -> b::types::Error {
        use b::types::Error as E;
        match e {
            crate::Error::Denied(c) => E::Denied(c),
            crate::Error::Stale => E::Stale,
            crate::Error::NotFound(m) => E::NotFound(m),
            crate::Error::Invalid(m) => E::Invalid(m),
            crate::Error::Cancelled => E::Cancelled,
            crate::Error::Failed(m) => E::Failed(m),
        }
    }

    fn view_out(view: v::View) -> vt::View {
        let body = match view.body {
            v::Body::Message(m) => vt::Body::Message(m),
            v::Body::Tree(items) => vt::Body::Tree(
                items
                    .into_iter()
                    .map(|i| vt::TreeItem {
                        key: i.key,
                        parent: i.parent,
                        label: i.label,
                        icon: i.icon,
                        detail: i.detail,
                        expandable: i.expandable,
                        expanded: i.expanded,
                    })
                    .collect(),
            ),
            v::Body::List(items) => vt::Body::List(
                items
                    .into_iter()
                    .map(|i| vt::ListItem { key: i.key, label: i.label, icon: i.icon, detail: i.detail })
                    .collect(),
            ),
            v::Body::Form(fields) => vt::Body::Form(
                fields
                    .into_iter()
                    .map(|f| vt::Field {
                        key: f.key,
                        label: f.label,
                        value: match f.value {
                            v::FieldValue::Text(t) => vt::FieldValue::Text(t),
                            v::FieldValue::Multiline(t) => vt::FieldValue::Multiline(t),
                            v::FieldValue::Checkbox(c) => vt::FieldValue::Checkbox(c),
                            v::FieldValue::Choice(o, s) => vt::FieldValue::Choice((o, s)),
                            v::FieldValue::Other { kind, data } => {
                                vt::FieldValue::Other(b::types::Extension { kind, data })
                            }
                        },
                    })
                    .collect(),
            ),
            v::Body::Table(t) => vt::Body::Table(vt::Table {
                columns: t.columns,
                total_rows: t.total_rows,
                first_row: t.first_row,
                rows: t.rows,
                editable: t.editable,
            }),
            v::Body::Html(h) => vt::Body::Html(h),
            v::Body::Other { kind, data } => vt::Body::Other(b::types::Extension { kind, data }),
        };
        vt::View {
            toolbar: view
                .toolbar
                .into_iter()
                .map(|b| vt::Button { id: b.id, label: b.label, icon: b.icon, enabled: b.enabled })
                .collect(),
            body,
            status: view.status,
        }
    }

    pub fn render_view<T: Plugin + v::Views + Default>(
        view: String,
        viewport: Option<vt::Viewport>,
        ctx: &b::invocation::Invocation,
    ) -> Result<vt::View, b::types::Error> {
        let ctx = Invocation::__new(ctx);
        let viewport = viewport.map(|v| v::Viewport { first_row: v.first_row, rows: v.rows });
        with::<T, _>(|p| p.render(&view, viewport, &ctx)).map(view_out).map_err(error_out)
    }

    pub fn mcp_call<T: Plugin + crate::McpProvider + Default>(
        tool: &str,
        arguments: &str,
        ctx: &b::invocation::Invocation,
    ) -> Result<String, b::types::Error> {
        let ctx = Invocation::__new(ctx);
        with::<T, _>(|p| p.call(tool, arguments, &ctx)).map_err(error_out)
    }

    pub fn configurations<T: Plugin + crate::RunConfigurations + Default>(
        root: &str,
    ) -> Vec<crate::run_configurations_bindings::exports::openidea::plugin::run_configurations::RunConfiguration> {
        use crate::run_configurations_bindings::exports::openidea::plugin::run_configurations::RunConfiguration as C;
        with::<T, _>(|p| p.configurations(root))
            .into_iter()
            .map(|c| C {
                id: c.id,
                name: c.name,
                program: c.program,
                args: c.args,
                cwd: c.cwd,
                test: c.test,
                framework: c.framework,
            })
            .collect()
    }
    pub fn select_tests<T: Plugin + crate::TestResults + Default>(
        config: &str,
        tests: &[Vec<String>],
    ) -> Option<Vec<String>> {
        with::<T, _>(|p| p.select_tests(config, tests))
    }
    pub fn test_results<T: Plugin + crate::TestResults + Default>(
        config: &str,
        chunk: &str,
    ) -> Vec<crate::test_results_bindings::exports::openidea::plugin::test_results::TestEvent> {
        use crate::PluginTestEvent as E;
        use crate::test_results_bindings::exports::openidea::plugin::test_results as w;
        let location = |l: crate::Location| b::types::Location {
            path: l.path,
            range: b::types::Range {
                start: b::types::Position { line: l.range.start.line, character: l.range.start.character },
                end: b::types::Position { line: l.range.end.line, character: l.range.end.character },
            },
        };
        let start = |v: crate::TestStart| w::TestStart {
            id: v.id,
            parent: v.parent,
            name: v.name,
            location: v.location.map(location),
        };
        with::<T, _>(|p| p.parse(config, chunk))
            .into_iter()
            .map(|event| match event {
                E::SuiteStarted(v) => w::TestEvent::SuiteStarted(start(v)),
                E::TestStarted(v) => w::TestEvent::TestStarted(start(v)),
                E::Passed(v) => w::TestEvent::Passed(w::TestPassed { id: v.id, duration_ms: v.duration_ms }),
                E::Failed(v) => w::TestEvent::Failed(w::TestFailed {
                    id: v.id,
                    duration_ms: v.duration_ms,
                    message: v.message,
                    expected: v.expected,
                    actual: v.actual,
                    location: v.location.map(location),
                }),
                E::Skipped(v) => w::TestEvent::Skipped(w::TestSkipped { id: v.id, reason: v.reason }),
                E::Output(v) => w::TestEvent::Output(w::TestOutput { id: v.id, text: v.text }),
                E::Other { kind, data } => w::TestEvent::Other(b::types::Extension { kind, data }),
            })
            .collect()
    }

    pub fn endpoints<T: Plugin + crate::endpoints::EndpointsProvider + Default>(
        ctx: &b::invocation::Invocation,
    ) -> Result<Vec<crate::endpoints_bindings::exports::openidea::plugin::endpoints_provider::Endpoint>, b::types::Error>
    {
        use crate::endpoints_bindings::exports::openidea::plugin::endpoints_provider as w;
        let ctx = Invocation::__new(ctx);
        with::<T, _>(|p| p.endpoints(&ctx))
            .map(|items| {
                items
                    .into_iter()
                    .map(|e| w::Endpoint {
                        method: e.method,
                        path: e.path,
                        framework: e.framework,
                        handler: e.handler,
                        location: loc(e.location),
                    })
                    .collect()
            })
            .map_err(error_out)
    }

    pub fn service_detail<T: Plugin + crate::details::Details + Default>(
        view: String,
        key: String,
        ctx: &b::invocation::Invocation,
    ) -> Result<Vec<crate::details_bindings::openidea::plugin::detail_types::Tab>, b::types::Error> {
        use crate::details as s;
        use crate::details_bindings::openidea::plugin::detail_types as w;
        let ctx = Invocation::__new(ctx);
        let tab = |t: s::Tab| w::Tab {
            id: t.id,
            label: t.label,
            body: match t.body {
                s::Pane::Message(m) => w::Pane::Message(m),
                s::Pane::Text(text) => w::Pane::Text(text),
                s::Pane::Log(log) => w::Pane::Log(w::ProcessLog {
                    program: log.program,
                    args: log.args,
                    toggles: log
                        .toggles
                        .into_iter()
                        .map(|t| w::LogToggle { id: t.id, label: t.label, args: t.args })
                        .collect(),
                }),
            },
        };
        with::<T, _>(|p| p.detail(&view, &key, &ctx)).map(|tabs| tabs.into_iter().map(tab).collect()).map_err(error_out)
    }

    pub fn commit_check<T: Plugin + crate::commit::CommitChecks + Default>(
        check: String,
        draft: b::commit::CommitDraft,
        ctx: &b::invocation::Invocation,
    ) -> Result<
        Vec<crate::commit_checks_bindings::exports::openidea::plugin::commit_checker::CommitProblem>,
        b::types::Error,
    > {
        use crate::commit_checks_bindings::exports::openidea::plugin::commit_checker as w;
        let ctx = Invocation::__new(ctx);
        let draft = crate::host::__draft_in(draft);
        with::<T, _>(|p| p.check(&check, &draft, &ctx))
            .map(|problems| {
                problems
                    .into_iter()
                    .map(|p| w::CommitProblem { message: p.message, location: p.location.map(loc) })
                    .collect()
            })
            .map_err(error_out)
    }

    pub fn view_event<T: Plugin + v::Views + Default>(
        view: String,
        event: vt::ViewEvent,
        ctx: &b::invocation::Invocation,
    ) -> Result<(), b::types::Error> {
        let ctx = Invocation::__new(ctx);
        let event = match event {
            vt::ViewEvent::Button(id) => v::ViewEvent::Button(id),
            vt::ViewEvent::Activate(k) => v::ViewEvent::Activate(k),
            vt::ViewEvent::Select(k) => v::ViewEvent::Select(k),
            vt::ViewEvent::Expand(k) => v::ViewEvent::Expand(k),
            vt::ViewEvent::Collapse(k) => v::ViewEvent::Collapse(k),
            vt::ViewEvent::Field((k, value)) => v::ViewEvent::Field(k, value),
            vt::ViewEvent::Cell(c) => v::ViewEvent::Cell { row: c.row, column: c.column, value: c.value },
            vt::ViewEvent::InsertRow(r) => v::ViewEvent::InsertRow(r),
            vt::ViewEvent::DeleteRows(r) => v::ViewEvent::DeleteRows(r),
            vt::ViewEvent::Message(m) => v::ViewEvent::Message(m),
            vt::ViewEvent::Other(x) => v::ViewEvent::Other { kind: x.kind, data: x.data },
        };
        with::<T, _>(|p| p.handle(&view, event, &ctx)).map_err(error_out)
    }

    pub fn handle_events<T: Plugin + Default>(events: Vec<b::events::Event>, ctx: &b::invocation::Invocation) {
        let events: Vec<crate::Event> = events.into_iter().map(crate::host::__event).collect();
        let ctx = Invocation::__new(ctx);
        with::<T, _>(|p| p.handle_events(&events, &ctx))
    }

    fn offset(n: usize) -> u32 {
        u32::try_from(n).unwrap_or(u32::MAX)
    }

    pub fn highlights<T: Plugin + SyntaxProvider + Default>(language: &str, text: &str) -> Vec<wit::Token> {
        with::<T, _>(|p| p.highlights(language, text))
            .into_iter()
            .map(|t| wit::Token { start: offset(t.range.start), end: offset(t.range.end), kind: t.kind.name().into() })
            .collect()
    }

    pub fn outline<T: Plugin + SyntaxProvider + Default>(language: &str, text: &str) -> Vec<wit::Symbol> {
        with::<T, _>(|p| p.outline(language, text))
            .into_iter()
            .map(|s| wit::Symbol {
                name: s.name,
                detail: s.detail,
                kind: s.kind.name().into(),
                start: offset(s.range.start),
                end: offset(s.range.end),
                name_start: offset(s.name_range.start),
                name_end: offset(s.name_range.end),
                parent: s.parent.map(offset),
            })
            .collect()
    }

    pub fn folding<T: Plugin + SyntaxProvider + Default>(language: &str, text: &str) -> Vec<wit::Fold> {
        with::<T, _>(|p| p.folding(language, text))
            .into_iter()
            .map(|f| wit::Fold {
                start_line: f.start_line,
                end_line: f.end_line,
                kind: match f.kind {
                    super::syntax::FoldKind::Region => "region",
                    super::syntax::FoldKind::Comment => "comment",
                    super::syntax::FoldKind::Imports => "imports",
                }
                .into(),
            })
            .collect()
    }
}

pub mod execution;
pub use execution::*;

#[cfg(target_arch = "wasm32")]
#[doc(hidden)]
pub mod run_configurations_bindings {
    wit_bindgen::generate!({ world: "configurations-provider", path: "wit", pub_export_macro: true,
        export_macro_name: "__export_configurations_world", default_bindings_module: "openidea_plugin::run_configurations_bindings" });
}
#[cfg(target_arch = "wasm32")]
#[doc(hidden)]
pub mod test_results_bindings {
    wit_bindgen::generate!({ world: "test-results-provider", path: "wit", pub_export_macro: true,
        export_macro_name: "__export_tests_world", default_bindings_module: "openidea_plugin::test_results_bindings",
        with: { "openidea:plugin/types@1.4.0": crate::bindings::openidea::plugin::types },
    });
}
#[doc(hidden)]
#[macro_export]
macro_rules! __run_configurations_exports {
    ($plugin:ty, $component:ident) => {
        impl $crate::run_configurations_bindings::exports::openidea::plugin::run_configurations::Guest for $component {
            fn configurations(root: String) -> Vec<$crate::run_configurations_bindings::exports::openidea::plugin::run_configurations::RunConfiguration> {
                $crate::__rt::configurations::<$plugin>(&root)
            }
        }
        $crate::run_configurations_bindings::__export_configurations_world!($component with_types_in $crate::run_configurations_bindings);
    };
}
#[doc(hidden)]
#[macro_export]
macro_rules! __test_results_exports {
    ($plugin:ty, $component:ident) => {
        impl $crate::test_results_bindings::exports::openidea::plugin::test_results::Guest for $component {
            fn parse(config: String, chunk: String) -> Vec<$crate::test_results_bindings::exports::openidea::plugin::test_results::TestEvent> {
                $crate::__rt::test_results::<$plugin>(&config, &chunk)
            }
            fn select_tests(config: String, tests: Vec<Vec<String>>) -> Option<Vec<String>> {
                $crate::__rt::select_tests::<$plugin>(&config, &tests)
            }
        }
        $crate::test_results_bindings::__export_tests_world!($component with_types_in $crate::test_results_bindings);
    };
}

pub mod language_features;

#[cfg(target_arch = "wasm32")]
#[doc(hidden)]
pub mod language_features_bindings {
    wit_bindgen::generate!({world: "editor-language-features", path: "wit", pub_export_macro: true,
        export_macro_name: "__export_language_features_world", default_bindings_module: "openidea_plugin::language_features_bindings",
        with: { "openidea:plugin/types@1.4.0": crate::bindings::openidea::plugin::types },
    });
}

#[doc(hidden)]
#[macro_export]
macro_rules! __language_features_exports {
 ($plugin:ty, $component:ident) => {
  impl $crate::language_features_bindings::exports::openidea::plugin::language_features::Guest for $component {
fn format(doc: $crate::language_features_bindings::exports::openidea::plugin::language_features::Document, range: Option<$crate::bindings::openidea::plugin::types::Range>, options: $crate::language_features_bindings::exports::openidea::plugin::language_features::FormatOptions) -> Result<Vec<$crate::bindings::openidea::plugin::types::TextEdit>, $crate::bindings::openidea::plugin::types::Error> { $crate::language_features::wasm::format::<$plugin>(doc, range, options) }
fn signature_help(doc: $crate::language_features_bindings::exports::openidea::plugin::language_features::Document, at: $crate::bindings::openidea::plugin::types::Position) -> Option<$crate::language_features_bindings::exports::openidea::plugin::language_features::SignatureHelpResult> { $crate::language_features::wasm::signature_help::<$plugin>(doc, at) }
fn document_highlights(doc: $crate::language_features_bindings::exports::openidea::plugin::language_features::Document, at: $crate::bindings::openidea::plugin::types::Position) -> Vec<$crate::language_features_bindings::exports::openidea::plugin::language_features::Highlight> { $crate::language_features::wasm::document_highlights::<$plugin>(doc, at) }
fn document_links(doc: $crate::language_features_bindings::exports::openidea::plugin::language_features::Document) -> Vec<$crate::language_features_bindings::exports::openidea::plugin::language_features::DocumentLink> { $crate::language_features::wasm::document_links::<$plugin>(doc) }
fn code_lenses(doc: $crate::language_features_bindings::exports::openidea::plugin::language_features::Document) -> Vec<$crate::language_features_bindings::exports::openidea::plugin::language_features::CodeLens> { $crate::language_features::wasm::code_lenses::<$plugin>(doc) }
fn selection_ranges(doc: $crate::language_features_bindings::exports::openidea::plugin::language_features::Document, at: $crate::bindings::openidea::plugin::types::Position) -> Vec<$crate::bindings::openidea::plugin::types::Range> { $crate::language_features::wasm::selection_ranges::<$plugin>(doc, at) }
fn folding(doc: $crate::language_features_bindings::exports::openidea::plugin::language_features::Document) -> Vec<$crate::language_features_bindings::exports::openidea::plugin::language_features::FoldRange> { $crate::language_features::wasm::folding::<$plugin>(doc) }
fn colors(doc: $crate::language_features_bindings::exports::openidea::plugin::language_features::Document) -> Vec<$crate::language_features_bindings::exports::openidea::plugin::language_features::ColorInfo> { $crate::language_features::wasm::colors::<$plugin>(doc) }
fn color_presentations(doc: $crate::language_features_bindings::exports::openidea::plugin::language_features::Document, color: $crate::language_features_bindings::exports::openidea::plugin::language_features::ColorInfo) -> Vec<String> { $crate::language_features::wasm::color_presentations::<$plugin>(doc, color) }
fn document_symbols(doc: $crate::language_features_bindings::exports::openidea::plugin::language_features::Document) -> Vec<$crate::language_features_bindings::exports::openidea::plugin::language_features::DocumentSymbol> { $crate::language_features::wasm::document_symbols::<$plugin>(doc) }
fn implementation(doc: $crate::language_features_bindings::exports::openidea::plugin::language_features::Document, at: $crate::bindings::openidea::plugin::types::Position) -> Vec<$crate::bindings::openidea::plugin::types::Location> { $crate::language_features::wasm::implementation::<$plugin>(doc, at) }
fn type_definition(doc: $crate::language_features_bindings::exports::openidea::plugin::language_features::Document, at: $crate::bindings::openidea::plugin::types::Position) -> Vec<$crate::bindings::openidea::plugin::types::Location> { $crate::language_features::wasm::type_definition::<$plugin>(doc, at) }
fn gutter_actions(doc: $crate::language_features_bindings::exports::openidea::plugin::language_features::Document) -> Vec<$crate::language_features_bindings::exports::openidea::plugin::language_features::GutterAction> { $crate::language_features::wasm::gutter_actions::<$plugin>(doc) }
  }
 $crate::language_features_bindings::__export_language_features_world!($component with_types_in $crate::language_features_bindings);
 };
}

#[cfg(target_arch = "wasm32")]
#[doc(hidden)]
pub mod injections_bindings {
    wit_bindgen::generate!({world: "language-injections", path: "wit", pub_export_macro: true,
        export_macro_name: "__export_injections_world", default_bindings_module: "openidea_plugin::injections_bindings",
        with: { "openidea:plugin/types@1.4.0": crate::bindings::openidea::plugin::types },
    });
}

#[doc(hidden)]
#[macro_export]
macro_rules! __injections_exports {
 ($plugin:ty, $component:ident) => {
  impl $crate::injections_bindings::exports::openidea::plugin::injections::Guest for $component {
fn injections(doc: $crate::injections_bindings::exports::openidea::plugin::injections::Document) -> Vec<$crate::injections_bindings::exports::openidea::plugin::injections::Injection> { $crate::language_features::wasm::injections::<$plugin>(doc) }
  }
 $crate::injections_bindings::__export_injections_world!($component with_types_in $crate::injections_bindings);
 };
}

/// Embedded-language range providers (API 1.4).
pub mod injections {
    pub use crate::language_features::{Document, Injection, Injections};
}

/// Implements tools declared in contributes.mcpTools. Arguments/results are JSON/text.
pub trait McpProvider {
    fn call(&mut self, tool: &str, arguments: &str, ctx: &Invocation) -> Result<String, Error>;
}
#[cfg(target_arch = "wasm32")]
#[doc(hidden)]
pub mod mcp_bindings {
    wit_bindgen::generate!({ world: "mcp-tools", path: "wit", pub_export_macro: true,
        export_macro_name: "__export_mcp_world", default_bindings_module: "openidea_plugin::mcp_bindings",
        with: {
            "openidea:plugin/types@1.4.0": crate::bindings::openidea::plugin::types,
            "openidea:plugin/invocation@1.4.0": crate::bindings::openidea::plugin::invocation,
        },
    });
}
#[doc(hidden)]
#[macro_export]
macro_rules! __mcp_exports {
    ($plugin:ty, $component:ident) => {
        impl $crate::mcp_bindings::exports::openidea::plugin::mcp_provider::Guest for $component {
            fn call(tool: String, arguments: String, ctx: &$crate::bindings::openidea::plugin::invocation::Invocation) -> Result<String, $crate::bindings::openidea::plugin::types::Error> {
                $crate::__rt::mcp_call::<$plugin>(&tool, &arguments, ctx)
            }
        }
        $crate::mcp_bindings::__export_mcp_world!($component with_types_in $crate::mcp_bindings);
    };
}
