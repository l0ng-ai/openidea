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
    #[serde(default)]
    pub libraries: Vec<String>,
    #[serde(default)]
    pub tomee: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub http_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub https_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub ajp_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub shutdown_port: Option<u16>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TomcatInstallation {
    pub path: String,
    pub version: String,
    #[serde(default)]
    pub libraries: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub base: Option<String>,
    #[serde(default)]
    pub tomee: bool,
}

pub fn is_tomee(home: &Path) -> bool {
    let Ok(entries) = fs::read_dir(home.join("lib")) else { return false };
    entries.flatten().any(|e| {
        e.path().file_name().and_then(|n| n.to_str()).is_some_and(|n| {
            let lower = n.to_ascii_lowercase();
            lower.ends_with(".jar") && (lower.starts_with("tomee-") || lower.starts_with("openejb-core-"))
        })
    })
}

pub fn read_server_xml_ports(xml: &str) -> (Option<u16>, Option<u16>, Option<u16>, Option<u16>) {
    let mut reader = Reader::from_str(xml);
    let mut http = None;
    let mut https = None;
    let mut ajp = None;
    let mut shutdown = None;
    while let Ok(event) = reader.read_event() {
        match event {
            Event::Eof => break,
            Event::Start(ref tag) | Event::Empty(ref tag) => {
                let name = tag.name().as_ref().to_owned();
                let attrs: Vec<(String, String)> = tag
                    .attributes()
                    .filter_map(|a| {
                        let a = a.ok()?;
                        let v = a.normalized_value(quick_xml::XmlVersion::Implicit1_0).ok()?.into_owned();
                        Some((a.key.as_ref().to_owned(), v))
                    })
                    .collect();
                let attr_val =
                    |k: &str| attrs.iter().find(|(key, _)| key.eq_ignore_ascii_case(k)).map(|(_, v)| v.as_str());
                let port = attr_val("port").and_then(|p| p.parse::<u16>().ok()).filter(|&p| p > 0);
                if name == "Server" && shutdown.is_none() {
                    shutdown = port;
                } else if name == "Connector" {
                    let protocol = attr_val("protocol").unwrap_or_default();
                    let ssl = attr_val("SSLEnabled").is_some_and(|v| v.eq_ignore_ascii_case("true"))
                        || attr_val("scheme").is_some_and(|v| v.eq_ignore_ascii_case("https"))
                        || attr_val("secure").is_some_and(|v| v.eq_ignore_ascii_case("true"));
                    let is_ajp = protocol.to_ascii_uppercase().contains("AJP");
                    if ssl && https.is_none() {
                        https = port;
                    } else if is_ajp && ajp.is_none() {
                        ajp = port;
                    } else if http.is_none()
                        && (protocol.is_empty() || protocol.contains("HTTP") || protocol.contains("Http"))
                    {
                        http = port;
                    }
                }
            }
            _ => {}
        }
    }
    (http, https, ajp, shutdown)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdeaTomcatServer {
    pub name: String,
    pub home: PathBuf,
    pub base: Option<PathBuf>,
    pub libraries: Vec<String>,
}

pub fn parse_idea_app_servers(xml: &str, user_home: &Path) -> Vec<IdeaTomcatServer> {
    let home_str = user_home.to_string_lossy();
    let expand = |raw: &str| -> String { raw.replace("$USER_HOME$", &home_str) };
    let mut reader = Reader::from_str(xml);
    let mut servers: Vec<IdeaTomcatServer> = Vec::new();
    let mut lib_map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    let mut cur_server_name: Option<String> = None;
    let mut cur_integration: Option<String> = None;
    let mut cur_home: Option<String> = None;
    let mut cur_base: Option<String> = None;
    let mut cur_lib_name: Option<String> = None;
    let mut in_classes = false;

    while let Ok(event) = reader.read_event() {
        match event {
            Event::Eof => break,
            Event::Start(ref tag) | Event::Empty(ref tag) => {
                let tag_name = tag.name().as_ref().to_owned();
                let attr = |key: &str| -> Option<String> {
                    tag.attributes().flatten().find(|a| a.key.as_ref().eq_ignore_ascii_case(key)).and_then(|a| {
                        a.normalized_value(quick_xml::XmlVersion::Implicit1_0).ok().map(|v| v.into_owned())
                    })
                };
                match tag_name.as_str() {
                    "ServerDK" => {
                        cur_server_name = attr("NAME");
                        cur_integration = None;
                        cur_home = None;
                        cur_base = None;
                    }
                    "option" if cur_server_name.is_some() => {
                        if let (Some(n), Some(v)) = (attr("name"), attr("value")) {
                            match n.as_str() {
                                "SOURCE_INTEGRATION_NAME" | "INTEGRATION_ID" => cur_integration = Some(v),
                                "CATALINA_HOME" if !v.trim().is_empty() => cur_home = Some(expand(v.trim())),
                                "CATALINA_BASE" if !v.trim().is_empty() => cur_base = Some(expand(v.trim())),
                                _ => {}
                            }
                        }
                    }
                    "library" => {
                        cur_lib_name = attr("name");
                    }
                    "CLASSES" if cur_lib_name.is_some() => {
                        in_classes = true;
                    }
                    "root" if in_classes && cur_lib_name.is_some() => {
                        if let Some(url) = attr("url") {
                            let cleaned =
                                url.strip_prefix("jar://").or_else(|| url.strip_prefix("file://")).unwrap_or(&url);
                            let cleaned = cleaned.strip_suffix("!/").unwrap_or(cleaned);
                            let expanded = expand(cleaned);
                            if !expanded.is_empty()
                                && let Some(ref lib_name) = cur_lib_name
                            {
                                lib_map.entry(lib_name.clone()).or_default().push(expanded);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Event::End(ref tag) => match tag.name().as_ref() {
                "ServerDK" => {
                    let is_tomcat =
                        cur_integration.as_deref().is_none_or(|i| i.contains("Tomcat") || i.contains("TomEE"));
                    if is_tomcat && let (Some(name), Some(home)) = (cur_server_name.take(), cur_home.take()) {
                        servers.push(IdeaTomcatServer {
                            name,
                            home: PathBuf::from(home),
                            base: cur_base.take().map(PathBuf::from),
                            libraries: Vec::new(),
                        });
                    }
                    cur_server_name = None;
                    cur_integration = None;
                    cur_home = None;
                    cur_base = None;
                }
                "CLASSES" => {
                    in_classes = false;
                }
                "library" => {
                    cur_lib_name = None;
                    in_classes = false;
                }
                _ => {}
            },
            _ => {}
        }
    }
    for srv in &mut servers {
        if let Some(libs) = lib_map.remove(&srv.name) {
            srv.libraries = libs;
        }
    }
    servers
}

pub fn discover_tomcat_libraries(home: &Path) -> Vec<String> {
    let lib_dir = home.join("lib");
    let mut out = Vec::new();
    for preferred in ["jsp-api.jar", "servlet-api.jar"] {
        let p = lib_dir.join(preferred);
        if p.is_file() {
            out.push(p.to_string_lossy().into_owned());
        }
    }
    if let Ok(entries) = fs::read_dir(&lib_dir) {
        let mut extras: Vec<String> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.is_file()
                    && p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.ends_with("-api.jar") && !matches!(n, "jsp-api.jar" | "servlet-api.jar"))
            })
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        extras.sort();
        out.extend(extras);
    }
    out
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
    let libraries = discover_tomcat_libraries(home);
    let tomee = is_tomee(home);
    let (http_port, https_port, ajp_port, shutdown_port) = fs::read_to_string(home.join("conf/server.xml"))
        .ok()
        .map(|xml| read_server_xml_ports(&xml))
        .unwrap_or((None, None, None, None));
    Ok(TomcatHome { version, libraries, tomee, http_port, https_port, ajp_port, shutdown_port })
}

pub fn detect_installations() -> Vec<TomcatInstallation> {
    let mut seen = std::collections::HashSet::new();
    let mut found = Vec::new();
    let user_home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);

    if let Some(ref home) = user_home {
        let mut jetbrains_roots =
            vec![home.join("Library/Application Support/JetBrains"), home.join(".config/JetBrains")];
        if let Some(appdata) = std::env::var_os("APPDATA") {
            jetbrains_roots.push(PathBuf::from(appdata).join("JetBrains"));
        }
        for jb_root in jetbrains_roots {
            let Ok(entries) = fs::read_dir(&jb_root) else { continue };
            let mut idea_dirs: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("IntelliJIdea") || n.starts_with("IdeaIC"))
                })
                .collect();
            idea_dirs.sort_by(|a, b| b.cmp(a));
            for dir in idea_dirs {
                let xml_path = dir.join("options/javaeeAppServers.xml");
                let Ok(xml) = fs::read_to_string(&xml_path) else { continue };
                for srv in parse_idea_app_servers(&xml, home) {
                    let Ok(canon) = dunce::canonicalize(&srv.home) else { continue };
                    if !seen.insert(canon.clone()) {
                        continue;
                    }
                    if let Ok(info) = validate_home(&canon) {
                        let base = srv
                            .base
                            .and_then(|b| dunce::canonicalize(b).ok())
                            .filter(|b| b != &canon)
                            .map(|b| b.to_string_lossy().into_owned());
                        let libraries = if srv.libraries.is_empty() { info.libraries } else { srv.libraries };
                        found.push(TomcatInstallation {
                            path: canon.to_string_lossy().into_owned(),
                            version: info.version,
                            libraries,
                            name: Some(srv.name).filter(|s| !s.trim().is_empty()),
                            base,
                            tomee: info.tomee,
                        });
                    }
                }
            }
        }
    }

    let mut candidates = Vec::new();
    for var in ["CATALINA_HOME", "TOMCAT_HOME"] {
        if let Some(val) = std::env::var_os(var).filter(|v| !v.is_empty()) {
            candidates.push(PathBuf::from(val));
        }
    }
    for brew_opt in ["/opt/homebrew/opt", "/usr/local/opt"] {
        let opt = Path::new(brew_opt);
        if let Ok(entries) = fs::read_dir(opt) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                if name.to_string_lossy().starts_with("tomcat") {
                    candidates.push(entry.path().join("libexec"));
                    candidates.push(entry.path());
                }
            }
        }
    }
    let mut roots = vec![
        PathBuf::from("/Library"),
        PathBuf::from("/opt"),
        PathBuf::from("/usr/share"),
        PathBuf::from("/usr/local"),
        PathBuf::from("C:/Program Files/Apache Software Foundation"),
        PathBuf::from("C:/"),
    ];
    if let Some(ref home) = user_home {
        roots.push(home.join("Documents/tomcat"));
        roots.push(home.join("Documents"));
        roots.push(home.join("Downloads"));
        roots.push(home.join("Library"));
        roots.push(home.clone());
    }
    for root in roots {
        let Ok(entries) = fs::read_dir(&root) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if name.starts_with("tomcat") || name.starts_with("apache-tomcat") || name.starts_with("apache-tomee") {
                candidates.push(entry.path());
                candidates.push(entry.path().join("libexec"));
            }
        }
    }
    for candidate in candidates {
        let Ok(canon) = dunce::canonicalize(&candidate) else { continue };
        if !seen.insert(canon.clone()) {
            continue;
        }
        if let Ok(info) = validate_home(&canon) {
            found.push(TomcatInstallation {
                path: canon.to_string_lossy().into_owned(),
                version: info.version,
                libraries: info.libraries,
                name: None,
                base: None,
                tomee: info.tomee,
            });
        }
    }
    found
}

