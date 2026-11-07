//! Kubernetes for OpenIDEA (`openidea.kubernetes`):
//! Mirrors the JetBrains IntelliJ Kubernetes plugin across both cluster runtime
//! management and rich YAML / Helm / Kustomize editor intelligence:
//! - Cluster Explorer tool window (`kubernetes`): browse contexts, namespaces,
//!   Workloads (Pods, Deployments, StatefulSets, DaemonSets, Jobs, CronJobs),
//!   Network (Services, Ingresses), Config & Storage (ConfigMaps, Secrets, PVCs),
//!   Nodes, CRDs, Events, Helm Releases, and Workspace YAML manifests.
//! - Live cluster actions: Describe, YAML extraction, Pod container log viewer
//!   with level filter & pattern matching, Follow Logs in terminal, Interactive
//!   Pod Shell (`kubectl exec -it`), Port Forward (`kubectl port-forward`),
//!   Scale Replicas, Rollout Restart, Apply / Diff / Dry-Run / Delete manifests,
//!   Kustomize build preview, and Helm template rendering.
//! - Editor intelligence (`Providers`): schema & live-template completion,
//!   cluster + workspace ConfigMap/Secret/Service/PVC/ServiceAccount/CRD/Helm
//!   completion, cross-resource Go to Definition and gutter line markers,
//!   static + dry-run manifest inspections, and one-click Quick Fixes.

pub mod intelligence;
pub mod kubectl;
pub mod manifest;

use intelligence::{
    ProjectIndex, completions_at, definitions_at, inspect_document, line_markers_for, normalize_slashes, project_of,
};
use kubectl::{
    ClusterSnapshot, KubeConfigState, apply_or_diff_manifest, build_kustomize, cordon_node, delete_cluster_resource,
    drain_node, exec_pod_command, fetch_category_into_snapshot, fetch_cluster_snapshot, fetch_helm_release_detail,
    fetch_kubeconfig_overview, fetch_namespaces_into_snapshot, fetch_nodes_into_snapshot, fetch_pod_logs,
    fetch_resource_extras, inspect_cluster_resource, inspect_cluster_resource_json, open_debug_terminal,
    open_exec_terminal, open_follow_logs_terminal, open_port_forward_terminal, render_helm_template, resolve_project,
    rollout_restart, scale_workload, suspend_cronjob, trigger_cronjob, workspace_manifests_json,
};
use manifest::{parse_yaml, utf16_len};
use openidea_plugin::host::{self, storage};
use openidea_plugin::providers::{CodeAction, CompletionItem, CompletionKind, Document, LineMarker, Providers};
use openidea_plugin::views::{Body, Button, View, ViewEvent, Viewport, Views};
use openidea_plugin::{
    Context, Diagnostic, Error, Event, Invocation, Location, NotificationLevel, Plugin, Position, Project, Range,
    Severity, StatusItem, register_plugin,
};
use serde_json::{Value, json};

