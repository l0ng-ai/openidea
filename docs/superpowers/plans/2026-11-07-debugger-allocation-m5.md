# Allocation profiling (M5: async-profiler `event=alloc` và `alloc,live`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Với cấu hình chạy JVM (`java …`), người dùng chọn **Profile Allocations** (mọi lần cấp phát, tính bằng byte) hoặc **Profile Live Objects** (chỉ object còn sống khi chương trình dừng), và thấy kết quả trong tool window Profiler đã có: flame graph, call tree, method list, với lá là kiểu được cấp phát.

**Architecture:** `ide-profiler` thêm `ProfileMode` (`Cpu | Allocations | LiveObjects`). Cùng cơ chế `JAVA_TOOL_OPTIONS` + `-agentpath` hiện có (`crates/ide-profiler/src/plan.rs:144-146`), mỗi lần chạy một sự kiện, output `collapsed`: `event=alloc,total` (trọng số là byte ước lượng) hoặc `event=alloc,live` (trọng số là số mẫu). Parser đánh dấu frame lá `…_[i]`/`…_[k]` của profile allocation là `AllocatedType` và ánh xạ nó tới file nguồn theo tên class. Chế độ live thêm `-XX:+StartAttachListener`; khi người dùng bấm Stop, run store gọi hook `beforeStop` của executor, hook này chạy `GC.run` qua `ide-jvm-attach` (M1) trong mọi JVM của cây tiến trình rồi mới gửi tín hiệu dừng, để object đã là rác không còn tính là "live".

**Tech Stack:** Rust 2024 (`ide-profiler`, `ide-jvm-attach`, `ide-run`, `ide-core`), serde + specta (tauri-specta bindings), React + zustand + CSS Modules, vitest. async-profiler ≥ 3.0 do người dùng cài (như hiện nay, app không tải về).

**Spec:** `docs/superpowers/specs/2026-11-07-jvm-debug-link-design.md` (mục 1, 4 hàng Allocation, 11 gạch M5 và dòng `JVMTI.agent_load`, 13, 14, 15, 16, 18). Mục "Sửa spec đề xuất" ở cuối plan thay một số dòng của spec theo Grounding (chưa áp vào spec). Plan M4 (`docs/superpowers/plans/2026-11-07-debugger-heap-m4.md`) không cung cấp interface nào M5 cần: M5 nằm trong tool window Profiler, không dùng editor "Heap".

## Global Constraints

- Mỗi lần chạy đúng một sự kiện, output `collapsed`. **Không** `event=cpu,alloc`: ngoài JFR, async-profiler từ chối nhiều sự kiện, chương trình vẫn chạy và không ghi file (Grounding P3).
- Chuỗi agent, giữ nguyên `start`, `collapsed`, `file=<out>/profile-%p.collapsed` và `quote_opt` của bản CPU:
  - `Cpu`: `event=cpu` (không đổi).
  - `Allocations`: `event=alloc,total` → `Profile.unit = "bytes"`.
  - `LiveObjects`: `event=alloc,live` (**không** `total`: với `live`, `total` cộng kích thước của chính các object được lấy mẫu, 0,55 MB cho 64 MiB giữ lại, sai thang đo) → `Profile.unit = "samples"`.
- Khoảng lấy mẫu: mặc định của async-profiler (512 KiB), không truyền `alloc=` và không có UI chỉnh (đo: 64k không đổi thời gian chạy và độ chính xác ở mức tổng, P8).
- `LiveObjects` cần JDK ≥ 11. Khi đọc được phiên bản (`ide_run::java_cmdline::java_feature_version`) và nó < 11 → `ProfilePrepared::Unsupported`, không chạy. Không đọc được → vẫn chạy; nếu không có mẫu, lỗi "no profile" nêu yêu cầu JDK 11.
- `LiveObjects` thêm `-XX:+StartAttachListener` **trước** agent trong `JAVA_TOOL_OPTIONS`, trừ khi `ide_jvm_attach::wants_listener_flag(<JAVA_TOOL_OPTIONS hiện có> + " " + <args của config>)` trả `false`. Không bao giờ gửi `SIGQUIT` hay tạo `.attach_pid<pid>`.
- Trước Stop (chỉ `LiveObjects`, chỉ lần Stop đầu): `GC.run` qua `ide_jvm_attach::jcmd` cho mỗi pid trong cây tiến trình có listener, tuần tự, timeout 5 s mỗi JVM. Frontend chờ hook tối đa 12 s; lần Stop thứ hai không chờ hook.
- Frame lá của profile allocation có hậu tố `_[i]` hoặc `_[k]` là `ProfileFrameKind::AllocatedType` (tên đã bỏ hậu tố). Ở profile CPU, `_[k]` vẫn là frame kernel kiểu `Code` như hiện nay.
- Windows: `Unsupported` như bản CPU (async-profiler không chạy trên Windows). Chỉ cấu hình có chương trình `java` (như bản CPU); Gradle/Maven/Tomcat không có executor allocation.
- IPC: `IdeResult<T>`, camelCase. `profiler_prepare` thêm tham số `mode`; lệnh mới `profiler_gc_before_stop`. Đăng ký ở `src-tauri/src/commands/{profiler.rs,mod.rs}` (Profiler chưa có trong `ide-host`, M5 giữ nguyên). Chạy `pnpm gen:bindings`, commit `src/bindings.ts`.
- Chuỗi hiển thị vào cả `src/platform/locales/text/en.json` và `zh.json`; title action có bản zh khác en. CSS Modules + tokens, không hex (token mới chỉ ở `src/styles/tokens.css`), icon từ `src/ui/icons.tsx`. Không import feature khác (profiler ↔ run chỉ qua `contributions.ts`).
- Không đưa mã spike, jar/dylib async-profiler hay output thật vào repo. Test JVM thật để `#[ignore]`, đọc `OPENIDEA_TEST_JAVA` (JDK ≥ 11) và `ASYNC_PROFILER_HOME`.
- Một nhánh `feat/debugger-jvm-memory`, một PR chung ở cuối mọi mốc: plan này **không** tạo issue hay PR. Commit: `feat(profiler): …` (Task 1: `refactor(core): …`), stage từng đường dẫn, không trailer `Co-Authored-By`, không stage `openspec/` hay `*.sh`.

## Grounding

