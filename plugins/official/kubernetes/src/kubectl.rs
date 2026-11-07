//! Wrapper around `kubectl`, `helm`, and `kustomize` CLI execution,
//! cluster state parsing, and interactive terminal session launching.

use openidea_plugin::host::{self, storage};
use openidea_plugin::{Error, Invocation, ProcessOutput, Project};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// Active Kubernetes connection configuration.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct KubeConfigState {
    pub kubeconfig: String,
    pub context: String,
    pub namespace: String,
    pub all_namespaces: bool,
    pub tail_lines: u32,
    pub shell: String,
    pub port_forward_local_port: u32,
}

impl KubeConfigState {
    pub fn load() -> Self {
        let kubeconfig = host::setting_string("kubeconfig").unwrap_or_default();
        let context = storage::get("context")
            .ok()
            .flatten()
            .filter(|s| !s.is_empty())
            .or_else(|| host::setting_string("context").filter(|s| !s.is_empty()))
            .unwrap_or_default();
        let namespace = storage::get("namespace")
            .ok()
            .flatten()
            .filter(|s| !s.is_empty())
            .or_else(|| host::setting_string("namespace").filter(|s| !s.is_empty()))
            .unwrap_or_else(|| "default".into());
        let all_namespaces = storage::get("allNamespaces")
            .ok()
            .flatten()
            .map(|v| v == "true")
            .unwrap_or_else(|| host::setting_bool("allNamespaces").unwrap_or(false));
        let tail_lines = host::setting_number("tailLines").map(|n| (n as u32).clamp(10, 10_000)).unwrap_or(200);
        let shell = host::setting_string("shell").filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
        let port_forward_local_port =
            host::setting_number("portForwardLocalPort").map(|n| n.max(0.0) as u32).unwrap_or(0);

        Self { kubeconfig, context, namespace, all_namespaces, tail_lines, shell, port_forward_local_port }
    }

    pub fn base_args(&self, include_namespace: bool) -> Vec<String> {
        let mut args = Vec::new();
        if !self.kubeconfig.trim().is_empty() {
            args.push(format!("--kubeconfig={}", self.kubeconfig.trim()));
        }
        if !self.context.trim().is_empty() {
            args.push(format!("--context={}", self.context.trim()));
        }
        if include_namespace && !self.all_namespaces && !self.namespace.trim().is_empty() {
            args.push("-n".into());
            args.push(self.namespace.trim().to_owned());
        }
        args
    }

    pub fn push_scope_flags(&self, args: &mut Vec<String>) {
        if self.all_namespaces {
            args.push("--all-namespaces".into());
        }
    }

    pub fn target_args(&self, namespace_override: Option<&str>) -> Vec<String> {
        let mut args = Vec::new();
        if !self.kubeconfig.trim().is_empty() {
            args.push(format!("--kubeconfig={}", self.kubeconfig.trim()));
        }
        if !self.context.trim().is_empty() {
            args.push(format!("--context={}", self.context.trim()));
        }
        let ns = namespace_override.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| self.namespace.trim());
        if !ns.is_empty() {
            args.push("-n".into());
            args.push(ns.to_owned());
        }
        args
    }
}

/// Summary of one cluster context from kubeconfig (`~/.kube/config`), enriched with Freelens store metadata when present.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClusterContextInfo {
    pub name: String,
    pub cluster: String,
    pub server: String,
    pub user: String,
    pub namespace: String,
    pub source: String,
    pub short_name: String,
    pub version: String,
    pub distro: String,
    pub nodes: Option<u32>,
    pub last_seen: String,
    pub hotbar_pinned: bool,
    pub hotbar_order: Option<u32>,
}

/// State of one container or initContainer in a Pod (rendered as colored status squares in Freelens).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContainerStateBadge {
    pub name: String,
    /// `"running"` | `"terminated"` | `"waiting"`
    pub state: String,
    pub ready: bool,
    pub reason: String,
    pub is_init: bool,
}

/// Summary of one Kubernetes resource returned by `kubectl get`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClusterResource {
    pub kind: String,
    pub name: String,
    pub namespace: String,
    pub status: String,
    pub ready: String,
    pub age: String,
    pub detail: String,
    pub containers: Vec<String>,
    pub ports: Vec<String>,
    /// Data entry keys when `kind` is `ConfigMap` or `Secret` (for editor auto-completion).
    pub data_keys: Vec<String>,
    #[serde(default)]
    pub container_states: Vec<ContainerStateBadge>,
    #[serde(default)]
    pub cpu: String,
    #[serde(default)]
    pub memory: String,
    #[serde(default)]
    pub restarts: u64,
    #[serde(default)]
    pub controlled_by_kind: String,
    #[serde(default)]
    pub controlled_by_name: String,
    #[serde(default)]
    pub pod_ip: String,
    #[serde(default)]
    pub host_ip: String,
    #[serde(default)]
    pub node_name: String,
    #[serde(default)]
    pub qos: String,
    #[serde(default)]
    pub labels: Vec<String>,
}

/// Summary of one Kubernetes event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClusterEvent {
    pub kind: String,
    pub object: String,
    pub namespace: String,
    pub reason: String,
    pub message: String,
    pub event_type: String,
    pub count: u64,
    pub last_seen: String,
}

/// Summary of one Helm release.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelmRelease {
    pub name: String,
    pub namespace: String,
    pub revision: String,
    pub status: String,
    pub chart: String,
    pub app_version: String,
    pub updated: String,
}

/// Snapshot of the cluster state displayed in the Kubernetes tool window.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClusterSnapshot {
    pub connected: bool,
    pub error: Option<String>,
    pub current_context: String,
    pub contexts: Vec<String>,
    pub cluster_catalog: Vec<ClusterContextInfo>,
    pub current_namespace: String,
    pub all_namespaces: bool,
    pub namespaces: Vec<String>,
    pub resources: Vec<ClusterResource>,
    pub events: Vec<ClusterEvent>,
    pub helm_releases: Vec<HelmRelease>,
}

/// Finds the active `Project` from `ctx` or the first open project in the workspace.
pub fn resolve_project(ctx: &Invocation) -> Result<Project, Error> {
    if let Some(p) = ctx.project() {
        return Ok(p);
    }
    host::projects()?
        .into_iter()
        .next()
        .ok_or_else(|| Error::Invalid("open a project to run Kubernetes commands".into()))
}

/// Runs `kubectl` with `args` in `project`.
pub fn run_kubectl(project: &Project, args: &[String], stdin: Option<&str>) -> Result<ProcessOutput, Error> {
    project.run_process("kubectl", args, stdin)
}

pub type KubeconfigOverview = (String, Vec<String>, Option<String>, Vec<ClusterContextInfo>);

/// Generates a 2–3 letter uppercase badge (like Freelens `AP`, `FDC`, `FPG`) from a context name.
pub fn compute_short_name(name: &str) -> String {
    let parts: Vec<&str> = name.split(['-', '_', '.', '/']).filter(|s| !s.is_empty()).collect();
    if parts.len() >= 3 {
        parts.iter().take(3).filter_map(|p| p.chars().next()).map(|c| c.to_ascii_uppercase()).collect()
    } else if parts.len() == 2 {
        parts.iter().filter_map(|p| p.chars().next()).map(|c| c.to_ascii_uppercase()).collect()
    } else {
        name.chars().take(3).map(|c| c.to_ascii_uppercase()).collect()
    }
}

/// Infers the user's home directory from `project.root()` (e.g. `/Users/<user>/...` or `/home/<user>/...`).
fn infer_home_dir(project: &Project) -> Option<String> {
    let root = project.root().ok()?.replace('\\', "/");
    let segs: Vec<&str> = root.split('/').filter(|s| !s.is_empty()).collect();
    if segs.len() >= 2 && matches!(segs[0], "Users" | "home") {
        return Some(format!("/{}/{}", segs[0], segs[1]));
    }
    if root.len() >= 9
        && root.as_bytes().get(1) == Some(&b':')
        && segs.len() >= 3
        && segs[1].eq_ignore_ascii_case("Users")
    {
        return Some(format!("{}/{}/{}", segs[0], segs[1], segs[2]));
    }
    None
}

#[derive(Deserialize)]
struct RawFreelensConfigMap {
    #[serde(default)]
    data: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct RawFreelensClusterStore {
    #[serde(default)]
    clusters: Vec<RawFreelensCluster>,
}

#[derive(Deserialize)]
struct RawFreelensCluster {
    #[serde(default)]
    id: String,
    #[serde(default, rename = "contextName")]
    context_name: String,
    #[serde(default, rename = "kubeConfigPath")]
    kube_config_path: String,
    #[serde(default)]
    metadata: Option<RawFreelensClusterMeta>,
}

#[derive(Deserialize)]
struct RawFreelensClusterMeta {
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    distribution: Option<String>,
    #[serde(default)]
    nodes: Option<u32>,
    #[serde(default, rename = "lastSeen")]
    last_seen: Option<String>,
}

#[derive(Deserialize)]
struct RawFreelensHotbarStore {
    #[serde(default)]
    hotbars: Vec<RawFreelensHotbar>,
}

#[derive(Deserialize)]
struct RawFreelensHotbar {
    #[serde(default)]
    items: Vec<Option<RawFreelensHotbarItem>>,
}

#[derive(Deserialize)]
struct RawFreelensHotbarItem {
    #[serde(default)]
    entity: Option<RawFreelensHotbarEntity>,
}

#[derive(Deserialize)]
struct RawFreelensHotbarEntity {
    #[serde(default)]
    uid: String,
    #[serde(default)]
    name: String,
    #[serde(default, rename = "shortName")]
    short_name: Option<String>,
}

struct FreelensClusterEntry {
    id: String,
    version: String,
    nodes: Option<u32>,
    distro: String,
    last_seen: String,
    kube_config_path: String,
}

/// Enriches `catalog` with Freelens `lens-cluster-store.json` and `lens-hotbar-store.json` when installed locally.
pub fn merge_freelens_stores(
    catalog: &mut [ClusterContextInfo],
    clusters_json: Option<&str>,
    hotbars_json: Option<&str>,
) {
    let mut by_context: BTreeMap<String, FreelensClusterEntry> = BTreeMap::new();
    if let Some(cjson) = clusters_json
        && let Ok(store) = serde_json::from_str::<RawFreelensClusterStore>(cjson)
    {
        for cl in store.clusters {
            if cl.context_name.is_empty() {
                continue;
            }
            let meta = cl.metadata.unwrap_or(RawFreelensClusterMeta {
                version: None,
                distribution: None,
                nodes: None,
                last_seen: None,
            });
            let ver = meta.version.unwrap_or_default();
            let dist = meta.distribution.filter(|d| d != "unknown").unwrap_or_default();
            let last_seen = meta.last_seen.unwrap_or_default();
            by_context.insert(
                cl.context_name,
                FreelensClusterEntry {
                    id: cl.id,
                    version: ver,
                    nodes: meta.nodes,
                    distro: dist,
                    last_seen,
                    kube_config_path: cl.kube_config_path,
                },
            );
        }
    }

    let mut hotbar_by_name_or_uid: BTreeMap<String, (String, u32)> = BTreeMap::new();
    if let Some(hjson) = hotbars_json
        && let Ok(hstore) = serde_json::from_str::<RawFreelensHotbarStore>(hjson)
    {
        let mut order_idx = 0u32;
        for hb in hstore.hotbars {
            for item in hb.items.into_iter().flatten() {
                if let Some(ent) = item.entity {
                    if ent.uid == "welcome-page-entity" || ent.uid == "catalog-entity" {
                        continue;
                    }
                    let badge = ent
                        .short_name
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_ascii_uppercase())
                        .unwrap_or_else(|| compute_short_name(&ent.name));
                    let ord = order_idx;
                    order_idx += 1;
                    if !ent.name.is_empty() {
                        hotbar_by_name_or_uid.insert(ent.name, (badge.clone(), ord));
                    }
                    if !ent.uid.is_empty() {
                        hotbar_by_name_or_uid.insert(ent.uid, (badge, ord));
                    }
                }
            }
        }
    }

    let mut used_hotbar_badges: BTreeMap<String, usize> = BTreeMap::new();
    for entry in catalog.iter_mut() {
        let mut cluster_uid = String::new();
        if let Some(fl) = by_context.get(&entry.name) {
            cluster_uid = fl.id.clone();
            if !fl.version.is_empty() {
                entry.version = fl.version.clone();
            }
            if fl.nodes.is_some() {
                entry.nodes = fl.nodes;
            }
            if !fl.distro.is_empty() {
                entry.distro = fl.distro.clone();
            }
            if !fl.last_seen.is_empty() {
                entry.last_seen = fl.last_seen.clone();
            }
            if !fl.kube_config_path.is_empty()
                && entry.source == "~/.kube/config"
                && fl.kube_config_path.ends_with("/.kube/config")
            {
                entry.source = "~/.kube/config".into();
            }
        }
        if let Some((badge, ord)) = hotbar_by_name_or_uid
            .get(&entry.name)
            .or_else(|| (!cluster_uid.is_empty()).then(|| hotbar_by_name_or_uid.get(&cluster_uid)).flatten())
        {
            entry.hotbar_pinned = true;
            entry.hotbar_order = Some(*ord);
            let count = used_hotbar_badges.entry(badge.clone()).or_insert(0);
            *count += 1;
            if *count > 1 && entry.name.ends_with("-staging") {
                entry.short_name = format!("{badge}S");
            } else {
                entry.short_name = badge.clone();
            }
        }
        if entry.short_name.is_empty() {
            entry.short_name = compute_short_name(&entry.name);
        }
    }
}

