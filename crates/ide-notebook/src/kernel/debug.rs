//! A notebook kernel's debugger as a DAP stream, for the IDE's DAP client.
//!
//! The kernel compiles each cell's code as a file of its own (`<tmp>/<hash of the code>.py`).
//! Once the debugger starts, every cell's code is sent with `dumpCell`, which writes that file
//! and names it. Paths are then rewritten both ways: the IDE's cell URIs to the kernel's files
//! in requests, the kernel's files to cell URIs in responses and events.

use super::KernelDebugger;
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, DuplexStream};
use tokio::sync::mpsc;

/// DAP messages larger than this end the session (a kernel reply is far smaller).
const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
/// Sequence numbers of the bridge's own requests, above any the IDE uses.
const OWN_SEQ: i64 = 1 << 40;
const CANNOT_DEBUG: &str = "this kernel cannot debug: it needs ipykernel 6 or later with debugpy installed";

/// Starts the bridge; the IDE reads and writes DAP on the returned stream. `cells` are the
/// notebook's code cells as (URI, source). Closing the stream disconnects the debugger, which
/// leaves the kernel and its state running.
pub fn dap_stream(debugger: KernelDebugger, cells: Vec<(String, String)>) -> DuplexStream {
    let (ide, ours) = tokio::io::duplex(1 << 16);
    tokio::spawn(bridge(debugger, cells, ours));
    ide
}

async fn bridge(mut debugger: KernelDebugger, cells: Vec<(String, String)>, stream: DuplexStream) {
    let (read, mut write) = tokio::io::split(stream);
    let (requests, mut from_ide) = mpsc::channel::<Value>(64);
    let reader = tokio::spawn(async move {
        let mut read = BufReader::new(read);
        while let Ok(Some(message)) = read_message(&mut read).await {
            if requests.send(message).await.is_err() {
                break;
            }
        }
    });
    let mut map = PathMap::default();
    // The bridge's dumpCell requests in flight, by seq; the IDE's requests wait for them.
    let mut dumping: HashMap<i64, String> = HashMap::new();
    let mut held: Vec<Value> = Vec::new();
    let mut seq = OWN_SEQ;
    let mut disconnected = false;
    // The IDE's requests the kernel has not answered yet, in order: the control channel
    // answers them in turn, and a kernel without debugpy answers with no message at all.
    let mut unanswered: VecDeque<(Value, Value)> = VecDeque::new();
    loop {
        tokio::select! {
            request = from_ide.recv() => {
                let Some(mut request) = request else { break };
                // Never end the kernel: it is the notebook's, not the debug session's.
                if request["command"] == "terminate" {
                    let reply = json!({"type": "response", "request_seq": request["seq"], "command": "terminate", "success": true});
                    if write_message(&mut write, &reply).await.is_err() {
                        break;
                    }
                    continue;
                }
                if request["command"] == "disconnect" {
                    disconnected = true;
                    request["arguments"]["terminateDebuggee"] = json!(false);
                }
                if !dumping.is_empty() {
                    held.push(request);
                    continue;
                }
                map.to_kernel(&mut request);
                unanswered.push_back((request["seq"].clone(), request["command"].clone()));
                if debugger.send(request).await.is_err() {
                    break;
                }
            }
            message = debugger.receive() => {
                let Some(mut message) = message else { break };
                if message["type"] == "response"
                    && let Some(uri) = message["request_seq"].as_i64().and_then(|seq| dumping.remove(&seq))
                {
                    if let Some(path) = message["body"]["sourcePath"].as_str() {
                        map.insert(uri, path.to_owned());
                    }
                    if dumping.is_empty() {
                        for mut request in held.drain(..) {
                            map.to_kernel(&mut request);
                            unanswered.push_back((request["seq"].clone(), request["command"].clone()));
                            let _ = debugger.send(request).await;
                        }
                    }
                    continue;
                }
                // The kernel starts its debugger on `initialize`: then the cells can be dumped.
                if message.get("type").is_none() {
                    let Some((seq, command)) = unanswered.pop_front() else { continue };
                    message = json!({"type": "response", "request_seq": seq, "command": command,
                        "success": false, "message": CANNOT_DEBUG});
                } else if message["type"] == "response" {
                    unanswered.retain(|(seq, _)| *seq != message["request_seq"]);
                }
                let initialize = message["type"] == "response" && message["command"] == "initialize";
                let started = initialize && message["success"] == true;
                if initialize && !started && message.get("message").is_none() {
                    message["message"] = json!(CANNOT_DEBUG);
                }
                map.to_ide(&mut message);
                if write_message(&mut write, &message).await.is_err() {
                    break;
                }
                if started {
                    for (uri, code) in &cells {
                        seq += 1;
                        dumping.insert(seq, uri.clone());
                        let dump = json!({"type": "request", "seq": seq, "command": "dumpCell", "arguments": {"code": code}});
                        let _ = debugger.send(dump).await;
                    }
                }
            }
        }
    }
    reader.abort();
    // Breakpoints left behind would stop later runs with no one to continue them.
    if !disconnected {
        let disconnect = json!({"type": "request", "seq": seq + 1, "command": "disconnect",
            "arguments": {"restart": false, "terminateDebuggee": false}});
        let _ = debugger.send(disconnect).await;
    }
}

