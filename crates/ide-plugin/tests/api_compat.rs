//! Plugin API versioning (plugins/README.md, "Evolving the plugin API").
//!
//! - The `wit/` package version, `ENGINE_VERSION` and `API_VERSION` agree.
//! - The version check accepts components the host can run and explains the rest.
//! - Components built for 1.0 link against a host of a later 1.x minor that
//!   adds functions and interfaces (wasmtime resolves `@1.0.0` names to a
//!   semver-compatible definition), and the host finds their exports under
//!   the newer name; a 2.0 host does not link them. The newer host is
//!   simulated with a linker that stubs every plugin import the component has
//!   at the newer version, so no copy of the WIT is needed.
//!
//! Components: the checked-in `dist/plugin.wasm` of the `hello` fixture, the
//! official plugins (`plugins/build.sh` rebuilds them).

use ide_plugin::{API_VERSION, PluginEngine, check_api, component_api, host_api};
use std::path::{Path, PathBuf};
use wasmtime::component::types::ComponentItem;
use wasmtime::component::{Component, Linker, ResourceTable, ResourceType};
use wasmtime::{Config, Engine};
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Official components plus fixtures for the base and optional indexing exports.
fn components() -> Vec<PathBuf> {
    let mut out = vec![
        repo().join("crates/ide-plugin/tests/fixtures/hello/dist/plugin.wasm"),
        repo().join("crates/ide-plugin/tests/fixtures/indexer/dist/plugin.wasm"),
        repo().join("crates/ide-plugin/tests/fixtures/semantic-tokens/dist/plugin.wasm"),
        repo().join("crates/ide-plugin/tests/fixtures/hover/dist/plugin.wasm"),
        repo().join("crates/ide-plugin/tests/fixtures/diagnostics/dist/plugin.wasm"),
        repo().join("crates/ide-plugin/tests/fixtures/inlay-hints/dist/plugin.wasm"),
        repo().join("crates/ide-plugin/tests/fixtures/language-features/dist/plugin.wasm"),
        repo().join("crates/ide-plugin/tests/fixtures/symbols/dist/plugin.wasm"),
        repo().join("crates/ide-plugin/tests/fixtures/api14/dist/plugin.wasm"),
        repo().join("crates/ide-plugin/tests/fixtures/execution/dist/plugin.wasm"),
    ];
    let official = repo().join("plugins/official");
    let mut dirs: Vec<_> = std::fs::read_dir(&official).unwrap().map(|e| e.unwrap().path()).collect();
    dirs.sort();
    out.extend(dirs.into_iter().map(|d| d.join("dist/plugin.wasm")).filter(|p| p.is_file()));
    assert!(out.len() >= 9, "expected hello and the official plugins, found {out:?}");
    out
}

fn v(s: &str) -> semver::Version {
    semver::Version::parse(s).unwrap()
}

#[test]
fn wit_package_engine_and_api_versions_agree() {
    let host = host_api();
    assert_eq!(API_VERSION, format!("{}.{}", host.major, host.minor));
    let want = format!("package openidea:plugin@{host};");
    let mut files = 0;
    for entry in std::fs::read_dir(repo().join("wit")).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "wit") {
            let src = std::fs::read_to_string(&path).unwrap();
            assert!(src.lines().any(|l| l.trim() == want), "{} does not declare `{want}`", path.display());
            files += 1;
        }
    }
    assert!(files > 1);
}

/// The SDK ships its own copy of `wit/` (it builds outside this repository);
/// it must be the API this host implements.
#[test]
fn the_sdk_carries_the_hosts_wit() {
    let read = |dir: PathBuf| {
        let mut files: Vec<(String, String)> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|e| e == "wit"))
            .map(|p| (p.file_name().unwrap().to_string_lossy().into_owned(), std::fs::read_to_string(&p).unwrap()))
            .collect();
        files.sort();
        files
    };
    let host = read(repo().join("wit"));
    let sdk = read(repo().join("sdk/rust/openidea-plugin/wit"));
    let names = |f: &[(String, String)]| f.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>();
    assert_eq!(names(&sdk), names(&host), "sdk/rust/openidea-plugin/wit has other files than wit/");
    for ((name, a), (_, b)) in host.iter().zip(&sdk) {
        assert!(a == b, "sdk/rust/openidea-plugin/wit/{name} differs from wit/{name}: copy wit/ into the SDK");
    }
}