pub const VIEW_ID: &str = "kubernetes";
pub const STATUS_ID: &str = "context";
const PAGE_HTML: &str = include_str!("page.html");

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((n >> 6) & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(n & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

#[derive(Default)]
pub struct KubernetesPlugin {
    pub index: ProjectIndex,
    pub snapshot: Option<ClusterSnapshot>,
}

impl KubernetesPlugin {
    fn update_status_bar(&self, cfg: &KubeConfigState) {
        let ctx_name = if let Some(ref snap) = self.snapshot
            && !snap.current_context.is_empty()
        {
            snap.current_context.as_str()
        } else if !cfg.context.is_empty() {
            cfg.context.as_str()
        } else {
            "k8s"
        };
        let ns_name = if cfg.all_namespaces {
            "all"
        } else if let Some(ref snap) = self.snapshot
            && !snap.current_namespace.is_empty()
        {
            snap.current_namespace.as_str()
        } else if !cfg.namespace.is_empty() {
            cfg.namespace.as_str()
        } else {
            "default"
        };
        let text = format!("k8s: {ctx_name}/{ns_name}");
        host::set_status_item(
            STATUS_ID,
            &StatusItem {
                text,
                tooltip: Some(format!(
                    "Kubernetes context: {ctx_name}, namespace: {ns_name} (click to switch context)"
                )),
                command: Some("switch-context".into()),
            },
        );
    }

    fn ensure_catalog_loaded(&mut self, project: &Project, cfg: &mut KubeConfigState) {
        let needs_catalog =
            self.snapshot.as_ref().is_none_or(|s| s.cluster_catalog.is_empty() || s.contexts.is_empty());
        if !needs_catalog {
            if let Some(ref mut snap) = self.snapshot {
                if cfg.context.is_empty() && !snap.current_context.is_empty() {
                    cfg.context = snap.current_context.clone();
                    let _ = storage::set("context", &cfg.context);
                } else if !cfg.context.is_empty() {
                    snap.current_context = cfg.context.clone();
                }
                snap.current_namespace = cfg.namespace.clone();
                snap.all_namespaces = cfg.all_namespaces;
            }
            return;
        }
        let mut snap = self.snapshot.take().unwrap_or_else(|| ClusterSnapshot {
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
        });
        match fetch_kubeconfig_overview(project, cfg) {
            Ok((current_ctx, contexts, ctx_ns, catalog)) => {
                if cfg.context.is_empty() && !current_ctx.is_empty() {
                    cfg.context = current_ctx.clone();
                    let _ = storage::set("context", &cfg.context);
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
                snap.all_namespaces = cfg.all_namespaces;
                if !snap.namespaces.contains(&cfg.namespace) {
                    snap.namespaces.push(cfg.namespace.clone());
                    snap.namespaces.sort();
                }
            }
            Err(e) => {
                snap.error = Some(e.to_string());
            }
        }
        self.snapshot = Some(snap);
    }

    fn refresh_cluster(&mut self, project: &Project) -> ClusterSnapshot {
        let mut cfg = KubeConfigState::load();
        let snap = fetch_cluster_snapshot(project, &mut cfg);
        self.snapshot = Some(snap.clone());
        self.update_status_bar(&cfg);
        snap
    }

    fn state_payload(&mut self, ctx: &Invocation) -> Value {
        let project = resolve_project(ctx).ok();
        let root = project.as_ref().and_then(|p| p.root().ok()).unwrap_or_default();
        self.index.ensure(project.as_ref(), None);
        if self.snapshot.is_none()
            && let Some(ref p) = project
        {
            self.refresh_cluster(p);
        }
        let ws = workspace_manifests_json(&self.index.files, &root);
        json!({
            "op": "state",
            "snapshot": self.snapshot.clone().unwrap_or_default(),
            "workspace": ws,
        })
    }

    fn post_state(&mut self, ctx: &Invocation) {
        let payload = self.state_payload(ctx);
        let _ = host::post_view_message(VIEW_ID, &payload.to_string());
        let cfg = KubeConfigState::load();
        self.update_status_bar(&cfg);
    }

    fn post_snapshot(&mut self, needs_bg_sync: bool) {
        let payload = json!({
            "op": "state",
            "snapshot": self.snapshot.clone().unwrap_or_default(),
            "needsBackgroundSync": needs_bg_sync,
        });
        let _ = host::post_view_message(VIEW_ID, &payload.to_string());
        let cfg = KubeConfigState::load();
        self.update_status_bar(&cfg);
    }

    fn post_detail(text: impl Into<String>, banner: Option<String>, is_error: bool) {
        let msg = json!({
            "op": "detail",
            "text": text.into(),
            "banner": banner,
            "error": is_error,
        });
        let _ = host::post_view_message(VIEW_ID, &msg.to_string());
    }

    /// Runs static inspections (and optional `kubectl --dry-run=client`) on `path` and publishes diagnostics.
    pub fn check_and_publish(&mut self, path: &str, run_dry_run_override: bool) -> Result<usize, Error> {
        if !(path.ends_with(".yaml") || path.ends_with(".yml")) {
            return Ok(0);
        }
        let Some(project) = project_of(path) else {
            return Ok(0);
        };
        let Ok(text) = project.read_file(path) else {
            return Ok(0);
        };
        self.index.ensure(Some(&project), Some((path, &text)));
        let parsed = self.index.files.get(&normalize_slashes(path)).cloned().unwrap_or_else(|| parse_yaml(&text));

        if parsed.marked_non_k8s || parsed.docs.is_empty() {
            host::publish_diagnostics(path, &[])?;
            return Ok(0);
        }

        let warn_latest = host::setting_bool("warnLatestTag").unwrap_or(true);
        let warn_resources = host::setting_bool("warnMissingResources").unwrap_or(true);
        let issues = inspect_document(&self.index, path, &text, &parsed, warn_latest, warn_resources);
        let mut diagnostics: Vec<Diagnostic> = issues.into_iter().map(|i| i.diagnostic).collect();

        let dry_run = run_dry_run_override || host::setting_bool("dryRunOnSave").unwrap_or(false);
        if dry_run && !text.contains("{{") {
            let cfg = KubeConfigState::load();
            if let Err(e) = apply_or_diff_manifest(&project, &cfg, &text, "dry-run") {
                let first_line = text.lines().next().unwrap_or("");
                let range = Range::new(Position::new(0, 0), Position::new(0, utf16_len(first_line)));
                diagnostics.push(intelligence::diag_with_source(
                    range,
                    Severity::Error,
                    e.to_string(),
                    "kubectl-dry-run",
                    "kubectl",
                    false,
                    false,
                ));
            }
        }

        let count = diagnostics.len();
        host::publish_diagnostics(path, &diagnostics)?;
        Ok(count)
    }

    fn scan_project_manifests(&mut self, ctx: &Invocation) -> Result<String, Error> {
        let project = resolve_project(ctx)?;
        let _task = host::begin_task("Kubernetes: Inspecting project manifests", true);
        self.index.built_at = None;
        self.index.ensure(Some(&project), None);
        let paths: Vec<String> = self.index.files.keys().cloned().collect();
        let mut total_issues = 0usize;
        let mut total_files = 0usize;
        for path in paths {
            if let Ok(n) = self.check_and_publish(&path, false) {
                total_files += 1;
                total_issues += n;
            }
        }
        let summary = format!("Inspected {total_files} YAML file(s): {total_issues} issue(s) reported");
        host::notify(NotificationLevel::Info, "Kubernetes Inspection", &summary);
        Ok(summary)
    }

    fn handle_page_message(&mut self, raw: &str, ctx: &Invocation) -> Result<(), Error> {
        let _task = host::begin_task("Kubernetes", false);
        let v: Value = serde_json::from_str(raw).map_err(|e| Error::Invalid(e.to_string()))?;
        let op = v.get("op").and_then(Value::as_str).unwrap_or("");
        match op {
            "init" => {
                let project = resolve_project(ctx).ok();
                let root = project.as_ref().and_then(|p| p.root().ok()).unwrap_or_default();
                let mut cfg = KubeConfigState::load();
                if let Some(ref p) = project {
                    self.ensure_catalog_loaded(p, &mut cfg);
                }
                self.update_status_bar(&cfg);
                let snap = self.snapshot.clone().unwrap_or_default();
                let ws = workspace_manifests_json(&self.index.files, &root);
                let cat = v.get("category").and_then(Value::as_str).unwrap_or("Pod");
                let needs_fetch = snap.namespaces.len() <= 3 || !snap.resources.iter().any(|r| r.kind == cat);
                let payload = json!({
                    "op": "state",
                    "snapshot": snap,
                    "workspace": ws,
                    "needsClusterFetch": false,
                });
                let _ = host::post_view_message(VIEW_ID, &payload.to_string());
                if needs_fetch
                    && let Some(ref p) = project
                    && let Some(ref mut s) = self.snapshot
                {
                    if s.namespaces.len() <= 3 {
                        fetch_namespaces_into_snapshot(p, &cfg, s);
                    }
                    fetch_category_into_snapshot(p, &cfg, s, cat);
                    self.post_snapshot(false);
                }
            }
            "refresh" => {
                let project = resolve_project(ctx)?;
                if let Some(cat) = v.get("category").and_then(Value::as_str) {
                    if cat == "Workspace" {
                        self.index.built_at = None;
                        self.index.ensure(Some(&project), None);
                        self.post_state(ctx);
                        return Ok(());
                    }
                    let mut cfg = KubeConfigState::load();
                    self.ensure_catalog_loaded(&project, &mut cfg);
                    if let Some(ref mut snap) = self.snapshot {
                        fetch_namespaces_into_snapshot(&project, &cfg, snap);
                        fetch_category_into_snapshot(&project, &cfg, snap, cat);
                    }
                    self.post_snapshot(false);
                } else {
                    self.index.built_at = None;
                    self.refresh_cluster(&project);
                    self.post_state(ctx);
                }
            }
            "set-context" => {
                if let Some(c) = v.get("context").and_then(Value::as_str) {
                    if let Ok(project) = resolve_project(ctx) {
                        let mut cfg = KubeConfigState::load();
                        self.ensure_catalog_loaded(&project, &mut cfg);
                    }
                    let prev_catalog = self.snapshot.as_ref().map(|s| s.cluster_catalog.clone()).unwrap_or_default();
                    let prev_contexts = self.snapshot.as_ref().map(|s| s.contexts.clone()).unwrap_or_default();
                    let default_ns = prev_catalog
                        .iter()
                        .find(|item| item.name == c && !item.namespace.is_empty())
                        .map(|item| item.namespace.clone())
                        .unwrap_or_else(|| "default".into());
                    let _ = storage::set("context", c);
                    let _ = storage::set("namespace", &default_ns);
                    let _ = storage::set("allNamespaces", "false");

                    if let Some(cat) = v.get("category").and_then(Value::as_str) {
                        let mut cfg = KubeConfigState::load();
                        cfg.context = c.to_owned();
                        cfg.namespace = default_ns.clone();
                        cfg.all_namespaces = false;
                        let mut snap = ClusterSnapshot {
                            connected: false,
                            error: None,
                            current_context: c.to_owned(),
                            contexts: prev_contexts,
                            cluster_catalog: prev_catalog,
                            current_namespace: default_ns.clone(),
                            all_namespaces: false,
                            namespaces: vec![default_ns, "default".into(), "kube-system".into()],
                            resources: Vec::new(),
                            events: Vec::new(),
                            helm_releases: Vec::new(),
                        };
                        snap.namespaces.sort();
                        snap.namespaces.dedup();
                        self.update_status_bar(&cfg);
                        if let Ok(project) = resolve_project(ctx) {
                            fetch_namespaces_into_snapshot(&project, &cfg, &mut snap);
                            if cat != "ClusterCatalog" && cat != "Workspace" {
                                fetch_category_into_snapshot(&project, &cfg, &mut snap, cat);
                            }
                            self.snapshot = Some(snap);
                            self.post_snapshot(false);
                        } else {
                            self.snapshot = Some(snap);
                            self.post_snapshot(false);
                        }
                    } else {
                        if let Ok(project) = resolve_project(ctx) {
                            self.refresh_cluster(&project);
                        }
                        self.post_state(ctx);
                    }
                }
            }
            "sync-cluster" => {
                let project = resolve_project(ctx)?;
                let mut cfg = KubeConfigState::load();
                self.ensure_catalog_loaded(&project, &mut cfg);
                if let Some(req_ctx) = v.get("context").and_then(Value::as_str)
                    && !req_ctx.is_empty()
                    && req_ctx != cfg.context
                {
                    return Ok(());
                }
                if let Some(ref mut snap) = self.snapshot {
                    if snap.namespaces.len() <= 3 {
                        fetch_namespaces_into_snapshot(&project, &cfg, snap);
                    }
                } else {
                    self.refresh_cluster(&project);
                }
                self.post_snapshot(false);
            }
            "load-category" => {
                let project = resolve_project(ctx)?;
                let mut cfg = KubeConfigState::load();
                self.ensure_catalog_loaded(&project, &mut cfg);
                if let Some(cat) = v.get("category").and_then(Value::as_str) {
                    if cat == "Workspace" {
                        self.index.ensure(Some(&project), None);
                        self.post_state(ctx);
                        return Ok(());
                    }
                    if let Some(ref mut snap) = self.snapshot {
                        if snap.namespaces.len() <= 3 {
                            fetch_namespaces_into_snapshot(&project, &cfg, snap);
                        }
                        fetch_category_into_snapshot(&project, &cfg, snap, cat);
                    }
                }
                self.post_snapshot(false);
            }
            "set-namespace" => {
                if let Some(ns) = v.get("namespace").and_then(Value::as_str) {
                    let _ = storage::set("namespace", ns);
                    let _ = storage::set("allNamespaces", "false");
                    if let Some(cat) = v.get("category").and_then(Value::as_str)
                        && let Ok(project) = resolve_project(ctx)
                    {
                        let mut cfg = KubeConfigState::load();
                        self.ensure_catalog_loaded(&project, &mut cfg);
                        if let Some(ref mut snap) = self.snapshot {
                            if snap.namespaces.len() <= 3 {
                                fetch_namespaces_into_snapshot(&project, &cfg, snap);
                            }
                            snap.current_namespace = ns.to_owned();
                            snap.all_namespaces = false;
                            snap.resources.retain(|r| {
                                matches!(r.kind.as_str(), "Namespace" | "Node" | "CustomResourceDefinition")
                            });
                            fetch_category_into_snapshot(&project, &cfg, snap, cat);
                        }
                        self.post_snapshot(false);
                    } else {
                        if let Ok(project) = resolve_project(ctx) {
                            self.refresh_cluster(&project);
                        }
                        self.post_state(ctx);
                    }
                }
            }
            "set-all-namespaces" => {
                let all = v.get("all").and_then(Value::as_bool).unwrap_or(false);
                let _ = storage::set("allNamespaces", if all { "true" } else { "false" });
                if let Some(cat) = v.get("category").and_then(Value::as_str)
                    && let Ok(project) = resolve_project(ctx)
                {
                    let mut cfg = KubeConfigState::load();
                    self.ensure_catalog_loaded(&project, &mut cfg);
                    if let Some(ref mut snap) = self.snapshot {
                        if snap.namespaces.len() <= 3 {
                            fetch_namespaces_into_snapshot(&project, &cfg, snap);
                        }
                        snap.all_namespaces = all;
                        snap.resources
                            .retain(|r| matches!(r.kind.as_str(), "Namespace" | "Node" | "CustomResourceDefinition"));
                        fetch_category_into_snapshot(&project, &cfg, snap, cat);
                    }
                    self.post_snapshot(false);
                } else {
                    if let Ok(project) = resolve_project(ctx) {
                        self.refresh_cluster(&project);
                    }
                    self.post_state(ctx);
                }
            }
            "inspect" => {
                let project = resolve_project(ctx)?;
                let cfg = KubeConfigState::load();
                let kind = v.get("kind").and_then(Value::as_str).unwrap_or("Pod");
                let ns = v.get("namespace").and_then(Value::as_str).unwrap_or("");
                let name = v.get("name").and_then(Value::as_str).unwrap_or("");
                let as_yaml = v.get("yaml").and_then(Value::as_bool).unwrap_or(false);
                match inspect_cluster_resource(&project, &cfg, kind, ns, name, as_yaml) {
                    Ok(out) => Self::post_detail(out, None, false),
                    Err(e) => Self::post_detail(e.to_string(), Some(e.to_string()), true),
                }
            }
            "inspect-json" => {
                let project = resolve_project(ctx)?;
                let cfg = KubeConfigState::load();
                let kind = v.get("kind").and_then(Value::as_str).unwrap_or("Pod");
                let ns = v.get("namespace").and_then(Value::as_str).unwrap_or("");
                let name = v.get("name").and_then(Value::as_str).unwrap_or("");
                match inspect_cluster_resource_json(&project, &cfg, kind, ns, name) {
                    Ok(out) => {
                        let msg = json!({
                            "op": "resource-json",
                            "kind": kind,
                            "namespace": ns,
                            "name": name,
                            "json": out,
                        });
                        let _ = host::post_view_message(VIEW_ID, &msg.to_string());
                        let extras = fetch_resource_extras(&project, &cfg, kind, ns, name, &out);
                        let _ = host::post_view_message(VIEW_ID, &extras.to_string());
                    }
                    Err(e) => Self::post_detail(e.to_string(), Some(e.to_string()), true),
                }
            }
            "pod-logs" => {
                let project = resolve_project(ctx)?;
                let cfg = KubeConfigState::load();
                let ns = v.get("namespace").and_then(Value::as_str).unwrap_or("default");
                let name = v.get("name").and_then(Value::as_str).unwrap_or("");
                let container = v.get("container").and_then(Value::as_str);
                let previous = v.get("previous").and_then(Value::as_bool).unwrap_or(false);
                match fetch_pod_logs(&project, &cfg, ns, name, container, previous) {
                    Ok(logs) => Self::post_detail(logs, None, false),
                    Err(e) => Self::post_detail(e.to_string(), Some(e.to_string()), true),
                }
            }
            "follow-logs" => {
                let cfg = KubeConfigState::load();
                let ns = v.get("namespace").and_then(Value::as_str).unwrap_or("default");
                let name = v.get("name").and_then(Value::as_str).unwrap_or("");
                let container = v.get("container").and_then(Value::as_str);
                open_follow_logs_terminal(&cfg, ns, name, container)?;
            }
            "exec-shell" => {
                let cfg = KubeConfigState::load();
                let ns = v.get("namespace").and_then(Value::as_str).unwrap_or("default");
                let name = v.get("name").and_then(Value::as_str).unwrap_or("");
                let container = v.get("container").and_then(Value::as_str);
                open_exec_terminal(&cfg, ns, name, container)?;
            }
            "debug-shell" => {
                let cfg = KubeConfigState::load();
                let ns = v.get("namespace").and_then(Value::as_str).unwrap_or("default");
                let name = v.get("name").and_then(Value::as_str).unwrap_or("");
                let container = v.get("container").and_then(Value::as_str);
                open_debug_terminal(&cfg, ns, name, container)?;
            }
            "pod-exec" => {
                let project = resolve_project(ctx)?;
                let cfg = KubeConfigState::load();
                let ns = v.get("namespace").and_then(Value::as_str).unwrap_or("default");
                let name = v.get("name").and_then(Value::as_str).unwrap_or("");
                let container = v.get("container").and_then(Value::as_str);
                let cmd = v.get("command").and_then(Value::as_str).unwrap_or("pwd");
                let cwd = v.get("cwd").and_then(Value::as_str).unwrap_or("/");
                let out = exec_pod_command(&project, &cfg, ns, name, container, cmd, cwd);
                let _ = host::post_view_message(VIEW_ID, &out.to_string());
            }
            "port-forward" => {
                let cfg = KubeConfigState::load();
                let kind = v.get("kind").and_then(Value::as_str).unwrap_or("Pod");
                let ns = v.get("namespace").and_then(Value::as_str).unwrap_or("default");
                let name = v.get("name").and_then(Value::as_str).unwrap_or("");
                let port = v.get("port").and_then(Value::as_str).unwrap_or("8080");
                open_port_forward_terminal(&cfg, kind, ns, name, port)?;
            }
            "scale" => {
                let project = resolve_project(ctx)?;
                let cfg = KubeConfigState::load();
                let kind = v.get("kind").and_then(Value::as_str).unwrap_or("Deployment");
                let ns = v.get("namespace").and_then(Value::as_str).unwrap_or("default");
                let name = v.get("name").and_then(Value::as_str).unwrap_or("");
                let replicas = v.get("replicas").and_then(Value::as_u64).unwrap_or(1) as u32;
                match scale_workload(&project, &cfg, kind, ns, name, replicas) {
                    Ok(msg) => {
                        self.refresh_cluster(&project);
                        self.post_state(ctx);
                        Self::post_detail(msg.clone(), Some(msg), false);
                    }
                    Err(e) => Self::post_detail(e.to_string(), Some(e.to_string()), true),
                }
            }
            "restart" => {
                let project = resolve_project(ctx)?;
                let cfg = KubeConfigState::load();
                let kind = v.get("kind").and_then(Value::as_str).unwrap_or("Deployment");
                let ns = v.get("namespace").and_then(Value::as_str).unwrap_or("default");
                let name = v.get("name").and_then(Value::as_str).unwrap_or("");
                match rollout_restart(&project, &cfg, kind, ns, name) {
                    Ok(msg) => {
                        self.refresh_cluster(&project);
                        self.post_state(ctx);
                        Self::post_detail(msg.clone(), Some(msg), false);
                    }
                    Err(e) => Self::post_detail(e.to_string(), Some(e.to_string()), true),
                }
            }
            "copy-yaml" => {
                let project = resolve_project(ctx)?;
                let cfg = KubeConfigState::load();
                let kind = v.get("kind").and_then(Value::as_str).unwrap_or("Pod");
                let ns = v.get("namespace").and_then(Value::as_str).unwrap_or("");
                let name = v.get("name").and_then(Value::as_str).unwrap_or("");
                let yaml = inspect_cluster_resource(&project, &cfg, kind, ns, name, true)?;
                host::copy_to_clipboard(&yaml)?;
                Self::post_detail(yaml, Some(format!("Copied {kind}/{name} YAML to clipboard")), false);
            }
            "apply-yaml" | "diff-yaml" => {
                let project = resolve_project(ctx)?;
                let cfg = KubeConfigState::load();
                let yaml_text = v.get("yaml").and_then(Value::as_str).unwrap_or("");
                let mode = if op == "apply-yaml" { "apply" } else { "diff" };
                match apply_or_diff_manifest(&project, &cfg, yaml_text, mode) {
                    Ok(out) => {
                        if mode == "apply" {
                            self.refresh_cluster(&project);
                            self.post_state(ctx);
                            host::notify(
                                NotificationLevel::Info,
                                "Kubernetes Apply",
                                out.lines().next().unwrap_or("Applied"),
                            );
                            Self::post_detail(yaml_text, Some(format!("Applied to cluster: {out}")), false);
                        } else {
                            Self::post_detail(out, Some("Diff against live cluster".into()), false);
                        }
                    }
                    Err(e) => Self::post_detail(yaml_text, Some(e.to_string()), true),
                }
            }
            "delete" => {
                let project = resolve_project(ctx)?;
                let mut cfg = KubeConfigState::load();
                self.ensure_catalog_loaded(&project, &mut cfg);
                let kind = v.get("kind").and_then(Value::as_str).unwrap_or("Pod");
                let ns = v.get("namespace").and_then(Value::as_str).unwrap_or("");
                let name = v.get("name").and_then(Value::as_str).unwrap_or("");
                match delete_cluster_resource(&project, &cfg, kind, ns, name) {
                    Ok(msg) => {
                        if let Some(ref mut snap) = self.snapshot {
                            fetch_category_into_snapshot(&project, &cfg, snap, kind);
                        }
                        self.post_snapshot(false);
                        Self::post_detail(msg.clone(), Some(msg), false);
                    }
                    Err(e) => Self::post_detail(e.to_string(), Some(e.to_string()), true),
                }
            }
            "cordon-node" => {
                let project = resolve_project(ctx)?;
                let mut cfg = KubeConfigState::load();
                self.ensure_catalog_loaded(&project, &mut cfg);
                let name = v.get("name").and_then(Value::as_str).unwrap_or("");
                let uncordon = v.get("uncordon").and_then(Value::as_bool).unwrap_or(false);
                match cordon_node(&project, &cfg, name, uncordon) {
                    Ok(msg) => {
                        if let Some(ref mut snap) = self.snapshot {
                            fetch_nodes_into_snapshot(&project, &cfg, snap);
                        }
                        self.post_snapshot(false);
                        if let Ok(json_str) = inspect_cluster_resource_json(&project, &cfg, "Node", "", name) {
                            let jmsg = json!({
                                "op": "resource-json",
                                "kind": "Node",
                                "namespace": "",
                                "name": name,
                                "json": json_str,
                            });
                            let _ = host::post_view_message(VIEW_ID, &jmsg.to_string());
                        }
                        host::notify(NotificationLevel::Info, "Kubernetes Node", &msg);
                        Self::post_detail(msg.clone(), Some(msg), false);
                    }
                    Err(e) => Self::post_detail(e.to_string(), Some(e.to_string()), true),
                }
            }
            "drain-node" => {
                let project = resolve_project(ctx)?;
                let mut cfg = KubeConfigState::load();
                self.ensure_catalog_loaded(&project, &mut cfg);
                let name = v.get("name").and_then(Value::as_str).unwrap_or("");
                match drain_node(&project, &cfg, name) {
                    Ok(msg) => {
                        if let Some(ref mut snap) = self.snapshot {
                            fetch_nodes_into_snapshot(&project, &cfg, snap);
                        }
                        self.post_snapshot(false);
                        if let Ok(json_str) = inspect_cluster_resource_json(&project, &cfg, "Node", "", name) {
                            let jmsg = json!({
                                "op": "resource-json",
                                "kind": "Node",
                                "namespace": "",
                                "name": name,
                                "json": json_str,
                            });
                            let _ = host::post_view_message(VIEW_ID, &jmsg.to_string());
                        }
                        host::notify(NotificationLevel::Info, "Kubernetes Node Drain", &msg);
                        Self::post_detail(msg.clone(), Some(msg), false);
                    }
                    Err(e) => Self::post_detail(e.to_string(), Some(e.to_string()), true),
                }
            }
            "trigger-cronjob" => {
                let project = resolve_project(ctx)?;
                let mut cfg = KubeConfigState::load();
                self.ensure_catalog_loaded(&project, &mut cfg);
                let ns = v.get("namespace").and_then(Value::as_str).unwrap_or("default");
                let name = v.get("name").and_then(Value::as_str).unwrap_or("");
                match trigger_cronjob(&project, &cfg, ns, name) {
                    Ok(msg) => {
                        if let Some(ref mut snap) = self.snapshot {
                            fetch_category_into_snapshot(&project, &cfg, snap, "CronJob");
                            fetch_category_into_snapshot(&project, &cfg, snap, "Job");
                        }
                        self.post_snapshot(false);
                        if let Ok(json_str) = inspect_cluster_resource_json(&project, &cfg, "CronJob", ns, name) {
                            let extras = fetch_resource_extras(&project, &cfg, "CronJob", ns, name, &json_str);
                            let _ = host::post_view_message(VIEW_ID, &extras.to_string());
                        }
                        host::notify(NotificationLevel::Info, "Kubernetes CronJob", &msg);
                        Self::post_detail(msg.clone(), Some(msg), false);
                    }
                    Err(e) => Self::post_detail(e.to_string(), Some(e.to_string()), true),
                }
            }
            "suspend-cronjob" => {
                let project = resolve_project(ctx)?;
                let mut cfg = KubeConfigState::load();
                self.ensure_catalog_loaded(&project, &mut cfg);
                let ns = v.get("namespace").and_then(Value::as_str).unwrap_or("default");
                let name = v.get("name").and_then(Value::as_str).unwrap_or("");
                let suspend = v.get("suspend").and_then(Value::as_bool).unwrap_or(true);
                match suspend_cronjob(&project, &cfg, ns, name, suspend) {
                    Ok(msg) => {
                        if let Some(ref mut snap) = self.snapshot {
                            fetch_category_into_snapshot(&project, &cfg, snap, "CronJob");
                        }
                        self.post_snapshot(false);
                        if let Ok(json_str) = inspect_cluster_resource_json(&project, &cfg, "CronJob", ns, name) {
                            let jmsg = json!({
                                "op": "resource-json",
                                "kind": "CronJob",
                                "namespace": ns,
                                "name": name,
                                "json": json_str,
                            });
                            let _ = host::post_view_message(VIEW_ID, &jmsg.to_string());
                        }
                        host::notify(NotificationLevel::Info, "Kubernetes CronJob", &msg);
                        Self::post_detail(msg.clone(), Some(msg), false);
                    }
                    Err(e) => Self::post_detail(e.to_string(), Some(e.to_string()), true),
                }
            }
            "helm-detail" => {
                let project = resolve_project(ctx)?;
                let cfg = KubeConfigState::load();
                let ns = v.get("namespace").and_then(Value::as_str).unwrap_or("default");
                let name = v.get("name").and_then(Value::as_str).unwrap_or("");
                let sub = v.get("sub").and_then(Value::as_str).unwrap_or("values");
                match fetch_helm_release_detail(&project, &cfg, ns, name, sub) {
                    Ok(out) => Self::post_detail(out, None, false),
                    Err(e) => Self::post_detail(e.to_string(), Some(e.to_string()), true),
                }
            }
            "open-location" => {
                if let Some(path) = v.get("path").and_then(Value::as_str) {
                    let line = v.get("line").and_then(Value::as_u64).unwrap_or(0) as u32;
                    host::open_location(path, line, 0)?;
                }
            }
            "editor-action" => {
                let act = v.get("action").and_then(Value::as_str).unwrap_or("apply");
                match self.run_manifest_command(act, ctx) {
                    Ok(out) => {
                        if act == "apply"
                            && let Ok(project) = resolve_project(ctx)
                        {
                            self.refresh_cluster(&project);
                            self.post_state(ctx);
                        }
                        Self::post_detail(out.clone(), Some(format!("kubectl {act} succeeded")), false);
                    }
                    Err(e) => Self::post_detail(e.to_string(), Some(e.to_string()), true),
                }
            }
            "kustomize-build" => match self.run_kustomize_command(ctx, None) {
                Ok(out) => Self::post_detail(out, Some("Rendered Kustomize overlay".into()), false),
                Err(e) => Self::post_detail(e.to_string(), Some(e.to_string()), true),
            },
            "helm-template" => match self.run_helm_template_command(ctx, None) {
                Ok(out) => Self::post_detail(out, Some("Rendered Helm chart templates".into()), false),
                Err(e) => Self::post_detail(e.to_string(), Some(e.to_string()), true),
            },
            _ => {}
        }
        Ok(())
    }

    fn run_manifest_command(&mut self, subcommand: &str, ctx: &Invocation) -> Result<String, Error> {
        let editor =
            ctx.editor().ok_or_else(|| Error::Invalid("focus a Kubernetes YAML file in the editor first".into()))?;
        let doc = editor.document()?;
        let project = resolve_project(ctx)?;
        let cfg = KubeConfigState::load();
        let out = apply_or_diff_manifest(&project, &cfg, &doc.text, subcommand)?;
        let title = match subcommand {
            "apply" => "Kubernetes Apply",
            "diff" => "Kubernetes Diff",
            "delete" => "Kubernetes Delete",
            "dry-run" => "Kubernetes Dry Run",
            _ => "Kubernetes",
        };
        let preview = out.lines().next().unwrap_or("Done");
        host::notify(NotificationLevel::Info, title, preview);
        Ok(out)
    }

    fn run_kustomize_command(&self, ctx: &Invocation, arg: Option<&str>) -> Result<String, Error> {
        let project = resolve_project(ctx)?;
        let dir = arg
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .or_else(|| {
                ctx.editor().map(|e| {
                    let p = normalize_slashes(&e.path());
                    let root = project.root().ok().map(|r| normalize_slashes(&r)).unwrap_or_default();
                    let rel = p.strip_prefix(&root).map(|r| r.trim_start_matches('/')).unwrap_or(&p);
                    match rel.rfind('/') {
                        Some(i) => rel[..i].to_owned(),
                        None => ".".into(),
                    }
                })
            })
            .unwrap_or_else(|| ".".into());
        let out = build_kustomize(&project, &dir)?;
        let lines = out.lines().count();
        host::notify(NotificationLevel::Info, "Kustomize Build", &format!("Rendered {lines} lines from '{dir}'"));
        Ok(out)
    }

    fn run_helm_template_command(&self, ctx: &Invocation, arg: Option<&str>) -> Result<String, Error> {
        let project = resolve_project(ctx)?;
        let dir = arg.filter(|s| !s.is_empty()).unwrap_or(".");
        let out = render_helm_template(&project, dir)?;
        let lines = out.lines().count();
        host::notify(NotificationLevel::Info, "Helm Template", &format!("Rendered {lines} lines from chart '{dir}'"));
        Ok(out)
    }
}

impl Plugin for KubernetesPlugin {
    fn activate(&mut self, _ctx: &Context) -> Result<(), Error> {
        let cfg = KubeConfigState::load();
        self.update_status_bar(&cfg);
        Ok(())
    }

    fn run_command(&mut self, id: &str, ctx: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "refresh" => {
                let project = resolve_project(ctx)?;
                self.index.built_at = None;
                let snap = self.refresh_cluster(&project);
                self.post_state(ctx);
                if let Some(err) = snap.error {
                    return Err(Error::Failed(err));
                }
                let msg = format!(
                    "Context '{}' ({}): {} resources loaded",
                    snap.current_context,
                    if snap.all_namespaces { "all namespaces" } else { snap.current_namespace.as_str() },
                    snap.resources.len()
                );
                host::notify(NotificationLevel::Info, "Kubernetes", &msg);
                Ok(Some(msg))
            }
            "switch-context" => {
                let project = resolve_project(ctx)?;
                let cfg = KubeConfigState::load();
                let next = if let Some(explicit) = arg.filter(|s| !s.trim().is_empty()) {
                    explicit.trim().to_owned()
                } else {
                    let (current, contexts, _, _) = fetch_kubeconfig_overview(&project, &cfg)?;
                    if contexts.is_empty() {
                        return Err(Error::NotFound("no contexts found in kubeconfig".into()));
                    }
                    let pos = contexts.iter().position(|c| *c == current).unwrap_or(0);
                    contexts[(pos + 1) % contexts.len()].clone()
                };
                storage::set("context", &next)?;
                let mut updated = KubeConfigState::load();
                updated.context = next.clone();
                self.update_status_bar(&updated);
                self.refresh_cluster(&project);
                self.post_state(ctx);
                host::notify(NotificationLevel::Info, "Kubernetes Context", &format!("Active context set to '{next}'"));
                Ok(Some(next))
            }
            "switch-namespace" => {
                let project = resolve_project(ctx)?;
                let next = if let Some(explicit) = arg.filter(|s| !s.trim().is_empty()) {
                    explicit.trim().to_owned()
                } else {
                    let snap = match self.snapshot.clone() {
                        Some(s) if !s.namespaces.is_empty() => s,
                        _ => self.refresh_cluster(&project),
                    };
                    let cur = &snap.current_namespace;
                    let pos = snap.namespaces.iter().position(|n| n == cur).unwrap_or(0);
                    snap.namespaces
                        .get((pos + 1) % snap.namespaces.len().max(1))
                        .cloned()
                        .unwrap_or_else(|| "default".into())
                };
                storage::set("namespace", &next)?;
                storage::set("allNamespaces", "false")?;
                let mut updated = KubeConfigState::load();
                updated.namespace = next.clone();
                updated.all_namespaces = false;
                self.update_status_bar(&updated);
                self.refresh_cluster(&project);
                self.post_state(ctx);
                host::notify(
                    NotificationLevel::Info,
                    "Kubernetes Namespace",
                    &format!("Active namespace set to '{next}'"),
                );
                Ok(Some(next))
            }
            "apply" => {
                if let Some(raw) = arg.filter(|s| s.trim_start().starts_with('{'))
                    && let Ok(v) = serde_json::from_str::<Value>(raw)
                    && v.get("op").and_then(Value::as_str) == Some("live-yaml-apply")
                {
                    let _task = host::begin_task("Kubernetes: Applying resource YAML", false);
                    let project = resolve_project(ctx)?;
                    let mut cfg = KubeConfigState::load();
                    if let Some(c) = v.get("context").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                        cfg.context = c.to_owned();
                    }
                    if let Some(ns) = v.get("namespace").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                        cfg.namespace = ns.to_owned();
                    }
                    let yaml_text = v.get("yaml").and_then(Value::as_str).unwrap_or("");
                    let out = apply_or_diff_manifest(&project, &cfg, yaml_text, "apply")?;
                    if let Some(kind) = v.get("kind").and_then(Value::as_str)
                        && let Some(ref mut snap) = self.snapshot
                    {
                        fetch_category_into_snapshot(&project, &cfg, snap, kind);
                        self.post_snapshot(false);
                    }
                    return Ok(Some(out));
                }
                self.run_manifest_command("apply", ctx).map(Some)
            }
            "diff" => {
                if let Some(raw) = arg.filter(|s| s.trim_start().starts_with('{'))
                    && let Ok(v) = serde_json::from_str::<Value>(raw)
                    && v.get("op").and_then(Value::as_str) == Some("live-yaml-diff")
                {
                    let _task = host::begin_task("Kubernetes: Diffing resource YAML", false);
                    let project = resolve_project(ctx)?;
                    let mut cfg = KubeConfigState::load();
                    if let Some(c) = v.get("context").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                        cfg.context = c.to_owned();
                    }
                    if let Some(ns) = v.get("namespace").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                        cfg.namespace = ns.to_owned();
                    }
                    let yaml_text = v.get("yaml").and_then(Value::as_str).unwrap_or("");
                    let out = apply_or_diff_manifest(&project, &cfg, yaml_text, "diff")?;
                    return Ok(Some(out));
                }
                self.run_manifest_command("diff", ctx).map(Some)
            }
            "delete-manifest" => self.run_manifest_command("delete", ctx).map(Some),
            "dry-run" => {
                if let Some(editor) = ctx.editor() {
                    let _ = self.check_and_publish(&editor.path(), true);
                }
                self.run_manifest_command("dry-run", ctx).map(Some)
            }
            "inspect" => {
                if let Some(raw) = arg.filter(|s| s.trim_start().starts_with('{'))
                    && let Ok(v) = serde_json::from_str::<Value>(raw)
                    && v.get("op").and_then(Value::as_str) == Some("live-yaml-get")
                {
                    let _task = host::begin_task("Kubernetes: Loading resource YAML", false);
                    let project = resolve_project(ctx)?;
                    let mut cfg = KubeConfigState::load();
                    if let Some(c) = v.get("context").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                        cfg.context = c.to_owned();
                    }
                    let kind = v.get("kind").and_then(Value::as_str).unwrap_or("Pod");
                    let ns = v.get("namespace").and_then(Value::as_str).unwrap_or("");
                    let name = v.get("name").and_then(Value::as_str).unwrap_or("");
                    let yaml = inspect_cluster_resource(&project, &cfg, kind, ns, name, true)?;
                    return Ok(Some(yaml));
                }
                let editor = ctx.editor().ok_or_else(|| Error::Invalid("focus a YAML file first".into()))?;
                let path = editor.path();
                let count = self.check_and_publish(&path, false)?;
                let msg = format!("{count} issue(s) found");
                host::notify(NotificationLevel::Info, "Kubernetes Inspection", &msg);
                Ok(Some(msg))
            }
            "scan-project" => self.scan_project_manifests(ctx).map(Some),
            "follow-logs" => {
                let cfg = KubeConfigState::load();
                let (ns, pod, container) = self.resolve_pod_target(ctx, arg, &cfg)?;
                open_follow_logs_terminal(&cfg, &ns, &pod, container.as_deref())?;
                Ok(Some(format!("{ns}/{pod}")))
            }
            "exec-shell" => {
                let cfg = KubeConfigState::load();
                let (ns, pod, container) = self.resolve_pod_target(ctx, arg, &cfg)?;
                open_exec_terminal(&cfg, &ns, &pod, container.as_deref())?;
                Ok(Some(format!("{ns}/{pod}")))
            }
            "port-forward" => {
                let cfg = KubeConfigState::load();
                let (kind, ns, name, port) = self.resolve_port_forward_target(ctx, arg, &cfg)?;
                open_port_forward_terminal(&cfg, &kind, &ns, &name, &port)?;
                Ok(Some(format!("{kind}/{name}:{port}")))
            }
            "scale" => {
                let project = resolve_project(ctx)?;
                let cfg = KubeConfigState::load();
                let (kind, ns, name, replicas) = self.resolve_scale_target(ctx, arg, &cfg)?;
                let out = scale_workload(&project, &cfg, &kind, &ns, &name, replicas)?;
                host::notify(NotificationLevel::Info, "Kubernetes Scale", &out);
                Ok(Some(out))
            }
            "rollout-restart" => {
                let project = resolve_project(ctx)?;
                let cfg = KubeConfigState::load();
                let (kind, ns, name) = self.resolve_workload_target(ctx, arg, &cfg)?;
                let out = rollout_restart(&project, &cfg, &kind, &ns, &name)?;
                host::notify(NotificationLevel::Info, "Kubernetes Rollout Restart", &out);
                Ok(Some(out))
            }
            "kustomize-build" => self.run_kustomize_command(ctx, arg).map(Some),
            "helm-template" => self.run_helm_template_command(ctx, arg).map(Some),
            _ => Err(Error::NotFound(format!("command {id}"))),
        }
    }

    fn handle_events(&mut self, events: &[Event], _ctx: &Invocation) {
        let _task = host::begin_task("Kubernetes: Inspecting manifest", false);
        let validate_on_save = host::setting_bool("validateOnSave").unwrap_or(true);
        for event in events {
            match event {
                Event::FileOpened(path) | Event::FileSaved(path)
                    if validate_on_save && (path.ends_with(".yaml") || path.ends_with(".yml")) =>
                {
                    let _ = self.check_and_publish(path, false);
                }
                _ => {}
            }
        }
    }
}