Mã spike (ngoài repo): `scratchpad/m5-spike/` — `java/Alloc.java` (debuggee: `garbage()` cấp phát 512 MiB `byte[1024]` bỏ ngay, `retained()` giữ 64 MiB `byte[4096]` trong list static, `strings()` 200k chuỗi; chế độ `exit`, `wait` (ngủ sau khi làm xong) và `pause` (gọi `pause()` giữa hai nửa)), `probe.py` và `probe2.py` (khởi động JVM với agent, JDWP qua `research-A/exp/jdwp.py`, attach qua `research-A/exp/attach.py`). async-profiler 4.6 (2026-10-19) và 3.0 bản macOS tải vào `m5-spike/dl/`; 2.9 có bố cục `build/` mà `async_profiler_lib` không tìm, nên app thực tế chỉ hỗ trợ ≥ 3.0. JDK 8 (Zulu 8.0.512), 11.0.29, 17.0.21, 21.0.4, 25.0.3, macOS arm64.

Giả định rủi ro nhất: "output `collapsed` của `event=alloc` gắn được vào cây gọi hiện có với trọng số đúng (byte), và `live` cho đúng tập object còn sống". Các câu hỏi:

**P1. Định dạng frame và trọng số của `event=alloc,collapsed` trên 11/21/25 (4.6 và 3.0 giống nhau)?** Lá là kiểu được cấp phát, tên Java dạng chấm, hậu tố `_[i]`; frame method dạng `/` không hậu tố; số cuối dòng là số mẫu:

```
11: 1018 Alloc.main;Alloc.garbage;byte[]_[i]
    106  Alloc.main;Alloc.retained;byte[]_[i]
    8    Alloc.main;Alloc.strings;java/lang/StringBuilder.toString;java/lang/StringLatin1.newString;java.lang.String_[i]
21: 1 Alloc.main;Alloc.retained;java/util/ArrayList.add;…;java/util/Arrays.copyOf;java.lang.Object[]_[i]
JDK 8: lá `byte[]_[k]` (ngoài TLAB) bên cạnh `byte[]_[i]`; có stack chỉ gồm một frame kiểu: `java.lang.String_[i] 524287`
```

**P2. `total` có cho số byte gần với thật không?** Có. Thật: `garbage` 512 MiB = 536,9 MB, `retained` 64 MiB = 67,1 MB:

```
4.6 event=alloc,total  11: garbage 541064184  retained 61865866 | 21: 548928489 / 67108736 | 25: 594541458 / 63963014
3.0 event=alloc,total  11: 547879915 / 71827319 | 21: 551549924 / 63963014 | 25: 540539897 / 60293005
JDK 8: 491245496 / 64429568 ; JDK 17: 549977063 / 61341579
các lần chạy probe (SIGINT/SIGTERM/debug): garbage 515–564 MB, retained 53–80 MB
```

Sai số mức site lớn: garbage −9 % … +11 %, retained −21 % … +19 %.

**P3. Hai sự kiện trong một lần chạy `collapsed`?** Không, cả 4.6 và 3.0:

```
event=cpu,alloc,collapsed → "[ERROR] Only JFR output supports multiple events", rc 0, không có file
event=cpu,alloc,jfr       → có .jfr; jfrconv --alloc --total -o collapsed đổi được (551 ms, cần Java; 3.0 dùng lib/converter.jar thay bin/jfrconv)
```

**P4. `live` hỗ trợ ở đâu và có đúng không?** JDK ≥ 11; JDK 8: `[ERROR] 'live' option is supported on OpenJDK 11+`, chương trình chạy, không có file. Nếu không có GC trước khi dump, rác vẫn tính là live (đếm mẫu, `wait` rồi SIGINT):

```
no_gc   21: retained 126, strings 37, garbage 2 | 11: retained 123, garbage 73, strings 36 | 25: retained 130, garbage 128, strings 45
GC.run qua attach (rc 0) rồi SIGINT:  21: retained 136 | 11: retained 148 | 25: retained 130        (không còn mẫu rác)
live,total 21: retained 546896, garbage 4160  (≈ 133 object × 4096 B: kích thước object được lấy mẫu, không phải ước lượng byte)
JAVA_TOOL_OPTIONS="-XX:+StartAttachListener -agentpath:…=start,event=alloc,live,collapsed,file=…": GC.run 8 ms (21) / 11 ms (11), file chỉ còn retained
```

Rác (`garbage` + `strings`) chiếm 15–57 % mẫu live khi không GC. 124–148 mẫu × 512 KiB ≈ 62–74 MiB so với 64 MiB thật.

**P5. Khi nào agent ghi file?** (`event=alloc,total`, chế độ `wait`)

```
21/11/25: SIGINT rc 130 → có file | SIGTERM rc 143 → có file | SIGKILL rc -9 → NO_FILE | JDWP VirtualMachine.Exit rc 0 → NO_FILE
```

Stop của run store là SIGINT rồi chờ (`crates/ide-run/src/process.rs:632-686`): có file. Stop lần hai (SIGKILL): mất profile.

**P6. Agent nạp lúc launch có sống qua breakpoint của phiên debug không?** Có. JDWP + agent, dừng `SUSPEND_ALL` ở `Alloc.pause` 3 s rồi resume:

```
21: garbage 546307054, afterPause 278396397, retained 57671570 | 11: 537918462 / 270007805 | 25: 515374121 / 262667787
SIGINT khi đang dừng: JVM còn sống sau 3 s, chưa có file; VirtualMachine.Dispose → thoát sau 447 ms (21) / 391 ms (11), có file
SIGTERM khi đang dừng (java-debug terminate = Process.destroy): như trên, 445 ms (21) / 393 ms (25), có file
```

java-debug `DebugSession.terminate()`: `vm.process().destroy()` khi có process, ngược lại `vm.exit(0)` (launch `runInTerminal`) → không có file theo P5.

**P7. Lấy profile giữa chừng khi VM đang dừng ở breakpoint?** Không:

```
asprof dump (nạp lại agent qua attach) khi SUSPEND_ALL: 21/25/11 → TIMEOUT 15 s; file chỉ được ghi sau resume
đang chạy, lệnh attach thô `load <lib> true dump,collapsed,total,file=…`: rc 0, 5 ms (21) / 9 ms (11), profile tiếp tục ghi đến khi thoát
```

**P8. Chi phí?** Thời gian chạy `Alloc` (JDK 21, 5 lần, ms): không agent 123–142; `alloc,total` 319–351; `alloc=64k,total` 308–316; `alloc=8k,total` 358–384; `alloc,live` 303–340. Phần thêm chủ yếu là nạp agent (~180 ms cố định).

**Quyết định từ Grounding:**

