# Debugger Kotlin qua kotlin-lsp DAP (K1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Debug Kotlin (Run/Debug từ gutter, test, Gradle/Maven debug, attach) chạy bằng DAP tích hợp của JetBrains kotlin-lsp khi kotlin-lsp là LSP Kotlin của dự án và import xong; nếu không thì dùng fwcd `kotlin-debug-adapter` như hôm nay, kèm một thông báo đã dịch nói lý do.

**Architecture:** Frontend không đổi đường dựng `LaunchConfig` (adapter `kotlin-debug-adapter` nghĩa là "debugger Kotlin"). `ide-host::debug_start` hỏi `ide-lsp` (`LspManager::kotlin_debug_server`: chờ `intellij/workspaceImportState` báo `FINISHED`, rồi `workspace/executeCommand start_debug_server`) và đổi adapter sang `kotlin-lsp` với `debugServer: <port>`; mọi lỗi thành lý do dự phòng. `ide-dap` nối DAP qua TCP bằng đường `debugServer` có sẵn, vẫn tự chạy JVM (`start_kotlin_debuggee`), gửi `attach` qua `JdwpLink` của M2 với `hold_resumes = false`, và chuẩn hoá các tật của kotlin-lsp (adapterID `intellij_jvm`, `invalidated`, `file://`, lý do `breakpoint` khi step, thread id cũ không được trả lời).

**Tech Stack:** Rust 2024 (tokio, serde_json, `percent-encoding`), LSP/DAP JSON, React + zustand, vitest, smoke qua `openidea-server`.

**Spec:** `docs/superpowers/specs/2026-11-07-jvm-debug-link-design.md` (§6, §9, §12 "Hướng", §13, §15 dòng K1, §16 R2). Kết quả K0: `docs/superpowers/specs/2026-11-07-k0-kotlin-lsp-dap-spike.md`. Plan M2 (K1 dùng các khối Interfaces của nó, M2 phải xong trước): `docs/superpowers/plans/2026-11-07-debugger-jvm-instances-m2.md`. Mục "Sửa spec đề xuất" ở cuối plan thay vài dòng của spec theo spike K1.

## Global Constraints

- kotlin-lsp DAP **chỉ** dùng qua `attach` vào JVM do app chạy (`start_kotlin_debuggee`) hoặc JVM build tool chạy với agent JDWP; không dùng `launch` của kotlin-lsp, không gọi `intellij.java.resolveLaunch`.
- Tên adapter trong app: `kotlin-lsp` (`ide_dap::kotlin_lsp::ADAPTER`); `adapterID` gửi trong DAP `initialize`: `intellij_jvm` (`ide_dap::kotlin_lsp::DAP_ADAPTER_ID`). fwcd giữ `kotlin-debug-adapter`.
- `JdwpLink` (M2): `hold_resumes = false` cho `kotlin-lsp`, `true` cho `kotlin-debug-adapter`. `SourceMirror` chỉ cho fwcd: kotlin-lsp nhận đường dẫn thật của file.
- Chờ import tối đa `KOTLIN_IMPORT_WAIT = 120 s` (quyết định 1); hết giờ → fwcd với lý do "still importing".
- `start_debug_server` gọi một lần mỗi phiên, đối số `[<URI thư mục gốc của server kotlin-lsp>]`; mỗi lần trả một cổng mới.
- Frontend vẫn phát `adapter: "kotlin-debug-adapter"` cho mọi phiên Kotlin; chỉ backend chọn. Không import feature khác; chuỗi hiển thị vào cả `src/platform/locales/text/en.json` và `zh.json` (kể cả chuỗi backend gửi trong `IdeEvent::Notify`, vì `notificationStore` dịch title/body bằng `txTemplate`).
- Mọi bất biến của M2 vẫn áp dụng (dải id `0x7000_0000..`, không dispose dư, không invoke).
- IPC: `IdeResult<T>`, camelCase; đổi kiểu IPC thì chạy `pnpm gen:bindings` và commit `src/bindings.ts`.
- Rust: `cargo +1.96 …` như M2. Commit `feat(debugger): …`, stage từng đường dẫn, không trailer `Co-Authored-By`, không stage `openspec/` hay `*.sh`.

## Grounding

Rủi ro làm sập cách làm: **kotlin-lsp, được điều khiển đúng như `ide-dap` điều khiển một phiên Kotlin hôm nay (tham số `initialize` của app, JVM chạy như `start_kotlin_debuggee`, `attach` qua relay không giữ gói, breakpoint bằng đường dẫn thật, `configurationDone` không chờ), có dừng ở dòng "Set a breakpoint here" của `fixtures/kotlin-gradle` và step được không? Và có tín hiệu nào cho "import xong"?** Probe `scratchpad/k1-spike/scripts/k1.py` (ngoài repo; `python3 -I`, kotlin-lsp 263.7084.0 của K0, JDK 21.0.4 cho debuggee, bản sao fixture có `build/install`). Chạy:

```
SYS=sys-cold1 EARLY=1 INV=0 python3 -I scripts/k1.py      # run1: adapterID = "kotlin-lsp" như app hôm nay
SYS=sys-cold2 EARLY=1 INV=0 python3 -I scripts/k1.py      # run2: adapterID "intellij_jvm", import lạnh
SYS=sys-cold2 INV=0 SESSIONS=2 STOPMODE=terminate …       # run3: import ấm, thread id cũ, hai phiên, terminate
ROOTPROBE=1 SYS=sys-cold2 SESSIONS=1 …                    # run4: đối số của start_debug_server
SYS=sys-cold2 SESSIONS=2 STOPMODE=disconnect …            # run5: disconnect khi đang dừng
```

**G1. Phiên đúng kiểu app có trúng breakpoint và step không?** Lần một: **không**, vì app gửi `adapterID = s.adapter` (bác lần một, đổi thiết kế: ánh xạ adapterID, Task 2):

```
run1 [12.9s]   FAILED initialize No debugger adapter found for given adapter id: kotlin-lsp null
run1 [12.9s]   FAILED setBreakpoints lateinit property breakpointsManager has not been initialized null
```

Với `adapterID: "intellij_jvm"` (mọi tham số khác giữ như `lib.rs::configure`, `attach` mang cả `name/request/cwd/env/projectRoot/mainClass/classPaths/…` và **không** có `type`): **có**.

