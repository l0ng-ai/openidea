//! Isolated local Tomcat installations and deployments. Never writes to CATALINA_HOME.
use crate::RunConfig;
use ide_core::{IdeError, IdeResult};
use quick_xml::{
    Reader, Writer,
    events::{BytesStart, Event},
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    fs,
    io::Read,
    net::TcpListener,
    path::{Path, PathBuf},
};

fn invalid(e: impl std::fmt::Display) -> IdeError {
    IdeError::invalid(e.to_string())
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TomcatHome {
    pub version: String,
}

pub fn validate_home(home: &Path) -> IdeResult<TomcatHome> {
    if !(home.join("bin/catalina.sh").is_file() || home.join("bin/catalina.bat").is_file())
        || !home.join("lib/catalina.jar").is_file()
    {
        return Err(invalid("Tomcat home must contain bin/catalina.sh or bin/catalina.bat and lib/catalina.jar"));
    }
    let mut jar = zip::ZipArchive::new(fs::File::open(home.join("lib/catalina.jar"))?).map_err(invalid)?;
    let mut properties = String::new();
    jar.by_name("org/apache/catalina/util/ServerInfo.properties").map_err(invalid)?.read_to_string(&mut properties)?;
    let version =
        properties.lines().find_map(|l| l.strip_prefix("server.info=")).unwrap_or("Apache Tomcat").trim().to_owned();
    Ok(TomcatHome { version })
}

pub fn base_dir(cache: &Path, id: &str) -> PathBuf {
    // Stable and collision-free for configuration IDs, including Windows path characters.
    let key: String = id.as_bytes().iter().map(|b| format!("{b:02x}")).collect();
    cache.join("tomcat").join(key)
}

pub fn free_port() -> IdeResult<u16> {
    Ok(TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

pub fn context_name(context: &str) -> IdeResult<String> {
    if context.is_empty() || context == "/" {
        return Ok("ROOT".into());
    }
    if !context.starts_with('/')
        || context.ends_with('/')
        || context[1..].split('/').any(|p| {
            p.is_empty() || p == "." || p == ".." || !p.chars().all(|c| c.is_alphanumeric() || "-_".contains(c))
        })
    {
        return Err(invalid("Context path must start with / and contain only letters, digits, /, - or _"));
    }
    Ok(context[1..].replace('/', "#"))
}

fn escape(text: &str) -> String {
    quick_xml::escape::escape(text).into_owned()
}

pub fn context_xml(doc_base: &Path, reload: bool) -> String {
    format!("<Context docBase=\"{}\" reloadable=\"{reload}\" />\n", escape(&doc_base.to_string_lossy()))
}

pub fn patch_server_xml(xml: &str, http: u16, shutdown: u16, secret: &str) -> IdeResult<String> {
    let mut reader = Reader::from_str(xml);
    let mut writer = Writer::new(Vec::new());
    let mut http_found = false;
    loop {
        let event = reader.read_event().map_err(invalid)?;
        if matches!(event, Event::Eof) {
            break;
        }
        let event = match event {
            Event::Start(ref tag) | Event::Empty(ref tag) => {
                let name = tag.name().as_ref().to_owned();
                let mut attrs: Vec<(String, String)> = tag
                    .attributes()
                    .map(|a| {
                        let a = a.map_err(invalid)?;
                        Ok((
                            a.key.as_ref().to_owned(),
                            a.normalized_value(quick_xml::XmlVersion::Implicit1_0).map_err(invalid)?.into_owned(),
                        ))
                    })
                    .collect::<IdeResult<_>>()?;
                let mut set = |key: &str, value: String| {
                    attrs.retain(|(k, _)| k != key);
                    attrs.push((key.into(), value));
                };
                match name.as_str() {
                    "Server" => {
                        set("port", shutdown.to_string());
                        set("address", "127.0.0.1".into());
                        set("shutdown", secret.into());
                    }
                    "Connector" => {
                        let protocol = tag
                            .try_get_attribute("protocol")
                            .map_err(invalid)?
                            .map(|a| a.value.into_owned())
                            .unwrap_or_default();
                        let is_http = !http_found
                            && (protocol.is_empty() || protocol.contains("HTTP") || protocol.contains("Http"));
                        set("port", if is_http { http } else { free_port()? }.to_string());
                        if is_http {
                            http_found = true;
                        }
                    }
                    "Engine" => set("name", "Catalina".into()),
                    "Host" => {
                        set("name", "localhost".into());
                        set("appBase", "webapps".into());
                        set("autoDeploy", "true".into());
                        set("deployOnStartup", "true".into());
                    }
                    _ => {}
                }
                let mut new = BytesStart::new(name);
                for (k, v) in &attrs {
                    new.push_attribute((k.as_str(), v.as_str()));
                }
                if matches!(event, Event::Empty(_)) { Event::Empty(new) } else { Event::Start(new) }
            }
            e => e.into_owned(),
        };
        writer.write_event(event).map_err(invalid)?;
    }
    if !http_found {
        return Err(invalid("Tomcat server.xml has no HTTP connector"));
    }
    String::from_utf8(writer.into_inner()).map_err(invalid)
}

fn copy_tree(from: &Path, to: &Path) -> IdeResult<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Synchronize an archive into a private exploded deployment, preserving unchanged class timestamps.
pub fn explode(war: &Path, destination: &Path, resources_only: bool) -> IdeResult<()> {
    let mut zip = zip::ZipArchive::new(fs::File::open(war)?).map_err(invalid)?;
    fs::create_dir_all(destination)?;
    let mut expected = std::collections::HashSet::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(invalid)?;
        let path = entry.enclosed_name().ok_or_else(|| invalid("WAR contains an invalid path"))?;
        expected.insert(path.clone());
        if entry.is_dir() {
            continue;
        }
        if resources_only && (path.extension().is_some_and(|e| e == "class") || path.starts_with("WEB-INF/lib")) {
            continue;
        }
        let target = destination.join(&path);
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes)?;
        if fs::read(&target).ok().as_deref() != Some(&bytes) {
            fs::create_dir_all(target.parent().unwrap())?;
            fs::write(target, bytes)?;
        }
    }
    fn remove_stale(
        root: &Path,
        dir: &Path,
        expected: &std::collections::HashSet<PathBuf>,
        resources: bool,
    ) -> IdeResult<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if entry.file_type()?.is_dir() {
                remove_stale(root, &path, expected, resources)?;
            } else {
                let rel = path.strip_prefix(root).map_err(invalid)?;
                if !expected.contains(rel)
                    && !(resources && (rel.extension().is_some_and(|e| e == "class") || rel.starts_with("WEB-INF/lib")))
                {
                    fs::remove_file(path)?;
                }
            }
        }
        Ok(())
    }
    remove_stale(destination, destination, &expected, resources_only)
}

