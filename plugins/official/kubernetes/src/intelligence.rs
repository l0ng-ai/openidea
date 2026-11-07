//! Editor intelligence for Kubernetes YAML manifests, Kustomizations, and Helm charts:
//! - Project-wide resource index (cached with TTL + updated on save/open)
//! - Context-aware completion (apiVersion, kind, live templates, resource names, keys, ports, labels, Helm values)
//! - Cross-resource Go to Definition & Gutter Line Markers
//! - Static inspections & Quick Fixes (`CodeAction`)

use crate::manifest::{KubeDoc, ParsedFile, Spanned, parse_yaml, utf16_len, yaml_context_at};
use openidea_plugin::providers::{CodeAction, CompletionItem, CompletionKind, Document, LineMarker};
use openidea_plugin::{Diagnostic, Location, Position, Project, Range, Severity, TextEdit, host};
use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};

const INDEX_TTL: Duration = Duration::from_secs(300);
const MAX_YAML_FILES: u32 = 80;
const MAX_INDEX_FILE_BYTES: usize = 256 << 10;
const MAX_INDEX_SCAN_TIME: Duration = Duration::from_millis(150);

/// Returns true if `path` is a lockfile, dependency folder, or CI config that should not be indexed as a Kubernetes manifest.
pub fn is_excluded_yaml_path(path: &str) -> bool {
    let norm = normalize_slashes(path);
    let fname = norm.rsplit('/').next().unwrap_or(&norm);
    if matches!(
        fname,
        "pnpm-lock.yaml"
            | "yarn.lock"
            | "package-lock.json"
            | "Chart.lock"
            | "pubspec.lock"
            | "docker-compose.yml"
            | "docker-compose.yaml"
            | "compose.yml"
            | "compose.yaml"
            | ".clang-format"
            | ".clang-tidy"
            | ". prettierrc.yaml"
            | ".prettierrc.yml"
    ) || fname.ends_with("-lock.yaml")
        || fname.ends_with(".lock.yaml")
    {
        return true;
    }
    norm.contains("/node_modules/")
        || norm.contains("/.git/")
        || norm.contains("/.github/workflows/")
        || norm.contains("/target/")
        || norm.contains("/dist/")
        || norm.contains("/vendor/")
}

/// Fast check before running the full line-by-line parser during background workspace scans.
fn is_likely_kube_or_helm_file(path: &str, text: &str) -> bool {
    if text.is_empty() || text.len() > MAX_INDEX_FILE_BYTES {
        return false;
    }
    let norm = normalize_slashes(path);
    let fname = norm.rsplit('/').next().unwrap_or(&norm);
    if fname == "values.yaml"
        || fname == "values.yml"
        || fname.starts_with("values.")
        || fname == "Chart.yaml"
        || fname == "kustomization.yaml"
        || fname == "kustomization.yml"
        || fname.ends_with(".tpl")
    {
        return true;
    }
    text.contains("apiVersion:")
        || text.contains("kind:")
        || text.contains(".Values.")
        || text.contains("define \"")
        || text.contains("resources:")
}

/// Project-wide index of parsed YAML manifests.
#[derive(Clone, Debug, Default)]
pub struct ProjectIndex {
    pub built_at: Option<Instant>,
    pub files: BTreeMap<String, ParsedFile>,
}

/// One diagnosed issue and its optional quick fix.
#[derive(Clone, Debug)]
pub struct InspectionIssue {
    pub diagnostic: Diagnostic,
    pub fix: Option<CodeAction>,
}

pub const DEPRECATED_APIS: &[(&str, &str, &str)] = &[
    ("extensions/v1beta1", "Deployment", "apps/v1"),
    ("apps/v1beta1", "Deployment", "apps/v1"),
    ("apps/v1beta2", "Deployment", "apps/v1"),
    ("apps/v1beta1", "StatefulSet", "apps/v1"),
    ("apps/v1beta2", "StatefulSet", "apps/v1"),
    ("extensions/v1beta1", "DaemonSet", "apps/v1"),
    ("apps/v1beta2", "DaemonSet", "apps/v1"),
    ("extensions/v1beta1", "ReplicaSet", "apps/v1"),
    ("apps/v1beta2", "ReplicaSet", "apps/v1"),
    ("extensions/v1beta1", "Ingress", "networking.k8s.io/v1"),
    ("networking.k8s.io/v1beta1", "Ingress", "networking.k8s.io/v1"),
    ("extensions/v1beta1", "NetworkPolicy", "networking.k8s.io/v1"),
    ("batch/v1beta1", "CronJob", "batch/v1"),
    ("policy/v1beta1", "PodDisruptionBudget", "policy/v1"),
    ("autoscaling/v2beta1", "HorizontalPodAutoscaler", "autoscaling/v2"),
    ("autoscaling/v2beta2", "HorizontalPodAutoscaler", "autoscaling/v2"),
    ("rbac.authorization.k8s.io/v1beta1", "Role", "rbac.authorization.k8s.io/v1"),
    ("rbac.authorization.k8s.io/v1beta1", "ClusterRole", "rbac.authorization.k8s.io/v1"),
    ("rbac.authorization.k8s.io/v1beta1", "RoleBinding", "rbac.authorization.k8s.io/v1"),
    ("rbac.authorization.k8s.io/v1beta1", "ClusterRoleBinding", "rbac.authorization.k8s.io/v1"),
    ("storage.k8s.io/v1beta1", "StorageClass", "storage.k8s.io/v1"),
    ("apiextensions.k8s.io/v1beta1", "CustomResourceDefinition", "apiextensions.k8s.io/v1"),
];

pub const API_VERSIONS: &[(&str, &str)] = &[
    ("v1", "Core Kubernetes API (Pod, Service, ConfigMap, Secret, Namespace, PVC)"),
    ("apps/v1", "Workloads API (Deployment, StatefulSet, DaemonSet, ReplicaSet)"),
    ("batch/v1", "Batch API (Job, CronJob)"),
    ("networking.k8s.io/v1", "Networking API (Ingress, NetworkPolicy, IngressClass)"),
    ("rbac.authorization.k8s.io/v1", "RBAC API (Role, ClusterRole, RoleBinding, ClusterRoleBinding)"),
    ("autoscaling/v2", "Autoscaling API (HorizontalPodAutoscaler)"),
    ("policy/v1", "Policy API (PodDisruptionBudget)"),
    ("storage.k8s.io/v1", "Storage API (StorageClass, VolumeAttachment, CSIDriver)"),
    ("apiextensions.k8s.io/v1", "CRD API (CustomResourceDefinition)"),
    ("kustomize.config.k8s.io/v1beta1", "Kustomize configuration"),
];

pub const KINDS: &[(&str, &str)] = &[
    ("Deployment", "apps/v1 — Managed stateless workload"),
    ("Service", "v1 — Network service exposing Pods"),
    ("ConfigMap", "v1 — Non-confidential configuration data"),
    ("Secret", "v1 — Sensitive configuration data"),
    ("Pod", "v1 — Smallest deployable compute unit"),
    ("StatefulSet", "apps/v1 — Stateful workload with stable identity"),
    ("DaemonSet", "apps/v1 — Node-local background workload"),
    ("Job", "batch/v1 — Run-to-completion task"),
    ("CronJob", "batch/v1 — Scheduled Job"),
    ("Ingress", "networking.k8s.io/v1 — HTTP/HTTPS routing to Services"),
    ("NetworkPolicy", "networking.k8s.io/v1 — Pod network isolation policy"),
    ("PersistentVolumeClaim", "v1 — Storage request bound to a PV"),
    ("PersistentVolume", "v1 — Cluster storage volume"),
    ("ServiceAccount", "v1 — Pod identity for cluster authentication"),
    ("Role", "rbac.authorization.k8s.io/v1 — Namespaced RBAC permissions"),
    ("ClusterRole", "rbac.authorization.k8s.io/v1 — Cluster-wide RBAC permissions"),
    ("RoleBinding", "rbac.authorization.k8s.io/v1 — Binds a Role to subjects"),
    ("ClusterRoleBinding", "rbac.authorization.k8s.io/v1 — Binds a ClusterRole cluster-wide"),
    ("Namespace", "v1 — Virtual cluster partition"),
    ("HorizontalPodAutoscaler", "autoscaling/v2 — Automatic replica scaling"),
    ("PodDisruptionBudget", "policy/v1 — Voluntary disruption budget"),
    ("StorageClass", "storage.k8s.io/v1 — Dynamic volume provisioning profile"),
    ("Kustomization", "kustomize.config.k8s.io/v1beta1 — Kustomize overlay manifest"),
];