```
run2 [ 7.8s] setBreakpoints: {"breakpoints": [{"id": 2, "verified": true, "source": {"name": "App.kt", "path": "/…/kg/src/main/kotlin/com/example/library/App.kt"}, "line": 13}]}
run2 [ 8.0s] attach response success=True after 0.3s; relay first JDWP cmd at 7.92
run2 [ 8.3s] STOP1 raw: {"seq": 7, "event": "stopped", "body": {"reason": "breakpoint", "threadId": 6, "allThreadsStopped": true}, "type": "event"}
run2 [ 8.4s] top: {"id": 7, "name": "at com.example.library.AppKt.main(App.kt:13)", "source": {"name": "App.kt", "path": "file:///…/App.kt"}, "line": 13, …
run2 [12.2s] evaluate library: {"result": "com.example.library.Library@4eee6366", "type": "Library@647", "variablesReference": 16}
run2 [12.2s] after step top: {"id": 19, "name": "at com.example.library.AppKt.main(App.kt:14)", …
```

**G2. Import xong lúc nào, đợi bằng tín hiệu gì?** Import bắt đầu ngay ở `initialized`, **không cần `didOpen`**; `start_debug_server` trả lời ngay cả khi đang import (nên tự nó không chờ). Tín hiệu đúng là notification riêng `intellij/workspaceImportState`; "không còn `$/progress`" **không** dùng được vì "Indexing" lặp lại mỗi ~10 s (23 lần trong run3):

```
run2 [ 1.7s] initialized sent
run2 [ 1.7s] progress begin "u76ste55d9b4vh8pbvni" 'Importing' msg=None
run2 [ 1.7s] EARLY start_debug_server -> 63479 None in 12 ms; active progress now: ['Importing']
run2 [ 7.6s] progress end   "u76ste55d9b4vh8pbvni" 'Importing'
run2 [ 7.6s] lsp notification intellij/workspaceImportState {"phase": "FINISHED", "folders": [{"folderUri": "file:///…/k1-spike/work/kg/", "tool": "gradle", "status": "SUCCESS"}]}
run3 [ 1.7s] progress begin … 'Importing'   →   [ 3.0s] progress end … 'Importing' + workspaceImportState FINISHED (ấm: 1,3 s)
```

Lạnh 5,9 s, ấm 1,3 s trên fixture (Gradle daemon của kotlin-lsp đã chạy). Attach trước khi import xong thì breakpoint "verified" mà không trúng (đã đo ở K0). Phase khác `FINISHED` và import lại khi sửa build file: chưa thấy **[SL]**, nên thiết kế coi mọi phase khác `FINISHED`, hoặc progress "Importing" còn mở, là "đang import".

**G3. App báo `supportsInvalidatedEvent: false`; giá trị biến có cuối cùng không?** **Không** (bác lần hai, đổi thiết kế: xử lý `invalidated`, Task 3 và 5). kotlin-lsp vẫn gửi `invalidated` và trả giá trị tạm:

```
run3 [ 5.5s]   event invalidated {"areas": ["variables"]}
run3 [ 5.5s] variables #1: [('library', 'Collecting data…', 14), ('unused', '"intentional warning: unused variable"', 15)]
run3 [ 5.7s]   event invalidated {"areas": ["variables"]}
run3 [ 7.5s] variables #2 (same ref): [('library', 'com.example.library.Library@1289a75'), ('unused', …)]
```

**G4. Step và thread id.** Stop sau `next` giống hệt stop ở breakpoint (không `hitBreakpointIds`, không `description`); id thread đổi mỗi lần dừng; request mang id của lần dừng trước **không bao giờ được trả lời**, nhưng không chặn request khác:

```
run3 [11.1s] STEP stop raw: {"seq": 20, "event": "stopped", "body": {"reason": "breakpoint", "threadId": 18, "allThreadsStopped": true}, "type": "event"}
run3 [11.1s] … old tid 6 new tid 18
run3 [11.1s] threads after a stale-id stackTrace: success=True in 0.00s (stale reply pending)
run3 [11.1s] valid stackTrace after a stale-id one: success=True
run3 [21.2s] stale-id stackTrace: no reply within 10 s more
```

**G5. Vòng đời.** `start_debug_server` nhận mọi đối số (cả không đối số) và mỗi lần trả cổng mới; hai phiên nối tiếp trên một kotlin-lsp đều chạy. `terminate` trên phiên `attach` (cách app dừng một phiên Kotlin kiểu "launch"): kotlin-lsp gửi `terminated`, thoát JVM, đóng socket DAP. `disconnect {terminateDebuggee: false}` khi đang dừng (cách app dừng phiên attach Gradle): JVM chạy tiếp tới hết.

```
run4 start_debug_server root/: result=64520 · subfolder: 64521 · unrelated: 64522 · no args: 64523 · path not uri: 64524
run3 [21.8s] start_debug_server #2 -> 63857 (first was 63739) … SESSION 2 STOP1 reason=breakpoint …
run3 [34.6s]   event terminated {}  ·  terminate: True None  ·  no terminated event: dap closed  ·  JVM exit code after terminate: 255
run5 [30.3s] disconnect while paused: success=True in 0.00s  ·  [jvm] Lent 'Kotlin in Action' … ·  JVM exit code after disconnect: 0
```

Hai lần bác đều đổi chi tiết thiết kế (ánh xạ adapterID; xử lý `invalidated`), không đổi cách làm: câu hỏi chính (attach qua relay không giữ gói, trúng, step, evaluate) trả lời "có". Chưa kiểm ở đây: JVM do Gradle fork (cùng agent JDWP như JVM probe; smoke ở Task 6 phủ), Windows. Đã dừng Gradle daemon (JBR của kotlin-lsp) mà import khởi động; probe để lại trong scratchpad, không vào repo.

## Review Focus

1. **Bấm Debug ngay khi vừa mở dự án (kotlin-lsp chưa chạy hoặc đang import)**: phiên phải chờ import rồi trúng breakpoint, không bao giờ "verified nhưng không dừng". Test ở Task 1 (`waits_for_the_import_before_starting_the_debug_server`, `an_older_finished_import_does_not_count_after_a_restart`).
2. **Request mang thread id của lần dừng trước** (bấm một thread trong danh sách đúng lúc lần dừng mới tới): trả lỗi ngay, không treo 30 s (`REQUEST_TIMEOUT`). Test ở Task 3 (`a_thread_from_an_earlier_stop_is_refused`).
3. **Step Over trên kotlin-lsp**: UI ghi "step", còn lần dừng ở breakpoint sau `continue` vẫn là "breakpoint". Test ở Task 3 (`a_step_stop_is_reported_as_a_step`, `a_breakpoint_after_continue_stays_a_breakpoint`).
4. **Biến hiện "Collecting data…" mãi** khi `invalidated` tới trước hoặc sau lần tải của view: view phải tải lại. Test ở Task 5 (`invalidated reloads the selected frame's variables`).
5. **kotlin-lsp khởi động lại hoặc chết giữa phiên** (đổi settings, crash): phiên kết thúc, JVM bị kill, link đóng, không treo. Test ở Task 2 (`losing_the_kotlin_lsp_connection_ends_the_session`).