/// Reads Freelens's `lens-cluster-store.json` and `lens-hotbar-store.json` via a single offline
/// `kubectl create configmap --dry-run=client -o json` call (requires no extra permissions beyond `process:kubectl`).
fn load_local_freelens_metadata(project: &Project, catalog: &mut [ClusterContextInfo]) {
    let Some(home) = infer_home_dir(project) else {
        return;
    };
    let candidate_dirs = [
        format!("{home}/Library/Application Support/Freelens"),
        format!("{home}/.config/Freelens"),
        format!("{home}/AppData/Roaming/Freelens"),
    ];
    for dir in candidate_dirs {
        let clusters_file = format!("{dir}/lens-cluster-store.json");
        let hotbars_file = format!("{dir}/lens-hotbar-store.json");
        let args = vec![
            "create".to_owned(),
            "configmap".into(),
            "freelens-sync".into(),
            format!("--from-file=clusters={clusters_file}"),
            format!("--from-file=hotbars={hotbars_file}"),
            "--dry-run=client".into(),
            "-o".into(),
            "json".into(),
        ];
        if let Ok(out) = run_kubectl(project, &args, None)
            && out.status == Some(0)
            && let Ok(cm) = serde_json::from_str::<RawFreelensConfigMap>(&out.stdout)
        {
            merge_freelens_stores(
                catalog,
                cm.data.get("clusters").map(String::as_str),
                cm.data.get("hotbars").map(String::as_str),
            );
            return;
        }
    }
}

/// Queries `kubectl config view -o json` to get available contexts, active context, active namespace, and full cluster catalog.
pub fn fetch_kubeconfig_overview(project: &Project, cfg: &KubeConfigState) -> Result<KubeconfigOverview, Error> {
    let mut args = Vec::new();
    if !cfg.kubeconfig.trim().is_empty() {
        args.push(format!("--kubeconfig={}", cfg.kubeconfig.trim()));
    }
    args.extend(["config".into(), "view".into(), "-o".into(), "json".into()]);
    let out = run_kubectl(project, &args, None)?;
    if out.status != Some(0) {
        return Err(Error::Failed(first_line_or(&out.stderr, "kubectl config view failed")));
    }
    let source =
        if cfg.kubeconfig.trim().is_empty() { "~/.kube/config".to_owned() } else { cfg.kubeconfig.trim().to_owned() };
    let (current, contexts, active_ns, mut catalog) = parse_kubeconfig_catalog(&out.stdout, &cfg.context, &source);
    load_local_freelens_metadata(project, &mut catalog);
    Ok((current, contexts, active_ns, catalog))
}

#[derive(Deserialize)]
struct RawKubeconfig {
    #[serde(rename = "current-context", default)]
    current_context: String,
    #[serde(default)]
    clusters: Vec<RawClusterEntry>,
    #[serde(default)]
    contexts: Vec<RawContextEntry>,
}

#[derive(Deserialize)]
struct RawClusterEntry {
    #[serde(default)]
    name: String,
    #[serde(default)]
    cluster: Option<RawClusterDetail>,
}

#[derive(Deserialize)]
struct RawClusterDetail {
    #[serde(default)]
    server: Option<String>,
}

#[derive(Deserialize)]
struct RawContextEntry {
    #[serde(default)]
    name: String,
    #[serde(default)]
    context: Option<RawContextDetail>,
}

#[derive(Deserialize)]
struct RawContextDetail {
    #[serde(default)]
    cluster: Option<String>,
    #[serde(default)]
    user: Option<String>,
    #[serde(default)]
    namespace: Option<String>,
}

/// Parses `kubectl config view -o json` output using typed deserialization (skipping cert blobs).
/// When `current-context` is not set in kubeconfig, falls back to the first available context.
pub fn parse_kubeconfig_json(json_str: &str, override_context: &str) -> (String, Vec<String>, Option<String>) {
    let (cur, ctxs, ns, _) = parse_kubeconfig_catalog(json_str, override_context, "~/.kube/config");
    (cur, ctxs, ns)
}

pub fn parse_kubeconfig_catalog(json_str: &str, override_context: &str, source: &str) -> KubeconfigOverview {
    let Ok(raw) = serde_json::from_str::<RawKubeconfig>(json_str) else {
        return (override_context.to_owned(), Vec::new(), None, Vec::new());
    };
    let mut cluster_servers = BTreeMap::new();
    for cl in raw.clusters {
        if !cl.name.is_empty()
            && let Some(server) = cl.cluster.and_then(|d| d.server)
        {
            cluster_servers.insert(cl.name, server);
        }
    }
    let mut contexts = Vec::with_capacity(raw.contexts.len());
    let mut catalog = Vec::with_capacity(raw.contexts.len());
    let mut context_namespaces = BTreeMap::new();
    for item in raw.contexts {
        if !item.name.is_empty() {
            let (cluster_name, user_name, ns_opt) = match item.context {
                Some(c) => (
                    c.cluster.unwrap_or_else(|| item.name.clone()),
                    c.user.unwrap_or_default(),
                    c.namespace.filter(|s| !s.is_empty()),
                ),
                None => (item.name.clone(), String::new(), None),
            };
            if let Some(ref ns) = ns_opt {
                context_namespaces.insert(item.name.clone(), ns.clone());
            }
            let server = cluster_servers.get(&cluster_name).cloned().unwrap_or_default();
            let distro = if server.contains(".azmk8s.io") {
                "aks".into()
            } else if server.contains(".eks.amazonaws.com") {
                "eks".into()
            } else if server.contains("gke") {
                "gke".into()
            } else if item.name.contains("docker-desktop") {
                "docker-desktop".into()
            } else if item.name.contains("minikube") {
                "minikube".into()
            } else if item.name.starts_with("kind-") {
                "kind".into()
            } else {
                String::new()
            };
            let short_name = compute_short_name(&item.name);
            catalog.push(ClusterContextInfo {
                name: item.name.clone(),
                cluster: cluster_name,
                server,
                user: user_name,
                namespace: ns_opt.unwrap_or_else(|| "default".into()),
                source: source.to_owned(),
                short_name,
                version: String::new(),
                distro,
                nodes: None,
                last_seen: String::new(),
                hotbar_pinned: false,
                hotbar_order: None,
            });
            contexts.push(item.name);
        }
    }
    let current = if !override_context.trim().is_empty() {
        override_context.trim().to_owned()
    } else if !raw.current_context.trim().is_empty() {
        raw.current_context.trim().to_owned()
    } else {
        contexts.first().cloned().unwrap_or_default()
    };
    let active_ns = context_namespaces.remove(&current);
    (current, contexts, active_ns, catalog)
}

#[derive(Deserialize)]
struct RawResourceList {
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    items: Option<Vec<RawResourceItem>>,
    #[serde(flatten)]
    single: Option<RawResourceItem>,
}

#[derive(Deserialize)]
struct RawResourceItem {
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    metadata: Option<RawMetadata>,
    #[serde(default)]
    spec: Option<RawSpec>,
    #[serde(default)]
    status: Option<RawStatus>,
    #[serde(default, rename = "type")]
    secret_type: Option<String>,
    #[serde(default)]
    provisioner: Option<String>,
    #[serde(default, rename = "reclaimPolicy")]
    reclaim_policy: Option<String>,
    #[serde(default, rename = "volumeBindingMode")]
    volume_binding_mode: Option<String>,
    #[serde(default)]
    data: Option<BTreeMap<String, serde::de::IgnoredAny>>,
    #[serde(default, rename = "stringData")]
    string_data: Option<BTreeMap<String, serde::de::IgnoredAny>>,
    #[serde(default)]
    value: Option<i64>,
    #[serde(default, rename = "globalDefault")]
    global_default: Option<bool>,
    #[serde(default)]
    handler: Option<String>,
    #[serde(default, rename = "addressType")]
    address_type: Option<String>,
    #[serde(default)]
    webhooks: Option<Vec<serde::de::IgnoredAny>>,
    #[serde(default)]
    rules: Option<Vec<serde::de::IgnoredAny>>,
    #[serde(default)]
    secrets: Option<Vec<serde::de::IgnoredAny>>,
    #[serde(default, rename = "roleRef")]
    role_ref: Option<RawOwnerReference>,
    #[serde(default)]
    subjects: Option<Vec<RawOwnerReference>>,
}

#[derive(Deserialize)]
struct RawOwnerReference {
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
struct RawMetadata {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    namespace: Option<String>,
    #[serde(default, rename = "creationTimestamp")]
    creation_timestamp: Option<String>,
    #[serde(default, rename = "ownerReferences")]
    owner_references: Option<Vec<RawOwnerReference>>,
    #[serde(default)]
    labels: Option<BTreeMap<String, String>>,
}

#[derive(Deserialize)]
struct RawSpec {
    #[serde(default, rename = "nodeName")]
    node_name: Option<String>,
    #[serde(default)]
    replicas: Option<u64>,
    #[serde(default)]
    completions: Option<u64>,
    #[serde(default)]
    schedule: Option<String>,
    #[serde(default)]
    suspend: Option<bool>,
    #[serde(default, rename = "type")]
    service_type: Option<String>,
    #[serde(default, rename = "clusterIP")]
    cluster_ip: Option<String>,
    #[serde(default, rename = "ingressClassName")]
    ingress_class_name: Option<String>,
    #[serde(default)]
    rules: Option<Vec<RawIngressRule>>,
    #[serde(default, rename = "storageClassName")]
    storage_class_name: Option<String>,
    #[serde(default)]
    resources: Option<RawPvcResources>,
    #[serde(default)]
    group: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    names: Option<RawCrdNames>,
    #[serde(default)]
    containers: Option<Vec<RawContainer>>,
    #[serde(default, rename = "initContainers")]
    init_containers: Option<Vec<RawContainer>>,
    #[serde(default)]
    template: Option<RawPodTemplate>,
    #[serde(default)]
    ports: Option<Vec<RawServicePort>>,
    #[serde(default, rename = "minReplicas")]
    min_replicas: Option<u64>,
    #[serde(default, rename = "maxReplicas")]
    max_replicas: Option<u64>,
    #[serde(default, rename = "scaleTargetRef")]
    scale_target_ref: Option<RawOwnerReference>,
    #[serde(default, rename = "minAvailable")]
    min_available: Option<Value>,
    #[serde(default, rename = "maxUnavailable")]
    max_unavailable: Option<Value>,
    #[serde(default, rename = "holderIdentity")]
    holder_identity: Option<String>,
    #[serde(default)]
    controller: Option<String>,
    #[serde(default)]
    capacity: Option<BTreeMap<String, String>>,
    #[serde(default, rename = "persistentVolumeReclaimPolicy")]
    pv_reclaim_policy: Option<String>,
}

#[derive(Deserialize)]
struct RawPodTemplate {
    #[serde(default)]
    spec: Option<RawPodTemplateSpec>,
}

#[derive(Deserialize)]
struct RawPodTemplateSpec {
    #[serde(default)]
    containers: Option<Vec<RawContainer>>,
    #[serde(default, rename = "initContainers")]
    init_containers: Option<Vec<RawContainer>>,
}

#[derive(Deserialize)]
struct RawContainer {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    ports: Option<Vec<RawContainerPort>>,
}

#[derive(Deserialize)]
struct RawContainerPort {
    #[serde(default, rename = "containerPort")]
    container_port: Option<u64>,
}

#[derive(Deserialize)]
struct RawServicePort {
    #[serde(default)]
    port: Option<u64>,
    #[serde(default)]
    protocol: Option<String>,
}

#[derive(Deserialize)]
struct RawIngressRule {
    #[serde(default)]
    host: Option<String>,
}

#[derive(Deserialize)]
struct RawPvcResources {
    #[serde(default)]
    requests: Option<BTreeMap<String, String>>,
}

#[derive(Deserialize)]
struct RawCrdNames {
    #[serde(default)]
    kind: Option<String>,
}

#[derive(Deserialize)]
struct RawStatus {
    #[serde(default)]
    phase: Option<String>,
    #[serde(default, rename = "podIP")]
    pod_ip: Option<String>,
    #[serde(default, rename = "hostIP")]
    host_ip: Option<String>,
    #[serde(default, rename = "qosClass")]
    qos_class: Option<String>,
    #[serde(default, rename = "containerStatuses")]
    container_statuses: Option<Vec<RawContainerStatus>>,
    #[serde(default, rename = "initContainerStatuses")]
    init_container_statuses: Option<Vec<RawContainerStatus>>,
    #[serde(default, rename = "readyReplicas")]
    ready_replicas: Option<u64>,
    #[serde(default, rename = "updatedReplicas")]
    updated_replicas: Option<u64>,
    #[serde(default, rename = "desiredNumberScheduled")]
    desired_number_scheduled: Option<u64>,
    #[serde(default, rename = "numberReady")]
    number_ready: Option<u64>,
    #[serde(default)]
    succeeded: Option<u64>,
    #[serde(default)]
    failed: Option<u64>,
    #[serde(default)]
    capacity: Option<BTreeMap<String, String>>,
    #[serde(default)]
    conditions: Option<Vec<RawCondition>>,
    #[serde(default, rename = "nodeInfo")]
    node_info: Option<RawNodeInfo>,
    #[serde(default, rename = "currentReplicas")]
    current_replicas: Option<u64>,
    #[serde(default, rename = "desiredReplicas")]
    desired_replicas: Option<u64>,
    #[serde(default, rename = "currentHealthy")]
    current_healthy: Option<u64>,
    #[serde(default, rename = "desiredHealthy")]
    desired_healthy: Option<u64>,
    #[serde(default, rename = "disruptionsAllowed")]
    disruptions_allowed: Option<u64>,
}

#[derive(Deserialize)]
struct RawContainerStatus {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    ready: Option<bool>,
    #[serde(default, rename = "restartCount")]
    restart_count: Option<u64>,
    #[serde(default)]
    state: Option<RawContainerState>,
}

#[derive(Deserialize)]
struct RawContainerState {
    #[serde(default)]
    running: Option<serde::de::IgnoredAny>,
    #[serde(default)]
    waiting: Option<RawWaitingState>,
    #[serde(default)]
    terminated: Option<RawTerminatedState>,
}

#[derive(Deserialize)]
struct RawWaitingState {
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Deserialize)]
struct RawTerminatedState {
    #[serde(default)]
    reason: Option<String>,
    #[serde(default, rename = "exitCode")]
    exit_code: Option<i64>,
}

#[derive(Deserialize)]
struct RawCondition {
    #[serde(default, rename = "type")]
    cond_type: Option<String>,
    #[serde(default)]
    status: Option<String>,
}

#[derive(Deserialize)]
struct RawNodeInfo {
    #[serde(default, rename = "kubeletVersion")]
    kubelet_version: Option<String>,
}

