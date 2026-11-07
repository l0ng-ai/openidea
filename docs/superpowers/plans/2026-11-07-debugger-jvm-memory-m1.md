# Debugger JVM Memory view (M1: bảng class qua attach) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tab **Memory** trong Debug tool window hiện bảng class của JVM đang debug (số instance, shallow bytes, chênh lệch so với lần lấy trước, lọc, sắp xếp) cho phiên Java (java-debug) và Kotlin, cả launch lẫn attach JDWP vào JVM trên máy này (Gradle, Maven, Tomcat, script).

**Architecture:** Crate mới `ide-jvm-attach` nói chuyện với HotSpot Attach Listener qua socket UNIX `.java_pid<pid>` (giao thức v1, lệnh `jcmd GC.class_histogram -all`) và đọc phiên bản JDK từ file `release`. `ide-dap` giữ trạng thái theo phiên (pid JVM, đang dừng hay chạy, snapshot trước để tính chênh lệch) và quyết định có được gọi attach không. App tự thêm `-XX:+StartAttachListener` khi launch nên không bao giờ cần `SIGQUIT`. Frontend thêm tab Memory trong feature `debugger`.

**Tech Stack:** Rust 2024 (std `UnixStream`, `libc`), tokio `spawn_blocking`, serde + specta (tauri-specta bindings), React + zustand + CSS Modules, `@tanstack/react-virtual` qua `src/ui/List.tsx`, vitest, smoke qua `openidea-server`.

**Spec:** `docs/superpowers/specs/2026-11-07-jvm-debug-link-design.md` (mục 4, 5, 8, 13, 14; phạm vi M1 ở cuối mục 5).

## Global Constraints

- Không bao giờ gửi `SIGQUIT` hay tạo `.attach_pid<pid>` trong M1; chỉ dùng socket đã có.
- Chỉ dùng socket thuộc `geteuid()` và không có quyền group/other (`mode & 0o077 == 0`), như `VirtualMachineImpl` của JDK.
- Histogram luôn ở chế độ `-all` (chế độ live chạy Full GC và xoá `WeakReference` của chương trình; không có trong M1).
- Khi VM đang dừng: chỉ gọi attach nếu JDK major ≥ 17 (đo: 8 và 11 treo; 12–16 chưa đo nên coi như 11).
- Timeout histogram 10 s; output tối đa 64 MiB; một yêu cầu histogram mỗi phiên tại một thời điểm.
- Thêm `-XX:+StartAttachListener` **trước** tham số JVM của người dùng, và không thêm nếu tham số đã chứa `StartAttachListener` hoặc `DisableAttachMechanism`.
- Adapter `java-debug` và `kotlin-debug-adapter` (`ide_dap::kotlin::ADAPTER`); dữ liệu chỉ trên unix (macOS, Linux). Phiên launch: pid từ app. Phiên attach (Task 10–13): pid tìm bằng cổng JDWP qua `agentProperties`, chỉ khi host là loopback. Tab hiện ở mọi phiên JVM; Windows, JVM ở máy khác, JVM không có listener: tab nêu lý do.
- Mọi chỗ app chèn agent JDWP (`jdwpLaunch`, init script Gradle, Tomcat) chèn thêm `-XX:+StartAttachListener` cùng kênh, trừ khi giá trị hiện có của kênh đó hoặc VM options của người dùng đã chứa `StartAttachListener` hoặc `DisableAttachMechanism`.
- IPC: `IdeResult<T>`, camelCase, đăng ký ở cả `crates/ide-host/src/ops/debug.rs::register` và `src-tauri/src/commands/{debug.rs,mod.rs}`; chạy `pnpm gen:bindings`, commit `src/bindings.ts`.
- Mọi chuỗi hiển thị vào `src/platform/locales/text/en.json` và `zh.json` (bản dịch ở Task 7). CSS Modules + tokens, không hex. Không import feature khác.
- Commit: kiểu `feat(debugger): …`, stage từng đường dẫn, không thêm trailer `Co-Authored-By`.

## Grounding

Giả định rủi ro nhất: "attach trả lời khi VM dừng ở breakpoint mà không cần `SIGQUIT`, và trên những JDK nào". Probe: `scratchpad/m1-spike/attach_spike.py` và `jdk8.py` (JDK chạy với `-XX:+StartAttachListener`, JDWP dừng ở breakpoint, gửi yêu cầu attach v1 trên socket có sẵn). Output:

```
11 {"socket_at_boot": true, "bp_hist_ms": 15013, "bp_hist": "TIMEOUT", "bp_version": "TIMEOUT", "startup_suspended_version": ["OpenJDK 64-Bit Server VM version 11.0.29+7"], "startup_suspended_ms": 14}
17 {"socket_at_boot": true, "bp_hist_ms": 32, "bp_hist": [0, 284, [..., "   1:       1000000       16000000  Heap$Live"]], "bp_version": ["OpenJDK 64-Bit Server VM version 17.0.21+9", "JDK 17.0.21"], ...}
21 {"socket_at_boot": true, "bp_hist_ms": 34, ...}
25 {"socket_at_boot": true, "bp_hist_ms": 32, ...}
JDK 8: socket_at_boot True; running 'GC.class_histogram -all' rc 0; suspended histogram rc TIMEOUT 15006 ms
```

Định dạng output thật (dùng làm fixture):

```
JDK 17:  ' num     #instances         #bytes  class name (module)'
         '-------------------------------------------------------'
         '   1:          1085        3955024  [I (java.base@17.0.21)'
         '   1:       1000000       16000000  Heap$Live'
         'Total         31639        5354360'
JDK 25:  '   1:             4        3565864  [Ljdk.internal.vm.FillerElement; (java.base@25.0.3)'
JDK 8:   ''  (dòng trống đầu)  ' num     #instances         #bytes  class name'  '----------------------------------------------'  '   1:           425        3572968  [I'
Lỗi:     rc "-1", body "java.lang.IllegalArgumentException: Unknown argument '-bogus' in diagnostic command."
VM.version: 'OpenJDK 64-Bit Server VM version 17.0.21+9' / 'JDK 17.0.21';  JDK 8: 'JDK 8.0_512'
```

Kết luận: listener bật lúc khởi động là đủ, không cần `SIGQUIT`; cổng chặn theo JDK ≥ 17 khi đang dừng là bắt buộc.

**S8 (bổ sung sau khi xác minh trong app, cho Task 10–13).** Giả định rủi ro nhất: "JVM do Gradle sinh ra khi debug có socket attach, và tìm được pid của nó". Probe: `scratchpad/m1-spike/gradle_spike.py` (init script `gradleRun.gradle` thêm `-XX:+StartAttachListener` cạnh agent JDWP, chạy `openideaRun` của `fixtures/kotlin-gradle`) và `agentprops_versions.py`. Output:

```
VM.system_properties  → "jdwp_lines": []                       (không có cổng: giả thuyết đầu bị bác)
agentProperties       → "sun.jdwp.listenerAddress=dt_socket\\:64390"  (cổng in ra: 64390)
"cli_children": [], "matched_ppid_comm": "87421 …/21.0.4-tem/bin/java", "matched_under_cli": false   (cha là Gradle daemon)
"scan_ms": 51, "histogram_code": 0
JDK 8:  16 ms ['0', 'sun.jdwp.listenerAddress=dt_socket\\:64468', …]
11 {"printed": "64449", "code": 0, "prop": ["sun.jdwp.listenerAddress=dt_socket\\:64449"], "ms": 84}
17 {"printed": "64451", "code": 0, "prop": ["sun.jdwp.listenerAddress=dt_socket\\:64451"], "ms": 98}
21 {"printed": "64452", "code": 0, "prop": ["sun.jdwp.listenerAddress=dt_socket\\:64452"], "ms": 47}
25 {"printed": "64453", "code": 0, "prop": ["sun.jdwp.listenerAddress=dt_socket\\:64453"], "ms": 92}
```

Kết luận: tìm theo cây tiến trình không được (daemon); quét socket của user và khớp `sun.jdwp.listenerAddress` với cổng thì được trên mọi JDK, khi JVM còn chờ debugger.

## Review Focus