pub fn project_of(path: &str) -> Option<Project> {
    let norm = normalize_slashes(path);
    host::projects()
        .ok()?
        .into_iter()
        .filter(|p| p.root().is_ok_and(|r| norm.starts_with(&normalize_slashes(&r))))
        .max_by_key(|p| p.root().map(|r| r.len()).unwrap_or(0))
}

pub fn normalize_slashes(path: &str) -> String {
    path.replace('\\', "/")
}

pub fn parent_dir(path: &str) -> String {
    let norm = normalize_slashes(path);
    match norm.rfind('/') {
        Some(0) => "/".into(),
        Some(i) => norm[..i].to_owned(),
        None => String::new(),
    }
}

pub fn join_relative(base_dir: &str, rel: &str) -> String {
    let rel_norm = normalize_slashes(rel);
    let mut parts: Vec<&str> = base_dir.split('/').filter(|s| !s.is_empty()).collect();
    let leading_slash = base_dir.starts_with('/');
    for seg in rel_norm.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    if leading_slash { format!("/{}", parts.join("/")) } else { parts.join("/") }
}

impl ProjectIndex {
    /// Builds or refreshes the YAML index for `project`, always overlaying `current_doc` if provided.
    pub fn ensure(&mut self, project: Option<&Project>, current_doc: Option<(&str, &str)>) {
        let fresh = self.built_at.is_some_and(|t| t.elapsed() < INDEX_TTL);
        if !fresh && let Some(proj) = project {
            let started = Instant::now();
            let mut files = std::mem::take(&mut self.files);
            'outer: for pat in ["**/*.yaml", "**/*.yml", "**/*.tpl"] {
                if started.elapsed() >= MAX_INDEX_SCAN_TIME {
                    break;
                }
                if let Ok(paths) = proj.find_files(pat, MAX_YAML_FILES) {
                    for p in paths {
                        if started.elapsed() >= MAX_INDEX_SCAN_TIME {
                            break 'outer;
                        }
                        if is_excluded_yaml_path(&p) {
                            continue;
                        }
                        if let Ok(text) = proj.read_file(&p) {
                            if !is_likely_kube_or_helm_file(&p, &text) {
                                continue;
                            }
                            let parsed = parse_yaml(&text);
                            if !parsed.docs.is_empty()
                                || !parsed.helm_values.is_empty()
                                || !parsed.helm_value_refs.is_empty()
                                || !parsed.helm_template_defs.is_empty()
                                || !parsed.helm_template_refs.is_empty()
                            {
                                files.insert(normalize_slashes(&p), parsed);
                            }
                        }
                    }
                }
            }
            self.files = files;
            self.built_at = Some(Instant::now());
        }
        if let Some((path, text)) = current_doc
            && !is_excluded_yaml_path(path)
            && text.len() <= MAX_INDEX_FILE_BYTES
        {
            let norm = normalize_slashes(path);
            self.files.insert(norm.clone(), parse_yaml(text));
            // Also opportunistically index adjacent Helm chart files (`../values.yaml`, `_helpers.tpl`) by direct path
            if let Some(proj) = project {
                let dir = parent_dir(&norm);
                let chart_root = if dir.ends_with("/templates") { parent_dir(&dir) } else { dir.clone() };
                for candidate in [
                    format!("{chart_root}/values.yaml"),
                    format!("{chart_root}/values.yml"),
                    format!("{dir}/_helpers.tpl"),
                ] {
                    if !self.files.contains_key(&candidate)
                        && let Ok(ctext) = proj.read_file(&candidate)
                        && ctext.len() <= MAX_INDEX_FILE_BYTES
                    {
                        self.files.insert(candidate, parse_yaml(&ctext));
                    }
                }
            }
        }
    }

    pub fn update_file(&mut self, path: &str, text: &str) {
        self.files.insert(normalize_slashes(path), parse_yaml(text));
    }

    /// Iterates over every `(file_path, &KubeDoc)` in the workspace.
    pub fn all_docs(&self) -> impl Iterator<Item = (&str, &KubeDoc)> {
        self.files.iter().flat_map(|(path, parsed)| parsed.docs.iter().map(move |d| (path.as_str(), d)))
    }

    /// Finds resources of `kind` and `name`.
    pub fn find_by_kind_and_name(&self, kind: &str, name: &str) -> Vec<(String, &KubeDoc, Range)> {
        let mut out = Vec::new();
        for (path, doc) in self.all_docs() {
            if doc.kind.as_ref().is_some_and(|k| k.value == kind)
                && let Some(ref n) = doc.name
                && n.value == name
            {
                out.push((path.to_owned(), doc, n.range));
            }
        }
        out
    }

    /// Finds workloads whose pod/resource labels match all `selector_labels`.
    pub fn find_matching_workloads(
        &self,
        selector_labels: &BTreeMap<String, Spanned>,
    ) -> Vec<(String, &KubeDoc, Range)> {
        if selector_labels.is_empty() {
            return Vec::new();
        }
        let mut out = Vec::new();
        for (path, doc) in self.all_docs() {
            if !doc.is_workload() {
                continue;
            }
            let target = doc.target_labels();
            if selector_labels.iter().all(|(k, v)| target.get(k).is_some_and(|tv| tv.value == v.value)) {
                let range = doc
                    .name
                    .as_ref()
                    .map(|n| n.range)
                    .or_else(|| doc.kind.as_ref().map(|k| k.range))
                    .unwrap_or_default();
                out.push((path.to_owned(), doc, range));
            }
        }
        out
    }

    /// Finds Services whose `selector_labels` match `workload`'s target labels.
    pub fn find_matching_services(&self, workload: &KubeDoc) -> Vec<(String, &KubeDoc, Range)> {
        let target = workload.target_labels();
        if target.is_empty() {
            return Vec::new();
        }
        let mut out = Vec::new();
        for (path, doc) in self.all_docs() {
            if doc.kind.as_ref().map(|k| k.value.as_str()) != Some("Service") || doc.selector_labels.is_empty() {
                continue;
            }
            if doc.selector_labels.iter().all(|(k, v)| target.get(k).is_some_and(|tv| tv.value == v.value)) {
                let range = doc
                    .name
                    .as_ref()
                    .map(|n| n.range)
                    .or_else(|| doc.kind.as_ref().map(|k| k.range))
                    .unwrap_or_default();
                out.push((path.to_owned(), doc, range));
            }
        }
        out
    }

    /// Finds `values.yaml` definitions for a Helm `.Values.<key>` reference.
    pub fn find_helm_value(&self, key_path: &str) -> Vec<(String, Range, String)> {
        let mut out = Vec::new();
        for (path, parsed) in &self.files {
            let file_name = path.rsplit('/').next().unwrap_or(path);
            if (file_name == "values.yaml" || file_name == "values.yml" || file_name.starts_with("values."))
                && let Some(sp) = parsed.helm_values.get(key_path)
            {
                out.push((path.clone(), sp.range, sp.value.clone()));
            }
        }
        out
    }

    /// Finds `{{- define "<name>" -}}` definitions across Helm templates and `_helpers.tpl`.
    pub fn find_helm_template(&self, name: &str) -> Vec<(String, Range)> {
        let mut out = Vec::new();
        for (path, parsed) in &self.files {
            if let Some(sp) = parsed.helm_template_defs.get(name) {
                out.push((path.clone(), sp.range));
            }
        }
        out
    }

    /// Finds CRD definitions matching `kind`.
    pub fn find_crd(&self, kind: &str) -> Vec<(String, &crate::manifest::CrdSpec, Range)> {
        let mut out = Vec::new();
        for (path, doc) in self.all_docs() {
            if let Some(ref crd) = doc.crd
                && crd.kind.value == kind
            {
                out.push((path.to_owned(), crd, crd.kind.range));
            }
        }
        out
    }
}

