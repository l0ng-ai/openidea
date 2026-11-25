//! The `javaAgents` extension point (API 1.10; `vmOptions` / `jdk` in 1.14): a Java
//! agent the host loads into the JVM of Application, Spring Boot and JAR Application
//! configurations, with optional JVM flags.
//!
//! ```toml
//! [[contributes.javaAgents]]
//! path = "agent/openidea-spring-agent.jar"   # inside the package
//! args = "optional-arguments"                # optional
//! vmOptions = ["-XX:+AllowEnhancedClassRedefinition"]  # optional, API 1.14
//! jdk = "jetbrains"                          # optional: only those VM options on JBR
//! ```
//!
//! One agent per plugin. The declaration derives the optional high-risk `java.agent`
//! capability; granting it records the jar's hash, and a launch adds the agent only
//! while the jar still has it ([`ide_run::java_agent`]).

use ide_extension::{Capability, Disposable, ExtensionPoint, Manifest, Package, Placement, Prepared, decode};
use ide_language::ProgramPin;
use ide_run::java_agent::{ContributedAgent, JavaAgentSource};
use parking_lot::RwLock;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

pub const POINT_ID: &str = "javaAgents";
const MAX_ARGS: usize = 4096;
const MAX_VM_OPTION: usize = 512;
const MAX_VM_OPTIONS: usize = 32;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Decl {
    path: PathBuf,
    #[serde(default)]
    args: Option<String>,
    #[serde(default, rename = "vmOptions")]
    vm_options: Vec<String>,
    #[serde(default)]
    jdk: Option<String>,
}

#[derive(Clone, Debug)]
pub(super) struct Agent {
    /// The jar, resolved inside the package.
    pub(super) jar: PathBuf,
    pub(super) args: Option<String>,
    pub(super) vm_options: Vec<String>,
    pub(super) jdk: Option<String>,
}

/// Agents of enabled plugins.
#[derive(Default)]
pub struct JavaAgents {
    items: RwLock<Vec<(u64, String, Agent)>>,
    seq: AtomicU64,
}

impl JavaAgents {
    pub(super) fn for_plugin(&self, plugin: &str) -> Option<Agent> {
        self.items.read().iter().find(|(_, id, _)| id == plugin).map(|(_, _, agent)| agent.clone())
    }

    fn add(self: &Arc<Self>, plugin: String, agent: Agent) -> Disposable {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        self.items.write().push((seq, plugin, agent));
        let weak = Arc::downgrade(self);
        Disposable::new(move || {
            if let Some(this) = weak.upgrade() {
                this.items.write().retain(|(s, _, _)| *s != seq);
            }
        })
    }
}

pub struct JavaAgentsPoint {
    store: Arc<JavaAgents>,
}

impl JavaAgentsPoint {
    pub fn new(store: Arc<JavaAgents>) -> Self {
        Self { store }
    }
}

impl ExtensionPoint for JavaAgentsPoint {
    fn id(&self) -> &'static str {
        POINT_ID
    }

    fn placement(&self) -> Placement {
        Placement::Workspace
    }

    fn prepare(&self, pkg: &Package, decl: toml::Value) -> Result<Prepared, String> {
        pkg.manifest.needs_api("contributes.javaAgents", 10)?;
        if pkg.manifest.declarations(POINT_ID).len() > 1 {
            return Err("contributes.javaAgents: a plugin contributes at most one Java agent".into());
        }
        let d: Decl = decode(POINT_ID, decl)?;
        let jar = resolve(&pkg.dir, &d.path)?;
        let args = d.args.filter(|a| !a.is_empty());
        if let Some(args) = &args
            && (args.len() > MAX_ARGS || args.contains(|c: char| c.is_control()))
        {
            return Err(format!("contributes.javaAgents: `args` must be one line of at most {MAX_ARGS} bytes"));
        }
        let vm_options = validate_vm_options(&d.vm_options)?;
        let jdk = validate_jdk(d.jdk)?;
        if !vm_options.is_empty() || jdk.is_some() {
            pkg.manifest.needs_api("contributes.javaAgents.vmOptions", 14)?;
        }
        let label = label(&d.path, args.as_deref(), &vm_options);
        let (store, plugin) = (self.store.clone(), pkg.id().to_owned());
        let agent = Agent { jar, args, vm_options, jdk };
        Ok(Prepared::new(label, move || Ok(store.add(plugin, agent))).file(d.path).capability(Capability::JavaAgent))
    }
}