/// Parses a `kubectl get ... -o json` List or single resource into `ClusterResource` items
/// using typed deserialization so large annotations, `managedFields`, and CRD schemas are skipped without allocation.
pub fn parse_resource_list_json(json_str: &str) -> Vec<ClusterResource> {
    let Ok(parsed) = serde_json::from_str::<RawResourceList>(json_str) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Some(items) = parsed.items {
        for item in items {
            if let Some(res) = parse_raw_resource_item(item) {
                out.push(res);
            }
        }
    } else if parsed.kind.is_some()
        && let Some(mut single) = parsed.single
    {
        if single.kind.is_none() {
            single.kind = parsed.kind;
        }
        if let Some(res) = parse_raw_resource_item(single) {
            out.push(res);
        }
    }
    out
}

fn parse_raw_resource_item(item: RawResourceItem) -> Option<ClusterResource> {
    let kind = item.kind?;
    let meta = item.metadata?;
    let name = meta.name?;
    let namespace = meta.namespace.unwrap_or_default();
    let age = meta.creation_timestamp.unwrap_or_default();
    let spec = item.spec.unwrap_or(RawSpec {
        node_name: None,
        replicas: None,
        completions: None,
        schedule: None,
        suspend: None,
        service_type: None,
        cluster_ip: None,
        ingress_class_name: None,
        rules: None,
        storage_class_name: None,
        resources: None,
        group: None,
        scope: None,
        names: None,
        containers: None,
        init_containers: None,
        template: None,
        ports: None,
        min_replicas: None,
        max_replicas: None,
        scale_target_ref: None,
        min_available: None,
        max_unavailable: None,
        holder_identity: None,
        controller: None,
        capacity: None,
        pv_reclaim_policy: None,
    });
    let st = item.status.unwrap_or(RawStatus {
        phase: None,
        pod_ip: None,
        host_ip: None,
        qos_class: None,
        container_statuses: None,
        init_container_statuses: None,
        ready_replicas: None,
        updated_replicas: None,
        desired_number_scheduled: None,
        number_ready: None,
        succeeded: None,
        failed: None,
        capacity: None,
        conditions: None,
        node_info: None,
        current_replicas: None,
        desired_replicas: None,
        current_healthy: None,
        desired_healthy: None,
        disruptions_allowed: None,
    });

    let (controlled_by_kind, controlled_by_name) = meta
        .owner_references
        .and_then(|mut v| v.pop())
        .map(|o| (o.kind.unwrap_or_default(), o.name.unwrap_or_default()))
        .unwrap_or_default();
    let labels: Vec<String> =
        meta.labels.map(|m| m.into_iter().map(|(k, v)| format!("{k}={v}")).collect()).unwrap_or_default();

    let mut containers = Vec::new();
    let mut container_states = Vec::new();
    let mut ports = Vec::new();
    let mut data_keys = Vec::new();
    let mut status = "Active".to_owned();
    let mut ready = String::new();
    let mut detail = String::new();
    let mut restarts = 0u64;
    let mut pod_ip = st.pod_ip.clone().unwrap_or_default();
    let host_ip = st.host_ip.clone().unwrap_or_default();
    let mut node_name = spec.node_name.clone().unwrap_or_default();
    let qos = st.qos_class.clone().unwrap_or_default();

    let carr = spec
        .containers
        .as_ref()
        .or_else(|| spec.template.as_ref().and_then(|t| t.spec.as_ref()).and_then(|s| s.containers.as_ref()));
    if let Some(carr) = carr {
        for c in carr {
            if let Some(ref cname) = c.name {
                containers.push(cname.clone());
            }
            if let Some(ref parr) = c.ports {
                for p in parr {
                    if let Some(cp) = p.container_port {
                        ports.push(cp.to_string());
                    }
                }
            }
        }
    }
    let init_arr = spec
        .init_containers
        .as_ref()
        .or_else(|| spec.template.as_ref().and_then(|t| t.spec.as_ref()).and_then(|s| s.init_containers.as_ref()));
    if let Some(init_arr) = init_arr {
        for c in init_arr {
            if let Some(ref cname) = c.name {
                containers.push(cname.clone());
            }
        }
    }

    match kind.as_str() {
        "Pod" => {
            status = st.phase.unwrap_or_else(|| "Unknown".into());
            if let Some(cs_arr) = st.container_statuses {
                let total = cs_arr.len();
                let ready_count = cs_arr.iter().filter(|cs| cs.ready.unwrap_or(false)).count();
                ready = format!("{ready_count}/{total}");
                restarts = cs_arr.iter().filter_map(|cs| cs.restart_count).sum();
                for cs in &cs_arr {
                    let cname = cs.name.clone().unwrap_or_default();
                    let cready = cs.ready.unwrap_or(false);
                    let (cstate, creason) = match cs.state.as_ref() {
                        Some(s) if s.running.is_some() => ("running".to_owned(), String::new()),
                        Some(s) if s.waiting.is_some() => (
                            "waiting".to_owned(),
                            s.waiting.as_ref().and_then(|w| w.reason.clone()).unwrap_or_default(),
                        ),
                        Some(s) if s.terminated.is_some() => {
                            let r = s.terminated.as_ref().and_then(|t| t.reason.clone()).unwrap_or_else(|| {
                                if s.terminated.as_ref().and_then(|t| t.exit_code) == Some(0) {
                                    "Completed".into()
                                } else {
                                    "Error".into()
                                }
                            });
                            ("terminated".to_owned(), r)
                        }
                        _ => ("unknown".to_owned(), String::new()),
                    };
                    if cstate == "waiting" && !creason.is_empty() {
                        status = creason.clone();
                    }
                    container_states.push(ContainerStateBadge {
                        name: cname,
                        state: cstate,
                        ready: cready,
                        reason: creason,
                        is_init: false,
                    });
                }
                if let Some(init_cs_arr) = st.init_container_statuses {
                    for ics in init_cs_arr {
                        let cname = ics.name.unwrap_or_default();
                        let cready = ics.ready.unwrap_or(false);
                        let (cstate, creason) = match ics.state.as_ref() {
                            Some(s) if s.running.is_some() => ("running".to_owned(), String::new()),
                            Some(s) if s.waiting.is_some() => (
                                "waiting".to_owned(),
                                s.waiting.as_ref().and_then(|w| w.reason.clone()).unwrap_or_default(),
                            ),
                            Some(s) if s.terminated.is_some() => (
                                "terminated".to_owned(),
                                s.terminated
                                    .as_ref()
                                    .and_then(|t| t.reason.clone())
                                    .unwrap_or_else(|| "Completed".into()),
                            ),
                            _ => ("terminated".to_owned(), "Completed".into()),
                        };
                        container_states.push(ContainerStateBadge {
                            name: cname,
                            state: cstate,
                            ready: cready,
                            reason: creason,
                            is_init: true,
                        });
                    }
                }
                let node = spec.node_name.as_deref().unwrap_or("");
                let pip = st.pod_ip.as_deref().unwrap_or("");
                detail = match (node.is_empty(), pip.is_empty()) {
                    (false, false) => format!("restarts: {restarts} • {pip} on {node}"),
                    (false, true) => format!("restarts: {restarts} • {node}"),
                    _ => format!("restarts: {restarts}"),
                };
            } else {
                ready = format!("0/{}", containers.len());
            }
        }
        "Deployment" | "StatefulSet" | "ReplicaSet" => {
            let desired = spec.replicas.unwrap_or(1);
            let rdy = st.ready_replicas.unwrap_or(0);
            let updated = st.updated_replicas.unwrap_or(rdy);
            ready = format!("{rdy}/{desired}");
            status = if rdy == desired {
                "Ready".into()
            } else if rdy > 0 {
                "Progressing".into()
            } else {
                "Scaling".into()
            };
            detail = format!("up-to-date: {updated}");
        }
        "DaemonSet" => {
            let desired = st.desired_number_scheduled.unwrap_or(0);
            let rdy = st.number_ready.unwrap_or(0);
            ready = format!("{rdy}/{desired}");
            status = if rdy == desired { "Ready".into() } else { "Degraded".into() };
        }
        "Job" => {
            let completions = spec.completions.unwrap_or(1);
            let succeeded = st.succeeded.unwrap_or(0);
            let failed = st.failed.unwrap_or(0);
            ready = format!("{succeeded}/{completions}");
            status = if succeeded >= completions {
                "Complete".into()
            } else if failed > 0 {
                "Failed".into()
            } else {
                "Running".into()
            };
        }
        "CronJob" => {
            let schedule = spec.schedule.as_deref().unwrap_or("* * * * *");
            let suspended = spec.suspend.unwrap_or(false);
            status = if suspended { "Suspended".into() } else { "Scheduled".into() };
            ready = schedule.to_owned();
            detail = format!("schedule: {schedule}");
        }
        "Service" => {
            let svc_type = spec.service_type.unwrap_or_else(|| "ClusterIP".into());
            let cluster_ip = spec.cluster_ip.unwrap_or_else(|| "None".into());
            status = svc_type;
            pod_ip = cluster_ip.clone();
            if let Some(parr) = spec.ports {
                for p in parr {
                    if let Some(port) = p.port {
                        let proto = p.protocol.as_deref().unwrap_or("TCP");
                        ports.push(port.to_string());
                        if !ready.is_empty() {
                            ready.push_str(", ");
                        }
                        ready.push_str(&format!("{port}/{proto}"));
                    }
                }
            }
            detail = format!("ClusterIP: {cluster_ip}");
        }
        "Ingress" => {
            let class = spec.ingress_class_name.unwrap_or_else(|| "default".into());
            let hosts: Vec<String> =
                spec.rules.map(|rules| rules.into_iter().filter_map(|r| r.host).collect()).unwrap_or_default();
            status = format!("Class: {class}");
            detail = if hosts.is_empty() { "*".into() } else { hosts.join(", ") };
        }
        "ConfigMap" | "Secret" => {
            if let Some(obj) = item.data {
                data_keys.extend(obj.into_keys());
            }
            if let Some(obj) = item.string_data {
                for k in obj.into_keys() {
                    if !data_keys.contains(&k) {
                        data_keys.push(k);
                    }
                }
            }
            data_keys.sort();
            ready = format!("{} keys", data_keys.len());
            if kind == "Secret" {
                status = item.secret_type.unwrap_or_else(|| "Opaque".into());
            } else {
                status = "ConfigMap".into();
            }
            detail = data_keys.iter().take(5).cloned().collect::<Vec<_>>().join(", ");
        }
        "PersistentVolumeClaim" => {
            status = st.phase.unwrap_or_else(|| "Pending".into());
            let cap = st
                .capacity
                .as_ref()
                .and_then(|m| m.get("storage"))
                .or_else(|| spec.resources.as_ref().and_then(|r| r.requests.as_ref()).and_then(|m| m.get("storage")))
                .cloned()
                .unwrap_or_default();
            let sc = spec.storage_class_name.unwrap_or_default();
            node_name = sc.clone();
            ready = cap;
            detail = if sc.is_empty() { String::new() } else { format!("storageClass: {sc}") };
        }
        "StorageClass" => {
            ready = item.provisioner.unwrap_or_default();
            status = item.reclaim_policy.unwrap_or_else(|| "Delete".into());
            detail = item.volume_binding_mode.unwrap_or_else(|| "Immediate".into());
        }
        "PersistentVolume" => {
            status = st.phase.unwrap_or_else(|| "Available".into());
            let sc = spec.storage_class_name.unwrap_or_default();
            node_name = sc.clone();
            let cap = spec.capacity.as_ref().and_then(|m| m.get("storage")).cloned().unwrap_or_default();
            ready = cap;
            let reclaim = spec.pv_reclaim_policy.unwrap_or_default();
            detail = match (sc.is_empty(), reclaim.is_empty()) {
                (false, false) => format!("storageClass: {sc} • {reclaim}"),
                (false, true) => format!("storageClass: {sc}"),
                (true, false) => reclaim,
                _ => String::new(),
            };
        }
        "Node" => {
            let is_ready = st.conditions.is_some_and(|arr| {
                arr.iter().any(|c| c.cond_type.as_deref() == Some("Ready") && c.status.as_deref() == Some("True"))
            });
            status = if is_ready { "Ready".into() } else { "NotReady".into() };
            ready = st.node_info.and_then(|n| n.kubelet_version).unwrap_or_default();
        }
        "Namespace" => {
            status = st.phase.unwrap_or_else(|| "Active".into());
        }
        "CustomResourceDefinition" => {
            status = spec.scope.unwrap_or_default();
            ready = spec.names.and_then(|n| n.kind).unwrap_or_default();
            detail = spec.group.unwrap_or_default();
        }
        "HorizontalPodAutoscaler" => {
            let min_p = spec.min_replicas.unwrap_or(1);
            let max_p = spec.max_replicas.unwrap_or(1);
            let cur_p = st.current_replicas.unwrap_or(0);
            let des_p = st.desired_replicas.unwrap_or(0);
            ready = format!("{min_p}/{max_p} (current: {cur_p})");
            status = format!("{cur_p}/{des_p}");
            if let Some(t) = spec.scale_target_ref {
                let tk = t.kind.unwrap_or_default();
                let tn = t.name.unwrap_or_default();
                if !tn.is_empty() {
                    detail = format!("{tk}/{tn}");
                }
            }
        }
        "PodDisruptionBudget" => {
            let min_av = spec
                .min_available
                .map(|v| v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string()))
                .unwrap_or_else(|| "N/A".into());
            let max_un = spec
                .max_unavailable
                .map(|v| v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string()))
                .unwrap_or_else(|| "N/A".into());
            let cur_h = st.current_healthy.unwrap_or(0);
            let des_h = st.desired_healthy.unwrap_or(0);
            let dis_a = st.disruptions_allowed.unwrap_or(0);
            ready = format!("min: {min_av}, maxUnavail: {max_un}");
            status = format!("{cur_h}/{des_h}");
            detail = format!("allowed disruptions: {dis_a}");
        }
        "PriorityClass" => {
            ready = item.value.unwrap_or(0).to_string();
            status = if item.global_default.unwrap_or(false) { "True".into() } else { "False".into() };
        }
        "RuntimeClass" => {
            ready = item.handler.unwrap_or_default();
        }
        "Lease" => {
            ready = spec.holder_identity.unwrap_or_default();
        }
        "IngressClass" => {
            ready = spec.controller.unwrap_or_default();
        }
        "EndpointSlice" => {
            ready = item.address_type.unwrap_or_else(|| "IPv4".into());
        }
        "MutatingWebhookConfiguration" | "ValidatingWebhookConfiguration" => {
            let cnt = item.webhooks.map(|w| w.len()).unwrap_or(0);
            ready = cnt.to_string();
        }
        "Role" | "ClusterRole" => {
            let cnt = item.rules.map(|r| r.len()).unwrap_or(0);
            ready = format!("{cnt} rules");
        }
        "RoleBinding" | "ClusterRoleBinding" => {
            if let Some(rr) = item.role_ref {
                ready = rr.name.unwrap_or_default();
            }
            if let Some(subs) = item.subjects {
                let names: Vec<String> = subs.into_iter().filter_map(|s| s.name).collect();
                detail = names.join(", ");
            }
        }
        "ServiceAccount" => {
            let cnt = item.secrets.map(|s| s.len()).unwrap_or(0);
            ready = format!("{cnt} secrets");
        }
        _ => {}
    }

    Some(ClusterResource {
        kind,
        name,
        namespace,
        status,
        ready,
        age,
        detail,
        containers,
        ports,
        data_keys,
        container_states,
        cpu: String::new(),
        memory: String::new(),
        restarts,
        controlled_by_kind,
        controlled_by_name,
        pod_ip,
        host_ip,
        node_name,
        qos,
        labels,
    })
}

