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

pub mod host;
#[cfg(not(target_arch = "wasm32"))]
pub mod mock;
pub mod providers;
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
            "openidea:plugin/types@1.0.0": crate::bindings::openidea::plugin::types,
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
            "openidea:plugin/types@1.0.0": crate::bindings::openidea::plugin::types,
            "openidea:plugin/workspace@1.0.0": crate::bindings::openidea::plugin::workspace,
            "openidea:plugin/editor@1.0.0": crate::bindings::openidea::plugin::editor,
            "openidea:plugin/invocation@1.0.0": crate::bindings::openidea::plugin::invocation,
        },
    });
}

/// The plugin API version this SDK targets.
pub const API_VERSION: &str = "1.0";

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
    ($plugin:ty) => {
        // Natively (tests) nothing is exported; keep the type "used".
        #[cfg(not(target_arch = "wasm32"))]
        const _: fn() -> $plugin = <$plugin as ::core::default::Default>::default;
        #[cfg(target_arch = "wasm32")]
        const _: () = {
            struct __OpenideaComponent;
            $crate::__plugin_exports!($plugin, __OpenideaComponent, $crate::bindings);
    $crate::bindings::__export_plugin_world!(__OpenideaComponent with_types_in $crate::bindings);
        };
    };
    ($plugin:ty, providers) => {
        #[cfg(not(target_arch = "wasm32"))]
        const _: fn() -> $plugin = <$plugin as ::core::default::Default>::default;
        #[cfg(target_arch = "wasm32")]
        const _: () = {
            struct __OpenideaComponent;
            $crate::__plugin_exports!($plugin, __OpenideaComponent, $crate::bindings);
            $crate::__providers_exports!($plugin, __OpenideaComponent);
    $crate::bindings::__export_plugin_world!(__OpenideaComponent with_types_in $crate::bindings);
        };
    };
    ($plugin:ty, views) => {
        #[cfg(not(target_arch = "wasm32"))]
        const _: fn() -> $plugin = <$plugin as ::core::default::Default>::default;
        #[cfg(target_arch = "wasm32")]
        const _: () = {
            struct __OpenideaComponent;
            $crate::__plugin_exports!($plugin, __OpenideaComponent, $crate::bindings);
            $crate::__views_exports!($plugin, __OpenideaComponent);
    $crate::bindings::__export_plugin_world!(__OpenideaComponent with_types_in $crate::bindings);
        };
    };
    ($plugin:ty, providers, views) => {
        #[cfg(not(target_arch = "wasm32"))]
        const _: fn() -> $plugin = <$plugin as ::core::default::Default>::default;
        #[cfg(target_arch = "wasm32")]
        const _: () = {
            struct __OpenideaComponent;
            $crate::__plugin_exports!($plugin, __OpenideaComponent, $crate::bindings);
            $crate::__providers_exports!($plugin, __OpenideaComponent);
            $crate::__views_exports!($plugin, __OpenideaComponent);
    $crate::bindings::__export_plugin_world!(__OpenideaComponent with_types_in $crate::bindings);
        };
    };
    ($plugin:ty, syntax) => {
        #[cfg(not(target_arch = "wasm32"))]
        const _: fn() -> $plugin = <$plugin as ::core::default::Default>::default;
        #[cfg(target_arch = "wasm32")]
        const _: () = {
            struct __OpenideaComponent;
            $crate::__plugin_exports!($plugin, __OpenideaComponent, $crate::bindings);

            impl $crate::syntax_bindings::exports::openidea::plugin::syntax_provider::Guest for __OpenideaComponent {
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

    $crate::bindings::__export_plugin_world!(__OpenideaComponent with_types_in $crate::bindings);
    $crate::syntax_bindings::__export_syntax_world!(__OpenideaComponent with_types_in $crate::syntax_bindings);
        };
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

    fn with<T: Plugin + Default, R>(f: impl FnOnce(&mut T) -> R) -> R {
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