fn validate_vm_options(raw: &[String]) -> Result<Vec<String>, String> {
    if raw.len() > MAX_VM_OPTIONS {
        return Err(format!("contributes.javaAgents: at most {MAX_VM_OPTIONS} `vmOptions`"));
    }
    let mut out = Vec::with_capacity(raw.len());
    for opt in raw {
        let opt = opt.trim();
        if opt.is_empty() {
            continue;
        }
        if !opt.starts_with('-')
            || opt.len() > MAX_VM_OPTION
            || opt.contains(|c: char| c.is_control() || c.is_whitespace())
        {
            return Err(format!(
                "contributes.javaAgents: each `vmOptions` entry must be one flag starting with `-` (at most {MAX_VM_OPTION} bytes, no spaces)"
            ));
        }
        if !out.iter().any(|o: &String| o == opt) {
            out.push(opt.to_owned());
        }
    }
    Ok(out)
}

fn validate_jdk(jdk: Option<String>) -> Result<Option<String>, String> {
    let Some(raw) = jdk.map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if raw != "jetbrains" {
        return Err("contributes.javaAgents: `jdk` must be \"jetbrains\" when set".into());
    }
    Ok(Some(raw))
}

/// What Settings › Plugins shows: jar name, args, and any JVM options.
fn label(path: &Path, args: Option<&str>, vm_options: &[String]) -> String {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut out = match args {
        Some(args) => format!("{name}={args}"),
        None => name,
    };
    if !vm_options.is_empty() {
        out.push(' ');
        out.push_str(&vm_options.join(" "));
    }
    out
}

/// The jar a package's declaration names, as an absolute path inside the package:
/// `..`, absolute paths and symlinks that lead out of it are refused.
fn resolve(dir: &Path, rel: &Path) -> Result<PathBuf, String> {
    ide_extension::check_relative(rel, "contributes.javaAgents: `path`")?;
    let root = dunce::canonicalize(dir).map_err(|e| format!("plugin directory: {e}"))?;
    let jar = dunce::canonicalize(dir.join(rel))
        .map_err(|_| format!("contributes.javaAgents: {}: no such file in the plugin", rel.display()))?;
    if !jar.starts_with(&root) {
        return Err(format!("contributes.javaAgents: {}: points outside the plugin", rel.display()));
    }
    if !jar.is_file() {
        return Err(format!("contributes.javaAgents: {}: not a file", rel.display()));
    }
    Ok(jar)
}

/// The jar the package at `dir` declares, for recording its hash when `java.agent`
/// is granted (before the declaration has taken effect, as on install).
pub(super) fn declared_jar(manifest: &Manifest, dir: &Path) -> Option<PathBuf> {
    let decl = manifest.declarations(POINT_ID).into_iter().next()?;
    let d: Decl = decode(POINT_ID, decl).ok()?;
    resolve(dir, &d.path).ok()
}

/// Declared `vmOptions` (for consent / Settings copy), if the package has a valid declaration.
pub(super) fn declared_vm_options(manifest: &Manifest) -> Vec<String> {
    let decl = manifest.declarations(POINT_ID).into_iter().next();
    let Some(decl) = decl else { return Vec::new() };
    let Ok(d) = decode::<Decl>(POINT_ID, decl) else {
        return Vec::new();
    };
    validate_vm_options(&d.vm_options).unwrap_or_default()
}