pub fn deployment(root: &Path, base: &Path, config: &RunConfig, resources_only: bool) -> IdeResult<PathBuf> {
    let p = &config.extras.params;
    match p.get("deployment").map(String::as_str).unwrap_or("artifact") {
        "artifact" => {
            if let Some(id) = p.get("artifact").filter(|s| !s.is_empty())
                && fs::read_to_string(base.join("artifact-id.txt")).ok().as_ref() != Some(id)
            {
                return Err(invalid("Build the selected WAR artifact before launching Tomcat"));
            }
            let war = fs::read_to_string(base.join("artifact-path.txt"))
                .map_err(|_| invalid("Build the WAR artifact before launching Tomcat"))?;
            let war = PathBuf::from(war.trim());
            if !war.is_file() || !war.extension().is_some_and(|e| e.eq_ignore_ascii_case("war")) {
                return Err(invalid("The built WAR artifact does not exist"));
            }
            let dest = base.join("deployment");
            explode(&war, &dest, resources_only)?;
            Ok(dest)
        }
        kind @ ("war" | "directory") => {
            let value = p
                .get("deploymentPath")
                .filter(|v| !v.trim().is_empty())
                .ok_or_else(|| invalid("Choose a WAR file or exploded directory"))?;
            let path = root.join(value).canonicalize()?;
            if (kind == "war" && (!path.is_file() || !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("war"))))
                || (kind == "directory" && !path.is_dir())
            {
                return Err(invalid("Invalid Tomcat deployment"));
            }
            Ok(path)
        }
        _ => Err(invalid("Unknown Tomcat deployment type")),
    }
}