---

### Task 0: Nhánh và điều kiện trước

**Files:** không.

- [ ] **Step 1: Không tạo issue hay PR**: mọi mốc ở `feat/debugger-jvm-memory`, một PR ở cuối.
- [ ] **Step 2: Kiểm tra M2 đã commit** trong worktree `../openidea-jvm-memory`: `git log --oneline` có commit "debug Kotlin through the JDWP link" và `crates/ide-jdwp` tồn tại. Chưa có thì dừng.
- [ ] **Step 3: Commit plan**: `git add docs/superpowers/plans/2026-11-07-debugger-kotlin-lsp-k1.md && git commit -m "feat(debugger): plan kotlin-lsp as the Kotlin debugger (K1)"`.

---

### Task 1: `ide-lsp`: theo dõi import của kotlin-lsp và mở debug server

**Files:**

- Create: `crates/ide-lsp/src/kotlin_lsp.rs`
- Modify: `crates/ide-lsp/src/lib.rs` (`mod kotlin_lsp; pub use kotlin_lsp::{KotlinDebugServer, KotlinDebugUnavailable};`), `crates/ide-lsp/src/server.rs` (struct `Server`, `Server::new`, `begin_start`), `crates/ide-lsp/src/handler.rs` (`on_notification`)
- Test: `crates/ide-lsp/tests/mock_server.rs`

**Interfaces:**

- Consumes: `LspManager::servers_for`, `ensure_started`, `Server::wait_ready`, `Server::progress`, `crate::uri::{path_to_uri_string, uri_to_path}`, `COMMAND_TIMEOUT`.
- Produces:

```rust
pub const KOTLIN_LSP: &str = "kotlin-lsp";                     // tên server trong languages/kotlin.toml
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ImportState { pub finished: bool, pub failed: Vec<PathBuf> }   // failed: folderUri có status != "SUCCESS"
// Server: pub(crate) import_state: tokio::sync::watch::Sender<Option<ImportState>>; về None trong begin_start
pub(crate) fn record_import_state(server: &Server, params: &Value)  // phase "FINISHED" → finished true; phase khác → false
#[derive(Clone, Debug, PartialEq)]
pub struct KotlinDebugServer { pub port: u16, pub root: PathBuf }
#[derive(Clone, Debug, PartialEq)]
pub enum KotlinDebugUnavailable { NotConfigured, NotInstalled, NotStarted(String), StillImporting, ImportFailed, Failed(String) }
impl LspManager {
    pub async fn kotlin_debug_server(&self, path: &Path, import_wait: Duration, cancel: &CancellationToken)
        -> Result<KotlinDebugServer, KotlinDebugUnavailable>;
}
```

Quy tắc của `kotlin_debug_server`:

1. Server tên `KOTLIN_LSP` trong `servers_for(kotlin, path)`; không có (tắt trong settings, chỉ có `kotlin-language-server`) → `NotConfigured`. Status `Missing` → `NotInstalled`.
2. `ensure_started`, `wait_ready(240 s)`; `None` → `NotStarted(status_message hoặc "{status:?}")`.
3. Chờ trên `import_state.subscribe()` tới khi `Some(ImportState { finished: true, .. })` **và** không còn `$/progress` nào có title chứa `"Importing"`; hết `import_wait` → `StillImporting`. Có thư mục trong `failed` là tiền tố của `path` → `ImportFailed`.
4. `workspace/executeCommand {"command": "start_debug_server", "arguments": [path_to_uri_string(&server.root)]}`; lỗi → `Failed(message)`; kết quả không phải số trong `1..=65535` → `Failed("unexpected debug server port: …")`.

Handler: nhánh `"intellij/workspaceImportState" if self.server.name == crate::kotlin_lsp::KOTLIN_LSP => crate::kotlin_lsp::record_import_state(&self.server, &params)`.

- [ ] **Step 1: Viết test thất bại** (`mock_server.rs`, `harness_for("kotlin", "kt", &[("kotlin-lsp", caps)], &[])`, mock trả `workspace/executeCommand` = `4711`):

