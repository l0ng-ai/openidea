//! Kubernetes for OpenIDEA: a tool window with the cluster as a tree
//! (namespaces → pods, deployments, services), loaded level by level as you
//! expand it. Pod logs and shells open in the IDE's terminal (`kubectl logs
//! -f`, `kubectl exec -it`), which streams them; everything goes through the
//! user's own `kubectl` (pinned by `process:kubectl`) and its configuration.
//! In a remote project it is the remote machine's `kubectl`.

use openidea_plugin::host;
use openidea_plugin::views::{Body, Button, TreeItem, View, ViewEvent, Viewport, Views};
use openidea_plugin::{Error, Invocation, Plugin, register_plugin};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const VIEW: &str = "cluster";
const KINDS: [(&str, &str, &str); 3] =
    [("pods", "Pods", "pod"), ("deployments", "Deployments", "deployment"), ("services", "Services", "service")];

/// One listed object: its name and a short status.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Object {
    pub name: String,
    pub status: String,
}

#[derive(Default)]
pub struct Kubernetes {
    /// Namespaces, once listed.
    namespaces: Option<Vec<String>>,
    /// `namespace/kind` → objects, once listed.
    objects: BTreeMap<String, Vec<Object>>,
    expanded: BTreeSet<String>,
    selected: Option<String>,
    /// The last kubectl failure (shown instead of the tree).
    error: Option<String>,
}

fn kubectl(args: &[&str]) -> Result<Value, Error> {
    let mut all: Vec<String> = Vec::new();
    if let Some(context) = host::setting_string("context").filter(|c| !c.is_empty()) {
        all.push("--context".into());
        all.push(context);
    }
    all.extend(args.iter().map(|a| (*a).to_owned()));
    all.extend(["-o".into(), "json".into()]);
    let out = host::run_process("kubectl", &all, None)?;
    if out.status != Some(0) {
        let reason = out.stderr.lines().find(|l| !l.trim().is_empty()).unwrap_or("kubectl failed");
        return Err(Error::Failed(reason.to_owned()));
    }
    serde_json::from_str(&out.stdout).map_err(|e| Error::Failed(format!("kubectl output: {e}")))
}

fn items(list: &Value) -> impl Iterator<Item = &Value> {
    list.get("items").and_then(Value::as_array).into_iter().flatten()
}

fn name(item: &Value) -> String {
    item.pointer("/metadata/name").and_then(Value::as_str).unwrap_or("?").to_owned()
}

/// `Running 2/2`, `CrashLoopBackOff`, `3/3 ready`, `ClusterIP 10.0.0.1`.
pub fn status_of(kind: &str, item: &Value) -> String {
    let s = |p: &str| item.pointer(p).and_then(Value::as_str).unwrap_or("").to_owned();
    let n = |p: &str| item.pointer(p).and_then(Value::as_u64).unwrap_or(0);
    match kind {
        "pods" => {
            let statuses = item.pointer("/status/containerStatuses").and_then(Value::as_array);
            let waiting =
                statuses.into_iter().flatten().find_map(|c| c.pointer("/state/waiting/reason").and_then(Value::as_str));
            let ready = statuses.into_iter().flatten().filter(|c| c.get("ready") == Some(&Value::Bool(true))).count();
            let total = statuses.map_or(0, Vec::len);
            match waiting {
                Some(reason) => reason.to_owned(),
                None => format!("{} {ready}/{total}", s("/status/phase")),
            }
        }
        "deployments" => format!("{}/{} ready", n("/status/readyReplicas"), n("/spec/replicas")),
        "services" => format!("{} {}", s("/spec/type"), s("/spec/clusterIP")).trim().to_owned(),
        _ => String::new(),
    }
}

impl Kubernetes {
    fn namespaces(&mut self) -> Result<Vec<String>, Error> {
        if let Some(ns) = &self.namespaces {
            return Ok(ns.clone());
        }
        let wanted: Vec<String> = host::setting_string("namespaces")
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
            .collect();
        let ns = if wanted.is_empty() {
            let mut all: Vec<String> = items(&kubectl(&["get", "namespaces"])?).map(name).collect();
            all.sort();
            all
        } else {
            wanted
        };
        self.namespaces = Some(ns.clone());
        Ok(ns)
    }

    fn objects(&mut self, namespace: &str, kind: &str) -> Result<Vec<Object>, Error> {
        let key = format!("{namespace}/{kind}");
        if let Some(o) = self.objects.get(&key) {
            return Ok(o.clone());
        }
        let list = kubectl(&["get", kind, "-n", namespace])?;
        let mut objects: Vec<Object> =
            items(&list).map(|i| Object { name: name(i), status: status_of(kind, i) }).collect();
        objects.sort_by(|a, b| a.name.cmp(&b.name));
        self.objects.insert(key, objects.clone());
        Ok(objects)
    }

    fn refresh(&mut self) {
        self.namespaces = None;
        self.objects.clear();
        self.error = None;
        host::refresh_view(VIEW);
    }