#[test]
fn the_version_check_runs_compatible_components_and_explains_the_rest() {
    let host = v("1.4.0");
    for ok in ["1.0.0", "1.3.0", "1.3.7", "1.4.0", "1.0.0-rc.1"] {
        assert_eq!(check_api(&v(ok), &host), Ok(()), "{ok}");
    }
    let newer = check_api(&v("1.5.0"), &host).unwrap_err();
    assert!(newer.contains("1.5") && newer.contains("update OpenIDEA"), "{newer}");
    assert!(check_api(&v("2.0.0"), &host).unwrap_err().contains("update OpenIDEA"));
    let older = check_api(&v("0.2.0"), &host).unwrap_err();
    assert!(older.contains("rebuild it with the 1.4 SDK"), "{older}");
    // 0.x: every minor is its own API.
    assert_eq!(check_api(&v("0.2.0"), &v("0.2.5")), Ok(()));
    assert!(check_api(&v("0.1.0"), &v("0.2.0")).is_err());
    assert!(check_api(&v("0.3.0"), &v("0.2.0")).is_err());
}

#[test]
fn a_components_api_is_the_highest_plugin_interface_version() {
    let names = ["wasi:io/poll@0.2.6", "openidea:plugin/log@1.0.0", "openidea:plugin/views@1.2.0"];
    assert_eq!(component_api(names), Ok(Some(v("1.2.0"))));
    assert_eq!(component_api(["wasi:cli/stdout@0.2.6"]), Ok(None));
    assert!(component_api(["openidea:plugin/log"]).unwrap_err().contains("unversioned"));
}

#[test]
fn shipped_components_are_built_for_this_api() {
    let engine = PluginEngine::new().unwrap();
    let host = host_api();
    for wasm in components() {
        let component = engine.compile(&wasm).unwrap();
        let built_for = engine.check_component(&component).unwrap_or_else(|e| panic!("{}: {e}", wasm.display()));
        let built_for = built_for.unwrap_or_else(|| panic!("{} uses no plugin interface", wasm.display()));
        assert_eq!((built_for.major, built_for.minor), (host.major, host.minor), "{}", wasm.display());
    }
}

// --- a later host, simulated -------------------------------------------------------------

struct Data {
    wasi: WasiCtx,
    table: ResourceTable,
}

impl WasiView for Data {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView { ctx: &mut self.wasi, table: &mut self.table }
    }
}

/// Distinct host types for the stubbed resources (a component may import several).
struct Stub<const N: usize>;

fn stub_resource(n: usize) -> ResourceType {
    macro_rules! pick { ($($i:literal)*) => { match n { $($i => ResourceType::host::<Stub<$i>>(),)* _ => panic!("more than 16 resources") } } }
    pick!(0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15)
}

enum Host<'a> {
    /// Defines everything the component imports, plus a function and an
    /// interface the component doesn't know.
    Superset,
    /// Leaves out one function, so linking must fail.
    Without(&'a str),
}

/// A linker with WASI and every `openidea:plugin/*` interface `component`
/// imports, defined at `version` with functions that are never called.
fn host_at(engine: &Engine, component: &Component, version: &str, host: Host<'_>) -> Linker<Data> {
    let mut linker = Linker::new(engine);
    wasmtime_wasi::p2::add_to_linker_sync(&mut linker).unwrap();
    // The component's resource → its stub. A resource re-exported through
    // `use` (`invocation` uses `editor.text-editor`) is the same type, so it
    // must get the same stub.
    let mut resources: Vec<(ResourceType, ResourceType)> = Vec::new();
    for (name, item) in component.component_type().imports(engine) {
        let Some(rest) = name.strip_prefix("openidea:plugin/") else { continue };
        let iface = rest.split_once('@').map_or(rest, |(i, _)| i);
        let ComponentItem::ComponentInstance(instance) = item.ty else { panic!("{name} is not an instance") };
        let mut defined = linker.instance(&format!("openidea:plugin/{iface}@{version}")).unwrap();
        for (export, item) in instance.exports(engine) {
            match item.ty {
                ComponentItem::ComponentFunc(_) if !matches!(host, Host::Without(f) if f == export) => {
                    defined.func_new(export, |_, _, _, _| Err(wasmtime::Error::msg("stub"))).unwrap();
                }
                ComponentItem::Resource(ty) => {
                    let stub = match resources.iter().find(|(r, _)| *r == ty) {
                        Some((_, stub)) => *stub,
                        None => {
                            let stub = stub_resource(resources.len());
                            resources.push((ty, stub));
                            stub
                        }
                    };
                    defined.resource(export, stub, |_, _| Ok(())).unwrap();
                }
                _ => {}
            }
        }
        if matches!(host, Host::Superset) {
            defined.func_new("added-in-a-later-minor", |_, _, _, _| Ok(())).unwrap();
        }
    }
    if matches!(host, Host::Superset) {
        let mut added = linker.instance(&format!("openidea:plugin/added-interface@{version}")).unwrap();
        added.func_new("call", |_, _, _, _| Ok(())).unwrap();
    }
    linker
}