1. **VM dừng giữa chừng một yêu cầu trên JDK 8/11** (bấm Refresh lúc đang chạy rồi breakpoint trúng): yêu cầu phải kết thúc bằng lý do `timedOut` sau ≤ 10 s, phiên debug vẫn chạy, khoá yêu cầu được nhả, lần Refresh sau khi resume chạy được. Test ở Task 2 (`jcmd_times_out_when_listener_never_answers`) và Task 5 (`histogram_lock_released_after_timeout`).
2. **Socket cũ của JVM đã chết / pid bị dùng lại** (`ECONNREFUSED`): hiện lý do `programExited` hoặc `listenerNotRunning`, không phải toast lỗi. Test ở Task 2 (`stale_socket_maps_to_refused`) và Task 5 (`refused_socket_reports_program_exited`).
3. **Socket không thuộc user hoặc có quyền group/other**: từ chối, không đọc dữ liệu. Test ở Task 2 (`rejects_socket_with_group_or_other_permissions`).
4. **Chương trình chạy qua shell/terminal** (`runInTerminal`, `debuggee_pid` là shell): chọn đúng tiến trình con có listener. Test ở Task 5 (`picks_first_descendant_with_listener`).
5. **Resume/step không kèm sự kiện `continued`** (java-debug thường không gửi): cờ "đang dừng" phải được xoá khi request resume/step thành công, nếu không người dùng JDK 11 thấy sai thông báo "resume trước". Test ở Task 4 (`resume_clears_suspended_without_continued_event`).
6. **Một JVM khác của user đang dừng ở breakpoint trên JDK 11** (socket có nhưng không trả lời) khi quét tìm pid: attach không bị chậm quá ngân sách 2 s và vẫn tìm đúng JVM. Test ở Task 10 (`scan_skips_silent_listener_within_budget`).
7. **Người dùng tắt attach** bằng `-XX:+DisableAttachMechanism` hay `-XX:-StartAttachListener` trong `JAVA_TOOL_OPTIONS`, `MAVEN_OPTS`, VM options của Tomcat hay jvmArgs Gradle: app không thêm cờ. Test ở Task 12 (`keeps_user_attach_opt_out`).
8. **Attach vào JVM ở máy khác** (host không phải loopback): không quét, tab nêu lý do. Test ở Task 11 (`remote_host_is_not_scanned`).
9. **Một lần chạy sinh hai JVM có JDWP** (Gradle `test` + `run`, `JAVA_TOOL_OPTIONS` cho script): mỗi phiên attach lấy đúng pid theo cổng của nó. Test ở Task 10 (`scan_matches_port_not_first_listener`).

---

### Task 0: Issue và worktree

**Files:** không.

- [ ] **Step 1: Hỏi chủ repo trước khi tạo issue** (quyết định 7 của spec). Khi được đồng ý: `gh issue create --title "Debugger: JVM Memory view (class table)" --body "<mục tiêu M1, link spec>"`; ghi số issue `#N` để dùng trong PR (`Closes #N`).
- [ ] **Step 2: Tạo worktree**

```bash
git worktree add ../openidea-jvm-memory -b feat/debugger-jvm-memory origin/main
cd ../openidea-jvm-memory && pnpm install
```

Expected: worktree mới trên `origin/main`. Copy spec và plan này vào worktree nếu chúng chưa có trên `main`, commit riêng: `git add docs/superpowers/specs/2026-11-07-jvm-debug-link-design.md docs/superpowers/plans/2026-11-07-debugger-jvm-memory-m1.md && git commit -m "feat(debugger): add JVM memory view design and M1 plan"`.

---

### Task 1: Crate `ide-jvm-attach` và parser histogram

**Files:**

- Create: `crates/ide-jvm-attach/Cargo.toml`, `crates/ide-jvm-attach/src/lib.rs`, `crates/ide-jvm-attach/src/histogram.rs`
- Modify: `Cargo.toml` (`[workspace.dependencies]`: `ide-jvm-attach = { path = "crates/ide-jvm-attach" }`)

**Interfaces:**

- Produces:
  - `pub struct HistogramRow { pub name: String, pub module: Option<String>, pub instances: u64, pub bytes: u64 }` (`name` ở dạng mã nguồn Java: `int[]`, `java.lang.String[][]`, `Heap$Live`; `module` như `java.base@17.0.21`)
  - `pub struct ClassHistogram { pub rows: Vec<HistogramRow>, pub skipped_lines: u32 }`
  - `pub fn parse_class_histogram(text: &str) -> ClassHistogram`
  - `pub fn display_class_name(jvm_name: &str) -> String`

Cargo: `edition.workspace`, `version.workspace`, `license.workspace`; deps `thiserror.workspace`; `[target.'cfg(unix)'.dependencies] libc = "0.2"`; dev-deps `tempfile.workspace`.

- [ ] **Step 1: Viết test thất bại** trong `histogram.rs` (`#[cfg(test)] mod tests`):

```rust
const JDK17: &str = " num     #instances         #bytes  class name (module)\n-------------------------------------------------------\n   1:          1085        3955024  [I (java.base@17.0.21)\n   2:       1000000       16000000  Heap$Live\n   3:          1218         107296  [Ljava.lang.Object; (java.base@17.0.21)\n   4:             4        3565864  [Ljdk.internal.vm.FillerElement; (java.base@25.0.3)\n   5:             2             64  [[B (java.base@17.0.21)\n   6:             1             16  Heap$$Lambda/0x000000080000c218\nTotal         31639        5354360\n";
const JDK8: &str = "\n num     #instances         #bytes  class name\n----------------------------------------------\n   1:           425        3572968  [I\n   2:        100000        1600000  Heap$Live\nTotal        100425        5172968\n";

#[test]
fn parses_jdk17_rows_with_modules() {
    let h = parse_class_histogram(JDK17);
    assert_eq!(h.rows[0], HistogramRow { name: "int[]".into(), module: Some("java.base@17.0.21".into()), instances: 1085, bytes: 3955024 });
    assert_eq!(h.rows[1], HistogramRow { name: "Heap$Live".into(), module: None, instances: 1_000_000, bytes: 16_000_000 });
    assert_eq!(h.rows[2].name, "java.lang.Object[]");
    assert_eq!(h.rows.iter().find(|r| r.name == "byte[][]").unwrap().instances, 2);
    assert_eq!(h.rows.last().unwrap().name, "Heap$$Lambda/0x000000080000c218");
}
#[test]
fn drops_g1_filler_rows() {
    assert!(parse_class_histogram(JDK17).rows.iter().all(|r| !r.name.contains("jdk.internal.vm.Filler")));
}
#[test]
fn parses_jdk8_without_module_column() {
    let h = parse_class_histogram(JDK8);
    assert_eq!(h.rows.len(), 2);
    assert_eq!(h.rows[1], HistogramRow { name: "Heap$Live".into(), module: None, instances: 100000, bytes: 1600000 });
    assert_eq!(h.skipped_lines, 0);
}
#[test]
fn counts_garbled_lines_instead_of_failing() {
    let h = parse_class_histogram("   1:   12  abc  Foo\n   2:   3   48  Bar\n");
    assert_eq!(h.rows.len(), 1);
    assert_eq!(h.skipped_lines, 1);
}
#[test]
fn display_names_for_arrays() {
    for (jvm, shown) in [("[Z", "boolean[]"), ("[J", "long[]"), ("[[D", "double[][]"), ("[Ljava.lang.String;", "java.lang.String[]"), ("java.util.HashMap$Node", "java.util.HashMap$Node")] {
        assert_eq!(display_class_name(jvm), shown);
    }
}
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo test -p ide-jvm-attach` → FAIL (chưa có hàm).
- [ ] **Step 3: Cài đặt** `parse_class_histogram` và `display_class_name`. Dòng hợp lệ: `<num>:` rồi hai số nguyên rồi tên; phần ` (<module>)` ở cuối là module. Bỏ qua dòng trống, dòng header (`num`), dòng `---`, dòng `Total`. Dòng bắt đầu bằng `<num>:` mà không đọc được → `skipped_lines += 1`. Bỏ dòng có tên (sau khi đổi sang dạng hiển thị) bắt đầu bằng `jdk.internal.vm.Filler`.
- [ ] **Step 4: Chạy lại**: `cargo test -p ide-jvm-attach` → PASS.
- [ ] **Step 5: Commit**: `git add Cargo.toml crates/ide-jvm-attach && git commit -m "feat(debugger): parse HotSpot class histograms"`