    /// `ns/pods/name` of the selected pod.
    fn selected_pod(&self) -> Option<(String, String)> {
        let key = self.selected.as_deref()?;
        let mut parts = key.splitn(3, '/');
        let (ns, kind, name) = (parts.next()?, parts.next()?, parts.next()?);
        (kind == "pods").then(|| (ns.to_owned(), name.to_owned()))
    }

    fn open_logs(&self) -> Result<(), Error> {
        let (ns, pod) = self.selected_pod().ok_or_else(|| Error::Invalid("select a pod first".into()))?;
        let tail = host::setting_number("tailLines").map_or(200, |n| n.max(0.0) as u64);
        let mut args = self.context_args();
        args.extend(["logs".into(), "-f".into(), format!("--tail={tail}"), "-n".into(), ns, pod.clone()]);
        host::open_terminal(&format!("logs: {pod}"), "kubectl", &args)
    }

    fn open_shell(&self) -> Result<(), Error> {
        let (ns, pod) = self.selected_pod().ok_or_else(|| Error::Invalid("select a pod first".into()))?;
        let shell = host::setting_string("shell").unwrap_or_else(|| "sh".into());
        let mut args = self.context_args();
        args.extend(["exec".into(), "-it".into(), "-n".into(), ns, pod.clone(), "--".into(), shell]);
        host::open_terminal(&format!("shell: {pod}"), "kubectl", &args)
    }

    fn context_args(&self) -> Vec<String> {
        match host::setting_string("context").filter(|c| !c.is_empty()) {
            Some(c) => vec!["--context".into(), c],
            None => Vec::new(),
        }
    }

    fn tree(&mut self) -> Result<Vec<TreeItem>, Error> {
        let mut out = Vec::new();
        for ns in self.namespaces()? {
            let open = self.expanded.contains(&ns);
            out.push(TreeItem::new(&ns, &ns).icon("folder").expandable(open));
            if !open {
                continue;
            }
            for (kind, label, icon) in KINDS {
                let key = format!("{ns}/{kind}");
                let open_kind = self.expanded.contains(&key);
                let mut group = TreeItem::new(&key, label).parent(&ns).icon("folder").expandable(open_kind);
                if open_kind {
                    let objects = self.objects(&ns, kind)?;
                    group = group.detail(&objects.len().to_string());
                    out.push(group);
                    for o in objects {
                        out.push(
                            TreeItem::new(&format!("{key}/{}", o.name), &o.name)
                                .parent(&key)
                                .icon(icon)
                                .detail(&o.status),
                        );
                    }
                } else {
                    out.push(group);
                }
            }
        }
        Ok(out)
    }
}

impl Plugin for Kubernetes {
    fn run_command(&mut self, id: &str, _ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, String> {
        match id {
            "refresh" => self.refresh(),
            "logs" => self.open_logs()?,
            "shell" => self.open_shell()?,
            _ => return Err(format!("unknown command {id}")),
        }
        Ok(None)
    }
}

impl Views for Kubernetes {
    fn render(&mut self, view: &str, _viewport: Option<Viewport>, _ctx: &Invocation) -> Result<View, Error> {
        if view != VIEW {
            return Err(Error::NotFound(view.into()));
        }
        let pod = self.selected_pod().is_some();
        let toolbar = |v: View| {
            v.button(Button::new("refresh", "Refresh").icon("refresh"))
                .button(Button::new("logs", "Follow Logs").icon("file-log").enabled(pod))
                .button(Button::new("shell", "Open Shell").icon("terminal").enabled(pod))
        };
        if let Some(e) = &self.error {
            return Ok(toolbar(View::message(&format!("kubectl: {e}"))));
        }
        match self.tree() {
            Ok(items) => {
                let context = host::setting_string("context")
                    .filter(|c| !c.is_empty())
                    .unwrap_or_else(|| "current context".into());
                let namespaces = self.namespaces.as_ref().map_or(0, Vec::len);
                Ok(toolbar(View::new(Body::Tree(items))).status(&format!("{context} · {namespaces} namespaces")))
            }
            Err(Error::Denied(cap)) => {
                Ok(toolbar(View::message(&format!("Allow {cap} in Settings › Plugins to browse the cluster."))))
            }
            Err(e) => {
                self.error = Some(e.to_string());
                Ok(toolbar(View::message(&format!("kubectl: {e}"))))
            }
        }
    }

    fn handle(&mut self, view: &str, event: ViewEvent, _ctx: &Invocation) -> Result<(), Error> {
        if view != VIEW {
            return Err(Error::NotFound(view.into()));
        }
        match event {
            ViewEvent::Expand(key) => {
                self.expanded.insert(key);
            }
            ViewEvent::Collapse(key) => {
                self.expanded.remove(&key);
            }
            ViewEvent::Select(key) => {
                self.selected = Some(key);
            }
            ViewEvent::Activate(key) => {
                self.selected = Some(key);
                return if self.selected_pod().is_some() { self.open_logs() } else { Ok(()) };
            }
            ViewEvent::Button(b) => match b.as_str() {
                "refresh" => {
                    self.refresh();
                    return Ok(());
                }
                "logs" => return self.open_logs(),
                "shell" => return self.open_shell(),
                _ => return Ok(()),
            },
            _ => return Ok(()),
        }
        host::refresh_view(VIEW);
        Ok(())
    }
}

register_plugin!(Kubernetes, views);

#[cfg(test)]
mod tests {
    use super::*;
    use openidea_plugin::ProcessOutput;
    use openidea_plugin::mock::MockHost;