```rust
#[tokio::test(flavor = "multi_thread")] async fn waits_for_the_import_before_starting_the_debug_server()
// mock gửi $/progress begin "Importing"; gọi kotlin_debug_server (import_wait 10 s) trong task; sau 300 ms mock chưa nhận
// executeCommand nào; mock gửi progress end + intellij/workspaceImportState {phase FINISHED, folders [{folderUri root, status SUCCESS}]}
// → Ok(KotlinDebugServer { port: 4711, root }); requested("workspace/executeCommand")[0] == {"command":"start_debug_server","arguments":[uri_of(root)]}
#[tokio::test(flavor = "multi_thread")] async fn still_importing_after_the_wait_is_reported()      // không có notification, import_wait 200 ms → Err(StillImporting), không executeCommand
#[tokio::test(flavor = "multi_thread")] async fn a_failed_import_of_the_module_is_reported()       // folders [{folderUri root, status "FAILED"}] → Err(ImportFailed)
#[tokio::test(flavor = "multi_thread")] async fn an_older_finished_import_does_not_count_after_a_restart() // FINISHED, restart server → import_state None → chờ lại
#[tokio::test(flavor = "multi_thread")] async fn without_kotlin_lsp_the_reason_is_not_configured() // harness chỉ có "kotlin-language-server" → Err(NotConfigured); "kotlin-lsp" missing → Err(NotInstalled)
#[tokio::test(flavor = "multi_thread")] async fn a_debug_server_error_is_reported()               // errors["workspace/executeCommand"] = (-32603, "boom") → Err(Failed(m)) với m chứa "boom"
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo +1.96 test -p ide-lsp --test mock_server kotlin` → FAIL (chưa có `kotlin_debug_server`).
- [ ] **Step 3: Cài đặt** như Interfaces và Quy tắc. Comment một dòng ở `record_import_state`: không dùng "hết `$/progress`" vì kotlin-lsp phát "Indexing" định kỳ.
- [ ] **Step 4: Chạy lại** lệnh trên và `cargo +1.96 test -p ide-lsp` → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-lsp/src/kotlin_lsp.rs crates/ide-lsp/src/lib.rs crates/ide-lsp/src/server.rs crates/ide-lsp/src/handler.rs crates/ide-lsp/tests/mock_server.rs && git commit -m "feat(debugger): start kotlin-lsp's debug server once its import has finished"`

---

### Task 2: `ide-dap`: adapter `kotlin-lsp` qua `debugServer`, JVM do app chạy, `JdwpLink` không giữ Resume

**Files:**

- Create: `crates/ide-dap/src/kotlin_lsp.rs` (hằng; Task 3 thêm phần tật)
- Modify: `crates/ide-dap/src/lib.rs` (`pub mod kotlin_lsp;`, `configure`, `capabilities`), `crates/ide-dap/src/kotlin.rs` (`is_kotlin`), `crates/ide-dap/src/adapter.rs` (`builtin`), `crates/ide-dap/src/jvm_memory/mod.rs` (`JVM_MEMORY_ADAPTERS`), `crates/ide-dap/src/session.rs` (chỗ M2 dựng link nếu nằm ở đây)
- Test: `crates/ide-dap/src/tests.rs`

**Interfaces:**

- Consumes: M2 Task 6 (`JdwpLink::start(host, port, LinkOptions { hold_resumes })`, `Session::jdwp_link`, `Session::jvm_inspector`, `Session::attach_target`), `session::start_kotlin_debuggee`, `take_debug_server` (đã có).
- Produces:

```rust
// kotlin_lsp.rs
pub const ADAPTER: &str = "kotlin-lsp";
pub const DAP_ADAPTER_ID: &str = "intellij_jvm";
// kotlin.rs
pub fn is_kotlin(adapter: &str) -> bool   // ADAPTER (fwcd) hoặc kotlin_lsp::ADAPTER
// adapter.rs builtin: "kotlin-lsp" => cfg("kotlin-lsp", &[], "tcp", "Install JetBrains Kotlin LSP in Settings › Languages & Frameworks › Language Servers")
// JVM_MEMORY_ADAPTERS = ["java-debug", kotlin::ADAPTER, kotlin_lsp::ADAPTER]
```

Thay đổi trong `configure` (mọi nhánh đang so `s.adapter == kotlin::ADAPTER`):

| Chỗ                                                  | fwcd (`kotlin-debug-adapter`) | `kotlin-lsp`                                        |
| ---------------------------------------------------- | ----------------------------- | --------------------------------------------------- |
| `SourceMirror`, `projectRoot` viết lại               | giữ                           | không                                               |
| `initialize.adapterID`                               | `s.adapter`                   | `DAP_ADAPTER_ID`                                    |
| `initialize.supportsInvalidatedEvent`                | `false`                       | `true` (nó vẫn gửi khi `false`, G3)                 |
| `start_kotlin_debuggee` + gửi `attach` thay `launch` | giữ                           | giống fwcd                                          |
| `JdwpLink::start` (thay chỗ M2 dựng)                 | `hold_resumes: true`          | `hold_resumes: false`                               |
| `setBreakpoints` lỗi làm hỏng khởi động              | giữ                           | như adapter khác (`tracing::debug!`)                |
| `configurationDone`                                  | gửi không chờ                 | `request_timeout(REQUEST_TIMEOUT)` như adapter khác |
| `link.release()` sau response `attach`               | giữ                           | gọi cũng được (no-op khi không giữ)                 |

- [ ] **Step 1: Viết test thất bại** (`tests.rs`; `config()` với `adapter: "kotlin-lsp"`, `request: "attach"`, `extra_json: {"debugServer": 4711, "hostName": "127.0.0.1", "port": 5005, "projectRoot": <tmp>}`; FakeLauncher bỏ qua cổng):

```rust
#[tokio::test] async fn kotlin_lsp_initializes_as_intellij_jvm()
// h.request("initialize")["arguments"]["adapterID"] == "intellij_jvm"; ["supportsInvalidatedEvent"] == true
// fwcd cùng test: "kotlin-debug-adapter", false
#[tokio::test] async fn kotlin_lsp_gets_real_paths_and_its_link_holds_nothing()
// setBreakpoints source.path == đường dẫn thật (không trong temp mirror); attach.arguments.projectRoot không đổi;
// attach.arguments.port != 5005 (cổng link); session.jdwp_link Some; session.attach_target == ("127.0.0.1", 5005)
#[tokio::test] async fn kotlin_lsp_waits_for_the_configuration_done_reply()
// Script { ignore_configuration_done: true } → start lỗi Timeout sau REQUEST_TIMEOUT (dùng tokio::time::pause); fwcd thì không
#[tokio::test] async fn kotlin_lsp_sessions_have_the_memory_tab()   // capabilities(id).jvm_memory == true
#[tokio::test] async fn losing_the_kotlin_lsp_connection_ends_the_session()
// fake adapter đóng stream sau stop đầu → DebugEvent::Terminated; manager.sessions(None) rỗng; jdwp_link đã take
```

Test link mới của M2 (`JdwpLink` với `hold_resumes: false` chuyển `1/9` ngay) đã có ở M2 Task 3; ở đây chỉ kiểm cờ được truyền: test đọc `link.state()` sau handshake giả là `Ready`, không phải `Held`.

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo +1.96 test -p ide-dap kotlin` → FAIL.
- [ ] **Step 3: Cài đặt** như bảng. Mọi điều kiện "phiên Kotlin" (relay/link, debuggee, đổi `launch` → `attach`) dùng `kotlin::is_kotlin`; điều kiện riêng fwcd giữ `== kotlin::ADAPTER`.
- [ ] **Step 4: Chạy lại**: `cargo +1.96 test -p ide-dap` → PASS (test Kotlin cũ của fwcd xanh không sửa assert).
- [ ] **Step 5: Commit**: `git add crates/ide-dap && git commit -m "feat(debugger): attach kotlin-lsp's debugger to the JVM the IDE starts"`

---

### Task 3: `ide-dap`: tật của client kotlin-lsp

**Files:**