pub fn base_dir(cache: &Path, id: &str) -> PathBuf {
    // Stable and collision-free for configuration IDs, including Windows path characters.
    let key: String = id.as_bytes().iter().map(|b| format!("{b:02x}")).collect();
    cache.join("tomcat").join(key)
}

pub fn effective_base_dir(root: &Path, cache: &Path, config: &RunConfig) -> PathBuf {
    if let Some(custom) = config.extras.params.get("tomcatBase").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let candidate = root.join(custom);
        let same_as_home =
            config.extras.params.get("tomcatHome").map(|s| s.trim()).filter(|s| !s.is_empty()).is_some_and(|h| {
                let home = root.join(h);
                home == candidate
                    || (dunce::canonicalize(&home).ok().zip(dunce::canonicalize(&candidate).ok()))
                        .is_some_and(|(a, b)| a == b)
            });
        if !same_as_home {
            return candidate;
        }
    }
    base_dir(cache, &config.id)
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

/// The web app's own `META-INF/context.xml`, from an exploded directory or a WAR.
fn app_context_xml(doc_base: &Path) -> Option<String> {
    if doc_base.is_dir() {
        return fs::read_to_string(doc_base.join("META-INF/context.xml")).ok();
    }
    let mut zip = zip::ZipArchive::new(fs::File::open(doc_base).ok()?).ok()?;
    let mut text = String::new();
    zip.by_name("META-INF/context.xml").ok()?.read_to_string(&mut text).ok()?;
    Some(text)
}

/// The context descriptor for `conf/Catalina/localhost`. Tomcat ignores the app's
/// `META-INF/context.xml` once a descriptor exists there, so its content (`<Resource>`,
/// `<Environment>`, `<Valve>`…) is carried over, with `docBase` and `reloadable` set by the IDE.
pub fn deployed_context_xml(doc_base: &Path, reload: bool) -> String {
    let Some(app) = app_context_xml(doc_base) else { return context_xml(doc_base, reload) };
    merge_context_xml(&app, doc_base, reload).unwrap_or_else(|e| {
        tracing::warn!("ignoring the web app's META-INF/context.xml: {e}");
        context_xml(doc_base, reload)
    })
}