---

### Task 2: Client attach trên socket có sẵn

**Files:**

- Create: `crates/ide-jvm-attach/src/socket.rs`
- Modify: `crates/ide-jvm-attach/src/lib.rs`

**Interfaces:**

- Produces:
  - `#[derive(Debug, thiserror::Error)] pub enum AttachError { Unsupported, NoListener, ForeignListener, Refused, Timeout, TooLarge, Command { code: i32, message: String }, Protocol(String), Io(#[from] std::io::Error) }`
  - `pub fn temp_dir() -> std::path::PathBuf` — macOS `confstr(_CS_DARWIN_USER_TEMP_DIR)` (`libc::_CS_DARWIN_USER_TEMP_DIR`, giá trị 65537, **không** phải `$TMPDIR`), Linux `/tmp`.
  - `pub fn has_listener(pid: u32) -> bool` — socket `<temp_dir>/.java_pid<pid>` tồn tại và qua kiểm tra chủ sở hữu.
  - `pub fn jcmd(pid: u32, command_line: &str, timeout: Duration) -> Result<String, AttachError>`
  - `pub(crate) fn jcmd_at(path: &Path, command_line: &str, timeout: Duration) -> Result<String, AttachError>`
  - `pub const MAX_OUTPUT: usize = 64 * 1024 * 1024;`
  - Trên `cfg(not(unix))`: `has_listener` trả `false`, `jcmd` trả `Err(AttachError::Unsupported)`.

- [ ] **Step 1: Viết test thất bại** (`socket.rs`, `#[cfg(all(test, unix))]`), dùng `UnixListener` trong `tempfile::tempdir()`:

```rust
#[test] fn sends_v1_jcmd_request_and_returns_body() // server đọc tới EOF-less: đọc đúng 4 chuỗi kết thúc NUL; assert bytes == b"1\0jcmd\0GC.class_histogram -all\0\0\0"; trả "0\nhello\n" rồi đóng → Ok("hello\n")
#[test] fn nonzero_code_is_command_error()      // server trả "-1\njava.lang.IllegalArgumentException: Unknown diagnostic command" → Err(Command { code: -1, message }) với message chứa "Unknown diagnostic command"
#[test] fn jcmd_times_out_when_listener_never_answers() // server accept rồi giữ kết nối; timeout 200 ms → Err(Timeout), tổng thời gian < 1 s
#[test] fn stale_socket_maps_to_refused()        // bind rồi drop listener (file còn) → Err(Refused)
#[test] fn rejects_socket_with_group_or_other_permissions() // chmod 0o666 → has_listener_at false, jcmd_at Err(ForeignListener)
#[test] fn output_over_limit_is_too_large()      // dùng hằng giới hạn nhỏ qua tham số nội bộ → Err(TooLarge)
#[test] fn missing_socket_is_no_listener()
```

Để test được giới hạn, tách `fn read_reply(stream, deadline, max) -> Result<String, AttachError>`; `jcmd_at` gọi nó với `MAX_OUTPUT`.

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo test -p ide-jvm-attach socket` → FAIL.
- [ ] **Step 3: Cài đặt.** Kiểm tra quyền bằng `std::os::unix::fs::MetadataExt` (`uid() == libc::geteuid()` và `mode() & 0o077 == 0`) **trước** khi connect. Request = `"1\0" "jcmd\0" "<command_line>\0" "\0" "\0"`. Đọc tới EOF với deadline tổng (đặt `set_read_timeout` theo thời gian còn lại mỗi vòng); dòng đầu là mã kết quả (số nguyên có thể âm), phần sau là body (UTF-8 lossy). `ECONNREFUSED` → `Refused`; `ENOENT` → `NoListener`.
- [ ] **Step 4: Chạy lại** → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-jvm-attach && git commit -m "feat(debugger): talk to the HotSpot attach listener"`

---

### Task 3: Phiên bản JDK, cờ listener và test JVM thật

**Files:**

- Create: `crates/ide-jvm-attach/src/jvm.rs`, `crates/ide-jvm-attach/tests/real_jvm.rs`
- Modify: `crates/ide-jvm-attach/src/lib.rs`

**Interfaces:**

- Produces:
  - `pub struct JavaVersion { pub major: u32, pub text: String }`
  - `pub fn parse_release(contents: &str) -> Option<JavaVersion>` — dòng `JAVA_VERSION="…"`
  - `pub fn parse_vm_version(output: &str) -> Option<JavaVersion>` — dòng `JDK …`
  - `pub fn java_version_of(pid: u32) -> Option<JavaVersion>` — file thực thi (`/proc/<pid>/exe`, macOS `libc::proc_pidpath`) → tìm `release` ở `exe/../..` rồi `exe/../../..` (JRE của JDK 8 nằm trong `jre/`)
  - `pub fn histogram_safe_while_suspended(major: u32) -> bool` — `major >= 17`; comment một dòng: đo được JDK 8/11 treo khi bị suspend
  - `pub const START_LISTENER_FLAG: &str = "-XX:+StartAttachListener";`
  - `pub fn wants_listener_flag(jvm_args: &str) -> bool` — `false` nếu chứa `StartAttachListener` hoặc `DisableAttachMechanism`

- [ ] **Step 1: Viết test thất bại** (`jvm.rs`):

```rust
#[test] fn release_versions() {
    assert_eq!(parse_release("IMPLEMENTOR=\"Eclipse Adoptium\"\nJAVA_VERSION=\"17.0.21\"\n").unwrap().major, 17);
    assert_eq!(parse_release("JAVA_VERSION=\"1.8.0_512\"").unwrap().major, 8);
    assert_eq!(parse_release("JAVA_VERSION=\"25\"").unwrap(), JavaVersion { major: 25, text: "25".into() });
    assert!(parse_release("IMPLEMENTOR=x").is_none());
}
#[test] fn vm_version_lines() {
    assert_eq!(parse_vm_version("OpenJDK 64-Bit Server VM version 17.0.21+9\nJDK 17.0.21\n").unwrap().major, 17);
    assert_eq!(parse_vm_version("OpenJDK 64-Bit Server VM version 25.512-b09\nJDK 8.0_512\n").unwrap().major, 8);
}
#[test] fn suspended_gate() { assert!(!histogram_safe_while_suspended(11)); assert!(!histogram_safe_while_suspended(16)); assert!(histogram_safe_while_suspended(17)); }
#[test] fn listener_flag_respects_user_choice() {
    assert!(wants_listener_flag("-Xmx1g"));
    assert!(!wants_listener_flag("-XX:-StartAttachListener"));
    assert!(!wants_listener_flag("-Xmx1g -XX:+DisableAttachMechanism"));
}
```