- Modify: `crates/ide-dap/src/kotlin_lsp.rs`, `crates/ide-dap/src/session.rs` (`Session` thêm field, `Session::client_path`, `on_event` nhánh `stopped` và nhánh mới `invalidated`), `crates/ide-dap/src/lib.rs` (`threads`, `stack_trace`, `resume`, `step`, `force_step_over`, `step_in_target`, `run_to`), `crates/ide-dap/Cargo.toml` (`percent-encoding = "2"`), `crates/ide-core/src/event.rs` (`DebugEvent`), `src/bindings.ts` (sinh lại)
- Test: `crates/ide-dap/src/kotlin_lsp.rs` (unit), `crates/ide-dap/src/tests.rs`

**Interfaces:**

- Produces:

```rust
// ide-core event.rs
DebugEvent::Invalidated { areas: Vec<String> }        // TS: { kind: "invalidated"; areas: string[] }
// kotlin_lsp.rs
pub(crate) fn source_path(path: &str) -> Option<PathBuf>   // "file:" URI → path (percent-decode, bỏ authority "localhost"); khác → None
pub(crate) fn frame_name(name: &str) -> &str               // bỏ tiền tố "at "
#[derive(Default)]
pub(crate) struct Quirks { /* step_pending: AtomicBool, threads: Mutex<(u64, HashSet<i64>)> */ }
impl Quirks {
    pub fn step_sent(&self);                                // trước next/stepIn/stepOut/force step
    pub fn resume_sent(&self);                              // trước continue / run_to
    pub fn stop_reason(&self, reason: String) -> String;    // lấy và xoá step_pending: pending && reason == "breakpoint" → "step"
    pub fn saw_threads(&self, stop: u64, ids: impl IntoIterator<Item = i64>);
    pub fn check_thread(&self, stop: u64, suspended: bool, id: i64) -> ide_core::IdeResult<()>;
}
// Session: pub(crate) quirks: kotlin_lsp::Quirks   (chỉ dùng khi adapter == kotlin_lsp::ADAPTER)
```

Quy tắc (chỉ khi `s.adapter == kotlin_lsp::ADAPTER`):

- `client_path`: thử `source_path` trước; frame có `path` dạng URI thành đường dẫn thật. `stack_trace` thêm `frame.name = frame_name(...)`.
- `on_event "stopped"`: `reason = quirks.stop_reason(reason)`; `quirks.saw_threads(stop, [threadId])` với `stop = s.suspended.ticket()` sau `stopped()`.
- `on_event "invalidated"`: emit `DebugEvent::Invalidated { areas }` (mọi adapter, rỗng nếu thiếu). Adapter khác không gửi vì không khai báo hỗ trợ.
- `threads()` gọi `saw_threads(ticket, ids)`. `check_thread`: khi `suspended` và tập của đúng `stop` hiện tại không rỗng mà không chứa `id` → `IdeError::invalid("thread {id} belongs to an earlier stop")`; ngoài ra `Ok`. Gọi trước khi gửi request ở các method liệt kê trong Files.
- Comment ngắn ở `Quirks`: request mang thread id cũ không bao giờ được kotlin-lsp trả lời (K1 G4); step báo `reason: "breakpoint"`. Comment ở `kotlin_lsp.rs` đầu file ghi hai giới hạn đã biết, không có guard: evaluate gọi hàm có breakpoint ngay sau step qua điểm treo làm mất các lần dừng sau ở breakpoint đó (K0); khi step, breakpoint của coroutine khác bị bỏ qua (K0).

- [ ] **Step 1: Viết test thất bại**

```rust
// kotlin_lsp.rs
#[test] fn file_uris_become_paths()        // "file:///p/a%20b/App.kt" → "/p/a b/App.kt"; "file://localhost/p/x.kt" → "/p/x.kt"; "/p/x.kt" → None
#[test] fn frame_names_lose_the_at_prefix() // "at com.x.AppKt.main(App.kt:13)" → "com.x.AppKt.main(App.kt:13)"; "main" → "main"
#[test] fn only_a_pending_step_turns_a_breakpoint_into_a_step() // step_sent → "breakpoint" → "step"; lần sau "breakpoint" → "breakpoint"; step_sent, resume_sent → "breakpoint"
#[test] fn threads_are_checked_against_the_current_stop() // saw_threads(3, [18]) → check(3, true, 18) Ok, check(3, true, 6) Err, check(4, true, 6) Ok (chưa biết), check(3, false, 6) Ok
// tests.rs (Script mới: step_reason: Option<&'static str>, invalidated_after_stop: bool, source_path dạng "file:///…")
#[tokio::test] async fn a_step_stop_is_reported_as_a_step()          // kotlin-lsp, step_reason "breakpoint" → DebugEvent::Stopped { reason: "step" }
#[tokio::test] async fn a_breakpoint_after_continue_stays_a_breakpoint()
#[tokio::test] async fn a_thread_from_an_earlier_stop_is_refused()  // sau stop + threads [1]: stack_trace(id, 99) → Err trong < 100 ms; log không có stackTrace threadId 99
#[tokio::test] async fn kotlin_lsp_frames_get_real_paths()          // source_path "file:///p/App.kt" → frames[0].path == "/p/App.kt"; java-debug với cùng script giữ nguyên
#[tokio::test] async fn invalidated_events_reach_the_client()       // invalidated_after_stop → DebugEvent::Invalidated { areas: ["variables"] }
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo +1.96 test -p ide-dap kotlin_lsp` → FAIL.
- [ ] **Step 3: Cài đặt** như Interfaces và Quy tắc.
- [ ] **Step 4: Chạy lại và sinh bindings**: `cargo +1.96 test -p ide-dap` và `cargo +1.96 test -p ide-core` → PASS; `pnpm gen:bindings` → `DebugEvent` trong `src/bindings.ts` có `{ kind: "invalidated"; areas: string[] }`; `pnpm typecheck` → 0 lỗi (switch `handleDebugEvent` không có `default`, Task 5 thêm nhánh; nếu typecheck đòi ngay thì thêm `case "invalidated": break;` tạm ở đây).
- [ ] **Step 5: Commit**: `git add crates/ide-dap crates/ide-core/src/event.rs src/bindings.ts src/features/debugger/state.ts && git commit -m "feat(debugger): normalize kotlin-lsp's paths, step stops, thread ids and invalidations"`

---

### Task 4: `ide-host`: chọn adapter Kotlin, dự phòng có lý do, chờ import có tiến trình

**Files:**

