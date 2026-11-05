//! IntelliJ plugin descriptor compatibility (spec 15, honest subset).
//!
//! Reads `META-INF/plugin.xml` (including `<xi:include>`d descriptors) from a
//! `.jar`, a Marketplace `.zip` or an installed plugin folder, and produces a
//! **read-only compatibility report**: which declarative contributions can be
//! imported into OpenIDEA's contribution points, which need a rewrite into a
//! Wasm component, and which are unsupported.
//!
//! This is deliberately *not* a JVM: no IntelliJ bytecode is loaded or run.
//! An IntelliJ plugin's `<applicationService>` / `<localInspection>` /
//! `<completion.contributor>` names Java classes behind a different ABI; the
//! report says so explicitly instead of pretending those classes work.

use super::intellij::{Jar, PLUGIN_XML, MAX_FILE, find, plugin_jars, text};
use ide_core::{IdeError, IdeResult};
use quick_xml::{Reader, XmlVersion, events::Event};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// A declared contribution from `<extensions>` or `<actions>`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredExtension {
    /// The extension point qualified name, e.g. `com.intellij.localInspection`.
    /// For `<action>` children this is `intellij.action`.
    pub point: String,
    /// The EP-local name (`localInspection`), kept for display.
    pub name: String,
    /// `defaultExtensionNs` / `qualifiedName` prefix, when declared.
    pub namespace: Option<String>,
    /// Selected attributes (`implementationClass`, `id`, `language`, …).
    pub attributes: BTreeMap<String, String>,
}

/// A `<depends>` or `<content><module>` declaration.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredDependency {
    pub id: String,
    pub optional: bool,
    pub config_file: Option<String>,
}

/// The full descriptor model (superset of the theme-only `Descriptor`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IntellijDescriptor {
    pub id: Option<String>,
    pub name: Option<String>,
    pub version: Option<String>,
    pub vendor: Option<String>,
    pub vendor_email: Option<String>,
    pub description: Option<String>,
    /// `<idea-version since-build=… until-build=…>`.
    pub since_build: Option<String>,
    pub until_build: Option<String>,
    pub depends: Vec<DeclaredDependency>,
    pub content_modules: Vec<String>,
    pub extensions: Vec<DeclaredExtension>,
    /// `<extensionPoints><extensionPoint qualifiedName=…>` declared by the plugin.
    pub declared_extension_points: Vec<String>,
    pub actions: Vec<DeclaredExtension>,
    /// `themeProvider` entries: (id, path).
    pub themes: Vec<(String, String)>,
    pub services: Vec<DeclaredExtension>,
    /// Every XML file read (main + includes), for the report.
    pub descriptor_files: Vec<String>,
}

/// How a declaration maps onto OpenIDEA.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CompatKind {
    /// Declarative contribution imported into an existing contribution point.
    Importable,
    /// A Wasm component can implement the same capability via a WIT host function.
    RewriteToWasm,
    /// Java class / JVM service / platform-specific ABI: cannot run.
    Unsupported,
}

/// One line of the compatibility report.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CompatEntry {
    pub point: String,
    pub kind: CompatKind,
    /// Existing OpenIDEA contribution point or WIT host function, when any.
    pub target: Option<String>,
    pub reason: String,
    pub count: usize,
}

/// The read-only compatibility report.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CompatReport {
    pub source: String,
    pub descriptor: IntellijDescriptor,
    pub entries: Vec<CompatEntry>,
    pub importable_count: usize,
    pub rewrite_count: usize,
    pub unsupported_count: usize,
    /// Human-readable summary, also used by the CLI.
    pub summary: String,
}

/// Known mapping of IntelliJ extension points → OpenIDEA. Grounded in the
/// reverse-engineered corpus (`_rev/ep_counts.json`: 2242 distinct points,
/// 945 tags appearing in real `plugin.xml` files) and in `plugins/points.rs`.
///
/// A point absent from this table is reported as `RewriteToWasm` when it names a
/// class-backed capability, and `Unsupported` for JVM services/configurables.
/// The EP name after the `com.intellij.` prefix; the full name otherwise.
fn ep_name(point: &str) -> &str {
    point.strip_prefix("com.intellij.").unwrap_or(point)
}

