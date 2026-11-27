//! Declares OpenIDEA's backend commands once, on the fn that implements them.
//!
//! A command that runs on the project host is an `ide-host` fn with `#[command]`; its module
//! lists it in `domain!`, and `ide-host` lists its domains in `domains!`. From that `src-tauri`
//! derives the Tauri adapter and its bindings entry, and `ide-host` derives the JSON-RPC handler
//! `openidea-server` answers. A command only the desktop runs keeps its hand-written Tauri fn,
//! with `#[desktop_command]`, and its module lists it in `desktop_domain!`. Every command
//! declares its trust class, and each declaration yields a `COMMAND`
//! (`ide_host::catalogue::Command`): its name, trust class, placement, bindings entry and
//! execution mode.
//!
//! The examples below build against a stand-in for `ide-host` (`src/doctest_host.rs`). Every
//! `compile_fail` example differs from the example before it only by the mistake it names.

use heck::ToLowerCamelCase;
use proc_macro::TokenStream;
use proc_macro2::TokenStream as T2;
use quote::{ToTokens, format_ident, quote};
use syn::ext::IdentExt;
use syn::parse::{Parse, ParseStream};
use syn::punctuated::Punctuated;
use syn::{FnArg, GenericArgument, Ident, ItemFn, Pat, PathArguments, ReturnType, Token, Type};

/// `#[command(trust = …)]` on a project-host command's implementation in `ide-host`.
///
/// The fn's name is the command's name and its `///` lines are the bindings' docs. Parameters
/// of type `&Host` or `&Arc<Host>`, `window: &str` and `plugins: &Arc<PluginHost>` are injected;
/// every other parameter is an argument, owned, whose key is its camelCase name, and
/// `Channel<T>` streams values back. `async fn` gives an async Tauri adapter, `fn` a sync one.
/// A result of type `IdeResult<T>` is returned as is; any other result is a success. A JSON-RPC
/// request that leaves out an argument marked `#[default]` gets the type's default, so servers
/// keep answering clients older than the argument.
///
/// Options:
/// - `trust = always | outside_restricted | trusted` (required): where the command may run;
///   `always` includes Restricted Mode, `outside_restricted` needs no project or a trusted
///   one, `trusted` needs a trusted project.
/// - `desktop_body = async | sync | spawn`: the Tauri adapter calls the hand-written fn of the
///   same name in `src-tauri` instead of this one, which stays the server's implementation.
///   `spawn` runs that sync body off the invoking thread.
///
/// ```
/// # include!("doctest_host.rs");
/// pub mod vcs {
///     use crate::{Host, IdeResult, ops::Channel};
///     use ide_command::command;
///
///     /// Renames a branch.
///     #[command(trust = trusted)]
///     pub async fn vcs_rename_branch(
///         host: &Host,
///         window: &str,
///         from: String,
///         to: String,
///         unset_upstream: bool,
///     ) -> IdeResult<()> {
///         Ok(())
///     }
///
///     #[command(trust = always)]
///     pub fn vcs_watch(window: &str, #[default] depth: u32, on_event: Channel<u32>) -> bool {
///         true
///     }
///
///     ide_command::domain!(vcs: vcs_rename_branch, vcs_watch);
/// }
///
/// ide_command::domains!(vcs: crate::vcs);
///
/// fn main() {
///     use catalogue::{Mode, Placement, TrustClass};
///     let mut d = rpc::Dispatcher::default();
///     register_domains(&mut d);
///     assert_eq!(d.0, [("vcs_rename_branch", TrustClass::Trusted), ("vcs_watch", TrustClass::Always)]);
///     let watch = vcs::__cmd_vcs_watch::COMMAND;
///     assert_eq!((watch.placement, watch.bindings, watch.mode), (Placement::ProjectHost, true, Mode::Sync));
/// }
/// ```
///
/// A command without a trust class:
///
/// ```compile_fail
/// # include!("doctest_host.rs");
/// pub mod vcs {
///     #[ide_command::command]
///     pub fn vcs_watch(window: &str) -> bool {
///         true
///     }
///
///     ide_command::domain!(vcs: vcs_watch);
/// }
/// # fn main() {}
/// ```
///
/// A command its module doesn't list:
///
/// ```compile_fail,E0425
/// # include!("doctest_host.rs");
/// pub mod vcs {
///     #[ide_command::command(trust = always)]
///     pub fn vcs_watch(window: &str) -> bool {
///         true
///     }
///
///     #[ide_command::command(trust = always)]
///     pub fn vcs_unwatch(window: &str) -> bool {
///         true
///     }
///
///     ide_command::domain!(vcs: vcs_watch);
/// }
/// # fn main() {}
/// ```
///
/// Two commands with one name, in different modules:
///
/// ```compile_fail,E0428
/// # include!("doctest_host.rs");
/// pub mod vcs {
///     #[ide_command::command(trust = always)]
///     pub fn vcs_watch(window: &str) -> bool {
///         true
///     }
///
///     ide_command::domain!(vcs: vcs_watch);
/// }
///
/// pub mod search {
///     #[ide_command::command(trust = always)]
///     pub fn vcs_watch(window: &str) -> bool {
///         true
///     }
///
///     ide_command::domain!(search: vcs_watch);
/// }
/// # fn main() {}
/// ```
///
/// A borrowed argument:
///
/// ```compile_fail
/// # include!("doctest_host.rs");
/// pub mod vcs {
///     #[ide_command::command(trust = always)]
///     pub fn vcs_watch(window: &str, path: &str) -> bool {
///         true
///     }
///
///     ide_command::domain!(vcs: vcs_watch);
/// }
/// # fn main() {}
/// ```
///
/// A stream that isn't a `Channel<T>`:
///
/// ```compile_fail
/// # include!("doctest_host.rs");
/// pub mod vcs {
///     use crate::ops::Emit;
///
///     #[ide_command::command(trust = always)]
///     pub fn vcs_watch(window: &str, on_event: Emit<u32>) -> bool {
///         true
///     }
///
///     ide_command::domain!(vcs: vcs_watch);
/// }
/// # fn main() {}
/// ```
#[proc_macro_attribute]
pub fn command(attr: TokenStream, item: TokenStream) -> TokenStream {
    let opts = syn::parse_macro_input!(attr as Opts);
    let f = syn::parse_macro_input!(item as ItemFn);
    expand_command(opts, f).unwrap_or_else(|e| e.to_compile_error()).into()
}