1. Hai chế độ, chọn lúc launch (P3). JFR + chuyển đổi (một lần chạy có cả CPU và allocation như IntelliJ) bị loại: cần Java để chạy converter, converter khác nhau giữa 3.x và 4.x, hoặc cần parser JFR trong Rust.
2. `Allocations` dùng `total` (byte, P2). Object lớn hơn khoảng lấy mẫu được tính đúng kích thước, khác với `số mẫu × 512 KiB`.
3. `LiveObjects` đếm mẫu (P4); `GC.run` trước Stop là điều kiện để kết quả có nghĩa; chương trình tự thoát hoặc không có listener → snapshot mang cảnh báo.
4. **Không làm allocation trong phiên debug ở M5** (xem "Không phải mục tiêu").

## Không phải mục tiêu M5

- **Ghi allocation trong phiên debug.** Kỹ thuật làm được một phần: agent nạp lúc launch sống qua breakpoint (P6), và Stop của java-debug launch (SIGTERM + detach) vẫn ghi file. Nhưng (a) không xem được ở breakpoint: dump khi VM đang dừng treo trên 11/21/25 (P7), nên kết quả chỉ có khi phiên kết thúc, giá trị không hơn Profile Allocations; (b) launch `runInTerminal` kết thúc bằng `VirtualMachine.Exit` và mất profile (P5); (c) phải thêm agent vào `vmArgs` của java-debug và vào `start_kotlin_debuggee`, chạm đường launch debug mà spec coi là anti-goal nếu hỏng. Xem allocation tại breakpoint cần agent JVMTI `SampledObjectAlloc` riêng như spec §11 ghi; để sau. Đường đi đã đo cho bản sau ghi ở "Sửa spec đề xuất" S2.
- JFR, nhiều sự kiện một lần chạy, `nativemem`, `lock` (P3).
- UI chỉnh khoảng lấy mẫu, so sánh hai profile allocation.
- Remote development và container: Profiler hiện chỉ chạy cục bộ (`containerExecutorBlocked`, không có op trong `ide-host`); M5 giữ nguyên.
- Gradle/Maven/Tomcat: `prepare` chỉ nhận chương trình `java`, như bản CPU.

## Review Focus

1. **Chương trình Live Objects tự kết thúc** (không ai bấm Stop) hoặc người dùng đã tắt attach (`-XX:+DisableAttachMechanism`): không có `GC.run`, rác hiện như object sống (P4: tới 57 % mẫu). Snapshot phải mang cảnh báo, không im lặng. Test ở Task 6 (`live snapshot of a run that ended by itself carries the notice`, `live snapshot without a collected JVM carries the notice`).
2. **Bấm Stop lần hai trong lúc `GC.run` đang chạy** (heap lớn, GC lâu): phải dừng ngay, không chờ hook; lần ba giết bằng SIGKILL như cũ. Test ở Task 5 (`second stop while beforeStop is pending stops at once`).
3. **`GC.run` không trả lời** (JVM treo, listener kẹt): Stop vẫn xảy ra sau tối đa 12 s, backend bỏ qua JVM đó sau 5 s và thử JVM tiếp theo. Test ở Task 4 (`gc_each_continues_after_failure`) và Task 5 (`beforeStop that never settles still stops after the cap`).
4. **Profile Live Objects với JDK 8**: async-profiler chỉ in lỗi và chương trình chạy bình thường không có profile. Biết phiên bản → từ chối trước khi chạy; không biết → thông báo "no profile" nêu JDK 11. Test ở Task 3 (`live_objects_refuses_jdk8`) và Task 2 (`live_without_samples_mentions_jdk11`).
5. **Kiểu của người dùng là lá** (`com.example.orders.Order`, `com.x.App$Inner[]`): double-click mở `Order.java` / `App.java`; `byte[]` không mở gì; profile CPU có lá `_[k]` (kernel) không bị đổi thành kiểu. Test ở Task 2 (`allocated_types_map_to_outer_class_source`, `cpu_mode_keeps_kernel_leaf_as_code`).

---

### Task 0: Nhánh và plan

**Files:** `docs/superpowers/plans/2026-11-07-debugger-allocation-m5.md`

- [ ] **Step 1: Làm tiếp trên nhánh** `feat/debugger-jvm-memory` trong worktree `../openidea-jvm-memory`. M5 chỉ cần mã M1 đã có (`ide-jvm-attach`); không phụ thuộc M2/M4. Không tạo issue, không push.
- [ ] **Step 2: Commit plan**: `git add docs/superpowers/plans/2026-11-07-debugger-allocation-m5.md && git commit -m "feat(profiler): plan allocation profiling (M5)"`.

---

### Task 1: `process_tree` vào `ide-core`

`ide-dap` có `session::process_tree` (`crates/ide-dap/src/session.rs:343-367`, `pub(crate)`); Task 4 cần nó ở `src-tauri`. Chuyển, không đổi hành vi.

**Files:**

- Modify: `crates/ide-core/src/process.rs` (thêm hàm + test), `crates/ide-dap/src/session.rs` (xoá hàm, gọi `ide_core::process::process_tree`), `crates/ide-dap/src/jvm_memory/mod.rs:234-243` (`pid_tree` gọi hàm mới)

**Interfaces:**

- Produces: `#[cfg(unix)] pub fn process_tree(pid: i32) -> Vec<i32>` trong `ide_core::process` — `pid` trước, rồi con cháu theo BFS từ `ps -A -o pid=,ppid=`; `ps` lỗi → `vec![pid]`.