#[derive(Deserialize)]
struct RawEventList {
    #[serde(default)]
    items: Vec<RawEventItem>,
}

#[derive(Deserialize)]
struct RawEventItem {
    #[serde(default, rename = "involvedObject")]
    involved_object: Option<RawInvolvedObject>,
    #[serde(default)]
    metadata: Option<RawMetadata>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default, rename = "type")]
    event_type: Option<String>,
    #[serde(default)]
    count: Option<u64>,
    #[serde(default, rename = "lastTimestamp")]
    last_timestamp: Option<String>,
    #[serde(default, rename = "eventTime")]
    event_time: Option<String>,
}

#[derive(Deserialize)]
struct RawInvolvedObject {
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

/// Parses `kubectl get events -o json` output into `ClusterEvent` items.
pub fn parse_events_json(json_str: &str) -> Vec<ClusterEvent> {
    let Ok(parsed) = serde_json::from_str::<RawEventList>(json_str) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in parsed.items.into_iter().rev().take(150) {
        let (obj_kind, obj_name) = match item.involved_object {
            Some(inv) => (inv.kind.unwrap_or_else(|| "Resource".into()), inv.name.unwrap_or_default()),
            None => ("Resource".into(), String::new()),
        };
        let (namespace, created) = match item.metadata {
            Some(m) => (m.namespace.unwrap_or_else(|| "default".into()), m.creation_timestamp.unwrap_or_default()),
            None => ("default".into(), String::new()),
        };
        let last_seen = item.last_timestamp.or(item.event_time).unwrap_or(created);
        out.push(ClusterEvent {
            kind: obj_kind,
            object: obj_name,
            namespace,
            reason: item.reason.unwrap_or_default(),
            message: item.message.unwrap_or_default(),
            event_type: item.event_type.unwrap_or_else(|| "Normal".into()),
            count: item.count.unwrap_or(1),
            last_seen,
        });
    }
    out
}

/// Parses `helm list -o json` output into `HelmRelease` items.
pub fn parse_helm_releases_json(json_str: &str) -> Vec<HelmRelease> {
    let Ok(arr) = serde_json::from_str::<Vec<Value>>(json_str) else {
        return Vec::new();
    };
    arr.into_iter()
        .filter_map(|v| {
            Some(HelmRelease {
                name: v.get("name")?.as_str()?.to_owned(),
                namespace: v.get("namespace").and_then(Value::as_str).unwrap_or("default").to_owned(),
                revision: v
                    .get("revision")
                    .map(|r| r.as_str().map(str::to_owned).unwrap_or_else(|| r.to_string()))
                    .unwrap_or_default(),
                status: v.get("status").and_then(Value::as_str).unwrap_or("unknown").to_owned(),
                chart: v.get("chart").and_then(Value::as_str).unwrap_or("").to_owned(),
                app_version: v.get("app_version").and_then(Value::as_str).unwrap_or("").to_owned(),
                updated: v.get("updated").and_then(Value::as_str).unwrap_or("").to_owned(),
            })
        })
        .collect()
}

const CUSTOM_COLUMNS_SPEC: &str = "custom-columns=KIND:.kind,NS:.metadata.namespace,NAME:.metadata.name,PHASE:.status.phase,READY_LIST:.status.containerStatuses[*].ready,RESTARTS:.status.containerStatuses[*].restartCount,NODE:.spec.nodeName,POD_IP:.status.podIP,READY_REP:.status.readyReplicas,SPEC_REP:.spec.replicas,DS_READY:.status.numberReady,DS_DESIRED:.status.desiredNumberScheduled,JOB_SUCC:.status.succeeded,JOB_COMP:.spec.completions,SCHEDULE:.spec.schedule,SUSPEND:.spec.suspend,SVC_TYPE:.spec.type,CLUSTER_IP:.spec.clusterIP,ING_CLASS:.spec.ingressClassName,ING_HOSTS:.spec.rules[*].host,PVC_CAP:.status.capacity.storage,PVC_SC:.spec.storageClassName,CONTAINERS:.spec.containers[*].name,PORTS:.spec.containers[*].ports[*].containerPort,SVC_PORTS:.spec.ports[*].port,OWNER_KIND:.metadata.ownerReferences[0].kind,OWNER_NAME:.metadata.ownerReferences[0].name,QOS:.status.qosClass,AGE:.metadata.creationTimestamp";

fn clean_col(val: &str) -> &str {
    if val == "<none>" || val == "<unset>" || val == "<nil>" { "" } else { val }
}

/// Parses compact `custom-columns` lines into `ClusterResource` items.
/// This keeps cluster-wide `--all-namespaces` responses well under the 4 MiB process output cap even on large production clusters.
pub fn parse_custom_columns_resources(text: &str) -> Vec<ClusterResource> {
    let mut out = Vec::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 26 {
            continue;
        }
        let n = cols.len();
        let has_owner_cols = n >= 29;
        let tail_cnt = if has_owner_cols { 14 } else { 11 };
        let kind = cols[0].to_owned();
        let namespace = clean_col(cols[1]).to_owned();
        let name = cols[2].to_owned();
        let phase = clean_col(cols[3]);
        let ready_list = clean_col(cols[4]);
        let restarts_list = clean_col(cols[5]);
        let node = clean_col(cols[6]);
        let pod_ip = clean_col(cols[7]);
        let ready_rep = clean_col(cols[8]);
        let spec_rep = clean_col(cols[9]);
        let ds_ready = clean_col(cols[10]);
        let ds_desired = clean_col(cols[11]);
        let job_succ = clean_col(cols[12]);
        let job_comp = clean_col(cols[13]);
        // `SCHEDULE` (index 14) may contain spaces (e.g. `*/5 * * * *`), while the last `tail_cnt` columns never contain spaces.
        let schedule_raw = cols[14..n - tail_cnt].join(" ");
        let schedule = clean_col(&schedule_raw);
        let suspend = clean_col(cols[n - tail_cnt]);
        let svc_type = clean_col(cols[n - tail_cnt + 1]);
        let cluster_ip = clean_col(cols[n - tail_cnt + 2]);
        let ing_class = clean_col(cols[n - tail_cnt + 3]);
        let ing_hosts = clean_col(cols[n - tail_cnt + 4]);
        let pvc_cap = clean_col(cols[n - tail_cnt + 5]);
        let pvc_sc = clean_col(cols[n - tail_cnt + 6]);
        let containers_raw = clean_col(cols[n - tail_cnt + 7]);
        let ports_raw = clean_col(cols[n - tail_cnt + 8]);
        let svc_ports_raw = clean_col(cols[n - tail_cnt + 9]);
        let (owner_kind, owner_name, qos) = if has_owner_cols {
            (clean_col(cols[n - 4]).to_owned(), clean_col(cols[n - 3]).to_owned(), clean_col(cols[n - 2]).to_owned())
        } else {
            (String::new(), String::new(), String::new())
        };
        let age = clean_col(cols[n - 1]).to_owned();

        let containers: Vec<String> = if containers_raw.is_empty() {
            Vec::new()
        } else {
            containers_raw.split(',').filter(|s| !s.is_empty()).map(str::to_owned).collect()
        };
        let mut ports: Vec<String> = if !ports_raw.is_empty() {
            ports_raw.split(',').filter(|s| !s.is_empty()).map(str::to_owned).collect()
        } else if !svc_ports_raw.is_empty() {
            svc_ports_raw.split(',').filter(|s| !s.is_empty()).map(str::to_owned).collect()
        } else {
            Vec::new()
        };
        ports.dedup();

        let mut status = "Active".to_owned();
        let mut ready = String::new();
        let mut detail = String::new();
        let mut restarts = 0u64;

        match kind.as_str() {
            "Pod" => {
                status = if phase.is_empty() { "Unknown".into() } else { phase.to_owned() };
                if !ready_list.is_empty() {
                    let parts: Vec<&str> = ready_list.split(',').collect();
                    let rdy_cnt = parts.iter().filter(|&&b| b == "true").count();
                    ready = format!("{rdy_cnt}/{}", parts.len());
                } else {
                    ready = format!("0/{}", containers.len());
                }
                restarts = restarts_list.split(',').filter_map(|s| s.parse::<u64>().ok()).sum();
                detail = match (node.is_empty(), pod_ip.is_empty()) {
                    (false, false) => format!("restarts: {restarts} • {pod_ip} on {node}"),
                    (false, true) => format!("restarts: {restarts} • {node}"),
                    _ => format!("restarts: {restarts}"),
                };
            }
            "Deployment" | "StatefulSet" | "ReplicaSet" => {
                let desired = spec_rep.parse::<u64>().unwrap_or(1);
                let rdy = ready_rep.parse::<u64>().unwrap_or(0);
                ready = format!("{rdy}/{desired}");
                status = if rdy == desired {
                    "Ready".into()
                } else if rdy > 0 {
                    "Progressing".into()
                } else {
                    "Scaling".into()
                };
                detail = format!("replicas: {rdy}/{desired}");
            }
            "DaemonSet" => {
                let desired = ds_desired.parse::<u64>().unwrap_or(0);
                let rdy = ds_ready.parse::<u64>().unwrap_or(0);
                ready = format!("{rdy}/{desired}");
                status = if rdy == desired { "Ready".into() } else { "Degraded".into() };
                detail = format!("pods: {rdy}/{desired}");
            }
            "Job" => {
                let comp = job_comp.parse::<u64>().unwrap_or(1);
                let succ = job_succ.parse::<u64>().unwrap_or(0);
                ready = format!("{succ}/{comp}");
                status = if succ >= comp { "Complete".into() } else { "Running".into() };
            }
            "CronJob" => {
                status = if suspend == "true" { "Suspended".into() } else { "Scheduled".into() };
                ready = schedule.to_owned();
                detail = if schedule.is_empty() { String::new() } else { format!("schedule: {schedule}") };
            }
            "Service" => {
                status = if svc_type.is_empty() { "ClusterIP".into() } else { svc_type.to_owned() };
                ready = ports.join(", ");
                detail = if cluster_ip.is_empty() { String::new() } else { format!("ClusterIP: {cluster_ip}") };
            }
            "Ingress" => {
                status = if ing_class.is_empty() { "Ingress".into() } else { format!("Class: {ing_class}") };
                detail = if ing_hosts.is_empty() { "*".into() } else { ing_hosts.to_owned() };
            }
            "ConfigMap" => {
                status = "ConfigMap".into();
            }
            "PersistentVolumeClaim" => {
                status = if phase.is_empty() { "Bound".into() } else { phase.to_owned() };
                ready = pvc_cap.to_owned();
                detail = if pvc_sc.is_empty() { String::new() } else { format!("storageClass: {pvc_sc}") };
            }
            _ => {}
        }

        out.push(ClusterResource {
            kind,
            name,
            namespace,
            status,
            ready,
            age,
            detail,
            containers,
            ports,
            restarts,
            controlled_by_kind: owner_kind,
            controlled_by_name: owner_name,
            pod_ip: if !pod_ip.is_empty() { pod_ip.to_owned() } else { cluster_ip.to_owned() },
            node_name: if !node.is_empty() { node.to_owned() } else { pvc_sc.to_owned() },
            qos,
            ..Default::default()
        });
        if out.len() >= 2_500 {
            break;
        }
    }
    out
}

/// Fetches `Namespace` rows using fast Server-Side Table output (`kubectl get namespaces --no-headers`).
pub fn fetch_namespaces_into_snapshot(project: &Project, cfg: &KubeConfigState, snap: &mut ClusterSnapshot) {
    let mut ns_args = cfg.base_args(false);
    ns_args.extend(["get".into(), "namespaces".into(), "--no-headers".into()]);
    if let Ok(out) = run_kubectl(project, &ns_args, None)
        && out.status == Some(0)
    {
        snap.resources.retain(|r| r.kind != "Namespace");
        let mut names = Vec::new();
        for line in out.stdout.lines() {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if let Some(&name) = cols.first() {
                let status = cols.get(1).copied().unwrap_or("Active");
                let age = cols.get(2).copied().unwrap_or("");
                names.push(name.to_owned());
                snap.resources.push(ClusterResource {
                    kind: "Namespace".into(),
                    name: name.to_owned(),
                    status: status.to_owned(),
                    age: age.to_owned(),
                    ..Default::default()
                });
            }
        }
        if !names.is_empty() {
            names.sort();
            snap.namespaces = names;
        }
    }
}