fn contains(range: Range, pos: Position) -> bool {
    range.start <= pos && pos <= range.end
}

/// Computes navigation links `(source_range, target_location, tooltip, icon)` for `doc`.
pub fn document_links(
    index: &ProjectIndex,
    doc_path: &str,
    parsed: &ParsedFile,
) -> Vec<(Range, Location, String, &'static str)> {
    let mut links = Vec::new();
    let norm_path = normalize_slashes(doc_path);
    let base_dir = parent_dir(&norm_path);

    // 1. Helm `.Values.xxx` references -> `values.yaml`
    for href in &parsed.helm_value_refs {
        for (vpath, vrange, vval) in index.find_helm_value(&href.value) {
            let detail = if vval.is_empty() {
                format!("values.yaml: {}", href.value)
            } else {
                format!("values.yaml: {} = {}", href.value, vval)
            };
            links.push((
                href.range,
                Location { path: vpath, range: vrange },
                format!("Go to Helm value ({detail})"),
                "navigate",
            ));
        }
    }

    // 1b. Helm named template `{{ include "name" . }}` / `{{ template "name" . }}` -> `define "name"`
    for tref in &parsed.helm_template_refs {
        for (tpath, trange) in index.find_helm_template(&tref.value) {
            let fname = tpath.rsplit('/').next().unwrap_or(&tpath);
            links.push((
                tref.range,
                Location { path: tpath.clone(), range: trange },
                format!("Go to Helm template '{}' in {fname}", tref.value),
                "navigate",
            ));
        }
    }

    for kdoc in &parsed.docs {
        let kind = kdoc.kind.as_ref().map(|k| k.value.as_str()).unwrap_or("");

        // 1c. Custom Resource `kind` -> CustomResourceDefinition
        if let Some(ref kind_sp) = kdoc.kind
            && kind != "CustomResourceDefinition"
        {
            for (crd_path, _, crd_range) in index.find_crd(kind) {
                links.push((
                    kind_sp.range,
                    Location { path: crd_path, range: crd_range },
                    format!("Go to CustomResourceDefinition '{kind}'"),
                    "implemented",
                ));
            }
        }

        // 2. Kustomization file paths -> target YAML file
        for kpath in &kdoc.kustomize_paths {
            let resolved = join_relative(&base_dir, &kpath.value);
            if let Some(target_file) = index.files.get(&resolved) {
                let target_range = target_file
                    .docs
                    .first()
                    .and_then(|d| d.name.as_ref().or(d.kind.as_ref()))
                    .map(|s| s.range)
                    .unwrap_or_default();
                links.push((
                    kpath.range,
                    Location { path: resolved, range: target_range },
                    format!("Go to Kustomize resource {}", kpath.value),
                    "navigate",
                ));
            }
        }

        // 3. Service selector -> matching workloads, and targetPort -> containerPort
        if kind == "Service" {
            let workloads = index.find_matching_workloads(&kdoc.selector_labels);
            for sel_sp in kdoc.selector_labels.values() {
                for (wpath, wdoc, wrange) in &workloads {
                    let wkind = wdoc.kind.as_ref().map_or("Workload", |k| k.value.as_str());
                    let wname = wdoc.name.as_ref().map_or("unnamed", |n| n.value.as_str());
                    links.push((
                        sel_sp.range,
                        Location { path: wpath.clone(), range: *wrange },
                        format!("Go to matching {wkind} '{wname}'"),
                        "implemented",
                    ));
                }
            }
            for sport in &kdoc.service_ports {
                if let Some(ref tp) = sport.target_port {
                    for (wpath, wdoc, _) in &workloads {
                        for c in &wdoc.containers {
                            for cp in &c.ports {
                                if cp.value == tp.value {
                                    let wname = wdoc.name.as_ref().map_or("workload", |n| n.value.as_str());
                                    links.push((
                                        tp.range,
                                        Location { path: wpath.clone(), range: cp.range },
                                        format!("Go to containerPort '{}' in {wname}", cp.value),
                                        "navigate",
                                    ));
                                }
                            }
                        }
                    }
                }
            }
        }

        // 4. Workload -> matching Services exposing it
        if kdoc.is_workload() {
            let services = index.find_matching_services(kdoc);
            if let Some(ref name_sp) = kdoc.name {
                for (spath, sdoc, srange) in services {
                    let sname = sdoc.name.as_ref().map_or("Service", |n| n.value.as_str());
                    links.push((
                        name_sp.range,
                        Location { path: spath, range: srange },
                        format!("Exposed by Service '{sname}'"),
                        "implementing",
                    ));
                }
            }
        }

        // 5. ConfigMap / Secret references (and specific key references)
        for dref in &kdoc.data_refs {
            for (tpath, tdoc, trange) in index.find_by_kind_and_name(dref.target_kind, &dref.name.value) {
                links.push((
                    dref.name.range,
                    Location { path: tpath.clone(), range: trange },
                    format!("Go to {} '{}'", dref.target_kind, dref.name.value),
                    "navigate",
                ));
                if let Some(ref key_sp) = dref.key
                    && let Some(target_key) = tdoc.data_keys.get(&key_sp.value)
                {
                    links.push((
                        key_sp.range,
                        Location { path: tpath.clone(), range: target_key.range },
                        format!("Go to key '{}' in {} '{}'", key_sp.value, dref.target_kind, dref.name.value),
                        "navigate",
                    ));
                }
            }
        }

        // 6. ServiceAccount references
        for saref in &kdoc.service_account_refs {
            for (tpath, _, trange) in index.find_by_kind_and_name("ServiceAccount", &saref.value) {
                links.push((
                    saref.range,
                    Location { path: tpath, range: trange },
                    format!("Go to ServiceAccount '{}'", saref.value),
                    "navigate",
                ));
            }
        }

        // 7. PVC claimName references
        for pvcref in &kdoc.pvc_refs {
            for (tpath, _, trange) in index.find_by_kind_and_name("PersistentVolumeClaim", &pvcref.value) {
                links.push((
                    pvcref.range,
                    Location { path: tpath, range: trange },
                    format!("Go to PersistentVolumeClaim '{}'", pvcref.value),
                    "navigate",
                ));
            }
        }

        // 8. StorageClass references
        for scref in &kdoc.storage_class_refs {
            for (tpath, _, trange) in index.find_by_kind_and_name("StorageClass", &scref.value) {
                links.push((
                    scref.range,
                    Location { path: tpath, range: trange },
                    format!("Go to StorageClass '{}'", scref.value),
                    "navigate",
                ));
            }
        }

        // 9. RoleRef in RoleBinding / ClusterRoleBinding
        if let Some((ref rkind, ref rname)) = kdoc.role_ref {
            for (tpath, _, trange) in index.find_by_kind_and_name(rkind, &rname.value) {
                links.push((
                    rname.range,
                    Location { path: tpath, range: trange },
                    format!("Go to {rkind} '{}'", rname.value),
                    "navigate",
                ));
            }
        }

        // 10. Ingress backend Service & Port references
        for backend in &kdoc.ingress_backends {
            for (spath, sdoc, srange) in index.find_by_kind_and_name("Service", &backend.service_name.value) {
                links.push((
                    backend.service_name.range,
                    Location { path: spath.clone(), range: srange },
                    format!("Go to Service '{}'", backend.service_name.value),
                    "navigate",
                ));
                if let Some(ref pname) = backend.port_name {
                    for sp in &sdoc.service_ports {
                        if let Some(ref sn) = sp.name
                            && sn.value == pname.value
                        {
                            links.push((
                                pname.range,
                                Location { path: spath.clone(), range: sn.range },
                                format!("Go to port '{}' on Service '{}'", pname.value, backend.service_name.value),
                                "navigate",
                            ));
                        }
                    }
                }
                if let Some(ref pnum) = backend.port_number {
                    for sp in &sdoc.service_ports {
                        if let Some(ref sn) = sp.port
                            && sn.value == pnum.value
                        {
                            links.push((
                                pnum.range,
                                Location { path: spath.clone(), range: sn.range },
                                format!("Go to port {} on Service '{}'", pnum.value, backend.service_name.value),
                                "navigate",
                            ));
                        }
                    }
                }
            }
        }
    }

    links
}

