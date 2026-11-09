//! IPC types and parsers for the docker CLI's `--format '{{json .}}'` output
//! (one JSON object per line).

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

/// Whether docker can be used, and why not.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DockerAvailability {
    Ready {
        client_version: String,
        server_version: String,
        /// Active docker context (`default`, `orbstack`, `desktop-linux`…).
        context: Option<String>,
    },
    /// No `docker` executable was found.
    NotInstalled,
    /// The CLI is there but cannot reach a daemon (not started, wrong context…).
    DaemonDown { message: String, context: Option<String> },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    pub command: String,
    /// `running`, `exited`, `paused`, `created`, `restarting`, `removing`, `dead`.
    pub state: String,
    /// Human status, e.g. `Up 2 hours (healthy)`.
    pub status: String,
    pub ports: String,
    pub created_at: String,
    /// `com.docker.compose.project` label.
    pub compose_project: Option<String>,
    pub compose_service: Option<String>,
    /// `com.docker.compose.project.working_dir` label.
    pub compose_working_dir: Option<String>,
    /// `com.docker.compose.project.config_files` label (comma-separated in docker).
    pub compose_files: Vec<String>,
    /// Mounted volume names or host paths reported by `docker ps` (`Mounts`).
    #[serde(default)]
    pub mounts: Vec<String>,
    /// Connected network names reported by `docker ps` (`Networks`).
    #[serde(default)]
    pub networks: Vec<String>,
    /// User and tool labels assigned to the container.
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
}

impl DockerContainer {
    pub fn running(&self) -> bool {
        matches!(self.state.as_str(), "running" | "restarting" | "paused")
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerImage {
    pub id: String,
    /// `<none>` for dangling images.
    pub repository: String,
    pub tag: String,
    pub size: String,
    pub created_since: String,
}

impl DockerImage {
    /// `repo:tag`, or the id for untagged images.
    pub fn reference(&self) -> String {
        if self.repository == "<none>" || self.repository.is_empty() {
            short_id(&self.id).to_owned()
        } else if self.tag == "<none>" || self.tag.is_empty() {
            self.repository.clone()
        } else {
            format!("{}:{}", self.repository, self.tag)
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerVolume {
    pub name: String,
    pub driver: String,
    pub mountpoint: String,
    pub compose_project: Option<String>,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerNetwork {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub scope: String,
    pub compose_project: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub ipv6: bool,
    #[serde(default)]
    pub internal: bool,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
}

/// One layer in `docker image history --no-trunc --format '{{json .}}'`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerImageLayer {
    pub id: String,
    pub created_by: String,
    pub size: String,
    pub created_since: String,
    pub created_at: String,
    pub comment: String,
}

/// Process table returned by `docker top <container>`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerProcessList {
    pub titles: Vec<String>,
    pub processes: Vec<Vec<String>>,
}

/// Live resource metrics returned by `docker stats --no-stream --no-trunc --format '{{json .}}'`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainerStats {
    pub cpu_perc: String,
    pub mem_usage: String,
    pub mem_perc: String,
    pub net_io: String,
    pub block_io: String,
    pub pids: String,
}

/// Everything the Services tree shows, fetched in one go.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerSnapshot {
    pub availability: DockerAvailability,
    /// The docker executable in use, e.g. for `docker exec -it` in a terminal.
    pub executable: Option<String>,
    pub containers: Vec<DockerContainer>,
    pub images: Vec<DockerImage>,
    pub volumes: Vec<DockerVolume>,
    pub networks: Vec<DockerNetwork>,
    /// Lists that failed although the daemon answered (shown, not fatal).
    pub errors: Vec<String>,
    /// Global CLI options selecting the connection's daemon (for `docker exec` in a terminal).
    #[serde(default)]
    pub global_args: Vec<String>,
}

/// One relevant `docker events` entry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerEvent {
    /// `container`, `image`, `volume`, `network`.
    pub object: String,
    pub action: String,
    pub id: String,
    pub name: Option<String>,
}

/// A line of `docker logs` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerLogLine {
    pub stderr: bool,
    pub text: String,
}

/// The first 12 hex digits of an id (`sha256:` prefix dropped), as docker prints them.
pub fn short_id(id: &str) -> &str {
    let id = id.strip_prefix("sha256:").unwrap_or(id);
    &id[..id.len().min(12)]
}