- Create: `crates/ide-host/src/ops/debug/kotlin.rs`
- Modify: `crates/ide-host/src/ops/debug.rs` (`mod kotlin;`, `debug_start`: gọi trước khối JDK của fwcd và đưa khối đó vào nhánh fwcd), `crates/ide-host/src/project.rs` (`Project` thêm `pub(crate) kotlin_debug_notices: Mutex<HashSet<&'static str>>`), `src/platform/locales/text/en.json`, `src/platform/locales/text/zh.json`

**Interfaces:**

- Consumes: Task 1 (`LspManager::kotlin_debug_server`, `KotlinDebugUnavailable`, `KotlinDebugServer`), Task 2 (`ide_dap::kotlin_lsp::ADAPTER`).
- Produces:

```rust
pub(super) const KOTLIN_IMPORT_WAIT: Duration = Duration::from_secs(120);
pub(super) fn use_kotlin_lsp(config: LaunchConfig, port: u16) -> IdeResult<LaunchConfig>; // adapter = kotlin_lsp::ADAPTER, extra_json.debugServer = port, phần còn lại giữ
pub(super) fn fallback_notice(reason: &KotlinDebugUnavailable) -> (&'static str, String); // (khoá lý do, body tiếng Anh)
pub(super) async fn choose_kotlin_debugger(host: &Host, window: &str, config: LaunchConfig) -> IdeResult<LaunchConfig>;
```

Quy tắc `choose_kotlin_debugger` (chỉ khi `config.adapter == ide_dap::kotlin::ADAPTER`):

1. Đường dẫn: `extra_json.projectRoot`, không có thì `config.cwd`. Không có project cho `window` → fwcd, lý do `NotConfigured`.
2. Gọi `project.lsp.kotlin_debug_server(path, KOTLIN_IMPORT_WAIT, &CancellationToken::new())`. Nếu sau 500 ms chưa xong: phát `IdeEvent::Task { title: "Waiting for kotlin-lsp to import the project", fraction: None, cancellable: false, done: false }` trên sink của window, và `done: true` khi xong (cả lỗi).
3. `Ok(server)` → `use_kotlin_lsp(config, server.port)`. `Err(reason)` → `tracing::info!` mỗi lần; `IdeEvent::Notify { level: Info, title: "Debugging Kotlin with kotlin-debug-adapter", body }` chỉ lần đầu mỗi khoá lý do trong `project.kotlin_debug_notices`; trả `config` không đổi (khối JDK ≥ 11 của fwcd chạy sau đó như hôm nay).

Chuỗi (en → zh), thêm cả hai file; body đúng như `fallback_notice` trả:

| Khoá             | en                                                                                                       | zh                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| title            | Debugging Kotlin with kotlin-debug-adapter                                                               | 使用 kotlin-debug-adapter 调试 Kotlin                         |
| task             | Waiting for kotlin-lsp to import the project                                                             | 正在等待 kotlin-lsp 导入项目                                  |
| `notConfigured`  | kotlin-lsp is not the Kotlin language server of this project.                                            | kotlin-lsp 不是此项目的 Kotlin 语言服务器。                   |
| `notInstalled`   | kotlin-lsp is not installed.                                                                             | 未安装 kotlin-lsp。                                           |
| `notStarted`     | kotlin-lsp did not start: {detail}                                                                       | kotlin-lsp 未能启动：{detail}                                 |
| `stillImporting` | kotlin-lsp is still importing the project. Debug again once the import has finished to use its debugger. | kotlin-lsp 仍在导入项目。导入完成后再次调试即可使用其调试器。 |
| `importFailed`   | kotlin-lsp could not import the project.                                                                 | kotlin-lsp 无法导入项目。                                     |
| `failed`         | kotlin-lsp could not start its debugger: {detail}                                                        | kotlin-lsp 无法启动其调试器：{detail}                         |

- [ ] **Step 1: Viết test thất bại** (`ops/debug/kotlin.rs`, helper `launch(adapter, request, extra)` của `ops/debug.rs` tests):

```rust
#[test] fn kotlin_lsp_takes_the_debug_server_port() {
    let c = use_kotlin_lsp(launch(ide_dap::kotlin::ADAPTER, "launch", serde_json::json!({"mainClass": "a.AppKt", "projectRoot": "/p"})), 4711).unwrap();
    assert_eq!(c.adapter, ide_dap::kotlin_lsp::ADAPTER);
    let extra: serde_json::Value = serde_json::from_str(c.extra_json.as_deref().unwrap()).unwrap();
    assert_eq!(extra["debugServer"], 4711);
    assert_eq!(extra["mainClass"], "a.AppKt");
    assert!(extra.get("__adapterJavaHome").is_none());
}
#[test] fn every_fallback_reason_has_a_catalogued_text() // mọi biến thể → body; body (thay {detail}) có trong en.json và zh.json (đọc file qua include_str!)
#[test] fn fallback_reasons_have_distinct_keys()
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo +1.96 test -p ide-host debug::kotlin` → FAIL.
- [ ] **Step 3: Cài đặt** như Interfaces và Quy tắc; trong `debug_start`, `config = kotlin::choose_kotlin_debugger(host, window, config).await?` đặt ngay trước khối `if config.adapter == ide_dap::kotlin::ADAPTER` hiện có (khối đó chỉ còn chạy cho fwcd vì adapter đã đổi). Thêm chuỗi vào hai file catalog.
- [ ] **Step 4: Chạy lại**: `cargo +1.96 test -p ide-host debug` và `pnpm vitest run src/platform/locales` → PASS (catalog test coi chuỗi có trong Rust là "đã dùng").
- [ ] **Step 5: Commit**: `git add crates/ide-host/src/ops/debug.rs crates/ide-host/src/ops/debug/kotlin.rs crates/ide-host/src/project.rs src/platform/locales/text/en.json src/platform/locales/text/zh.json && git commit -m "feat(debugger): debug Kotlin with kotlin-lsp and say why when falling back"`

---

### Task 5: Frontend: tải lại biến khi `invalidated`, nhãn adapter

**Files:**

- Modify: `src/features/debugger/state.ts` (store `useDebug` thêm `variablesEpoch: number`; `handleDebugEvent` nhánh `stopped` và nhánh mới `invalidated`), `src/features/debugger/ui/DebugToolWindow.tsx` (effect scopes/locals ~dòng 427, `generation` ~dòng 584), `src/features/run/ConfigForm.tsx` (`ADAPTERS`)
- Test: `src/features/debugger/__tests__/executionState.test.ts`, `src/features/debugger/__tests__/toolWindow.test.tsx`