`tests/real_jvm.rs` (`#[ignore]`, unix): đọc `OPENIDEA_TEST_JAVA` (đường dẫn `java`), ghi một `Main.java` nhỏ giữ 1000 object `Main$Item` vào tempdir, chạy `java -XX:+StartAttachListener Main.java` (single-file source, JDK ≥ 11), chờ dòng `READY`; assert `has_listener(pid)`, `java_version_of(pid).major` khớp `java -version`, `parse_class_histogram(&jcmd(pid, "GC.class_histogram -all", 10s)?)` có dòng `Main$Item` với `instances == 1000`; `jcmd(pid, "No.such", …)` → `Command`. Kill tiến trình ở cuối (kể cả khi assert lỗi).

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo test -p ide-jvm-attach jvm` → FAIL.
- [ ] **Step 3: Cài đặt** các hàm trên.
- [ ] **Step 4: Chạy lại**: `cargo test -p ide-jvm-attach` → PASS; rồi `OPENIDEA_TEST_JAVA=$HOME/.sdkman/candidates/java/21.0.4-tem/bin/java cargo test -p ide-jvm-attach --test real_jvm -- --ignored` → PASS (lặp với JDK 11 và 25 nếu có).
- [ ] **Step 5: Commit**: `git add crates/ide-jvm-attach && git commit -m "feat(debugger): read the debuggee's JDK version and attach flag"`

---

### Task 4: Trạng thái phiên trong `ide-dap` (pid JVM, đang dừng, cờ listener cho Kotlin)

**Files:**

- Modify: `crates/ide-dap/Cargo.toml` (dep `ide-jvm-attach.workspace = true`), `crates/ide-dap/src/session.rs` (struct `Session` ~dòng 30–75, `on_event` ~455–500, `start_kotlin_debuggee` ~727–795, `process_tree` ~295), `crates/ide-dap/src/lib.rs` (`resume` 1350, `step` 1386, `run_to` 1401, `force_step_over` 1482, `step_in_target` 1489)
- Test: `crates/ide-dap/src/tests.rs`

**Interfaces:**

- Produces trên `Session`:
  - `pub jvm_pid: AtomicI64` — pid JVM do app tự chạy (Kotlin). **Không** dùng `debuggee_pid` cho việc này: `debuggee_pid` điều khiển cách Stop gửi tín hiệu, đổi nó sẽ đổi hành vi Stop của Kotlin.
  - `pub suspended: AtomicBool` — `true` khi nhận `stopped`; `false` khi nhận `continued` hoặc khi request `continue`/step/run-to/force-step-over/step-in-target trả về thành công. Giá trị sai theo hướng `true` chỉ làm từ chối an toàn; vì vậy không xoá ở chỗ nào khác.
  - `pub(crate) fn process_tree(pid: i32) -> Vec<i32>` (đổi từ private)

- [ ] **Step 1: Viết test thất bại** trong `tests.rs` (dùng `harness(Script { .. })` hiện có; Script đã phát `stopped` ở dòng ~198):

```rust
#[tokio::test] async fn stopped_event_marks_session_suspended()        // sau stopped → session.suspended == true
#[tokio::test] async fn resume_clears_suspended_without_continued_event() // stopped → manager.resume(id, 1) → suspended == false (FakeLauncher không gửi continued)
#[tokio::test] async fn continued_event_clears_suspended()
```

Và unit test cho dựng lệnh Kotlin: tách `fn kotlin_jvm_args(user: Vec<String>) -> Vec<String>` trong `session.rs`:

```rust
#[test] fn kotlin_launch_starts_attach_listener_first() {
    assert_eq!(kotlin_jvm_args(vec!["-Xmx1g".into()]), vec!["-XX:+StartAttachListener".to_string(), "-Xmx1g".into()]);
    assert_eq!(kotlin_jvm_args(vec!["-XX:+DisableAttachMechanism".into()]), vec!["-XX:+DisableAttachMechanism".to_string()]);
}
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo nextest run -p ide-dap` → FAIL.
- [ ] **Step 3: Cài đặt.** `start_kotlin_debuggee` dùng `kotlin_jvm_args(strings("vmArguments"))` và sau `spawn` lưu `child.id()` vào `s.jvm_pid`. `on_event`: `"stopped"` set `suspended = true` trước khi emit; `"continued"` set `false`. Các hàm resume/step trong `lib.rs` set `false` sau khi request thành công.
- [ ] **Step 4: Chạy lại**: `cargo nextest run -p ide-dap` → PASS (toàn bộ test cũ của `ide-dap` vẫn xanh).
- [ ] **Step 5: Commit**: `git add crates/ide-dap && git commit -m "feat(debugger): track a JVM session's pid and suspension"`

---

### Task 5: Snapshot bảng class trong `ide-dap`

**Files:**

- Create: `crates/ide-dap/src/jvm_memory.rs`
- Modify: `crates/ide-dap/src/lib.rs` (`mod jvm_memory; pub use jvm_memory::*;`, `DebugCapabilities` ~117, `capabilities()` ~1527, method mới trên `DebugManager`), `crates/ide-dap/src/session.rs` (field `pub jvm_memory: tokio::sync::Mutex<JvmMemoryState>`)

**Interfaces:**

- Consumes: Task 1–3 (`ide_jvm_attach::{has_listener, jcmd, parse_class_histogram, java_version_of, parse_vm_version, histogram_safe_while_suspended, AttachError}`), Task 4 (`jvm_pid`, `suspended`, `process_tree`).
- Produces (serde camelCase, `specta::Type`):

```rust
pub struct JvmClassRow { pub name: String, pub module: Option<String>, pub instances: u64, pub bytes: u64,
    pub delta_instances: Option<i64>, pub delta_bytes: Option<i64>, pub ambiguous: bool }
pub struct JvmMemorySnapshot { pub rows: Vec<JvmClassRow>, pub total_instances: u64, pub total_bytes: u64,
    pub java_version: String, pub taken_while_suspended: bool, pub has_baseline: bool, pub elapsed_ms: u32 }
#[serde(tag = "kind")] pub enum JvmMemoryUnavailable { NotLaunchedByIde, UnsupportedPlatform, NoJvmProcess,
    ListenerNotRunning, UnsafeWhileSuspended { java_major: u32 }, ProgramExited, TimedOut }
#[serde(tag = "status")] pub enum JvmMemoryResult { Ready { snapshot: JvmMemorySnapshot }, Unavailable { reason: JvmMemoryUnavailable } }
pub struct JvmMemoryState { previous: Option<HashMap<String, (u64, u64)>> } // chỉ tên không trùng
pub const JVM_MEMORY_ADAPTERS: &[&str] = &["java-debug", crate::kotlin::ADAPTER];
pub const HISTOGRAM_TIMEOUT: Duration = Duration::from_secs(10);
impl DebugManager { pub async fn jvm_memory_classes(&self, s: DebugSessionId) -> IdeResult<JvmMemoryResult> }
pub(crate) fn pick_jvm_pid(tree: &[i32], has_listener: impl Fn(u32) -> bool) -> Option<u32>
pub(crate) fn diff_rows(rows: Vec<HistogramRow>, previous: Option<&HashMap<String, (u64, u64)>>) -> (Vec<JvmClassRow>, HashMap<String, (u64, u64)>)
```

Hai enum dùng `#[serde(tag = …, rename_all = "camelCase", rename_all_fields = "camelCase")]` như `DebugEvent` (`crates/ide-core/src/event.rs:204`), nên TS thấy `{ kind: "unsafeWhileSuspended", javaMajor: 11 }`.
`DebugCapabilities` thêm `pub jvm_memory: bool` = `JVM_MEMORY_ADAPTERS.contains(adapter) && request == "launch" && cfg!(unix)`.

- [ ] **Step 1: Viết test thất bại** (`jvm_memory.rs` + `tests.rs`):

```rust
#[test] fn picks_first_descendant_with_listener() { assert_eq!(pick_jvm_pid(&[10, 11, 12], |p| p == 12), Some(12)); assert_eq!(pick_jvm_pid(&[10], |_| false), None); }
#[test] fn first_snapshot_has_no_deltas()          // diff_rows(rows, None) → mọi delta None
#[test] fn deltas_against_previous_snapshot()       // previous {"A": (2, 32)}, rows A(5, 80), B(1, 16) → A Some(3)/Some(48), B Some(1)/Some(16) (class mới: delta = giá trị hiện tại)
#[test] fn duplicate_names_are_ambiguous_without_delta() // hai dòng "Foo" → cả hai ambiguous, delta None, không vào map mới
#[test] fn rows_sorted_by_bytes_descending()
#[tokio::test] async fn attach_session_is_not_launched_by_ide()   // harness với request "attach" → Unavailable(NotLaunchedByIde); capabilities().jvm_memory == false
#[tokio::test] async fn unknown_pid_reports_no_jvm_process()      // launch không có process event → Unavailable(NoJvmProcess)
#[tokio::test] async fn histogram_lock_released_after_timeout()   // AttachProbe giả trả Err(Timeout) lần 1, Ok lần 2 → TimedOut rồi Ready; lần 2 không bị lần 1 chặn
#[test] fn refused_socket_reports_program_exited()                // AttachProbe giả: histogram Err(Refused), alive false → ProgramExited; alive true → ListenerNotRunning
```