/// Provides `definition` locations at `at`.
pub fn definitions_at(index: &ProjectIndex, doc: &Document, at: Position, parsed: &ParsedFile) -> Vec<Location> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for (range, loc, _, _) in document_links(index, &doc.path, parsed) {
        if contains(range, at) && seen.insert((loc.path.clone(), loc.range.start.line, loc.range.start.character)) {
            out.push(loc);
        }
    }
    out
}

/// Provides gutter `LineMarker` items for `doc`.
pub fn line_markers_for(index: &ProjectIndex, doc: &Document, parsed: &ParsedFile) -> Vec<LineMarker> {
    let mut by_line: BTreeMap<u32, LineMarker> = BTreeMap::new();
    for (range, loc, tooltip, icon) in document_links(index, &doc.path, parsed) {
        by_line.entry(range.start.line).or_insert_with(|| LineMarker {
            line: range.start.line,
            icon: Some(icon.to_owned()),
            tooltip,
            target: Some(loc),
        });
    }
    by_line.into_values().collect()
}

pub fn diag_with_source(
    range: Range,
    severity: Severity,
    message: impl Into<String>,
    code: &str,
    source: &str,
    deprecated: bool,
    unnecessary: bool,
) -> Diagnostic {
    let mut d = Diagnostic::new(range, severity, message).code(code);
    d.source = Some(source.to_owned());
    d.deprecated = deprecated;
    d.unnecessary = unnecessary;
    d
}

pub fn quickfix(title: impl Into<String>, edits: Vec<(String, Vec<TextEdit>)>) -> CodeAction {
    CodeAction { title: title.into(), kind: Some("quickfix".into()), preferred: true, edits, data: None }
}

pub fn snippet_item(label: &str, insert_text: impl Into<String>, replace: Range, detail: &str) -> CompletionItem {
    CompletionItem {
        label: label.to_owned(),
        detail: Some(detail.to_owned()),
        kind: Some(CompletionKind::Snippet),
        insert_text: insert_text.into(),
        snippet: true,
        replace: Some(replace),
        sort_text: None,
        filter_text: None,
        documentation: None,
        additional_edits: Vec::new(),
    }
}