fn engine() -> Engine {
    let mut config = Config::new();
    config.wasm_component_model(true);
    Engine::new(&config).unwrap()
}

/// The next minor of the API this host implements.
fn next_minor() -> String {
    let host = host_api();
    format!("{}.{}.0", host.major, host.minor + 1)
}

#[test]
fn components_link_against_a_later_minor_that_adds_functions_and_interfaces() {
    let engine = engine();
    let next = next_minor();
    for wasm in components() {
        let component = Component::from_file(&engine, &wasm).unwrap();
        let linker = host_at(&engine, &component, &next, Host::Superset);
        linker.instantiate_pre(&component).unwrap_or_else(|e| panic!("{}: {e:?}", wasm.display()));

        let exports: Vec<String> = component
            .component_type()
            .exports(&engine)
            .map(|(n, _)| n.to_owned())
            .filter(|n| n.starts_with("openidea:plugin/"))
            .collect();
        assert!(!exports.is_empty(), "{} exports no plugin interface", wasm.display());
        for name in exports {
            let iface = name.split_once('@').unwrap().0;
            let newer = format!("{iface}@{next}");
            assert!(
                component.get_export_index(None, &newer).is_some(),
                "{}: a {next} host can't find export {name}",
                wasm.display()
            );
        }
    }
}

#[test]
fn components_do_not_link_against_another_major() {
    let engine = engine();
    let next_major = format!("{}.0.0", host_api().major + 1);
    let wasm = repo().join("crates/ide-plugin/tests/fixtures/hello/dist/plugin.wasm");
    let component = Component::from_file(&engine, &wasm).unwrap();
    let linker = host_at(&engine, &component, &next_major, Host::Superset);
    assert!(linker.instantiate_pre(&component).is_err());
    let iface = component
        .component_type()
        .exports(&engine)
        .map(|(n, _)| n.to_owned())
        .find(|n| n.starts_with("openidea:plugin/"))
        .unwrap();
    let newer = format!("{}@{next_major}", iface.split_once('@').unwrap().0);
    assert!(component.get_export_index(None, &newer).is_none());
}

#[test]
fn a_later_minor_that_drops_a_function_does_not_link() {
    // Keeps the test above honest: the stub host really is type-checked.
    let engine = engine();
    let wasm = repo().join("crates/ide-plugin/tests/fixtures/hello/dist/plugin.wasm");
    let component = Component::from_file(&engine, &wasm).unwrap();
    let (iface, func) = component
        .component_type()
        .imports(&engine)
        .filter(|(n, _)| n.starts_with("openidea:plugin/"))
        .find_map(|(n, item)| match item.ty {
            ComponentItem::ComponentInstance(i) => i
                .exports(&engine)
                .find(|(_, it)| matches!(it.ty, ComponentItem::ComponentFunc(_)))
                .map(|(f, _)| (n.to_owned(), f.to_owned())),
            _ => None,
        })
        .expect("hello imports a plugin function");
    let linker = host_at(&engine, &component, &next_minor(), Host::Without(&func));
    let err = linker.instantiate_pre(&component).err().unwrap_or_else(|| panic!("{iface} without {func} linked"));
    assert!(format!("{err:?}").contains(&func), "{err:?}");
}