fn expand_command(opts: Opts, mut f: ItemFn) -> syn::Result<T2> {
    opts.only(&["trust", "desktop_body"])?;
    let trust = opts.trust()?;
    // `#[default]` is read here and not emitted.
    let defaulted: Vec<bool> = f
        .sig
        .inputs
        .iter_mut()
        .map(|input| match input {
            FnArg::Typed(pt) => {
                let before = pt.attrs.len();
                pt.attrs.retain(|a| !a.path().is_ident("default"));
                pt.attrs.len() != before
            }
            FnArg::Receiver(_) => false,
        })
        .collect();
    let name = &f.sig.ident;
    if !f.sig.generics.params.is_empty() {
        return Err(syn::Error::new_spanned(&f.sig.generics, "a command is not generic"));
    }
    let is_async = f.sig.asyncness.is_some();
    let (run, body) = match opts.value("desktop_body") {
        None if is_async => (format_ident!("async"), quote!(derived)),
        None => (format_ident!("sync"), quote!(derived)),
        Some(Some(m)) if ["async", "sync", "spawn"].contains(&m.to_string().as_str()) => (m, quote!(desktop)),
        Some(v) => return Err(error(v.as_ref().unwrap_or(name), "`desktop_body = async | sync | spawn`")),
    };
    let mode = match run.to_string().as_str() {
        "async" => quote!(Async),
        "spawn" => quote!(Spawn),
        _ => quote!(Sync),
    };

    let mut aliases = Vec::new(); // one type alias per argument, resolved in the fn's own scope
    let mut args = Vec::new(); // the arguments, for the Tauri adapter's signature
    let mut call = Vec::new(); // every parameter in declared order, for the Tauri adapter's call
    let mut rpc_call = Vec::new(); // the same, for the JSON-RPC handler
    let mut needs_plugins = false;
    for (input, defaulted) in f.sig.inputs.iter().zip(defaulted) {
        let FnArg::Typed(pt) = input else {
            return Err(error(input, "a command is a free fn"));
        };
        let Pat::Ident(pi) = &*pt.pat else {
            return Err(error(&pt.pat, "command parameters are plain identifiers"));
        };
        let ident = &pi.ident;
        let plain_only = || error(ident, "`#[default]` marks a plain argument");
        if defaulted && injected(ident, &pt.ty).is_some() {
            return Err(plain_only());
        }
        match injected(ident, &pt.ty) {
            Some(Injected::Host) => {
                call.push(quote!((inj host)));
                rpc_call.push(quote!(&c.host));
                continue;
            }
            Some(Injected::Window) => {
                call.push(quote!((inj window)));
                rpc_call.push(quote!(&c.window));
                continue;
            }
            Some(Injected::Plugins) => {
                needs_plugins = true;
                call.push(quote!((inj plugins)));
                rpc_call.push(quote!(&plugins));
                continue;
            }
            None => {}
        }
        if matches!(&*pt.ty, Type::Reference(_)) {
            return Err(error(
                &pt.ty,
                "command arguments are owned; the injected references are `&Host`, `window: &str` and `plugins: &Arc<PluginHost>`",
            ));
        }
        let seg = last_segment(&pt.ty);
        if seg.is_some_and(|s| s.ident == "Emit") {
            return Err(error(&pt.ty, "a command streams through `Channel<T>`, not `Emit<T>`"));
        }
        let key = ident.unraw().to_string().to_lower_camel_case();
        let alias = format_ident!("A{}", args.len());
        if let Some(inner) = seg.filter(|s| s.ident == "Channel").and_then(type_argument) {
            if defaulted {
                return Err(plain_only());
            }
            aliases.push(quote!(pub type #alias = #inner;));
            args.push(quote!((#ident channel #alias)));
            call.push(quote!((arg channel #ident)));
            rpc_call.push(quote!(c.sender(#key)?));
        } else {
            let ty = &pt.ty;
            aliases.push(quote!(pub type #alias = #ty;));
            args.push(quote!((#ident plain #alias)));
            call.push(quote!((arg plain #ident)));
            rpc_call.push(if defaulted {
                quote!(c.arg::<::core::option::Option<#ty>>(#key)?.unwrap_or_default())
            } else {
                quote!(c.arg(#key)?)
            });
        }
    }

    let ret: Type = match &f.sig.output {
        ReturnType::Default => syn::parse_quote!(()),
        ReturnType::Type(_, t) => (**t).clone(),
    };
    let fallible = last_segment(&ret).is_some_and(|s| s.ident == "IdeResult");
    // specta exports `fn f()` as `void` and `fn f() -> ()` as `null`: keep which one was written.
    let ret_alias = match &f.sig.output {
        ReturnType::Default => quote!(),
        ReturnType::Type(..) => quote!(Ret),
    };
    let shape = if fallible { quote!(fallible [#ret_alias]) } else { quote!(infallible [#ret_alias]) };
    let await_ = is_async.then(|| quote!(.await));
    let invoke = quote!(super::#name(#(#rpc_call),*) #await_);
    let invoke = if fallible { invoke } else { quote!(Ok(#invoke)) };
    let plugins = needs_plugins.then(|| {
        quote! {
            let plugins = c.host.plugin_host()
                .ok_or_else(|| crate::IdeError::unavailable("the plugin host has shut down"))?;
        }
    });
    let docs: Vec<_> = f.attrs.iter().filter(|a| a.path().is_ident("doc")).collect();
    let module = format_ident!("__cmd_{}", name);
    let tokens = format_ident!("__catalogue_{}", name);
    let name_str = name.unraw().to_string();

    Ok(quote! {
        #f

        // Resolves only if this module's `domain!` lists the command.
        const _: () = self::__listed::#name;

        #[doc(hidden)]
        #[allow(non_snake_case)]
        pub mod #module {
            #[allow(unused_imports)]
            use super::*;
            #(#aliases)*
            pub type Ret = #ret;
            pub const COMMAND: crate::catalogue::Command = crate::catalogue::Command {
                name: #name_str,
                trust: crate::catalogue::TrustClass::#trust,
                placement: crate::catalogue::Placement::ProjectHost,
                bindings: true,
                mode: crate::catalogue::Mode::#mode,
            };
            /// The JSON-RPC handler.
            pub async fn rpc(c: crate::rpc::Call) -> crate::IdeResult<impl ::serde::Serialize + use<>> {
                #plugins
                #invoke
            }
        }

        /// The command's signature, handed to `$cb!` for `src-tauri` to derive its Tauri adapter.
        #[doc(hidden)]
        #[macro_export]
        macro_rules! #tokens {
            ([$($cb:tt)*] { $($ctx:tt)* }) => {
                $($cb)*! { { $($ctx)* } {
                    name: #name,
                    module: #module,
                    docs: [ #(#docs)* ],
                    run: #run,
                    result: #shape,
                    body: #body,
                    args: [ #(#args)* ],
                    call: [ #(#call)* ],
                } }
            };
        }
    })
}

/// `domain!(vcs: vcs_status, vcs_rename_branch, …)`: the commands one `ide-host` module
/// declares with `#[command]`, in any order. It goes once at the end of that module and gives it
/// the server's `register`; `domains!` names the domain.
///
/// ```
/// # include!("doctest_host.rs");
/// pub mod vcs {
///     #[ide_command::command(trust = always)]
///     pub fn vcs_watch(window: &str) -> bool {
///         true
///     }
///
///     ide_command::domain!(vcs: vcs_watch);
/// }
/// # fn main() {}
/// ```
///
/// A listed name that isn't a command:
///
/// ```compile_fail,E0433
/// # include!("doctest_host.rs");
/// pub mod vcs {
///     #[ide_command::command(trust = always)]
///     pub fn vcs_watch(window: &str) -> bool {
///         true
///     }
///
///     ide_command::domain!(vcs: vcs_watch, vcs_unwatch);
/// }
/// # fn main() {}
/// ```
#[proc_macro]
pub fn domain(input: TokenStream) -> TokenStream {
    let Domain { name, commands } = syn::parse_macro_input!(input as Domain);
    let modules: Vec<_> = commands.iter().map(|c| format_ident!("__cmd_{}", c)).collect();
    let tokens: Vec<_> = commands.iter().map(|c| format_ident!("__catalogue_{}", c)).collect();
    let list = format_ident!("__domain_{}", name);
    let names = commands.iter();
    let listed = commands.iter();
    let d = quote!($);
    quote! {
        #[doc(hidden)]
        #[allow(non_upper_case_globals)]
        mod __listed {
            #( pub(super) const #listed: () = (); )*
        }

        // Resolves only from the `domains!` entry that names this domain.
        #[doc(hidden)]
        #[allow(non_upper_case_globals)]
        pub(crate) const #list: () = ();

        /// Adds this module's commands to the server.
        pub(crate) fn register(d: &mut crate::rpc::Dispatcher) {
            #( d.add(#modules::COMMAND.name, #modules::COMMAND.trust, #modules::rpc); )*
        }

        /// `@each`: each command's signature, in list order. `@names`: the list.
        #[doc(hidden)]
        #[macro_export]
        macro_rules! #list {
            (@each [#d (#d cb:tt)*] { #d (#d ctx:tt)* }) => {
                #( #d crate::#tokens!{ [#d (#d cb)*] { #d (#d ctx)* } } )*
            };
            (@names [#d (#d cb:tt)*] { #d (#d ctx:tt)* }) => {
                #d (#d cb)*! { { #d (#d ctx)* } [ #(#names)* ] }
            };
        }
    }
    .into()
}

/// `domains!(vcs: crate::ops::vcs::commands, …)`, once in `ide-host`: every domain, by the name
/// its `domain!` gives it and the crate path of its module. It gives the server
/// `register_domains`, and hands `src-tauri` the list of domains through `__domains!`.
///
/// ```
/// # include!("doctest_host.rs");
/// pub mod vcs {
///     #[ide_command::command(trust = always)]
///     pub fn vcs_watch(window: &str) -> bool {
///         true
///     }
///
///     ide_command::domain!(vcs: vcs_watch);
/// }
///
/// ide_command::domains!(vcs: crate::vcs);
/// # fn main() {}
/// ```
///
/// A domain under another name than its `domain!` gives it:
///
/// ```compile_fail,E0425
/// # include!("doctest_host.rs");
/// pub mod vcs {
///     #[ide_command::command(trust = always)]
///     pub fn vcs_watch(window: &str) -> bool {
///         true
///     }
///
///     ide_command::domain!(vcs: vcs_watch);
/// }
///
/// ide_command::domains!(git: crate::vcs);
/// # fn main() {}
/// ```
#[proc_macro]
pub fn domains(input: TokenStream) -> TokenStream {
    let entries = syn::parse_macro_input!(input with Punctuated::<DomainPath, Token![,]>::parse_terminated);
    let mut names = Vec::new();
    let mut paths = Vec::new();
    let mut from_crate = Vec::new();
    for DomainPath { name, path } in entries {
        let mut segments = path.segments.iter();
        if path.leading_colon.is_some() || segments.next().is_none_or(|s| s.ident != "crate") {
            return error(&path, "a domain's path starts with `crate::`").to_compile_error().into();
        }
        let rest: Vec<_> = segments.map(|s| &s.ident).collect();
        from_crate.push(quote!(#(#rest)::*));
        names.push(name);
        paths.push(path);
    }
    let lists: Vec<_> = names.iter().map(|n| format_ident!("__domain_{}", n)).collect();
    let d = quote!($);
    quote! {
        #( const _: () = #paths::#lists; )*

        /// Adds every domain's commands to the server.
        pub(crate) fn register_domains(d: &mut crate::rpc::Dispatcher) {
            #( #paths::register(d); )*
        }

        /// `@names`: each domain as `(name __domain_name { path })`.
        #[doc(hidden)]
        #[macro_export]
        macro_rules! __domains {
            (@names [#d (#d cb:tt)*] { #d (#d ctx:tt)* }) => {
                #d (#d cb)*! { { #d (#d ctx)* } [ #( (#names #lists { #d crate::#from_crate }) )* ] }
            };
        }
    }
    .into()
}

/// `#[desktop_command(trust = …)]` on a command only the desktop runs, above its
/// `#[tauri::command]` in `src-tauri`, whose `(async)` it reads. The fn is left as written.
///
/// Options: `trust` as for `#[command]` (required), and `bindings = none` for a command that is
/// registered outside tauri-specta; such a command isn't listed in `desktop_domain!`.
///
/// ```
/// # include!("doctest_host.rs");
/// # extern crate self as ide_host;
/// pub mod clipboard {
///     #[ide_command::desktop_command(trust = always)]
///     pub async fn clipboard_text() -> Option<String> {
///         None
///     }
///
///     ide_command::desktop_domain!(clipboard_text);
/// }
///
/// fn main() {
///     let text = clipboard::clipboard_text::COMMAND;
///     assert_eq!((text.name, text.placement), ("clipboard_text", catalogue::Placement::Desktop));
/// }
/// ```
///
/// A command without a trust class:
///
/// ```compile_fail
/// # include!("doctest_host.rs");
/// # extern crate self as ide_host;
/// pub mod clipboard {
///     #[ide_command::desktop_command]
///     pub async fn clipboard_text() -> Option<String> {
///         None
///     }
///
///     ide_command::desktop_domain!(clipboard_text);
/// }
/// # fn main() {}
/// ```
///
/// A command its module doesn't list:
///
/// ```compile_fail,E0425
/// # include!("doctest_host.rs");
/// # extern crate self as ide_host;
/// pub mod clipboard {
///     #[ide_command::desktop_command(trust = always)]
///     pub async fn clipboard_text() -> Option<String> {
///         None
///     }
///
///     #[ide_command::desktop_command(trust = always)]
///     pub async fn clipboard_html() -> Option<String> {
///         None
///     }
///
///     ide_command::desktop_domain!(clipboard_text);
/// }
/// # fn main() {}
/// ```
#[proc_macro_attribute]
pub fn desktop_command(attr: TokenStream, item: TokenStream) -> TokenStream {
    let opts = syn::parse_macro_input!(attr as Opts);
    let f = syn::parse_macro_input!(item as ItemFn);
    expand_desktop_command(opts, f).unwrap_or_else(|e| e.to_compile_error()).into()
}

fn expand_desktop_command(opts: Opts, f: ItemFn) -> syn::Result<T2> {
    opts.only(&["trust", "bindings"])?;
    let trust = opts.trust()?;
    let bindings = match opts.value("bindings") {
        None => true,
        Some(Some(v)) if v == "none" => false,
        Some(v) => return Err(error(v.as_ref().unwrap_or(&f.sig.ident), "`bindings = none`")),
    };
    // `#[tauri::command(async)]` runs a sync fn off the invoking thread.
    let spawned = f.attrs.iter().any(|a| {
        let path = a.path();
        path.segments.len() == 2
            && path.segments[0].ident == "tauri"
            && path.segments[1].ident == "command"
            && a.parse_args::<Ident>().is_ok_and(|i| i == "async")
    });
    let mode = if f.sig.asyncness.is_some() {
        quote!(Async)
    } else if spawned {
        quote!(Spawn)
    } else {
        quote!(Sync)
    };
    let name = &f.sig.ident;
    let name_str = name.unraw().to_string();
    let listed = bindings.then(|| quote!(const _: () = self::__listed::#name;));
    Ok(quote! {
        #f

        #listed

        #[doc(hidden)]
        pub mod #name {
            pub const COMMAND: ::ide_host::catalogue::Command = ::ide_host::catalogue::Command {
                name: #name_str,
                trust: ::ide_host::catalogue::TrustClass::#trust,
                placement: ::ide_host::catalogue::Placement::Desktop,
                bindings: #bindings,
                mode: ::ide_host::catalogue::Mode::#mode,
            };
        }
    })
}

/// `desktop_domain!(clipboard_text, clipboard_write_text, …)`: the `#[desktop_command]`s of one
/// `src-tauri` module that are in the bindings, in any order. It goes once at the end of that
/// module and gives it `__desktop_domain!(@names …)`.
#[proc_macro]
pub fn desktop_domain(input: TokenStream) -> TokenStream {
    let commands = syn::parse_macro_input!(input with Punctuated::<Ident, Token![,]>::parse_terminated);
    let names = commands.iter();
    let listed = commands.iter();
    let d = quote!($);
    quote! {
        #[doc(hidden)]
        #[allow(non_upper_case_globals)]
        mod __listed {
            #( pub(super) const #listed: () = (); )*
        }

        #[doc(hidden)]
        macro_rules! __desktop_domain {
            (@names [#d (#d cb:tt)*] { #d (#d ctx:tt)* }) => {
                #d (#d cb)*! { { #d (#d ctx)* } [ #(#names)* ] }
            };
        }
        #[allow(unused_imports)]
        pub(crate) use __desktop_domain;
    }
    .into()
}

/// `sorted_catalogue!(bindings: a::x, b::y, …; raw: c::z, …)`, in `src-tauri`: every command,
/// sorted by name, as `(collect_commands![…bindings…], [COMMAND, …every command…])`. Each path
/// names a command fn and the module of the same name that holds its `COMMAND`.
///
/// ```
/// # include!("doctest_host.rs");
/// # extern crate self as ide_host;
/// # extern crate self as tauri_specta;
/// # #[macro_export]
/// # macro_rules! collect_commands { ($($p:path),*) => { [$(stringify!($p)),*] } }
/// pub mod clipboard {
///     #[ide_command::desktop_command(trust = always)]
///     pub async fn clipboard_text() -> Option<String> {
///         None
///     }
///
///     #[ide_command::desktop_command(trust = always)]
///     pub fn clipboard_clear() {}
///
///     ide_command::desktop_domain!(clipboard_text, clipboard_clear);
/// }
///
/// fn main() {
///     let (commands, rows) = ide_command::sorted_catalogue!(
///         bindings: clipboard::clipboard_text, clipboard::clipboard_clear;
///         raw:
///     );
///     assert_eq!(commands, ["clipboard :: clipboard_clear", "clipboard :: clipboard_text"]);
///     assert_eq!(rows.map(|c| c.name), ["clipboard_clear", "clipboard_text"]);
/// }
/// ```
///
/// Two commands with one name:
///
/// ```compile_fail
/// # include!("doctest_host.rs");
/// # extern crate self as ide_host;
/// # extern crate self as tauri_specta;
/// # #[macro_export]
/// # macro_rules! collect_commands { ($($p:path),*) => { [$(stringify!($p)),*] } }
/// pub mod clipboard {
///     #[ide_command::desktop_command(trust = always)]
///     pub async fn clipboard_text() -> Option<String> {
///         None
///     }
///
///     #[ide_command::desktop_command(trust = always)]
///     pub fn clipboard_clear() {}
///
///     ide_command::desktop_domain!(clipboard_text, clipboard_clear);
/// }
///
/// pub mod editor {
///     #[ide_command::desktop_command(trust = always)]
///     pub fn clipboard_clear() {}
///
///     ide_command::desktop_domain!(clipboard_clear);
/// }
///
/// fn main() {
///     let (commands, rows) = ide_command::sorted_catalogue!(
///         bindings: clipboard::clipboard_text, clipboard::clipboard_clear, editor::clipboard_clear;
///         raw:
///     );
/// }
/// ```
#[proc_macro]
pub fn sorted_catalogue(input: TokenStream) -> TokenStream {
    let Catalogue { bindings, raw } = syn::parse_macro_input!(input as Catalogue);
    let key = |p: &syn::Path| p.segments.last().map(|s| s.ident.unraw().to_string()).unwrap_or_default();
    let mut bindings: Vec<_> = bindings.into_iter().collect();
    bindings.sort_by_cached_key(key);
    let mut all: Vec<_> = bindings.iter().chain(&raw).collect();
    all.sort_by_cached_key(|p| key(p));
    for pair in all.windows(2) {
        if key(pair[0]) == key(pair[1]) {
            let (a, b) = (pair[0], pair[1]);
            let message = format!(
                "command `{}` is declared twice: `{}` and `{}`",
                key(b),
                a.to_token_stream(),
                b.to_token_stream()
            );
            return syn::Error::new_spanned(b, message).to_compile_error().into();
        }
    }
    quote! {
        (
            ::tauri_specta::collect_commands![ #(#bindings),* ],
            [ #( #all::COMMAND ),* ],
        )
    }
    .into()
}

struct Catalogue {
    bindings: Punctuated<syn::Path, Token![,]>,
    raw: Punctuated<syn::Path, Token![,]>,
}

impl Parse for Catalogue {
    fn parse(input: ParseStream) -> syn::Result<Self> {
        let paths = |input: ParseStream, label: &str| -> syn::Result<Punctuated<syn::Path, Token![,]>> {
            let ident: Ident = input.parse()?;
            if ident != label {
                return Err(error(&ident, &format!("expected `{label}:`")));
            }
            input.parse::<Token![:]>()?;
            let mut out = Punctuated::new();
            while !input.is_empty() && !input.peek(Token![;]) {
                out.push_value(input.parse()?);
                if !input.peek(Token![,]) {
                    break;
                }
                out.push_punct(input.parse()?);
            }
            Ok(out)
        };
        let bindings = paths(input, "bindings")?;
        input.parse::<Token![;]>()?;
        let raw = paths(input, "raw")?;
        let _ = input.parse::<Option<Token![;]>>()?;
        Ok(Self { bindings, raw })
    }
}

enum Injected {
    Host,
    Window,
    Plugins,
}

/// `&Host` or `&Arc<Host>` under any name, `window: &str`, `plugins: &Arc<PluginHost>`.
fn injected(ident: &Ident, ty: &Type) -> Option<Injected> {
    let Type::Reference(r) = ty else { return None };
    if r.mutability.is_some() {
        return None;
    }
    let seg = last_segment(&r.elem)?;
    let arc_of =
        |name: &str| seg.ident == "Arc" && type_argument(seg).and_then(last_segment).is_some_and(|s| s.ident == name);
    if seg.ident == "Host" || arc_of("Host") {
        Some(Injected::Host)
    } else if ident == "window" && seg.ident == "str" {
        Some(Injected::Window)
    } else if ident == "plugins" && arc_of("PluginHost") {
        Some(Injected::Plugins)
    } else {
        None
    }
}

fn last_segment(ty: &Type) -> Option<&syn::PathSegment> {
    match ty {
        Type::Path(p) if p.qself.is_none() => p.path.segments.last(),
        _ => None,
    }
}

fn type_argument(seg: &syn::PathSegment) -> Option<&Type> {
    match &seg.arguments {
        PathArguments::AngleBracketed(a) => a.args.iter().find_map(|g| match g {
            GenericArgument::Type(t) => Some(t),
            _ => None,
        }),
        _ => None,
    }
}

fn error(span: impl ToTokens, message: &str) -> syn::Error {
    syn::Error::new_spanned(span, message)
}

/// `name: a, b, …`
struct Domain {
    name: Ident,
    commands: Punctuated<Ident, Token![,]>,
}

impl Parse for Domain {
    fn parse(input: ParseStream) -> syn::Result<Self> {
        let name = input.parse()?;
        input.parse::<Token![:]>()?;
        Ok(Self { name, commands: Punctuated::parse_terminated(input)? })
    }
}

/// `name: crate::path`
struct DomainPath {
    name: Ident,
    path: syn::Path,
}

impl Parse for DomainPath {
    fn parse(input: ParseStream) -> syn::Result<Self> {
        let name = input.parse()?;
        input.parse::<Token![:]>()?;
        Ok(Self { name, path: input.parse()? })
    }
}

/// An attribute's options: `key = value` and bare `key`.
struct Opts(Vec<(Ident, Option<Ident>)>);

impl Parse for Opts {
    fn parse(input: ParseStream) -> syn::Result<Self> {
        let mut out = Vec::new();
        while !input.is_empty() {
            let key: Ident = input.parse()?;
            let value = if input.peek(Token![=]) {
                input.parse::<Token![=]>()?;
                // `async` is a keyword.
                Some(Ident::parse_any(input)?)
            } else {
                None
            };
            out.push((key, value));
            if !input.is_empty() {
                input.parse::<Token![,]>()?;
            }
        }
        Ok(Self(out))
    }
}

impl Opts {
    fn value(&self, key: &str) -> Option<Option<Ident>> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
    }

    fn only(&self, known: &[&str]) -> syn::Result<()> {
        match self.0.iter().map(|(k, _)| k).find(|k| !known.iter().any(|n| *k == n)) {
            Some(k) => Err(error(k, &format!("unknown option; the options are {}", known.join(", ")))),
            None => Ok(()),
        }
    }

    fn trust(&self) -> syn::Result<T2> {
        match self.value("trust").flatten().map(|t| t.to_string()).as_deref() {
            Some("always") => Ok(quote!(Always)),
            Some("outside_restricted") => Ok(quote!(OutsideRestricted)),
            Some("trusted") => Ok(quote!(Trusted)),
            _ => Err(syn::Error::new(
                proc_macro2::Span::call_site(),
                "every command declares its trust class: `trust = always | outside_restricted | trusted`",
            )),
        }
    }
}
