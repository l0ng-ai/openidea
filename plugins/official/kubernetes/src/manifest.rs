//! Fast, indentation-aware parser for multi-document Kubernetes YAML manifests,
//! Kustomization files, and Helm `Chart.yaml` / `values.yaml` / template files.
//! All positions and ranges use 0-based lines and UTF-16 columns.

use openidea_plugin::{Position, Range};
use std::collections::BTreeMap;

/// A string value with its exact range in the document.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Spanned {
    pub value: String,
    pub range: Range,
    pub line: u32,
}

impl Spanned {
    pub fn new(value: impl Into<String>, range: Range) -> Self {
        let line = range.start.line;
        Self { value: value.into(), range, line }
    }
}

/// A reference to a ConfigMap or Secret (whole object or a specific key).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DataRef {
    pub target_kind: &'static str, // "ConfigMap" or "Secret"
    pub name: Spanned,
    pub key: Option<Spanned>,
}

/// A Service port declared under `spec.ports`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServicePort {
    pub name: Option<Spanned>,
    pub port: Option<Spanned>,
    pub target_port: Option<Spanned>,
}

/// An Ingress backend service reference.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IngressBackendRef {
    pub service_name: Spanned,
    pub port_name: Option<Spanned>,
    pub port_number: Option<Spanned>,
}

/// A container (or initContainer) inside a Pod or workload template.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContainerSpec {
    pub name: Option<Spanned>,
    pub image: Option<Spanned>,
    pub ports: Vec<Spanned>,
    pub has_resources: bool,
    pub has_limits: bool,
    pub has_requests: bool,
    pub has_liveness_probe: bool,
    pub has_readiness_probe: bool,
    pub privileged: Option<Spanned>,
    pub run_as_non_root: Option<Spanned>,
    pub indent: usize,
    pub header_line: u32,
    pub end_line: u32,
}

/// A CustomResourceDefinition (CRD) specification discovered in the project or cluster.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CrdSpec {
    pub group: String,
    pub versions: Vec<String>,
    pub kind: Spanned,
    pub plural: Option<String>,
    pub scope: Option<String>,
    pub spec_properties: Vec<String>,
}

/// One YAML document inside a file (separated by `---`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KubeDoc {
    pub start_line: u32,
    pub end_line: u32,
    pub api_version: Option<Spanned>,
    pub kind: Option<Spanned>,
    pub name: Option<Spanned>,
    pub namespace: Option<Spanned>,
    /// `metadata.labels` key -> value
    pub labels: BTreeMap<String, Spanned>,
    /// `spec.template.metadata.labels` key -> value (for Deployments, StatefulSets, etc.)
    pub pod_labels: BTreeMap<String, Spanned>,
    pub pod_labels_indent: Option<usize>,
    pub pod_labels_line: Option<u32>,
    /// `spec.selector.matchLabels` or `spec.selector` (for Service) key -> value
    pub selector_labels: BTreeMap<String, Spanned>,
    pub selector_line: Option<u32>,
    pub replicas: Option<Spanned>,
    pub service_type: Option<Spanned>,
    pub service_ports: Vec<ServicePort>,
    pub containers: Vec<ContainerSpec>,
    pub data_keys: BTreeMap<String, Spanned>,
    pub data_indent: Option<usize>,
    pub data_end_line: Option<u32>,
    pub data_refs: Vec<DataRef>,
    pub service_account_refs: Vec<Spanned>,
    pub pvc_refs: Vec<Spanned>,
    pub storage_class_refs: Vec<Spanned>,
    pub role_ref: Option<(String, Spanned)>,
    pub ingress_backends: Vec<IngressBackendRef>,
    /// Kustomization file paths (`resources`, `patches`, `components`, `bases`).
    pub kustomize_paths: Vec<Spanned>,
    /// Duplicate sibling YAML keys within the same mapping (`(key_name, second_range, first_line)`).
    pub duplicate_keys: Vec<(String, Range, u32)>,
    /// Read-only / server-managed fields present in a local manifest (`metadata.uid`, `status`, etc.).
    pub readonly_fields: Vec<(String, Range)>,
    /// Deprecated field keys (`spec.serviceAccount`, Kustomize `bases` / `patchesStrategicMerge`, etc.).
    pub deprecated_fields: Vec<(String, String, Range)>,
    /// Invalid enum values (`(field_path, actual_value, allowed_values, range)`).
    pub invalid_enums: Vec<(String, String, &'static [&'static str], Range)>,
    /// Parsed CRD info when `kind == "CustomResourceDefinition"`.
    pub crd: Option<CrdSpec>,
}

