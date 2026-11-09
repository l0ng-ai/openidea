//! Real stdio LSP through a registered plugin wrapper, without a container daemon.
#![cfg(unix)]
use ide_core::{DocId, IdeEvent, LanguageId, Pos};
use ide_host::{
    Host, HostConfig,
    plugins::{Consent, HostWorkspace, PluginEvent, PluginHost},
};
use ide_language::{LanguageConfig, LanguageRegistry};
use ide_plugin::{Invocation, Limits};
use parking_lot::Mutex;
use serde_json::json;
use std::{os::unix::fs::PermissionsExt, path::PathBuf, sync::Arc, time::Duration};

const SERVER: &str = r#"import sys,json,os
root = 'file:///container' if os.environ.get('FAKE_IN_TARGET') else sys.argv[3]
def send(v):
    body=json.dumps(v).encode(); sys.stdout.buffer.write(('Content-Length: %d\r\n\r\n'%len(body)).encode()+body); sys.stdout.buffer.flush()
while True:
    headers={}
    while True:
        line=sys.stdin.buffer.readline()
        if not line: sys.exit(0)
        if line in (b'\r\n',b'\n'): break
        k,v=line.decode().split(':',1); headers[k.lower()]=v.strip()
    msg=json.loads(sys.stdin.buffer.read(int(headers['content-length'])))
    method=msg.get('method'); params=msg.get('params',{})
    if method=='initialize':
        assert params['rootUri']==root,params
        assert params['rootPath']==root.removeprefix('file://'),params
        assert params['workspaceFolders'][0]['uri']==root,params
        open(sys.argv[1],'a').write(json.dumps(params)+'\n')
        result={'capabilities':{'textDocumentSync':1,'definitionProvider':True,'documentLinkProvider':True}}
    elif method=='textDocument/didOpen':
        if params['textDocument']['uri'] != root+'/main.mock': continue
        send({'jsonrpc':'2.0','method':'textDocument/publishDiagnostics','params':{'uri':root+'/main.mock','diagnostics':[{'range':{'start':{'line':0,'character':0},'end':{'line':0,'character':1}},'message':'mapped diagnostic','severity':2}]}})
        continue
    elif method=='textDocument/documentLink':
        result=[{'target':sys.argv[2]+'#L2','range':{'start':{'line':0,'character':0},'end':{'line':0,'character':1}}}]
    elif method=='textDocument/definition':
        assert params['textDocument']['uri']==root+'/main.mock',params
        r={'start':{'line':0,'character':0},'end':{'line':0,'character':1}}
        result=[{'uri':root+'/definition.mock','range':r},{'uri':sys.argv[2],'range':r}]
    elif method=='shutdown': result=None
    elif method=='exit': sys.exit(0)
    else:
        if 'id' not in msg: continue
        result=None
    send({'jsonrpc':'2.0','id':msg['id'],'result':result})
"#;