**Interfaces:**

- Consumes: bindings Task 3 (`DebugEvent` `invalidated`).
- Produces: `useDebug.getState().variablesEpoch` tăng ở mỗi `stopped` và mỗi `invalidated` của phiên đang dừng có `areas` rỗng hoặc chứa `"variables"`/`"all"`; khi đó `handleDebugEvent` cũng gọi `loadLocals(id, s.selectedFrame)` nếu có frame. `DebugToolWindow`: `generation={variablesEpoch * 100000 + (frame ?? 0)}` và effect scopes/locals phụ thuộc `variablesEpoch`. Nhãn `ADAPTERS`: `{ id: "kotlin-debug-adapter", label: "kotlin-lsp or kotlin-debug-adapter (Kotlin)" }` (tên công cụ, như các nhãn bên cạnh không qua catalog).

- [ ] **Step 1: Viết test thất bại:**

```ts
it("invalidated reloads the selected frame's variables", ...)
// phiên paused, selectedFrame 7; mock commands.debugScopes/debugVariables trả "Collecting data…" rồi "Library@1";
// handleDebugEvent(id, { kind: "invalidated", areas: ["variables"] }) → variablesEpoch +1, debugVariables gọi lại, inline value "Library@1"
it("invalidated while running or for other areas changes nothing", ...) // status running, hoặc areas ["threads"] → epoch giữ nguyên, không gọi debugScopes
// toolWindow.test.tsx
it("the variables pane shows the value sent after an invalidation", ...) // render tab Variables, lần đầu "Collecting data…", sau event → "com.example.library.Library@1"
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `pnpm vitest run src/features/debugger/__tests__/executionState.test.ts src/features/debugger/__tests__/toolWindow.test.tsx` → FAIL.
- [ ] **Step 3: Cài đặt** như Interfaces; bỏ `case "invalidated": break;` tạm nếu Task 3 đã thêm.
- [ ] **Step 4: Chạy lại** lệnh trên → PASS; `pnpm typecheck`, `pnpm lint`, `pnpm knip` → 0 lỗi.
- [ ] **Step 5: Commit**: `git add src/features/debugger/state.ts src/features/debugger/ui/DebugToolWindow.tsx src/features/run/ConfigForm.tsx src/features/debugger/__tests__/executionState.test.ts src/features/debugger/__tests__/toolWindow.test.tsx && git commit -m "feat(debugger): reload variables when the debugger invalidates them"`

---

### Task 6: Smoke với kotlin-lsp thật và với fwcd, kiểm tra toàn bộ, xác minh trong app

**Files:**

- Modify: `smoke/debug.test.ts` (`Case`, `CASES`, `smoke`), `.github/workflows/language-smoke.yml` (bước smoke debug của `kotlin`)

**Interfaces:**

- Consumes: `commands.toolsInstall`, `commands.settingsSet(scope, key, value)`, sự kiện `debug … started` (adapter), notification store.
- Produces: `Case` thêm `tools: string[]` (thay `debugger` để cài), `adapter: string` (adapter của phiên gốc, từ `useDebug.getState().sessions[id].adapter`), `settings?: Record<string, unknown>` (ghi vào scope `global` trước `openProject`), `notice?: string` (title notification phải có).

- [ ] **Step 1: Sửa smoke**: case `kotlin`: `tools: ["kotlin-lsp"]`, `adapter: "kotlin-lsp"` (giữ `variable`, `evaluate`, `memory` và phần instances của M2). Case mới `kotlin-fwcd`: cùng fixture, `tools: ["kotlin-debug-adapter"]`, `adapter: "kotlin-debug-adapter"`, `settings: { languageServers: { "kotlin-lsp": { enabled: false } } }` (gửi `settingsSet("global", "languageServers", JSON.stringify(…))`), `notice: "Debugging Kotlin with kotlin-debug-adapter"`. Các case khác: `tools: [c.debugger cũ]`, `adapter` = tên cũ. Sau lần dừng đầu: `expect(rootOf(s).adapter).toBe(c.adapter)`; có `notice` thì `useNotifications.getState().items` có title đó. Assert step giữ `stopReason === "step"` (Task 3 chuẩn hoá).
- [ ] **Step 2: CI**: trong `language-smoke.yml`, sau bước `pnpm smoke smoke/debug.test.ts -t "^${{ matrix.language }}$"`, thêm bước `if: matrix.language == 'kotlin'` chạy `pnpm smoke smoke/debug.test.ts -t "^kotlin-fwcd$"`.
- [ ] **Step 3: Chạy smoke** (từng lệnh một): `cargo build -p ide-host --bin openidea-server`; `pnpm smoke smoke/debug.test.ts -t "^kotlin$"` → PASS (phiên `kotlin-lsp`, dừng ở `App.kt` dòng sau "Set a breakpoint here", `library` có trong locals, evaluate khớp `/Library/`, step → "step", bảng Memory và instances của `Book` = 3); `pnpm smoke smoke/debug.test.ts -t "^kotlin-fwcd$"` → PASS; `pnpm smoke smoke/debug.test.ts -t "^java$"` → PASS (không hồi quy).
- [ ] **Step 4: Kiểm tra như CI** (từng lệnh): `cargo fmt --all --check`; `cargo clippy --workspace --all-targets -- -D warnings`; `cargo nextest run --workspace`; `pnpm typecheck`; `pnpm lint`; `pnpm format:check`; `pnpm knip`; `pnpm test`; `pnpm build` → 0 lỗi.
- [ ] **Step 5: Xác minh trong app** bằng skill `verify` (Tauri MCP, `pnpm dev:status` lấy cổng và `appIdentifier`): `fixtures/kotlin-gradle` mở mới → Debug `App.kt` từ gutter ngay → thấy task "Waiting for kotlin-lsp to import the project" rồi dừng ở breakpoint; panel Variables hiện `library = …Library@…` (không kẹt "Collecting data…"); Step Over → stop reason step; frame không có tiền tố "at "; Memory tab có bảng class và instances `Book`; Stop → JVM kết thúc. Debug một test Kotlin từ gutter (Gradle attach) → dừng. Tắt `kotlin-lsp` trong Settings › Language Servers → Debug lại → notification "Debugging Kotlin with kotlin-debug-adapter" một lần, phiên fwcd dừng ở breakpoint; Debug lần nữa → không có notification mới. Chụp ảnh sáng/tối và zh.
- [ ] **Step 6: Commit**: `git add smoke/debug.test.ts .github/workflows/language-smoke.yml && git commit -m "feat(debugger): smoke-test Kotlin debugging with kotlin-lsp and the fwcd fallback"`. Không mở PR: lưu lệnh Step 3–4, kết quả và ảnh Step 5 cho mục **How it was verified** của PR chung.

---

## Sửa spec đề xuất (chưa áp; chủ repo duyệt rồi người thực hiện sửa spec)

1. **§13, gạch "Transport DAP qua TCP"**: thay bằng "Transport DAP qua TCP đã có (`debugServer` → `ProcessLauncher` với `reuse_port`, như java-debug); K1 thêm adapter `kotlin-lsp` dùng đường đó, cổng từ `workspace/executeCommand start_debug_server` (`[URI thư mục gốc của server]`; lệnh nhận mọi đối số và mỗi lần trả một cổng mới [XM K1 G5]). `adapterID` của DAP `initialize` phải là `intellij_jvm` [XM K1 G1]. K1 không dùng `launch` của kotlin-lsp nên không gọi `intellij.java.resolveLaunch` (chỉ cần nếu sau này dùng launch)."
2. **§12, đoạn kotlin-lsp**: câu "Phải chờ import xong mới attach (trước đó breakpoint 'verified' nhưng 0 lần trúng)" thêm "Import bắt đầu ngay sau `initialized`, không cần `didOpen`; tín hiệu xong là notification `intellij/workspaceImportState { phase: "FINISHED", folders[].status }`; `$/progress` 'Indexing' lặp mỗi ~10 s nên 'hết progress' không dùng được; `start_debug_server` không tự chờ import [XM K1 G2]". Câu "Client cần xử lý `invalidated`, thread id không ổn định…" thêm "`invalidated` được gửi cả khi client báo `supportsInvalidatedEvent: false`, giá trị đầu là `Collecting data…` [XM K1 G3]; request mang thread id của lần dừng trước không bao giờ được trả lời (request khác vẫn chạy) [XM K1 G4]; `terminate` trên phiên attach thoát JVM, gửi `terminated` rồi đóng socket DAP; `disconnect { terminateDebuggee: false }` khi đang dừng để JVM chạy tiếp [XM K1 G5]".
3. **§15, dòng K1**: "transport DAP qua TCP từ `start_debug_server`" → "adapter `kotlin-lsp` qua đường `debugServer` có sẵn, cổng từ `start_debug_server` sau khi import xong".
4. **§2, bảng bằng chứng**: thêm dòng `K1 | kotlin-lsp DAP điều khiển như ide-dap (adapterID, invalidated, step, thread id, vòng đời, tín hiệu import) | [XM]: trúng breakpoint và step qua relay không giữ gói sau khi đổi adapterID sang intellij_jvm; tín hiệu import intellij/workspaceImportState; xem plan K1 Grounding`.

## Cần chủ repo quyết định

1. **Chờ import bao lâu, rồi làm gì.** Mặc định đề xuất: chờ tối đa 120 s với task "Waiting for kotlin-lsp to import the project", hết giờ thì debug bằng fwcd kèm lý do; lần Debug sau (import đã xong) dùng kotlin-lsp. Lý do: fixture import 1–6 s, dự án Gradle lớn có thể vài phút; người dùng không phải chờ vô hạn.
2. **Thông báo dự phòng hiện bao nhiêu lần.** Mặc định đề xuất: một lần mỗi lý do mỗi project window (mức Info), log mỗi lần. Lý do: người cố ý dùng `kotlin-language-server` sẽ không bị làm phiền ở mỗi lần Debug.
3. **Có cho người dùng ép dùng fwcd không.** Mặc định đề xuất: không thêm setting ở K1; tắt `kotlin-lsp` trong Settings › Language Servers là cách ép (cũng tắt LSP). Run config giữ id `kotlin-debug-adapter`, nhãn đổi thành "kotlin-lsp or kotlin-debug-adapter (Kotlin)".
4. **Phiên kotlin-lsp hỏng lúc khởi động có tự thử lại bằng fwcd không.** Mặc định đề xuất: không; lỗi hiện như lỗi khởi động adapter hôm nay. Lý do: phiên hỏng đã phát `Started` và đã chạy JVM, thử lại tạo phiên thứ hai trong UI; smoke CI với bản kotlin-lsp ghim bắt hồi quy (R2).
5. **Lỗi evaluate sau step của kotlin-lsp (K0).** Mặc định đề xuất: không guard (không phát hiện được từ phía client), ghi trong comment của `kotlin_lsp.rs` và trong mô tả PR mục giới hạn đã biết.

## Self-review

- **Phủ spec:** §12 "Hướng" (kotlin-lsp chính khi là LSP đang chạy, app chạy JVM, `JdwpLink` `hold_resumes = false`, fwcd `true` khi dự phòng) → Task 1, 2, 4; §13 TCP + `start_debug_server` → Task 1, 2 (sửa spec 1 cho `resolveLaunch`); §6.1 (1) theo adapter → Task 2; §9 agent chỉ có ở launch của kotlin-lsp: K1 attach nên agentless, không cần mã; §15 K1 → toàn plan; §16 R2 (fwcd dự phòng, smoke bản cài thật) → Task 4, 6; yêu cầu UI lý do dự phòng đã dịch → Task 4; tật K0 (`invalidated`, thread id, `file://`, `reason: "breakpoint"`, frame async không `presentationHint`: hiển thị như frame thường, không mã) → Task 3, 5; lỗi evaluate sau step → quyết định 5. Tính năng cũ: gutter/test/Gradle đều qua `javaLaunchConfig`/`javaAttachConfig` không đổi; hot swap chỉ java-debug (không đổi); Memory M1/M2 → Task 2 (`JVM_MEMORY_ADAPTERS`, link) và smoke Task 6.
- **Kiểu nhất quán:** `KotlinDebugServer`/`KotlinDebugUnavailable` (Task 1) dùng ở Task 4; `kotlin_lsp::ADAPTER`/`DAP_ADAPTER_ID`/`kotlin::is_kotlin` (Task 2) dùng ở Task 3, 4; `DebugEvent::Invalidated` (Task 3) dùng ở Task 5; `variablesEpoch` chỉ trong Task 5.
- **Ngoài phạm vi K1:** launch/terminal launch của kotlin-lsp (agent coroutine, stack lúc tạo), Coroutine view (M3), Windows.