impl KubeDoc {
    /// Whether this document looks like a Kubernetes or Kustomize resource.
    pub fn is_kube_resource(&self) -> bool {
        self.api_version.is_some() || self.kind.is_some() || !self.kustomize_paths.is_empty()
    }

    /// Effective labels exposed to Service selectors (`pod_labels` for workloads, `labels` for Pods).
    pub fn target_labels(&self) -> &BTreeMap<String, Spanned> {
        if !self.pod_labels.is_empty() { &self.pod_labels } else { &self.labels }
    }

    /// Whether this document is a workload that manages or is a Pod.
    pub fn is_workload(&self) -> bool {
        matches!(
            self.kind.as_ref().map(|k| k.value.as_str()),
            Some("Pod" | "Deployment" | "StatefulSet" | "DaemonSet" | "ReplicaSet" | "Job" | "CronJob")
        )
    }
}

/// Parsed file representation: multi-doc resources, Helm values, `.Values` references,
/// and named Helm templates (`define` / `include` / `template`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ParsedFile {
    pub docs: Vec<KubeDoc>,
    /// Flattened `values.yaml` keys (`image.tag` -> spanned value/key).
    pub helm_values: BTreeMap<String, Spanned>,
    /// `{{ .Values.foo.bar }}` occurrences in Helm templates.
    pub helm_value_refs: Vec<Spanned>,
    /// `{{- define "mychart.fullname" -}}` definitions in Helm templates / `_helpers.tpl`.
    pub helm_template_defs: BTreeMap<String, Spanned>,
    /// `{{ include "mychart.fullname" . }}` or `{{ template "mychart.fullname" . }}` references.
    pub helm_template_refs: Vec<Spanned>,
    /// Whether `# nonk8s` or `# openidea:nonk8s` is set at the top of the file.
    pub marked_non_k8s: bool,
}

///UTF-16 length of `s`.
pub fn utf16_len(s: &str) -> u32 {
    if s.is_ascii() { s.len() as u32 } else { s.encode_utf16().count() as u32 }
}

/// Converts a byte offset within `line_str` on `line_no` into a UTF-16 `Position`.
pub fn pos_in_line(line_no: u32, line_str: &str, byte_offset: usize) -> Position {
    let clamped = byte_offset.min(line_str.len());
    let prefix = &line_str[..clamped];
    Position::new(line_no, utf16_len(prefix))
}

/// Builds a `Range` on a single line from byte offsets `start..end`.
pub fn range_in_line(line_no: u32, line_str: &str, start: usize, end: usize) -> Range {
    Range::new(pos_in_line(line_no, line_str, start), pos_in_line(line_no, line_str, end))
}

/// Strips inline YAML comments (`# ...` outside quotes) and trims surrounding quotes.
fn parse_scalar_span(raw_after_colon: &str, base_byte: usize, line_no: u32, full_line: &str) -> Option<Spanned> {
    let trimmed_start = raw_after_colon.trim_start();
    if trimmed_start.is_empty() || trimmed_start.starts_with('#') {
        return None;
    }
    let lead = raw_after_colon.len() - trimmed_start.len();
    let val_start_rel = lead;

    // Handle quoted strings or unquoted scalars.
    let bytes = trimmed_start.as_bytes();
    if bytes[0] == b'"' || bytes[0] == b'\'' {
        let quote = bytes[0];
        let mut i = 1;
        while i < bytes.len() {
            if quote == b'"' && bytes[i] == b'\\' {
                i += 2;
                continue;
            }
            if bytes[i] == quote {
                let inner = &trimmed_start[1..i];
                let start = base_byte + val_start_rel + 1;
                let end = base_byte + val_start_rel + i;
                return Some(Spanned::new(inner, range_in_line(line_no, full_line, start, end)));
            }
            i += 1;
        }
    }

    // Unquoted value: stop at ` #` or `\t#`.
    let mut end_rel = trimmed_start.len();
    for (idx, _) in trimmed_start.match_indices('#') {
        if idx == 0 || trimmed_start.as_bytes()[idx - 1].is_ascii_whitespace() {
            end_rel = idx;
            break;
        }
    }
    let clean = trimmed_start[..end_rel].trim_end();
    if clean.is_empty() || matches!(clean, "|" | ">" | "|-" | ">-" | "|+" | ">+") {
        return None;
    }
    let start = base_byte + val_start_rel;
    let end = start + clean.len();
    Some(Spanned::new(clean, range_in_line(line_no, full_line, start, end)))
}