impl KubernetesPlugin {
    /// Resolves `(namespace, pod_name, container)` from `arg` (`ns/pod/container` or `pod`),
    /// active editor YAML, or the first running Pod in the cluster snapshot.
    fn resolve_pod_target(
        &mut self,
        ctx: &Invocation,
        arg: Option<&str>,
        cfg: &KubeConfigState,
    ) -> Result<(String, String, Option<String>), Error> {
        if let Some(a) = arg.filter(|s| !s.trim().is_empty()) {
            let parts: Vec<&str> = a.trim().split('/').collect();
            return Ok(match parts.as_slice() {
                [pod] => (cfg.namespace.clone(), (*pod).to_owned(), None),
                [ns, pod] => ((*ns).to_owned(), (*pod).to_owned(), None),
                [ns, pod, c, ..] => ((*ns).to_owned(), (*pod).to_owned(), Some((*c).to_owned())),
                _ => (cfg.namespace.clone(), a.trim().to_owned(), None),
            });
        }
        if let Some(editor) = ctx.editor()
            && let Ok(doc) = editor.document()
        {
            let parsed = parse_yaml(&doc.text);
            if let Some(kdoc) = parsed.docs.iter().find(|d| d.kind.as_ref().is_some_and(|k| k.value == "Pod"))
                && let Some(ref n) = kdoc.name
            {
                let ns = kdoc.namespace.as_ref().map_or_else(|| cfg.namespace.clone(), |s| s.value.clone());
                let c = kdoc.containers.first().and_then(|c| c.name.as_ref().map(|s| s.value.clone()));
                return Ok((ns, n.value.clone(), c));
            }
        }
        if self.snapshot.is_none()
            && let Ok(project) = resolve_project(ctx)
        {
            self.refresh_cluster(&project);
        }
        if let Some(ref snap) = self.snapshot
            && let Some(pod) = snap.resources.iter().find(|r| r.kind == "Pod")
        {
            let ns = if pod.namespace.is_empty() { cfg.namespace.clone() } else { pod.namespace.clone() };
            return Ok((ns, pod.name.clone(), pod.containers.first().cloned()));
        }
        Err(Error::NotFound("no Pod found in active editor or cluster".into()))
    }