pub fn deployed_context_xml_with_descriptor(
    doc_base: &Path,
    custom_descriptor: Option<&Path>,
    reload: bool,
) -> IdeResult<String> {
    let Some(custom) = custom_descriptor else {
        return Ok(deployed_context_xml(doc_base, reload));
    };
    let text = fs::read_to_string(custom)
        .map_err(|e| invalid(format!("Cannot read context descriptor {}: {e}", custom.display())))?;
    merge_context_xml(&text, doc_base, reload)
        .map_err(|e| invalid(format!("Invalid context descriptor {}: {e}", custom.display())))
}

fn merge_context_xml(app: &str, doc_base: &Path, reload: bool) -> IdeResult<String> {
    let mut reader = Reader::from_str(app);
    let mut writer = Writer::new(Vec::new());
    let mut root = false;
    loop {
        let event = reader.read_event().map_err(invalid)?;
        let event = match event {
            Event::Eof => break,
            Event::Start(ref tag) | Event::Empty(ref tag) if !root => {
                if tag.name().as_ref() != "Context" {
                    return Err(invalid("the root element is not <Context>"));
                }
                root = true;
                let mut new = BytesStart::new("Context");
                for a in tag.attributes() {
                    let a = a.map_err(invalid)?;
                    if !matches!(a.key.as_ref(), "docBase" | "reloadable" | "path") {
                        new.push_attribute(a);
                    }
                }
                new.push_attribute(("docBase", doc_base.to_string_lossy().as_ref()));
                new.push_attribute(("reloadable", if reload { "true" } else { "false" }));
                if matches!(event, Event::Empty(_)) { Event::Empty(new) } else { Event::Start(new) }
            }
            e => e,
        };
        writer.write_event(event).map_err(invalid)?;
    }
    if !root {
        return Err(invalid("no <Context> element"));
    }
    String::from_utf8(writer.into_inner()).map_err(invalid)
}

#[derive(Clone, Copy, Debug, Default)]
pub struct TomcatPorts {
    pub http: u16,
    pub https: Option<u16>,
    pub ajp: Option<u16>,
    pub shutdown: u16,
}

pub fn patch_server_xml(xml: &str, http: u16, shutdown: u16, secret: &str) -> IdeResult<String> {
    patch_server_xml_with_ports(xml, TomcatPorts { http, https: None, ajp: None, shutdown }, secret)
}