pub fn effective_context(config: &RunConfig, doc: &Path) -> String {
    config.extras.params.get("contextPath").filter(|s| !s.is_empty()).cloned().unwrap_or_else(|| {
        let name = config
            .extras
            .params
            .get("artifactName")
            .cloned()
            .unwrap_or_else(|| doc.file_stem().unwrap_or_default().to_string_lossy().into_owned());
        if name == "ROOT" { "/".into() } else { format!("/{name}") }
    })
}

/// Platform-neutral plan; Windows uses the process manager's raw cmd quoting for batch scripts.
pub fn script_command(home: &Path, windows: bool, verb: &str) -> (String, Vec<String>) {
    if windows {
        (format!("\"{}\" {verb}", home.join("bin/catalina.bat").display()), vec![])
    } else {
        ("sh".into(), vec![home.join("bin/catalina.sh").to_string_lossy().into_owned(), verb.into()])
    }
}

pub fn prepare(root: &Path, cache: &Path, config: &mut RunConfig) -> IdeResult<()> {
    let home = root
        .join(config.extras.params.get("tomcatHome").ok_or_else(|| invalid("Choose a Tomcat installation directory"))?)
        .canonicalize()?;
    validate_home(&home)?;
    let base = base_dir(cache, &config.id);
    fs::create_dir_all(&base)?;
    let base = base.canonicalize()?;
    let doc = deployment(root, &base, config, false)?;
    let context = effective_context(config, &doc);
    let context = context_name(&context)?;
    let port: u16 =
        config.extras.params.get("httpPort").map(String::as_str).unwrap_or("8080").parse().map_err(invalid)?;
    if port == 0 {
        return Err(invalid("HTTP port must be between 1 and 65535"));
    }
    let shutdown = free_port()?;
    let secret = format!(
        "OPENIDEA_{}_{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(invalid)?.as_nanos()
    );
    // Refresh only the IDE-owned configuration, leaving logs and deployed artifacts available.
    if base.join("conf").exists() {
        fs::remove_dir_all(base.join("conf"))?;
    }
    copy_tree(&home.join("conf"), &base.join("conf"))?;
    let contexts = base.join("conf/Catalina/localhost");
    if contexts.exists() {
        fs::remove_dir_all(&contexts)?;
    }
    for dir in ["logs", "temp", "work", "webapps", "conf/Catalina/localhost"] {
        fs::create_dir_all(base.join(dir))?;
    }
    let server = patch_server_xml(&fs::read_to_string(home.join("conf/server.xml"))?, port, shutdown, &secret)?;
    fs::write(base.join("conf/server.xml"), server)?;
    let debug = config.extras.params.get("tomcatDebug").is_some_and(|v| v == "true");
    fs::write(contexts.join(format!("{context}.xml")), context_xml(&doc, !debug))?;
    config.env.insert("CATALINA_HOME".into(), home.to_string_lossy().into_owned());
    config.env.insert("CATALINA_BASE".into(), base.to_string_lossy().into_owned());
    if let Some(jre) = config.extras.params.get("jre").filter(|s| !s.trim().is_empty()) {
        let jre = root.join(jre).canonicalize()?;
        config.env.insert("JAVA_HOME".into(), jre.to_string_lossy().into_owned());
        config.env.insert("JRE_HOME".into(), jre.to_string_lossy().into_owned());
    } else if let Some(java) = config.env.get("JAVA_HOME").cloned() {
        config.env.insert("JRE_HOME".into(), java);
    }
    let vm = config.extras.params.get("vmOptions").cloned().unwrap_or_default();
    let jmx = free_port()?;
    let mut opts = config.env.get("CATALINA_OPTS").cloned().unwrap_or_default();
    opts.push_str(&format!(" {vm} -Dcom.sun.management.jmxremote.port={jmx} -Dcom.sun.management.jmxremote.rmi.port={jmx} -Dcom.sun.management.jmxremote.host=127.0.0.1 -Djava.rmi.server.hostname=127.0.0.1 -Dcom.sun.management.jmxremote.authenticate=false -Dcom.sun.management.jmxremote.ssl=false"));
    if debug {
        opts.push_str(" -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:0");
    }
    config.env.insert("CATALINA_OPTS".into(), opts);
    (config.command, config.args) = script_command(&home, cfg!(windows), "run");
    config.extras.stop_command = Some(if cfg!(windows) {
        script_command(&home, true, "stop").0
    } else {
        format!("sh '{}' stop", home.join("bin/catalina.sh").to_string_lossy().replace('\'', "'\\''"))
    });
    config.extras.emulate_terminal = false;
    Ok(())
}