    fn resolve_port_forward_target(
        &mut self,
        ctx: &Invocation,
        arg: Option<&str>,
        cfg: &KubeConfigState,
    ) -> Result<(String, String, String, String), Error> {
        if let Some(a) = arg.filter(|s| !s.trim().is_empty()) {
            // Format: `Service/ns/my-svc:8080:80` or `my-pod:8080`
            let (target, port) = a.trim().split_once(':').unwrap_or((a.trim(), "8080"));
            let parts: Vec<&str> = target.split('/').collect();
            return Ok(match parts.as_slice() {
                [name] => ("Pod".into(), cfg.namespace.clone(), (*name).to_owned(), port.to_owned()),
                [kind, name] => ((*kind).to_owned(), cfg.namespace.clone(), (*name).to_owned(), port.to_owned()),
                [kind, ns, name, ..] => ((*kind).to_owned(), (*ns).to_owned(), (*name).to_owned(), port.to_owned()),
                _ => ("Pod".into(), cfg.namespace.clone(), target.to_owned(), port.to_owned()),
            });
        }
        if let Some(editor) = ctx.editor()
            && let Ok(doc) = editor.document()
        {
            let parsed = parse_yaml(&doc.text);
            if let Some(kdoc) = parsed.docs.first()
                && let (Some(kind), Some(name)) = (&kdoc.kind, &kdoc.name)
            {
                let ns = kdoc.namespace.as_ref().map_or_else(|| cfg.namespace.clone(), |s| s.value.clone());
                let port = kdoc
                    .service_ports
                    .first()
                    .and_then(|p| p.port.as_ref().map(|s| s.value.clone()))
                    .or_else(|| kdoc.containers.first().and_then(|c| c.ports.first().map(|p| p.value.clone())))
                    .unwrap_or_else(|| "8080".into());
                return Ok((kind.value.clone(), ns, name.value.clone(), port));
            }
        }
        let (ns, pod, _) = self.resolve_pod_target(ctx, None, cfg)?;
        Ok(("Pod".into(), ns, pod, "8080".into()))
    }