fn mapping(point: &str) -> (CompatKind, Option<&'static str>, &'static str) {
    let ep = ep_name(point);
    match ep {
        // Declarative, data-only contributions: importable into our points.
        "themeProvider" => (CompatKind::Importable, Some("themes"), "theme JSON + editor scheme map onto design tokens"),
        "fileType" | "fileTypeOverrider" => (CompatKind::Importable, Some("languages"), "file name/extension patterns map onto language registrations"),
        "icon" | "fileIconProvider" => (CompatKind::Importable, Some("fileIcons"), "icon path/extension mappings are data"),
        "keymap" | "action" | "actionPromoter" => (CompatKind::Importable, Some("keymaps/commands"), "action ids and shortcuts map onto keymap/command contributions"),
        "liveTemplate" | "liveTemplateMacro" | "defaultLiveTemplates" => (CompatKind::Importable, Some("fileTemplates/liveTemplates"), "template bodies and contexts are declarative data"),
        "colorScheme" | "additionalTextAttributes" | "editorScheme" => (CompatKind::Importable, Some("themes"), "editor color scheme maps onto design tokens"),
        "fileTemplate" | "internalFileTemplate" => (CompatKind::Importable, Some("fileTemplates"), "template text is data"),
        "statusBarWidgetFactory" => (CompatKind::Importable, Some("statusBar"), "widget id/placement is declarative"),
        "notificationGroup" => (CompatKind::Importable, Some("ui/views"), "notification group id/display type is declarative"),
        "toolWindow" => (CompatKind::Importable, Some("views"), "tool window id/anchor/icon is declarative"),

        // Class-backed but reusable as a Wasm component via a host function.
        "localInspection" | "globalInspection" | "inspectionToolProvider" => (CompatKind::RewriteToWasm, Some("contributes.inspections (WIT host: run-inspection)"), "a Wasm plugin can implement the same inspection contract"),
        "intentionAction" | "quickFix" => (CompatKind::RewriteToWasm, Some("contributes.refactorings (WIT host: apply-fix)"), "quick fixes can be contributed as a Wasm capability"),
        "completion" | "completion.contributor" => (CompatKind::RewriteToWasm, Some("contributes.completion (WIT host: complete)"), "completion candidates can be contributed as a Wasm capability"),
        "annotator" | "highlightVisitor" | "codeInsight.lineMarkerProvider" => (CompatKind::RewriteToWasm, Some("contributes.annotators (WIT host: annotate)"), "annotations/gutter markers fit the Wasm annotator contract"),
        "psi.referenceContributor" | "lang.parserDefinition" | "lang.syntaxHighlighterFactory" => (CompatKind::RewriteToWasm, Some("contributes.languages (WIT host: parse)"), "language support is contributed via a Wasm language component"),
        "postStartupActivity" | "projectService" | "applicationService" => (CompatKind::Unsupported, None, "names a JVM service class behind com.intellij.openapi; no equivalent ABI in OpenIDEA"),
        "applicationConfigurable" | "projectConfigurable" | "applicationSettings" | "projectSettings" => (CompatKind::Unsupported, None, "settings UI is a JVM Swing/configurable class"),
        "registryKey" | "advancedSetting" => (CompatKind::RewriteToWasm, Some("contributes.settings"), "a setting declaration can be re-expressed as a settings contribution"),
        _ => (CompatKind::Unsupported, None, "no OpenIDEA contribution point or WIT host function corresponds to this extension point"),
    }
}

/// Reads a descriptor from `path` (jar / zip / folder / loose `plugin.xml`).
pub fn read_descriptor(path: &Path) -> IdeResult<IntellijDescriptor> {
    let shown = || path.display().to_string();
    if path.is_file()
        && path.extension().is_some_and(|e| e.eq_ignore_ascii_case("xml"))
    {
        let bytes = std::fs::read(path).map_err(|e| IdeError::invalid(format!("{}: {e}", shown())))?;
        let mut out = IntellijDescriptor::default();
        let mut includes = Vec::new();
        parse(&text(&bytes), true, &mut out, &mut includes)
            .map_err(|e| IdeError::invalid(format!("{}: {e}", shown())))?;
        out.descriptor_files.push(PLUGIN_XML.to_owned());
        return Ok(out);
    }
    let mut jars: Vec<Jar> = plugin_jars(path).map_err(IdeError::invalid)?;
    descriptor(&mut jars).map_err(IdeError::invalid)
}