type Pins = Arc<RwLock<HashMap<(String, String), ProgramPin>>>;

/// [`JavaAgentSource`] over the agents and the hashes granted for them.
pub struct PluginJavaAgents {
    pub(super) store: Arc<JavaAgents>,
    pub(super) pins: Pins,
}

impl JavaAgentSource for PluginJavaAgents {
    fn agents(&self) -> Vec<ContributedAgent> {
        let cap = Capability::JavaAgent.to_string();
        let pins = self.pins.read();
        self.store
            .items
            .read()
            .iter()
            .map(|(_, plugin, agent)| ContributedAgent {
                plugin: plugin.clone(),
                jar: agent.jar.clone(),
                args: agent.args.clone(),
                vm_options: agent.vm_options.clone(),
                jdk: agent.jdk.clone(),
                approved_hash: pins.get(&(plugin.clone(), cap.clone())).map(|pin| pin.hash.clone()),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MANIFEST: &str =
        "id = \"acme.spring\"\nname = \"Spring\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.10\"\n";
    const MANIFEST_14: &str =
        "id = \"acme.spring\"\nname = \"Spring\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.14\"\n";

    fn package(dir: &Path, manifest: &str) -> Package {
        std::fs::create_dir_all(dir.join("agent")).unwrap();
        std::fs::write(dir.join("agent/spring agent.jar"), b"PK").unwrap();
        Package::new(Manifest::parse(manifest).unwrap(), dir.to_path_buf())
    }

    fn prepare(pkg: &Package) -> Result<Prepared, String> {
        let point = JavaAgentsPoint::new(Arc::default());
        let decls = pkg.manifest.declarations(POINT_ID);
        let mut last = Err("no declaration".into());
        for decl in decls {
            last = Ok(point.prepare(pkg, decl)?);
        }
        last
    }

    #[test]
    fn parses_the_declaration_and_derives_the_capability() {
        let tmp = tempfile::tempdir().unwrap();
        let toml = format!(
            "{MANIFEST}[[contributes.javaAgents]]\npath = \"agent/spring agent.jar\"\nargs = \"port=0,trace\"\n"
        );
        let pkg = package(tmp.path(), &toml);
        let prepared = prepare(&pkg).unwrap();
        assert_eq!(prepared.capabilities, [Capability::JavaAgent]);
        assert_eq!(prepared.files, [PathBuf::from("agent/spring agent.jar")]);
        assert_eq!(prepared.label, "spring agent.jar=port=0,trace");
        let jar = declared_jar(&pkg.manifest, &pkg.dir).unwrap();
        assert_eq!(jar, dunce::canonicalize(tmp.path().join("agent/spring agent.jar")).unwrap());

        let store: Arc<JavaAgents> = Arc::default();
        let point = JavaAgentsPoint::new(store.clone());
        let decl = pkg.manifest.declarations(POINT_ID).remove(0);
        let disposable = (point.prepare(&pkg, decl).unwrap().commit)().unwrap();
        let source = PluginJavaAgents { store: store.clone(), pins: Arc::default() };
        let agents = source.agents();
        assert_eq!(agents.len(), 1);
        assert_eq!(
            (agents[0].plugin.as_str(), agents[0].args.as_deref(), agents[0].approved_hash.as_ref()),
            ("acme.spring", Some("port=0,trace"), None)
        );
        assert!(agents[0].vm_options.is_empty());
        source.pins.write().insert(("acme.spring".into(), "java.agent".into()), ProgramPin::approve(&jar).unwrap());
        assert!(source.agents()[0].approved_hash.is_some());
        disposable.dispose();
        assert!(source.agents().is_empty(), "disabling the plugin drops its agent");
    }

    #[test]
    fn parses_vm_options_and_jdk_gate() {
        let tmp = tempfile::tempdir().unwrap();
        let toml = format!(
            "{MANIFEST_14}[[contributes.javaAgents]]\npath = \"agent/spring agent.jar\"\nvmOptions = [\"-XX:+AllowEnhancedClassRedefinition\"]\njdk = \"jetbrains\"\n"
        );
        let pkg = package(tmp.path(), &toml);
        let prepared = prepare(&pkg).unwrap();
        assert_eq!(prepared.label, "spring agent.jar -XX:+AllowEnhancedClassRedefinition");
        assert_eq!(declared_vm_options(&pkg.manifest), ["-XX:+AllowEnhancedClassRedefinition"]);

        let store: Arc<JavaAgents> = Arc::default();
        let point = JavaAgentsPoint::new(store.clone());
        let decl = pkg.manifest.declarations(POINT_ID).remove(0);
        let _keep = (point.prepare(&pkg, decl).unwrap().commit)().unwrap();
        let agent = store.for_plugin("acme.spring").unwrap();
        assert_eq!(agent.vm_options, ["-XX:+AllowEnhancedClassRedefinition"]);
        assert_eq!(agent.jdk.as_deref(), Some("jetbrains"));
    }

    #[test]
    fn refuses_what_would_fail_at_launch() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("evil.jar"), b"PK").unwrap();
        let refused = |n: usize, manifest: &str| {
            let dir = tmp.path().join(n.to_string());
            prepare(&package(&dir, manifest)).map(|_| ()).unwrap_err()
        };
        let case = |n: usize, body: &str| refused(n, &format!("{MANIFEST}{body}"));
        let agent = |path: &str| format!("[[contributes.javaAgents]]\npath = \"{path}\"\n");
        assert!(case(0, &agent("../evil.jar")).contains("relative path inside the plugin"));
        assert!(case(1, &agent("/etc/passwd")).contains("relative path inside the plugin"));
        assert!(case(2, &agent("agent/missing.jar")).contains("no such file"));
        assert!(case(3, &agent("agent")).contains("not a file"));
        let two = format!("{}{}", agent("agent/spring agent.jar"), agent("agent/spring agent.jar"));
        assert!(case(4, &two).contains("at most one Java agent"));
        assert!(
            case(5, "[[contributes.javaAgents]]\npath = \"agent/spring agent.jar\"\nargs = \"a\\nb\"\n")
                .contains("one line")
        );
        assert!(
            case(6, "[[contributes.javaAgents]]\npath = \"agent/spring agent.jar\"\nmain = \"x\"\n")
                .contains("unknown field")
        );
        let old = format!("{}{}", MANIFEST.replace("^1.10", "^1.9"), agent("agent/spring agent.jar"));
        assert!(refused(7, &old).contains("new in plugin API 1.10"));
        assert!(
            refused(
                9,
                &format!(
                    "{MANIFEST}[[contributes.javaAgents]]\npath = \"agent/spring agent.jar\"\nvmOptions = [\"-XX:+AllowEnhancedClassRedefinition\"]\n"
                ),
            )
            .contains("new in plugin API 1.14")
        );
        assert!(
            refused(
                10,
                &format!(
                    "{MANIFEST_14}[[contributes.javaAgents]]\npath = \"agent/spring agent.jar\"\nvmOptions = [\"not-a-flag\"]\n"
                ),
            )
            .contains("starting with `-`")
        );
        assert!(
            refused(
                11,
                &format!(
                    "{MANIFEST_14}[[contributes.javaAgents]]\npath = \"agent/spring agent.jar\"\njdk = \"temurin\"\n"
                ),
            )
            .contains("jetbrains")
        );
        #[cfg(unix)]
        {
            let dir = tmp.path().join("8");
            let pkg = package(&dir, &format!("{MANIFEST}{}", agent("agent/link.jar")));
            std::os::unix::fs::symlink(outside.path().join("evil.jar"), dir.join("agent/link.jar")).unwrap();
            assert!(prepare(&pkg).map(|_| ()).unwrap_err().contains("points outside the plugin"));
            assert_eq!(declared_jar(&pkg.manifest, &pkg.dir), None);
        }
    }
}