Để test được các đường có socket, tách phần đồng bộ thành `fn take_snapshot(probe: &dyn AttachProbe, pid_tree: &[i32], suspended: bool, previous: Option<&…>) -> Result<…>` với `trait AttachProbe { fn has_listener(&self, pid: u32) -> bool; fn version(&self, pid: u32) -> Option<JavaVersion>; fn histogram(&self, pid: u32) -> Result<String, AttachError>; fn alive(&self, pid: u32) -> bool }`; bản thật gọi `ide_jvm_attach`, test dùng bản giả.

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo nextest run -p ide-dap jvm_memory` → FAIL.
- [ ] **Step 3: Cài đặt `jvm_memory_classes`.** Thứ tự quyết định:
  1. Adapter không trong `JVM_MEMORY_ADAPTERS` hoặc `request != "launch"` → `NotLaunchedByIde`; không phải unix → `UnsupportedPlatform`.
  2. `pid = jvm_pid` nếu > 0, nếu không thì `debuggee_pid`; 0 → `NoJvmProcess`.
  3. Khoá `session.jvm_memory` (một yêu cầu mỗi phiên), rồi `spawn_blocking`: `pick_jvm_pid(process_tree(pid))` → không có: `ProgramExited` nếu `pid` đã chết, ngược lại `ListenerNotRunning`.
  4. Phiên bản: `java_version_of`, nếu `None` và VM không dừng thì `jcmd VM.version` (timeout 2 s) + `parse_vm_version`. Đang dừng mà chưa biết bản hoặc `!histogram_safe_while_suspended(major)` → `UnsafeWhileSuspended { java_major }` (0 nếu không biết).
  5. `jcmd(pid, "GC.class_histogram -all", HISTOGRAM_TIMEOUT)`: `Timeout` → `TimedOut`; `Refused`/`NoListener` → `ProgramExited` hoặc `ListenerNotRunning` như bước 3; `ForeignListener` → `ListenerNotRunning` và `tracing::warn!`; `Command`/`Protocol`/`TooLarge`/`Io` → `IdeError::internal`.
  6. `diff_rows`, lưu map mới vào state, trả `Ready`. `taken_while_suspended` lấy giá trị `suspended` lúc bắt đầu.
- [ ] **Step 4: Chạy lại**: `cargo nextest run -p ide-dap` → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-dap && git commit -m "feat(debugger): snapshot a JVM's class table over attach"`

---

### Task 6: Cờ listener cho Java, lệnh IPC và bindings

**Files:**

- Modify: `crates/ide-host/Cargo.toml` (dep `ide-jvm-attach.workspace = true`), `crates/ide-host/src/ops/debug.rs` (`debug_start` ~dòng 10, hàm mới cạnh `match_java_debug_encoding`, `register` ~362, tests cuối file), `src-tauri/src/commands/debug.rs`, `src-tauri/src/commands/mod.rs` (~460), `src/bindings.ts` (sinh lại)

**Interfaces:**

- Consumes: `DebugManager::jvm_memory_classes` (Task 5), `ide_jvm_attach::{START_LISTENER_FLAG, wants_listener_flag}` (Task 3).
- Produces:
  - `fn start_java_attach_listener(config: LaunchConfig) -> LaunchConfig` (ide-host, private): chỉ `adapter == "java-debug" && request == "launch"`; `vmArgs` = `"-XX:+StartAttachListener"` + `" " + vmArgs` cũ (nếu khác rỗng) khi `wants_listener_flag(vmArgs)`.
  - `pub async fn debug_jvm_memory_classes(host: &Host, _window: &str, session: DebugSessionId) -> IdeResult<JvmMemoryResult>` (ide-host) đăng ký tên `"debug_jvm_memory_classes"` với arg `"session"`.
  - Tauri `debug_jvm_memory_classes(state, session)`; TS: `commands.debugJvmMemoryClasses(session)`.

- [ ] **Step 1: Viết test thất bại** trong `ops/debug.rs` (dùng helper `launch(adapter, request, extra)` và `vm_args` có sẵn):

```rust
#[test] fn java_debug_launches_start_the_attach_listener() {
    let fixed = start_java_attach_listener(launch("java-debug", "launch", serde_json::json!({"vmArgs": "-Xmx1g"})));
    assert_eq!(vm_args(&fixed), "-XX:+StartAttachListener -Xmx1g");
    assert_eq!(vm_args(&start_java_attach_listener(launch("java-debug", "launch", serde_json::json!({})))), "-XX:+StartAttachListener");
    for extra in [serde_json::json!({"vmArgs": "-XX:-StartAttachListener"}), serde_json::json!({"vmArgs": "-XX:+DisableAttachMechanism"})] {
        assert_eq!(vm_args(&start_java_attach_listener(launch("java-debug", "launch", extra.clone()))), extra["vmArgs"]);
    }
    assert_eq!(vm_args(&start_java_attach_listener(launch("java-debug", "attach", serde_json::json!({"vmArgs": "-Xmx1g"})))), "-Xmx1g");
}
```

Lưu ý thứ tự trong `debug_start`: gọi `start_java_attach_listener` **trước** `match_java_debug_encoding`, để test encoding hiện có (`java_debug_launches_on_windows_write_utf8`) vẫn chỉ kiểm phần đuôi; cập nhật chuỗi mong đợi của test đó nếu nó gọi qua `debug_start` (hiện nó gọi thẳng `match_java_debug_encoding` nên không đổi).

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo nextest run -p ide-host debug` → FAIL.
- [ ] **Step 3: Cài đặt** hàm, gọi trong `debug_start`, thêm op và đăng ký; thêm lệnh Tauri và liệt kê trong `mod.rs`.
- [ ] **Step 4: Chạy lại và sinh bindings**: `cargo nextest run -p ide-host debug` → PASS; `pnpm gen:bindings` → `src/bindings.ts` có `debugJvmMemoryClasses` và các kiểu `JvmMemoryResult`, `JvmClassRow`, `JvmMemoryUnavailable`; `DebugCapabilities` có `jvmMemory`.
- [ ] **Step 5: Commit**: `git add crates/ide-host src-tauri/src/commands/debug.rs src-tauri/src/commands/mod.rs src/bindings.ts && git commit -m "feat(debugger): expose the JVM class table over IPC"`

---

### Task 7: Store và logic hiển thị phía frontend

**Files:**

- Create: `src/features/debugger/memory/memoryState.ts`, `src/features/debugger/memory/rows.ts`
- Test: `src/features/debugger/__tests__/memoryRows.test.ts`, `src/features/debugger/__tests__/memoryState.test.ts`

**Interfaces:**

- Consumes: `commands.debugJvmMemoryClasses`, `call`, `useDebug` (`stopSeq`, `sessions`) từ `../state`.
- Produces:
  - `rows.ts`: `export type SortKey = "name" | "instances" | "deltaInstances" | "bytes"`; `export interface RowQuery { filter: string; sort: SortKey; desc: boolean; changedOnly: boolean }`; `export function visibleRows(rows: readonly JvmClassRow[], q: RowQuery): JvmClassRow[]`; `export function formatBytes(n: number): string`; `export function formatDelta(n: number | null): string`.
  - `memoryState.ts`: `export interface MemoryEntry { result: JvmMemoryResult | null; loading: boolean; error: string | null; takenAtStop: number; query: RowQuery }`; `export const useMemory` (zustand, `bySession: Record<DebugSessionId, MemoryEntry>`); `export async function refreshMemory(id: DebugSessionId): Promise<void>`; `export function setMemoryQuery(id: DebugSessionId, patch: Partial<RowQuery>): void`; `export function isOutdated(entry: MemoryEntry, stopSeq: number): boolean` (`takenAtStop !== stopSeq`); `export function forgetMemory(id: DebugSessionId): void`. Mặc định query: `{ filter: "", sort: "bytes", desc: true, changedOnly: false }`.

- [ ] **Step 1: Viết test thất bại**:

```ts
it("filters by substring, case-insensitive", () => expect(visibleRows(rows, { ...q, filter: "hashmap" }).map((r) => r.name)).toEqual(["java.util.HashMap$Node"]));
it("changed only keeps non-zero instance deltas", ...)       // deltaInstances 0 và null bị bỏ
it("sorts by delta with nulls last in both directions", ...)
it("formats bytes", () => { expect(formatBytes(0)).toBe("0 B"); expect(formatBytes(1536)).toBe("1.5 KB"); expect(formatBytes(16_000_000)).toBe("15.3 MB"); });
it("formats deltas", () => { expect(formatDelta(null)).toBe(""); expect(formatDelta(0)).toBe("0"); expect(formatDelta(3)).toBe("+3"); expect(formatDelta(-2)).toBe("−2"); });
it("refreshMemory stores the result and the stop it was taken at", ...)   // mock commands.debugJvmMemoryClasses; useDebug.setState({ stopSeq: 4 }) → entry.takenAtStop === 4, loading false
it("refreshMemory keeps the old snapshot and records the error on failure", ...)
it("ignores a second refresh while one is loading", ...)
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `pnpm vitest run src/features/debugger/__tests__/memoryRows.test.ts src/features/debugger/__tests__/memoryState.test.ts` → FAIL.
- [ ] **Step 3: Cài đặt.** `formatBytes` dùng bội số 1024, một chữ số thập phân từ KB trở lên. Gọi `forgetMemory` khi phiên bị xoá khỏi `useDebug` (đăng ký trong `activate()` của debugger bằng `useDebug.subscribe`).
- [ ] **Step 4: Chạy lại** → PASS.
- [ ] **Step 5: Commit**: `git add src/features/debugger/memory src/features/debugger/__tests__/memoryRows.test.ts src/features/debugger/__tests__/memoryState.test.ts && git commit -m "feat(debugger): keep JVM memory snapshots per debug session"`