const NODE_COLUMNS_SPEC: &str = "custom-columns=NAME:.metadata.name,TAINTS:.spec.taints[*].key,UNSCHED:.spec.unschedulable,VERSION:.status.nodeInfo.kubeletVersion,KERNEL:.status.nodeInfo.kernelVersion,IP:.status.addresses[?(@.type==\"InternalIP\")].address,ALLOC_CPU:.status.allocatable.cpu,ALLOC_MEM:.status.allocatable.memory,COND_TYPES:.status.conditions[*].type,COND_STATUS:.status.conditions[*].status,INSTANCE:.metadata.labels.node\\.kubernetes\\.io/instance-type,POOL:.metadata.labels.kubernetes\\.azure\\.com/agentpool,AGE:.metadata.creationTimestamp";

fn parse_kube_cores(raw: &str) -> f64 {
    let s = clean_col(raw.trim());
    if s.is_empty() {
        return 0.0;
    }
    if let Some(m) = s.strip_suffix('m') {
        m.parse::<f64>().unwrap_or(0.0) / 1000.0
    } else if let Some(n) = s.strip_suffix('n') {
        n.parse::<f64>().unwrap_or(0.0) / 1_000_000_000.0
    } else {
        s.parse::<f64>().unwrap_or(0.0)
    }
}

fn parse_kube_gi(raw: &str) -> f64 {
    let s = clean_col(raw.trim());
    if s.is_empty() {
        return 0.0;
    }
    if let Some(ki) = s.strip_suffix("Ki") {
        ki.parse::<f64>().unwrap_or(0.0) / (1024.0 * 1024.0)
    } else if let Some(mi) = s.strip_suffix("Mi") {
        mi.parse::<f64>().unwrap_or(0.0) / 1024.0
    } else if let Some(gi) = s.strip_suffix("Gi") {
        gi.parse::<f64>().unwrap_or(0.0)
    } else if let Some(ti) = s.strip_suffix("Ti") {
        ti.parse::<f64>().unwrap_or(0.0) * 1024.0
    } else {
        s.parse::<f64>().unwrap_or(0.0) / (1024.0 * 1024.0 * 1024.0)
    }
}

/// Fetches `Node` rows on demand using Server-Side custom-columns output + `kubectl top nodes`,
/// avoiding downloading megabytes of full Node `.status.images` JSON over the network.
pub fn fetch_nodes_into_snapshot(project: &Project, cfg: &KubeConfigState, snap: &mut ClusterSnapshot) {
    let mut top_map: BTreeMap<String, (f64, f64)> = BTreeMap::new();
    let mut top_args = cfg.base_args(false);
    top_args.extend(["top".into(), "nodes".into(), "--no-headers".into()]);
    if let Ok(top_out) = run_kubectl(project, &top_args, None)
        && top_out.status == Some(0)
    {
        for line in top_out.stdout.lines() {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() >= 4 {
                let nname = cols[0].to_owned();
                let u_cpu = parse_kube_cores(cols[1]);
                let u_mem = parse_kube_gi(cols[3]);
                top_map.insert(nname, (u_cpu, u_mem));
            }
        }
    }

    let mut node_args = cfg.base_args(false);
    node_args.extend(["get".into(), "nodes".into(), "-o".into(), NODE_COLUMNS_SPEC.into(), "--no-headers".into()]);
    if let Ok(out) = run_kubectl(project, &node_args, None)
        && out.status == Some(0)
    {
        snap.resources.retain(|r| r.kind != "Node");
        if out.stdout.trim_start().starts_with('{') {
            snap.resources.extend(parse_resource_list_json(&out.stdout));
        } else {
            for line in out.stdout.lines() {
                let cols: Vec<&str> = line.split_whitespace().collect();
                if cols.len() >= 13 {
                    let name = cols[0];
                    let taints_raw = clean_col(cols[1]);
                    let unsched = clean_col(cols[2]);
                    let version = clean_col(cols[3]);
                    let kernel = clean_col(cols[4]);
                    let internal_ip = clean_col(cols[5]);
                    let alloc_cpu = parse_kube_cores(cols[6]);
                    let alloc_mem = parse_kube_gi(cols[7]);
                    let cond_types: Vec<&str> = clean_col(cols[8]).split(',').filter(|s| !s.is_empty()).collect();
                    let cond_stats: Vec<&str> = clean_col(cols[9]).split(',').filter(|s| !s.is_empty()).collect();
                    let instance_type = clean_col(cols[10]);
                    let node_group = clean_col(cols[11]);
                    let age = clean_col(cols[12]);

                    let taints_list: Vec<String> = if taints_raw.is_empty() {
                        Vec::new()
                    } else {
                        taints_raw.split(',').filter(|s| !s.is_empty()).map(str::to_owned).collect()
                    };
                    let taints_cnt = taints_list.len() as u64;
                    let schedulable = if unsched == "true" { "False" } else { "True" };

                    let mut active_conds: Vec<String> = Vec::new();
                    for (ct, cs) in cond_types.iter().zip(cond_stats.iter()) {
                        if *cs == "True" {
                            active_conds.push((*ct).to_owned());
                        }
                    }
                    if active_conds.is_empty() {
                        active_conds.push("NotReady".into());
                    }
                    if unsched == "true" && !active_conds.iter().any(|c| c == "SchedulingDisabled") {
                        active_conds.push("SchedulingDisabled".into());
                    }
                    let status = active_conds.join(", ");

                    let (u_cpu, u_mem) = top_map.get(name).copied().unwrap_or((0.0, 0.0));
                    let cpu_str = if alloc_cpu > 0.0 { format!("{u_cpu:.2}/{alloc_cpu:.2}") } else { String::new() };
                    let mem_str =
                        if alloc_mem > 0.0 { format!("{u_mem:.1}Gi/{alloc_mem:.1}Gi") } else { String::new() };

                    snap.resources.push(ClusterResource {
                        kind: "Node".into(),
                        name: name.to_owned(),
                        status,
                        ready: version.to_owned(),
                        age: age.to_owned(),
                        detail: internal_ip.to_owned(),
                        containers: taints_list,
                        cpu: cpu_str,
                        memory: mem_str,
                        restarts: taints_cnt,
                        controlled_by_kind: instance_type.to_owned(),
                        controlled_by_name: node_group.to_owned(),
                        pod_ip: internal_ip.to_owned(),
                        host_ip: String::new(),
                        node_name: kernel.to_owned(),
                        qos: schedulable.to_owned(),
                        ..Default::default()
                    });
                } else if let Some(&name) = cols.first() {
                    let status = cols.get(1).copied().unwrap_or("Ready");
                    let roles = cols.get(2).copied().map(clean_col).unwrap_or("");
                    let age = cols.get(3).copied().map(clean_col).unwrap_or("");
                    let version = cols.get(4).copied().map(clean_col).unwrap_or("");
                    let internal_ip = cols.get(5).copied().map(clean_col).unwrap_or("");
                    let schedulable = if status.contains("SchedulingDisabled") { "False" } else { "True" };
                    snap.resources.push(ClusterResource {
                        kind: "Node".into(),
                        name: name.to_owned(),
                        status: status.to_owned(),
                        ready: version.to_owned(),
                        age: age.to_owned(),
                        detail: internal_ip.to_owned(),
                        pod_ip: internal_ip.to_owned(),
                        host_ip: if roles == "agent" { String::new() } else { roles.to_owned() },
                        qos: schedulable.to_owned(),
                        ..Default::default()
                    });
                }
            }
        }
    }
}

const CRD_COLUMNS_SPEC: &str = "custom-columns=NAME:.metadata.name,GROUP:.spec.group,KIND:.spec.names.kind,SCOPE:.spec.scope,VERSION:.spec.versions[0].name,AGE:.metadata.creationTimestamp";

const CR_INSTANCE_COLUMNS_SPEC: &str =
    "custom-columns=KIND:.kind,NS:.metadata.namespace,NAME:.metadata.name,AGE:.metadata.creationTimestamp";

/// Parses `CR_INSTANCE_COLUMNS_SPEC` lines into `ClusterResource` items for a given CRD name.
pub fn parse_cr_instance_lines(text: &str, crd_name: &str) -> Vec<ClusterResource> {
    let mut out = Vec::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() >= 4 {
            let cr_kind = clean_col(cols[0]);
            let ns = clean_col(cols[1]);
            let name = cols[2];
            let age = clean_col(cols[3]);
            out.push(ClusterResource {
                kind: format!("CR:{crd_name}"),
                name: name.to_owned(),
                namespace: ns.to_owned(),
                status: "Active".into(),
                ready: cr_kind.to_owned(),
                age: age.to_owned(),
                detail: crd_name.to_owned(),
                controlled_by_kind: cr_kind.to_owned(),
                controlled_by_name: crd_name.to_owned(),
                ..Default::default()
            });
        }
    }
    out
}

/// Fetches `CustomResourceDefinition` rows on demand using Server-Side custom-columns output,
/// avoiding downloading megabytes of OpenAPI v3 validation schemas.
pub fn fetch_crds_into_snapshot(project: &Project, cfg: &KubeConfigState, snap: &mut ClusterSnapshot) {
    let mut crd_args = cfg.base_args(false);
    crd_args.extend(["get".into(), "crd".into(), "-o".into(), CRD_COLUMNS_SPEC.into(), "--no-headers".into()]);
    if let Ok(out) = run_kubectl(project, &crd_args, None)
        && out.status == Some(0)
    {
        snap.resources.retain(|r| r.kind != "CustomResourceDefinition");
        for line in out.stdout.lines() {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() >= 6 {
                snap.resources.push(ClusterResource {
                    kind: "CustomResourceDefinition".into(),
                    name: cols[0].to_owned(),
                    detail: clean_col(cols[1]).to_owned(),
                    controlled_by_kind: clean_col(cols[2]).to_owned(),
                    status: clean_col(cols[3]).to_owned(),
                    ready: clean_col(cols[4]).to_owned(),
                    age: clean_col(cols[5]).to_owned(),
                    ..Default::default()
                });
            } else if cols.len() >= 4 {
                snap.resources.push(ClusterResource {
                    kind: "CustomResourceDefinition".into(),
                    name: cols[0].to_owned(),
                    status: cols[3].to_owned(),
                    ready: cols[2].to_owned(),
                    age: cols.get(4).copied().unwrap_or("").to_owned(),
                    detail: cols[1].to_owned(),
                    ..Default::default()
                });
            } else if let Some(&name) = cols.first() {
                let group = name.split_once('.').map(|(_, g)| g).unwrap_or("");
                let age = cols.get(1).copied().unwrap_or("");
                snap.resources.push(ClusterResource {
                    kind: "CustomResourceDefinition".into(),
                    name: name.to_owned(),
                    status: "Namespaced".into(),
                    ready: "v1".into(),
                    age: age.to_owned(),
                    detail: group.to_owned(),
                    ..Default::default()
                });
            }
        }
    }
}

/// Fetches `Secret` rows using Server-Side Table output (`kubectl get secrets --no-headers`),
/// avoiding downloading `.data` payloads over the network.
pub fn fetch_secrets_into_snapshot(project: &Project, cfg: &KubeConfigState, snap: &mut ClusterSnapshot) {
    let mut sec_args = cfg.base_args(true);
    sec_args.extend(["get".into(), "secrets".into()]);
    cfg.push_scope_flags(&mut sec_args);
    sec_args.push("--no-headers".into());
    if let Ok(out) = run_kubectl(project, &sec_args, None)
        && out.status == Some(0)
    {
        snap.resources.retain(|r| r.kind != "Secret");
        for line in out.stdout.lines() {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() >= 5 {
                let ns = clean_col(cols[0]);
                let name = cols[1];
                let sec_type = cols[2];
                let data_cnt = cols[3];
                let age = cols[4];
                snap.resources.push(ClusterResource {
                    kind: "Secret".into(),
                    name: name.to_owned(),
                    namespace: ns.to_owned(),
                    status: sec_type.to_owned(),
                    ready: format!("{data_cnt} keys"),
                    age: age.to_owned(),
                    detail: format!("type: {sec_type}"),
                    ..Default::default()
                });
            } else if cols.len() == 4 {
                if cols[2].chars().all(|c| c.is_ascii_digit()) {
                    let name = cols[0];
                    let sec_type = cols[1];
                    let data_cnt = cols[2];
                    let age = cols[3];
                    snap.resources.push(ClusterResource {
                        kind: "Secret".into(),
                        name: name.to_owned(),
                        namespace: cfg.namespace.clone(),
                        status: sec_type.to_owned(),
                        ready: format!("{data_cnt} keys"),
                        age: age.to_owned(),
                        detail: format!("type: {sec_type}"),
                        ..Default::default()
                    });
                } else {
                    let ns = clean_col(cols[0]);
                    let name = cols[1];
                    let sec_type = cols[2];
                    let age = cols[3];
                    snap.resources.push(ClusterResource {
                        kind: "Secret".into(),
                        name: name.to_owned(),
                        namespace: ns.to_owned(),
                        status: sec_type.to_owned(),
                        ready: "Secret".into(),
                        age: age.to_owned(),
                        detail: format!("type: {sec_type}"),
                        ..Default::default()
                    });
                }
            }
        }
    }
}

/// Fetches cluster `Event` items on demand.
pub fn fetch_events_into_snapshot(project: &Project, cfg: &KubeConfigState, snap: &mut ClusterSnapshot) {
    let mut ev_args = cfg.base_args(true);
    ev_args.extend(["get".into(), "events".into()]);
    cfg.push_scope_flags(&mut ev_args);
    ev_args.extend(["-o".into(), "json".into()]);
    if let Ok(out) = run_kubectl(project, &ev_args, None)
        && out.status == Some(0)
    {
        snap.events = parse_events_json(&out.stdout);
    }
}

/// Fetches `HelmRelease` items on demand.
pub fn fetch_helm_into_snapshot(project: &Project, cfg: &KubeConfigState, snap: &mut ClusterSnapshot) {
    let mut helm_args = Vec::new();
    if !cfg.kubeconfig.trim().is_empty() {
        helm_args.push(format!("--kubeconfig={}", cfg.kubeconfig.trim()));
    }
    if !cfg.context.trim().is_empty() {
        helm_args.push(format!("--kube-context={}", cfg.context.trim()));
    }
    if cfg.all_namespaces {
        helm_args.push("-A".into());
    } else if !cfg.namespace.trim().is_empty() {
        helm_args.push("-n".into());
        helm_args.push(cfg.namespace.trim().to_owned());
    }
    helm_args.extend(["list".into(), "-o".into(), "json".into()]);
    if let Ok(out) = project.run_process("helm", &helm_args, None)
        && out.status == Some(0)
    {
        snap.helm_releases = parse_helm_releases_json(&out.stdout);
    }
}