/// Parses docker's `Labels` column (`a=b,c=d`). Values may themselves contain
/// commas (compose's `config_files`), so a segment without `=` continues the
/// previous value.
pub fn parse_labels(raw: &str) -> BTreeMap<String, String> {
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    let mut last: Option<String> = None;
    for seg in raw.split(',') {
        match seg.split_once('=') {
            Some((k, v)) if !k.is_empty() && !k.contains(['/', ' ']) => {
                out.insert(k.to_owned(), v.to_owned());
                last = Some(k.to_owned());
            }
            _ => {
                if let Some(v) = last.as_ref().and_then(|k| out.get_mut(k)) {
                    v.push(',');
                    v.push_str(seg);
                }
            }
        }
    }
    out
}

const COMPOSE_PROJECT: &str = "com.docker.compose.project";
const COMPOSE_SERVICE: &str = "com.docker.compose.service";
const COMPOSE_DIR: &str = "com.docker.compose.project.working_dir";
const COMPOSE_FILES: &str = "com.docker.compose.project.config_files";

fn lines<T: for<'de> Deserialize<'de>>(text: &str) -> impl Iterator<Item = T> + '_ {
    text.lines().filter(|l| l.trim_start().starts_with('{')).filter_map(|l| match serde_json::from_str::<T>(l) {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::debug!("skipping unparsable docker line: {e}");
            None
        }
    })
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct RawContainer {
    #[serde(rename = "ID")]
    id: String,
    names: String,
    image: String,
    command: String,
    state: String,
    status: String,
    ports: String,
    created_at: String,
    labels: String,
    mounts: String,
    networks: String,
}

fn split_csv(raw: &str) -> Vec<String> {
    raw.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).collect()
}