/// Runs static Kubernetes manifest inspections on `parsed` (for `doc_path` / `text`),
/// returning both diagnostics and quick-fix `CodeAction`s.
pub fn inspect_document(
    index: &ProjectIndex,
    doc_path: &str,
    text: &str,
    parsed: &ParsedFile,
    warn_latest_tag: bool,
    warn_missing_resources: bool,
) -> Vec<InspectionIssue> {
    let mut issues = Vec::new();
    if parsed.marked_non_k8s {
        return issues;
    }
    let lines: Vec<&str> = text.split('\n').collect();
    let norm_path = normalize_slashes(doc_path);
    let base_dir = parent_dir(&norm_path);
    let has_multiple_manifest_files = index.files.len() > 1;

    for kdoc in &parsed.docs {
        if !kdoc.is_kube_resource() {
            continue;
        }
        let kind = kdoc.kind.as_ref().map(|k| k.value.as_str()).unwrap_or("");
        let api = kdoc.api_version.as_ref().map(|a| a.value.as_str()).unwrap_or("");

        // 1. Deprecated apiVersion check + Quick Fix
        if let Some(ref api_sp) = kdoc.api_version {
            for &(old_api, target_kind, replacement_api) in DEPRECATED_APIS {
                if api == old_api && (kind == target_kind || kind.is_empty()) {
                    let message =
                        format!("Deprecated apiVersion '{old_api}' for {target_kind}; use '{replacement_api}' instead");
                    let diag = diag_with_source(
                        api_sp.range,
                        Severity::Warning,
                        &message,
                        "deprecated-api-version",
                        "kubernetes",
                        true,
                        false,
                    );
                    let fix = quickfix(
                        format!("Kubernetes: Upgrade apiVersion to {replacement_api}"),
                        vec![(
                            doc_path.to_owned(),
                            vec![TextEdit { range: api_sp.range, text: replacement_api.to_owned() }],
                        )],
                    );
                    issues.push(InspectionIssue { diagnostic: diag, fix: Some(fix) });
                }
            }
        }

        // 2. Missing `metadata.name` on standard Kubernetes objects (excluding Kustomization)
        if !kind.is_empty()
            && kind != "Kustomization"
            && kind != "List"
            && kdoc.name.is_none()
            && let Some(ref kind_sp) = kdoc.kind
        {
            let diag = diag_with_source(
                kind_sp.range,
                Severity::Error,
                format!("{kind} resource is missing 'metadata.name'"),
                "missing-metadata-name",
                "kubernetes",
                false,
                false,
            );
            let insert_line = kind_sp.line + 1;
            let edit_pos = Position::new(insert_line, 0);
            let default_name = format!("my-{}\n", kind.to_ascii_lowercase());
            let snippet = if text.contains("metadata:") {
                format!("  name: {default_name}")
            } else {
                format!("metadata:\n  name: {default_name}")
            };
            let fix = quickfix(
                "Kubernetes: Add metadata.name",
                vec![(doc_path.to_owned(), vec![TextEdit { range: Range::new(edit_pos, edit_pos), text: snippet }])],
            );
            issues.push(InspectionIssue { diagnostic: diag, fix: Some(fix) });
        }

        // 3. Workload selector.matchLabels vs spec.template.metadata.labels mismatch
        if matches!(kind, "Deployment" | "StatefulSet" | "DaemonSet" | "ReplicaSet") && !kdoc.selector_labels.is_empty()
        {
            for (sel_k, sel_v) in &kdoc.selector_labels {
                let matches_pod = kdoc.pod_labels.get(sel_k).is_some_and(|pv| pv.value == sel_v.value);
                if !matches_pod {
                    let message = format!(
                        "Selector label '{sel_k}: {}' does not match 'spec.template.metadata.labels'",
                        sel_v.value
                    );
                    let diag = diag_with_source(
                        sel_v.range,
                        Severity::Error,
                        &message,
                        "selector-label-mismatch",
                        "kubernetes",
                        false,
                        false,
                    );

                    let fix = if let Some(existing_pod_label) = kdoc.pod_labels.get(sel_k) {
                        Some(quickfix(
                            format!("Kubernetes: Set template label '{sel_k}' to '{}'", sel_v.value),
                            vec![(
                                doc_path.to_owned(),
                                vec![TextEdit { range: existing_pod_label.range, text: sel_v.value.clone() }],
                            )],
                        ))
                    } else if let (Some(labels_line), Some(labels_indent)) =
                        (kdoc.pod_labels_line, kdoc.pod_labels_indent)
                    {
                        let pos = Position::new(labels_line + 1, 0);
                        let pad = " ".repeat(labels_indent + 2);
                        Some(quickfix(
                            format!("Kubernetes: Add '{sel_k}: {}' to pod template labels", sel_v.value),
                            vec![(
                                doc_path.to_owned(),
                                vec![TextEdit {
                                    range: Range::new(pos, pos),
                                    text: format!("{pad}{sel_k}: {}\n", sel_v.value),
                                }],
                            )],
                        ))
                    } else {
                        None
                    };
                    issues.push(InspectionIssue { diagnostic: diag, fix });
                }
            }
        }

        // 4. Container inspections: `:latest` / untagged image, missing resources, privileged container
        for container in &kdoc.containers {
            let cname = container.name.as_ref().map_or("container", |n| n.value.as_str());
            if warn_latest_tag
                && let Some(ref img) = container.image
                && !img.value.contains("{{")
            {
                let last_segment = img.value.rsplit('/').next().unwrap_or(&img.value);
                let is_latest_or_untagged =
                    img.value.ends_with(":latest") || (!last_segment.contains(':') && !img.value.contains('@'));
                if is_latest_or_untagged {
                    let msg = format!(
                        "Container '{cname}' image '{}' uses ':latest' or omits an explicit version tag",
                        img.value
                    );
                    let diag = diag_with_source(
                        img.range,
                        Severity::Warning,
                        &msg,
                        "image-latest-tag",
                        "kubernetes",
                        false,
                        false,
                    );
                    let base_img = img.value.strip_suffix(":latest").unwrap_or(&img.value);
                    let pinned = format!("{base_img}:1.0.0");
                    let fix = quickfix(
                        format!("Kubernetes: Pin image version tag ({pinned})"),
                        vec![(doc_path.to_owned(), vec![TextEdit { range: img.range, text: pinned }])],
                    );
                    issues.push(InspectionIssue { diagnostic: diag, fix: Some(fix) });
                }
            }

            if warn_missing_resources && kdoc.is_workload() && (!container.has_limits || !container.has_requests) {
                let anchor_range =
                    container.name.as_ref().or(container.image.as_ref()).map(|s| s.range).unwrap_or_else(|| {
                        let line_len = lines.get(container.header_line as usize).map_or(0, |l| utf16_len(l));
                        Range::new(
                            Position::new(container.header_line, 0),
                            Position::new(container.header_line, line_len),
                        )
                    });
                let diag = diag_with_source(
                    anchor_range,
                    Severity::Warning,
                    format!("Container '{cname}' is missing CPU/memory resource requests and limits"),
                    "missing-resource-limits",
                    "kubernetes",
                    false,
                    false,
                );

                if !container.has_resources {
                    let insert_line = container.end_line + 1;
                    let pad = " ".repeat(container.indent + 2);
                    let block = format!(
                        "{pad}resources:\n{pad}  requests:\n{pad}    cpu: 100m\n{pad}    memory: 128Mi\n{pad}  limits:\n{pad}    cpu: 500m\n{pad}    memory: 256Mi\n"
                    );
                    let pos = if (insert_line as usize) <= lines.len() {
                        Position::new(insert_line, 0)
                    } else {
                        Position::new(container.end_line, lines.last().map_or(0, |l| utf16_len(l)))
                    };
                    let prefix = if (insert_line as usize) > lines.len() && !text.ends_with('\n') { "\n" } else { "" };
                    let fix = quickfix(
                        format!("Kubernetes: Add resource requests and limits to '{cname}'"),
                        vec![(
                            doc_path.to_owned(),
                            vec![TextEdit { range: Range::new(pos, pos), text: format!("{prefix}{block}") }],
                        )],
                    );
                    issues.push(InspectionIssue { diagnostic: diag, fix: Some(fix) });
                } else {
                    issues.push(InspectionIssue { diagnostic: diag, fix: None });
                }
            }

            if let Some(ref priv_sp) = container.privileged
                && priv_sp.value == "true"
            {
                let diag = diag_with_source(
                    priv_sp.range,
                    Severity::Warning,
                    format!("Container '{cname}' runs in privileged mode (securityContext.privileged: true)"),
                    "privileged-container",
                    "kubernetes",
                    false,
                    false,
                );
                let fix = quickfix(
                    "Kubernetes: Set privileged to false",
                    vec![(doc_path.to_owned(), vec![TextEdit { range: priv_sp.range, text: "false".into() }])],
                );
                issues.push(InspectionIssue { diagnostic: diag, fix: Some(fix) });
            }
        }

        // 5. Missing ConfigMap / Secret key reference in same project
        for dref in &kdoc.data_refs {
            if dref.name.value.contains("{{") {
                continue;
            }
            let targets = index.find_by_kind_and_name(dref.target_kind, &dref.name.value);
            if let Some(ref key_sp) = dref.key
                && !key_sp.value.contains("{{")
            {
                for (tpath, tdoc, _) in &targets {
                    if !tdoc.data_keys.contains_key(&key_sp.value) {
                        let diag = diag_with_source(
                            key_sp.range,
                            Severity::Warning,
                            format!(
                                "Key '{}' is not defined in {} '{}'",
                                key_sp.value, dref.target_kind, dref.name.value
                            ),
                            "unresolved-config-key",
                            "kubernetes",
                            false,
                            false,
                        );

                        let fix = if let (Some(data_indent), Some(data_end)) = (tdoc.data_indent, tdoc.data_end_line) {
                            let pad = " ".repeat(data_indent + 2);
                            let pos = Position::new(data_end + 1, 0);
                            Some(quickfix(
                                format!(
                                    "Kubernetes: Add key '{}' to {} '{}'",
                                    key_sp.value, dref.target_kind, dref.name.value
                                ),
                                vec![(
                                    tpath.clone(),
                                    vec![TextEdit {
                                        range: Range::new(pos, pos),
                                        text: format!("{pad}{}: \"\"\n", key_sp.value),
                                    }],
                                )],
                            ))
                        } else {
                            None
                        };
                        issues.push(InspectionIssue { diagnostic: diag, fix });
                    }
                }
            } else if targets.is_empty() && (parsed.docs.len() > 1 || has_multiple_manifest_files) {
                let diag = diag_with_source(
                    dref.name.range,
                    Severity::Info,
                    format!(
                        "Referenced {} '{}' was not found in workspace manifests",
                        dref.target_kind, dref.name.value
                    ),
                    "unresolved-resource-ref",
                    "kubernetes",
                    false,
                    false,
                );
                issues.push(InspectionIssue { diagnostic: diag, fix: None });
            }
        }

        // 6. Duplicate YAML keys within the same mapping
        for (dup_key, dup_range, first_line) in &kdoc.duplicate_keys {
            let diag = diag_with_source(
                *dup_range,
                Severity::Error,
                format!("Duplicate YAML key '{dup_key}' (first defined on line {})", first_line + 1),
                "duplicate-yaml-key",
                "kubernetes",
                false,
                false,
            );
            let remove_range =
                Range::new(Position::new(dup_range.start.line, 0), Position::new(dup_range.start.line + 1, 0));
            let fix = quickfix(
                format!("Kubernetes: Remove duplicate key '{dup_key}'"),
                vec![(doc_path.to_owned(), vec![TextEdit { range: remove_range, text: String::new() }])],
            );
            issues.push(InspectionIssue { diagnostic: diag, fix: Some(fix) });
        }

        // 7. Read-only / server-managed fields (`metadata.uid`, `metadata.resourceVersion`, `status`, etc.)
        for (ro_path, ro_range) in &kdoc.readonly_fields {
            let diag = diag_with_source(
                *ro_range,
                Severity::Info,
                format!("'{ro_path}' is a server-managed read-only field in Kubernetes manifests"),
                "readonly-field",
                "kubernetes",
                false,
                true,
            );
            let remove_range =
                Range::new(Position::new(ro_range.start.line, 0), Position::new(ro_range.start.line + 1, 0));
            let fix = quickfix(
                format!("Kubernetes: Remove read-only field '{ro_path}'"),
                vec![(doc_path.to_owned(), vec![TextEdit { range: remove_range, text: String::new() }])],
            );
            issues.push(InspectionIssue { diagnostic: diag, fix: Some(fix) });
        }

        // 8. Deprecated fields (`bases`, `patchesStrategicMerge`, `commonLabels`, `spec.serviceAccount`)
        for (dep_field, replacement, dep_range) in &kdoc.deprecated_fields {
            let diag = diag_with_source(
                *dep_range,
                Severity::Warning,
                format!("Deprecated field '{dep_field}'; use '{replacement}' instead"),
                "deprecated-field",
                "kubernetes",
                true,
                false,
            );
            let fix = quickfix(
                format!("Kubernetes: Replace '{dep_field}' with '{replacement}'"),
                vec![(doc_path.to_owned(), vec![TextEdit { range: *dep_range, text: replacement.clone() }])],
            );
            issues.push(InspectionIssue { diagnostic: diag, fix: Some(fix) });
        }

        // 9. Invalid enum values (`spec.type`, `imagePullPolicy`, `restartPolicy`, `pathType`)
        for (enum_path, actual, allowed, enum_range) in &kdoc.invalid_enums {
            let diag = diag_with_source(
                *enum_range,
                Severity::Error,
                format!("Invalid value '{actual}' for '{enum_path}' (expected one of: {})", allowed.join(", ")),
                "invalid-enum-value",
                "kubernetes",
                false,
                false,
            );
            let default_val = allowed[0];
            let fix = quickfix(
                format!("Kubernetes: Change '{enum_path}' to '{default_val}'"),
                vec![(doc_path.to_owned(), vec![TextEdit { range: *enum_range, text: default_val.to_owned() }])],
            );
            issues.push(InspectionIssue { diagnostic: diag, fix: Some(fix) });
        }

        // 10. Kustomization missing local file path inspection
        if has_multiple_manifest_files {
            for kpath in &kdoc.kustomize_paths {
                if kpath.value.starts_with("http://")
                    || kpath.value.starts_with("https://")
                    || kpath.value.starts_with("ssh://")
                {
                    continue;
                }
                let resolved = join_relative(&base_dir, &kpath.value);
                let exists = index.files.contains_key(&resolved)
                    || index.files.keys().any(|k| k.starts_with(&format!("{resolved}/")));
                if !exists {
                    let diag = diag_with_source(
                        kpath.range,
                        Severity::Warning,
                        format!("Kustomize path '{}' does not match any manifest in the project", kpath.value),
                        "unresolved-kustomize-path",
                        "kubernetes",
                        false,
                        false,
                    );
                    issues.push(InspectionIssue { diagnostic: diag, fix: None });
                }
            }
        }
    }

    // If any issues were reported, offer a file-level quick fix to mark the file as `# nonk8s` (IntelliJ parity).
    if !issues.is_empty()
        && let Some(first) = issues.first()
    {
        let start = Position::new(0, 0);
        let mark_non_k8s = CodeAction {
            title: "Kubernetes: Mark file as non-Kubernetes (# nonk8s)".into(),
            kind: Some("quickfix".into()),
            preferred: false,
            edits: vec![(
                doc_path.to_owned(),
                vec![TextEdit { range: Range::new(start, start), text: "# nonk8s\n".into() }],
            )],
            data: None,
        };
        issues.push(InspectionIssue { diagnostic: first.diagnostic.clone(), fix: Some(mark_non_k8s) });
    }

    issues
}