fn format_pod_memory_aligned(raw: &str) -> String {
    let s = raw.trim();
    if let Some(mi) = s.strip_suffix("Mi").and_then(|v| v.parse::<f64>().ok()) {
        if mi >= 1024.0 { format!("{:.1}Gi", mi / 1024.0) } else { format!("{mi:.1}Mi") }
    } else if let Some(ki) = s.strip_suffix("Ki").and_then(|v| v.parse::<f64>().ok()) {
        if ki >= 1024.0 * 1024.0 {
            format!("{:.1}Gi", ki / (1024.0 * 1024.0))
        } else if ki >= 1024.0 {
            format!("{:.1}Mi", ki / 1024.0)
        } else {
            format!("{ki:.1}Ki")
        }
    } else if let Some(gi) = s.strip_suffix("Gi").and_then(|v| v.parse::<f64>().ok()) {
        format!("{gi:.1}Gi")
    } else {
        s.to_owned()
    }
}

/// Enriches `Pod` entries in `snap.resources` with live CPU & Memory from `kubectl top pods --no-headers` when available.
pub fn enrich_pod_metrics(project: &Project, cfg: &KubeConfigState, snap: &mut ClusterSnapshot) {
    let pod_cnt = snap.resources.iter().filter(|r| r.kind == "Pod").count();
    if pod_cnt == 0 || pod_cnt >= 2_500 {
        return;
    }
    let mut args = cfg.base_args(true);
    args.extend(["top".into(), "pods".into()]);
    cfg.push_scope_flags(&mut args);
    args.push("--no-headers".into());
    let Ok(out) = run_kubectl(project, &args, None) else {
        return;
    };
    if out.status != Some(0) {
        return;
    }
    let mut ns_metrics: BTreeMap<(String, String), (String, String)> = BTreeMap::new();
    let mut single_metrics: BTreeMap<String, (String, String)> = BTreeMap::new();
    for line in out.stdout.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() >= 4 {
            let ns = cols[0].to_owned();
            let name = cols[1].to_owned();
            let raw_cpu = cols[2];
            let cpu = if let Some(m) = raw_cpu.strip_suffix('m').and_then(|v| v.parse::<f64>().ok()) {
                format!("{:.3}", m / 1000.0)
            } else {
                raw_cpu.to_owned()
            };
            let mem = format_pod_memory_aligned(cols[3]);
            ns_metrics.insert((ns, name), (cpu, mem));
        } else if cols.len() == 3 {
            let name = cols[0].to_owned();
            let raw_cpu = cols[1];
            let cpu = if let Some(m) = raw_cpu.strip_suffix('m').and_then(|v| v.parse::<f64>().ok()) {
                format!("{:.3}", m / 1000.0)
            } else {
                raw_cpu.to_owned()
            };
            let mem = format_pod_memory_aligned(cols[2]);
            single_metrics.insert(name, (cpu, mem));
        }
    }
    for r in snap.resources.iter_mut().filter(|r| r.kind == "Pod") {
        if let Some((cpu, mem)) =
            ns_metrics.get(&(r.namespace.clone(), r.name.clone())).or_else(|| single_metrics.get(&r.name))
        {
            r.cpu = cpu.clone();
            r.memory = mem.clone();
        }
    }
}

/// Fetches the 10 namespaced workload/network/config resource kinds into `snap`.
pub fn fetch_workloads_into_snapshot(project: &Project, cfg: &KubeConfigState, snap: &mut ClusterSnapshot) {
    let mut res_args = cfg.base_args(true);
    res_args.extend([
        "get".into(),
        "pods,deployments,statefulsets,daemonsets,replicasets,jobs,cronjobs,services,ingresses,configmaps,pvc".into(),
    ]);
    cfg.push_scope_flags(&mut res_args);
    if cfg.all_namespaces {
        res_args.extend(["-o".into(), CUSTOM_COLUMNS_SPEC.into(), "--no-headers".into()]);
    } else {
        res_args.extend(["-o".into(), "json".into()]);
    }
    match run_kubectl(project, &res_args, None) {
        Ok(out) if out.status == Some(0) => {
            snap.connected = true;
            snap.error = None;
            snap.resources
                .retain(|r| matches!(r.kind.as_str(), "Namespace" | "Node" | "CustomResourceDefinition" | "Secret"));
            if out.stdout.trim_start().starts_with('{') {
                snap.resources.extend(parse_resource_list_json(&out.stdout));
            } else {
                snap.resources.extend(parse_custom_columns_resources(&out.stdout));
            }
            enrich_pod_metrics(project, cfg, snap);
        }
        Ok(out) => {
            snap.error = Some(first_line_or(&out.stderr, "kubectl get resources failed"));
        }
        Err(e) => {
            snap.error = Some(e.to_string());
        }
    }
}

/// Maps a Kubernetes resource `Kind` to `(kubectl_plural_name, is_cluster_scoped, prefer_json_in_all_ns)`.
pub fn kubectl_resource_info(kind: &str) -> (&'static str, bool, bool) {
    match kind {
        "Pod" => ("pods", false, false),
        "Deployment" => ("deployments", false, false),
        "StatefulSet" => ("statefulsets", false, false),
        "DaemonSet" => ("daemonsets", false, false),
        "ReplicaSet" => ("replicasets", false, false),
        "ReplicationController" => ("replicationcontrollers", false, false),
        "Job" => ("jobs", false, false),
        "CronJob" => ("cronjobs", false, false),
        "Service" => ("services", false, false),
        "Endpoints" => ("endpoints", false, false),
        "EndpointSlice" => ("endpointslices", false, false),
        "Ingress" => ("ingresses", false, true),
        "IngressClass" => ("ingressclasses", true, true),
        "NetworkPolicy" => ("networkpolicies", false, true),
        "ConfigMap" => ("configmaps", false, false),
        "Secret" => ("secrets", false, false),
        "ResourceQuota" => ("resourcequotas", false, true),
        "LimitRange" => ("limitranges", false, true),
        "HorizontalPodAutoscaler" => ("horizontalpodautoscalers", false, true),
        "PodDisruptionBudget" => ("poddisruptionbudgets", false, true),
        "PriorityClass" => ("priorityclasses", true, true),
        "RuntimeClass" => ("runtimeclasses", true, true),
        "Lease" => ("leases", false, false),
        "MutatingWebhookConfiguration" => ("mutatingwebhookconfigurations", true, true),
        "ValidatingWebhookConfiguration" => ("validatingwebhookconfigurations", true, true),
        "PersistentVolumeClaim" => ("pvc", false, false),
        "PersistentVolume" => ("pv", true, true),
        "StorageClass" => ("storageclasses", true, true),
        "Namespace" => ("namespaces", true, false),
        "Node" => ("nodes", true, false),
        "Event" => ("events", false, false),
        "ServiceAccount" => ("serviceaccounts", false, false),
        "ClusterRole" => ("clusterroles", true, true),
        "Role" => ("roles", false, false),
        "ClusterRoleBinding" => ("clusterrolebindings", true, true),
        "RoleBinding" => ("rolebindings", false, true),
        "CustomResourceDefinition" => ("crd", true, false),
        _ => ("pods", false, false),
    }
}

/// Fetches a single category on demand (used for instant ~200ms hotbar context switching and lazy sidebar tabs).
pub fn fetch_category_into_snapshot(
    project: &Project,
    cfg: &KubeConfigState,
    snap: &mut ClusterSnapshot,
    category: &str,
) {
    match category {
        "Namespace" => fetch_namespaces_into_snapshot(project, cfg, snap),
        "Node" => fetch_nodes_into_snapshot(project, cfg, snap),
        "CustomResourceDefinition" => fetch_crds_into_snapshot(project, cfg, snap),
        "Secret" => fetch_secrets_into_snapshot(project, cfg, snap),
        "Event" => fetch_events_into_snapshot(project, cfg, snap),
        "HelmRelease" => fetch_helm_into_snapshot(project, cfg, snap),
        "ClusterOverview" | "WorkloadsOverview" => {
            fetch_workloads_into_snapshot(project, cfg, snap);
            fetch_secrets_into_snapshot(project, cfg, snap);
        }
        "ClusterCatalog" | "Workspace" => {}
        kind if kind.starts_with("CR:") => {
            let crd_name = kind.strip_prefix("CR:").unwrap_or(kind);
            if !snap.resources.iter().any(|r| r.kind == "CustomResourceDefinition") {
                fetch_crds_into_snapshot(project, cfg, snap);
            }
            let is_cluster_scoped = snap
                .resources
                .iter()
                .find(|r| r.kind == "CustomResourceDefinition" && r.name == crd_name)
                .is_some_and(|r| r.status.eq_ignore_ascii_case("Cluster"));
            let mut cr_args = cfg.base_args(!is_cluster_scoped);
            cr_args.extend(["get".into(), crd_name.to_owned()]);
            if !is_cluster_scoped {
                cfg.push_scope_flags(&mut cr_args);
            }
            cr_args.extend(["-o".into(), CR_INSTANCE_COLUMNS_SPEC.into(), "--no-headers".into()]);
            if let Ok(out) = run_kubectl(project, &cr_args, None)
                && out.status == Some(0)
            {
                snap.connected = true;
                snap.error = None;
                snap.resources.retain(|r| r.kind != kind);
                snap.resources.extend(parse_cr_instance_lines(&out.stdout, crd_name));
            }
        }
        kind => {
            let (kubectl_type, cluster_scoped, prefer_json_in_all_ns) = kubectl_resource_info(kind);
            let mut res_args = cfg.base_args(!cluster_scoped);
            res_args.extend(["get".into(), kubectl_type.into()]);
            if !cluster_scoped {
                cfg.push_scope_flags(&mut res_args);
            }
            if cfg.all_namespaces && !cluster_scoped && !prefer_json_in_all_ns {
                res_args.extend(["-o".into(), CUSTOM_COLUMNS_SPEC.into(), "--no-headers".into()]);
            } else {
                res_args.extend(["-o".into(), "json".into()]);
            }
            match run_kubectl(project, &res_args, None) {
                Ok(out) if out.status == Some(0) => {
                    snap.connected = true;
                    snap.error = None;
                    snap.resources.retain(|r| r.kind != kind);
                    if out.stdout.trim_start().starts_with('{') {
                        snap.resources.extend(parse_resource_list_json(&out.stdout));
                    } else {
                        snap.resources.extend(parse_custom_columns_resources(&out.stdout));
                    }
                    if kind == "Pod" {
                        enrich_pod_metrics(project, cfg, snap);
                    }
                }
                Ok(out) => {
                    snap.error = Some(first_line_or(&out.stderr, "kubectl get resources failed"));
                }
                Err(e) => {
                    snap.error = Some(e.to_string());
                }
            }
        }
    }
}

/// Fetches a `ClusterSnapshot` using `kubectl`.
/// Heavy cluster-wide categories (`Node`, `CustomResourceDefinition`, `Event`, `HelmRelease`) are loaded on demand when selected.
pub fn fetch_cluster_snapshot(project: &Project, cfg: &mut KubeConfigState) -> ClusterSnapshot {
    let _task = host::begin_task("Kubernetes: Refreshing cluster", true);
    let mut snap = ClusterSnapshot {
        connected: false,
        error: None,
        current_context: cfg.context.clone(),
        contexts: Vec::new(),
        cluster_catalog: Vec::new(),
        current_namespace: cfg.namespace.clone(),
        all_namespaces: cfg.all_namespaces,
        namespaces: vec!["default".into(), "kube-system".into()],
        resources: Vec::new(),
        events: Vec::new(),
        helm_releases: Vec::new(),
    };

    match fetch_kubeconfig_overview(project, cfg) {
        Ok((current_ctx, contexts, ctx_ns, catalog)) => {
            if cfg.context.is_empty() && !current_ctx.is_empty() {
                cfg.context = current_ctx.clone();
            }
            if cfg.namespace == "default"
                && let Some(ns) = ctx_ns
                && !ns.is_empty()
            {
                cfg.namespace = ns.clone();
                let _ = storage::set("namespace", &ns);
            }
            snap.current_context = if cfg.context.is_empty() { current_ctx } else { cfg.context.clone() };
            snap.contexts = contexts;
            snap.cluster_catalog = catalog;
            snap.current_namespace = cfg.namespace.clone();
        }
        Err(e) => {
            snap.error = Some(e.to_string());
            return snap;
        }
    }

    if snap.current_context.is_empty() {
        snap.error = Some("No Kubernetes contexts found in kubeconfig (~/.kube/config)".into());
        return snap;
    }

    fetch_namespaces_into_snapshot(project, cfg, &mut snap);
    // On massive shared clusters (>150 namespaces, e.g. 950+ user namespaces), `--all-namespaces`
    // paginates across 25,000+ pods and hits the 30s host process timeout; scope to the active namespace.
    if cfg.all_namespaces && snap.namespaces.len() > 150 {
        cfg.all_namespaces = false;
        snap.all_namespaces = false;
        let _ = storage::set("allNamespaces", "false");
    }
    fetch_workloads_into_snapshot(project, cfg, &mut snap);
    fetch_secrets_into_snapshot(project, cfg, &mut snap);

    snap
}

/// Fetches Pod logs (`kubectl logs`).
pub fn fetch_pod_logs(
    project: &Project,
    cfg: &KubeConfigState,
    namespace: &str,
    pod: &str,
    container: Option<&str>,
    previous: bool,
) -> Result<String, Error> {
    let mut args = cfg.target_args(Some(namespace));
    args.push("logs".into());
    args.push(pod.to_owned());
    if let Some(c) = container.filter(|c| !c.is_empty()) {
        args.push("-c".into());
        args.push(c.to_owned());
    }
    if previous {
        args.push("--previous".into());
    }
    args.push(format!("--tail={}", cfg.tail_lines));
    args.push("--timestamps=true".into());
    let out = run_kubectl(project, &args, None)?;
    if out.status != Some(0) {
        return Err(Error::Failed(first_line_or(&out.stderr, "kubectl logs failed")));
    }
    Ok(out.stdout)
}