/// Cell URIs and the kernel's files for their code.
#[derive(Default)]
struct PathMap {
    to_kernel: HashMap<String, String>,
    to_ide: HashMap<String, String>,
}

impl PathMap {
    fn insert(&mut self, uri: String, path: String) {
        self.to_ide.insert(path.clone(), uri.clone());
        self.to_kernel.insert(uri, path);
    }

    fn to_kernel(&self, message: &mut Value) {
        rewrite(message, &self.to_kernel);
    }

    fn to_ide(&self, message: &mut Value) {
        rewrite(message, &self.to_ide);
    }
}

/// Rewrites the `path` of every `source` object in `value`.
fn rewrite(value: &mut Value, paths: &HashMap<String, String>) {
    match value {
        Value::Object(object) => {
            if let Some(Value::Object(source)) = object.get_mut("source")
                && let Some(mapped) = source.get("path").and_then(Value::as_str).and_then(|path| paths.get(path))
            {
                source.insert("path".into(), Value::String(mapped.clone()));
                // The kernel's name is its file's (`908337371.py`); the IDE names the cell.
                source.remove("name");
            }
            object.values_mut().for_each(|value| rewrite(value, paths));
        }
        Value::Array(values) => values.iter_mut().for_each(|value| rewrite(value, paths)),
        _ => {}
    }
}

async fn read_message<R: AsyncReadExt + AsyncBufReadExt + Unpin>(read: &mut R) -> std::io::Result<Option<Value>> {
    let mut length = None;
    loop {
        let mut line = String::new();
        if read.read_line(&mut line).await? == 0 {
            return Ok(None);
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            length = value.trim().parse::<usize>().ok();
        }
    }
    let length = length.filter(|length| *length <= MAX_MESSAGE_BYTES).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "DAP message without a valid Content-Length")
    })?;
    let mut body = vec![0; length];
    read.read_exact(&mut body).await?;
    serde_json::from_slice(&body).map(Some).map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
}