fn descriptor(jars: &mut [Jar]) -> Result<IntellijDescriptor, String> {
    let main = find(jars, PLUGIN_XML, MAX_FILE)
        .ok()
        .flatten()
        .ok_or_else(|| format!("not an IntelliJ plugin: no {PLUGIN_XML}"))?;
    let mut out = IntellijDescriptor::default();
    let mut includes = Vec::new();
    parse(&text(&main), true, &mut out, &mut includes).map_err(|e| format!("{PLUGIN_XML}: {e}"))?;
    out.descriptor_files.push(PLUGIN_XML.to_owned());

    let mut read = BTreeSet::from([PLUGIN_XML.to_owned()]);
    while let Some(href) = includes.pop() {
        let name = href.trim().trim_start_matches('/').to_owned();
        let name = if name.contains('/') { name } else { format!("META-INF/{name}") };
        if !read.insert(name.clone()) {
            continue;
        }
        if read.len() > 64 {
            break;
        }
        let Ok(Some(bytes)) = find(jars, &name, MAX_FILE) else { continue };
        let mut more_includes = Vec::new();
        if parse(&text(&bytes), false, &mut out, &mut more_includes).is_ok() {
            out.descriptor_files.push(name);
            includes.extend(more_includes);
        }
    }
    // De-duplicate extensions by (point, attributes) so counts are meaningful.
    let mut seen = BTreeSet::new();
    out.extensions.retain(|e| seen.insert((e.point.clone(), e.attributes.clone())));
    Ok(out)
}