    fn ok(stdout: &str) -> Result<ProcessOutput, Error> {
        Ok(ProcessOutput { status: Some(0), stdout: stdout.into(), stderr: String::new() })
    }

    fn cluster(host: &MockHost) {
        host.on_process("kubectl", |args, _| {
            let a: Vec<&str> = args.iter().map(String::as_str).collect();
            match a.as_slice() {
                ["get", "namespaces", ..] => ok(r#"{"items":[{"metadata":{"name":"kube-system"}},{"metadata":{"name":"default"}}]}"#),
                ["get", "pods", "-n", "default", ..] => ok(r#"{"items":[
                    {"metadata":{"name":"web-1"},"status":{"phase":"Running","containerStatuses":[{"ready":true},{"ready":false}]}},
                    {"metadata":{"name":"job-1"},"status":{"phase":"Pending","containerStatuses":[{"ready":false,"state":{"waiting":{"reason":"CrashLoopBackOff"}}}]}}
                ]}"#),
                ["get", kind, "-n", _, ..] if *kind == "deployments" || *kind == "services" => ok(r#"{"items":[]}"#),
                other => panic!("unexpected kubectl {other:?}"),
            }
        });
    }

    fn tree(p: &mut Kubernetes, host: &MockHost) -> Vec<TreeItem> {
        match p.render(VIEW, None, &host.invocation()).unwrap().body {
            Body::Tree(items) => items,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn lists_namespaces_then_objects_when_expanded() {
        let host = MockHost::install().with_capabilities(&["process:kubectl"]);
        cluster(&host);
        let mut p = Kubernetes::default();
        let labels = |items: &[TreeItem]| items.iter().map(|i| i.label.clone()).collect::<Vec<_>>();
        assert_eq!(labels(&tree(&mut p, &host)), ["default", "kube-system"]);
        p.handle(VIEW, ViewEvent::Expand("default".into()), &host.invocation()).unwrap();
        p.handle(VIEW, ViewEvent::Expand("default/pods".into()), &host.invocation()).unwrap();
        let items = tree(&mut p, &host);
        let pods: Vec<(String, Option<String>)> = items
            .iter()
            .filter(|i| i.parent.as_deref() == Some("default/pods"))
            .map(|i| (i.label.clone(), i.detail.clone()))
            .collect();
        assert_eq!(
            pods,
            [("job-1".into(), Some("CrashLoopBackOff".into())), ("web-1".into(), Some("Running 1/2".into()))]
        );
        // Cached until Refresh.
        let runs = host.process_runs().len();
        tree(&mut p, &host);
        assert_eq!(host.process_runs().len(), runs);
        p.handle(VIEW, ViewEvent::Button("refresh".into()), &host.invocation()).unwrap();
        tree(&mut p, &host);
        assert!(host.process_runs().len() > runs);
    }

    #[test]
    fn logs_and_shells_open_in_the_terminal() {
        let host = MockHost::install().with_capabilities(&["process:kubectl"]);
        cluster(&host);
        host.set_setting("context", "\"prod\"");
        host.set_setting("tailLines", "50");
        let mut p = Kubernetes::default();
        p.handle(VIEW, ViewEvent::Activate("default/pods/web-1".into()), &host.invocation()).unwrap();
        p.handle(VIEW, ViewEvent::Button("shell".into()), &host.invocation()).unwrap();
        let t = host.terminals();
        assert_eq!(t[0].title, "logs: web-1");
        assert_eq!(t[0].args, ["--context", "prod", "logs", "-f", "--tail=50", "-n", "default", "web-1"]);
        assert_eq!(t[1].args, ["--context", "prod", "exec", "-it", "-n", "default", "web-1", "--", "sh"]);
        // A namespace is not a pod.
        p.handle(VIEW, ViewEvent::Select("default".into()), &host.invocation()).unwrap();
        assert!(p.run_command("logs", &host.invocation(), None).is_err());
    }

    #[test]
    fn without_kubectl_the_view_explains_what_is_missing() {
        let host = MockHost::install().with_capabilities(&[]);
        let mut p = Kubernetes::default();
        let view = p.render(VIEW, None, &host.invocation()).unwrap();
        assert_eq!(
            view.body,
            Body::Message("Allow process:kubectl in Settings › Plugins to browse the cluster.".into())
        );

        let host = MockHost::install().with_capabilities(&["process:kubectl"]);
        host.on_process("kubectl", |_, _| {
            Ok(ProcessOutput {
                status: Some(1),
                stdout: String::new(),
                stderr: "The connection to the server was refused".into(),
            })
        });
        let mut p = Kubernetes::default();
        let view = p.render(VIEW, None, &host.invocation()).unwrap();
        assert_eq!(view.body, Body::Message("kubectl: The connection to the server was refused".into()));
    }
}