    fn resolve_workload_target(
        &mut self,
        ctx: &Invocation,
        arg: Option<&str>,
        cfg: &KubeConfigState,
    ) -> Result<(String, String, String), Error> {
        if let Some(a) = arg.filter(|s| !s.trim().is_empty()) {
            let parts: Vec<&str> = a.trim().split('/').collect();
            return Ok(match parts.as_slice() {
                [name] => ("Deployment".into(), cfg.namespace.clone(), (*name).to_owned()),
                [kind, name] => ((*kind).to_owned(), cfg.namespace.clone(), (*name).to_owned()),
                [kind, ns, name, ..] => ((*kind).to_owned(), (*ns).to_owned(), (*name).to_owned()),
                _ => ("Deployment".into(), cfg.namespace.clone(), a.trim().to_owned()),
            });
        }
        if let Some(editor) = ctx.editor()
            && let Ok(doc) = editor.document()
        {
            let parsed = parse_yaml(&doc.text);
            if let Some(kdoc) = parsed.docs.iter().find(|d| d.is_workload())
                && let (Some(kind), Some(name)) = (&kdoc.kind, &kdoc.name)
            {
                let ns = kdoc.namespace.as_ref().map_or_else(|| cfg.namespace.clone(), |s| s.value.clone());
                return Ok((kind.value.clone(), ns, name.value.clone()));
            }
        }
        if self.snapshot.is_none()
            && let Ok(project) = resolve_project(ctx)
        {
            self.refresh_cluster(&project);
        }
        if let Some(ref snap) = self.snapshot
            && let Some(w) =
                snap.resources.iter().find(|r| matches!(r.kind.as_str(), "Deployment" | "StatefulSet" | "DaemonSet"))
        {
            return Ok((w.kind.clone(), w.namespace.clone(), w.name.clone()));
        }
        Err(Error::NotFound("no Deployment/StatefulSet/DaemonSet found".into()))
    }

