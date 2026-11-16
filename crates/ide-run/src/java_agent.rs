//! Java agents of plugins (`[[contributes.javaAgents]]`): the JVM of an Application,
//! Spring Boot or JAR Application configuration gets one `-javaagent:<jar>[=<args>]`
//! per plugin whose `java.agent` capability the user granted, for Run and Debug alike.
//!
//! The grant records the jar's content hash; an agent whose jar no longer has it is
//! left out (with a console line) until the user approves it again. The desktop
//! installs the [`JavaAgentSource`]; elsewhere (`openidea-server`) there is none, so
//! remote projects never get an agent.

use ide_language::ProgramPin;
use parking_lot::RwLock;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Run configuration kinds whose JVM gets the agents.
pub const KINDS: &[&str] = &["application", "spring-boot", "jar-application"];

pub fn applies(kind: &str) -> bool {
    KINDS.contains(&kind)
}

/// An agent a plugin contributes, as it stands right before a launch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContributedAgent {
    pub plugin: String,
    /// The jar in the plugin's package (absolute).
    pub jar: PathBuf,
    pub args: Option<String>,
    /// The jar's hash recorded when the user granted `java.agent`; `None`: not granted.
    pub approved_hash: Option<String>,
}

/// The agents of the enabled plugins.
pub trait JavaAgentSource: Send + Sync {
    fn agents(&self) -> Vec<ContributedAgent>;
}

static SOURCE: RwLock<Option<Arc<dyn JavaAgentSource>>> = RwLock::new(None);

/// Installs (or removes) the source [`current`] reads.
pub fn set_java_agent_source(source: Option<Arc<dyn JavaAgentSource>>) {
    *SOURCE.write() = source;
}

/// What a launch adds: the `-javaagent:` options, and a console line per agent left out.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Agents {
    pub options: Vec<String>,
    pub notes: Vec<String>,
}

/// The agents the installed source allows now (none without a source).
pub fn current() -> Agents {
    let source = SOURCE.read().clone();
    source.map(|s| approved(&s.agents())).unwrap_or_default()
}

/// Granted agents whose jar still has the hash approved for it; an ungranted one is
/// left out silently, a changed or missing jar with a note.
pub fn approved(agents: &[ContributedAgent]) -> Agents {
    let mut out = Agents::default();
    for agent in agents {
        let Some(hash) = &agent.approved_hash else { continue };
        let pin = ProgramPin { path: agent.jar.clone(), hash: hash.clone() };
        match pin.verify() {
            Ok(jar) => out.options.push(option(jar, agent.args.as_deref())),
            Err(e) => out.notes.push(format!("The Java agent of plugin {} was not added: {e}", agent.plugin)),
        }
    }
    out
}

/// `-javaagent:<jar>[=<args>]`, one argument: the JVM takes the path as it is, spaces included.
pub fn option(jar: &Path, args: Option<&str>) -> String {
    match args.filter(|a| !a.is_empty()) {
        Some(args) => format!("-javaagent:{}={args}", jar.display()),
        None => format!("-javaagent:{}", jar.display()),
    }
}

/// Adds `options` to `java` arguments after the VM options (before the main class or
/// `-jar`), each as its own argument; one already there is not added again.
pub fn add_to_args(args: &mut Vec<String>, options: &[String]) {
    let mut at = crate::java_cmdline::vm_options_end(args);
    for option in options {
        if args[..at].contains(option) {
            continue;
        }
        args.insert(at, option.clone());
        at += 1;
    }
}

/// The same for a list of VM options (the Kotlin debugger's `vmArguments`).
pub fn add_to_vm_args(vm_args: &mut Vec<String>, options: &[String]) {
    for option in options {
        if !vm_args.contains(option) {
            vm_args.push(option.clone());
        }
    }
}