---

### Task 8: Tab Memory, action và chuỗi hiển thị

**Files:**

- Create: `src/features/debugger/memory/MemoryView.tsx`, `src/features/debugger/memory/MemoryView.module.css`
- Modify: `src/features/debugger/ui/DebugToolWindow.tsx` (`type Tab` dòng 106, mảng tab ~174–179, panel ~232), `src/features/debugger/actions.ts`, `src/platform/locales/text/en.json`, `src/platform/locales/text/zh.json`
- Test: `src/features/debugger/__tests__/memoryView.test.tsx`, `src/features/debugger/__tests__/toolWindow.test.tsx`

**Interfaces:**

- Consumes: Task 7; `sessionSupports("jvmMemory", session)`; `List` từ `src/ui/List.tsx`; `IconButton`, `Input`, `Checkbox` từ `src/ui`.
- Produces: `export function MemoryView({ session }: { session: DebugSession })`; action `debug.memory.refresh` (title "Refresh Memory View", category "Debug", icon `refresh`, `when: "debugSessionActive"`, không phím mặc định, chạy `refreshMemory` cho phiên đang chọn).

Hành vi:

- `type Tab = "variables" | "console" | "memory"`; tab Memory chỉ hiện khi `sessionSupports("jvmMemory", active)`. Mở tab lần đầu mà chưa có snapshot → tự gọi `refreshMemory`. Không tự làm mới ở mỗi lần dừng.
- Thanh công cụ: nút Refresh (action), ô lọc, checkbox "Changed only". Cột: Class (kèm module mờ), Count, Diff, Shallow Size; bấm tiêu đề cột đổi sắp xếp (`aria-sort`). Dòng `ambiguous` có chú thích "Loaded by more than one class loader".
- Chân bảng: tổng và nguồn số liệu. Banner khi `isOutdated`. Trạng thái `unavailable` hiện văn bản theo `reason.kind`. Lỗi hiện dưới thanh công cụ và giữ snapshot cũ.

Chuỗi (en → zh), thêm cả hai file:

| en                                                                                                      | zh                                                                                        |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Memory                                                                                                  | 内存                                                                                      |
| Refresh Memory View                                                                                     | 刷新内存视图                                                                              |
| Filter classes                                                                                          | 筛选类                                                                                    |
| Changed only                                                                                            | 仅显示有变化的                                                                            |
| Class                                                                                                   | 类                                                                                        |
| Count                                                                                                   | 数量                                                                                      |
| Diff                                                                                                    | 差异                                                                                      |
| Shallow Size                                                                                            | 浅层大小                                                                                  |
| {n} classes · {m} objects · {size}                                                                      | {n} 个类 · {m} 个对象 · {size}                                                            |
| Counts include objects that are unreachable but not yet collected.                                      | 计数包含已不可达但尚未回收的对象。                                                        |
| Taken before the last stop. Refresh to update.                                                          | 这是上次暂停之前获取的数据。刷新以更新。                                                  |
| Loaded by more than one class loader                                                                    | 由多个类加载器加载                                                                        |
| Memory view works for programs the IDE launches.                                                        | 内存视图仅适用于由 IDE 启动的程序。                                                       |
| Memory view is not available on this platform yet.                                                      | 此平台暂不支持内存视图。                                                                  |
| Could not find the program's JVM process.                                                               | 找不到程序的 JVM 进程。                                                                   |
| The JVM does not accept attach requests. Restart the debug session without -XX:+DisableAttachMechanism. | JVM 不接受 attach 请求。请在不使用 -XX:+DisableAttachMechanism 的情况下重新启动调试会话。 |
| JDK {v} cannot report memory while suspended. Resume the program, then refresh.                         | JDK {v} 在暂停时无法报告内存。请继续运行程序后再刷新。                                    |
| The program has exited.                                                                                 | 程序已退出。                                                                              |
| The JVM did not answer within 10 seconds.                                                               | JVM 在 10 秒内没有响应。                                                                  |

Placeholder theo cách catalog đang dùng (`tx` với `{n}`, xem các khoá như `"Branch '{n}' already exists"`). `java_major == 0` → dùng biến thể "This JDK cannot report memory while suspended. Resume the program, then refresh." / "此 JDK 在暂停时无法报告内存。请继续运行程序后再刷新。".

- [ ] **Step 1: Viết test thất bại**:

```ts
// toolWindow.test.tsx
it("shows the Memory tab only for sessions with jvmMemory", ...)   // caps { jvmMemory: true } → có tab "Memory"; false → không
// memoryView.test.tsx
it("loads a snapshot when the tab first opens", ...)               // commands.debugJvmMemoryClasses được gọi 1 lần
it("renders rows with formatted size and delta", ...)              // "Heap$Live", "1,000,000", "15.3 MB", "+3"
it("explains why memory is unavailable", ...)                      // reason { kind: "unsafeWhileSuspended", javaMajor: 11 } → "JDK 11 cannot report memory while suspended…"
it("marks the snapshot outdated after another stop", ...)          // tăng stopSeq → banner hiện
it("filters and toggles changed only", ...)
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `pnpm vitest run src/features/debugger/__tests__/memoryView.test.tsx src/features/debugger/__tests__/toolWindow.test.tsx` → FAIL.
- [ ] **Step 3: Cài đặt** view, tab, action, chuỗi. Dùng token trong `src/styles/tokens.css`; số cột canh phải với `font-variant-numeric: tabular-nums`.
- [ ] **Step 4: Chạy lại**: hai lệnh vitest trên → PASS; `pnpm vitest run src/platform/locales` (gồm `textCatalog.test.ts`) → PASS; `pnpm typecheck` → 0 lỗi.
- [ ] **Step 5: Commit**: `git add src/features/debugger/memory src/features/debugger/ui/DebugToolWindow.tsx src/features/debugger/actions.ts src/platform/locales/text/en.json src/platform/locales/text/zh.json src/features/debugger/__tests__/memoryView.test.tsx src/features/debugger/__tests__/toolWindow.test.tsx && git commit -m "feat(debugger): add the Memory tab with the JVM class table"`

---

### Task 9: Smoke, kiểm tra toàn bộ và xác minh trong app

**Files:**

- Modify: `smoke/debug.test.ts` (kiểu `CASES` ~dòng 40–92, hàm `smoke` ~205–250)

**Interfaces:**

- Consumes: `commands.debugJvmMemoryClasses` (Task 6).

- [ ] **Step 1: Thêm vào smoke**: trường tuỳ chọn `memory?: { className: string; instances: number }`; java `{ className: "com.example.orders.OrderBook", instances: 1 }`, kotlin `{ className: "com.example.library.Book", instances: 3 }`. Sau khi kiểm `evaluate`: gọi `debugJvmMemoryClasses(s.id)`; nếu `status === "ready"` thì dòng `className` có `instances` đúng bằng giá trị; nếu `unavailable` thì chỉ chấp nhận `reason.kind === "unsafeWhileSuspended"` với `javaMajor < 17` (cổng an toàn), mọi trường hợp khác là lỗi kèm `shown()`.
- [ ] **Step 2: Chạy smoke**: `cargo build -p ide-host --bin openidea-server`, rồi `pnpm smoke smoke/debug.test.ts -t java` và `pnpm smoke smoke/debug.test.ts -t kotlin` → PASS.
- [ ] **Step 3: Kiểm tra như CI** (từng lệnh một): `cargo fmt --all --check`; `cargo clippy --workspace --all-targets -- -D warnings`; `cargo nextest run --workspace`; `pnpm typecheck`; `pnpm lint`; `pnpm format:check`; `pnpm knip`; `pnpm test`; `pnpm build`. Mọi lệnh → 0 lỗi.
- [ ] **Step 4: Xác minh trong app** bằng skill `verify` (Tauri MCP): mở `fixtures/java-app`, đặt breakpoint ở dòng "Set a breakpoint here", Debug, mở tab Memory → thấy `com.example.orders.OrderBook` = 1; Resume rồi dừng lại → banner "Taken before the last stop"; Refresh → cột Diff có giá trị. Chụp ảnh tab Memory ở theme sáng và tối. Lặp với `fixtures/kotlin-gradle` (`com.example.library.Book` = 3).
- [ ] **Step 5: Commit và PR**: `git add smoke/debug.test.ts && git commit -m "feat(debugger): smoke-test the JVM Memory view"`; mở PR theo `.github/pull_request_template.md`, mô tả ngắn, `Closes #N`, mục **How it was verified** gồm các lệnh ở Step 2–3 và ảnh chụp ở Step 4.