/// Extracts `{{ .Values.xxx.yyy }}`, `{{ define "name" }}`, and `{{ include/template "name" }}` from a line.
fn extract_helm_constructs(
    line_no: u32,
    line: &str,
    value_refs: &mut Vec<Spanned>,
    template_defs: &mut BTreeMap<String, Spanned>,
    template_refs: &mut Vec<Spanned>,
) {
    let mut search_from = 0;
    while let Some(idx) = line[search_from..].find(".Values.") {
        let start_byte = search_from + idx + ".Values.".len();
        let rest = &line[start_byte..];
        let path_len =
            rest.find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))).unwrap_or(rest.len());
        let path = rest[..path_len].trim_end_matches('.');
        if !path.is_empty() {
            let end_byte = start_byte + path.len();
            value_refs.push(Spanned::new(path, range_in_line(line_no, line, start_byte, end_byte)));
        }
        search_from = start_byte + path_len.max(1);
    }

    for (kw, is_def) in [("define \"", true), ("include \"", false), ("template \"", false)] {
        let mut from = 0;
        while let Some(idx) = line[from..].find(kw) {
            let name_start = from + idx + kw.len();
            if let Some(end_rel) = line[name_start..].find('"') {
                let name = &line[name_start..name_start + end_rel];
                if !name.is_empty() {
                    let sp = Spanned::new(name, range_in_line(line_no, line, name_start, name_start + end_rel));
                    if is_def {
                        template_defs.insert(name.to_owned(), sp);
                    } else {
                        template_refs.push(sp);
                    }
                }
                from = name_start + end_rel + 1;
            } else {
                break;
            }
        }
    }
}

const SERVICE_TYPES: &[&str] = &["ClusterIP", "NodePort", "LoadBalancer", "ExternalName"];
const PULL_POLICIES: &[&str] = &["Always", "IfNotPresent", "Never"];
const RESTART_POLICIES: &[&str] = &["Always", "OnFailure", "Never"];
const PATH_TYPES: &[&str] = &["Exact", "Prefix", "ImplementationSpecific"];

#[derive(Clone, Debug, Default)]
struct PendingRef {
    kind: &'static str, // "ConfigMap" or "Secret"
    indent: usize,
    name: Option<Spanned>,
    key: Option<Spanned>,
}

#[derive(Clone, Debug, Default)]
struct PendingIngressBackend {
    indent: usize,
    service_name: Option<Spanned>,
    port_name: Option<Spanned>,
    port_number: Option<Spanned>,
}

#[derive(Clone, Debug, Default)]
struct PendingRoleRef {
    indent: usize,
    kind: Option<String>,
    name: Option<Spanned>,
}

#[derive(Clone, Debug, Default)]
struct PendingSubject {
    indent: usize,
    kind: Option<String>,
    name: Option<Spanned>,
}