pub fn patch_server_xml_with_ports(xml: &str, ports: TomcatPorts, secret: &str) -> IdeResult<String> {
    let mut reader = Reader::from_str(xml);
    let mut writer = Writer::new(Vec::new());
    let mut http_found = false;
    let mut https_found = false;
    let mut ajp_found = false;
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
                let (protocol, ssl, ajp) = {
                    let attr_val =
                        |k: &str| attrs.iter().find(|(key, _)| key.eq_ignore_ascii_case(k)).map(|(_, v)| v.as_str());
                    let protocol = attr_val("protocol").unwrap_or_default().to_owned();
                    let ssl = attr_val("SSLEnabled").is_some_and(|v| v.eq_ignore_ascii_case("true"))
                        || attr_val("scheme").is_some_and(|v| v.eq_ignore_ascii_case("https"))
                        || attr_val("secure").is_some_and(|v| v.eq_ignore_ascii_case("true"));
                    let ajp = protocol.to_ascii_uppercase().contains("AJP");
                    (protocol, ssl, ajp)
                };
                let mut set = |key: &str, value: String| {
                    attrs.retain(|(k, _)| k != key);
                    attrs.push((key.into(), value));
                };
                match name.as_str() {
                    "Server" => {
                        set("port", ports.shutdown.to_string());
                        set("address", "127.0.0.1".into());
                        set("shutdown", secret.into());
                    }
                    "Connector" => {
                        if ssl && !https_found {
                            let p = ports.https.map_or_else(free_port, Ok)?;
                            set("port", p.to_string());
                            https_found = true;
                        } else if ajp && !ajp_found {
                            let p = ports.ajp.map_or_else(free_port, Ok)?;
                            set("port", p.to_string());
                            ajp_found = true;
                        } else if !http_found
                            && (protocol.is_empty() || protocol.contains("HTTP") || protocol.contains("Http"))
                        {
                            set("port", ports.http.to_string());
                            http_found = true;
                            if let Some(https_port) = ports.https {
                                set("redirectPort", https_port.to_string());
                            }
                        } else {
                            set("port", free_port()?.to_string());
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

/// Updates the exploded artifact deployment from the module's own class output directories and
/// its web resources ([`web_sources`]), file by file and only what changed, instead of
/// rebuilding and re-exploding the WAR. `module` and `class_paths` are absolute.
/// `Ok(false)`: not possible this way (not deployed from the artifact yet, the module's output
/// isn't on the classpath, or a module it depends on was compiled since the last update, whose
/// archive in `WEB-INF/lib` would be stale) — rebuild the WAR instead.
pub fn sync_outputs(base: &Path, module: &Path, class_paths: &[PathBuf], resources_only: bool) -> IdeResult<bool> {
    let dest = base.join("deployment");
    let manifest = base.join("synced-files.json");
    let since = [base.join("artifact-path.txt"), manifest.clone()]
        .iter()
        .filter_map(|p| fs::metadata(p).and_then(|m| m.modified()).ok())
        .max();
    let Some(since) = since else { return Ok(false) };
    if !dest.join("WEB-INF").is_dir() {
        return Ok(false);
    }
    let (own, others): (Vec<&PathBuf>, Vec<&PathBuf>) =
        class_paths.iter().filter(|p| p.is_dir()).partition(|p| p.starts_with(module));
    if own.is_empty() || others.iter().any(|d| modified_since(d, since)) {
        return Ok(false);
    }
    let previous: Vec<String> =
        fs::read(&manifest).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let mut current = std::collections::BTreeSet::new();
    let classes = dest.join("WEB-INF/classes");
    for dir in own {
        sync_tree(dir, dir, &classes, Path::new("WEB-INF/classes"), resources_only, &mut current)?;
    }
    for (dir, target) in web_sources(module) {
        if dir.is_dir() {
            sync_tree(&dir, &dir, &dest.join(&target), &target, resources_only, &mut current)?;
        }
    }
    for rel in previous.iter().filter(|p| !current.contains(*p)) {
        let path = dest.join(rel);
        if path.is_file() {
            fs::remove_file(path)?;
        }
    }
    fs::write(manifest, serde_json::to_vec(&current).map_err(invalid)?)?;
    Ok(true)
}

/// The folders whose files the WAR puts at its root (or under the second path): the web app
/// folder (`src/main/webapp`, maven-war-plugin's `warSourceDirectory`, Gradle's
/// `webAppDirName` / `webAppDirectory`), then maven-war-plugin's `webResources`.
pub fn web_sources(module: &Path) -> Vec<(PathBuf, PathBuf)> {
    let rel = |dir: &str| {
        let dir = ["${project.basedir}/", "${basedir}/"].iter().find_map(|p| dir.strip_prefix(p)).unwrap_or(dir);
        module.join(dir.trim())
    };
    if let Ok(pom) = fs::read_to_string(module.join("pom.xml"))
        && let Some(war) = war_plugin(&pom)
    {
        let mut out = vec![(rel(tag(war, "warSourceDirectory").unwrap_or("src/main/webapp")), PathBuf::new())];
        let mut rest = tag_block(war, "webResources").unwrap_or_default();
        while let Some(start) = rest.find("<resource>") {
            let end = rest[start..].find("</resource>").map_or(rest.len(), |e| start + e);
            let resource = &rest[start..end];
            if let Some(dir) = tag(resource, "directory") {
                out.push((rel(dir), PathBuf::from(tag(resource, "targetPath").unwrap_or_default())));
            }
            rest = &rest[end..];
        }
        return out;
    }
    let gradle = ["build.gradle", "build.gradle.kts"].iter().find_map(|f| fs::read_to_string(module.join(f)).ok());
    let web_app_dir = gradle.as_deref().and_then(|text| {
        text.lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .find(|l| l.contains("webAppDirName") || l.contains("webAppDirectory"))
            .and_then(|l| l.split(['"', '\'']).nth(1).map(str::to_owned))
    });
    vec![(rel(web_app_dir.as_deref().unwrap_or("src/main/webapp")), PathBuf::new())]
}

/// The `<plugin>` element of maven-war-plugin in `pom`, if it is configured there.
fn war_plugin(pom: &str) -> Option<&str> {
    let at = pom.find("<artifactId>maven-war-plugin</artifactId>")?;
    let start = pom[..at].rfind("<plugin>")?;
    let end = pom[at..].find("</plugin>").map_or(pom.len(), |e| at + e);
    Some(&pom[start..end])
}

/// The text of the first `<name>` element in `xml`.
fn tag<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    tag_block(xml, name).map(str::trim).filter(|t| !t.is_empty())
}

fn tag_block<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let start = xml.find(&open)? + open.len();
    let end = start + xml[start..].find(&format!("</{name}>"))?;
    Some(&xml[start..end])
}

fn modified_since(dir: &Path, since: std::time::SystemTime) -> bool {
    let Ok(entries) = fs::read_dir(dir) else { return false };
    entries.flatten().any(|e| match e.file_type() {
        Ok(t) if t.is_dir() => modified_since(&e.path(), since),
        Ok(t) if t.is_file() => e.metadata().and_then(|m| m.modified()).is_ok_and(|m| m > since),
        _ => false,
    })
}

/// Copies changed files of `from` (below `root`) to `to`; unchanged files keep their timestamps,
/// so Tomcat only reloads when a class really changed. Records each source file as `prefix/rel`.
fn sync_tree(
    root: &Path,
    from: &Path,
    to: &Path,
    prefix: &Path,
    resources_only: bool,
    seen: &mut std::collections::BTreeSet<String>,
) -> IdeResult<()> {
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let path = entry.path();
        let kind = entry.file_type()?;
        if kind.is_dir() {
            sync_tree(root, &path, to, prefix, resources_only, seen)?;
            continue;
        }
        if !kind.is_file() {
            continue;
        }
        let rel = path.strip_prefix(root).map_err(invalid)?;
        seen.insert(prefix.join(rel).to_string_lossy().replace('\\', "/"));
        if resources_only && rel.extension().is_some_and(|e| e == "class") {
            continue;
        }
        let target = to.join(rel);
        let bytes = fs::read(&path)?;
        if fs::read(&target).ok().as_deref() != Some(&bytes) {
            fs::create_dir_all(target.parent().unwrap_or(to))?;
            fs::write(target, bytes)?;
        }
    }
    Ok(())
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
                return Err(invalid(format!("The built WAR artifact does not exist: {}", war.display())));
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
            let path = root.join(value);
            let path = dunce::canonicalize(&path)
                .map_err(|e| invalid(format!("Invalid Tomcat deployment: {} ({e})", path.display())))?;
            if (kind == "war" && (!path.is_file() || !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("war"))))
                || (kind == "directory" && !path.is_dir())
            {
                return Err(invalid(format!("Invalid Tomcat deployment: {}", path.display())));
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

fn parse_optional_port(
    params: &std::collections::BTreeMap<String, String>,
    key: &str,
    label: &str,
) -> IdeResult<Option<u16>> {
    let Some(raw) = params.get(key).map(|s| s.trim()).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let port: u16 = raw.parse().map_err(|_| invalid(format!("{label} must be between 1 and 65535")))?;
    if port == 0 {
        return Err(invalid(format!("{label} must be between 1 and 65535")));
    }
    Ok(Some(port))
}

pub fn patch_catalina_properties(props: &str, extra_jars: &[String]) -> String {
    if extra_jars.is_empty() {
        return props.to_owned();
    }
    let suffix: String = extra_jars.iter().map(|j| format!(",\"{}\"", j.replace('\\', "/"))).collect();
    let mut patched = false;
    let mut lines: Vec<String> = props
        .lines()
        .map(|l| {
            if l.trim_start().starts_with("common.loader=") && !l.ends_with('\\') {
                patched = true;
                format!("{l}{suffix}")
            } else {
                l.to_owned()
            }
        })
        .collect();
    if !patched {
        lines.push(format!("common.loader=\"${{catalina.base}}/lib\",\"${{catalina.base}}/lib/*.jar\",\"${{catalina.home}}/lib\",\"${{catalina.home}}/lib/*.jar\"{suffix}"));
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogConfigItem {
    pattern: String,
    active: bool,
    skip_content: bool,
}

fn truncate_skipped_logs(base: &Path, raw_logs: Option<&str>) {
    let logs_dir = base.join("logs");
    let Ok(entries) = fs::read_dir(&logs_dir) else { return };
    let prefixes: Vec<String> = match raw_logs.and_then(|s| serde_json::from_str::<Vec<LogConfigItem>>(s).ok()) {
        Some(items) => items
            .into_iter()
            .filter(|i| i.active && i.skip_content)
            .filter_map(|i| {
                let file_part = i.pattern.rsplit('/').next().unwrap_or(&i.pattern);
                file_part.split('*').next().map(|p| p.trim().to_owned()).filter(|p| !p.is_empty())
            })
            .collect(),
        None => vec!["localhost.".into(), "catalina.".into()],
    };
    if prefixes.is_empty() {
        return;
    }
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file()
            && let Some(name) = path.file_name().and_then(|n| n.to_str())
            && prefixes.iter().any(|pref| name.starts_with(pref))
        {
            let _ = fs::write(&path, b"");
        }
    }
}

pub fn prepare(root: &Path, cache: &Path, config: &mut RunConfig) -> IdeResult<()> {
    // Batch scripts and their environment variables require ordinary Windows paths.
    let home = dunce::canonicalize(root.join(
        config.extras.params.get("tomcatHome").ok_or_else(|| invalid("Choose a Tomcat installation directory"))?,
    ))?;
    validate_home(&home)?;
    let base = effective_base_dir(root, cache, config);
    fs::create_dir_all(&base)?;
    let base = dunce::canonicalize(&base)?;
    let doc = deployment(root, &base, config, false)?;
    let context = effective_context(config, &doc);
    let context = context_name(&context)?;
    let port: u16 =
        config.extras.params.get("httpPort").map(String::as_str).unwrap_or("8080").parse().map_err(invalid)?;
    if port == 0 {
        return Err(invalid("HTTP port must be between 1 and 65535"));
    }
    let https = parse_optional_port(&config.extras.params, "httpsPort", "HTTPS port")?;
    let ajp = parse_optional_port(&config.extras.params, "ajpPort", "AJP port")?;
    let shutdown =
        parse_optional_port(&config.extras.params, "shutdownPort", "Shutdown port")?.map_or_else(free_port, Ok)?;
    let jmx = parse_optional_port(&config.extras.params, "jmxPort", "JMX port")?.map_or_else(free_port, Ok)?;
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
    if config.extras.params.get("deployTomcatApps").is_some_and(|v| v == "true") && home.join("webapps").is_dir() {
        copy_tree(&home.join("webapps"), &base.join("webapps"))?;
    }
    let server = patch_server_xml_with_ports(
        &fs::read_to_string(home.join("conf/server.xml"))?,
        TomcatPorts { http: port, https, ajp, shutdown },
        &secret,
    )?;
    fs::write(base.join("conf/server.xml"), server)?;
    let debug = config.extras.params.get("tomcatDebug").is_some_and(|v| v == "true");
    let custom_descriptor =
        config.extras.params.get("contextDescriptor").map(|s| s.trim()).filter(|s| !s.is_empty()).map(|s| root.join(s));
    let context_xml_content = deployed_context_xml_with_descriptor(&doc, custom_descriptor.as_deref(), !debug)?;
    fs::write(contexts.join(format!("{context}.xml")), context_xml_content)?;
    config.env.insert("CATALINA_HOME".into(), home.to_string_lossy().into_owned());
    config.env.insert("CATALINA_BASE".into(), base.to_string_lossy().into_owned());
    if let Some(jre) = config.extras.params.get("jre").filter(|s| !s.trim().is_empty()) {
        let jre = dunce::canonicalize(root.join(jre))?;
        config.env.insert("JAVA_HOME".into(), jre.to_string_lossy().into_owned());
        config.env.insert("JRE_HOME".into(), jre.to_string_lossy().into_owned());
    } else if let Some(java) = config.env.get("JAVA_HOME").cloned() {
        config.env.insert("JRE_HOME".into(), java);
    }
    let vm = config.extras.params.get("vmOptions").cloned().unwrap_or_default();
    let mut opts = config.env.get("CATALINA_OPTS").cloned().unwrap_or_default();
    opts.push_str(&format!(" {vm} -Dcom.sun.management.jmxremote.port={jmx} -Dcom.sun.management.jmxremote.rmi.port={jmx} -Dcom.sun.management.jmxremote.host=127.0.0.1 -Djava.rmi.server.hostname=127.0.0.1 -Dcom.sun.management.jmxremote.authenticate=false -Dcom.sun.management.jmxremote.ssl=false"));
    if config.extras.params.get("preserveSessions") != Some(&"true".into()) {
        opts.push_str(" -Dorg.apache.catalina.session.StandardManager.PATHNAME=");
    }
    if debug {
        let jdwp_port = parse_optional_port(&config.extras.params, "debugPort", "Debug port")?.unwrap_or(0);
        opts.push_str(&format!(" -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:{jdwp_port}"));
    }
    config.env.insert("CATALINA_OPTS".into(), opts);
    truncate_skipped_logs(&base, config.extras.params.get("tomcatLogs").map(String::as_str));
    if let Some(libs) = config.extras.params.get("tomcatLibraries").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let lib_items: Vec<String> =
            libs.split([';', ':']).map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect();
        let joined = lib_items.join(sep);
        if !joined.is_empty() {
            config.env.insert("CLASSPATH".into(), joined);
        }
        let home_lib = home.join("lib");
        let extra_jars: Vec<String> = lib_items.into_iter().filter(|j| !Path::new(j).starts_with(&home_lib)).collect();
        let cat_props_path = base.join("conf/catalina.properties");
        if !extra_jars.is_empty()
            && let Ok(props) = fs::read_to_string(&cat_props_path)
        {
            fs::write(&cat_props_path, patch_catalina_properties(&props, &extra_jars))?;
        }
    }
    if config.extras.params.get("passEnvVars").map(String::as_str) != Some("false") {
        let env_key = if debug { "startupEnvDebug" } else { "startupEnvRun" };
        if let Some(raw_env) = config.extras.params.get(env_key).or_else(|| config.extras.params.get("startupEnv")) {
            for pair in raw_env.split('\n').map(str::trim).filter(|s| !s.is_empty()) {
                if let Some((k, v)) = pair.split_once('=') {
                    let k = k.trim();
                    if !k.is_empty() && !v.is_empty() {
                        config.env.insert(k.to_owned(), v.to_owned());
                    }
                }
            }
        }
    }
    let use_custom_start = config.extras.params.get("useDefaultStartup").map(String::as_str) != Some("true");
    if use_custom_start
        && let Some(custom_start) =
            config.extras.params.get("startupScript").map(|s| s.trim()).filter(|s| !s.is_empty())
    {
        let script = root.join(custom_start);
        if cfg!(windows) {
            config.command = format!("\"{}\"", script.display());
            config.args = vec![];
        } else {
            config.command = "sh".into();
            config.args = vec![script.to_string_lossy().into_owned()];
        }
    } else {
        (config.command, config.args) = script_command(&home, cfg!(windows), "run");
    }
    let use_custom_stop = config.extras.params.get("useDefaultShutdown").map(String::as_str) != Some("true");
    config.extras.stop_command = Some(
        if use_custom_stop
            && let Some(custom_stop) =
                config.extras.params.get("shutdownScript").map(|s| s.trim()).filter(|s| !s.is_empty())
        {
            let script = root.join(custom_stop);
            if cfg!(windows) {
                format!("\"{}\"", script.display())
            } else {
                format!("sh '{}'", script.to_string_lossy().replace('\'', "'\\''"))
            }
        } else if cfg!(windows) {
            script_command(&home, true, "stop").0
        } else {
            format!("sh '{}' stop", home.join("bin/catalina.sh").to_string_lossy().replace('\'', "'\\''"))
        },
    );
    config.extras.emulate_terminal = false;
    Ok(())
}

pub fn update(root: &Path, cache: &Path, config: &RunConfig, mode: &str) -> IdeResult<()> {
    if !matches!(mode, "resources" | "classes" | "redeploy") {
        return Err(invalid("Unknown Tomcat update operation"));
    }
    let base = effective_base_dir(root, cache, config);
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
    #[test]
    fn keeps_the_apps_own_context_descriptor() {
        let tmp = tempfile::tempdir().unwrap();
        let app = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Context path=\"/old\" docBase=\"old\" reloadable=\"false\" antiResourceLocking=\"true\">\n  <!-- JNDI -->\n  <Resource name=\"jdbc/x\" auth=\"Container\" type=\"javax.sql.DataSource\" url=\"jdbc:h2:mem:a;b=&amp;c\"/>\n  <Environment name=\"mode\" value=\"dev\" type=\"java.lang.String\"/>\n</Context>\n";
        let dir = tmp.path().join("web app");
        fs::create_dir_all(dir.join("META-INF")).unwrap();
        fs::write(dir.join("META-INF/context.xml"), app).unwrap();
        let war = tmp.path().join("app.war");
        archive(&war, &[("META-INF/context.xml", app), ("index.jsp", "")]);
        for doc in [&dir, &war] {
            let xml = deployed_context_xml(doc, true);
            let doc_base = escape(&doc.to_string_lossy());
            assert!(
                xml.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Context antiResourceLocking=\"true\""),
                "{xml}"
            );
            assert!(xml.contains(&format!("docBase=\"{doc_base}\" reloadable=\"true\">")), "{xml}");
            assert!(!xml.contains("/old") && !xml.contains("\"old\"") && !xml.contains("\"false\""), "{xml}");
            assert!(xml.contains("<!-- JNDI -->"));
            assert!(xml.contains("<Resource name=\"jdbc/x\" auth=\"Container\" type=\"javax.sql.DataSource\" url=\"jdbc:h2:mem:a;b=&amp;c\"/>"));
            assert!(xml.contains("<Environment name=\"mode\""));
            assert!(xml.trim_end().ends_with("</Context>"));
        }

        fs::write(dir.join("META-INF/context.xml"), "<Context/>").unwrap();
        let doc_base = escape(&dir.to_string_lossy());
        assert_eq!(
            deployed_context_xml(&dir, false),
            format!("<Context docBase=\"{doc_base}\" reloadable=\"false\"/>")
        );
        // Unreadable or not a context: the IDE's own descriptor, as before.
        for broken in ["<Context><Resource></Context>", "<Server/>", ""] {
            fs::write(dir.join("META-INF/context.xml"), broken).unwrap();
            assert_eq!(deployed_context_xml(&dir, false), context_xml(&dir, false), "{broken}");
        }
        let plain = tmp.path().join("plain");
        fs::create_dir_all(&plain).unwrap();
        assert_eq!(deployed_context_xml(&plain, true), context_xml(&plain, true));
        let bare = tmp.path().join("bare.war");
        archive(&bare, &[("index.jsp", "")]);
        assert_eq!(deployed_context_xml(&bare, true), context_xml(&bare, true));
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
        assert_eq!(deployment(tmp.path(), &base, &c, false).unwrap(), dunce::canonicalize(&war).unwrap());
        fs::create_dir_all(tmp.path().join("WebContent")).unwrap();
        c.extras.params.insert("deployment".into(), "directory".into());
        c.extras.params.insert("deploymentPath".into(), "WebContent".into());
        assert!(deployment(tmp.path(), &base, &c, false).unwrap().ends_with("WebContent"));
    }
    #[test]
    fn updates_the_exploded_deployment_from_module_outputs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (base, module) = (root.join("base"), root.join("web"));
        let (dest, out, dep) =
            (base.join("deployment"), module.join("target/classes"), root.join("core/target/classes"));
        let webapp = module.join("src/main/webapp");
        for dir in [dest.join("WEB-INF/classes/a"), out.join("a"), webapp.clone(), dep.clone()] {
            fs::create_dir_all(dir).unwrap();
        }
        for (path, text) in [
            (dest.join("WEB-INF/classes/a/Same.class"), "same"),
            (dest.join("WEB-INF/classes/a/App.class"), "old"),
            (dest.join("index.jsp"), "old"),
            (out.join("a/Same.class"), "same"),
            (out.join("a/App.class"), "new"),
            (out.join("app.properties"), "new"),
            (webapp.join("index.jsp"), "new"),
        ] {
            fs::write(path, text).unwrap();
        }
        let paths = [out.clone(), dep.clone(), root.join("lib.jar")];
        // Not deployed from the artifact yet.
        assert!(!sync_outputs(&base, &module, &paths, false).unwrap());
        fs::write(base.join("artifact-path.txt"), "web.war").unwrap();
        let same = || fs::metadata(dest.join("WEB-INF/classes/a/Same.class")).unwrap().modified().unwrap();
        let before = same();

        assert!(sync_outputs(&base, &module, &paths, true).unwrap());
        assert_eq!(fs::read_to_string(dest.join("WEB-INF/classes/a/App.class")).unwrap(), "old");
        assert_eq!(fs::read_to_string(dest.join("WEB-INF/classes/app.properties")).unwrap(), "new");
        assert_eq!(fs::read_to_string(dest.join("index.jsp")).unwrap(), "new");

        assert!(sync_outputs(&base, &module, &paths, false).unwrap());
        assert_eq!(fs::read_to_string(dest.join("WEB-INF/classes/a/App.class")).unwrap(), "new");
        assert_eq!(same(), before);

        fs::remove_file(out.join("app.properties")).unwrap();
        assert!(sync_outputs(&base, &module, &paths, false).unwrap());
        assert!(!dest.join("WEB-INF/classes/app.properties").exists());
        assert!(dest.join("WEB-INF/classes/a/Same.class").exists());

        // A dependency module compiled since: its archive in WEB-INF/lib is stale.
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(60);
        fs::File::create(dep.join("Core.class")).unwrap().set_modified(later).unwrap();
        assert!(!sync_outputs(&base, &module, &paths, false).unwrap());
    }
    #[test]
    fn web_sources_follow_the_war_plugin_and_gradle_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let module = tmp.path();
        let rel = |sources: Vec<(PathBuf, PathBuf)>| -> Vec<(String, String)> {
            sources
                .into_iter()
                .map(|(d, t)| {
                    let d = d.strip_prefix(module).unwrap().to_string_lossy().replace('\\', "/");
                    (d, t.to_string_lossy().into_owned())
                })
                .collect()
        };
        assert_eq!(rel(web_sources(module)), [("src/main/webapp".to_owned(), String::new())]);

        // An Eclipse-style layout: the JSPs come in through webResources.
        fs::write(
            module.join("pom.xml"),
            r#"<project><build><plugins>
              <plugin><artifactId>maven-compiler-plugin</artifactId></plugin>
              <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-war-plugin</artifactId>
                <configuration>
                  <warSourceDirectory>${basedir}/web</warSourceDirectory>
                  <webResources>
                    <resource><directory>WebContent</directory><includes><include>**/*</include></includes></resource>
                    <resource><directory>extra</directory><targetPath>static</targetPath></resource>
                  </webResources>
                </configuration>
              </plugin>
            </plugins></build></project>"#,
        )
        .unwrap();
        assert_eq!(
            rel(web_sources(module)),
            [
                ("web".to_owned(), String::new()),
                ("WebContent".to_owned(), String::new()),
                ("extra".to_owned(), "static".to_owned())
            ]
        );

        fs::remove_file(module.join("pom.xml")).unwrap();
        fs::write(
            module.join("build.gradle"),
            "plugins { id 'war' }\n// webAppDirName = 'old'\nwebAppDirName = 'WebContent'\n",
        )
        .unwrap();
        assert_eq!(rel(web_sources(module)), [("WebContent".to_owned(), String::new())]);
    }

    #[test]
    fn updates_web_resources_outside_src_main_webapp() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (base, module) = (root.join("base"), root.join("web"));
        let (dest, out) = (base.join("deployment"), module.join("target/classes"));
        for dir in [dest.join("WEB-INF/classes"), out.clone(), module.join("WebContent/jsp")] {
            fs::create_dir_all(dir).unwrap();
        }
        fs::write(
            module.join("pom.xml"),
            "<project><plugin><artifactId>maven-war-plugin</artifactId><configuration><webResources>\
             <resource><directory>WebContent</directory></resource></webResources></configuration></plugin></project>",
        )
        .unwrap();
        fs::write(dest.join("index.jsp"), "old").unwrap();
        fs::write(module.join("WebContent/jsp/list.jsp"), "new").unwrap();
        fs::write(base.join("artifact-path.txt"), "web.war").unwrap();

        assert!(sync_outputs(&base, &module, std::slice::from_ref(&out), true).unwrap());
        assert_eq!(fs::read_to_string(dest.join("jsp/list.jsp")).unwrap(), "new");
        // Files the WAR brought that no source here maps to stay.
        assert_eq!(fs::read_to_string(dest.join("index.jsp")).unwrap(), "old");
    }

    #[test]
    fn deployment_errors_identify_the_checked_path() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().join("cache");
        fs::create_dir_all(&base).unwrap();
        for path in ["missing.war", r"C:\工作\timesheet\target\timesheet.war", r"\\server\share\timesheet.war"] {
            fs::write(base.join("artifact-path.txt"), format!("{path}\r\n")).unwrap();
            let error = deployment(tmp.path(), &base, &config(), false).unwrap_err().to_string();
            assert!(error.contains(path), "{error}");
        }
        for kind in ["war", "directory"] {
            let mut c = config();
            c.extras.params.insert("deployment".into(), kind.into());
            c.extras.params.insert("deploymentPath".into(), "missing".into());
            let error = deployment(tmp.path(), &base, &c, false).unwrap_err().to_string();
            assert!(error.contains(&tmp.path().join("missing").display().to_string()), "{error}");
            c.extras.params.insert("deploymentPath".into(), "cache".into());
            if kind == "war" {
                assert!(deployment(tmp.path(), &base, &c, false).unwrap_err().to_string().contains("cache"));
            }
        }
    }
    #[test]
    fn prepares_isolated_base_and_jdwp_only_for_run() {
        let tmp = tempfile::tempdir().unwrap();
        check_prepared_paths(tmp.path());
    }
    #[cfg(windows)]
    #[test]
    fn prepares_plain_windows_paths_from_verbatim_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = PathBuf::from(format!(r"\\?\{}", dunce::canonicalize(tmp.path()).unwrap().display()));
        check_prepared_paths(&root);
    }
    fn check_prepared_paths(root: &Path) {
        let home = root.join("Tomcat Home");
        fs::create_dir_all(home.join("bin")).unwrap();
        fs::create_dir_all(home.join("conf")).unwrap();
        fs::create_dir_all(root.join("WebRoot")).unwrap();
        fs::write(home.join("bin/catalina.sh"), "").unwrap();
        fs::write(home.join("bin/catalina.bat"), "").unwrap();
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
        let cache = root.join("cache");
        prepare(root, &cache, &mut c).unwrap();
        assert_eq!(fs::read_to_string(home.join("conf/server.xml")).unwrap(), server);
        let base = PathBuf::from(&c.env["CATALINA_BASE"]);
        let context = base.join("conf/Catalina/localhost/app.xml");
        let doc = dunce::canonicalize(root.join("WebRoot")).unwrap();
        assert_eq!(fs::read_to_string(&context).unwrap(), context_xml(&doc, false));
        assert_eq!(c.env["CATALINA_HOME"], dunce::canonicalize(&home).unwrap().to_string_lossy());
        assert_eq!(base, dunce::canonicalize(base_dir(&cache, &c.id)).unwrap());
        assert!(c.env["CATALINA_OPTS"].contains("suspend=n,address=127.0.0.1:0"));
        assert!(c.env["CATALINA_OPTS"].contains("-Xmx256m"));
        assert!(!c.env.get("JAVA_OPTS").is_some_and(|s| s.contains("jdwp")));
        assert_eq!(c.env["JRE_HOME"], "/jdk with spaces");
        let stop = c.extras.stop_command.as_ref().unwrap();
        assert!(stop.contains("stop"));
        let script = if cfg!(windows) { "catalina.bat" } else { "catalina.sh" };
        assert!(stop.contains(script));

        fs::create_dir_all(root.join("JDK Home")).unwrap();
        c.extras.params.insert("jre".into(), "JDK Home".into());
        prepare(root, &cache, &mut c).unwrap();
        let jre = dunce::canonicalize(root.join("JDK Home")).unwrap();
        for key in ["JAVA_HOME", "JRE_HOME"] {
            assert_eq!(c.env[key], jre.to_string_lossy());
        }
        assert!(!c.command.contains(r"\\?\"));
        assert!(c.args.iter().all(|arg| !arg.contains(r"\\?\")));
        assert!(!c.extras.stop_command.as_ref().unwrap().contains(r"\\?\"));
        assert!(c.env.values().all(|value| !value.contains(r"\\?\")));
        assert!(!fs::read_to_string(context).unwrap().contains(r"\\?\"));
    }

    #[test]
    fn supports_idea_custom_base_ports_context_descriptor_and_instance_webapps() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let home = root.join("Tomcat Home");
        fs::create_dir_all(home.join("bin")).unwrap();
        fs::create_dir_all(home.join("conf")).unwrap();
        fs::create_dir_all(home.join("webapps/manager")).unwrap();
        fs::write(home.join("webapps/manager/index.html"), "manager").unwrap();
        fs::create_dir_all(root.join("WebRoot")).unwrap();
        fs::write(home.join("bin/catalina.sh"), "").unwrap();
        fs::write(home.join("bin/catalina.bat"), "").unwrap();
        archive(
            &home.join("lib/catalina.jar"),
            &[("org/apache/catalina/util/ServerInfo.properties", "server.info=Apache Tomcat/10.1")],
        );
        fs::write(home.join("lib/jsp-api.jar"), "").unwrap();
        fs::write(home.join("lib/servlet-api.jar"), "").unwrap();
        let validated = validate_home(&home).unwrap();
        assert_eq!(validated.libraries.len(), 2);
        assert!(validated.libraries[0].ends_with("jsp-api.jar"));
        assert!(validated.libraries[1].ends_with("servlet-api.jar"));
        let server = "<Server port='8005'><Service><Connector port='8080' protocol='HTTP/1.1'/><Connector port='8443' protocol='HTTP/1.1' SSLEnabled='true'/><Connector port='8009' protocol='AJP/1.3'/><Engine name='Catalina'><Host name='localhost'/></Engine></Service></Server>";
        fs::write(home.join("conf/server.xml"), server).unwrap();
        fs::write(
            root.join("custom-context.xml"),
            "<Context privileged=\"true\"><Parameter name=\"env\" value=\"dev\"/></Context>",
        )
        .unwrap();

        let mut c = config();
        for (k, v) in [
            ("tomcatHome", "Tomcat Home"),
            ("tomcatBase", "custom-base"),
            ("deployment", "directory"),
            ("deploymentPath", "WebRoot"),
            ("contextPath", "/app"),
            ("contextDescriptor", "custom-context.xml"),
            ("httpPort", "18080"),
            ("httpsPort", "18443"),
            ("ajpPort", "18009"),
            ("shutdownPort", "18005"),
            ("jmxPort", "11099"),
            ("deployTomcatApps", "true"),
            ("preserveSessions", "false"),
        ] {
            c.extras.params.insert(k.into(), v.into());
        }
        let cache = root.join("cache");
        prepare(root, &cache, &mut c).unwrap();

        let base = PathBuf::from(&c.env["CATALINA_BASE"]);
        assert_eq!(base, dunce::canonicalize(root.join("custom-base")).unwrap());
        let patched_server = fs::read_to_string(base.join("conf/server.xml")).unwrap();
        assert!(patched_server.contains("port=\"18005\""));
        assert!(patched_server.contains("port=\"18080\""));
        assert!(patched_server.contains("redirectPort=\"18443\""));
        assert!(patched_server.contains("port=\"18443\""));
        assert!(patched_server.contains("port=\"18009\""));
        assert!(base.join("webapps/manager/index.html").is_file());
        let ctx_xml = fs::read_to_string(base.join("conf/Catalina/localhost/app.xml")).unwrap();
        assert!(ctx_xml.contains("privileged=\"true\""));
        assert!(ctx_xml.contains("<Parameter name=\"env\" value=\"dev\"/>"));
        assert!(c.env["CATALINA_OPTS"].contains("-Dcom.sun.management.jmxremote.port=11099"));
        assert!(c.env["CATALINA_OPTS"].contains("-Dorg.apache.catalina.session.StandardManager.PATHNAME="));
    }

    #[test]
    fn imports_idea_app_servers_detects_tomee_reads_server_xml_ports_and_patches_catalina_properties() {
        let idea_xml = r#"<application>
  <component name="AppserversManager">
    <ServerDK NAME="Tomcat 9.0.78">
      <option name="SOURCE_INTEGRATION_NAME" value="Tomcat Server" />
      <DATA>
        <option name="CATALINA_HOME" value="$USER_HOME$/Documents/tomcat/apache-tomcat-9.0.82" />
        <option name="CATALINA_BASE" value="" />
      </DATA>
    </ServerDK>
    <ServerDK NAME="Tomcat10">
      <option name="SOURCE_INTEGRATION_NAME" value="Tomcat Server" />
      <DATA>
        <option name="CATALINA_HOME" value="$USER_HOME$/Documents/tomcat/apache-tomcat-10.1.57" />
        <option name="CATALINA_BASE" value="$USER_HOME$/Documents/tomcat/base-10" />
      </DATA>
    </ServerDK>
    <LibraryTable>
      <library name="Tomcat10">
        <CLASSES>
          <root url="jar://$USER_HOME$/Documents/tomcat/apache-tomcat-10.1.57/lib/jsp-api.jar!/" />
          <root url="jar://$USER_HOME$/Documents/tomcat/apache-tomcat-10.1.57/lib/servlet-api.jar!/" />
        </CLASSES>
      </library>
    </LibraryTable>
  </component>
</application>"#;
        let parsed = parse_idea_app_servers(idea_xml, Path::new("/Users/demo"));
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].name, "Tomcat 9.0.78");
        assert_eq!(parsed[0].home, PathBuf::from("/Users/demo/Documents/tomcat/apache-tomcat-9.0.82"));
        assert_eq!(parsed[0].base, None);
        assert_eq!(parsed[1].name, "Tomcat10");
        assert_eq!(parsed[1].home, PathBuf::from("/Users/demo/Documents/tomcat/apache-tomcat-10.1.57"));
        assert_eq!(parsed[1].base, Some(PathBuf::from("/Users/demo/Documents/tomcat/base-10")));
        assert_eq!(
            parsed[1].libraries,
            vec![
                "/Users/demo/Documents/tomcat/apache-tomcat-10.1.57/lib/jsp-api.jar",
                "/Users/demo/Documents/tomcat/apache-tomcat-10.1.57/lib/servlet-api.jar",
            ]
        );

        let server_xml = "<Server port='8005'><Service><Connector port='8080' protocol='HTTP/1.1'/><Connector port='8443' SSLEnabled='true'/><Connector port='8009' protocol='AJP/1.3'/></Service></Server>";
        assert_eq!(read_server_xml_ports(server_xml), (Some(8080), Some(8443), Some(8009), Some(8005)));

        let patched_props = patch_catalina_properties(
            "package.access=sun.\ncommon.loader=\"${catalina.base}/lib\",\"${catalina.home}/lib/*.jar\"\n",
            &["/opt/extra/driver.jar".into()],
        );
        assert!(patched_props.contains(
            "common.loader=\"${catalina.base}/lib\",\"${catalina.home}/lib/*.jar\",\"/opt/extra/driver.jar\""
        ));

        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("tomee");
        fs::create_dir_all(home.join("bin")).unwrap();
        fs::create_dir_all(home.join("conf")).unwrap();
        fs::write(home.join("bin/catalina.sh"), "").unwrap();
        archive(
            &home.join("lib/catalina.jar"),
            &[("org/apache/catalina/util/ServerInfo.properties", "server.info=Apache Tomcat (TomEE)/9.0.82\n")],
        );
        fs::write(home.join("lib/tomee-catalina-9.1.2.jar"), "").unwrap();
        fs::write(home.join("conf/server.xml"), server_xml).unwrap();
        let info = validate_home(&home).unwrap();
        assert!(info.tomee);
        assert_eq!(info.http_port, Some(8080));
        assert_eq!(info.https_port, Some(8443));
        assert_eq!(info.ajp_port, Some(8009));
        assert_eq!(info.shutdown_port, Some(8005));
    }
}