pub fn update(root: &Path, cache: &Path, config: &RunConfig, mode: &str) -> IdeResult<()> {
    if !matches!(mode, "resources" | "classes" | "redeploy") {
        return Err(invalid("Unknown Tomcat update operation"));
    }
    let base = base_dir(cache, &config.id);
    let doc = deployment(root, &base, config, mode == "resources")?;
    let context = context_name(&effective_context(config, &doc))?;
    let file = base.join("conf/Catalina/localhost").join(format!("{context}.xml"));
    if !file.is_file() {
        return Err(invalid("Start this Tomcat configuration before updating it"));
    }
    if mode == "redeploy" {
        let content = fs::read(&file)?;
        fs::write(file, content)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn archive(path: &Path, entries: &[(&str, &str)]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
        for (name, text) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(text.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }
    fn config() -> RunConfig {
        RunConfig {
            id: "local:demo".into(),
            name: "Tomcat".into(),
            kind: "tomcat".into(),
            command: "catalina".into(),
            args: vec!["run".into()],
            cwd: None,
            env: Default::default(),
            detected: false,
            is_test: false,
            debug_adapter: Some("java-debug".into()),
            allow_parallel: false,
            extras: Default::default(),
        }
    }
    #[test]
    fn validates_home_and_reads_version() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(validate_home(tmp.path()).is_err());
        fs::create_dir_all(tmp.path().join("bin")).unwrap();
        fs::write(tmp.path().join("bin/catalina.bat"), "").unwrap();
        archive(
            &tmp.path().join("lib/catalina.jar"),
            &[("org/apache/catalina/util/ServerInfo.properties", "server.info=Apache Tomcat/10.1.61\n")],
        );
        assert_eq!(validate_home(tmp.path()).unwrap().version, "Apache Tomcat/10.1.61");
    }
    #[test]
    fn patches_ports_without_changing_comments_and_escapes_context() {
        let xml = "<Server port='8005' shutdown='SHUTDOWN'><!-- <Connector port=\"8080\"/> --><Service><Connector port='8080' protocol='HTTP/1.1'/><Connector port='8009' protocol='AJP/1.3'/><Engine name='Catalina'><Host name='localhost'/></Engine></Service></Server>";
        let patched = patch_server_xml(xml, 18080, 18005, "SECRET").unwrap();
        assert!(patched.contains("port=\"18080\""));
        assert!(patched.contains("port=\"18005\""));
        assert!(!patched.contains("port=\"8009\""));
        assert!(patched.contains("<!-- <Connector port=\"8080\"/> -->"));
        assert_eq!(context_name("/").unwrap(), "ROOT");
        assert_eq!(context_name("/a/b").unwrap(), "a#b");
        for path in ["../escape", "/../escape", "/x#y", "/a//b", "/a/"] {
            assert!(context_name(path).is_err());
        }
        assert!(context_xml(Path::new("/tmp/a & b/\"web\""), false).contains("a &amp; b/&quot;web&quot;"));
    }
    #[test]
    fn constructs_platform_commands_without_splitting_paths() {
        let home = if cfg!(windows) { Path::new("C:/some path/tomcat") } else { Path::new("/some path/tomcat") };
        assert_eq!(
            script_command(home, false, "run"),
            ("sh".into(), vec![home.join("bin/catalina.sh").to_string_lossy().into_owned(), "run".into()])
        );
        let (command, args) = script_command(home, true, "run");
        assert_eq!(command, format!("\"{}\" run", home.join("bin/catalina.bat").display()));
        assert!(args.is_empty());
    }
    #[test]
    fn resolves_manual_deployments_and_synchronizes_war_resources() {
        let tmp = tempfile::tempdir().unwrap();
        let war = tmp.path().join("web app.war");
        archive(&war, &[("index.html", "old"), ("WEB-INF/classes/App.class", "class1"), ("removed.txt", "delete")]);
        let base = tmp.path().join("cache");
        fs::create_dir_all(&base).unwrap();
        fs::write(base.join("artifact-path.txt"), war.to_string_lossy().as_bytes()).unwrap();
        let mut c = config();
        let dest = deployment(tmp.path(), &base, &c, false).unwrap();
        archive(&war, &[("index.html", "new"), ("WEB-INF/classes/App.class", "class2")]);
        deployment(tmp.path(), &base, &c, true).unwrap();
        assert_eq!(fs::read_to_string(dest.join("index.html")).unwrap(), "new");
        assert_eq!(fs::read_to_string(dest.join("WEB-INF/classes/App.class")).unwrap(), "class1");
        assert!(!dest.join("removed.txt").exists());
        deployment(tmp.path(), &base, &c, false).unwrap();
        assert_eq!(fs::read_to_string(dest.join("WEB-INF/classes/App.class")).unwrap(), "class2");
        c.extras.params.insert("deployment".into(), "war".into());
        c.extras.params.insert("deploymentPath".into(), "web app.war".into());
        assert_eq!(deployment(tmp.path(), &base, &c, false).unwrap(), war.canonicalize().unwrap());
        fs::create_dir_all(tmp.path().join("WebContent")).unwrap();
        c.extras.params.insert("deployment".into(), "directory".into());
        c.extras.params.insert("deploymentPath".into(), "WebContent".into());
        assert!(deployment(tmp.path(), &base, &c, false).unwrap().ends_with("WebContent"));
    }
    #[test]
    fn prepares_isolated_base_and_jdwp_only_for_run() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("Tomcat Home");
        fs::create_dir_all(home.join("bin")).unwrap();
        fs::create_dir_all(home.join("conf")).unwrap();
        fs::create_dir_all(tmp.path().join("WebRoot")).unwrap();
        fs::write(home.join("bin/catalina.sh"), "").unwrap();
        archive(
            &home.join("lib/catalina.jar"),
            &[("org/apache/catalina/util/ServerInfo.properties", "server.info=Apache Tomcat/10.1")],
        );
        let server = "<Server port='8005'><Service><Connector port='8080'/><Engine name='Catalina'><Host name='localhost'/></Engine></Service></Server>";
        fs::write(home.join("conf/server.xml"), server).unwrap();
        let mut c = config();
        for (k, v) in [
            ("tomcatHome", "Tomcat Home"),
            ("deployment", "directory"),
            ("deploymentPath", "WebRoot"),
            ("contextPath", "/app"),
            ("tomcatDebug", "true"),
            ("vmOptions", "-Xmx256m"),
        ] {
            c.extras.params.insert(k.into(), v.into());
        }
        c.env.insert("JAVA_HOME".into(), "/jdk with spaces".into());
        prepare(tmp.path(), &tmp.path().join("cache"), &mut c).unwrap();
        assert_eq!(fs::read_to_string(home.join("conf/server.xml")).unwrap(), server);
        let base = PathBuf::from(&c.env["CATALINA_BASE"]);
        assert!(base.join("conf/Catalina/localhost/app.xml").is_file());
        assert!(c.env["CATALINA_OPTS"].contains("suspend=n,address=127.0.0.1:0"));
        assert!(c.env["CATALINA_OPTS"].contains("-Xmx256m"));
        assert!(!c.env.get("JAVA_OPTS").is_some_and(|s| s.contains("jdwp")));
        assert_eq!(c.env["JRE_HOME"], "/jdk with spaces");
        let stop = c.extras.stop_command.unwrap();
        assert!(stop.contains("stop"));
        let script = if cfg!(windows) { "catalina.bat" } else { "catalina.sh" };
        assert!(stop.contains(script));
    }
}