#[tokio::test(flavor = "multi_thread")]
async fn initialize_definition_diagnostics_external_read_only_and_withdrawal() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("project");
    std::fs::create_dir(&root).unwrap();
    let source = root.join("main.mock");
    std::fs::write(&source, "x").unwrap();
    std::fs::write(root.join("definition.mock"), "x").unwrap();
    let library = base.join("library with space.mock");
    std::fs::write(&library, "read only library").unwrap();
    let log = base.join("initialize.json");
    let reads = base.join("reads");
    let server = base.join("server.py");
    std::fs::write(&server, SERVER).unwrap();
    let wrapper = base.join("wrapper");
    std::fs::write(
        &wrapper,
        format!(
            r#"#!/bin/sh
[ "$1" = wrapped ] && [ "$2" = --cwd=/container ] || exit 91
shift 2
if [ "$1" = cat ]; then printf '%s' "$3" > '{}'; fi
export FAKE_IN_TARGET=1
exec "$@"
"#,
            reads.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut language: LanguageConfig = toml::from_str(
        "id='mock'\nname='Mock'\nextensions=['mock']\n[[language-servers]]\nname='mock-ls'\ncommand='python3'",
    )
    .unwrap();
    language.language_servers[0].args = vec![
        server.to_string_lossy().into(),
        log.to_string_lossy().into(),
        ide_lsp::path_to_uri_string(&library),
        ide_lsp::path_to_uri_string(&root),
    ];
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink_events = events.clone();
    let host = Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("local"),
        languages: Arc::new(LanguageRegistry::from_configs(vec![language])),
        syntax: Arc::default(),
        sink_for: Box::new(move |_| {
            let e = sink_events.clone();
            Arc::new(move |event: IdeEvent| e.lock().push(event))
        }),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }));
    host.open_project("main", &root).unwrap();
    host.set_project_trust(&root, true, false).await.unwrap();
    let plugins = Arc::new(
        PluginHost::new(base.join("plugins"), Arc::new(|_: Option<&str>, _: PluginEvent| {}), Limits::default())
            .unwrap(),
    );
    plugins.set_workspace(Some(Arc::new(HostWorkspace(Arc::downgrade(&host)))));
    host.set_plugin_host(&plugins);
    let package = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/execution");
    plugins.install_from_dir(&package, &Consent::all()).unwrap();
    plugins.choose_program("execution", "process:execution-tool", Some(&root), Some(&wrapper)).unwrap();
    let invocation =
        || Invocation { client: Some("main".into()), workspace_root: Some(root.clone()), ..Default::default() };
    plugins.run_command("execution", "target", None, invocation()).unwrap();
    let id = plugins.run_targets(&root)[0].id.clone();
    let project = host.project("main").unwrap();
    project
        .settings
        .set(
            ide_workspace::SettingsScope::Project,
            "languageServerTargets",
            json!({"mock":{"target":id,"server":"mock-ls"}}),
        )
        .unwrap();
    let doc = DocId::next();
    project.lsp.did_open(doc, &source, &LanguageId::new("mock"), 1, "x");
    // Links have no previously recorded location origin. Their URI must identify
    // the right server by itself, including when its fragment is stripped.
    let links = project.lsp.document_links(doc).await.unwrap();
    let link = &links[0];
    assert_eq!(link.fragment.as_deref(), Some("L2"));
    assert!(link.url.is_none());
    let linked =
        ide_host::ops::doc::doc_open_virtual(&host, "main", link.path.as_ref().unwrap().to_string_lossy().into_owned())
            .await
            .unwrap();
    assert!(linked.read_only);
    let locations = tokio::time::timeout(
        Duration::from_secs(15),
        project.lsp.goto(doc, Pos::new(0, 0), ide_lsp::types::GotoKind::Definition),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(locations[0].path.to_path_buf(), root.join("definition.mock"));
    assert!(log.exists(), "initialize reached the fake server with the mapped root");
    for _ in 0..200 {
        if events.lock().iter().any(|e| matches!(e,IdeEvent::Diagnostics{path,items,..} if path.to_path_buf()==source && items.iter().any(|d| d.message=="mapped diagnostic"))) { break; }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(events.lock().iter().any(|e| matches!(e,IdeEvent::Diagnostics{path,items,..} if path.to_path_buf()==source && items.iter().any(|d| d.message=="mapped diagnostic"))));
    let uri = locations[1].uri.clone().expect("external paths are virtual documents");
    assert!(uri.starts_with("openidea-target:"));
    let opened = ide_host::ops::doc::doc_open_virtual(&host, "main", uri.clone()).await.unwrap();
    assert!(opened.read_only);
    assert_eq!(project.documents.text_of(std::path::Path::new(&uri)).unwrap(), "read only library");
    assert_eq!(std::fs::read_to_string(&reads).unwrap(), library.to_string_lossy());
    assert!(
        project
            .documents
            .apply_edits(opened.id, &[ide_core::TextEdit { range: Default::default(), new_text: "bad".into() }])
            .is_err()
    );
    for operation in [
        ide_core::FileEdit::Create { path: uri.clone().into(), overwrite: true },
        ide_core::FileEdit::Delete { path: uri.clone().into(), recursive: false },
        ide_core::FileEdit::Rename { from: uri.clone().into(), to: root.join("copy.mock").into() },
        ide_core::FileEdit::Edit { path: uri.clone().into(), version: None, edits: Vec::new() },
    ] {
        let mut edit = ide_core::WorkspaceEdit { files: vec![operation], ..Default::default() };
        assert!(project.documents.prepare_workspace_edit(&mut edit).is_err());
    }
    // A library tab must not prevent ordinary project refactorings.
    project
        .documents
        .apply_workspace_edit(&ide_core::WorkspaceEdit {
            files: vec![ide_core::FileEdit::Create { path: root.join("created.mock").into(), overwrite: false }],
            ..Default::default()
        })
        .unwrap();
    assert!(root.join("created.mock").exists());
    // Changing the project setting restarts on the host, then back inside the target.
    let selection = json!({"mock":{"target":id,"server":"mock-ls"}});
    for value in [json!({}), selection.clone()] {
        project.settings.set(ide_workspace::SettingsScope::Project, "languageServerTargets", value.clone()).unwrap();
        project.lsp.reconfigure().await;
        let expected = if value == json!({}) { ide_lsp::path_to_uri_string(&root) } else { "file:///container".into() };
        wait_root(&log, &expected).await;
    }
    // Withdrawal invalidates reads, even when contents were cached earlier.
    plugins.run_command("execution", "untarget", None, invocation()).unwrap();
    assert!(project.lsp.virtual_document(&uri).await.is_err());
    wait_root(&log, &ide_lsp::path_to_uri_string(&root)).await;
    plugins.run_command("execution", "target", None, invocation()).unwrap();
    wait_root(&log, "file:///container").await;
    plugins.set_enabled("execution", false).unwrap();
    assert!(project.lsp.virtual_document(&uri).await.is_err());
    wait_root(&log, &ide_lsp::path_to_uri_string(&root)).await;
    host.shutdown().await;
    plugins.shutdown();
}

async fn wait_root(log: &std::path::Path, expected: &str) {
    for _ in 0..500 {
        let text = std::fs::read_to_string(log).unwrap_or_default();
        if text
            .lines()
            .last()
            .and_then(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .is_some_and(|v| v["rootUri"] == expected)
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("server did not initialize with {expected}: {}", std::fs::read_to_string(log).unwrap_or_default());
}