> Ghi chú khi thực thi: Step 1–3 đã xong (commit `a1bea50f`; smoke kotlin chưa có bước memory vì fixture đi qua Gradle attach). Step 4–5 chuyển sang Task 14, sau khi Task 10–13 mở rộng sang phiên attach.

---

### Task 10: Tìm JVM theo cổng JDWP trong `ide-jvm-attach`

**Files:**

- Modify: `crates/ide-jvm-attach/src/socket.rs` (tách phần gửi thao tác: `jcmd` gửi thao tác `jcmd`, hàm mới gửi `agentProperties`), `crates/ide-jvm-attach/src/lib.rs`
- Create: `crates/ide-jvm-attach/src/properties.rs`, `crates/ide-jvm-attach/src/discover.rs`
- Test: các file trên + `crates/ide-jvm-attach/tests/real_jvm.rs`

**Interfaces:**

- Consumes: Task 2 (`temp_dir`, `has_listener`, kiểm tra quyền/peer uid, deadline).
- Produces:

```rust
pub fn agent_properties(pid: u32, timeout: Duration) -> Result<HashMap<String, String>, AttachError> // thao tác attach v1 "agentProperties", không tham số
pub fn parse_properties(text: &str) -> HashMap<String, String>   // định dạng java.util.Properties.store: '#' chú thích, key=value, \: \= \\ \t \n \r \f \uXXXX
pub fn jdwp_port(props: &HashMap<String, String>) -> Option<u16> // "sun.jdwp.listenerAddress": số sau dấu ':' cuối ("dt_socket:64390", "127.0.0.1:5005")
pub fn find_jvm_by_jdwp_port(port: u16, per_socket: Duration, budget: Duration) -> Option<u32> // unix; ngoài unix → None
```

Quét `temp_dir()` lấy tên `.java_pid<số>`, chỉ hỏi socket qua được các kiểm tra của `has_listener` (owner, quyền, không phải symlink, peer uid). Hỏi song song (mỗi socket một thread), trả pid đầu tiên có `jdwp_port == Some(port)`, không chờ quá `budget` kể cả khi có socket không trả lời. Để test được, tách bản nhận thư mục: `pub(crate) fn find_in(dir: &Path, port, per_socket, budget)`.

- [ ] **Step 1: Viết test thất bại:**

```rust
#[test] fn parses_store_format_with_escapes()       // "#c\nsun.jdwp.listenerAddress=dt_socket\\:64390\nk\\=x=a\\\\b\nu=\\u0041" → listenerAddress "dt_socket:64390", "k=x" → "a\\b", "u" → "A"
#[test] fn jdwp_port_forms()                         // dt_socket:64390 → 64390; 127.0.0.1:5005 → 5005; thiếu → None; "dt_socket:abc" → None; ":0" → None
#[test] fn scan_matches_port_not_first_listener()    // hai server UNIX giả trong thư mục tạm: pid 111 trả cổng 5005, pid 222 trả cổng 6006; find_in(dir, 6006) → Some(222)
#[test] fn scan_skips_silent_listener_within_budget() // pid 111 nhận kết nối nhưng không trả lời, pid 222 trả cổng 6006; find_in(dir, 6006, 1 s, 2 s) → Some(222) và mất < 2.5 s
#[test] fn scan_ignores_non_matching_names()         // ".java_pidabc", ".java_pid" , "java_pid12" bị bỏ qua
// real_jvm.rs (ignored, cần OPENIDEA_TEST_JAVA): java -XX:+StartAttachListener -agentlib:jdwp=…,suspend=y,address=127.0.0.1:0 -version; đọc cổng từ dòng "Listening for transport dt_socket at address: N"; find_jvm_by_jdwp_port(N, 1 s, 2 s) == Some(child.id())
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo +1.96 test -p ide-jvm-attach` → FAIL.
- [ ] **Step 3: Cài đặt** như Interfaces. Thread hỏi socket chạy độc lập; luồng chính nhận kết quả qua channel với `recv_timeout` theo deadline của `budget`, thread chậm tự kết thúc theo deadline của chính nó.
- [ ] **Step 4: Chạy lại**: `cargo +1.96 test -p ide-jvm-attach`, và `OPENIDEA_TEST_JAVA=<jdk 21>/bin/java cargo +1.96 test -p ide-jvm-attach --test real_jvm -- --ignored` → PASS.
- [ ] **Step 5: Commit**: `feat(debugger): find a local JVM by its JDWP port`

---

### Task 11: Phiên attach trong `ide-dap`

**Files:**

- Modify: `crates/ide-dap/src/lib.rs` (đường khởi động phiên trước khi gửi `attach`, ~dòng 886; `capabilities()`), `crates/ide-dap/src/jvm_memory.rs`, `crates/ide-dap/src/tests.rs`

**Interfaces:**

- Consumes: Task 10 (`find_jvm_by_jdwp_port`), Task 4–5 (`jvm_pid`, `take_snapshot`, `AttachProbe`).
- Produces:

```rust
pub(crate) fn local_jdwp_port(arguments: &Value) -> Option<u16> // "hostName" là 127.0.0.1 / localhost / ::1 / [::1] (hoặc thiếu) và "port" là số hay chuỗi số khác 0
JvmMemoryUnavailable::AttachedJvmNotFound   // thay NotLaunchedByIde; TS kind "attachedJvmNotFound"
DebugCapabilities.jvm_memory = JVM_MEMORY_ADAPTERS.contains(adapter)   // mọi nền tảng, mọi request: tab luôn hiện, lý do nằm trong kết quả
```

- [ ] **Step 1: Viết test thất bại:**