    fn resolve_scale_target(
        &mut self,
        ctx: &Invocation,
        arg: Option<&str>,
        cfg: &KubeConfigState,
    ) -> Result<(String, String, String, u32), Error> {
        if let Some(a) = arg.filter(|s| !s.trim().is_empty())
            && let Some((target, rep_str)) = a.trim().split_once('=')
        {
            let replicas =
                rep_str.parse::<u32>().map_err(|_| Error::Invalid(format!("invalid replica count: {rep_str}")))?;
            let (kind, ns, name) = self.resolve_workload_target(ctx, Some(target), cfg)?;
            return Ok((kind, ns, name, replicas));
        }
        let (kind, ns, name) = self.resolve_workload_target(ctx, arg, cfg)?;
        let replicas = ctx
            .editor()
            .and_then(|e| e.document().ok())
            .and_then(|d| {
                parse_yaml(&d.text).docs.into_iter().find_map(|k| k.replicas.and_then(|r| r.value.parse::<u32>().ok()))
            })
            .unwrap_or(1);
        Ok((kind, ns, name, replicas))
    }
}

impl Providers for KubernetesPlugin {
    fn completion(&mut self, doc: &Document, at: Position, _trigger: Option<&str>) -> Vec<CompletionItem> {
        let proj = project_of(&doc.path);
        self.index.ensure(proj.as_ref(), Some((&doc.path, &doc.text)));
        let parsed =
            self.index.files.get(&normalize_slashes(&doc.path)).cloned().unwrap_or_else(|| parse_yaml(&doc.text));
        let mut items = completions_at(&self.index, doc, at, &parsed);

        // Enrich ConfigMap/Secret/Service/ServiceAccount/PVC/CRD completions from the cached live cluster snapshot!
        if let Some(ref snap) = self.snapshot {
            let (parent_path, current_line, _) = manifest::yaml_context_at(&doc.text, at);
            let trimmed = current_line.trim_start();
            if let Some(colon) = trimmed.find(':') {
                let key = trimmed[..colon].trim().trim_start_matches("- ").trim();
                let raw_val = trimmed[colon + 1..].trim_start();
                let start_col = at.character.saturating_sub(utf16_len(raw_val));
                let replace = Range::new(Position::new(at.line, start_col), at);
                let full_key = if parent_path.is_empty() { key.to_owned() } else { format!("{parent_path}.{key}") };

                let target_kind = if full_key.contains("configMapKeyRef.name")
                    || full_key.contains("configMapRef.name")
                    || full_key.ends_with("configMap.name")
                {
                    Some("ConfigMap")
                } else if full_key.contains("secretKeyRef.name")
                    || full_key.contains("secretRef.name")
                    || full_key.ends_with("secret.secretName")
                    || full_key.ends_with("tls.secretName")
                {
                    Some("Secret")
                } else if full_key.ends_with("backend.service.name") {
                    Some("Service")
                } else if full_key.ends_with("persistentVolumeClaim.claimName") {
                    Some("PersistentVolumeClaim")
                } else {
                    None
                };

                if let Some(tk) = target_kind {
                    for r in snap.resources.iter().filter(|r| r.kind == tk) {
                        if !items.iter().any(|i| i.label == r.name) {
                            items.push(CompletionItem {
                                replace: Some(replace),
                                detail: Some(format!("Cluster {tk} ({})", r.namespace)),
                                ..CompletionItem::new(&r.name, CompletionKind::Reference)
                            });
                        }
                    }
                } else if full_key.ends_with("configMapKeyRef.key") || full_key.ends_with("secretKeyRef.key") {
                    let tk = if full_key.contains("configMapKeyRef") { "ConfigMap" } else { "Secret" };
                    for r in snap.resources.iter().filter(|r| r.kind == tk) {
                        for dk in &r.data_keys {
                            if !items.iter().any(|i| i.label == *dk) {
                                items.push(CompletionItem {
                                    replace: Some(replace),
                                    detail: Some(format!("Cluster {tk} '{}' ({})", r.name, r.namespace)),
                                    ..CompletionItem::new(dk, CompletionKind::Property)
                                });
                            }
                        }
                    }
                } else if full_key == "metadata.namespace" {
                    for ns in &snap.namespaces {
                        if !items.iter().any(|i| i.label == *ns) {
                            items.push(CompletionItem {
                                replace: Some(replace),
                                detail: Some("Cluster Namespace".into()),
                                ..CompletionItem::new(ns, CompletionKind::Module)
                            });
                        }
                    }
                }
            }
        }

        items
    }

    fn code_actions(&mut self, doc: &Document, selection: Range) -> Vec<CodeAction> {
        let proj = project_of(&doc.path);
        self.index.ensure(proj.as_ref(), Some((&doc.path, &doc.text)));
        let parsed =
            self.index.files.get(&normalize_slashes(&doc.path)).cloned().unwrap_or_else(|| parse_yaml(&doc.text));
        let warn_latest = host::setting_bool("warnLatestTag").unwrap_or(true);
        let warn_resources = host::setting_bool("warnMissingResources").unwrap_or(true);
        let issues = inspect_document(&self.index, &doc.path, &doc.text, &parsed, warn_latest, warn_resources);
        let mut actions = Vec::new();
        let mut seen_titles = std::collections::BTreeSet::new();
        for issue in issues {
            let d_line = issue.diagnostic.range.start.line;
            let overlaps = d_line >= selection.start.line && d_line <= selection.end.line;
            let is_file_level = issue.fix.as_ref().is_some_and(|f| f.title.contains("# nonk8s"));
            if (overlaps || is_file_level)
                && let Some(fix) = issue.fix
                && seen_titles.insert(fix.title.clone())
            {
                actions.push(fix);
            }
        }
        actions
    }

    fn definition(&mut self, doc: &Document, at: Position) -> Vec<Location> {
        let proj = project_of(&doc.path);
        self.index.ensure(proj.as_ref(), Some((&doc.path, &doc.text)));
        let parsed =
            self.index.files.get(&normalize_slashes(&doc.path)).cloned().unwrap_or_else(|| parse_yaml(&doc.text));
        definitions_at(&self.index, doc, at, &parsed)
    }

    fn line_markers(&mut self, doc: &Document) -> Vec<LineMarker> {
        let proj = project_of(&doc.path);
        self.index.ensure(proj.as_ref(), Some((&doc.path, &doc.text)));
        let parsed =
            self.index.files.get(&normalize_slashes(&doc.path)).cloned().unwrap_or_else(|| parse_yaml(&doc.text));
        line_markers_for(&self.index, doc, &parsed)
    }
}