/// The same for VM options written as one line (java-debug's `vmArgs`): an option with
/// spaces is quoted the way the debugger's launch arguments are.
pub fn add_to_vm_args_text(vm_args: &str, options: &[String]) -> String {
    let present = split_text(vm_args);
    let mut out = vm_args.trim().to_owned();
    for option in options {
        if present.contains(option) {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&quote(option));
    }
    out
}

/// As the frontend's `joinJavaArgs` writes one argument.
fn quote(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains(|c: char| c.is_whitespace() || c == '"') {
        return arg.to_owned();
    }
    let mut out = String::from('"');
    for c in arg.chars() {
        if c == '"' || c == '\\' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

/// Splits a line of arguments written by [`quote`] (or by hand: unquoted words).
fn split_text(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = text.chars().peekable();
    loop {
        while chars.next_if(|c| c.is_whitespace()).is_some() {}
        if chars.peek().is_none() {
            return out;
        }
        let mut arg = String::new();
        let mut quoted = false;
        while let Some(c) = chars.next() {
            match c {
                '"' => quoted = !quoted,
                '\\' if quoted && matches!(chars.peek(), Some('"' | '\\')) => arg.extend(chars.next()),
                c if c.is_whitespace() && !quoted => break,
                c => arg.push(c),
            }
        }
        out.push(arg);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| (*s).to_owned()).collect()
    }

    struct Jar {
        _dir: tempfile::TempDir,
        path: PathBuf,
        hash: String,
    }

    /// An agent jar in a directory whose name has a space.
    fn jar() -> Jar {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("my plugins").join("agent.jar");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"PK agent").unwrap();
        let hash = ProgramPin::approve(&path).unwrap().hash;
        Jar { _dir: dir, path, hash }
    }

    fn agent(jar: &Jar, args: Option<&str>, granted: bool) -> ContributedAgent {
        ContributedAgent {
            plugin: "acme.spring".into(),
            jar: jar.path.clone(),
            args: args.map(str::to_owned),
            approved_hash: granted.then(|| jar.hash.clone()),
        }
    }

    #[test]
    fn only_granted_agents_with_their_approved_jar_are_added() {
        let jar = jar();
        assert_eq!(approved(&[agent(&jar, None, false)]), Agents::default(), "no grant: nothing, silently");
        let granted = approved(&[agent(&jar, Some("port=0"), true)]);
        assert_eq!(granted.options, [format!("-javaagent:{}=port=0", jar.path.display())]);
        assert!(granted.notes.is_empty());

        std::fs::write(&jar.path, b"PK swapped").unwrap();
        let changed = approved(&[agent(&jar, None, true)]);
        assert!(changed.options.is_empty());
        assert_eq!(changed.notes.len(), 1);
        assert!(changed.notes[0].contains("acme.spring") && changed.notes[0].contains("changed since it was approved"));

        std::fs::remove_file(&jar.path).unwrap();
        let missing = approved(&[agent(&jar, None, true)]);
        assert!(missing.options.is_empty() && missing.notes.len() == 1);
    }

    #[test]
    fn run_adds_one_argument_after_the_vm_options() {
        let jar = jar();
        let options = approved(&[agent(&jar, None, true)]).options;
        let option = format!("-javaagent:{}", jar.path.display());
        assert!(option.contains("my plugins"), "the path keeps its space, unquoted: {option}");

        // Application / Spring Boot: after the user's VM options and the classpath, before the main class.
        let mut args = strings(&["-Xmx1g", "-cp", "/p/classes", "app.Main", "--server.port=0"]);
        add_to_args(&mut args, &options);
        assert_eq!(args, strings(&["-Xmx1g", "-cp", "/p/classes", &option, "app.Main", "--server.port=0"]));
        // Already there (the user added it, or a second pass): not added again.
        let again = args.clone();
        add_to_args(&mut args, &options);
        assert_eq!(args, again);

        // JAR Application, Debug: after the JDWP agent and the user's options, before `-jar`.
        let jdwp = "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:0";
        let mut args = strings(&[jdwp, "-Dx=1", "-jar", "app.jar", "-v"]);
        add_to_args(&mut args, &options);
        assert_eq!(args, strings(&[jdwp, "-Dx=1", &option, "-jar", "app.jar", "-v"]));

        // A program argument equal to the option is not a VM option.
        let mut args = strings(&["app.Main", &option]);
        add_to_args(&mut args, &options);
        assert_eq!(args, strings(&[&option, "app.Main", &option]));

        let mut untouched = strings(&["-cp", "x", "Main"]);
        add_to_args(&mut untouched, &[]);
        assert_eq!(untouched, strings(&["-cp", "x", "Main"]));
    }

    #[test]
    fn a_shortened_command_line_keeps_the_agent_as_its_own_argument() {
        let jar = jar();
        let options = approved(&[agent(&jar, None, true)]).options;
        let classpath = vec!["/home/u/.m2/repository/org/x/lib/1.0/lib-1.0.jar"; 4000].join(":");
        let mut args = strings(&["-Xmx1g", "-cp", &classpath, "app.Main"]);
        add_to_args(&mut args, &options);
        let dir = tempfile::tempdir().unwrap();
        let jdk = dir.path().join("jdk");
        std::fs::create_dir_all(jdk.join("bin")).unwrap();
        std::fs::write(jdk.join("release"), "JAVA_VERSION=\"21.0.3\"").unwrap();
        let shortened = crate::java_cmdline::shorten(&jdk.join("bin/java"), &args, dir.path(), false, dir.path())
            .unwrap()
            .expect("too long for one argument");
        assert_eq!(shortened.how, crate::java_cmdline::Shortening::ArgFile);
        // Only the classpath moves into the argfile; the agent stays one argument, path and all.
        assert_eq!(shortened.args.len(), 4);
        assert_eq!(shortened.args[2], options[0]);
        assert!(!std::fs::read_to_string(&shortened.file).unwrap().contains("javaagent"));
    }

    #[test]
    fn debug_adds_the_option_to_the_debuggers_vm_options() {
        let jar = jar();
        let options = approved(&[agent(&jar, Some("trace sql"), true)]).options;
        let option = format!("-javaagent:{}=trace sql", jar.path.display());
        assert_eq!(options, std::slice::from_ref(&option));

        // java-debug: one line, quoted like the frontend quotes VM options with spaces.
        let text = add_to_vm_args_text("-Xmx1g -Dspring.output.ansi.enabled=always", &options);
        assert!(text.starts_with("-Xmx1g -Dspring.output.ansi.enabled=always \"-javaagent:"), "{text}");
        assert_eq!(split_text(&text), strings(&["-Xmx1g", "-Dspring.output.ansi.enabled=always", &option]));
        assert_eq!(add_to_vm_args_text(&text, &options), text, "not added twice");
        assert_eq!(split_text(&add_to_vm_args_text("", &options)), std::slice::from_ref(&option));
        assert_eq!(add_to_vm_args_text(" -Xmx1g ", &[]), "-Xmx1g");

        // The Kotlin debugger: a list.
        let mut list = strings(&["-Xmx1g"]);
        add_to_vm_args(&mut list, &options);
        add_to_vm_args(&mut list, &options);
        assert_eq!(list, strings(&["-Xmx1g", &option]));
    }

    #[test]
    fn quoting_round_trips() {
        for arg in ["plain", "with space", r#"q"uote"#, r"C:\Program Files\a.jar", ""] {
            assert_eq!(split_text(&quote(arg)), [arg.to_owned()], "{arg}");
        }
        assert_eq!(split_text("  a  \"b c\" d "), strings(&["a", "b c", "d"]));
    }

    #[test]
    fn kinds() {
        for kind in ["application", "spring-boot", "jar-application"] {
            assert!(applies(kind), "{kind}");
        }
        for kind in ["junit", "maven", "gradle", "tomcat", "java-file", "remote-jvm-debug"] {
            assert!(!applies(kind), "{kind}");
        }
    }
}