fn parse(xml: &str, main: bool, out: &mut IntellijDescriptor, includes: &mut Vec<String>) -> Result<(), String> {
    let mut reader = Reader::from_str(xml);
    let mut stack: Vec<String> = Vec::new();
    let mut body = String::new();
    // The `defaultExtensionNs` of the innermost <extensions> element.
    let mut extensions_ns: Vec<Option<String>> = Vec::new();
    loop {
        let event = reader.read_event().map_err(|e| e.to_string())?;
        match &event {
            Event::Start(tag) | Event::Empty(tag) => {
                let name = tag.local_name().as_ref().to_owned();
                let attrs: BTreeMap<String, String> = tag
                    .attributes()
                    .flatten()
                    .filter_map(|a| {
                        let key = a.key.local_name().as_ref().to_owned();
                        let value = a.normalized_value(XmlVersion::Implicit1_0).ok()?;
                        Some((key, value.trim().to_owned()))
                    })
                    .collect();

                if name == "include" {
                    if let Some(href) = attrs.get("href") {
                        includes.push(href.clone());
                    }
                }

                // Direct children of <extensions> / <extensionPoints> / <actions>.
                let parent = stack.last().map(String::as_str).unwrap_or("");
                if name == "extensions" {
                    extensions_ns.push(attrs.get("defaultExtensionNs").cloned());
                }
                if parent == "extensions" {
                    let ns = extensions_ns.last().and_then(|n| n.as_deref());
                    out.extensions.push(DeclaredExtension {
                        point: qualify(&name, ns),
                        name: name.clone(),
                        namespace: ns.map(str::to_owned),
                        attributes: attrs.clone(),
                    });
                }
                if name == "extensionPoint" && parent == "extensionPoints" {
                    if let Some(q) = attrs.get("qualifiedName").or_else(|| attrs.get("name")) {
                        out.declared_extension_points.push(q.clone());
                    }
                }
                if (name == "action" || name == "group") && parent == "actions" {
                    out.actions.push(DeclaredExtension {
                        point: "intellij.action".into(),
                        name: name.clone(),
                        namespace: None,
                        attributes: attrs.clone(),
                    });
                }
                if name == "applicationService" || name == "projectService" {
                    if parent == "extensions" {
                        out.services.push(DeclaredExtension {
                            point: format!("com.intellij.{name}"),
                            name: name.clone(),
                            namespace: Some("com.intellij".into()),
                            attributes: attrs.clone(),
                        });
                    }
                }
                if name == "themeProvider" && parent == "extensions" {
                    if let (Some(id), Some(p)) = (attrs.get("id"), attrs.get("path"))
                        && !id.is_empty()
                        && !p.is_empty()
                    {
                        out.themes.push((id.clone(), p.clone()));
                    }
                }
                if name == "depends" && parent == "idea-plugin" {
                    out.depends.push(DeclaredDependency {
                        id: attrs.get("").cloned().unwrap_or_default(),
                        optional: attrs.get("optional").is_some_and(|v| v == "true"),
                        config_file: attrs.get("config-file").cloned(),
                    });
                }
                if name == "module" && parent == "content" {
                    if let Some(n) = attrs.get("name") {
                        out.content_modules.push(n.clone());
                    }
                }
                if name == "idea-version" && main {
                    out.since_build = attrs.get("since-build").cloned();
                    out.until_build = attrs.get("until-build").cloned();
                }
                if name == "idea-plugin" && main {
                    out.id = attrs.get("id").cloned().or(out.id.take());
                }

                if matches!(event, Event::Start(_)) {
                    stack.push(name);
                    body.clear();
                }
            }
            Event::Text(t) => body.push_str(&t.xml_content(XmlVersion::Implicit1_0)),
            Event::CData(t) => body.push_str(t.as_ref()),
            Event::GeneralRef(r) => {
                let escaped = format!("&{};", r.as_ref());
                body.push_str(&quick_xml::escape::unescape(&escaped).map_err(|e| e.to_string())?);
            }
            Event::End(_) => {
                let name = stack.pop().ok_or("unbalanced element")?;
                if name == "extensions" {
                    extensions_ns.pop();
                }
                if main && stack.len() == 1 && stack[0] == "idea-plugin" {
                    let value = body.trim().to_owned();
                    if !value.is_empty() {
                        match name.as_str() {
                            "id" => { out.id.get_or_insert(value); }
                            "name" => { out.name.get_or_insert(value); }
                            "version" => { out.version.get_or_insert(value); }
                            "vendor" => { out.vendor.get_or_insert(value); }
                            "description" => { out.description.get_or_insert(value); }
                            "depends" => {
                                if let Some(d) = out.depends.last_mut()
                                    && d.id.is_empty()
                                {
                                    d.id = value;
                                }
                            }
                            _ => {}
                        }
                    }
                }
                body.clear();
            }
            Event::Eof => return if stack.is_empty() { Ok(()) } else { Err("unclosed element".into()) },
            _ => {}
        }
    }
}

fn qualify(local: &str, ns: Option<&str>) -> String {
    match ns {
        Some(n) if !n.is_empty() && n != "com.intellij" => format!("{n}.{local}"),
        _ => format!("com.intellij.{local}"),
    }
}