/// Parses a YAML document into `ParsedFile`.
pub fn parse_yaml(text: &str) -> ParsedFile {
    let mut result = ParsedFile::default();
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.is_empty() {
        return result;
    }

    for header_line in lines.iter().take(5) {
        let t = header_line.trim();
        if t == "# nonk8s" || t == "# openidea:nonk8s" || t.starts_with("# nonk8s ") {
            result.marked_non_k8s = true;
        }
    }

    let mut doc = KubeDoc { start_line: 0, end_line: 0, ..Default::default() };
    let mut path_stack: Vec<(usize, String)> = Vec::new();
    let mut sibling_keys: Vec<(usize, String, BTreeMap<String, u32>)> = Vec::new();
    let mut pending_ref: Option<PendingRef> = None;
    let mut pending_backend: Option<PendingIngressBackend> = None;
    let mut pending_role_ref: Option<PendingRoleRef> = None;
    let mut pending_subject: Option<PendingSubject> = None;

    let flush_pending = |doc: &mut KubeDoc,
                         pending_ref: &mut Option<PendingRef>,
                         pending_backend: &mut Option<PendingIngressBackend>,
                         pending_role_ref: &mut Option<PendingRoleRef>,
                         pending_subject: &mut Option<PendingSubject>| {
        if let Some(r) = pending_ref.take()
            && let Some(name) = r.name
        {
            doc.data_refs.push(DataRef { target_kind: r.kind, name, key: r.key });
        }
        if let Some(b) = pending_backend.take()
            && let Some(service_name) = b.service_name
        {
            doc.ingress_backends.push(IngressBackendRef {
                service_name,
                port_name: b.port_name,
                port_number: b.port_number,
            });
        }
        if let Some(rr) = pending_role_ref.take()
            && let Some(name) = rr.name
        {
            doc.role_ref = Some((rr.kind.unwrap_or_else(|| "Role".into()), name));
        }
        if let Some(sub) = pending_subject.take()
            && sub.kind.as_deref() == Some("ServiceAccount")
            && let Some(name) = sub.name
        {
            doc.service_account_refs.push(name);
        }
    };

    for (idx, raw_line) in lines.iter().enumerate() {
        let line_no = idx as u32;
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        extract_helm_constructs(
            line_no,
            line,
            &mut result.helm_value_refs,
            &mut result.helm_template_defs,
            &mut result.helm_template_refs,
        );

        let trimmed = line.trim();
        if trimmed == "---" || trimmed.starts_with("--- ") || trimmed == "..." {
            flush_pending(
                &mut doc,
                &mut pending_ref,
                &mut pending_backend,
                &mut pending_role_ref,
                &mut pending_subject,
            );
            doc.end_line = line_no.saturating_sub(1);
            if doc.is_kube_resource() {
                result.docs.push(doc);
            }
            doc = KubeDoc { start_line: line_no + 1, end_line: line_no + 1, ..Default::default() };
            path_stack.clear();
            sibling_keys.clear();
            continue;
        }
        doc.end_line = line_no;

        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with("{{") {
            continue;
        }

        let raw_indent = line.len() - line.trim_start_matches(' ').len();
        if let Some(container) = doc.containers.last_mut()
            && raw_indent > container.indent
        {
            container.end_line = line_no;
        }
        if let Some(data_indent) = doc.data_indent
            && raw_indent > data_indent
        {
            doc.data_end_line = Some(line_no);
        }

        // Check if pending blocks ended due to indentation drop.
        if pending_ref.as_ref().is_some_and(|p| raw_indent <= p.indent)
            && let Some(r) = pending_ref.take()
            && let Some(name) = r.name
        {
            doc.data_refs.push(DataRef { target_kind: r.kind, name, key: r.key });
        }
        if pending_backend.as_ref().is_some_and(|p| raw_indent <= p.indent)
            && let Some(b) = pending_backend.take()
            && let Some(service_name) = b.service_name
        {
            doc.ingress_backends.push(IngressBackendRef {
                service_name,
                port_name: b.port_name,
                port_number: b.port_number,
            });
        }
        if pending_role_ref.as_ref().is_some_and(|p| raw_indent <= p.indent)
            && let Some(rr) = pending_role_ref.take()
            && let Some(name) = rr.name
        {
            doc.role_ref = Some((rr.kind.unwrap_or_else(|| "Role".into()), name));
        }
        if pending_subject.as_ref().is_some_and(|p| raw_indent <= p.indent)
            && let Some(sub) = pending_subject.take()
            && sub.kind.as_deref() == Some("ServiceAccount")
            && let Some(name) = sub.name
        {
            doc.service_account_refs.push(name);
        }

        let after_spaces = &line[raw_indent..];
        let (is_list_item, effective_indent, content, content_byte_offset) =
            if let Some(rest) = after_spaces.strip_prefix("- ") {
                let extra_spaces = rest.len() - rest.trim_start_matches(' ').len();
                (true, raw_indent + 2 + extra_spaces, &rest[extra_spaces..], raw_indent + 2 + extra_spaces)
            } else if after_spaces == "-" {
                (true, raw_indent + 2, "", raw_indent + 1)
            } else {
                (false, raw_indent, after_spaces, raw_indent)
            };

        // Pop stack elements that are deeper than or equal to the current indentation.
        // For list items (`- key: val`), keep the list parent (which is at ` < raw_indent` or `<= raw_indent`),
        // but pop previous sibling keys inside the list item (`>= effective_indent`).
        if is_list_item {
            while path_stack.last().is_some_and(|(ind, _)| *ind > raw_indent) {
                path_stack.pop();
            }
            while sibling_keys.last().is_some_and(|(ind, _, _)| *ind >= raw_indent) {
                sibling_keys.pop();
            }
            if pending_subject.as_ref().is_some_and(|p| raw_indent <= p.indent + 2)
                && let Some(sub) = pending_subject.take()
                && sub.kind.as_deref() == Some("ServiceAccount")
                && let Some(name) = sub.name
            {
                doc.service_account_refs.push(name);
            }
        } else {
            while path_stack.last().is_some_and(|(ind, _)| *ind >= effective_indent) {
                path_stack.pop();
            }
            while sibling_keys.last().is_some_and(|(ind, _, _)| *ind > effective_indent) {
                sibling_keys.pop();
            }
        }

        let joined_parent = path_stack.iter().map(|(_, k)| k.as_str()).collect::<Vec<_>>().join(".");

        // Pure scalar list item, e.g. under `resources:` or `patches:` in kustomization.yaml
        if is_list_item && !content.contains(':') {
            if matches!(
                joined_parent.as_str(),
                "resources" | "bases" | "components" | "patches" | "patchesStrategicMerge" | "configurations"
            ) && let Some(sp) = parse_scalar_span(content, content_byte_offset, line_no, line)
            {
                doc.kustomize_paths.push(sp);
            }
            continue;
        }

        // Start of a new list item under `containers` / `initContainers`, `ports`, or `subjects`.
        if is_list_item {
            if joined_parent.ends_with("spec.containers") || joined_parent.ends_with("spec.initContainers") {
                doc.containers.push(ContainerSpec {
                    name: None,
                    image: None,
                    ports: Vec::new(),
                    has_resources: false,
                    has_limits: false,
                    has_requests: false,
                    has_liveness_probe: false,
                    has_readiness_probe: false,
                    privileged: None,
                    run_as_non_root: None,
                    indent: raw_indent,
                    header_line: line_no,
                    end_line: line_no,
                });
            } else if joined_parent == "spec.ports" {
                doc.service_ports.push(ServicePort { name: None, port: None, target_port: None });
            } else if joined_parent == "subjects" {
                pending_subject = Some(PendingSubject { indent: raw_indent, kind: None, name: None });
            }
        }

        let Some(colon_idx) = content.find(':') else { continue };
        let key_raw = content[..colon_idx].trim();
        let key = key_raw.trim_matches(|c| c == '"' || c == '\'');
        if key.is_empty() || key.contains("{{") {
            continue;
        }
        let key_start_byte =
            content_byte_offset + (content[..colon_idx].len() - content[..colon_idx].trim_start().len());
        let key_end_byte = key_start_byte + key_raw.len();
        let key_range = range_in_line(line_no, line, key_start_byte, key_end_byte);

        // Duplicate key check within the same mapping scope
        let scope_entry = if let Some(last) =
            sibling_keys.last_mut().filter(|(ind, parent, _)| *ind == effective_indent && *parent == joined_parent)
        {
            last
        } else {
            sibling_keys.push((effective_indent, joined_parent.clone(), BTreeMap::new()));
            sibling_keys.last_mut().expect("just pushed")
        };
        if let Some(&first_line) = scope_entry.2.get(key) {
            doc.duplicate_keys.push((key.to_owned(), key_range, first_line));
        } else {
            scope_entry.2.insert(key.to_owned(), line_no);
        }

        let after_colon = &content[colon_idx + 1..];
        let after_colon_byte = content_byte_offset + colon_idx + 1;
        let scalar = parse_scalar_span(after_colon, after_colon_byte, line_no, line);

        let full_path = if joined_parent.is_empty() { key.to_owned() } else { format!("{joined_parent}.{key}") };

        // Record Helm `values.yaml` flattened path (capped at 512 entries per file).
        if result.helm_values.len() < 512 {
            if let Some(ref val) = scalar {
                result.helm_values.entry(full_path.clone()).or_insert_with(|| Spanned {
                    value: val.value.clone(),
                    range: key_range,
                    line: line_no,
                });
            } else {
                result.helm_values.entry(full_path.clone()).or_insert_with(|| Spanned {
                    value: String::new(),
                    range: key_range,
                    line: line_no,
                });
            }
        }

        //Read-only / server-populated fields detection (IntelliJ Kubernetes inspection parity)
        if matches!(
            full_path.as_str(),
            "metadata.uid"
                | "metadata.resourceVersion"
                | "metadata.creationTimestamp"
                | "metadata.generation"
                | "metadata.selfLink"
                | "metadata.managedFields"
                | "status"
        ) {
            doc.readonly_fields.push((full_path.clone(), key_range));
        }

        // Deprecated fields detection (Kustomize & Kubernetes)
        match full_path.as_str() {
            "bases" => {
                doc.deprecated_fields.push(("bases".into(), "resources".into(), key_range));
            }
            "patchesStrategicMerge" | "patchesJson6902" => {
                doc.deprecated_fields.push((full_path.clone(), "patches".into(), key_range));
            }
            "commonLabels" => {
                doc.deprecated_fields.push(("commonLabels".into(), "labels".into(), key_range));
            }
            "spec.serviceAccount" => {
                doc.deprecated_fields.push(("serviceAccount".into(), "serviceAccountName".into(), key_range));
            }
            _ => {}
        }

        // Enum value validation
        if let Some(ref val) = scalar
            && !val.value.contains("{{")
            && !val.value.starts_with('$')
        {
            if full_path == "spec.type"
                && doc.kind.as_ref().map(|k| k.value.as_str()) == Some("Service")
                && !SERVICE_TYPES.contains(&val.value.as_str())
            {
                doc.invalid_enums.push((full_path.clone(), val.value.clone(), SERVICE_TYPES, val.range));
            } else if key == "imagePullPolicy" && !PULL_POLICIES.contains(&val.value.as_str()) {
                doc.invalid_enums.push((full_path.clone(), val.value.clone(), PULL_POLICIES, val.range));
            } else if key == "restartPolicy" && !RESTART_POLICIES.contains(&val.value.as_str()) {
                doc.invalid_enums.push((full_path.clone(), val.value.clone(), RESTART_POLICIES, val.range));
            } else if key == "pathType" && !PATH_TYPES.contains(&val.value.as_str()) {
                doc.invalid_enums.push((full_path.clone(), val.value.clone(), PATH_TYPES, val.range));
            }
        }

        // Open block contexts when a reference block starts.
        match key {
            "configMapKeyRef" | "configMapRef" | "configMap"
                if full_path.contains("env") || full_path.contains("volumes") =>
            {
                if let Some(prev) = pending_ref.replace(PendingRef {
                    kind: "ConfigMap",
                    indent: effective_indent,
                    name: None,
                    key: None,
                }) && let Some(name) = prev.name
                {
                    doc.data_refs.push(DataRef { target_kind: prev.kind, name, key: prev.key });
                }
            }
            "secretKeyRef" | "secretRef" | "secret" if full_path.contains("env") || full_path.contains("volumes") => {
                if let Some(prev) =
                    pending_ref.replace(PendingRef { kind: "Secret", indent: effective_indent, name: None, key: None })
                    && let Some(name) = prev.name
                {
                    doc.data_refs.push(DataRef { target_kind: prev.kind, name, key: prev.key });
                }
            }
            "service" if full_path.ends_with("backend.service") => {
                if let Some(prev) = pending_backend.replace(PendingIngressBackend {
                    indent: effective_indent,
                    service_name: None,
                    port_name: None,
                    port_number: None,
                }) && let Some(service_name) = prev.service_name
                {
                    doc.ingress_backends.push(IngressBackendRef {
                        service_name,
                        port_name: prev.port_name,
                        port_number: prev.port_number,
                    });
                }
            }
            "roleRef" if full_path == "roleRef" => {
                pending_role_ref = Some(PendingRoleRef { indent: effective_indent, kind: None, name: None });
            }
            _ => {}
        }

        // Populate pending blocks if active.
        if let Some(ref mut pr) = pending_ref
            && effective_indent > pr.indent
        {
            match key {
                "name" | "secretName" => pr.name = scalar.clone(),
                "key" => pr.key = scalar.clone(),
                _ => {}
            }
        }
        if let Some(ref mut pb) = pending_backend
            && effective_indent > pb.indent
        {
            if full_path.ends_with("backend.service.name") {
                pb.service_name = scalar.clone();
            } else if full_path.ends_with("backend.service.port.name") {
                pb.port_name = scalar.clone();
            } else if full_path.ends_with("backend.service.port.number") {
                pb.port_number = scalar.clone();
            }
        }
        if let Some(ref mut rr) = pending_role_ref
            && effective_indent > rr.indent
        {
            match key {
                "kind" => rr.kind = scalar.as_ref().map(|s| s.value.clone()),
                "name" => rr.name = scalar.clone(),
                _ => {}
            }
        }
        if let Some(ref mut sub) = pending_subject
            && effective_indent > sub.indent
        {
            match key {
                "kind" => sub.kind = scalar.as_ref().map(|s| s.value.clone()),
                "name" => sub.name = scalar.clone(),
                _ => {}
            }
        }

        // CustomResourceDefinition (CRD) extraction
        if doc.kind.as_ref().map(|k| k.value.as_str()) == Some("CustomResourceDefinition") {
            let crd = doc.crd.get_or_insert_with(CrdSpec::default);
            match full_path.as_str() {
                "spec.group" => {
                    if let Some(ref s) = scalar {
                        crd.group = s.value.clone();
                    }
                }
                "spec.scope" => {
                    crd.scope = scalar.as_ref().map(|s| s.value.clone());
                }
                "spec.names.kind" => {
                    if let Some(ref s) = scalar {
                        crd.kind = s.clone();
                    }
                }
                "spec.names.plural" => {
                    crd.plural = scalar.as_ref().map(|s| s.value.clone());
                }
                "spec.versions.name" => {
                    if let Some(ref s) = scalar {
                        crd.versions.push(s.value.clone());
                    }
                }
                _ => {
                    if let Some(prop) =
                        full_path.strip_prefix("spec.versions.schema.openAPIV3Schema.properties.spec.properties.")
                        && !prop.contains('.')
                        && !crd.spec_properties.iter().any(|p| p == prop)
                    {
                        crd.spec_properties.push(prop.to_owned());
                    }
                }
            }
        }

        // Match top-level and nested Kubernetes resource fields.
        match full_path.as_str() {
            "apiVersion" => doc.api_version = scalar.clone(),
            "kind" => doc.kind = scalar.clone(),
            "metadata.name" => doc.name = scalar.clone(),
            "metadata.namespace" | "namespace" => {
                if doc.namespace.is_none() {
                    doc.namespace = scalar.clone();
                }
            }
            "spec.replicas" => doc.replicas = scalar.clone(),
            "spec.type" => doc.service_type = scalar.clone(),
            "spec.selector" | "spec.selector.matchLabels" => {
                doc.selector_line = Some(line_no);
            }
            "spec.template.metadata.labels" => {
                doc.pod_labels_indent = Some(effective_indent);
                doc.pod_labels_line = Some(line_no);
            }
            "data" | "stringData" => {
                doc.data_indent = Some(effective_indent);
                doc.data_end_line = Some(line_no);
            }
            "spec.storageClassName" => {
                if let Some(s) = scalar.clone() {
                    doc.storage_class_refs.push(s);
                }
            }
            _ => {
                if let Some(label_key) = full_path.strip_prefix("metadata.labels.") {
                    if let Some(s) = scalar.clone() {
                        doc.labels.insert(label_key.to_owned(), s);
                    }
                } else if let Some(label_key) = full_path
                    .strip_prefix("spec.template.metadata.labels.")
                    .or_else(|| full_path.strip_prefix("spec.jobTemplate.spec.template.metadata.labels."))
                {
                    if let Some(s) = scalar.clone() {
                        doc.pod_labels.insert(label_key.to_owned(), s);
                    }
                } else if let Some(sel_key) = full_path
                    .strip_prefix("spec.selector.matchLabels.")
                    .or_else(|| full_path.strip_prefix("spec.podSelector.matchLabels."))
                {
                    if let Some(s) = scalar.clone() {
                        doc.selector_labels.insert(sel_key.to_owned(), s);
                    }
                } else if let Some(sel_key) = full_path.strip_prefix("spec.selector.") {
                    if sel_key != "matchLabels"
                        && sel_key != "matchExpressions"
                        && let Some(s) = scalar.clone()
                    {
                        doc.selector_labels.insert(sel_key.to_owned(), s);
                    }
                } else if let Some(data_key) =
                    full_path.strip_prefix("data.").or_else(|| full_path.strip_prefix("stringData."))
                {
                    if !data_key.contains('.') {
                        let sp = Spanned::new(scalar.as_ref().map_or("", |s| s.value.as_str()), key_range);
                        doc.data_keys.insert(data_key.to_owned(), sp);
                    }
                } else if full_path.ends_with("serviceAccountName") || full_path.ends_with("serviceAccount") {
                    if let Some(s) = scalar.clone() {
                        doc.service_account_refs.push(s);
                    }
                } else if full_path.ends_with("persistentVolumeClaim.claimName") {
                    if let Some(s) = scalar.clone() {
                        doc.pvc_refs.push(s);
                    }
                } else if (full_path.ends_with("tls.secretName") || full_path.ends_with("imagePullSecrets.name"))
                    && let Some(s) = scalar.clone()
                {
                    doc.data_refs.push(DataRef { target_kind: "Secret", name: s, key: None });
                } else if full_path.starts_with("spec.ports.") {
                    if let Some(port) = doc.service_ports.last_mut() {
                        match key {
                            "name" => port.name = scalar.clone(),
                            "port" => port.port = scalar.clone(),
                            "targetPort" => port.target_port = scalar.clone(),
                            _ => {}
                        }
                    }
                } else if (full_path.contains("spec.containers.") || full_path.contains("spec.initContainers."))
                    && let Some(container) = doc.containers.last_mut()
                {
                    let suffix = full_path
                        .rsplit_once("spec.containers.")
                        .or_else(|| full_path.rsplit_once("spec.initContainers."))
                        .map(|(_, s)| s)
                        .unwrap_or("");
                    match suffix {
                        "name" => container.name = scalar.clone(),
                        "image" => container.image = scalar.clone(),
                        "ports.name" | "ports.containerPort" => {
                            if let Some(s) = scalar.clone() {
                                container.ports.push(s);
                            }
                        }
                        "resources" => container.has_resources = true,
                        "resources.limits" => {
                            container.has_resources = true;
                            container.has_limits = true;
                        }
                        "resources.requests" => {
                            container.has_resources = true;
                            container.has_requests = true;
                        }
                        "livenessProbe" => container.has_liveness_probe = true,
                        "readinessProbe" => container.has_readiness_probe = true,
                        "securityContext.privileged" => container.privileged = scalar.clone(),
                        "securityContext.runAsNonRoot" => container.run_as_non_root = scalar.clone(),
                        _ => {}
                    }
                } else if matches!(key, "path")
                    && (full_path.starts_with("patches.") || full_path.starts_with("components."))
                    && let Some(s) = scalar.clone()
                {
                    doc.kustomize_paths.push(s);
                }
            }
        }

        // Push current key to stack so child lines inherit its path.
        if scalar.is_none() {
            path_stack.push((effective_indent, key.to_owned()));
        }
    }

    flush_pending(&mut doc, &mut pending_ref, &mut pending_backend, &mut pending_role_ref, &mut pending_subject);
    if doc.is_kube_resource() {
        result.docs.push(doc);
    }

    result
}