/// Runs `kubectl describe <kind> <name>` or `kubectl get <kind> <name> -o yaml`.
pub fn inspect_cluster_resource(
    project: &Project,
    cfg: &KubeConfigState,
    kind: &str,
    namespace: &str,
    name: &str,
    as_yaml: bool,
) -> Result<String, Error> {
    let target_type = kind.strip_prefix("CR:").unwrap_or(kind).to_ascii_lowercase();
    let (_, cluster_scoped, _) =
        if kind.starts_with("CR:") { ("cr", namespace.is_empty(), false) } else { kubectl_resource_info(kind) };
    let mut args =
        if cluster_scoped || namespace.is_empty() { cfg.base_args(false) } else { cfg.target_args(Some(namespace)) };
    if as_yaml {
        args.extend(["get".into(), target_type, name.to_owned(), "-o".into(), "yaml".into()]);
    } else {
        args.extend(["describe".into(), target_type, name.to_owned()]);
    }
    let out = run_kubectl(project, &args, None)?;
    if out.status != Some(0) {
        return Err(Error::Failed(first_line_or(&out.stderr, "kubectl resource query failed")));
    }
    Ok(out.stdout)
}

/// Runs `kubectl get <kind> <name> -o json` to populate the Freelens structured Detail Drawer.
pub fn inspect_cluster_resource_json(
    project: &Project,
    cfg: &KubeConfigState,
    kind: &str,
    namespace: &str,
    name: &str,
) -> Result<String, Error> {
    let target_type = kind.strip_prefix("CR:").unwrap_or(kind).to_ascii_lowercase();
    let (_, cluster_scoped, _) =
        if kind.starts_with("CR:") { ("cr", namespace.is_empty(), false) } else { kubectl_resource_info(kind) };
    let mut args =
        if cluster_scoped || namespace.is_empty() { cfg.base_args(false) } else { cfg.target_args(Some(namespace)) };
    args.extend(["get".into(), target_type, name.to_owned(), "-o".into(), "json".into()]);
    let out = run_kubectl(project, &args, None)?;
    if out.status != Some(0) {
        return Err(Error::Failed(first_line_or(&out.stderr, "kubectl get resource json failed")));
    }
    Ok(out.stdout)
}

/// Fetches related pods (with CPU/Memory metrics), related child resources, and involved events for the Drawer.
pub fn fetch_resource_extras(
    project: &Project,
    cfg: &KubeConfigState,
    kind: &str,
    namespace: &str,
    name: &str,
    raw_json: &str,
) -> Value {
    let mut related_pods: Vec<ClusterResource> = Vec::new();
    let mut related_resources: Vec<ClusterResource> = Vec::new();
    let mut events: Vec<ClusterEvent> = Vec::new();

    if kind == "Node" {
        let mut p_args = cfg.base_args(false);
        p_args.extend([
            "get".into(),
            "pods".into(),
            "-A".into(),
            "--field-selector".into(),
            format!("spec.nodeName={name}"),
            "-o".into(),
            CUSTOM_COLUMNS_SPEC.into(),
            "--no-headers".into(),
        ]);
        if let Ok(out) = run_kubectl(project, &p_args, None)
            && out.status == Some(0)
        {
            related_pods = parse_custom_columns_resources(&out.stdout);
        }
        if !related_pods.is_empty() {
            let mut t_args = cfg.base_args(false);
            t_args.extend([
                "top".into(),
                "pods".into(),
                "-A".into(),
                "--field-selector".into(),
                format!("spec.nodeName={name}"),
                "--no-headers".into(),
            ]);
            if let Ok(out) = run_kubectl(project, &t_args, None)
                && out.status == Some(0)
            {
                let mut metrics: BTreeMap<(String, String), (String, String)> = BTreeMap::new();
                for line in out.stdout.lines() {
                    let cols: Vec<&str> = line.split_whitespace().collect();
                    if cols.len() >= 4 {
                        let ns = cols[0].to_owned();
                        let pname = cols[1].to_owned();
                        let raw_cpu = cols[2];
                        let cpu = if let Some(m) = raw_cpu.strip_suffix('m').and_then(|v| v.parse::<f64>().ok()) {
                            format!("{:.3}", m / 1000.0)
                        } else {
                            raw_cpu.to_owned()
                        };
                        metrics.insert((ns, pname), (cpu, cols[3].to_owned()));
                    }
                }
                for pod in &mut related_pods {
                    if let Some((cpu, mem)) = metrics.get(&(pod.namespace.clone(), pod.name.clone())) {
                        pod.cpu = cpu.clone();
                        pod.memory = mem.clone();
                    }
                }
            }
        }
    } else if matches!(kind, "Deployment" | "DaemonSet" | "StatefulSet" | "ReplicaSet" | "Job") && !namespace.is_empty()
    {
        if let Ok(parsed) = serde_json::from_str::<Value>(raw_json) {
            let selector = parsed
                .pointer("/spec/selector/matchLabels")
                .and_then(Value::as_object)
                .map(|m| {
                    m.iter().filter_map(|(k, v)| v.as_str().map(|vs| format!("{k}={vs}"))).collect::<Vec<_>>().join(",")
                })
                .unwrap_or_default();
            if !selector.is_empty() {
                let mut p_args = cfg.target_args(Some(namespace));
                p_args.extend(["get".into(), "pods".into(), "-l".into(), selector.clone(), "-o".into(), "json".into()]);
                if let Ok(out) = run_kubectl(project, &p_args, None)
                    && out.status == Some(0)
                {
                    let all_pods = parse_resource_list_json(&out.stdout);
                    if matches!(kind, "ReplicaSet" | "Job") {
                        let owned: Vec<ClusterResource> =
                            all_pods.iter().filter(|p| p.controlled_by_name == name).cloned().collect();
                        related_pods = if owned.is_empty() { all_pods } else { owned };
                    } else {
                        related_pods = all_pods;
                    }
                }
                if !related_pods.is_empty() {
                    let mut t_args = cfg.target_args(Some(namespace));
                    t_args.extend(["top".into(), "pods".into(), "-l".into(), selector.clone(), "--no-headers".into()]);
                    if let Ok(out) = run_kubectl(project, &t_args, None)
                        && out.status == Some(0)
                    {
                        let mut metrics: BTreeMap<String, (String, String)> = BTreeMap::new();
                        for line in out.stdout.lines() {
                            let cols: Vec<&str> = line.split_whitespace().collect();
                            if cols.len() >= 3 {
                                let pname = cols[0].to_owned();
                                let raw_cpu = cols[1];
                                let cpu = if let Some(m) = raw_cpu.strip_suffix('m').and_then(|v| v.parse::<f64>().ok())
                                {
                                    format!("{:.3}", m / 1000.0)
                                } else {
                                    raw_cpu.to_owned()
                                };
                                metrics.insert(pname, (cpu, cols[2].to_owned()));
                            }
                        }
                        for pod in &mut related_pods {
                            if let Some((cpu, mem)) = metrics.get(&pod.name) {
                                pod.cpu = cpu.clone();
                                pod.memory = mem.clone();
                            }
                        }
                    }
                }
                if kind == "Deployment" {
                    let mut rs_args = cfg.target_args(Some(namespace));
                    rs_args.extend(["get".into(), "rs".into(), "-l".into(), selector, "-o".into(), "json".into()]);
                    if let Ok(out) = run_kubectl(project, &rs_args, None)
                        && out.status == Some(0)
                    {
                        let all_rs = parse_resource_list_json(&out.stdout);
                        let owned: Vec<ClusterResource> =
                            all_rs.iter().filter(|r| r.controlled_by_name == name).cloned().collect();
                        related_resources = if owned.is_empty() { all_rs } else { owned };
                    }
                }
            }
        }
    } else if kind == "CronJob" && !namespace.is_empty() {
        let mut j_args = cfg.target_args(Some(namespace));
        j_args.extend(["get".into(), "jobs".into(), "-o".into(), "json".into()]);
        if let Ok(out) = run_kubectl(project, &j_args, None)
            && out.status == Some(0)
        {
            related_resources =
                parse_resource_list_json(&out.stdout).into_iter().filter(|r| r.controlled_by_name == name).collect();
        }
    } else if kind == "StorageClass" {
        let mut pv_args = cfg.base_args(false);
        pv_args.extend(["get".into(), "pv".into(), "-o".into(), "json".into()]);
        if let Ok(out) = run_kubectl(project, &pv_args, None)
            && out.status == Some(0)
        {
            related_resources = parse_resource_list_json(&out.stdout)
                .into_iter()
                .filter(|r| r.detail.contains(&format!("storageClass: {name}")))
                .collect();
        }
    } else if kind == "Namespace" {
        let mut rq_args = cfg.target_args(Some(name));
        rq_args.extend(["get".into(), "resourcequotas,limitranges".into(), "-o".into(), "json".into()]);
        if let Ok(out) = run_kubectl(project, &rq_args, None)
            && out.status == Some(0)
        {
            related_resources = parse_resource_list_json(&out.stdout);
        }
    } else if kind == "CustomResourceDefinition" {
        let mut cr_args = cfg.base_args(false);
        cr_args.extend([
            "get".into(),
            name.to_owned(),
            "-A".into(),
            "-o".into(),
            CR_INSTANCE_COLUMNS_SPEC.into(),
            "--no-headers".into(),
        ]);
        if let Ok(out) = run_kubectl(project, &cr_args, None)
            && out.status == Some(0)
        {
            related_resources = parse_cr_instance_lines(&out.stdout, name);
        }
    }

    if kind != "Event" {
        let (_, cluster_scoped, _) = kubectl_resource_info(kind);
        let mut ev_args = if cluster_scoped || namespace.is_empty() {
            cfg.base_args(false)
        } else {
            cfg.target_args(Some(namespace))
        };
        ev_args.extend([
            "get".into(),
            "events".into(),
            "--field-selector".into(),
            format!("involvedObject.name={name},involvedObject.kind={kind}"),
            "-o".into(),
            "json".into(),
        ]);
        if let Ok(out) = run_kubectl(project, &ev_args, None)
            && out.status == Some(0)
        {
            events = parse_events_json(&out.stdout);
        }
    }

    json!({
        "op": "resource-extras",
        "kind": kind,
        "namespace": namespace,
        "name": name,
        "relatedPods": related_pods,
        "relatedResources": related_resources,
        "events": events,
    })
}

/// Opens an interactive terminal following Pod logs (`kubectl logs -f`).
pub fn open_follow_logs_terminal(
    cfg: &KubeConfigState,
    namespace: &str,
    pod: &str,
    container: Option<&str>,
) -> Result<(), Error> {
    let mut args = cfg.target_args(Some(namespace));
    args.push("logs".into());
    args.push("-f".into());
    args.push(format!("--tail={}", cfg.tail_lines));
    args.push(pod.to_owned());
    if let Some(c) = container.filter(|c| !c.is_empty()) {
        args.push("-c".into());
        args.push(c.to_owned());
    }
    let title = match container.filter(|c| !c.is_empty()) {
        Some(c) => format!("k8s logs: {pod}/{c}"),
        None => format!("k8s logs: {pod}"),
    };
    host::open_terminal(&title, "kubectl", &args)
}

/// Opens an interactive shell inside a Pod container (`kubectl exec -it`).
pub fn open_exec_terminal(
    cfg: &KubeConfigState,
    namespace: &str,
    pod: &str,
    container: Option<&str>,
) -> Result<(), Error> {
    let mut args = cfg.target_args(Some(namespace));
    args.push("exec".into());
    args.push("-it".into());
    args.push(pod.to_owned());
    if let Some(c) = container.filter(|c| !c.is_empty()) {
        args.push("-c".into());
        args.push(c.to_owned());
    }
    args.push("--".into());
    args.push(cfg.shell.clone());
    let title = match container.filter(|c| !c.is_empty()) {
        Some(c) => format!("k8s exec: {pod}/{c}"),
        None => format!("k8s exec: {pod}"),
    };
    host::open_terminal(&title, "kubectl", &args)
}

/// Opens an ephemeral debug container (`kubectl debug -it --image=busybox`) for distroless Pods.
pub fn open_debug_terminal(
    cfg: &KubeConfigState,
    namespace: &str,
    pod: &str,
    container: Option<&str>,
) -> Result<(), Error> {
    let mut args = cfg.target_args(Some(namespace));
    args.extend(["debug".into(), "-it".into(), pod.to_owned(), "--image=busybox:latest".into()]);
    if let Some(c) = container.filter(|c| !c.is_empty()) {
        args.push(format!("--target={c}"));
    }
    args.extend(["--".into(), "/bin/sh".into()]);
    host::open_terminal(&format!("k8s debug: {pod}"), "kubectl", &args)
}

