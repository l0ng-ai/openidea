use crate::ops::Channel;
use ide_core::{CancellationToken, IdeError, IdeResult, RequestId};
use ide_vcs::{RebaseEdit, RebaseEditorReply};
use parking_lot::Mutex;
use serde::Serialize;
use specta::Type;
use std::collections::HashMap;
use std::sync::mpsc;
use std::time::Duration;

#[derive(Serialize, Type)]
pub struct RebaseEditorPrompt {
    pub index: u32,
    pub edit: RebaseEdit,
}

type EditorKey = (String, RequestId, u32);

#[derive(Default)]
pub(crate) struct RebaseEditors {
    pending: Mutex<HashMap<EditorKey, mpsc::Sender<Option<RebaseEditorReply>>>>,
}

impl RebaseEditors {
    pub fn wait(
        &self,
        window: &str,
        request: RequestId,
        prompt: RebaseEditorPrompt,
        channel: &Channel<RebaseEditorPrompt>,
        cancel: &CancellationToken,
    ) -> Option<RebaseEditorReply> {
        let key = (window.to_owned(), request, prompt.index);
        let (send, recv) = mpsc::channel();
        self.pending.lock().insert(key.clone(), send);
        let result = (|| {
            channel.send(prompt).ok()?;
            while !cancel.is_cancelled() {
                match recv.recv_timeout(Duration::from_millis(100)) {
                    Ok(reply) => return reply,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            None
        })();
        self.pending.lock().remove(&key);
        result
    }

    pub fn reply(
        &self,
        window: &str,
        request: RequestId,
        index: u32,
        reply: Option<RebaseEditorReply>,
    ) -> IdeResult<()> {
        let expired = || IdeError::invalid("The Git editor request is no longer active.");
        let send = self.pending.lock().remove(&(window.to_owned(), request, index)).ok_or_else(expired)?;
        send.send(reply).map_err(|_| expired())
    }
}
