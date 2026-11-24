//! Exception breakpoints on a chosen class, armed through a session's backend.

use super::*;
use ide_jvm_inspect::{ExceptionArmState, ExceptionClassBreakpoints, ExceptionClassSpec, InspectFuture, VmTarget};

/// The target, the list, and the DAP requests sent before it.
type ArmCall = (VmTarget, Vec<ExceptionClassSpec>, Vec<String>);

/// Records each list it is given with the DAP requests sent before it.
struct FakeArmer {
    log: Log,
    calls: Mutex<Vec<ArmCall>>,
}

impl FakeArmer {
    fn new(h: &Harness) -> Arc<Self> {
        Arc::new(Self { log: h.log.clone(), calls: Mutex::default() })
    }

    fn lists(&self) -> Vec<Vec<String>> {
        self.calls.lock().iter().map(|(_, specs, _)| specs.iter().map(|s| s.class_name.clone()).collect()).collect()
    }

    /// The DAP requests sent before each call.
    fn before(&self) -> Vec<Vec<String>> {
        self.calls.lock().iter().map(|(_, _, sent)| sent.clone()).collect()
    }
}

impl ExceptionClassBreakpoints for FakeArmer {
    fn set<'a>(
        &'a self,
        target: &'a VmTarget,
        breakpoints: &'a [ExceptionClassSpec],
    ) -> InspectFuture<'a, Vec<(String, ExceptionArmState)>> {
        let sent = self
            .log
            .lock()
            .iter()
            .filter(|m| m["type"] == "request")
            .map(|m| m["command"].as_str().unwrap().to_owned())
            .collect();
        self.calls.lock().push((target.clone(), breakpoints.to_vec(), sent));
        let states = breakpoints.iter().map(|b| (b.id.clone(), ExceptionArmState::Armed)).collect();
        Box::pin(async move { Ok(states) })
    }
}

fn class_bp(id: &str, class_name: &str) -> ExceptionClassBreakpoint {
    ExceptionClassBreakpoint {
        id: id.into(),
        class_name: class_name.into(),
        caught: true,
        uncaught: true,
        enabled: true,
        class_filters: vec![],
        class_exclusion_filters: vec![],
    }
}

/// A java-debug attach to a JVM on another machine: the target is known from the request alone.
fn attach() -> LaunchConfig {
    LaunchConfig {
        extra_json: Some(json!({"hostName": "10.0.0.5", "port": 5005}).to_string()),
        ..java_config("attach")
    }
}

async fn start(h: &Harness, config: LaunchConfig, armer: &Arc<FakeArmer>) -> DebugSessionId {
    let backend: Arc<dyn ExceptionClassBreakpoints> = armer.clone();
    h.manager.start_with_exception_classes(config, h.owner.clone(), |_| None, Some(backend)).await.unwrap()
}

#[tokio::test]
async fn armed_after_the_exception_filters_and_before_configuration_done() {
    let h = harness(Script::default());
    let armer = FakeArmer::new(&h);
    let filtered = ExceptionClassBreakpoint {
        caught: false,
        enabled: false,
        class_filters: vec!["com.acme.*".into()],
        class_exclusion_filters: vec!["*Test".into()],
        ..class_bp("b", "com.acme.Boom")
    };
    h.manager.set_exception_class_breakpoints(vec![class_bp("a", "java.lang.IllegalStateException"), filtered]).await;
    start(&h, attach(), &armer).await;

    assert_eq!(armer.before(), [["initialize", "attach", "setExceptionBreakpoints"]]);
    let (target, specs, _) = armer.calls.lock()[0].clone();
    assert_eq!((target.pid, target.attach_host.as_deref(), target.attach_port), (None, Some("10.0.0.5"), Some(5005)));
    assert_eq!(
        specs[1],
        ExceptionClassSpec {
            id: "b".into(),
            class_name: "com.acme.Boom".into(),
            caught: false,
            uncaught: true,
            enabled: false,
            class_filters: vec!["com.acme.*".into()],
            class_exclusion_filters: vec!["*Test".into()],
        }
    );
    assert!(h.commands().contains(&"configurationDone".to_owned()));
}

#[tokio::test]
async fn armed_again_after_every_set_exception_breakpoints() {
    let h = harness(Script::default());
    let armer = FakeArmer::new(&h);
    h.manager.set_exception_class_breakpoints(vec![class_bp("a", "com.acme.Boom")]).await;
    start(&h, attach(), &armer).await;
    h.manager.set_exception_breakpoints(BTreeMap::from([("raised".into(), true)])).await.unwrap();

    assert_eq!(armer.lists(), [["com.acme.Boom"], ["com.acme.Boom"]]);
    let last = armer.before().pop().unwrap();
    assert_eq!(last.iter().filter(|c| *c == "setExceptionBreakpoints").count(), 2, "{last:?}");
}

#[tokio::test]
async fn a_new_list_reaches_the_sessions_that_take_it() {
    let h = harness(Script::default());
    let armer = FakeArmer::new(&h);
    start(&h, attach(), &armer).await;
    let other = h.start(attach()).await.unwrap();
    assert!(armer.lists().is_empty(), "nothing to arm at start");

    h.manager.set_exception_class_breakpoints(vec![class_bp("a", "com.acme.Boom")]).await;
    h.manager.set_exception_class_breakpoints(vec![]).await;
    assert_eq!(armer.lists(), [vec!["com.acme.Boom".to_owned()], vec![]], "an empty list takes them down");

    let filters = h.manager.exception_filters(None);
    let support = |id| filters.iter().find(|f| f.session == id).unwrap().classes.clone();
    assert_eq!(support(other), None);
    let java = filters.iter().find(|f| f.session != other).unwrap().session;
    assert_eq!(
        support(java),
        Some(ExceptionClassSupport {
            family: "java".into(),
            condition: false,
            class_filters: true,
            catch_filters: false
        })
    );
}

#[tokio::test]
async fn nothing_is_sent_before_the_jvm_is_known() {
    let h = harness(Script::default());
    let armer = FakeArmer::new(&h);
    h.manager.set_exception_class_breakpoints(vec![class_bp("a", "com.acme.Boom")]).await;
    // The fake adapter sends no `process` event before `configurationDone`: no pid to name.
    start(&h, java_config("launch"), &armer).await;
    assert!(armer.lists().is_empty());
}
