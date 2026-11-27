//! Plugin dependencies and plugin-declared extension points through a real WASM owner
//! (`ide-plugin/tests/fixtures/ext-owner`) and data-only dependents.
use ide_extension::DependencyState;
use ide_host::plugins::{Consent, PluginHost, PluginInfo, PluginStatus};
use ide_plugin::{Invocation, Limits};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

const OWNER: &str = "test.ext-owner";
const POINT: &str = "test.ext-owner.items";

struct Fixture {
    _tmp: tempfile::TempDir,
    plugins_dir: PathBuf,
    host: PluginHost,
}

impl Fixture {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let plugins_dir = root.join("plugins");
        let host = Self::host_on(&plugins_dir);
        host.load_all();
        Self { _tmp: tmp, plugins_dir, host }
    }

    fn host_on(plugins_dir: &Path) -> PluginHost {
        PluginHost::new(plugins_dir.to_owned(), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap()
    }

    /// Installs the real owner plugin, optionally at another version.
    fn install_owner(&self, version: &str) -> Result<PluginInfo, String> {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/ext-owner");
        let pkg = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(pkg.path().join("dist")).unwrap();
        std::fs::copy(fixture.join("dist/plugin.wasm"), pkg.path().join("dist/plugin.wasm")).unwrap();
        let toml = std::fs::read_to_string(fixture.join("plugin.toml")).unwrap();
        std::fs::write(
            pkg.path().join("plugin.toml"),
            toml.replace("version = \"0.1.0\"", &format!("version = \"{version}\"")),
        )
        .unwrap();
        self.install_dir(pkg.path())
    }

    /// Installs a plugin made of a manifest only (contributions, no code).
    fn install_data(&self, id: &str, version: &str, body: &str) -> Result<PluginInfo, String> {
        let pkg = tempfile::tempdir().unwrap();
        let manifest =
            format!("id = \"{id}\"\nname = \"{id}\"\nversion = \"{version}\"\nengines.openidea = \"^1.5\"\n{body}");
        std::fs::write(pkg.path().join("plugin.toml"), manifest).unwrap();
        self.install_dir(pkg.path())
    }

    fn install_dir(&self, dir: &Path) -> Result<PluginInfo, String> {
        self.host.install_from_dir(dir, &Consent::all()).map_err(|e| e.message)
    }

    fn contributor(&self) -> Result<PluginInfo, String> {
        self.install_data(
            "test.ext-contributor",
            "0.2.0",
            &format!(
                "[[depends]]\nid = \"{OWNER}\"\nversion = \"^0.1\"\n\n[[contributes.\"{POINT}\"]]\nname = \"from-contributor\"\nweight = 7\n"
            ),
        )
    }

    fn run(&self, plugin: &str, command: &str, arg: Option<&str>) -> Result<Option<String>, String> {
        let inv = Invocation { client: Some("main".into()), ..Default::default() };
        self.host.run_command(plugin, command, arg, inv).map_err(|e| e.message)
    }

    fn info(&self, id: &str) -> PluginInfo {
        self.host.info_of(id).unwrap()
    }
}

#[test]
fn a_dependent_contributes_data_that_reaches_the_owners_code() {
    let f = Fixture::new();
    f.install_owner("0.1.0").unwrap();
    f.contributor().unwrap();

    let dump = f.run(OWNER, "dump", None).unwrap().unwrap();
    assert_eq!(dump, r#"test.ext-contributor:{"name":"from-contributor","weight":7}"#);

    let owner = f.info(OWNER);
    assert_eq!(owner.extension_points.len(), 1);
    assert_eq!(owner.extension_points[0].id, POINT);
    assert_eq!(owner.extension_points[0].contributors, ["test.ext-contributor"]);
    assert_eq!(owner.dependents.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), ["test.ext-contributor"]);

    let contributor = f.info("test.ext-contributor");
    assert_eq!(contributor.status, PluginStatus::Static);
    assert_eq!(contributor.depends.len(), 1);
    assert_eq!(contributor.depends[0].state, DependencyState::Satisfied);
    assert_eq!(contributor.depends[0].name.as_deref(), Some("Extension point owner"));
}