/// Computes completions at `at` in `doc`.
pub fn completions_at(index: &ProjectIndex, doc: &Document, at: Position, parsed: &ParsedFile) -> Vec<CompletionItem> {
    let (parent_path, current_line, doc_kind) = yaml_context_at(&doc.text, at);
    let col_utf16 = at.character as usize;
    let units: Vec<u16> = current_line.encode_utf16().take(col_utf16).collect();
    let line_prefix = String::from_utf16_lossy(&units);

    let mut items = Vec::new();

    // 1. Helm template `{{ .Values.xxx }}` and `{{ include "xxx" . }}` completion
    if let Some(idx) = line_prefix.rfind("include \"").or_else(|| line_prefix.rfind("template \"")) {
        let quote_pos = line_prefix[idx..].find('"').unwrap_or(0) + idx + 1;
        let typed = &line_prefix[quote_pos..];
        if !typed.contains('"') {
            let start_col = at.character.saturating_sub(utf16_len(typed));
            let replace = Range::new(Position::new(at.line, start_col), at);
            let mut seen = BTreeSet::new();
            for (path, file) in &index.files {
                let fname = path.rsplit('/').next().unwrap_or(path);
                for name in file.helm_template_defs.keys() {
                    if name.starts_with(typed) && seen.insert(name.clone()) {
                        items.push(CompletionItem {
                            replace: Some(replace),
                            detail: Some(format!("Helm template in {fname}")),
                            ..CompletionItem::new(name, CompletionKind::Function)
                        });
                    }
                }
            }
            return items;
        }
    }

    if let Some(idx) = line_prefix.rfind(".Values.") {
        let typed = &line_prefix[idx + ".Values.".len()..];
        if typed.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')) {
            let start_col = at.character.saturating_sub(utf16_len(typed));
            let replace = Range::new(Position::new(at.line, start_col), at);
            let mut seen = BTreeSet::new();
            for (path, file) in &index.files {
                let fname = path.rsplit('/').next().unwrap_or(path);
                if fname == "values.yaml" || fname == "values.yml" || fname.starts_with("values.") {
                    for (k, sp) in &file.helm_values {
                        if k.starts_with(typed) && seen.insert(k.clone()) {
                            items.push(CompletionItem {
                                replace: Some(replace),
                                detail: Some(if sp.value.is_empty() {
                                    fname.to_owned()
                                } else {
                                    format!("{} ({fname})", sp.value)
                                }),
                                ..CompletionItem::new(k, CompletionKind::Property)
                            });
                        }
                    }
                }
            }
            return items;
        }
    }

    let trimmed_prefix = line_prefix.trim_start();

    // 2. Value completion after `key: `
    if let Some(colon_idx) = trimmed_prefix.find(':') {
        let key = trimmed_prefix[..colon_idx].trim().trim_start_matches("- ").trim();
        let raw_val = trimmed_prefix[colon_idx + 1..].trim_start();
        let start_col = at.character.saturating_sub(utf16_len(raw_val));
        let replace = Range::new(Position::new(at.line, start_col), at);
        let full_key = if parent_path.is_empty() { key.to_owned() } else { format!("{parent_path}.{key}") };

        match full_key.as_str() {
            "apiVersion" => {
                let mut seen = BTreeSet::new();
                for &(ver, desc) in API_VERSIONS {
                    if ver.starts_with(raw_val) && seen.insert(ver.to_owned()) {
                        items.push(CompletionItem {
                            replace: Some(replace),
                            detail: Some(desc.into()),
                            ..CompletionItem::new(ver, CompletionKind::Value)
                        });
                    }
                }
                for (_, kdoc) in index.all_docs() {
                    if let Some(ref crd) = kdoc.crd {
                        for v in &crd.versions {
                            let group_ver = format!("{}/{v}", crd.group);
                            if group_ver.starts_with(raw_val) && seen.insert(group_ver.clone()) {
                                items.push(CompletionItem {
                                    replace: Some(replace),
                                    detail: Some(format!("CRD API ({})", crd.kind.value)),
                                    ..CompletionItem::new(&group_ver, CompletionKind::Value)
                                });
                            }
                        }
                    }
                }
                return items;
            }
            "kind" => {
                for &(k, desc) in KINDS {
                    if k.to_ascii_lowercase().starts_with(&raw_val.to_ascii_lowercase()) {
                        items.push(CompletionItem {
                            replace: Some(replace),
                            detail: Some(desc.into()),
                            ..CompletionItem::new(k, CompletionKind::Class)
                        });
                    }
                }
                for (path, kdoc) in index.all_docs() {
                    if let Some(ref crd) = kdoc.crd
                        && !crd.kind.value.is_empty()
                        && crd.kind.value.to_ascii_lowercase().starts_with(&raw_val.to_ascii_lowercase())
                    {
                        let fname = path.rsplit('/').next().unwrap_or(path);
                        items.push(CompletionItem {
                            replace: Some(replace),
                            detail: Some(format!("CRD ({}) in {fname}", crd.group)),
                            ..CompletionItem::new(&crd.kind.value, CompletionKind::Class)
                        });
                    }
                }
                return items;
            }
            "spec.type" if doc_kind.as_deref() == Some("Service") => {
                for st in ["ClusterIP", "NodePort", "LoadBalancer", "ExternalName"] {
                    items.push(CompletionItem {
                        replace: Some(replace),
                        detail: Some("Service type".into()),
                        ..CompletionItem::new(st, CompletionKind::EnumMember)
                    });
                }
                return items;
            }
            _ => {}
        }

        if key == "imagePullPolicy" {
            for p in ["IfNotPresent", "Always", "Never"] {
                items.push(CompletionItem {
                    replace: Some(replace),
                    ..CompletionItem::new(p, CompletionKind::EnumMember)
                });
            }
            return items;
        }
        if key == "restartPolicy" {
            for p in ["Always", "OnFailure", "Never"] {
                items.push(CompletionItem {
                    replace: Some(replace),
                    ..CompletionItem::new(p, CompletionKind::EnumMember)
                });
            }
            return items;
        }

        // Cross-resource name completions
        if full_key.contains("configMapKeyRef.name")
            || full_key.contains("configMapRef.name")
            || full_key.ends_with("configMap.name")
        {
            for (path, kdoc) in index.all_docs() {
                if kdoc.kind.as_ref().map(|k| k.value.as_str()) == Some("ConfigMap")
                    && let Some(ref n) = kdoc.name
                {
                    let fname = path.rsplit('/').next().unwrap_or(path);
                    items.push(CompletionItem {
                        replace: Some(replace),
                        detail: Some(format!("ConfigMap in {fname}")),
                        ..CompletionItem::new(&n.value, CompletionKind::Reference)
                    });
                }
            }
            return items;
        }

        if full_key.contains("secretKeyRef.name")
            || full_key.contains("secretRef.name")
            || full_key.ends_with("secret.secretName")
            || full_key.ends_with("tls.secretName")
        {
            for (path, kdoc) in index.all_docs() {
                if kdoc.kind.as_ref().map(|k| k.value.as_str()) == Some("Secret")
                    && let Some(ref n) = kdoc.name
                {
                    let fname = path.rsplit('/').next().unwrap_or(path);
                    items.push(CompletionItem {
                        replace: Some(replace),
                        detail: Some(format!("Secret in {fname}")),
                        ..CompletionItem::new(&n.value, CompletionKind::Reference)
                    });
                }
            }
            return items;
        }

        // ConfigMap / Secret `key:` completion based on the referenced ConfigMap/Secret in the current doc
        if full_key.ends_with("configMapKeyRef.key") || full_key.ends_with("secretKeyRef.key") {
            let target_kind = if full_key.contains("configMapKeyRef") { "ConfigMap" } else { "Secret" };
            let active_doc = parsed
                .docs
                .iter()
                .find(|d| d.start_line <= at.line && at.line <= d.end_line)
                .or_else(|| parsed.docs.first());
            let referenced_names: Vec<String> = active_doc
                .map(|d| {
                    d.data_refs.iter().filter(|r| r.target_kind == target_kind).map(|r| r.name.value.clone()).collect()
                })
                .unwrap_or_default();

            for (_, kdoc) in index.all_docs() {
                if kdoc.kind.as_ref().map(|k| k.value.as_str()) == Some(target_kind)
                    && let Some(ref n) = kdoc.name
                    && (referenced_names.is_empty() || referenced_names.contains(&n.value))
                {
                    for (dk, dv) in &kdoc.data_keys {
                        items.push(CompletionItem {
                            replace: Some(replace),
                            detail: Some(format!("{target_kind} '{}' ({})", n.value, dv.value)),
                            ..CompletionItem::new(dk, CompletionKind::Property)
                        });
                    }
                }
            }
            return items;
        }

        if full_key.ends_with("backend.service.name") {
            for (path, kdoc) in index.all_docs() {
                if kdoc.kind.as_ref().map(|k| k.value.as_str()) == Some("Service")
                    && let Some(ref n) = kdoc.name
                {
                    let fname = path.rsplit('/').next().unwrap_or(path);
                    items.push(CompletionItem {
                        replace: Some(replace),
                        detail: Some(format!("Service in {fname}")),
                        ..CompletionItem::new(&n.value, CompletionKind::Reference)
                    });
                }
            }
            return items;
        }

        if full_key.ends_with("serviceAccountName") || full_key.ends_with("serviceAccount") {
            for (path, kdoc) in index.all_docs() {
                if kdoc.kind.as_ref().map(|k| k.value.as_str()) == Some("ServiceAccount")
                    && let Some(ref n) = kdoc.name
                {
                    let fname = path.rsplit('/').next().unwrap_or(path);
                    items.push(CompletionItem {
                        replace: Some(replace),
                        detail: Some(format!("ServiceAccount in {fname}")),
                        ..CompletionItem::new(&n.value, CompletionKind::Reference)
                    });
                }
            }
            return items;
        }

        if full_key.ends_with("persistentVolumeClaim.claimName") {
            for (path, kdoc) in index.all_docs() {
                if kdoc.kind.as_ref().map(|k| k.value.as_str()) == Some("PersistentVolumeClaim")
                    && let Some(ref n) = kdoc.name
                {
                    let fname = path.rsplit('/').next().unwrap_or(path);
                    items.push(CompletionItem {
                        replace: Some(replace),
                        detail: Some(format!("PVC in {fname}")),
                        ..CompletionItem::new(&n.value, CompletionKind::Reference)
                    });
                }
            }
            return items;
        }

        if key == "targetPort" {
            let mut seen = BTreeSet::new();
            for (_, kdoc) in index.all_docs() {
                for c in &kdoc.containers {
                    for p in &c.ports {
                        if seen.insert(p.value.clone()) {
                            let wname = kdoc.name.as_ref().map_or("workload", |n| n.value.as_str());
                            items.push(CompletionItem {
                                replace: Some(replace),
                                detail: Some(format!("Container port in {wname}")),
                                ..CompletionItem::new(&p.value, CompletionKind::Value)
                            });
                        }
                    }
                }
            }
            return items;
        }
    }

    // 3. Key and live-template completions when typing a key at `parent_path`
    let typed_key = trimmed_prefix.trim_start_matches("- ");
    let start_col = at.character.saturating_sub(utf16_len(typed_key));
    let replace = Range::new(Position::new(at.line, start_col), at);

    // Selector label key:value pairs from workloads in the workspace
    if parent_path == "spec.selector" || parent_path == "spec.selector.matchLabels" {
        let mut seen = BTreeSet::new();
        for (_, kdoc) in index.all_docs() {
            if kdoc.is_workload() {
                for (lk, lv) in kdoc.target_labels() {
                    let pair = format!("{lk}: {}", lv.value);
                    if pair.starts_with(typed_key) && seen.insert(pair.clone()) {
                        let wname = kdoc.name.as_ref().map_or("workload", |n| n.value.as_str());
                        items.push(CompletionItem {
                            replace: Some(replace),
                            detail: Some(format!("Label from {wname}")),
                            ..CompletionItem::new(&pair, CompletionKind::Property)
                        });
                    }
                }
            }
        }
    }

    for (field, snippet, detail) in schema_keys_for(&parent_path, doc_kind.as_deref()) {
        if field.starts_with(typed_key) {
            items.push(snippet_item(field, *snippet, replace, detail));
        }
    }

    // CustomResourceDefinition (CRD) `spec` property completion
    if parent_path == "spec"
        && let Some(ref k) = doc_kind
    {
        for (_, crd, _) in index.find_crd(k) {
            for prop in &crd.spec_properties {
                if prop.starts_with(typed_key) {
                    items.push(snippet_item(
                        prop,
                        format!("{prop}: ${{1:value}}"),
                        replace,
                        &format!("CRD {k} spec property"),
                    ));
                }
            }
        }
    }

    // Root-level IntelliJ-style Kubernetes live templates (`kdep`, `ksvc`, `kcm`, `ksec`, `king`, `kpod`, `kust`)
    if parent_path.is_empty() {
        for (abbr, title, body) in live_templates() {
            if abbr.starts_with(typed_key) || title.to_ascii_lowercase().contains(&typed_key.to_ascii_lowercase()) {
                let mut item = snippet_item(abbr, *body, replace, title);
                item.filter_text = Some(format!("{abbr} {title}"));
                items.push(item);
            }
        }
    }

    items
}