/// `docker ps -a --no-trunc --format '{{json .}}'`.
pub fn parse_containers(text: &str) -> Vec<DockerContainer> {
    let mut out: Vec<DockerContainer> = lines::<RawContainer>(text)
        .map(|r| {
            let all_labels = parse_labels(&r.labels);
            let files = all_labels.get(COMPOSE_FILES).map(|f| split_csv(f)).unwrap_or_default();
            // Older docker versions derive `State` from nothing: fall back on the status text.
            let state = if r.state.is_empty() {
                if r.status.starts_with("Up") { "running".into() } else { "exited".into() }
            } else {
                r.state.to_ascii_lowercase()
            };
            DockerContainer {
                name: r.names.split(',').next().unwrap_or_default().trim_start_matches('/').to_owned(),
                id: r.id,
                image: r.image,
                command: r.command.trim_matches('"').to_owned(),
                state,
                status: r.status,
                ports: r.ports,
                created_at: r.created_at,
                compose_project: all_labels.get(COMPOSE_PROJECT).filter(|s| !s.is_empty()).cloned(),
                compose_service: all_labels.get(COMPOSE_SERVICE).filter(|s| !s.is_empty()).cloned(),
                compose_working_dir: all_labels.get(COMPOSE_DIR).filter(|s| !s.is_empty()).cloned(),
                compose_files: files,
                mounts: split_csv(&r.mounts),
                networks: split_csv(&r.networks),
                labels: all_labels,
            }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct RawImage {
    #[serde(rename = "ID")]
    id: String,
    repository: String,
    tag: String,
    size: String,
    created_since: String,
}

/// `docker image ls --no-trunc --format '{{json .}}'`.
pub fn parse_images(text: &str) -> Vec<DockerImage> {
    let mut out: Vec<DockerImage> = lines::<RawImage>(text)
        .map(|r| DockerImage {
            id: r.id,
            repository: r.repository,
            tag: r.tag,
            size: r.size,
            created_since: r.created_since,
        })
        .collect();
    // Tagged images by name, dangling ones last.
    out.sort_by(|a, b| {
        (a.repository == "<none>", &a.repository, &a.tag).cmp(&(b.repository == "<none>", &b.repository, &b.tag))
    });
    out
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct RawVolume {
    name: String,
    driver: String,
    mountpoint: String,
    scope: String,
    labels: String,
}

/// `docker volume ls --format '{{json .}}'`.
pub fn parse_volumes(text: &str) -> Vec<DockerVolume> {
    let mut out: Vec<DockerVolume> = lines::<RawVolume>(text)
        .map(|r| {
            let labels = parse_labels(&r.labels);
            DockerVolume {
                compose_project: labels.get(COMPOSE_PROJECT).filter(|s| !s.is_empty()).cloned(),
                name: r.name,
                driver: r.driver,
                mountpoint: r.mountpoint,
                scope: r.scope,
                labels,
            }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct RawNetwork {
    #[serde(rename = "ID")]
    id: String,
    name: String,
    driver: String,
    scope: String,
    created_at: String,
    #[serde(rename = "IPv6")]
    ipv6: String,
    internal: String,
    labels: String,
}

/// `docker network ls --no-trunc --format '{{json .}}'`.
pub fn parse_networks(text: &str) -> Vec<DockerNetwork> {
    let mut out: Vec<DockerNetwork> = lines::<RawNetwork>(text)
        .map(|r| {
            let labels = parse_labels(&r.labels);
            DockerNetwork {
                compose_project: labels.get(COMPOSE_PROJECT).filter(|s| !s.is_empty()).cloned(),
                id: r.id,
                name: r.name,
                driver: r.driver,
                scope: r.scope,
                created_at: r.created_at,
                ipv6: r.ipv6.eq_ignore_ascii_case("true"),
                internal: r.internal.eq_ignore_ascii_case("true"),
                labels,
            }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct RawImageLayer {
    #[serde(rename = "ID")]
    id: String,
    created_by: String,
    size: String,
    created_since: String,
    created_at: String,
    comment: String,
}

/// `docker image history --no-trunc --format '{{json .}}'`.
pub fn parse_image_history(text: &str) -> Vec<DockerImageLayer> {
    lines::<RawImageLayer>(text)
        .map(|r| DockerImageLayer {
            id: r.id,
            created_by: r.created_by,
            size: r.size,
            created_since: r.created_since,
            created_at: r.created_at,
            comment: r.comment,
        })
        .collect()
}

/// `docker top <container>` tabular output.
pub fn parse_container_top(text: &str) -> DockerProcessList {
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let Some(header) = lines.next() else {
        return DockerProcessList::default();
    };
    let titles: Vec<String> = header.split_whitespace().map(str::to_owned).collect();
    if titles.is_empty() {
        return DockerProcessList::default();
    }
    let cols = titles.len();
    let processes = lines
        .map(|line| {
            let mut row = Vec::with_capacity(cols);
            let mut rest = line.trim_start();
            for _ in 0..cols.saturating_sub(1) {
                match rest.split_once(char::is_whitespace) {
                    Some((field, tail)) => {
                        row.push(field.to_owned());
                        rest = tail.trim_start();
                    }
                    None => break,
                }
            }
            if !rest.is_empty() || row.len() < cols {
                row.push(rest.to_owned());
            }
            row
        })
        .collect();
    DockerProcessList { titles, processes }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct RawStats {
    #[serde(rename = "CPUPerc")]
    cpu_perc: String,
    mem_usage: String,
    mem_perc: String,
    #[serde(rename = "NetIO")]
    net_io: String,
    #[serde(rename = "BlockIO")]
    block_io: String,
    #[serde(rename = "PIDs")]
    pids: String,
}

/// `docker stats --no-stream --no-trunc --format '{{json .}}'`.
pub fn parse_container_stats(text: &str) -> Option<DockerContainerStats> {
    lines::<RawStats>(text).next().map(|r| DockerContainerStats {
        cpu_perc: r.cpu_perc,
        mem_usage: r.mem_usage,
        mem_perc: r.mem_perc,
        net_io: r.net_io,
        block_io: r.block_io,
        pids: r.pids,
    })
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawVersion {
    #[serde(rename = "Client")]
    client: Option<RawVersionPart>,
    #[serde(rename = "Server")]
    server: Option<RawVersionPart>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct RawVersionPart {
    version: String,
    context: Option<String>,
}

/// Availability from `docker version --format '{{json .}}'` (stdout, stderr, exit status).
/// Without a daemon docker still prints the client half (with `"Server": null`)
/// and explains the problem on stderr.
pub fn parse_version(stdout: &str, stderr: &str, success: bool) -> DockerAvailability {
    let parsed: RawVersion = stdout
        .lines()
        .find(|l| l.trim_start().starts_with('{'))
        .and_then(|l| serde_json::from_str(l).ok())
        .unwrap_or_default();
    let context = parsed.client.as_ref().and_then(|c| c.context.clone()).filter(|c| !c.is_empty());
    match (&parsed.server, success) {
        (Some(server), true) if !server.version.is_empty() => DockerAvailability::Ready {
            client_version: parsed.client.map(|c| c.version).unwrap_or_default(),
            server_version: server.version.clone(),
            context,
        },
        _ => {
            let message = stderr
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .unwrap_or("Cannot connect to the Docker daemon")
                .to_owned();
            DockerAvailability::DaemonDown { message, context }
        }
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawEvent {
    #[serde(rename = "Type")]
    kind: String,
    #[serde(rename = "Action")]
    action: String,
    #[serde(rename = "Actor")]
    actor: RawActor,
    /// Old-style field (`docker events` before API 1.22 had only these).
    id: String,
    status: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct RawActor {
    #[serde(rename = "ID")]
    id: String,
    attributes: BTreeMap<String, String>,
}

/// One `docker events --format '{{json .}}'` line, or `None` for events that do
/// not change what the Services view shows (exec sessions, attach, resize…).
pub fn parse_event(line: &str) -> Option<DockerEvent> {
    let raw: RawEvent = serde_json::from_str(line.trim()).ok()?;
    let action = if raw.action.is_empty() { raw.status } else { raw.action };
    let object = if raw.kind.is_empty() { "container".to_owned() } else { raw.kind };
    if !matches!(object.as_str(), "container" | "image" | "volume" | "network") {
        return None;
    }
    let verb = action.split(':').next().unwrap_or_default().trim();
    let noisy = verb.starts_with("exec_")
        || matches!(
            verb,
            "attach" | "detach" | "resize" | "top" | "commit" | "copy" | "archive-path" | "extract-to-dir" | "export"
        );
    if noisy || verb.is_empty() {
        return None;
    }
    let id = if raw.actor.id.is_empty() { raw.id } else { raw.actor.id };
    Some(DockerEvent { name: raw.actor.attributes.get("name").cloned(), object, action: verb.to_owned(), id })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_keep_commas_inside_values() {
        let l = parse_labels(
            "com.docker.compose.project=demo,com.docker.compose.project.config_files=/a/x.yml,/a/y.yml,k=v",
        );
        assert_eq!(l["com.docker.compose.project"], "demo");
        assert_eq!(l["com.docker.compose.project.config_files"], "/a/x.yml,/a/y.yml");
        assert_eq!(l["k"], "v");
        assert!(parse_labels("").is_empty());
    }

    #[test]
    fn short_ids() {
        assert_eq!(short_id("sha256:0123456789abcdef"), "0123456789ab");
        assert_eq!(short_id("abc"), "abc");
    }

    #[test]
    fn image_reference() {
        let img = |repo: &str, tag: &str| DockerImage {
            id: "sha256:feedfacecafe0000".into(),
            repository: repo.into(),
            tag: tag.into(),
            size: String::new(),
            created_since: String::new(),
        };
        assert_eq!(img("postgres", "16").reference(), "postgres:16");
        assert_eq!(img("<none>", "<none>").reference(), "feedfacecafe");
        assert_eq!(img("local/app", "<none>").reference(), "local/app");
    }

    #[test]
    fn version_without_daemon() {
        let out = r#"{"Client":{"Version":"24.0.2","Context":"orbstack"},"Server":null}"#;
        let err = "Cannot connect to the Docker daemon at unix:///x.sock. Is the docker daemon running?\n";
        assert_eq!(
            parse_version(out, err, false),
            DockerAvailability::DaemonDown {
                message: "Cannot connect to the Docker daemon at unix:///x.sock. Is the docker daemon running?".into(),
                context: Some("orbstack".into())
            }
        );
        let ok = r#"{"Client":{"Version":"27.1.1","Context":"default"},"Server":{"Version":"27.1.1"}}"#;
        assert!(
            matches!(parse_version(ok, "", true), DockerAvailability::Ready { ref server_version, .. } if server_version == "27.1.1")
        );
    }

    #[test]
    fn events_skip_exec_noise() {
        let start = r#"{"status":"start","id":"c1","from":"nginx","Type":"container","Action":"start","Actor":{"ID":"c1","Attributes":{"name":"web"}},"scope":"local","time":1}"#;
        assert_eq!(
            parse_event(start),
            Some(DockerEvent {
                object: "container".into(),
                action: "start".into(),
                id: "c1".into(),
                name: Some("web".into())
            })
        );
        let exec = r#"{"Type":"container","Action":"exec_start: sh","Actor":{"ID":"c1","Attributes":{}}}"#;
        assert_eq!(parse_event(exec), None);
        let health = r#"{"Type":"container","Action":"health_status: healthy","Actor":{"ID":"c1","Attributes":{}}}"#;
        assert_eq!(parse_event(health).map(|e| e.action), Some("health_status".into()));
        let daemon = r#"{"Type":"daemon","Action":"reload","Actor":{"ID":"d","Attributes":{}}}"#;
        assert_eq!(parse_event(daemon), None);
        assert_eq!(parse_event("not json"), None);
    }
}