impl Views for KubernetesPlugin {
    fn render(&mut self, view: &str, _viewport: Option<Viewport>, ctx: &Invocation) -> Result<View, Error> {
        if view != VIEW_ID {
            return Err(Error::NotFound(view.into()));
        }
        // Only load kubeconfig contexts & workspace manifests synchronously during initial render
        // so the tool window opens immediately and never times out; the page then requests
        // live cluster resources via `postMessage({op: "refresh"})` inside a background Task.
        let project = resolve_project(ctx).ok();
        let root = project.as_ref().and_then(|p| p.root().ok()).unwrap_or_default();
        self.index.ensure(project.as_ref(), None);
        let mut cfg = KubeConfigState::load();
        if let Some(ref p) = project {
            self.ensure_catalog_loaded(p, &mut cfg);
        }
        self.update_status_bar(&cfg);
        let snap = self.snapshot.clone().unwrap_or_default();
        let ws = workspace_manifests_json(&self.index.files, &root);
        let initial = json!({
            "op": "state",
            "snapshot": snap,
            "workspace": ws,
            "needsClusterFetch": snap.resources.is_empty() && snap.error.is_none(),
        });
        let status_line = if let Some(ref err) = snap.error {
            format!("Disconnected: {err}")
        } else {
            format!(
                "Context: {} • Namespace: {} • {} cluster resources • {} workspace files",
                if snap.current_context.is_empty() { "default" } else { snap.current_context.as_str() },
                if snap.all_namespaces { "all" } else { snap.current_namespace.as_str() },
                snap.resources.len(),
                self.index.files.len()
            )
        };
        let initial_b64 = base64_encode(initial.to_string().as_bytes());
        let html = PAGE_HTML.replacen("__START_B64__", &initial_b64, 1);
        Ok(View::new(Body::Html(html))
            .button(Button::new("refresh", "Refresh Cluster").icon("refresh"))
            .button(Button::new("apply", "Apply Active YAML").icon("run"))
            .button(Button::new("scan", "Inspect Project Manifests"))
            .status(&status_line))
    }

    fn handle(&mut self, view: &str, event: ViewEvent, ctx: &Invocation) -> Result<(), Error> {
        if view != VIEW_ID {
            return Err(Error::NotFound(view.into()));
        }
        match event {
            ViewEvent::Button(id) => match id.as_str() {
                "refresh" => {
                    let project = resolve_project(ctx)?;
                    self.index.built_at = None;
                    self.refresh_cluster(&project);
                    self.post_state(ctx);
                    host::refresh_view(VIEW_ID);
                }
                "apply" => {
                    let out = self.run_manifest_command("apply", ctx)?;
                    if let Ok(project) = resolve_project(ctx) {
                        self.refresh_cluster(&project);
                    }
                    self.post_state(ctx);
                    Self::post_detail(out, Some("Applied active manifest".into()), false);
                }
                "scan" => {
                    let summary = self.scan_project_manifests(ctx)?;
                    Self::post_detail(summary.clone(), Some(summary), false);
                }
                _ => {}
            },
            ViewEvent::Message(raw) => {
                self.handle_page_message(&raw, ctx)?;
            }
            _ => {}
        }
        Ok(())
    }
}

register_plugin!(KubernetesPlugin, providers, views);

#[cfg(test)]
mod tests {
    use super::*;
    use openidea_plugin::ProcessOutput;
    use openidea_plugin::mock::MockHost;

    const SAMPLE_MANIFEST: &str = r#"apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  DATABASE_URL: "postgres://db:5432/app"
  LOG_LEVEL: "info"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-api
  labels:
    app.kubernetes.io/name: web-api
spec:
  replicas: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: web-api
  template:
    metadata:
      labels:
        app.kubernetes.io/name: web-api
    spec:
      serviceAccountName: web-sa
      containers:
        - name: api
          image: ghcr.io/acme/web-api:1.4.2
          ports:
            - name: http
              containerPort: 8080
          env:
            - name: DB
              valueFrom:
                configMapKeyRef:
                  name: app-config
                  key: DATABASE_URL
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
---
apiVersion: v1
kind: Service
metadata:
  name: web-svc
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: web-api
  ports:
    - name: http
      port: 80
      targetPort: http
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web-ing
spec:
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web-svc
                port:
                  name: http
"#;