- [ ] **Step 1: Viết test thất bại** `process_tree_lists_the_child_of_a_shell` trong `ide-core/src/process.rs` (`#[cfg(unix)]`): spawn `sh -c "sleep 5 & wait"`, chờ tới khi `process_tree(sh_pid).len() >= 2` (tối đa 2 s), assert phần tử đầu là `sh_pid` và có một pid khác; kill nhóm bằng `kill_tree`.
- [ ] **Step 2: Chạy** `cargo nextest run -p ide-core process_tree` → FAIL (không có hàm).
- [ ] **Step 3: Chuyển hàm** nguyên văn từ `ide-dap`, đổi `pub(crate)` thành `pub`; sửa hai chỗ gọi trong `ide-dap`.
- [ ] **Step 4: Chạy** `cargo nextest run -p ide-core process_tree` và `cargo nextest run -p ide-dap` → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-core/src/process.rs crates/ide-dap/src/session.rs crates/ide-dap/src/jvm_memory/mod.rs && git commit -m "refactor(core): share the process tree lookup"`.

---

### Task 2: Mô hình profile allocation: `ProfileMode`, frame kiểu, parser, ánh xạ nguồn

**Files:**

- Modify: `crates/ide-profiler/src/lib.rs` (kiểu IPC, `collect`), `crates/ide-profiler/src/tree.rs` (`FrameKey.kind`), `crates/ide-profiler/src/formats.rs` (`add_folded`), `crates/ide-profiler/src/jvm.rs` (`resolve_sources`), `crates/ide-profiler/src/plan.rs` (chỉ thêm `mode: ProfileMode::Cpu` vào hai `ProfileSpec::Folded` hiện có để biên dịch), `src/bindings.ts` (sinh lại), `src/features/profiler/profiler.test.ts` (fixture `Profile` thêm `mode: "cpu"`, mỗi frame `kind: "code"`, để `pnpm typecheck` qua)

**Interfaces:**

- Produces (serde camelCase, `specta::Type`):

```rust
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ProfileMode { #[default] Cpu, Allocations, LiveObjects }

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ProfileFrameKind { #[default] Code, AllocatedType }

pub struct ProfileFrame { pub name: String, pub file: Option<IpcPath>, pub line: Option<u32>, pub kind: ProfileFrameKind }
pub struct Profile { /* như cũ */ pub mode: ProfileMode }          // unit: "ms" | "samples" | "bytes"
ProfileSpec::Folded { profiler, dir, ext, base, jvm_root, mode: ProfileMode }
// tree.rs
pub(crate) struct FrameKey { pub name: String, pub file: Option<PathBuf>, pub line: Option<u32>, pub kind: ProfileFrameKind }
impl FrameKey { pub fn named(..) -> Self /* Code */; pub fn allocated(name: impl Into<String>) -> Self }
impl TreeBuilder { pub fn finish(self, profiler: &str, unit: &str, mode: ProfileMode) -> Profile }
// formats.rs
pub(crate) fn add_folded(b: &mut TreeBuilder, text: &str, base: &Path, allocation_leaf: bool)
```

`collect` cho `Folded`: `unit = if mode == Allocations { "bytes" } else { "samples" }`, `allocation_leaf = mode != Cpu`. `CpuProfiles` và `Perf` dùng `ProfileMode::Cpu`. Lỗi "nothing recorded" của `LiveObjects` thêm câu: `Profiling live objects needs JDK 11 or newer.`

- [ ] **Step 1: Viết test thất bại** trong `formats.rs`:

```rust
#[test]
fn allocation_leaves_become_types() {
    let mut b = TreeBuilder::new();
    let text = "Alloc.main;Alloc.garbage;byte[]_[i] 541064184\n\
                Alloc.main;Alloc.strings;java/lang/StringBuilder.toString;java.lang.String_[i] 6815731\n\
                Alloc.main;Alloc.retained;byte[]_[k] 4112\n\
                java.lang.String_[i] 524287\n";
    add_folded(&mut b, text, Path::new("/p"), true);
    let p = b.finish("async-profiler", "bytes", ProfileMode::Allocations);
    assert_eq!(p.total, 541064184.0 + 6815731.0 + 4112.0 + 524287.0);
    let kind = |n: &str| p.frames.iter().find(|f| f.name == n).unwrap().kind;
    assert_eq!(kind("byte[]"), ProfileFrameKind::AllocatedType);
    assert_eq!(kind("java.lang.String"), ProfileFrameKind::AllocatedType);
    assert_eq!(kind("Alloc.garbage"), ProfileFrameKind::Code);
    assert_eq!(kind("java/lang/StringBuilder.toString"), ProfileFrameKind::Code);
    assert_eq!(p.frames.iter().filter(|f| f.name == "byte[]").count(), 1, "_[i] and _[k] are one type");
}

#[test]
fn cpu_mode_keeps_kernel_leaf_as_code() {
    let mut b = TreeBuilder::new();
    add_folded(&mut b, "java/lang/Thread.run;__psynch_cvwait_[k] 3\n", Path::new("/p"), false);
    let p = b.finish("async-profiler", "samples", ProfileMode::Cpu);
    assert!(p.frames.iter().all(|f| f.kind == ProfileFrameKind::Code));
    assert!(p.frames.iter().any(|f| f.name == "__psynch_cvwait"));
}
```

Trong `jvm.rs`:

```rust
#[test]
fn allocated_types_map_to_outer_class_source() {
    // src/main/java/com/x/App.java và src/main/java/Alloc.java; frame kiểu
    // "com.x.App$Inner[]" → App.java, "com.x.App" → App.java, "Alloc" → Alloc.java,
    // "byte[]" và "java.lang.String" → None; frame Code "com.x.App.work" → App.java như cũ.
}
```

Trong `lib.rs`: `live_without_samples_mentions_jdk11` (`collect` với `Folded { mode: LiveObjects }` trên thư mục rỗng → `Err` có chuỗi `JDK 11`) và `allocation_profile_is_in_bytes` (thư mục có `profile-1.collapsed` một dòng `A.main;byte[]_[i] 1024` → `unit == "bytes"`, `mode == Allocations`, `total == 1024.0`).

- [ ] **Step 2: Chạy** `cargo nextest run -p ide-profiler` → FAIL (biên dịch).
- [ ] **Step 3: Cài đặt.** `add_folded`: chỉ khi `allocation_leaf` và là frame cuối, chuỗi thô kết thúc bằng `_[i]` hoặc `_[k]` → `FrameKey::allocated(<bỏ hậu tố>)`; mọi frame khác qua `folded_frame` như cũ. `jvm::resolve_sources`: frame `AllocatedType` dùng `type_key(name)`: bỏ mọi `[]` ở cuối, cắt trước `$`, thay `.` bằng `/`; frame `Code` dùng `class_key` như cũ. Cập nhật test có sẵn (`finish(…, ProfileMode::Cpu)`, `add_folded(…, false)`).
- [ ] **Step 4: Chạy** `cargo nextest run -p ide-profiler` → PASS; `pnpm gen:bindings && pnpm typecheck` → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-profiler/src/{lib,tree,formats,jvm,plan}.rs src/bindings.ts src/features/profiler/profiler.test.ts && git commit -m "feat(profiler): read async-profiler allocation profiles into the call tree"`.

---

### Task 3: Kế hoạch chạy theo chế độ trong `plan.rs`

**Files:**

- Modify: `crates/ide-profiler/src/plan.rs`, `crates/ide-profiler/Cargo.toml` (`ide-jvm-attach.workspace = true`), `src-tauri/src/commands/profiler.rs` (`profiler_prepare` nhận `mode`), `src/bindings.ts` (sinh lại), `src/features/profiler/executor.ts` (lời gọi hiện có truyền `"cpu"`)

**Interfaces:**

- Consumes: `ProfileMode` (Task 2); `ide_jvm_attach::wants_listener_flag(&str) -> bool`; `ide_run::java_cmdline::java_feature_version(&Path) -> Option<u32>`; `ide_run::which::find_executable`.
- Produces: `pub fn prepare(root: &Path, config: &RunConfig, out: &Path, mode: ProfileMode) -> ProfilePrepared`; IPC `profiler_prepare(window: Window, state: State<'_, AppState>, config: RunConfig, mode: ProfileMode) -> IdeResult<ProfilePrepared>`.

- [ ] **Step 1: Viết test thất bại** trong `plan.rs` (dùng lại cách dựng `ASYNC_PROFILER_HOME` giả của `jvm_without_async_profiler_points_to_releases`; tách helper `fake_async_profiler(dir) -> PathBuf`):
  - `jvm_allocations_records_bytes`: `Allocations` → `JAVA_TOOL_OPTIONS` chứa `=start,event=alloc,total,collapsed,file=` và không chứa `StartAttachListener`; `spec` là `Folded { mode: Allocations, ext: "collapsed", .. }`.
  - `jvm_live_objects_starts_the_attach_listener`: `LiveObjects`, `JAVA_TOOL_OPTIONS` sẵn `-Xmx2g` → giá trị bắt đầu bằng `-Xmx2g -XX:+StartAttachListener -agentpath:` và chứa `event=alloc,live,collapsed`, không chứa `total`.
  - `live_objects_keeps_user_attach_opt_out`: args config chứa `-XX:+DisableAttachMechanism` → không thêm `StartAttachListener`; tương tự khi `JAVA_TOOL_OPTIONS` chứa `-XX:-StartAttachListener`.
  - `live_objects_refuses_jdk8`: `command` là `<tmp>/jdk8/bin/java` (file rỗng) với `<tmp>/jdk8/release` = `JAVA_VERSION="1.8.0_512"` → `Unsupported { reason }` chứa `JDK 11`; với `JAVA_VERSION="11.0.29"` → `Ready`.
  - `allocation_modes_need_a_jvm`: `node index.js` với `Allocations` → `Unsupported` có chuỗi `JVM`; `Cpu` → `Ready` như cũ.
  - Test có sẵn gọi `prepare(…, ProfileMode::Cpu)` và giữ nguyên kỳ vọng.
- [ ] **Step 2: Chạy** `cargo nextest run -p ide-profiler plan` → FAIL.
- [ ] **Step 3: Cài đặt.** `prepare` trả `Unsupported("Allocation profiling is available for JVM applications.")` khi `mode != Cpu` và chương trình không phải `java`. `jvm(root, config, dir, out, mode)`: chuỗi sự kiện theo Global Constraints; với `LiveObjects`, trước khi dựng agent: launcher = `config.command` nếu là đường dẫn tuyệt đối, ngược lại `find_executable("java", &search_path(config))`; `java_feature_version` < 11 → `Unsupported(format!("Profiling live objects needs JDK 11 or newer; '{}' runs JDK {v}.", config.name))`; rồi `append_env("JAVA_TOOL_OPTIONS", "-XX:+StartAttachListener")` nếu `wants_listener_flag(existing + " " + config.args.join(" "))`, sau đó mới append agent.
- [ ] **Step 4: Chạy** `cargo nextest run -p ide-profiler` → PASS; sửa `profiler_prepare` (truyền `mode` vào `ide_profiler::prepare`), `pnpm gen:bindings`, truyền `"cpu"` ở `executor.ts`, `pnpm typecheck` → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-profiler/Cargo.toml crates/ide-profiler/src/plan.rs Cargo.lock src-tauri/src/commands/profiler.rs src/bindings.ts src/features/profiler/executor.ts && git commit -m "feat(profiler): plan allocation and live-object runs of JVM programs"`.

---

### Task 4: `GC.run` trước Stop, IPC, test JVM thật

**Files:**

- Create: `crates/ide-profiler/src/live.rs`, `crates/ide-profiler/tests/async_profiler_jvm.rs`
- Modify: `crates/ide-profiler/src/lib.rs` (`mod live; pub use live::gc_before_stop;`), `src-tauri/src/commands/profiler.rs`, `src-tauri/src/commands/mod.rs:468-469`, `src/bindings.ts` (sinh lại)

**Interfaces:**

- Consumes: `ide_jvm_attach::{has_listener, jcmd, AttachError}`; `ide_core::process::process_tree` (Task 1); `ide_host::ops::run::list(&Host) -> Vec<RunInfo>`.
- Produces:

```rust
// live.rs
pub const GC_TIMEOUT: Duration = Duration::from_secs(5);
/// Runs `GC.run` in every JVM of `pid_tree` with an attach listener, so the live-object
/// profile the agent writes at exit holds only reachable objects. Returns how many JVMs collected.
pub fn gc_before_stop(pid_tree: &[i32]) -> u32
fn gc_each(pids: &[i32], has_listener: impl Fn(u32) -> bool, gc: impl Fn(u32) -> Result<String, AttachError>) -> u32
// src-tauri
#[tauri::command] #[specta::specta]
pub async fn profiler_gc_before_stop(state: State<'_, AppState>, run: RunId) -> IdeResult<u32>
```

`profiler_gc_before_stop`: tìm `pid` của `run` trong `ide_host::ops::run::list(&state.host)`; không có hoặc đã thoát → `Ok(0)`; ngược lại `blocking(move || Ok(ide_profiler::gc_before_stop(&process_tree(pid as i32))))`. Trên non-unix trả `Ok(0)`.

- [ ] **Step 1: Viết test thất bại** trong `live.rs`:
  - `gc_each_skips_pids_without_listener_and_counts_successes`: pids `[10, 11, 12]`, listener chỉ ở 11 và 12, `gc` trả `Ok` → `2`; ghi lại pid đã gọi = `[11, 12]`.
  - `gc_each_continues_after_failure`: listener ở 11, 12; `gc(11)` → `Err(AttachError::Timeout)`, `gc(12)` → `Ok` → `1`, đã gọi cả hai.
  - `gc_each_ignores_negative_pids`: `[-1, 5]` với listener ở mọi pid → chỉ gọi 5.
- [ ] **Step 2: Viết test JVM thật** `crates/ide-profiler/tests/async_profiler_jvm.rs`, mọi test `#[ignore]`, bỏ qua khi thiếu `OPENIDEA_TEST_JAVA` hoặc `ASYNC_PROFILER_HOME`. Workload là một file Java tự viết trong test (`const ALLOC_JAVA: &str`), chạy kiểu single-file (`java <tmp>/Alloc.java <mode>`): giữ 64 MiB `byte[4096]` trong list static (`retained`), cấp phát 256 MiB `byte[1024]` bỏ ngay (`garbage`), in `WAITING` rồi ngủ khi mode là `wait`.
  - `allocations_profile_weighs_bytes`: `prepare(…, Allocations)`, chạy `launch` (env + args) tới khi thoát, `collect` → `unit == "bytes"`, tổng của frame `Code` tên `Alloc.garbage` trong khoảng `[200 MiB, 330 MiB]`, có frame `byte[]` kiểu `AllocatedType`.
  - `live_objects_after_gc_keep_only_retained`: `prepare(…, LiveObjects)`, chạy mode `wait`, chờ `WAITING`, `gc_before_stop(&[pid]) == 1`, gửi SIGINT (`kill -INT <pid>`), chờ thoát, `collect` → `unit == "samples"`, số mẫu dưới `Alloc.retained` ≥ 90 % tổng mẫu dưới `retained` + `garbage`.
- [ ] **Step 3: Chạy** `cargo nextest run -p ide-profiler live` → FAIL.
- [ ] **Step 4: Cài đặt** `gc_each` (bỏ pid ≤ 0, tuần tự, `tracing::debug!` lỗi) và `gc_before_stop` (gọi `gc_each` với `has_listener` và `jcmd(pid, "GC.run", GC_TIMEOUT)`); lệnh IPC `profiler_gc_before_stop`; đăng ký trong `mod.rs`; `pnpm gen:bindings`.
- [ ] **Step 5: Chạy** `cargo nextest run -p ide-profiler`, rồi `OPENIDEA_TEST_JAVA=~/.sdkman/candidates/java/21.0.4-tem/bin/java ASYNC_PROFILER_HOME=<async-profiler ≥ 3.0> cargo test -p ide-profiler --test async_profiler_jvm -- --ignored` (lặp với 11.0.29-tem) → PASS; `pnpm typecheck` → PASS.
- [ ] **Step 6: Commit**: `git add crates/ide-profiler/src/live.rs crates/ide-profiler/src/lib.rs crates/ide-profiler/tests/async_profiler_jvm.rs src-tauri/src/commands/profiler.rs src-tauri/src/commands/mod.rs src/bindings.ts && git commit -m "feat(profiler): collect garbage before a live-object run stops"`.

---

### Task 5: Hook `beforeStop` của executor trong run store

**Files:**

- Modify: `src/workbench/contributions.ts:1139-1144` (`ExecutorLaunch`), `src/features/run/store.ts` (option `startRun`, runtime, `stopSession` ~dòng 1061), `src/features/run/executors.ts`
- Test: `src/features/run/executorStop.test.ts` (mock `@/platform/ipc` như các test store khác của feature run, ví dụ `consoleFlush.test.ts`)

**Interfaces:**

- Produces:

```ts
// contributions.ts, trong ExecutorLaunch
/** The user stopped the run: called before the stop signal, which waits for it (at most `BEFORE_STOP_TIMEOUT_MS`). A second Stop does not wait. */
beforeStop?(runId: RunId): Promise<void>;
// store.ts
export const BEFORE_STOP_TIMEOUT_MS = 12_000;
startRun(config, reuse?, baseConfig?, options: { …; beforeStop?: (runId: RunId) => Promise<void> })
```

`stopSession`: sau `patchSession(…, { stopped: true, status: "stopping" })`, nếu runtime có `beforeStop` và chưa có hook nào đang chờ: đánh dấu đang chờ, `await Promise.race([beforeStop(runId).catch(() => undefined), delay(BEFORE_STOP_TIMEOUT_MS)])`, bỏ dấu, rồi `runStop` như cũ. Nếu hook đang chờ (Stop lần hai): gọi `runStop` ngay. `runWithExecutor` truyền `beforeStop: plan.beforeStop`.

- [ ] **Step 1: Viết test thất bại** (vitest, fake timers):
  - `stop waits for beforeStop then sends the stop`: `beforeStop` resolve sau 100 ms → `runStop` chưa được gọi lúc 50 ms, được gọi đúng một lần sau 100 ms, `beforeStop` nhận đúng `runId`.
  - `second stop while beforeStop is pending stops at once`: `beforeStop` không bao giờ resolve; Stop lần một, Stop lần hai → `runStop` được gọi một lần ngay ở lần hai; hook được gọi đúng một lần.
  - `beforeStop that never settles still stops after the cap`: tiến `BEFORE_STOP_TIMEOUT_MS` → `runStop` được gọi.
  - `a rejected beforeStop still stops`.
  - `runs without beforeStop stop as before` (không thay đổi đường cũ).
- [ ] **Step 2: Chạy** `pnpm vitest run src/features/run/executorStop.test.ts` → FAIL.
- [ ] **Step 3: Cài đặt** như Interfaces.
- [ ] **Step 4: Chạy** lại test → PASS; `pnpm vitest run src/features/run` → PASS.
- [ ] **Step 5: Commit**: `git add src/workbench/contributions.ts src/features/run/store.ts src/features/run/executors.ts src/features/run/executorStop.test.ts && git commit -m "feat(run): let a run executor act before the run stops"`.

---

### Task 6: Executor Profile Allocations / Profile Live Objects và snapshot

**Files:**

- Modify: `src/features/profiler/executor.ts`, `src/features/profiler/index.ts`, `src/features/profiler/store.ts`, `src/features/profiler/model.ts`, `src/platform/locales/text/en.json`, `zh.json`
- Test: `src/features/profiler/profiler.test.ts`, Create `src/features/profiler/executor.test.ts`

**Interfaces:**

- Consumes: `commands.profilerPrepare(config, mode)`, `commands.profilerGcBeforeStop(run)` (Task 4), `ExecutorLaunch.beforeStop` (Task 5).
- Produces:

```ts
// model.ts
export function allocationProfilerSupports(config: Pick<RunConfig, "command">): boolean   // programName === "java"
// store.ts
export interface Snapshot { id; name; createdAt; profile; /** Why the numbers may mislead; shown above the views. */ notice: string | null }
export function addSnapshot(name: string, profile: Profile, notice?: string | null): Snapshot
// executor.ts
export function profilerExecutor(mode: ProfileMode): RunExecutorContribution
export const LIVE_NOT_STOPPED: string    // "The program ended by itself, so no garbage collection ran before the profile was written: objects that were already unreachable may show as live."
export const LIVE_NOT_COLLECTED: string  // "No garbage collection ran before the program stopped (its attach listener was not reachable): objects that were already unreachable may show as live."
```

| mode          | `id`                  | `label(name)`                    | `action`                 | `order` | `supports`                   |
| ------------- | --------------------- | -------------------------------- | ------------------------ | ------- | ---------------------------- |
| `cpu`         | `profiler`            | `Profile '${name}'`              | `run.profile`            | 20      | `profilerSupports`           |
| `allocations` | `profilerAllocations` | `Profile '${name}' Allocations`  | `run.profileAllocations` | 21      | `allocationProfilerSupports` |
| `liveObjects` | `profilerLiveObjects` | `Profile '${name}' Live Objects` | `run.profileLiveObjects` | 22      | `allocationProfilerSupports` |

Chỉ `liveObjects` có `beforeStop`: gọi `profilerGcBeforeStop(runId)`, nhớ số JVM đã GC trong closure của launch; lỗi IPC coi như 0. `finished({ stopped })`: `notice = !stopped ? LIVE_NOT_STOPPED : collected === 0 ? LIVE_NOT_COLLECTED : null` (chế độ khác: `null`). Actions mới trong `index.ts` (category "Run", icon `profile`, `when: "projectOpen"`, không phím mặc định): `run.profileAllocations` title "Profile Allocations", description "Run the selected configuration and record where it allocates memory", keywords `["allocation", "memory", "async-profiler"]`; `run.profileLiveObjects` title "Profile Live Objects", description "Run the selected configuration and record where the objects still alive when it stops were allocated", keywords `["allocation", "live objects", "memory leak"]`. Cả hai chạy `run.withExecutor` với executor tương ứng. Label executor viết như `Profile '${name}'` hiện có; nếu `textCatalog.test.ts` đòi entry thì thêm vào cả hai catalog.

- [ ] **Step 1: Viết test thất bại**:
  - `profiler.test.ts`: `allocationProfilerSupports` đúng cho `java`, `/opt/jdk/bin/java`, sai cho `node`, `python`.
  - `executor.test.ts` (mock `@/platform/ipc`, `@/workbench/contributions`): `prepare sends the executor's mode` (ba executor gửi `"cpu"`, `"allocations"`, `"liveObjects"`); `only live objects has beforeStop`; `live snapshot of a run that ended by itself carries the notice` (`finished({ stopped: false })` → snapshot `notice === LIVE_NOT_STOPPED`); `live snapshot without a collected JVM carries the notice` (`beforeStop` với IPC trả 0, rồi `finished({ stopped: true })` → `LIVE_NOT_COLLECTED`); `live snapshot after GC has no notice` (IPC trả 1); `allocation snapshot has no notice`.
- [ ] **Step 2: Chạy** `pnpm vitest run src/features/profiler` → FAIL.
- [ ] **Step 3: Cài đặt**; đăng ký ba executor trong `activate()`; thêm title, description và hai notice vào `en.json` + `zh.json` (zh của title khác en, ví dụ "分析内存分配" / "分析存活对象").
- [ ] **Step 4: Chạy** `pnpm vitest run src/features/profiler src/platform/locales` → PASS.
- [ ] **Step 5: Commit**: `git add src/features/profiler/{executor.ts,executor.test.ts,index.ts,store.ts,model.ts,profiler.test.ts} src/platform/locales/text/en.json src/platform/locales/text/zh.json && git commit -m "feat(profiler): profile allocations and live objects of JVM runs"`.

---

### Task 7: Hiển thị profile allocation trong tool window Profiler

**Files:**

- Modify: `src/features/profiler/model.ts` (`formatWeight`), `src/features/profiler/ProfilerView.tsx`, `src/features/profiler/Profiler.module.css`, `src/styles/tokens.css:102-108`, `src/platform/locales/text/en.json`, `zh.json`
- Test: `src/features/profiler/profiler.test.ts`, `src/features/profiler/ProfilerView.test.tsx` (Create)

**Interfaces:**

- Consumes: `Profile.mode`, `ProfileFrame.kind` (Task 2), `Snapshot.notice` (Task 6).
- Produces: `formatWeight(value, "bytes")` → `"0 B"`, `"1.0 KB"`, `"512.0 MB"`, `"1.2 GB"` (bước 1024, một chữ số thập phân, so sánh giá trị đã làm tròn như `formatBytes` của Memory view); token `--flame-type: color-mix(in srgb, var(--accent) 30%, var(--bg-elev));`.

Giao diện: tab snapshot có nhãn `${name} · Allocations` / `${name} · Live Objects` (CPU giữ tên), tooltip thêm chế độ. Dòng tóm tắt cạnh tab view: `async-profiler · 612.4 MB allocated` (Allocations), `async-profiler · 184 live samples (≈ 512 KB each)` (Live Objects), CPU như cũ. Frame `allocatedType`: lớp CSS `typeFrame` (`background: var(--flame-type)`, thắng `c1`–`c4`, không thắng `match`/`dim`), tooltip mở đầu bằng `Allocated type`, tên trong call tree và method list có hậu tố nhạt `allocated`. `snapshot.notice` hiện thành một dòng cảnh báo (icon `warning` từ `src/ui/icons.tsx`, màu token `--warning`) giữa toolbar và body. Double-click frame kiểu mở file nguồn như frame thường (file đến từ Task 2).

- [ ] **Step 1: Viết test thất bại**:
  - `profiler.test.ts`: `formatWeight(0, "bytes") === "0 B"`, `formatWeight(1024, "bytes") === "1.0 KB"`, `formatWeight(536870912, "bytes") === "512.0 MB"`, `formatWeight(1048575, "bytes") === "1.0 MB"`; `formatWeight(3, "samples")` và `"ms"` giữ kết quả cũ.
  - `ProfilerView.test.tsx` (testing-library, store thật với `addSnapshot`): `allocation profile shows bytes and marks type frames` (Call Tree có `byte[]` với nhãn `allocated`, tóm tắt chứa `allocated`); `notice is shown above the views` (snapshot có notice → văn bản notice hiện; không có → không có `role="status"` cảnh báo); `cpu profile looks as before` (không có nhãn `allocated`).
- [ ] **Step 2: Chạy** `pnpm vitest run src/features/profiler` → FAIL.
- [ ] **Step 3: Cài đặt**; thêm chuỗi mới (`Allocations`, `Live Objects`, `allocated`, `Allocated type`, `{size} allocated`, `{count} live samples (≈ 512 KB each)` — đặt tên placeholder theo quy ước `tx` mà `textCatalog.test.ts` kiểm) vào hai catalog.
- [ ] **Step 4: Chạy** `pnpm vitest run src/features/profiler src/platform/locales` → PASS; `pnpm typecheck` → PASS.
- [ ] **Step 5: Commit**: `git add src/features/profiler/{model.ts,ProfilerView.tsx,ProfilerView.test.tsx,Profiler.module.css,profiler.test.ts} src/styles/tokens.css src/platform/locales/text/en.json src/platform/locales/text/zh.json && git commit -m "feat(profiler): show allocated bytes and allocated types in the profiler"`.

---

### Task 8: Kiểm tra toàn bộ và xác minh trong app

**Files:** không (trừ sửa lỗi tìm thấy).

- [ ] **Step 1: Rust** (từng lệnh một): `cargo fmt --all --check`; `cargo clippy -p ide-core -p ide-dap -p ide-profiler -p openidea --all-targets -- -D warnings` (`openidea` là package của `src-tauri`); `cargo nextest run -p ide-core -p ide-dap -p ide-profiler`. Expected: sạch, PASS.
- [ ] **Step 2: Frontend**: `pnpm gen:bindings` rồi `git diff --exit-code src/bindings.ts`; `pnpm typecheck`; `pnpm lint`; `pnpm format:check`; `pnpm knip`; `pnpm vitest run src/features/profiler src/features/run src/platform/locales`; `pnpm build`. Expected: PASS, bindings không đổi.
- [ ] **Step 3: Test JVM thật** (Task 4 Step 5) với JDK 11.0.29 và 25.0.3, async-profiler 4.6 và 3.0 → PASS.
- [ ] **Step 4: Xác minh trong app** bằng skill `verify` (Tauri MCP; `pnpm dev:status` lấy cổng, truyền `appIdentifier`). Khởi động `ASYNC_PROFILER_HOME=<async-profiler 4.6> pnpm tauri dev`. Mở một project tạm ngoài repo chứa `Alloc.java` của Grounding (mode `wait`), cấu hình `java -cp . Alloc wait` (JDK 21):
  1. Menu run có **Profile 'Alloc' Allocations** và **Profile 'Alloc' Live Objects**; cấu hình `node` không có hai mục này.
  2. Profile Allocations, chờ `WAITING`, Stop → tab `Alloc · Allocations`; tổng ≈ 600–700 MB; Call Tree: `Alloc.main → Alloc.garbage → byte[]` (nhãn `allocated`, màu `--flame-type`) ≈ 512 MB.
  3. Profile Live Objects, Stop một lần → không có cảnh báo; `Alloc.retained` chiếm > 90 % mẫu.
  4. Profile Live Objects với cấu hình mode `exit` (tự thoát) → cảnh báo `LIVE_NOT_STOPPED`.
  5. Cấu hình chạy JDK 8 (`release` 1.8) → Profile Live Objects báo cần JDK 11, không chạy.
  6. Double-click một frame kiểu của class người dùng mở đúng file nguồn.
     Chụp ảnh sáng/tối và zh của bước 2 và 3.
- [ ] **Step 5: Commit** các sửa lỗi (nếu có) theo từng phần, stage từng đường dẫn.

---

## Sửa spec đề xuất (chưa áp vào spec)

**S1. §4, hàng Allocation.** Thay:

```
| Allocation                   | async-profiler `event=alloc[,live]`                           | —                                                                                                                                                        | Sau; không Windows                                                                                                                                                                                                                                                                                                                  |
```

bằng:

```
| Allocation                   | async-profiler ≥ 3.0 qua executor "Profile Allocations" (`event=alloc,total`, byte) / "Profile Live Objects" (`event=alloc,live`, số mẫu), output `collapsed` | 512 MiB cấp phát thật → ước 491–595 MB trên JDK 8/11/17/21/25; 64 MiB giữ lại → 53–80 MB **[XM, M5 P1/P2]** | Chỉ khi chạy (không trong phiên debug); không Windows; mỗi lần chạy một sự kiện. `live` cần JDK ≥ 11 và `GC.run` qua attach trước khi dừng, nếu không rác chiếm tới 57 % mẫu **[XM, M5 P4]** |
```

**S2. §11, gạch M5.** Thay câu "Ghi stack cấp phát ngay trong phiên debug cần `SampledObjectAlloc` (JVMTI): dùng agent JetBrains (Apache-2.0, kèm NOTICE) hoặc agent tự viết; để sau." bằng:

> Không trong phiên debug ở M5. Đã đo: async-profiler nạp bằng `-agentpath` lúc launch sống qua breakpoint `SUSPEND_ALL` và ghi profile khi JVM nhận SIGINT/SIGTERM (Stop của java-debug launch là `Process.destroy` + detach: có file), nhưng không khi kết thúc bằng JDWP `VirtualMachine.Exit` (launch `runInTerminal`) hay SIGKILL; dump khi VM đang dừng treo trên 11/21/25, nên không xem được ở breakpoint **[XM, M5 P5–P7]**. Xem allocation tại breakpoint cần agent JVMTI `SampledObjectAlloc` (agent JetBrains Apache-2.0 kèm NOTICE, hoặc tự viết); để sau.

**S3. §11, dòng "Agent nạp động (`JVMTI.agent_load`) vào VM đang suspend treo [XM]".** Thêm vào cuối: "Kể cả với async-profiler đã nạp (`asprof dump`, 11/21/25: timeout 15 s, file chỉ ghi sau resume); khi VM đang chạy, lệnh attach `load <lib> true dump,…` trả lời trong 5–9 ms **[XM, M5 P7]**."

**S4. §15, hàng M5.** Thay `| **M5**     | Allocation | M4 |` bằng `| **M5**     | Allocation (Profile Allocations / Live Objects) | M1 (`ide-jvm-attach`) |`: M5 không dùng mã hay UI của M4.

**S5. §2, bảng bằng chứng.** Thêm hàng: `| P (M5) | async-profiler `event=alloc[,live]`: định dạng, độ chính xác, khi nào ghi file, phiên debug | **[XM]** lá `<kiểu>_[i]`; `total`±11 % ở site lớn; không nhiều sự kiện ngoài JFR;`live` cần 11+ và GC trước dump; có file khi SIGINT/SIGTERM, không khi SIGKILL/`VirtualMachine.Exit`; dump khi đang dừng treo. Mã: `scratchpad/m5-spike` |`.

## Cần chủ repo quyết định

1. **Có làm chế độ Live Objects không, và có chạy `GC.run` trong chương trình của người dùng lúc Stop không.** Mặc định đề xuất: **có**. Không có GC thì kết quả sai tới 57 % (P4); GC chạy đúng lúc chương trình đang bị dừng theo yêu cầu của người dùng, chỉ ở chế độ họ đã chọn. Nếu không đồng ý: bỏ executor Live Objects, Task 1, Task 4 (phần `gc_before_stop`) và Task 5; M5 chỉ còn Profile Allocations.
2. **Điểm vào: hai executor mới trong menu run** (chỉ hiện với cấu hình `java`) hay một executor allocation + lựa chọn live trong cài đặt Profiler. Mặc định đề xuất: **hai executor** (dùng extension point có sẵn, không cần trang cài đặt, mỗi lần chạy một sự kiện vốn là giới hạn của async-profiler).