async fn write_message<W: AsyncWriteExt + Unpin>(write: &mut W, message: &Value) -> std::io::Result<()> {
    let body = message.to_string();
    write.write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes()).await?;
    write.write_all(body.as_bytes()).await?;
    write.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_rewritten_in_every_source() {
        let mut map = PathMap::default();
        map.insert("vscode-notebook-cell:/p/a.ipynb#c1".into(), "/tmp/ipykernel_1/123.py".into());
        let mut request = json!({"command": "setBreakpoints", "arguments": {
            "source": {"path": "vscode-notebook-cell:/p/a.ipynb#c1", "name": "a.ipynb#c1"}, "breakpoints": [{"line": 2}]}});
        map.to_kernel(&mut request);
        assert_eq!(request["arguments"]["source"], json!({"path": "/tmp/ipykernel_1/123.py"}));
        let mut frames = json!({"body": {"stackFrames": [
            {"name": "f", "line": 2, "source": {"path": "/tmp/ipykernel_1/123.py", "name": "123.py"}},
            {"name": "g", "line": 9, "source": {"path": "/work/lib.py", "name": "lib.py"}}]}});
        map.to_ide(&mut frames);
        assert_eq!(frames["body"]["stackFrames"][0]["source"], json!({"path": "vscode-notebook-cell:/p/a.ipynb#c1"}));
        assert_eq!(frames["body"]["stackFrames"][1]["source"]["path"], "/work/lib.py", "other files are left alone");
    }

    /// A bridge over a stand-in kernel: what it is sent, and a way to answer.
    fn fake(
        cells: Vec<(String, String)>,
    ) -> (DuplexStream, mpsc::Receiver<jupyter_protocol::JupyterMessage>, mpsc::UnboundedSender<Value>) {
        let (control, sent) = mpsc::channel(16);
        let (answer, inbox) = mpsc::unbounded_channel();
        (dap_stream(KernelDebugger { control, inbox }, cells), sent, answer)
    }

    fn content(message: jupyter_protocol::JupyterMessage) -> Value {
        match message.content {
            jupyter_protocol::JupyterMessageContent::DebugRequest(request) => request.content,
            other => panic!("not a debug request: {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_kernel_without_debugpy_fails_initialize_with_a_reason() {
        let (stream, mut sent, answer) = fake(Vec::new());
        let (read, mut write) = tokio::io::split(stream);
        let mut read = BufReader::new(read);
        write_message(&mut write, &json!({"type": "request", "seq": 1, "command": "initialize", "arguments": {}}))
            .await
            .unwrap();
        assert_eq!(content(sent.recv().await.unwrap())["command"], "initialize");
        answer.send(Value::Null).unwrap();
        let reply = read_message(&mut read).await.unwrap().unwrap();
        assert_eq!(reply["request_seq"], 1);
        assert_eq!(reply["success"], false);
        assert_eq!(reply["message"], CANNOT_DEBUG);
    }

    #[tokio::test]
    async fn breakpoints_wait_for_the_cells_to_be_dumped() {
        let uri = "vscode-notebook-cell:/p/a.ipynb#c1";
        let (stream, mut sent, answer) = fake(vec![(uri.into(), "x = 1\n".into())]);
        let (read, mut write) = tokio::io::split(stream);
        let mut read = BufReader::new(read);
        write_message(&mut write, &json!({"type": "request", "seq": 1, "command": "initialize", "arguments": {}}))
            .await
            .unwrap();
        sent.recv().await.unwrap();
        answer.send(json!({"type": "response", "request_seq": 1, "command": "initialize", "success": true})).unwrap();
        assert_eq!(read_message(&mut read).await.unwrap().unwrap()["success"], true);
        let dump = content(sent.recv().await.unwrap());
        assert_eq!((dump["command"].as_str(), dump["arguments"]["code"].as_str()), (Some("dumpCell"), Some("x = 1\n")));
        // Sent before the dump is answered: held, then sent with the kernel's path.
        let set = json!({"type": "request", "seq": 2, "command": "setBreakpoints",
            "arguments": {"source": {"path": uri}, "breakpoints": [{"line": 1}]}});
        write_message(&mut write, &set).await.unwrap();
        tokio::task::yield_now().await;
        assert!(sent.try_recv().is_err());
        answer
            .send(json!({"type": "response", "request_seq": dump["seq"], "command": "dumpCell", "success": true,
            "body": {"sourcePath": "/tmp/k/1.py"}}))
            .unwrap();
        let set = content(sent.recv().await.unwrap());
        assert_eq!(set["arguments"]["source"]["path"], "/tmp/k/1.py");
        // Dropping the IDE's side disconnects the kernel's debugger.
        drop((read, write));
        let disconnect = content(sent.recv().await.unwrap());
        assert_eq!(
            (disconnect["command"].as_str(), disconnect["arguments"]["terminateDebuggee"].as_bool()),
            (Some("disconnect"), Some(false))
        );
    }

    #[tokio::test]
    async fn dap_frames_round_trip() {
        let (a, b) = tokio::io::duplex(1024);
        let (_, mut write) = tokio::io::split(a);
        let (read, _) = tokio::io::split(b);
        let mut read = BufReader::new(read);
        write_message(&mut write, &json!({"seq": 1, "type": "request", "command": "initialize"})).await.unwrap();
        write_message(&mut write, &json!({"seq": 2, "text": "ünïcode"})).await.unwrap();
        assert_eq!(read_message(&mut read).await.unwrap().unwrap()["command"], "initialize");
        assert_eq!(read_message(&mut read).await.unwrap().unwrap()["text"], "ünïcode");
    }
}