    const KUBECONFIG_JSON: &str = r#"{
        "current-context": "prod-east",
        "contexts": [
            {"name": "dev-local", "context": {"namespace": "dev"}},
            {"name": "prod-east", "context": {"namespace": "production"}}
        ]
    }"#;

    const RESOURCES_JSON: &str = r#"{
        "kind": "List",
        "items": [
            {
                "kind": "Pod",
                "metadata": {"name": "web-api-7f8b9-abc", "namespace": "production", "creationTimestamp": "2026-11-05T12:00:00Z"},
                "spec": {"nodeName": "node-1", "containers": [{"name": "api", "ports": [{"containerPort": 8080}]}]},
                "status": {
                    "phase": "Running",
                    "podIP": "10.244.0.14",
                    "containerStatuses": [{"name": "api", "ready": true, "restartCount": 1}]
                }
            },
            {
                "kind": "Deployment",
                "metadata": {"name": "web-api", "namespace": "production"},
                "spec": {"replicas": 3, "containers": [{"name": "api"}]},
                "status": {"readyReplicas": 3, "updatedReplicas": 3}
            },
            {
                "kind": "ConfigMap",
                "metadata": {"name": "cluster-cm", "namespace": "production"},
                "data": {"CLUSTER_KEY": "1", "FEATURE_FLAG": "true"}
            }
        ]
    }"#;

    fn install_mock_with_kubectl() -> MockHost {
        let host = MockHost::install().with_capabilities(&[
            "project.read",
            "editor.read",
            "editor.write",
            "events",
            "storage",
            "clipboard",
            "process:kubectl",
            "process:helm",
            "process:kustomize",
        ]);
        host.on_process("kubectl", |args, _stdin| {
            let joined = args.join(" ");
            let stdout = if joined.contains("config view") {
                KUBECONFIG_JSON.to_owned()
            } else if joined.contains("get namespaces") {
                "default Active 10d\nproduction Active 10d\n".to_owned()
            } else if joined.contains("get nodes") {
                r#"{"kind":"List","items":[{"kind":"Node","metadata":{"name":"node-1"},"status":{"conditions":[{"type":"Ready","status":"True"}],"nodeInfo":{"kubeletVersion":"v1.32.0"}}}]}"#.to_owned()
            } else if joined.contains("get crd") {
                "certificates.cert-manager.io cert-manager.io Certificate Namespaced 10d\n".to_owned()
            } else if joined.contains("get pods,deployments") {
                RESOURCES_JSON.to_owned()
            } else if joined.contains("get secrets") {
                "production app-secret Opaque 5d\n".to_owned()
            } else if joined.contains("get events") {
                r#"{"kind":"List","items":[{"involvedObject":{"kind":"Pod","name":"web-api-7f8b9-abc"},"metadata":{"namespace":"production"},"reason":"Started","message":"Started container api","type":"Normal","count":1,"lastTimestamp":"2026-11-05T12:00:05Z"}]}"#.to_owned()
            } else if joined.contains("logs ") {
                "2026-11-05T12:01:00Z INFO Listening on :8080\n2026-11-05T12:01:05Z ERROR Database timeout\n".to_owned()
            } else if joined.contains("describe ") {
                "Name:         web-api-7f8b9-abc\nNamespace:    production\nStatus:       Running\n".to_owned()
            } else if joined.contains("-o yaml") {
                "apiVersion: v1\nkind: Pod\nmetadata:\n  name: web-api-7f8b9-abc\n".to_owned()
            } else if joined.contains("scale ") {
                "deployment.apps/web-api scaled\n".to_owned()
            } else if joined.contains("rollout restart") {
                "deployment.apps/web-api restarted\n".to_owned()
            } else if joined.contains("apply ") {
                "deployment.apps/web-api configured\n".to_owned()
            } else if joined.contains("kustomize ") {
                "apiVersion: v1\nkind: Service\nmetadata:\n  name: kustomized-svc\n".to_owned()
            } else {
                String::new()
            };
            Ok(ProcessOutput { status: Some(0), stdout, stderr: String::new() })
        });
        host.on_process("helm", |args, _stdin| {
            let joined = args.join(" ");
            let stdout = if joined.contains("list ") {
                r#"[{"name":"ingress-nginx","namespace":"production","revision":"4","status":"deployed","chart":"ingress-nginx-4.11.0","app_version":"1.11.0"}]"#.to_owned()
            } else if joined.contains("template ") {
                "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: rendered-chart\n".to_owned()
            } else {
                "replicaCount: 2\n".to_owned()
            };
            Ok(ProcessOutput { status: Some(0), stdout, stderr: String::new() })
        });
        host
    }

    #[test]
    fn parses_multi_doc_manifests_and_navigates_cross_resource() {
        let host = MockHost::install();
        host.add_file("k8s/app.yaml", SAMPLE_MANIFEST);
        let mut plugin = KubernetesPlugin::default();
        let doc = Document {
            path: "/project/k8s/app.yaml".into(),
            language: "yaml".into(),
            version: 1,
            text: SAMPLE_MANIFEST.into(),
        };

        // Gutter line markers on ConfigMap ref, Workload exposed by Service, Service selector, Ingress backend
        let markers = plugin.line_markers(&doc);
        assert!(markers.len() >= 5, "expected at least 5 gutter markers, got {markers:?}");
        assert!(markers.iter().any(|m| m.tooltip.contains("Exposed by Service 'web-svc'")));
        assert!(markers.iter().any(|m| m.tooltip.contains("Go to matching Deployment 'web-api'")));
        assert!(markers.iter().any(|m| m.tooltip.contains("Go to ConfigMap 'app-config'")));
        assert!(markers.iter().any(|m| m.tooltip.contains("Go to key 'DATABASE_URL'")));
        assert!(markers.iter().any(|m| m.tooltip.contains("Go to Service 'web-svc'")));

        // Go to Definition from `key: DATABASE_URL` (line 36) jumps to line 5 in ConfigMap `data:`
        let defs = plugin.definition(&doc, Position::new(36, 25));
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].range.start.line, 5);

        // Go to Definition from Service `targetPort: http` (line 56) jumps to container port `name: http` (line 29)
        let port_defs = plugin.definition(&doc, Position::new(56, 20));
        assert_eq!(port_defs.len(), 1);
        assert_eq!(port_defs[0].range.start.line, 29);
    }

    #[test]
    fn helm_values_and_named_templates_complete_and_navigate() {
        let host = MockHost::install();
        host.add_file("chart/values.yaml", "image:\n  repository: nginx\n  tag: \"1.27.0\"\nreplicaCount: 3\n");
        host.add_file(
            "chart/templates/_helpers.tpl",
            "{{- define \"mychart.fullname\" -}}\n{{ .Chart.Name }}\n{{- end -}}\n",
        );
        let tpl = "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ include \"mychart.fullname\" . }}\nspec:\n  replicas: {{ .Values.replicaCount }}\n  template:\n    spec:\n      containers:\n        - name: app\n          image: \"{{ .Values.image.tag }}\"\n";
        host.add_file("chart/templates/deployment.yaml", tpl);

        let mut plugin = KubernetesPlugin::default();
        let doc = Document {
            path: "/project/chart/templates/deployment.yaml".into(),
            language: "yaml".into(),
            version: 1,
            text: tpl.into(),
        };

        // Jump from `.Values.image.tag` (line 10) to `values.yaml` line 2
        let defs = plugin.definition(&doc, Position::new(10, 32));
        assert_eq!(defs.len(), 1);
        assert!(defs[0].path.ends_with("chart/values.yaml"));
        assert_eq!(defs[0].range.start.line, 2);

        // Jump from `include "mychart.fullname"` (line 3) to `_helpers.tpl` line 0
        let tpl_defs = plugin.definition(&doc, Position::new(3, 24));
        assert_eq!(tpl_defs.len(), 1);
        assert!(tpl_defs[0].path.ends_with("chart/templates/_helpers.tpl"));
        assert_eq!(tpl_defs[0].range.start.line, 0);

        // Complete `.Values.im`
        let editing = tpl.replace(".Values.image.tag", ".Values.im");
        let edit_doc = Document { text: editing, ..doc };
        let items = plugin.completion(&edit_doc, Position::new(10, 29), None);
        let labels: Vec<&str> = items.iter().map(|i| i.label.as_str()).collect();
        assert!(labels.contains(&"image.tag") && labels.contains(&"image.repository"), "{labels:?}");
    }

    #[test]
    fn inspections_and_quick_fixes_cover_deprecated_apis_labels_images_and_keys() {
        let host = MockHost::install();
        let bad_yaml = r#"apiVersion: extensions/v1beta1
kind: Deployment
metadata:
  name: legacy-app
  uid: 1234-5678
spec:
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: wrong-label
    spec:
      containers:
        - name: app
          image: nginx:latest
          imagePullPolicy: InvalidPolicy
          securityContext:
            privileged: true
"#;
        host.add_file("deploy.yaml", bad_yaml);
        let mut plugin = KubernetesPlugin::default();
        let count = plugin.check_and_publish("/project/deploy.yaml", false).unwrap();
        assert!(count >= 6, "expected at least 6 diagnostics, got {count}");

        let diags = host.diagnostics();
        let file_diags = &diags["/project/deploy.yaml"];
        let codes: Vec<_> = file_diags.iter().filter_map(|d| d.code.as_deref()).collect();
        assert!(codes.contains(&"deprecated-api-version"), "{codes:?}");
        assert!(codes.contains(&"selector-label-mismatch"), "{codes:?}");
        assert!(codes.contains(&"image-latest-tag"), "{codes:?}");
        assert!(codes.contains(&"missing-resource-limits"), "{codes:?}");
        assert!(codes.contains(&"privileged-container"), "{codes:?}");
        assert!(codes.contains(&"readonly-field"), "{codes:?}");
        assert!(codes.contains(&"invalid-enum-value"), "{codes:?}");

        // Quick fix on line 0 upgrades `extensions/v1beta1` to `apps/v1`
        let doc = Document {
            path: "/project/deploy.yaml".into(),
            language: "yaml".into(),
            version: 1,
            text: bad_yaml.into(),
        };
        let actions = plugin.code_actions(&doc, Range::new(Position::new(0, 0), Position::new(0, 10)));
        assert!(actions.iter().any(|a| a.title.contains("Upgrade apiVersion to apps/v1")), "{actions:?}");
        assert!(actions.iter().any(|a| a.title.contains("# nonk8s")), "{actions:?}");
    }

    #[test]
    fn cluster_explorer_commands_and_terminal_sessions_work() {
        let host = install_mock_with_kubectl();
        host.add_file("k8s/app.yaml", SAMPLE_MANIFEST);
        host.open_editor("/project/k8s/app.yaml", "yaml", SAMPLE_MANIFEST, &[]);

        let mut plugin = KubernetesPlugin::default();
        plugin.activate(&host.context("openidea.kubernetes")).unwrap();

        // Render the Kubernetes Explorer view (loads kubeconfig contexts immediately)
        let view = plugin.render(VIEW_ID, None, &host.invocation()).unwrap();
        let Body::Html(html) = &view.body else { panic!("expected Html view") };
        assert!(!html.contains("__START_B64__"));
        assert_eq!(host.status_items()["context"].text, "k8s: prod-east/production");

        // Page requests cluster resources via `{op: "refresh"}`
        plugin.handle(VIEW_ID, ViewEvent::Message(r#"{"op":"refresh"}"#.into()), &host.invocation()).unwrap();
        assert!(host.view_messages().iter().any(|(v, m)| v == VIEW_ID && m.contains("web-api-7f8b9-abc")));

        // Switch context command cycles to `dev-local`
        let next_ctx = plugin.run_command("switch-context", &host.invocation(), None).unwrap().unwrap();
        assert_eq!(next_ctx, "dev-local");
        assert_eq!(host.storage().get("context").map(String::as_str), Some("dev-local"));

        // Follow logs & Exec shell open terminals with the right kubectl arguments
        plugin.run_command("follow-logs", &host.invocation(), Some("production/web-api-7f8b9-abc/api")).unwrap();
        plugin.run_command("exec-shell", &host.invocation(), Some("production/web-api-7f8b9-abc/api")).unwrap();
        plugin.run_command("port-forward", &host.invocation(), Some("Service/production/web-svc:8080:80")).unwrap();
        let terms = host.terminals();
        assert_eq!(terms.len(), 3);
        assert!(terms[0].args.contains(&"logs".into()) && terms[0].args.contains(&"-f".into()));
        assert!(terms[1].args.contains(&"exec".into()) && terms[1].args.contains(&"-it".into()));
        assert!(terms[2].args.contains(&"port-forward".into()) && terms[2].args.contains(&"8080:80".into()));

        // Scale and Rollout Restart commands
        let scaled =
            plugin.run_command("scale", &host.invocation(), Some("Deployment/production/web-api=4")).unwrap().unwrap();
        assert!(scaled.contains("scaled"));
        let restarted = plugin
            .run_command("rollout-restart", &host.invocation(), Some("Deployment/production/web-api"))
            .unwrap()
            .unwrap();
        assert!(restarted.contains("restarted"));

        // Kustomize and Helm Template commands
        let kust = plugin.run_command("kustomize-build", &host.invocation(), Some(".")).unwrap().unwrap();
        assert!(kust.contains("kustomized-svc"));
        let helm_out = plugin.run_command("helm-template", &host.invocation(), Some(".")).unwrap().unwrap();
        assert!(helm_out.contains("rendered-chart"));

        // Live YAML editing in the tool window (`apply-yaml`)
        plugin
            .handle(
                VIEW_ID,
                ViewEvent::Message(
                    r#"{"op":"apply-yaml","yaml":"apiVersion: v1\nkind: Pod\nmetadata:\n  name: web-api-7f8b9-abc\n"}"#
                        .into(),
                ),
                &host.invocation(),
            )
            .unwrap();
        assert!(host.view_messages().iter().any(|(v, m)| v == VIEW_ID && m.contains("Applied to cluster")));
    }

    #[test]
    fn merges_freelens_cluster_store_and_hotbars() {
        let (_, _, _, mut catalog) = kubectl::parse_kubeconfig_catalog(
            r#"{
                "current-context": "falcon-phx-ga",
                "clusters": [{"name": "falcon-phx-ga", "cluster": {"server": "https://phx-ga.example.com"}}],
                "contexts": [
                    {"name": "falcon-phx-ga", "context": {"cluster": "falcon-phx-ga", "namespace": "default"}},
                    {"name": "falcon-dal-ca", "context": {"cluster": "falcon-dal-ca"}}
                ]
            }"#,
            "",
            "~/.kube/config",
        );
        let clusters_json = r#"{
            "clusters": [
                {
                    "id": "d1387eed1a8f84eba2adb853dd0c0d0f",
                    "contextName": "falcon-phx-ga",
                    "kubeConfigPath": "/Users/dengliu/.kube/config",
                    "metadata": {"version": "v1.36.3", "distribution": "aks", "nodes": 132}
                },
                {
                    "id": "f78a9808",
                    "contextName": "falcon-dal-ca",
                    "kubeConfigPath": "/Users/dengliu/.kube/config",
                    "metadata": {"version": "v1.36.2", "distribution": "unknown", "nodes": 545}
                }
            ]
        }"#;
        let hotbars_json = r#"{
            "hotbars": [
                {
                    "items": [
                        {"entity": {"uid": "d1387eed1a8f84eba2adb853dd0c0d0f", "name": "falcon-phx-ga", "shortName": "fpg"}}
                    ]
                }
            ]
        }"#;
        kubectl::merge_freelens_stores(&mut catalog, Some(clusters_json), Some(hotbars_json));
        assert_eq!(catalog[0].version, "v1.36.3");
        assert_eq!(catalog[0].distro, "aks");
        assert_eq!(catalog[0].nodes, Some(132));
        assert!(catalog[0].hotbar_pinned);
        assert_eq!(catalog[0].short_name, "FPG");
        assert_eq!(catalog[1].version, "v1.36.2");
        assert_eq!(catalog[1].short_name, "FDC");
        assert!(!catalog[1].hotbar_pinned);
    }
}
