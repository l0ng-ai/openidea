//! [`JvmInspector`] over the `openidea.jvm.*` commands of the JVM inspector bundle that runs inside
//! jdtls next to java-debug (`java/jvm-inspect`).

use super::missing_bundle;
use crate::LspManager;
use ide_core::IdeError;
use ide_jvm_inspect::{
    ClassCount, InspectError, InspectFuture, JvmField, JvmInspector, JvmReferrer, JvmValue, ObjectId, VmTarget,
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::{Instant, timeout_at};

const CLASSES_TIMEOUT: Duration = Duration::from_secs(90);
const REFERRERS_TIMEOUT: Duration = Duration::from_secs(90);
const INSTANCES_TIMEOUT: Duration = Duration::from_secs(30);
const FIELDS_TIMEOUT: Duration = Duration::from_secs(15);

pub struct JdtJvmInspector {
    lsp: Arc<LspManager>,
    /// A path inside the module whose jdtls runs the debug session.
    server: PathBuf,
    /// The bundle serializes commands per VM and waits without bound on the JDT LS thread pool,
    /// so a second command in flight can only queue behind the first one.
    turn: Arc<tokio::sync::Mutex<()>>,
}

impl JdtJvmInspector {
    pub fn new(lsp: Arc<LspManager>, server: PathBuf) -> Self {
        Self { lsp, server, turn: Arc::new(tokio::sync::Mutex::new(())) }
    }

    /// Runs `openidea.jvm.<op>`; `limit` covers waiting for the turn as well as the command.
    async fn call<T: DeserializeOwned>(
        &self,
        op: &str,
        target: &VmTarget,
        args: Vec<Value>,
        limit: Duration,
    ) -> Result<T, InspectError> {
        let deadline = Instant::now() + limit;
        let turn = timeout_at(deadline, self.turn.clone().lock_owned()).await.map_err(|_| InspectError::TimedOut)?;
        let lsp = self.lsp.clone();
        let server = self.server.clone();
        let command = format!("openidea.jvm.{op}");
        let arguments: Vec<Value> = std::iter::once(target_json(target)).chain(args).collect();
        // Spawned so that a caller that gave up keeps the turn until jdtls answers or its own
        // timeout fires: the bundle is still working on the abandoned command until then.
        let task = tokio::spawn(async move {
            let _turn = turn;
            lsp.jdtls_command(&server, &command, arguments).await
        });
        let reply = match timeout_at(deadline, task).await {
            Err(_) => return Err(InspectError::TimedOut),
            Ok(Err(joined)) => return Err(InspectError::Failed(joined.to_string())),
            Ok(Ok(reply)) => reply.map_err(command_error)?,
        };
        decode(reply)
    }
}

/// `VmTarget` is not `Serialize`: the field names here are the bundle's.
fn target_json(target: &VmTarget) -> Value {
    json!({
        "pid": target.pid,
        "host": target.attach_host,
        "port": target.attach_port,
        "generation": target.generation,
    })
}

fn command_error(e: IdeError) -> InspectError {
    if missing_bundle(&e) {
        InspectError::Unsupported("the JVM inspector bundle is not loaded".to_owned())
    } else {
        InspectError::Failed(e.message)
    }
}

/// `{"ok": payload}` or `{"error": code, "detail": text}`.
fn decode<T: DeserializeOwned>(mut reply: Value) -> Result<T, InspectError> {
    if let Some(code) = reply.get("error").and_then(Value::as_str) {
        let detail = reply.get("detail").and_then(Value::as_str);
        return Err(match code {
            "unsupported" => {
                InspectError::Unsupported(detail.unwrap_or("the JVM inspector cannot read this JVM").to_owned())
            }
            "vmNotFound" => InspectError::VmNotFound,
            "stale" => InspectError::Stale,
            "collected" => InspectError::Collected,
            "classNotLoaded" => InspectError::ClassNotLoaded,
            "notSuspended" => InspectError::NotSuspended,
            "timedOut" => InspectError::TimedOut,
            other => InspectError::Failed(match detail {
                Some(detail) => format!("{other}: {detail}"),
                None => other.to_owned(),
            }),
        });
    }
    let payload = reply
        .get_mut("ok")
        .map(Value::take)
        .ok_or_else(|| InspectError::Failed(format!("unexpected reply from the JVM inspector: {reply}")))?;
    serde_json::from_value(payload).map_err(|e| InspectError::Failed(format!("malformed JVM inspector reply: {e}")))
}

impl JvmInspector for JdtJvmInspector {
    fn class_counts<'a>(&'a self, target: &'a VmTarget) -> InspectFuture<'a, Vec<ClassCount>> {
        Box::pin(self.call("classes", target, Vec::new(), CLASSES_TIMEOUT))
    }

    fn instances<'a>(
        &'a self,
        target: &'a VmTarget,
        class_name: &'a str,
        limit: u32,
    ) -> InspectFuture<'a, Vec<JvmValue>> {
        Box::pin(self.call("instances", target, vec![json!(class_name), json!(limit)], INSTANCES_TIMEOUT))
    }

    fn fields<'a>(&'a self, target: &'a VmTarget, object: ObjectId) -> InspectFuture<'a, Vec<JvmField>> {
        Box::pin(self.call("fields", target, vec![json!(object)], FIELDS_TIMEOUT))
    }

    fn referrers<'a>(
        &'a self,
        target: &'a VmTarget,
        object: ObjectId,
        limit: u32,
    ) -> InspectFuture<'a, Vec<JvmReferrer>> {
        Box::pin(self.call("referrers", target, vec![json!(object), json!(limit)], REFERRERS_TIMEOUT))
    }
}