#[test]
fn a_plugin_waits_for_the_plugin_it_needs_and_starts_when_it_arrives() {
    let f = Fixture::new();
    let waiting = f.contributor().unwrap();
    assert_eq!(waiting.status, PluginStatus::Blocked);
    assert_eq!(waiting.error.as_deref(), Some("Requires test.ext-owner ^0.1, which is not installed"));
    assert_eq!(waiting.depends[0].state, DependencyState::Missing);

    f.install_owner("0.1.0").unwrap();
    assert_eq!(f.info("test.ext-contributor").status, PluginStatus::Static, "started with its dependency");
    assert_eq!(f.info("test.ext-contributor").error, None);
    assert!(f.run(OWNER, "dump", None).unwrap().unwrap().contains("from-contributor"));
}

#[test]
fn disabling_a_plugin_stops_what_needs_it_and_enabling_brings_it_back() {
    let f = Fixture::new();
    f.install_owner("0.1.0").unwrap();
    f.contributor().unwrap();

    f.host.set_enabled(OWNER, false).unwrap();
    let blocked = f.info("test.ext-contributor");
    assert_eq!(blocked.status, PluginStatus::Blocked);
    assert_eq!(blocked.error.as_deref(), Some("Requires test.ext-owner, which is disabled"));
    assert_eq!(blocked.depends[0].state, DependencyState::Disabled);
    assert!(blocked.contributions.is_empty(), "its contributions are withdrawn");

    f.host.set_enabled(OWNER, true).unwrap();
    assert_eq!(f.info("test.ext-contributor").status, PluginStatus::Static);
    assert!(f.run(OWNER, "dump", None).unwrap().unwrap().contains("from-contributor"));
}

#[test]
fn a_version_the_requirement_does_not_accept_blocks() {
    let f = Fixture::new();
    f.install_owner("0.3.0").unwrap();
    let info = f.contributor().unwrap();
    assert_eq!(info.status, PluginStatus::Blocked);
    assert_eq!(info.error.as_deref(), Some("Requires test.ext-owner ^0.1, but version 0.3.0 is installed"));
    assert_eq!(info.depends[0].state, DependencyState::Version);
}

#[test]
fn updating_the_owner_checks_its_dependents_again() {
    let f = Fixture::new();
    f.install_owner("0.1.0").unwrap();
    f.contributor().unwrap();
    assert_eq!(f.info("test.ext-contributor").status, PluginStatus::Static);

    f.install_owner("0.3.0").unwrap();
    assert_eq!(f.info("test.ext-contributor").status, PluginStatus::Blocked, "^0.1 no longer matches");

    f.install_owner("0.1.5").unwrap();
    assert_eq!(f.info("test.ext-contributor").status, PluginStatus::Static);
}

#[test]
fn plugins_that_need_each_other_do_not_start_and_say_so() {
    let f = Fixture::new();
    let a = f.install_data("test.cycle-a", "1.0.0", "[[depends]]\nid = \"test.cycle-b\"\n").unwrap();
    assert_eq!(a.status, PluginStatus::Blocked, "b is not installed yet");
    let b = f.install_data("test.cycle-b", "1.0.0", "[[depends]]\nid = \"test.cycle-a\"\n").unwrap();
    for info in [b, f.info("test.cycle-a")] {
        assert_eq!(info.status, PluginStatus::Blocked, "{}", info.id);
        assert_eq!(
            info.error.as_deref(),
            Some("Part of a dependency cycle: test.cycle-a → test.cycle-b → test.cycle-a"),
            "{}",
            info.id
        );
    }
}

#[test]
fn a_restart_of_the_app_starts_plugins_after_the_ones_they_need() {
    let f = Fixture::new();
    f.install_owner("0.1.0").unwrap();
    f.contributor().unwrap();
    f.host.shutdown();

    // "test.ext-contributor" sorts before "test.ext-owner": directory order would start it first.
    let again = Fixture::host_on(&f.plugins_dir);
    again.load_all();
    assert_eq!(again.info_of("test.ext-contributor").unwrap().status, PluginStatus::Static);
    let inv = Invocation { client: Some("main".into()), ..Default::default() };
    let dump = again.run_command(OWNER, "dump", None, inv).unwrap().unwrap();
    assert!(dump.contains("from-contributor"), "{dump}");
}