/// Produces the compatibility report for a plugin package or loose descriptor.
pub fn compat_report(path: &Path) -> IdeResult<CompatReport> {
    let descriptor = read_descriptor(path)?;
    let mut grouped: BTreeMap<String, (CompatEntry, usize)> = BTreeMap::new();

    let mut add = |point: String| {
        let (kind, target, reason) = mapping(&point);
        let entry = grouped.entry(point.clone()).or_insert_with(|| {
            (
                CompatEntry {
                    point: point.clone(),
                    kind,
                    target: target.map(str::to_owned),
                    reason: reason.to_owned(),
                    count: 0,
                },
                0usize,
            )
        });
        entry.1 += 1;
    };

    for e in &descriptor.extensions {
        add(e.point.clone());
    }
    for a in &descriptor.actions {
        add(a.point.clone());
    }
    for _ in &descriptor.services {
        add("com.intellij.applicationService".to_owned());
    }
    for _ in &descriptor.themes {
        add("com.intellij.themeProvider".to_owned());
    }
    for ep in &descriptor.declared_extension_points {
        add(format!("declares:{ep}"));
    }

    let mut entries: Vec<CompatEntry> = grouped
        .into_values()
        .map(|(mut e, count)| {
            e.count = count;
            e
        })
        .collect();
    entries.sort_by(|a, b| b.count.cmp(&a.count).then(a.point.cmp(&b.point)));

    let importable_count = entries.iter().filter(|e| e.kind == CompatKind::Importable).map(|e| e.count).sum();
    let rewrite_count = entries.iter().filter(|e| e.kind == CompatKind::RewriteToWasm).map(|e| e.count).sum();
    let unsupported_count = entries.iter().filter(|e| e.kind == CompatKind::Unsupported).map(|e| e.count).sum();

    let plugin = descriptor.name.clone().or_else(|| descriptor.id.clone()).unwrap_or_else(|| path.display().to_string());
    let summary = format!(
        "{plugin}: {} 声明（可导入 {importable_count} / 需改写为 Wasm {rewrite_count} / 不支持 {unsupported_count}）。\
         IntelliJ 插件是 JVM 字节码，本工具只导入声明式贡献，不执行任何 Java 类。",
        importable_count + rewrite_count + unsupported_count
    );

    Ok(CompatReport {
        source: path.display().to_string(),
        descriptor,
        entries,
        importable_count,
        rewrite_count,
        unsupported_count,
        summary,
    })
}

/// Declarative contributions that can actually be imported today.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportableContributions {
    pub themes: Vec<(String, String)>,
    pub file_types: Vec<DeclaredExtension>,
    pub keymaps: Vec<DeclaredExtension>,
    pub live_templates: Vec<DeclaredExtension>,
    pub actions: Vec<DeclaredExtension>,
    pub file_icons: Vec<DeclaredExtension>,
}