```rust
#[test] fn local_jdwp_port_accepts_loopback_only()   // 127.0.0.1/localhost/::1 + 5005 → Some(5005); port "5005" → Some(5005); host "10.0.0.5" → None; port 0 → None
#[tokio::test] async fn remote_host_is_not_scanned()  // harness attach java-debug hostName "10.0.0.5": jvm_pid vẫn 0; jvm_memory_classes → Unavailable(AttachedJvmNotFound)
#[tokio::test] async fn attach_session_reports_capability() // capabilities().jvm_memory == true cho java-debug attach và kotlin attach; false cho adapter khác
#[test] fn attach_with_pid_takes_snapshot()          // take_snapshot với probe giả, cây [pid] của phiên attach → Ready
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo +1.96 test -p ide-dap jvm_memory` → FAIL.
- [ ] **Step 3: Cài đặt.**
  1. Trong đường khởi động, ngay trước khi gửi request `attach` (và **trước** khi Kotlin `StartupRelay` đổi `hostName`/`port`): nếu adapter thuộc `JVM_MEMORY_ADAPTERS`, `s.request == "attach"`, `cfg!(unix)` và `local_jdwp_port(&arguments)` có giá trị → `spawn_blocking(find_jvm_by_jdwp_port(port, 1 s, 2 s))`, lưu vào `jvm_pid` nếu tìm thấy. Lỗi hay không thấy: chỉ `tracing::debug!`, phiên vẫn chạy.
  2. `jvm_memory_classes`: không phải unix → `UnsupportedPlatform`; phiên attach có `jvm_pid == 0` → `AttachedJvmNotFound`; phiên attach có pid → cây là `[jvm_pid]` (không đi qua `debuggee_pid`); phiên launch giữ nguyên Task 5.
  3. Đổi tên biến thể enum, sửa test cũ dùng `NotLaunchedByIde`.
- [ ] **Step 4: Chạy lại**: `cargo +1.96 test -p ide-dap` → PASS; `pnpm gen:bindings`.
- [ ] **Step 5: Commit** (`crates/ide-dap`, `src/bindings.ts`): `feat(debugger): find the JVM of a local JDWP attach session`

---

### Task 12: Thêm listener vào mọi JVM debug qua JDWP agent

**Files:**

- Modify: `src/platform/javaLaunch.ts` (cạnh `JDWP_AGENT`), `src/features/run/javaDebug.ts` (`jdwpLaunch`, `debugWithAgent`), `src/features/run/gradleRun.gradle`, `crates/ide-run/src/tomcat.rs` (~dòng 513–518)
- Test: `src/features/run/java.test.ts`, `src/features/run/gradleRun.test.ts` (hoặc file test đang kiểm `jdwpLaunch` cho từng kênh), test trong `tomcat.rs`

**Interfaces:**

- Produces: `export const ATTACH_LISTENER = "-XX:+StartAttachListener"` và `export function optsOutOfAttach(text: string): boolean` (`/StartAttachListener|DisableAttachMechanism/`) trong `src/platform/javaLaunch.ts`.

Mỗi kênh `jdwpLaunch` đang dùng nhận `ATTACH_LISTENER` đặt **ngay trước** `JDWP_AGENT` trong cùng kênh, trừ khi `optsOutOfAttach` đúng với giá trị hiện có của kênh đó hoặc với VM options của cấu hình:

| Kênh                                  | Hiện tại                                        | Thêm                                                                                                          |
| ------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `java-file` có args                   | `[JDWP_AGENT, …args]`                           | `[ATTACH_LISTENER, JDWP_AGENT, …args]`                                                                        |
| `java-file` không args                | `JDK_JAVA_OPTIONS`                              | `ATTACH_LISTENER JDWP_AGENT`                                                                                  |
| Maven `spring-boot:run`               | `-Dspring-boot.run.jvmArguments`                | như trên                                                                                                      |
| Maven test                            | `maven.surefire.debug` / `maven.failsafe.debug` | như trên                                                                                                      |
| Maven trong JVM của Maven             | `MAVEN_OPTS`                                    | như trên                                                                                                      |
| Gradle ủy quyền (`openidea.run.main`) | init script `gradleRun.gradle`                  | script thêm `-XX:+StartAttachListener` trước agent, trừ khi danh sách `openidea.run.jvmArgs` có cờ tắt        |
| Gradle `--debug-jvm`                  | `--debug-jvm`                                   | `debugWithAgent` gọi `commands.runGradleJvmArgsScript([ATTACH_LISTENER])` và thêm `--init-script <đường dẫn>` |
| Script khác                           | `JAVA_TOOL_OPTIONS`                             | như trên                                                                                                      |
| Tomcat (`tomcat.rs`)                  | `CATALINA_OPTS` khi debug                       | thêm cờ trước agent, trừ khi `vmOptions` hoặc `CATALINA_OPTS` có cờ tắt                                       |

- [ ] **Step 1: Viết test thất bại:** mỗi dòng trong bảng một test kiểm giá trị chính xác sau `jdwpLaunch` (cờ đứng trước agent); `keeps_user_attach_opt_out` (TS: `JAVA_TOOL_OPTIONS="-XX:+DisableAttachMechanism"`, `MAVEN_OPTS="-XX:-StartAttachListener"` → không thêm cờ, agent vẫn thêm); Rust Tomcat: debug → `CATALINA_OPTS` chứa `-XX:+StartAttachListener -agentlib:jdwp`; `vmOptions` có `-XX:+DisableAttachMechanism` → không chứa `StartAttachListener`; test init script Gradle trong `gradleRun.test.ts` nếu file đó kiểm nội dung script.
- [ ] **Step 2: Chạy, xác nhận thất bại**: `pnpm vitest run src/features/run`, `cargo +1.96 test -p ide-run tomcat` → FAIL.
- [ ] **Step 3: Cài đặt** như bảng.
- [ ] **Step 4: Chạy lại** hai lệnh trên → PASS; `pnpm typecheck`.
- [ ] **Step 5: Commit**: `feat(debugger): start the attach listener in JVMs debugged through a JDWP agent`

---

### Task 13: Tab Memory cho mọi phiên JVM và các chỉnh nhỏ

**Files:**

- Modify: `src/features/debugger/memory/MemoryView.tsx`, `src/features/debugger/memory/rows.ts`, `src/platform/locales/text/en.json`, `zh.json`
- Test: `src/features/debugger/__tests__/memoryView.test.tsx`, `memoryRows.test.ts`, `toolWindow.test.tsx`

**Interfaces:**

- Consumes: Task 11 (`attachedJvmNotFound`, capability mới).

- [ ] **Step 1: Viết test thất bại:**
  - `attachedJvmNotFound` → "Memory view needs a JVM on this computer started with -XX:+StartAttachListener. Programs the IDE debugs get it automatically." (bỏ chuỗi "Memory view works for programs the IDE launches." khỏi hai catalog).
  - Phiên attach java-debug có `jvmMemory: true` → tab Memory hiện.
  - `formatDelta(4312) === "+4,312"`, `formatDelta(-1500) === "−1,500"` (cùng cách nhóm số với cột Count).
  - Ở locale zh, tooltip nút Refresh, placeholder và `aria-label` ô lọc, nhãn "Changed only" đều là bản dịch (hiện truyền chuỗi literal không qua `tx`).
- [ ] **Step 2: Chạy, xác nhận thất bại**: `pnpm vitest run src/features/debugger src/platform/locales` → FAIL.
- [ ] **Step 3: Cài đặt.** Bản zh: "Memory 视图需要本机上以 -XX:+StartAttachListener 启动的 JVM。由 IDE 调试的程序会自动添加该选项。"
- [ ] **Step 4: Chạy lại** lệnh trên, `pnpm typecheck`, `pnpm lint`, `pnpm knip` → PASS.
- [ ] **Step 5: Commit**: `feat(debugger): show the Memory tab for every JVM debug session`

---

### Task 14: Smoke, kiểm tra toàn bộ, xác minh trong app và PR

Như Task 9 Step 2–5, với các thay đổi:

- Smoke kotlin bật lại bước memory (`com.example.library.Book` = 3); fixture này đi qua Gradle attach nên là kiểm thử đầu-cuối của Task 10–12.
- Xác minh trong app (bridge `tauri-plugin-mcp-bridge` qua WebSocket, `scratchpad/m1-verify/bridge.mjs`): Java như Task 9; `fixtures/kotlin-gradle` có tab Memory, `Book` = 3, Diff sau Resume; phiên `fixtures/rust-app` không có tab; ảnh zh của tab.
- Issue, push và PR chỉ khi chủ repo đồng ý.