fn schema_keys_for(parent_path: &str, kind: Option<&str>) -> &'static [(&'static str, &'static str, &'static str)] {
    match parent_path {
        "" => &[
            ("apiVersion", "apiVersion: ${1:apps/v1}", "API group and version"),
            ("kind", "kind: ${1:Deployment}", "Resource kind"),
            ("metadata", "metadata:\n  name: ${1:my-app}", "Standard object metadata"),
            ("spec", "spec:\n  $0", "Desired state specification"),
            ("data", "data:\n  ${1:KEY}: \"${2:value}\"", "ConfigMap / Secret data entries"),
            ("stringData", "stringData:\n  ${1:KEY}: \"${2:value}\"", "Unencoded Secret string entries"),
        ],
        "metadata" => &[
            ("name", "name: ${1:my-app}", "Resource name"),
            ("namespace", "namespace: ${1:default}", "Target namespace"),
            ("labels", "labels:\n  app.kubernetes.io/name: ${1:my-app}", "Resource labels"),
            ("annotations", "annotations:\n  ${1:key}: \"${2:value}\"", "Resource annotations"),
        ],
        "spec" => match kind {
            Some("Service") => &[
                ("type", "type: ${1:ClusterIP}", "Service exposure type"),
                ("selector", "selector:\n  app.kubernetes.io/name: ${1:my-app}", "Pod label selector"),
                (
                    "ports",
                    "ports:\n  - name: ${1:http}\n    port: ${2:80}\n    targetPort: ${3:http}",
                    "Service port mappings",
                ),
            ],
            Some("Ingress") => &[
                ("ingressClassName", "ingressClassName: ${1:nginx}", "Ingress controller class"),
                (
                    "rules",
                    "rules:\n  - host: ${1:example.com}\n    http:\n      paths:\n        - path: /\n          pathType: Prefix\n          backend:\n            service:\n              name: ${2:my-service}\n              port:\n                name: ${3:http}",
                    "Ingress routing rules",
                ),
                (
                    "tls",
                    "tls:\n  - hosts:\n      - ${1:example.com}\n    secretName: ${2:tls-secret}",
                    "TLS configuration",
                ),
            ],
            _ => &[
                ("replicas", "replicas: ${1:2}", "Desired replica count"),
                (
                    "selector",
                    "selector:\n  matchLabels:\n    app.kubernetes.io/name: ${1:my-app}",
                    "Label selector for Pods",
                ),
                (
                    "template",
                    "template:\n  metadata:\n    labels:\n      app.kubernetes.io/name: ${1:my-app}\n  spec:\n    containers:\n      - name: ${1:my-app}\n        image: ${2:nginx:1.27-alpine}",
                    "Pod template specification",
                ),
                ("strategy", "strategy:\n  type: ${1:RollingUpdate}", "Deployment update strategy"),
                ("serviceAccountName", "serviceAccountName: ${1:default}", "Pod ServiceAccount name"),
                (
                    "containers",
                    "containers:\n  - name: ${1:app}\n    image: ${2:nginx:1.27-alpine}",
                    "Pod containers list",
                ),
            ],
        },
        p if p.ends_with("spec.containers") || p.ends_with("spec.initContainers") => &[
            ("name", "name: ${1:app}", "Container name"),
            ("image", "image: ${1:nginx:1.27-alpine}", "Container image"),
            ("imagePullPolicy", "imagePullPolicy: ${1:IfNotPresent}", "Image pull policy"),
            ("ports", "ports:\n  - name: ${1:http}\n    containerPort: ${2:8080}", "Container ports"),
            ("env", "env:\n  - name: ${1:ENV_VAR}\n    value: \"${2:value}\"", "Environment variables"),
            (
                "envFrom",
                "envFrom:\n  - configMapRef:\n      name: ${1:my-config}",
                "Populate env from ConfigMap or Secret",
            ),
            (
                "resources",
                "resources:\n  requests:\n    cpu: ${1:100m}\n    memory: ${2:128Mi}\n  limits:\n    cpu: ${3:500m}\n    memory: ${4:256Mi}",
                "CPU and memory requests/limits",
            ),
            (
                "livenessProbe",
                "livenessProbe:\n  httpGet:\n    path: ${1:/healthz}\n    port: ${2:http}\n  initialDelaySeconds: ${3:15}\n  periodSeconds: ${4:20}",
                "Container liveness probe",
            ),
            (
                "readinessProbe",
                "readinessProbe:\n  httpGet:\n    path: ${1:/readyz}\n    port: ${2:http}\n  initialDelaySeconds: ${3:5}\n  periodSeconds: ${4:10}",
                "Container readiness probe",
            ),
            (
                "volumeMounts",
                "volumeMounts:\n  - name: ${1:config-vol}\n    mountPath: ${2:/etc/config}",
                "Container volume mounts",
            ),
            (
                "securityContext",
                "securityContext:\n  runAsNonRoot: true\n  allowPrivilegeEscalation: false",
                "Container security context",
            ),
        ],
        _ => &[],
    }
}