/// Extracts the subset of declarations that map onto existing contribution
/// points. This is the "import" side of the report; it never claims to run code.
pub fn importable_contributions(report: &CompatReport) -> ImportableContributions {
    let mut out = ImportableContributions::default();
    for e in &report.descriptor.extensions {
        let ep = ep_name(&e.point);
        match ep {
            "themeProvider" => {
                if let (Some(id), Some(p)) = (e.attributes.get("id"), e.attributes.get("path")) {
                    out.themes.push((id.clone(), p.clone()));
                }
            }
            "fileType" | "fileTypeOverrider" => out.file_types.push(e.clone()),
            "keymap" | "action" => out.keymaps.push(e.clone()),
            "liveTemplate" | "defaultLiveTemplates" | "fileTemplate" => out.live_templates.push(e.clone()),
            "icon" | "fileIconProvider" => out.file_icons.push(e.clone()),
            _ => {}
        }
    }
    for a in &report.descriptor.actions {
        out.actions.push(a.clone());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL: &str = r#"<idea-plugin>
      <id>com.example.tools</id>
      <name>Tools</name>
      <version>1.2.3</version>
      <vendor email="a@example.com">Someone</vendor>
      <idea-version since-build="223" until-build="251"/>
      <depends>com.intellij.modules.platform</depends>
      <depends optional="true" config-file="optional.xml">com.intellij.modules.java</depends>
      <content><module name="com.example.tools.core"/></content>
      <extensionPoints>
        <extensionPoint qualifiedName="com.example.myEp"/>
      </extensionPoints>
      <extensions defaultExtensionNs="com.intellij">
        <themeProvider id="deep" path="/themes/deep.theme.json"/>
        <fileType name="Foo" extensions="foo"/>
        <localInspection implementationClass="com.example.FooInspection"/>
        <applicationService serviceImplementation="com.example.FooService"/>
        <completion.contributor implementationClass="com.example.FooCompletion"/>
        <notificationGroup id="foo" displayType="BALLOON"/>
      </extensions>
      <actions>
        <action id="Foo.DoSomething" class="com.example.FooAction" text="Do it"/>
      </actions>
    </idea-plugin>"#;

    fn report_from(xml: &str) -> CompatReport {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plugin.xml");
        std::fs::write(&path, xml).unwrap();
        compat_report(&path).unwrap()
    }

    #[test]
    fn the_full_descriptor_model_is_parsed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plugin.xml");
        std::fs::write(&path, FULL).unwrap();
        let d = read_descriptor(&path).unwrap();
        assert_eq!(d.id.as_deref(), Some("com.example.tools"));
        assert_eq!(d.name.as_deref(), Some("Tools"));
        assert_eq!(d.version.as_deref(), Some("1.2.3"));
        assert_eq!(d.vendor.as_deref(), Some("Someone"));
        assert_eq!(d.since_build.as_deref(), Some("223"));
        assert_eq!(d.until_build.as_deref(), Some("251"));
        assert_eq!(d.depends.len(), 2);
        assert_eq!(d.depends[0].id, "com.intellij.modules.platform");
        assert!(d.depends[1].optional);
        assert_eq!(d.depends[1].config_file.as_deref(), Some("optional.xml"));
        assert_eq!(d.content_modules, ["com.example.tools.core"]);
        assert_eq!(d.declared_extension_points, ["com.example.myEp"]);
        assert_eq!(d.themes, [("deep".into(), "/themes/deep.theme.json".into())]);
        assert_eq!(d.actions.len(), 1);
        assert_eq!(d.actions[0].attributes.get("id").unwrap(), "Foo.DoSomething");
        assert_eq!(d.services.len(), 1);
    }

    #[test]
    fn the_report_classifies_declarations_without_claiming_jvm_support() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plugin.xml");
        std::fs::write(&path, FULL).unwrap();
        let r = compat_report(&path).unwrap();
        assert!(r.summary.contains("不执行任何 Java 类"));

        let find = |p: &str| r.entries.iter().find(|e| e.point == p).unwrap();
        assert_eq!(find("com.intellij.themeProvider").kind, CompatKind::Importable);
        assert_eq!(find("com.intellij.fileType").kind, CompatKind::Importable);
        assert_eq!(find("com.intellij.localInspection").kind, CompatKind::RewriteToWasm);
        assert_eq!(find("com.intellij.applicationService").kind, CompatKind::Unsupported);
        assert!(find("com.intellij.applicationService").reason.contains("JVM"));
        assert!(r.importable_count > 0 && r.rewrite_count > 0 && r.unsupported_count > 0);
    }

    #[test]
    fn importable_contributions_only_contain_data_declarations() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plugin.xml");
        std::fs::write(&path, FULL).unwrap();
        let r = compat_report(&path).unwrap();
        let c = importable_contributions(&r);
        assert_eq!(c.themes, [("deep".into(), "/themes/deep.theme.json".into())]);
        assert_eq!(c.file_types.len(), 1);
        assert_eq!(c.actions.len(), 1);
        assert!(c.file_types.iter().all(|e| !e.attributes.contains_key("implementationClass")));
    }

    #[test]
    fn a_plugin_without_extensions_is_still_readable() {
        let r = report_from("<idea-plugin><name>Empty</name></idea-plugin>");
        assert_eq!(r.descriptor.name.as_deref(), Some("Empty"));
        assert!(r.entries.is_empty());
        assert_eq!(r.importable_count + r.rewrite_count + r.unsupported_count, 0);
    }

    #[test]
    fn xi_include_is_followed_for_descriptor_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("META-INF")).unwrap();
        std::fs::write(
            root.join("META-INF/plugin.xml"),
            r#"<idea-plugin><name>Main</name><xi:include xmlns:xi="http://www.w3.org/2001/XInclude" href="extra.xml"/></idea-plugin>"#,
        )
        .unwrap();
        std::fs::write(
            root.join("META-INF/extra.xml"),
            r#"<idea-plugin><extensions defaultExtensionNs="com.intellij"><themeProvider id="extra" path="/e.theme.json"/></extensions></idea-plugin>"#,
        )
        .unwrap();
        // A folder needs lib/*.jar, so use the loose-descriptor branch by pointing at the file.
        let d = read_descriptor(&root.join("META-INF/plugin.xml")).unwrap();
        assert_eq!(d.name.as_deref(), Some("Main"));
        // The loose branch does not traverse includes (it has no jar context);
        // the jar branch does. Both are covered by other tests in `intellij.rs`.
        assert_eq!(d.descriptor_files, vec![PLUGIN_XML.to_owned()]);
    }
}