#[test]
fn only_the_declaring_plugin_reads_a_point_and_unknown_points_are_not_found() {
    let f = Fixture::new();
    f.install_owner("0.1.0").unwrap();
    f.install_data(
        "test.other",
        "1.0.0",
        "[[extension-points]]\nid = \"test.other.things\"\nfields = { name = \"string\" }\n",
    )
    .unwrap();

    assert_eq!(f.run(OWNER, "read", Some(POINT)).unwrap().as_deref(), Some("0"));
    let denied = f.run(OWNER, "read", Some("test.other.things")).unwrap_err();
    assert!(denied.contains("denied") || denied.contains("permission"), "{denied}");
    let missing = f.run(OWNER, "read", Some("test.nobody.things")).unwrap_err();
    assert!(missing.contains("no running plugin declares"), "{missing}");
}

#[test]
fn contributions_are_checked_against_the_fields_the_point_declares() {
    let f = Fixture::new();
    f.install_owner("0.1.0").unwrap();
    let body = format!("[[depends]]\nid = \"{OWNER}\"\n\n[[contributes.\"{POINT}\"]]\nweight = 1\n");
    let err = f.install_data("test.bad", "1.0.0", &body).unwrap_err();
    assert!(err.contains("missing required field \"name\""), "{err}");

    let body =
        format!("[[depends]]\nid = \"{OWNER}\"\n\n[[contributes.\"{POINT}\"]]\nname = \"x\"\ncolour = \"red\"\n");
    let err = f.install_data("test.bad", "1.0.0", &body).unwrap_err();
    assert!(err.contains("unknown field \"colour\""), "{err}");

    let body = format!("[[contributes.\"{POINT}\"]]\nname = \"x\"\n");
    let err = f.install_data("test.bad", "1.0.0", &body).unwrap_err();
    assert!(err.contains("[[depends]]"), "contributing needs the dependency: {err}");
}

/// An optional requirement never blocks, but the plugin still contributes once the plugin
/// appears (IntelliJ loads an optional `depends` part when its target is installed or enabled later).
#[test]
fn an_optional_dependent_contributes_when_its_target_appears_later() {
    let f = Fixture::new();
    let body = format!(
        "[[depends]]\nid = \"{OWNER}\"\noptional = true\n\n[[contributes.\"{POINT}\"]]\nname = \"optional-one\"\n"
    );
    let early = f.install_data("test.optional", "1.0.0", &body).unwrap();
    assert_eq!(early.status, PluginStatus::Static, "an optional requirement never blocks: {:?}", early.error);
    assert_eq!(early.depends[0].state, DependencyState::Missing);

    f.install_owner("0.1.0").unwrap();
    let dump = f.run(OWNER, "dump", None).unwrap().unwrap();
    assert!(dump.contains("optional-one"), "contributed once the owner appeared: {dump:?}");

    // Off and on again: it is back without restarting anything.
    f.host.set_enabled(OWNER, false).unwrap();
    assert_eq!(f.info("test.optional").status, PluginStatus::Static, "optional: not blocked");
    f.host.set_enabled(OWNER, true).unwrap();
    assert!(f.run(OWNER, "dump", None).unwrap().unwrap().contains("optional-one"));
}

#[test]
fn the_owner_hears_that_contributions_changed() {
    let f = Fixture::new();
    f.install_owner("0.1.0").unwrap();
    // The owner is running when the contribution arrives.
    f.run(OWNER, "dump", None).unwrap();
    f.contributor().unwrap();
    f.host.flush_events();
    assert!(f.host.wait_events(Duration::from_secs(10)), "the event was delivered");
    let seen = f.run(OWNER, "changes", None).unwrap().unwrap();
    assert!(seen.contains(POINT), "{seen}");

    // Only the owner hears: a plugin that declares nothing is not woken for it.
    let other = f.info("test.ext-contributor");
    assert_eq!(other.stats.activations, 0);
}

#[test]
fn a_dependent_follows_its_dependency_through_permission_changes() {
    let f = Fixture::new();
    f.install_owner("0.1.0").unwrap();
    f.contributor().unwrap();
    assert_eq!(f.info("test.ext-contributor").status, PluginStatus::Static);

    // Revoking a permission the owner requires stops it, and what needs it with it.
    f.host.set_capability(OWNER, "storage", false).unwrap();
    assert_ne!(f.info(OWNER).status, PluginStatus::Active);
    assert_eq!(f.info("test.ext-contributor").status, PluginStatus::Blocked);

    // Granting it again starts both, without touching the dependent.
    f.host.set_capability(OWNER, "storage", true).unwrap();
    assert_eq!(f.info("test.ext-contributor").status, PluginStatus::Static);
    assert!(f.run(OWNER, "dump", None).unwrap().unwrap().contains("from-contributor"));
}