/// Runs a shell command inside a Pod container (`kubectl exec`) and returns structured output + updated working directory.
pub fn exec_pod_command(
    project: &Project,
    cfg: &KubeConfigState,
    namespace: &str,
    pod: &str,
    container: Option<&str>,
    command: &str,
    cwd: &str,
) -> Value {
    let start_dir = if cwd.trim().is_empty() { "/" } else { cwd.trim() };
    let wrapped = format!(
        "cd '{}' 2>/dev/null; {}; printf '\\n__OPENIDEA_PWD__:%s' \"$(pwd 2>/dev/null || echo '{}')\"",
        start_dir.replace('\'', "'\\''"),
        command,
        start_dir
    );
    let mut args = cfg.target_args(Some(namespace));
    args.push("exec".into());
    args.push(pod.to_owned());
    if let Some(c) = container.filter(|c| !c.is_empty()) {
        args.push("-c".into());
        args.push(c.to_owned());
    }
    args.extend(["--".into(), "/bin/sh".into(), "-c".into(), wrapped]);

    match run_kubectl(project, &args, None) {
        Ok(out) => {
            let no_shell = out.stderr.contains("stat /bin/sh")
                || out.stderr.contains("executable file not found")
                || out.stderr.contains("no such file or directory") && out.stdout.is_empty();
            if no_shell {
                // Distroless container fallback: try running the command directly without `/bin/sh -c`
                let direct_tokens: Vec<String> = command.split_whitespace().map(str::to_owned).collect();
                if !direct_tokens.is_empty() && !command.contains("&&") && !command.contains(';') {
                    let mut d_args = cfg.target_args(Some(namespace));
                    d_args.push("exec".into());
                    d_args.push(pod.to_owned());
                    if let Some(c) = container.filter(|c| !c.is_empty()) {
                        d_args.push("-c".into());
                        d_args.push(c.to_owned());
                    }
                    d_args.push("--".into());
                    d_args.extend(direct_tokens);
                    if let Ok(d_out) = run_kubectl(project, &d_args, None)
                        && (d_out.status == Some(0) || !d_out.stdout.is_empty())
                    {
                        return json!({
                            "op": "shell-output",
                            "command": command,
                            "stdout": d_out.stdout,
                            "stderr": d_out.stderr,
                            "exitCode": d_out.status.unwrap_or(0),
                            "cwd": start_dir,
                            "distroless": true,
                        });
                    }
                }
                return json!({
                    "op": "shell-output",
                    "command": command,
                    "stdout": "",
                    "stderr": format!(
                        "{}\n(Note: Container image appears to be distroless without /bin/sh. Use 'Debug Container (busybox)' above to attach an ephemeral shell.)",
                        out.stderr.trim()
                    ),
                    "exitCode": out.status.unwrap_or(126),
                    "cwd": start_dir,
                    "distroless": true,
                });
            }

            let mut stdout = out.stdout;
            let mut next_cwd = start_dir.to_owned();
            if let Some(idx) = stdout.rfind("\n__OPENIDEA_PWD__:") {
                let pwd_part = stdout[idx + "\n__OPENIDEA_PWD__:".len()..].trim();
                if !pwd_part.is_empty() {
                    next_cwd = pwd_part.to_owned();
                }
                stdout.truncate(idx);
            } else if let Some(idx) = stdout.find("__OPENIDEA_PWD__:") {
                let pwd_part = stdout[idx + "__OPENIDEA_PWD__:".len()..].trim();
                if !pwd_part.is_empty() {
                    next_cwd = pwd_part.to_owned();
                }
                stdout.truncate(idx);
            }
            json!({
                "op": "shell-output",
                "command": command,
                "stdout": stdout,
                "stderr": out.stderr,
                "exitCode": out.status.unwrap_or(0),
                "cwd": next_cwd,
                "distroless": false,
            })
        }
        Err(e) => json!({
            "op": "shell-output",
            "command": command,
            "stdout": "",
            "stderr": e.to_string(),
            "exitCode": 1,
            "cwd": start_dir,
            "distroless": false,
        }),
    }
}

/// Opens a terminal running `kubectl port-forward`.
pub fn open_port_forward_terminal(
    cfg: &KubeConfigState,
    kind: &str,
    namespace: &str,
    name: &str,
    port_spec: &str,
) -> Result<(), Error> {
    let mut args = cfg.target_args(Some(namespace));
    args.push("port-forward".into());
    let resource_target = format!("{}/{name}", kind.to_ascii_lowercase());
    args.push(resource_target.clone());
    let mapping = if port_spec.contains(':') {
        port_spec.to_owned()
    } else if cfg.port_forward_local_port > 0 {
        format!("{}:{port_spec}", cfg.port_forward_local_port)
    } else {
        let p = if port_spec.is_empty() { "8080" } else { port_spec };
        format!("{p}:{p}")
    };
    args.push(mapping.clone());
    host::open_terminal(&format!("k8s port-forward: {name} ({mapping})"), "kubectl", &args)
}

/// Scales a workload (`kubectl scale --replicas=N`).
pub fn scale_workload(
    project: &Project,
    cfg: &KubeConfigState,
    kind: &str,
    namespace: &str,
    name: &str,
    replicas: u32,
) -> Result<String, Error> {
    let mut args = cfg.target_args(Some(namespace));
    args.extend(["scale".into(), format!("{}/{name}", kind.to_ascii_lowercase()), format!("--replicas={replicas}")]);
    let out = run_kubectl(project, &args, None)?;
    if out.status != Some(0) {
        return Err(Error::Failed(first_line_or(&out.stderr, "kubectl scale failed")));
    }
    Ok(out.stdout.trim().to_owned())
}

/// Restarts a workload rollout (`kubectl rollout restart`).
pub fn rollout_restart(
    project: &Project,
    cfg: &KubeConfigState,
    kind: &str,
    namespace: &str,
    name: &str,
) -> Result<String, Error> {
    let mut args = cfg.target_args(Some(namespace));
    args.extend(["rollout".into(), "restart".into(), format!("{}/{name}", kind.to_ascii_lowercase())]);
    let out = run_kubectl(project, &args, None)?;
    if out.status != Some(0) {
        return Err(Error::Failed(first_line_or(&out.stderr, "kubectl rollout restart failed")));
    }
    Ok(out.stdout.trim().to_owned())
}

/// Deletes a cluster resource (`kubectl delete <kind> <name>`).
pub fn delete_cluster_resource(
    project: &Project,
    cfg: &KubeConfigState,
    kind: &str,
    namespace: &str,
    name: &str,
) -> Result<String, Error> {
    let target_type = kind.strip_prefix("CR:").unwrap_or(kind).to_ascii_lowercase();
    let (_, cluster_scoped, _) =
        if kind.starts_with("CR:") { ("cr", namespace.is_empty(), false) } else { kubectl_resource_info(kind) };
    let mut args =
        if cluster_scoped || namespace.is_empty() { cfg.base_args(false) } else { cfg.target_args(Some(namespace)) };
    args.extend(["delete".into(), target_type, name.to_owned()]);
    let out = run_kubectl(project, &args, None)?;
    if out.status != Some(0) {
        return Err(Error::Failed(first_line_or(&out.stderr, "kubectl delete failed")));
    }
    Ok(out.stdout.trim().to_owned())
}

/// Triggers a manual Job from a CronJob (`kubectl create job --from=cronjob/<name> <name>-manual`).
pub fn trigger_cronjob(project: &Project, cfg: &KubeConfigState, namespace: &str, name: &str) -> Result<String, Error> {
    let mut args = cfg.target_args(Some(namespace));
    let job_name = format!("{name}-manual");
    let _ = run_kubectl(
        project,
        &[cfg.target_args(Some(namespace)), vec!["delete".into(), "job".into(), job_name.clone()]].concat(),
        None,
    );
    args.extend(["create".into(), "job".into(), format!("--from=cronjob/{name}"), job_name]);
    let out = run_kubectl(project, &args, None)?;
    if out.status != Some(0) {
        return Err(Error::Failed(first_line_or(&out.stderr, "kubectl create job --from=cronjob failed")));
    }
    Ok(first_line_or(&out.stdout, &format!("Triggered job from cronjob/{name}")))
}

/// Suspends or resumes a CronJob (`kubectl patch cronjob <name> -p '{"spec":{"suspend":...}}'`).
pub fn suspend_cronjob(
    project: &Project,
    cfg: &KubeConfigState,
    namespace: &str,
    name: &str,
    suspend: bool,
) -> Result<String, Error> {
    let mut args = cfg.target_args(Some(namespace));
    let patch = format!("{{\"spec\":{{\"suspend\":{suspend}}}}}");
    args.extend(["patch".into(), "cronjob".into(), name.to_owned(), "-p".into(), patch]);
    let out = run_kubectl(project, &args, None)?;
    if out.status != Some(0) {
        return Err(Error::Failed(first_line_or(&out.stderr, "kubectl patch cronjob failed")));
    }
    Ok(first_line_or(&out.stdout, &format!("cronjob/{name} {}", if suspend { "suspended" } else { "resumed" })))
}

/// Cordons or uncordons a cluster Node (`kubectl cordon <node>` / `kubectl uncordon <node>`).
pub fn cordon_node(project: &Project, cfg: &KubeConfigState, name: &str, uncordon: bool) -> Result<String, Error> {
    let mut args = cfg.base_args(false);
    let op = if uncordon { "uncordon" } else { "cordon" };
    args.extend([op.into(), name.to_owned()]);
    let out = run_kubectl(project, &args, None)?;
    if out.status != Some(0) {
        return Err(Error::Failed(first_line_or(&out.stderr, &format!("kubectl {op} failed"))));
    }
    Ok(first_line_or(&out.stdout, &format!("node/{name} {op}ed")))
}

/// Drains a cluster Node (`kubectl drain <node> --ignore-daemonsets --delete-emptydir-data --force`).
pub fn drain_node(project: &Project, cfg: &KubeConfigState, name: &str) -> Result<String, Error> {
    let mut args = cfg.base_args(false);
    args.extend([
        "drain".into(),
        name.to_owned(),
        "--ignore-daemonsets".into(),
        "--delete-emptydir-data".into(),
        "--force".into(),
        "--timeout=45s".into(),
    ]);
    let out = run_kubectl(project, &args, None)?;
    if out.status != Some(0) {
        return Err(Error::Failed(first_line_or(&out.stderr, "kubectl drain failed")));
    }
    Ok(first_line_or(&out.stdout, &format!("node/{name} drained")))
}

/// Applies, dry-runs, diffs, or deletes a YAML manifest string via `kubectl -f -`.
pub fn apply_or_diff_manifest(
    project: &Project,
    cfg: &KubeConfigState,
    yaml_text: &str,
    subcommand: &str, // "apply", "diff", "delete", "dry-run"
) -> Result<String, Error> {
    let mut args = cfg.target_args(None);
    match subcommand {
        "apply" => {
            args.extend(["apply".into(), "-f".into(), "-".into()]);
        }
        "dry-run" => {
            args.extend(["apply".into(), "--dry-run=client".into(), "-f".into(), "-".into()]);
        }
        "diff" => {
            args.extend(["diff".into(), "-f".into(), "-".into()]);
        }
        "delete" => {
            args.extend(["delete".into(), "-f".into(), "-".into()]);
        }
        other => return Err(Error::Invalid(format!("unknown manifest action {other}"))),
    }
    let out = run_kubectl(project, &args, Some(yaml_text))?;
    // `kubectl diff` exits with status 1 when differences exist, and >1 on error.
    if subcommand == "diff" {
        return match out.status {
            Some(0) => Ok("No differences between manifest and live cluster resource.".into()),
            Some(1) => Ok(out.stdout),
            _ => Err(Error::Failed(first_line_or(&out.stderr, "kubectl diff failed"))),
        };
    }
    if out.status != Some(0) {
        return Err(Error::Failed(first_line_or(&out.stderr, &format!("kubectl {subcommand} failed"))));
    }
    Ok(out.stdout.trim().to_owned())
}

/// Builds a Kustomize directory using `kubectl kustomize <dir>` (or `kustomize build <dir>`).
pub fn build_kustomize(project: &Project, dir: &str) -> Result<String, Error> {
    let target = if dir.is_empty() { "." } else { dir };
    let args = vec!["kustomize".to_owned(), target.to_owned()];
    if let Ok(out) = run_kubectl(project, &args, None)
        && out.status == Some(0)
    {
        return Ok(out.stdout);
    }
    let k_args = vec!["build".to_owned(), target.to_owned()];
    let out = project.run_process("kustomize", &k_args, None)?;
    if out.status != Some(0) {
        return Err(Error::Failed(first_line_or(&out.stderr, "kustomize build failed")));
    }
    Ok(out.stdout)
}

/// Renders Helm chart templates (`helm template <dir>`) or fetches release values/manifest.
pub fn render_helm_template(project: &Project, chart_dir: &str) -> Result<String, Error> {
    let target = if chart_dir.is_empty() { "." } else { chart_dir };
    let args = vec!["template".to_owned(), target.to_owned()];
    let out = project.run_process("helm", &args, None)?;
    if out.status != Some(0) {
        return Err(Error::Failed(first_line_or(&out.stderr, "helm template failed")));
    }
    Ok(out.stdout)
}

/// Fetches a Helm release's manifest or values (`helm get manifest|values <release>`).
pub fn fetch_helm_release_detail(
    project: &Project,
    cfg: &KubeConfigState,
    namespace: &str,
    release: &str,
    sub: &str, // "manifest" or "values"
) -> Result<String, Error> {
    let mut args = Vec::new();
    if !cfg.kubeconfig.trim().is_empty() {
        args.push(format!("--kubeconfig={}", cfg.kubeconfig.trim()));
    }
    if !cfg.context.trim().is_empty() {
        args.push(format!("--kube-context={}", cfg.context.trim()));
    }
    if !namespace.trim().is_empty() {
        args.push("-n".into());
        args.push(namespace.trim().to_owned());
    }
    args.extend(["get".into(), sub.to_owned(), release.to_owned()]);
    let out = project.run_process("helm", &args, None)?;
    if out.status != Some(0) {
        return Err(Error::Failed(first_line_or(&out.stderr, "helm get failed")));
    }
    Ok(out.stdout)
}

/// Summarizes workspace Kubernetes manifests for the tool window's "Workspace Manifests" section.
pub fn workspace_manifests_json(files: &BTreeMap<String, crate::manifest::ParsedFile>, root: &str) -> Value {
    let norm_root = root.replace('\\', "/");
    let mut items = Vec::new();
    for (path, parsed) in files {
        let rel = path.strip_prefix(&norm_root).map(|r| r.trim_start_matches('/')).unwrap_or(path);
        for doc in &parsed.docs {
            if let Some(ref kind) = doc.kind {
                let name = doc.name.as_ref().map_or("(unnamed)", |n| n.value.as_str());
                let ns = doc.namespace.as_ref().map_or("default", |n| n.value.as_str());
                let api = doc.api_version.as_ref().map_or("", |a| a.value.as_str());
                items.push(json!({
                    "path": rel,
                    "fullPath": path,
                    "line": doc.name.as_ref().map_or(kind.line, |n| n.line),
                    "kind": kind.value,
                    "name": name,
                    "namespace": ns,
                    "apiVersion": api,
                }));
            }
        }
    }
    Value::Array(items)
}

fn first_line_or(stderr: &str, fallback: &str) -> String {
    stderr.lines().find(|l| !l.trim().is_empty()).map(|l| l.trim().to_owned()).unwrap_or_else(|| fallback.to_owned())
}