/// Returns the YAML path hierarchy at `position` (`line`, `character`) for context-aware completion.
pub fn yaml_context_at(text: &str, pos: Position) -> (String, String, Option<String>) {
    let lines: Vec<&str> = text.split('\n').collect();
    let target_line_idx = (pos.line as usize).min(lines.len().saturating_sub(1));

    // Find start of current document (`---`).
    let mut doc_start = 0usize;
    for i in (0..=target_line_idx).rev() {
        let t = lines[i].trim();
        if i < target_line_idx && (t == "---" || t.starts_with("--- ")) {
            doc_start = i + 1;
            break;
        }
    }

    let current_line = lines.get(target_line_idx).copied().unwrap_or("");
    let current_line = current_line.strip_suffix('\r').unwrap_or(current_line);
    let current_indent = current_line.len() - current_line.trim_start_matches(' ').len();

    let mut stack: Vec<(usize, String)> = Vec::new();
    let mut doc_kind: Option<String> = None;

    for line_raw in &lines[doc_start..target_line_idx] {
        let line = line_raw.strip_suffix('\r').unwrap_or(line_raw);
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let raw_indent = line.len() - line.trim_start_matches(' ').len();
        let after_spaces = &line[raw_indent..];
        let (is_list, eff_indent, content) = if let Some(rest) = after_spaces.strip_prefix("- ") {
            let extra = rest.len() - rest.trim_start_matches(' ').len();
            (true, raw_indent + 2 + extra, &rest[extra..])
        } else {
            (false, raw_indent, after_spaces)
        };
        if is_list {
            while stack.last().is_some_and(|(ind, _)| *ind > raw_indent) {
                stack.pop();
            }
        } else {
            while stack.last().is_some_and(|(ind, _)| *ind >= eff_indent) {
                stack.pop();
            }
        }
        if let Some(colon) = content.find(':') {
            let key = content[..colon].trim().trim_matches(|c| c == '"' || c == '\'');
            let after = content[colon + 1..].trim();
            if raw_indent == 0 && key == "kind" && !after.is_empty() {
                doc_kind = Some(after.trim_matches(|c| c == '"' || c == '\'').to_owned());
            }
            if after.is_empty() || after.starts_with('#') {
                stack.push((eff_indent, key.to_owned()));
            }
        }
    }

    // Also inspect forward in the same document if `kind` hasn't been seen yet.
    if doc_kind.is_none() {
        for line_raw in &lines[target_line_idx..] {
            let line = line_raw.strip_suffix('\r').unwrap_or(line_raw);
            let trimmed = line.trim();
            if trimmed == "---" || trimmed.starts_with("--- ") {
                break;
            }
            if let Some(rest) = line.strip_prefix("kind:") {
                let k = rest.trim().trim_matches(|c| c == '"' || c == '\'');
                if !k.is_empty() {
                    doc_kind = Some(k.to_owned());
                    break;
                }
            }
        }
    }

    while stack.last().is_some_and(|(ind, _)| *ind >= current_indent) {
        stack.pop();
    }

    let parent_path = stack.into_iter().map(|(_, k)| k).collect::<Vec<_>>().join(".");
    (parent_path, current_line.to_owned(), doc_kind)
}