fn live_templates() -> &'static [(&'static str, &'static str, &'static str)] {
    &[
        (
            "kdep",
            "Kubernetes Deployment",
            "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${1:my-app}\n  labels:\n    app.kubernetes.io/name: ${1:my-app}\nspec:\n  replicas: ${2:2}\n  selector:\n    matchLabels:\n      app.kubernetes.io/name: ${1:my-app}\n  template:\n    metadata:\n      labels:\n        app.kubernetes.io/name: ${1:my-app}\n    spec:\n      containers:\n        - name: ${1:my-app}\n          image: ${3:nginx:1.27-alpine}\n          ports:\n            - name: http\n              containerPort: ${4:80}\n          resources:\n            requests:\n              cpu: 100m\n              memory: 128Mi\n            limits:\n              cpu: 500m\n              memory: 256Mi\n$0",
        ),
        (
            "ksvc",
            "Kubernetes Service",
            "apiVersion: v1\nkind: Service\nmetadata:\n  name: ${1:my-app}\nspec:\n  type: ${2:ClusterIP}\n  selector:\n    app.kubernetes.io/name: ${1:my-app}\n  ports:\n    - name: http\n      port: ${3:80}\n      targetPort: ${4:http}\n$0",
        ),
        (
            "kcm",
            "Kubernetes ConfigMap",
            "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${1:my-config}\ndata:\n  ${2:APP_ENV}: \"${3:production}\"\n$0",
        ),
        (
            "ksec",
            "Kubernetes Secret",
            "apiVersion: v1\nkind: Secret\nmetadata:\n  name: ${1:my-secret}\ntype: Opaque\nstringData:\n  ${2:API_KEY}: \"${3:change-me}\"\n$0",
        ),
        (
            "king",
            "Kubernetes Ingress",
            "apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: ${1:my-ingress}\nspec:\n  ingressClassName: ${2:nginx}\n  rules:\n    - host: ${3:app.example.com}\n      http:\n        paths:\n          - path: /\n            pathType: Prefix\n            backend:\n              service:\n                name: ${4:my-app}\n                port:\n                  name: ${5:http}\n$0",
        ),
        (
            "kpod",
            "Kubernetes Pod",
            "apiVersion: v1\nkind: Pod\nmetadata:\n  name: ${1:my-pod}\n  labels:\n    app.kubernetes.io/name: ${1:my-pod}\nspec:\n  containers:\n    - name: ${1:my-pod}\n      image: ${2:nginx:1.27-alpine}\n      resources:\n        requests:\n          cpu: 100m\n          memory: 128Mi\n        limits:\n          cpu: 500m\n          memory: 256Mi\n$0",
        ),
        (
            "kust",
            "Kustomization",
            "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nnamespace: ${1:default}\nresources:\n  - ${2:deployment.yaml}\n  - ${3:service.yaml}\n$0",
        ),
    ]
}
