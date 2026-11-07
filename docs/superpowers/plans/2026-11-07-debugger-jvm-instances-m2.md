# Debugger JVM Memory view (M2: danh sách instance, referrer một bước, dự phòng JDWP cho bảng class) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trong tab **Memory**, người dùng mở danh sách instance của một class (≤ 1000), xem field của từng instance (một cấp, mở lười), xem referrer một bước kèm tên field trỏ tới, nhảy tới source của class; và bảng class vẫn có số liệu ở chỗ M1 không lấy được (JDK 8–16 khi đang dừng, Windows, JVM ở máy khác) bằng JDWP `InstanceCounts` một lần.

**Architecture:** Trait `JvmInspector` (crate mới `ide-jvm-inspect`) có hai bản cài. Phiên Java: bundle jdtls mới `java/jvm-inspect` lấy VM JDI sống của java-debug bằng reflection, chọn đúng VM theo pid (launch) hoặc cổng socket JDWP (attach), và nâng timeout gói JDI trong lúc chạy lệnh dài; phía Rust gọi qua `workspace/executeCommand` (`ide-lsp/src/jdtls/jvm_inspect.rs`). Phiên Kotlin: crate mới `ide-jdwp` với `JdwpLink` (relay trung lập adapter, thay `kotlin_jdwp.rs`, `hold_resumes` cho fwcd) chèn lệnh JDWP của riêng nó trong dải id tách biệt và trả lại đúng số ObjectID nó đã nhận. `ide-dap` giữ inspector theo phiên, kiểm tra "đang dừng" và "cùng lần dừng", chọn dự phòng cho bảng class, phát `DebugEvent::Capabilities` / `DebugEvent::JvmBackend`.

**Tech Stack:** Rust 2024 (tokio net/io-util, `futures::future::BoxFuture`, thiserror, proptest), Java 21 bytecode dịch bằng ECJ của JDT LS 1.63.0 (chạy bằng JDK 25), JDI (`com.sun.jdi`, `org.eclipse.jdi.VirtualMachine`), serde + specta, React + zustand + CSS Modules, vitest, smoke qua `openidea-server`.

**Spec:** `docs/superpowers/specs/2026-11-07-jvm-debug-link-design.md` (mục 4, 5 phần Windows/dự phòng, 6, 7, 8 mục 3 và 6, 9 bảng phạm vi, 13, 14, 15, 16). Plan M1: `docs/superpowers/plans/2026-11-07-debugger-jvm-memory-m1.md`. Mục "Sửa spec đề xuất" ở cuối plan này thay một số dòng của spec theo kết quả spike.

## Global Constraints

- **Không bao giờ** gửi `VirtualMachine.DisposeObjects` cho một ID với số lớn hơn số lần link đã nhận ID đó trong reply của chính nó (dư một lần là JVM abort, spec 6.2). Không dispose ReferenceTypeID. Không dùng `DisableCollection`/`EnableCollection`.
- Gói nội bộ của link dùng id trong `[0x7000_0000, 0x7FFF_FFFF)`; adapter phát id trong dải → `Degraded` (chỉ chuyển tiếp).
- Link trong suốt: byte của adapter đi qua không đổi theo cả hai chiều. Ngoại lệ duy nhất: giữ `VirtualMachine.Resume (1/9)` và `ThreadReference.Resume (11/3)` trước `release()` khi `hold_resumes = true`. Giới hạn gói adapter → JVM giữ như hiện nay: độ dài `11..=16 MiB`. Chiều JVM → adapter không giới hạn (stream).
- Lệnh nội bộ của link chỉ gửi khi link ở `Suspended` và `ThreadReference.SuspendCount (11/12)` của thread dừng > 0; một lệnh một lúc; `InstanceCounts` gửi một gói cho mọi class (không chia lô). Ngoại lệ không cần đang dừng: `IDSizes (1/7)` ngay sau handshake và `DisposeObjects (1/14)`.
- Không invoke ở đâu cả: không `InvokeMethod`, không `NewInstance`, không `toString`.
- Giới hạn: instance ≤ `1000`; referrer mặc định `50`, tối đa `200`; mảng mở ra `100` phần tử đầu; text của `String` chỉ đọc khi ≤ `1000` ký tự; tìm chỉ số trong mảng referrer chỉ khi mảng ≤ `10 000` phần tử.
- Dữ liệu qua JDWP (bảng class dự phòng, instance, field, referrer) chỉ lấy khi phiên đang dừng; object chỉ dùng được trong cùng lần dừng (`generation` = `Session::stop_seq`).
- Bundle không ghim phiên bản java-debug: thiếu class/field/method nào → `unsupported`, capability `jvm_instances` tắt, không toast. Trong lệnh `classes` và `referrers`, bundle nâng timeout gói JDI lên `60 000 ms` qua `org.eclipse.jdi.VirtualMachine.setRequestTimeout` rồi trả lại giá trị cũ.
- Bảng class dự phòng: nguồn `debugger`, "chỉ object reachable", không có shallow size; chênh lệch chỉ tính với baseline cùng nguồn.
- Đường dẫn sau đợt sửa M1: `crates/ide-dap/src/jvm_memory/{mod.rs (kiểu + API phiên), scan.rs, snapshot.rs, tests.rs}`, biến thể lý do `ListenModeNotSupported`, context key `debugHasJvmMemory`, không thêm `-XX:+StartAttachListener` trên Windows. Plan này tham chiếu theo tên, không theo số dòng.
- IPC: `IdeResult<T>`, camelCase, mỗi lệnh mới gọi `host.require_trust(window)`; đăng ký ở `crates/ide-host/src/ops/debug.rs::register` và `src-tauri/src/commands/{debug.rs,mod.rs}`; chạy `pnpm gen:bindings`, commit `src/bindings.ts`.
- Chuỗi hiển thị vào cả `src/platform/locales/text/en.json` và `zh.json`. CSS Modules + tokens, không hex, icon từ `src/ui/icons.tsx`, `aria-label` cho nút icon. Không import feature khác.
- Test JVM thật để `#[ignore]` (Rust) hoặc chạy tay (harness Python), đọc `OPENIDEA_TEST_JAVA`. Không đưa mã thử nghiệm hay bản sao nguồn OpenJDK/java-debug vào repo.
- Commit: `feat(debugger): …`, stage từng đường dẫn, không trailer `Co-Authored-By`, không stage `openspec/` hay `*.sh`.

## Grounding

Ba giả định có thể làm hỏng cách làm, mỗi cái một probe trong `scratchpad/m2-spike/probes/` (ngoài repo). Bản tải: JDT LS 1.63.0 (`dl-jdtls`, cần JDK 25 để chạy), vscode-java-debug mới nhất trên open-vsx (`dl-javadebug`).

**G1. Reflection tới VM của java-debug có còn chạy với bản app cài hôm nay, và ánh xạ phiên → VM bằng gì?** App cài `vscode-java-debug` mới nhất từ open-vsx (`crates/ide-tools/src/registry.rs`, không ghim). Bản mới nhất là 0.60.0 (2026-10-15), bên trong vẫn là plugin 0.53.2, cùng SHA-256 với bản research D và bản đang cài trong profile dev:

```
0.60.0 2026-10-15T03:47:51.514537Z
14f6f52a313aaff242f26fa738546bd0da6d2015526d807828b5e18df2141136  m2-spike/dl-javadebug/.../com.microsoft.java.debug.plugin-0.53.2.jar
14f6f52a313aaff242f26fa738546bd0da6d2015526d807828b5e18df2141136  javadebug-dl/.../com.microsoft.java.debug.plugin-0.53.2.jar
14f6f52a313aaff242f26fa738546bd0da6d2015526d807828b5e18df2141136  ~/Library/Application Support/ai.l0ng.openidea.dev.…/tools/java-debug/…/com.microsoft.java.debug.plugin-0.53.2.jar
```

Probe `bundle_spike.py map` (bundle `m2probe.jar` đọc `connectedVMs` và socket qua `VirtualMachineImpl.packetReceiveManager()` → `PacketManager.fConnection` → `SocketConnection.fSocket`; một phiên launch và hai phiên attach vào hai JVM chạy **cùng một chương trình**):

```
[   1.1s] jdtls 1.63.0 + java-debug 0.53.2: probe registered: True | java-debug registered: True
[   3.8s] vms before any session: []
[   3.9s] LAUNCH stopped; DAP process event: [] | processId request: {'processId': 28764, 'shellProcessId': -1}
[   4.1s] ATTACH ports 59246 (pid 28765) and 59247 (pid 28766); DAP threads: [1, 3, 4, 5, 6, 7] [1, 3, 4, 5, 6, 7]
[   4.1s] VM: {"version": "25.0.3", "pid": 28764, "remotePort": 59245, "localPort": 59244, "remoteHost": "127.0.0.1", "timeout": 3000} threads: ['1:main', '2:Reference Handler', '3:Finalizer', '4:Signal Dispatcher', '5:Notification Thread', '6:Common-Cleaner']
[   4.1s] VM: {"version": "21.0.4", "remotePort": 59246, "localPort": 59249, "remoteHost": "127.0.0.1", "timeout": 3000} threads: ['1:main', '3:Reference Handler', '4:Finalizer', '5:Signal Dispatcher', '6:Notification Thread', '7:Common-Cleaner']
[   4.1s] VM: {"version": "21.0.4", "remotePort": 59247, "localPort": 59251, "remoteHost": "127.0.0.1", "timeout": 3000} threads: ['1:main', '3:Reference Handler', '4:Finalizer', '5:Signal Dispatcher', '6:Notification Thread', '7:Common-Cleaner']
[   4.1s] attach thread lists identical: True
[   4.1s] remote ports match attach ports: True
[   5.1s] vms after all sessions ended: []
```

Kết luận: reflection chạy trên JDT LS 1.63.0 (`org.eclipse.jdt.debug` 3.27.0). Launch: `vm.process().pid()` trùng pid java-debug báo (`processid`). **Khớp attach theo danh sách thread của DAP bị bác**: hai JVM cùng chương trình có cùng id và tên thread. Khớp theo cổng socket thì đúng: `remotePort` = `port` của request `attach` (kể cả phiên "Listen to remote JVM", nơi java-debug attach vào cổng relay). Đây là lần bác thứ nhất, đổi thiết kế (Task 7), không đổi cách làm.

**G2. JVM đếm ObjectID theo từng lần xuất hiện trong reply không (để ledger "nhận bao nhiêu, dispose bấy nhiêu" không bao giờ dư khi adapter giữ cùng ID)? ReferenceTypeID có dispose được không?** Probe `refcount_spike.py`: "adapter" nhận X một lần, "link" nhận X hai lần trong **một** reply `ReferenceType.GetValues` (hai field static cùng trỏ một object), link dispose 2, adapter dispose 1:

```
RESULT {"jdk": 8, "same_id_twice_in_one_reply": true, "after_link_dispose_2": {"jvm_exit": null, "object": "valid"}, "after_adapter_dispose_1": {"jvm_exit": null, "object": "error 20"}, "reftype_same_id": true, "after_reftype_dispose_2": {"jvm_exit": null, "type": "valid"}, "last_output": ["Listening for transport dt_socket at address: 60176", "READY"]}
RESULT {"jdk": 11, "same_id_twice_in_one_reply": true, "after_link_dispose_2": {"jvm_exit": null, "object": "valid"}, "after_adapter_dispose_1": {"jvm_exit": null, "object": "error 20"}, "reftype_same_id": true, "after_reftype_dispose_2": {"jvm_exit": null, "type": "valid"}, "last_output": ["Listening for transport dt_socket at address: 60183", "READY"]}
RESULT {"jdk": 17, "same_id_twice_in_one_reply": true, "after_link_dispose_2": {"jvm_exit": null, "object": "valid"}, "after_adapter_dispose_1": {"jvm_exit": null, "object": "error 20"}, "reftype_same_id": true, "after_reftype_dispose_2": {"jvm_exit": null, "type": "valid"}, "last_output": ["Listening for transport dt_socket at address: 60189", "READY"]}
RESULT {"jdk": 21, "same_id_twice_in_one_reply": true, "after_link_dispose_2": {"jvm_exit": null, "object": "valid"}, "after_adapter_dispose_1": {"jvm_exit": null, "object": "error 20"}, "reftype_same_id": true, "after_reftype_dispose_2": {"jvm_exit": null, "type": "valid"}, "last_output": ["Listening for transport dt_socket at address: 60192", "READY"]}
RESULT {"jdk": 25, "same_id_twice_in_one_reply": true, "after_link_dispose_2": {"jvm_exit": null, "object": "valid"}, "after_adapter_dispose_1": {"jvm_exit": null, "object": "error 20"}, "reftype_same_id": true, "after_reftype_dispose_2": {"jvm_exit": null, "type": "valid"}, "last_output": ["Listening for transport dt_socket at address: 60202", "READY"]}
```

Kết luận: đếm theo từng lần xuất hiện, trên 8/11/17/21/25; dispose đúng phần của link giữ object sống cho adapter, phần của adapter mới làm ID hết hiệu lực (lỗi 20). `DisposeObjects` lên ReferenceTypeID không làm nó hết hiệu lực, nên số đếm của nó không theo cùng quy tắc: link không bao giờ dispose ReferenceTypeID.

**G3. `InstanceCounts` một lần cho mọi class khi đang dừng (dự phòng JDK 8/11) mất bao lâu, có chặn adapter, và timeout ~3 s của Eclipse JDI có làm hỏng java-debug?** Probe `bundle_spike.py latency` / `block` / `hover` (JVM `-Xmx4g`, `Heap$Live` × n, dừng ở breakpoint, đếm qua bundle; trong lúc đếm, gửi request DAP của chính java-debug):

```
latency.log (trích các trường đo; mỗi dòng gốc còn có version/remotePort/localPort/remoteHost/timeout 3000):
[   4.5s] JDK 8 n=1,000,000 default timeout: "classes": 420, "instanceCountsMs": 100, "objects": 1004005
[   6.2s] JDK 8 n=10,000,000 default timeout: "classes": 420, "instanceCountsMs": 1297, "objects": 10004005
[   7.5s] JDK 8 n=10,000,000 timeout 60s: "instanceCountsMs": 1260, "objects": 10004005 | DAP stackTrace during it: 1063 ms success=True
[   7.8s] JDK 8 instances/referrers: "instances": 1000, "instancesMs": 16, "referrers": 1, "referrersMs": 262
[   8.1s] JDK 11 n=1,000,000 default timeout: "classes": 440, "instanceCountsMs": 81, "objects": 1010368
[   9.3s] JDK 11 n=10,000,000 default timeout: "classes": 440, "instanceCountsMs": 808, "objects": 10010368
[  10.1s] JDK 11 n=10,000,000 timeout 60s: "instanceCountsMs": 766, "objects": 10010368 | DAP stackTrace during it: 568 ms success=True
[  10.5s] JDK 11 instances/referrers: "instances": 1000, "instancesMs": 72, "referrers": 1, "referrersMs": 348
[  11.0s] JDK 21 n=1,000,000 default timeout: "classes": 487, "instanceCountsMs": 278, "objects": 1009788
[  14.6s] JDK 21 n=10,000,000 default timeout: "classes": 487, "error": "org.eclipse.jdi.TimeoutException: Timeout occurred while waiting for packet 181."
[  24.6s] JDK 21 n=10,000,000 timeout 60s: "allClassesMs": 1925, "classes": 487, "instanceCountsMs": 8082, "objects": 10009788 | DAP stackTrace during it: 1723 ms success=True
[  25.0s] JDK 21 instances/referrers: "instances": 1000, "instancesMs": 34, "referrers": 1, "referrersMs": 425
block.log (JDK 21, n=10,000,000):
[   9.5s] raised=60000: count [... "timeout": 3000, "allClassesMs": 1, "classes": 487, "instanceCountsMs": 4976, "objects": 10009788}] | DAP evaluate during it: 4513 ms success=True 10000000
[  18.5s] raised=60000: DAP evaluate after: 15 ms success=True
[  22.1s] raised=-1: count [... "classes": 487, "error": "org.eclipse.jdi.TimeoutException: Timeout occurred while waiting for packet 60."}] | DAP evaluate during it: 3006 ms success=False Cannot evaluate because of org.eclipse.jdi.TimeoutException: Timeout occurred while waiti
[  31.1s] raised=-1: DAP evaluate after: 30 ms success=True
hover.log:
[   4.4s] hover idle: 20 ms
[   9.6s] during count (5209 ms): hover 5 ms (has result: True), documentSymbol 3 ms
```

Kết luận: JDK 8/11 khi dừng: ≤ 1,3 s trên 10M object, request của java-debug chờ ≤ 1,1 s và thành công, nên dự phòng tự chạy được. JDK ≥ 17 (Windows, JVM từ xa): 5–8 s; với timeout mặc định thì **cả lệnh đếm lẫn request của java-debug đang chờ đều hỏng**; khi bundle nâng timeout (toàn cục theo VM) thì request của java-debug chờ 4,5 s vẫn thành công. Lệnh `executeCommand` dài không chặn jdtls (hover 5 ms). `Instances(1000)` 3–72 ms, `ReferringObjects` 31–425 ms trên 10M object.

Không còn giả định nào chưa kiểm mà làm sập cách làm. Chưa kiểm được ở đây: Windows (không có máy), kotlin-lsp DAP (K0); M2 nhắm fwcd hiện tại.

## Review Focus

1. **Hai JVM chạy cùng chương trình, mỗi cái một phiên attach** (hai cửa sổ, hoặc test + app): instance phải lấy từ đúng JVM của phiên (G1: danh sách thread giống hệt). Test ở Task 7 (`selector_matches_attach_port_not_threads`) và Task 8 (`target_carries_attach_port_and_host`).
2. **Resume hay step trong lúc một yêu cầu instance/referrer đang chờ trên link Kotlin**: reply đến muộn vẫn được đếm và dispose đúng một lần, JVM chạy tiếp, UI báo "từ trước lần dừng". Test ở Task 4 (`late_reply_after_resume_is_disposed_once`) và Task 9 (`object_from_previous_stop_is_stale`).
3. **Đếm trên heap lớn với JDK ≥ 17 qua java-debug** (Windows, JVM từ xa): request DAP của java-debug trong lúc đếm không được hỏng vì `TimeoutException`, và timeout phải được trả lại sau đó. Test ở Task 7 (`request_timeout_raised_and_restored`, harness `--heap 10000000`).
4. **Reply lớn của chính adapter qua link** (mảng lớn, `AllClassesWithGeneric` của dự án lớn, > 16 MiB): chuyển nguyên vẹn, không bị cắt hay đổi. Test ở Task 3 (`forwards_large_jvm_packet_unchanged`).
5. **Instance `String` rất dài** (log buffer 50 MB): xem trước không tải cả chuỗi. Test ở Task 5 (`long_string_preview_reads_length_only`) và Task 7 (`string_preview_rule`).

---

### Task 0: Issue và nhánh

**Files:** không.

- [ ] **Step 1: Không tạo issue hay PR ở đây**: chủ repo chọn làm mọi mốc trên `feat/debugger-jvm-memory` và mở một PR ở cuối.
- [ ] **Step 2: Làm tiếp trên nhánh M1** `feat/debugger-jvm-memory` trong worktree `../openidea-jvm-memory`, sau khi đợt sửa M1 đã commit (`git log --oneline` có `jvm_memory/mod.rs`). Commit plan này riêng: `git add docs/superpowers/plans/2026-11-07-debugger-jvm-instances-m2.md && git commit -m "feat(debugger): plan JVM instances and referrers (M2)"`.

---

### Task 1: Crate `ide-jvm-inspect` (kiểu và trait)

**Files:**

- Create: `crates/ide-jvm-inspect/Cargo.toml`, `crates/ide-jvm-inspect/src/lib.rs`, `crates/ide-jvm-inspect/src/names.rs`
- Modify: `Cargo.toml` (`[workspace.dependencies]`: `ide-jvm-inspect = { path = "crates/ide-jvm-inspect" }`)

**Interfaces:**

- Produces (serde camelCase, `specta::Type`; enum dùng `#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]`):

```rust
pub type ObjectId = u64;
pub enum JvmValue {
    Null,
    Primitive { type_name: String, text: String },
    #[serde(rename = "string")] Str { id: ObjectId, text: Option<String>, length: u32 }, // text None khi length > STRING_PREVIEW_CHARS
    Boxed { id: ObjectId, type_name: String, text: String },
    Object { id: ObjectId, type_name: String },
    Array { id: ObjectId, type_name: String, length: u32 },
}
impl JvmValue { pub fn object_id(&self) -> Option<ObjectId> }
pub struct JvmField { pub name: String, pub value: JvmValue }          // mảng: name "[i]"
pub struct JvmReferrer { pub value: JvmValue, pub via: Vec<String> }   // tên field hoặc "[i]" trỏ tới object
pub struct ClassCount { pub name: String, pub instances: u64 }         // name dạng hiển thị như histogram
pub struct VmTarget { pub pid: Option<u32>, pub attach_host: Option<String>, pub attach_port: Option<u16>, pub generation: u64 }
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum InspectError { NotSuspended, Stale, Collected, ClassNotLoaded, VmNotFound, Unsupported(String), TimedOut, Closed, Failed(String) }
pub type InspectFuture<'a, T> = futures::future::BoxFuture<'a, Result<T, InspectError>>;
pub trait JvmInspector: Send + Sync {
    fn class_counts<'a>(&'a self, target: &'a VmTarget) -> InspectFuture<'a, Vec<ClassCount>>;
    fn instances<'a>(&'a self, target: &'a VmTarget, class_name: &'a str, limit: u32) -> InspectFuture<'a, Vec<JvmValue>>;
    fn fields<'a>(&'a self, target: &'a VmTarget, object: ObjectId) -> InspectFuture<'a, Vec<JvmField>>;
    fn referrers<'a>(&'a self, target: &'a VmTarget, object: ObjectId, limit: u32) -> InspectFuture<'a, Vec<JvmReferrer>>;
}
pub const MAX_INSTANCES: u32 = 1000;
pub const DEFAULT_REFERRERS: u32 = 50;
pub const MAX_REFERRERS: u32 = 200;
pub const ARRAY_PREVIEW: u32 = 100;
pub const STRING_PREVIEW_CHARS: u32 = 1000;
pub const REFERRER_ARRAY_SCAN: u32 = 10_000;
// names.rs
pub fn signature_to_name(signature: &str) -> Option<String>
pub fn name_to_signature(name: &str) -> Option<String>
pub fn is_boxed(type_name: &str) -> bool        // java.lang.{Integer,Long,Short,Byte,Character,Boolean,Float,Double}
pub fn string_length(value_array_length: u32, coder: Option<u8>) -> u32 // JDK 9+: length >> coder; JDK 8 (không có coder): length
```

Cargo: `edition/version/license.workspace`; deps `serde`, `specta`, `thiserror`, `futures` (workspace).

- [ ] **Step 1: Viết test thất bại** (`names.rs`, `lib.rs`):

```rust
#[test] fn signatures_to_display_names() {
    for (sig, name) in [("Lcom/x/Foo$Bar;", "com.x.Foo$Bar"), ("[I", "int[]"), ("[[Ljava/lang/String;", "java.lang.String[][]"), ("Z", "boolean")] {
        assert_eq!(signature_to_name(sig).as_deref(), Some(name));
        assert_eq!(name_to_signature(name).as_deref(), Some(sig));
    }
    assert_eq!(signature_to_name("Lbroken"), None);
}
#[test] fn string_length_follows_coder() { assert_eq!(string_length(10, Some(1)), 5); assert_eq!(string_length(10, Some(0)), 10); assert_eq!(string_length(7, None), 7); }
#[test] fn boxed_types() { assert!(is_boxed("java.lang.Integer")); assert!(!is_boxed("java.lang.String")); }
#[test] fn value_json_shape() {
    let v = JvmValue::Str { id: 7, text: None, length: 50_000_000 };
    assert_eq!(serde_json::to_value(&v).unwrap(), serde_json::json!({"kind": "string", "id": 7, "text": null, "length": 50000000}));
    assert_eq!(JvmValue::Null.object_id(), None);
    assert_eq!(JvmValue::Array { id: 3, type_name: "int[]".into(), length: 2 }.object_id(), Some(3));
}
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo +1.96 test -p ide-jvm-inspect` → FAIL.
- [ ] **Step 3: Cài đặt** như Interfaces. `InspectError` có `#[error]` ngắn bằng tiếng Anh cho log.
- [ ] **Step 4: Chạy lại** → PASS.
- [ ] **Step 5: Commit**: `git add Cargo.toml crates/ide-jvm-inspect && git commit -m "feat(debugger): add the JVM inspector types"`

---

### Task 2: Crate `ide-jdwp`: codec và đếm ObjectID trong reply

**Files:**

- Create: `crates/ide-jdwp/Cargo.toml`, `crates/ide-jdwp/src/lib.rs`, `crates/ide-jdwp/src/codec.rs`, `crates/ide-jdwp/src/ids.rs`
- Modify: `Cargo.toml` (`ide-jdwp = { path = "crates/ide-jdwp" }`)

**Interfaces:**

- Produces:

```rust
pub const HEADER_LEN: usize = 11;
pub const FLAG_REPLY: u8 = 0x80;
pub const MAX_ADAPTER_PACKET: usize = 16 * 1024 * 1024;
pub struct Header { pub length: u32, pub id: u32, pub flags: u8, pub a: u8, pub b: u8 } // lệnh: (set, cmd) = (a, b); reply: error = u16::from_be_bytes([a, b])
impl Header { pub fn parse(bytes: &[u8; 11]) -> Header; pub fn is_reply(&self) -> bool; pub fn command(&self) -> (u8, u8); pub fn error(&self) -> u16;
              pub fn command_bytes(id: u32, set: u8, cmd: u8, body_len: usize) -> [u8; 11] }
pub struct IdSizes { pub field: u8, pub method: u8, pub object: u8, pub reference_type: u8, pub frame: u8 }
impl IdSizes { pub fn parse(reply_body: &[u8]) -> Result<IdSizes, CodecError> }
pub struct Reader<'a> // u8, i32, i64, id(size), string, value(tag) -> Value
pub struct Writer     // u8, i32, i64, id(v, size), string, into_vec()
pub enum Value { Null, Primitive { tag: u8, raw: u64 }, Object { tag: u8, id: u64 } }
pub fn primitive_text(tag: u8, raw: u64) -> String     // Z/B/C/S/I/J/F/D theo Java (F/D in như Float/Double.toString cơ bản: 1.5, NaN)
pub fn is_object_tag(tag: u8) -> bool                  // b'L' b's' b't' b'g' b'l' b'c' b'['
pub enum ReplyIds { None, TaggedObjects, Values, ArrayRegion, Untagged }
pub fn object_ids(layout: ReplyIds, body: &[u8], sizes: &IdSizes) -> Result<Vec<u64>, CodecError> // mỗi lần xuất hiện một phần tử, bỏ id 0
pub fn stop_of(event_body: &[u8], sizes: &IdSizes) -> Option<Stop>  // Composite (64/100)
pub struct Stop { pub suspend_policy: u8, pub thread: Option<u64> }
pub fn dispose_body(entries: &[(u64, u32)], sizes: &IdSizes) -> Vec<u8> // int n; (objectID, int refCnt)*
#[derive(Debug, thiserror::Error)] pub enum CodecError { Truncated, BadTag(u8), BadLength(u32) }
```

Bố cục reply: `TaggedObjects` = `int n; (tag, objectID)*` (`Instances 2/16`, `ReferringObjects 9/10`); `Values` = `int n; value*` (`GetValues 2/6`, `9/2`); `ArrayRegion` = `byte tag; int n;` rồi giá trị không tag nếu tag nguyên thuỷ, có tag nếu là object (`13/2`); `Untagged` = một objectID (`ObjectReference.ReferenceType 9/1` trả ReferenceTypeID nên **không** dùng `Untagged` cho nó). `stop_of`: `byte suspendPolicy; int n;` rồi sự kiện đầu: `byte kind; int requestID;` và với mọi kind trừ `CLASS_UNLOAD (9)` và `VM_DEATH (99)` thì objectID của thread đứng ngay sau.

- [ ] **Step 1: Viết test thất bại:**

```rust
#[test] fn header_round_trip()                 // command_bytes(0x7000_0001, 1, 21, 4) → parse: id, (1,21), length 15, !is_reply
#[test] fn id_sizes_from_reply()               // body 5 × i32 8 → IdSizes { 8, 8, 8, 8, 8 }
#[test] fn counts_every_occurrence()           // Values [L x, L x, I 5, s y, L 0] → [x, x, y]
#[test] fn array_region_of_objects_and_primitives() // tag 'I' n=3 → []; tag 'L' n=2 (L a)(L a) → [a, a]
#[test] fn truncated_body_is_an_error()        // cắt 1 byte cuối → Err(Truncated); tag 'Q' → Err(BadTag)
#[test] fn stop_of_breakpoint_and_vm_death()   // policy 2, kind 2 thread t → Stop { 2, Some(t) }; kind 99 → Stop { _, None }; policy 0 vẫn trả Stop { 0, Some(t) }
#[test] fn dispose_body_layout()               // [(5, 2)] sizes 8 → 00000001 0000000000000005 00000002
#[test] fn primitive_texts()                   // ('Z',1) "true"; ('C', 'a') "a"; ('I', u32 -1) "-1"; ('J', ...) ; ('D', 1.5 bits) "1.5"
proptest! { #[test] fn object_ids_match_encoded(values in vec(any_value(), 0..64)) } // encode bằng Writer → object_ids == các id object khác 0 theo thứ tự
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo +1.96 test -p ide-jdwp` → FAIL.
- [ ] **Step 3: Cài đặt.** Mọi đọc kiểm biên, không panic trên dữ liệu lạ.
- [ ] **Step 4: Chạy lại** → PASS.
- [ ] **Step 5: Commit**: `git add Cargo.toml crates/ide-jdwp && git commit -m "feat(debugger): add a JDWP codec that counts object IDs"`

---

### Task 3: `JdwpLink`: chuyển tiếp trong suốt, giữ Resume, theo dõi lần dừng

**Files:**

- Create: `crates/ide-jdwp/src/link/mod.rs`, `crates/ide-jdwp/src/link/upstream.rs`, `crates/ide-jdwp/src/link/downstream.rs`, `crates/ide-jdwp/src/link/tests.rs`

**Interfaces:**

- Consumes: Task 2 (`Header`, `IdSizes`, `stop_of`).
- Produces:

```rust
pub const OWN_IDS: std::ops::Range<u32> = 0x7000_0000..0x7FFF_FFFF;
pub struct LinkOptions { pub hold_resumes: bool }
#[derive(Clone, Debug, PartialEq)] pub enum LinkState { Connecting, Handshaking, Held, Ready, Suspended { generation: u64, thread: Option<u64> }, Degraded(String), Closed }
#[derive(Clone)] pub struct JdwpLink { /* Arc<Inner> */ }
impl JdwpLink {
    pub async fn start(jvm_host: String, jvm_port: u16, options: LinkOptions) -> std::io::Result<(JdwpLink, u16)>; // cổng loopback cho adapter; chờ adapter 60 s như relay cũ
    pub(crate) fn spawn_over<A, J>(adapter: A, jvm: J, options: LinkOptions) -> JdwpLink where A, J: AsyncRead + AsyncWrite + Send + Unpin + 'static;
    pub fn release(&self);
    pub fn state(&self) -> LinkState;
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<LinkState>;
    pub fn generation(&self) -> u64;
}
impl Drop for /* Inner */ // drop handle cuối → abort task, đóng cả hai socket
```

Quy tắc:

- **Lên (adapter → JVM):** handshake 14 byte chuyển nguyên rồi link gửi `IDSizes (1/7)` của nó (id trong `OWN_IDS`). Mỗi gói đọc đủ (độ dài `11..=MAX_ADAPTER_PACKET`, ngoài khoảng → `Closed`), ghi dưới khoá writer chung. `hold_resumes` và chưa `release()`: giữ `1/9`, `11/3` (tối đa 1024, vượt → `Closed`), như `kotlin_jdwp.rs`, kể cả giữ phần gói đang đọc dở khi release. Id của adapter trong `OWN_IDS` → `Degraded("adapter packet id in the reserved range")`, vẫn chuyển tiếp.
- **Kết thúc lần dừng** khi một lệnh sau thật sự được ghi sang JVM: `1/9`, `11/3`, `3/3` (ClassType.InvokeMethod), `3/4` (NewInstance), `5/1` (InterfaceType.InvokeMethod), `9/6` (ObjectReference.InvokeMethod). `1/6` (Dispose) và `1/10` (Exit) → `Closed`.
- **Xuống (JVM → adapter):** đọc header. Reply có id trong `OWN_IDS` → của link (Task 4), không bao giờ tới adapter. Gói `64/100` (độ dài ≤ 1 MiB) đọc đủ, `stop_of` → nếu `suspend_policy != 0` thì `Suspended { generation + 1, thread }`; rồi chuyển tiếp nguyên. Mọi gói khác: ghi header rồi copy đúng `length - 11` byte theo kiểu stream (không giới hạn).
- `Held` từ khi handshake xong tới `release()` khi `hold_resumes`; ngược lại `Ready`. Một bên đóng → `Closed`, đóng bên kia.

- [ ] **Step 1: Viết test thất bại** (`link/tests.rs`, dùng `tokio::io::duplex`; chuyển ba test của `crates/ide-dap/src/kotlin_jdwp.rs` sang đây):

```rust
#[tokio::test] async fn holds_resumes_but_allows_setup_and_preserves_partial_reads() // như test cũ; IDSizes của link nằm trong dải và không ảnh hưởng thứ tự gói của adapter
#[tokio::test] async fn dropping_link_closes_both_sockets()
#[tokio::test] async fn rejects_invalid_adapter_packet_lengths()      // 0, 10, 16 MiB + 1 → Closed
#[tokio::test] async fn forwards_large_jvm_packet_unchanged()         // reply 20 MiB cho id 5 của adapter → adapter nhận đúng 20 MiB byte, bằng nhau
#[tokio::test] async fn own_reply_never_reaches_adapter()             // JVM trả reply IDSizes của link → adapter không nhận byte nào ngoài handshake
#[tokio::test] async fn stop_event_starts_generation_and_resume_ends_it() // event bp policy 2 thread 9 → Suspended{1, Some(9)}; adapter 1/9 → Ready; event lần 2 → generation 2; 9/6 → Ready
#[tokio::test] async fn held_resume_ends_generation_only_when_released()
#[tokio::test] async fn adapter_id_in_reserved_range_degrades()       // gói adapter id 0x7000_0005 → state Degraded, gói vẫn tới JVM
#[tokio::test] async fn vm_dispose_closes_link()
proptest! { #[test] fn passthrough_is_byte_exact(script in adapter_and_jvm_packets()) } // chuỗi gói ngẫu nhiên hai chiều (kể cả event) → mỗi bên nhận đúng byte bên kia gửi, trừ reply của link
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo +1.96 test -p ide-jdwp link` → FAIL.
- [ ] **Step 3: Cài đặt** như Quy tắc; trạng thái phát qua `tokio::sync::watch`.
- [ ] **Step 4: Chạy lại** → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-jdwp && git commit -m "feat(debugger): relay JDWP transparently and track stops"`

---

### Task 4: Lệnh nội bộ của link và sổ ObjectID

**Files:**

- Create: `crates/ide-jdwp/src/link/ledger.rs`, `crates/ide-jdwp/tests/real_jvm.rs`
- Modify: `crates/ide-jdwp/src/link/{mod.rs,downstream.rs,tests.rs}`

**Interfaces:**

- Consumes: Task 2 (`ReplyIds`, `object_ids`, `dispose_body`), Task 3.
- Produces:

```rust
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum LinkError { NotSuspended, Stale, Degraded, Closed, TimedOut, Jdwp(u16), Protocol(String) }
impl JdwpLink {
    /// Một lệnh một lúc; `ids` mô tả chỗ có ObjectID trong reply để sổ đếm, kể cả khi người gọi đã bỏ cuộc.
    pub async fn command(&self, set: u8, cmd: u8, body: Vec<u8>, ids: ReplyIds, timeout: Duration) -> Result<Vec<u8>, LinkError>;
    pub fn id_sizes(&self) -> Option<IdSizes>;
}
pub(crate) struct Ledger { counts: HashMap<u64, u32> }
impl Ledger { pub fn record(&mut self, ids: &[u64]); pub fn drain(&mut self) -> Vec<(u64, u32)>; }
pub const DISPOSE_CHUNK: usize = 1000;
```

Quy tắc `command`:

1. Khoá lệnh (một lệnh một lúc). `Degraded` → `Err(Degraded)`; `Closed` → `Err(Closed)`; không `Suspended` hoặc chưa có `IdSizes` → `Err(NotSuspended)`.
2. Gửi `11/12` với thread của lần dừng (nếu `thread` là `None` thì bỏ bước này); trả về 0 → `Err(NotSuspended)`. Rồi gửi lệnh với id kế tiếp trong `OWN_IDS`.
3. Reader xuống nhận reply của link: lỗi JDWP ≠ 0 → không đếm gì; ngược lại `object_ids(ids, …)` → `Ok` thì `Ledger::record`, `Err` thì **không đếm** (rò rỉ an toàn hơn dispose dư) và `tracing::warn!`. Đếm xảy ra trong reader, không phụ thuộc người gọi còn chờ.
4. Lần dừng kết thúc trong lúc chờ (generation khác) → `Err(Stale)`; hết `timeout` → `Err(TimedOut)`; reply vẫn được đếm khi tới.
5. Khi lần dừng kết thúc (Task 3), **sau khi** gói của adapter đã ghi sang JVM: `drain()` và gửi `1/14` theo lô `DISPOSE_CHUNK`, reply bị bỏ. Khi `Closed` (kể cả do `1/6` của adapter): bỏ sổ, không gửi gì.

- [ ] **Step 1: Viết test thất bại:**

```rust
#[tokio::test] async fn refuses_when_not_suspended()                // Ready → NotSuspended; Suspended nhưng 11/12 trả 0 → NotSuspended
#[tokio::test] async fn one_internal_command_at_a_time()            // hai command song song → JVM giả thấy gói thứ hai chỉ sau reply thứ nhất
#[tokio::test] async fn disposes_exact_counts_after_forwarded_resume() // reply Instances [x, x, y] → adapter 1/9 → JVM nhận 1/9 trước, rồi 1/14 với {(x,2),(y,1)}
#[tokio::test] async fn late_reply_after_resume_is_disposed_once()  // command đang chờ, adapter 1/9 → Err(Stale); reply [x] tới sau; lần dừng kế + resume → đúng một 1/14 có (x,1)
#[tokio::test] async fn malformed_reply_is_leaked_not_disposed()    // reply cụt → Err(Protocol), không 1/14 nào
#[tokio::test] async fn jdwp_error_reply_counts_nothing()           // error 20 → Err(Jdwp(20)), sổ rỗng
#[tokio::test] async fn no_dispose_after_vm_dispose_or_close()
#[tokio::test] async fn disposes_in_chunks_of_1000()                // 2500 id → ba gói 1/14 (1000, 1000, 500)
proptest! { #[test] fn never_disposes_more_than_received(events in interleavings()) } // reply/resume/close xen kẽ ngẫu nhiên → với mọi id: tổng dispose ≤ tổng nhận; sau resume cuối thì bằng
```

`tests/real_jvm.rs` (`#[ignore]`, đọc `OPENIDEA_TEST_JAVA`): ghi `Main.java` (5 object `Main$Item` giữ trong `static List`, vòng lặp gọi `pause()`), chạy `java -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:0 Main.java`, đọc cổng từ dòng `Listening for transport dt_socket at address: N`; `JdwpLink::start` tới cổng đó; test đóng vai adapter bằng codec: handshake, `IDSizes`, `ClassesBySignature("LMain;")`, `Methods`, `EventRequest.Set` breakpoint ở `pause` (policy 2), chờ event. Rồi `link.command(2, 16, Instances(Main$Item, 1000), TaggedObjects)` → 5 id; "adapter" tự đọc `9/1` của cùng các id (phần đếm của nó); adapter `1/9`; sau 1 s: `child.try_wait()` là `None` (JVM không abort); dừng lần hai, `9/1` của adapter trên id cũ vẫn thành công. Kill tiến trình ở cuối kể cả khi assert lỗi.

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo +1.96 test -p ide-jdwp` → FAIL.
- [ ] **Step 3: Cài đặt** như Quy tắc.
- [ ] **Step 4: Chạy lại**: `cargo +1.96 test -p ide-jdwp` → PASS; rồi với từng JDK 11, 17, 21, 25 (và 8 bằng chương trình đã dịch `--release 8` nếu `Main.java` single-file không chạy trên 8): `OPENIDEA_TEST_JAVA=<jdk>/bin/java cargo +1.96 test -p ide-jdwp --test real_jvm -- --ignored` → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-jdwp && git commit -m "feat(debugger): inject JDWP commands and return their object IDs exactly"`

---

### Task 5: `LinkInspector` (JvmInspector qua JdwpLink)

**Files:**

- Create: `crates/ide-jdwp/src/inspector.rs`, `crates/ide-jdwp/src/inspector/tests.rs`
- Modify: `crates/ide-jdwp/Cargo.toml` (dep `ide-jvm-inspect.workspace = true`), `crates/ide-jdwp/src/lib.rs`, `crates/ide-jdwp/tests/real_jvm.rs`

**Interfaces:**

- Consumes: Task 1 (trait, kiểu, hằng, `name_to_signature`, `signature_to_name`, `is_boxed`, `string_length`), Task 4 (`JdwpLink::command`).
- Produces: `pub struct LinkInspector { link: JdwpLink }`, `impl LinkInspector { pub fn new(link: JdwpLink) -> Self }`, `impl ide_jvm_inspect::JvmInspector for LinkInspector` (bỏ qua `target`; generation do `ide-dap` kiểm).

Lệnh JDWP từng thao tác (mọi reply qua `command` với `ReplyIds` ghi bên cạnh):

| Thao tác             | Lệnh                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `class_counts`       | `AllClasses 1/3` (None) → `InstanceCounts 1/21` một gói cho mọi class (None), timeout 120 s; bỏ class đếm 0; tên bằng `signature_to_name`                                                                                                                                                                                                                                           |
| `instances`          | `ClassesBySignature 1/2` (None); không có class → `ClassNotLoaded`; với mỗi class `Instances 2/16` (TaggedObjects) tới khi đủ `min(limit, MAX_INSTANCES)`                                                                                                                                                                                                                           |
| xem trước một object | `ObjectReference.ReferenceType 9/1` (None) → `ReferenceType.Signature 2/1` (cache theo reftype); `String`: field `value`/`coder` của `java/lang/String` (cache), `9/2` (Values) → `ArrayReference.Length 13/1` → `string_length`; ≤ `STRING_PREVIEW_CHARS` thì `StringReference.Value 10/1`, không thì `text: None`; kiểu bọc: `9/2` field `value` → `primitive_text`; mảng: `13/1` |
| `fields`             | object: chuỗi `ClassType.Superclass 3/1` + `ReferenceType.Fields 2/4`, bỏ field static (`modBits & 0x0008`), `9/2` (Values); mảng: `13/1` + `ArrayReference.GetValues 13/2` từ 0, `min(length, ARRAY_PREVIEW)` (ArrayRegion), tên `[i]`                                                                                                                                             |
| `referrers`          | `ReferringObjects 9/10` (TaggedObjects) với `min(limit, MAX_REFERRERS)`; `via`: object → tên field có giá trị là object đích (dùng lại `fields`); mảng ≤ `REFERRER_ARRAY_SCAN` → chỉ số `[i]`                                                                                                                                                                                       |

Ánh xạ lỗi: `LinkError::NotSuspended` → `NotSuspended`; `Stale` → `Stale`; `Degraded` → `Unsupported("the JDWP link stopped inspecting")`; `Closed` → `Closed`; `TimedOut` → `TimedOut`; `Jdwp(20)` → `Collected`; `Jdwp(21)` → `ClassNotLoaded`; còn lại → `Failed`.

- [ ] **Step 1: Viết test thất bại** (`inspector/tests.rs`, JVM giả trả reply theo kịch bản qua `spawn_over`):

```rust
#[tokio::test] async fn previews_strings_boxed_objects_arrays()  // 4 instance → Str{text Some("hi"), length 2}, Boxed{"java.lang.Integer","42"}, Object{"com.x.Foo"}, Array{"int[]", length 3}
#[tokio::test] async fn long_string_preview_reads_length_only()  // value.length 100_000_000, coder 1 → Str{text None, length 50_000_000}; JVM giả không nhận gói 10/1 nào
#[tokio::test] async fn fields_walk_superclasses_and_skip_statics()
#[tokio::test] async fn array_fields_show_first_100()            // mảng 5000 phần tử → 100 field "[0]".."[99]", một gói 13/2 với length 100
#[tokio::test] async fn referrers_name_the_field()               // referrer Owner có field `item` trỏ tới đích → via ["item"]; mảng 3 phần tử chứa đích ở [1] → via ["[1]"]
#[tokio::test] async fn class_counts_send_one_instance_counts_packet() // 600 class → đúng một gói 1/21 chứa 600 reftype; class đếm 0 bị bỏ
#[tokio::test] async fn invalid_object_maps_to_collected()       // 9/1 trả lỗi 20 → Err(Collected)
#[tokio::test] async fn missing_class_is_not_loaded()
```

`tests/real_jvm.rs` (thêm, ignored): qua `LinkInspector` trên JVM thật: `instances("Main$Item", 1000)` → 5 `Object`; `fields` của một instance có field `name` là `Str` với text đúng; `referrers` của instance thứ nhất (giữ trong `ArrayList`) có đúng một referrer là `Array` kiểu `java.lang.Object[]` (mảng `elementData`) với `via == ["[0]"]`; `class_counts` có `Main$Item` = 5.

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo +1.96 test -p ide-jdwp inspector` → FAIL.
- [ ] **Step 3: Cài đặt** như bảng.
- [ ] **Step 4: Chạy lại** unit test và test JVM thật (JDK 11 và 21) → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-jdwp && git commit -m "feat(debugger): list instances and referrers over the JDWP link"`

---

### Task 6: Phiên Kotlin dùng `JdwpLink`

**Files:**

- Delete: `crates/ide-dap/src/kotlin_jdwp.rs`
- Modify: `crates/ide-dap/Cargo.toml` (deps `ide-jdwp`, `ide-jvm-inspect`), `crates/ide-dap/src/lib.rs` (bỏ `mod kotlin_jdwp`; đường khởi động phiên: chỗ dựng `StartupRelay` và chỗ `relay.release()`), `crates/ide-dap/src/session.rs` (struct `Session`, `Session::new`, chỗ `kotlin_relay.lock().take()`)
- Test: `crates/ide-dap/src/tests.rs`

**Interfaces:**

- Consumes: Task 3–5 (`JdwpLink::start`, `LinkOptions`, `release`, `LinkInspector::new`).
- Produces trên `Session`:
  - `pub jdwp_link: parking_lot::Mutex<Option<ide_jdwp::JdwpLink>>` (thay `kotlin_relay`).
  - `pub jvm_inspector: parking_lot::Mutex<Option<Arc<dyn ide_jvm_inspect::JvmInspector>>>`.
  - `pub attach_target: std::sync::OnceLock<(String, u16)>` — `hostName` (rỗng nếu thiếu) và `port` của mọi request `attach` của adapter JVM, ghi **trước** khi Kotlin đổi chúng sang cổng link. Khác `jdwp_port` của M1 (chỉ JVM cục bộ).

- [ ] **Step 1: Viết test thất bại** (`tests.rs`, harness hiện có):

```rust
#[tokio::test] async fn kotlin_session_installs_link_inspector()   // phiên kotlin (launch hoặc attach) → jdwp_link Some, jvm_inspector Some
#[tokio::test] async fn attach_target_recorded_before_kotlin_rewrite() // attach kotlin hostName "10.0.0.5" port 5005 → attach_target ("10.0.0.5", 5005); arguments gửi adapter có hostName 127.0.0.1 và cổng link
#[tokio::test] async fn java_attach_records_target()                // java-debug attach localhost:5005 → ("localhost", 5005); jvm_inspector None
```

Mọi test Kotlin hiện có (giữ Resume tới khi attach xong) phải xanh không sửa assert.

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo +1.96 test -p ide-dap` → FAIL.
- [ ] **Step 3: Cài đặt.** Chỗ cũ dựng `StartupRelay::start(host, port)` → `JdwpLink::start(host, port, LinkOptions { hold_resumes: true })` (fwcd cần; khi có adapter khác ở K0 thì truyền `false`); lưu link, đặt `jvm_inspector = LinkInspector::new(link.clone())`. Chỗ `relay.release()` → `link.release()`. Kết thúc phiên: `jdwp_link.lock().take()` và `jvm_inspector.lock().take()`.
- [ ] **Step 4: Chạy lại**: `cargo +1.96 test -p ide-dap` → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-dap && git commit -m "feat(debugger): debug Kotlin through the JDWP link"` (`git add` đường dẫn đã xoá `crates/ide-dap/src/kotlin_jdwp.rs` cùng thư mục crate).

---

### Task 7: Bundle jdtls `java/jvm-inspect`

**Files:**

- Create: `java/jvm-inspect/MANIFEST.MF`, `java/jvm-inspect/plugin.xml`, `java/jvm-inspect/build.py`, `java/jvm-inspect/build-dependencies.sha256` (bản sao của `java/java-usages/build-dependencies.sha256`: cùng JDT LS 1.63.0), `java/jvm-inspect/README.md`, `java/jvm-inspect/src/ai/openidea/jvminspect/{InspectCommand,ConnectedVms,VmSelector,Handles,Values,RequestTimeout}.java`, `java/jvm-inspect/tests/SelfTest.java`, `java/jvm-inspect/tests/inspect.py`, `java/jvm-inspect/openidea-jvm-inspect.jar`

**Interfaces:**

- Manifest: `Bundle-SymbolicName: ai.openidea.jvminspect;singleton:=true`, `Bundle-Version: 1.0.0`, `Bundle-RequiredExecutionEnvironment: JavaSE-21`, `Require-Bundle: org.eclipse.jdt.ls.core,org.eclipse.core.runtime,org.eclipse.equinox.common,org.eclipse.jdt.debug`. `plugin.xml`: một `delegateCommandHandler` `ai.openidea.jvminspect.InspectCommand` cho `openidea.jvm.vms`, `openidea.jvm.classes`, `openidea.jvm.instances`, `openidea.jvm.fields`, `openidea.jvm.referrers`.
- Giao thức (JSON qua gson). Đối số đầu của mọi lệnh trừ `vms` là `target` = `{"pid": n|null, "host": s|null, "port": n|null, "generation": n}`. Trả `{"ok": <payload>}` hoặc `{"error": "unsupported"|"vmNotFound"|"stale"|"collected"|"classNotLoaded"|"notSuspended"|"timedOut", "detail": s}`. Giá trị có dạng JSON của `JvmValue` (Task 1).

| Lệnh        | Đối số sau `target`  | `ok`                                                                           |
| ----------- | -------------------- | ------------------------------------------------------------------------------ |
| `vms`       | —                    | `[{pid, remoteHost, remotePort, localPort, version, canGetInstanceInfo}]`      |
| `classes`   | —                    | `[{name, instances}]` (bỏ 0), qua `vm.instanceCounts(vm.allClasses())` một lần |
| `instances` | `className`, `limit` | `[JvmValue]`                                                                   |
| `fields`    | `objectId`           | `[{name, value}]`                                                              |
| `referrers` | `objectId`, `limit`  | `[{value, via}]`                                                               |

- Lớp Java (chỉ phần logic có test được tách khỏi JDI):
  - `ConnectedVms.read(Function<String, Class<?>> loader)`: `JdtVirtualMachineManagerProvider#getVirtualMachineManager()` rồi field `connectedVMs`; `socket(VirtualMachine)`: `packetReceiveManager()` → field `fConnection` (tìm lên superclass) → `fSocket`. Mọi `ReflectiveOperationException`/`ClassCastException` → `Unsupported(detail)`.
  - `VmSelector.select(List<VmInfo> vms, Target t)`: launch (`t.pid != null`): khớp `pid`; attach: khớp `remotePort == t.port`, nếu nhiều hơn một thì lọc `remoteHost` thuộc `InetAddress.getAllByName(t.host)` (lỗi phân giải → giữ nguyên); đúng một → chọn, không thì `vmNotFound`. Không dùng danh sách thread.
  - `Handles`: mỗi VM một bảng `id → ObjectReference` của các object bundle đã trả; `generation` khác lần trước → xoá bảng; vượt 100 000 mục → xoá bảng; id không có trong bảng → `stale`.
  - `Values.stringPreview(int arrayLength, Integer coder, Supplier<String> text)` và các quy tắc xem trước như Task 5 (kiểu bọc đọc field `value`, mảng chỉ `length()`, không `invokeMethod`).
  - `RequestTimeout.raise(Knob k, int ms)` trả `AutoCloseable`: đặt `max(cũ, ms)`, khi đóng chỉ trả lại `cũ` nếu giá trị hiện tại vẫn là giá trị đã đặt; `Knob` bọc `org.eclipse.jdi.VirtualMachine#get/setRequestTimeout`. Dùng với `60 000` trong `classes` và `referrers`.
  - `InspectCommand`: `synchronized` theo VM (một lệnh mỗi VM); `notSuspended` khi không thread nào `isSuspended()`; `ObjectCollectedException` → `collected`; `org.eclipse.jdi.TimeoutException` → `timedOut`; `vm.canGetInstanceInfo() == false` → `unsupported`.
- `build.py /path/to/jdtls [--test]`: như `java/java-usages/build.py`, thêm `jdimodel.jar` (giải nén từ `plugins/org.eclipse.jdt.debug_*.jar` vào thư mục tạm) vào classpath; `--test` dịch `tests/SelfTest.java` cùng nguồn và chạy nó.

- [ ] **Step 1: Viết test thất bại** `tests/SelfTest.java` (main thuần, không JUnit; mỗi ca in `PASS <name>` hoặc ném lỗi):

```java
selector_matches_launch_pid();                 // [{pid 10}, {pid 11}], target pid 11 → vm thứ hai
selector_matches_attach_port_not_threads();    // hai VM pid null, port 59246 / 59247 (giống G1) → target port 59247 → vm thứ hai
selector_filters_same_port_by_host();          // hai VM cùng port 5005, host 127.0.0.1 và 10.0.0.5; target host "localhost" → vm thứ nhất
selector_reports_vm_not_found();               // không khớp, hoặc hai VM cùng port và host → vmNotFound
connected_vms_missing_field_is_unsupported();  // loader trả class giả không có `connectedVMs` → Unsupported, detail chứa "connectedVMs"
request_timeout_raised_and_restored();         // knob 3000 → trong khối 60000 → sau 3000; knob đổi thành 5000 trong khối → sau vẫn 5000
handles_cleared_on_new_generation();           // put(gen 1, id 7) → get(gen 1, 7) có; get(gen 2, 7) → stale
string_preview_rule();                         // (2000, coder 1) → length 1000, text đọc; (2002, 1) → length 1001, text không đọc (Supplier không được gọi)
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `PATH=<jdk25>/bin:$PATH python3 java/jvm-inspect/build.py <jdtls 1.63.0> --test` → FAIL (chưa có lớp).
- [ ] **Step 3: Cài đặt** các lớp và `InspectCommand`; build jar; build hai lần, so SHA-256, ghi vào README cùng danh sách API nội bộ dùng tới (`JdtVirtualMachineManagerProvider`, `AdvancedVirtualMachineManager.connectedVMs`, `VirtualMachineImpl.packetReceiveManager()`, `PacketManager.fConnection`, `SocketConnection.fSocket`, `org.eclipse.jdi.VirtualMachine#setRequestTimeout`), cách build lại và cách chạy harness. Ghi rõ: không ghim java-debug; mọi điểm reflection gãy → `unsupported`.
- [ ] **Step 4: Chạy lại** `build.py --test` → mọi dòng `PASS`. Rồi harness JDT LS thật: `python3 java/jvm-inspect/tests/inspect.py <jdtls 1.63.0> <com.microsoft.java.debug.plugin-0.53.2.jar>` (biến `OPENIDEA_TEST_JAVA` liệt kê JDK debuggee, ví dụ 11 và 21) kiểm: `vms` rỗng khi chưa có phiên; launch chọn theo pid; hai attach cùng chương trình mỗi cái lấy đúng VM theo cổng; `instances` của `Heap$Live` = min(n, 1000); `fields` có `v`; `referrers` của một instance trả mảng giữ nó, `via` là một chỉ số dạng `"[i]"`; `classes` trên JDK 11 khi dừng; `--heap 10000000` trên JDK 21: một `evaluate` DAP gửi 0,5 s sau khi `classes` bắt đầu thành công, và `vms` sau đó báo `timeout == 3000`. Kết quả mong đợi: in `OK` cho từng mục.
- [ ] **Step 5: Commit**: `git add java/jvm-inspect && git commit -m "feat(debugger): add the jdtls bundle that inspects java-debug's JVM"`

---

### Task 8: Cài bundle và client Rust trong `ide-lsp`

**Files:**

- Modify: `crates/ide-sdk/src/java.rs` (`usages_bundle`, `clean_usages_bundles`, test `usages_bundle_tests`), `crates/ide-host/src/project.rs` (chuỗi `bundles` cạnh `usages_bundle`), `crates/ide-lsp/Cargo.toml` (dep `ide-jvm-inspect`), `crates/ide-lsp/src/jdtls.rs` (`java_debug_server`, struct giữ state của `LspManager`), `crates/ide-lsp/src/jdtls/mod.rs` hoặc chỗ khai báo module con cạnh `hierarchy`
- Create: `crates/ide-lsp/src/jdtls/jvm_inspect.rs`
- Test: `crates/ide-sdk/src/java.rs` (tests), `crates/ide-lsp/tests/mock_server.rs`

**Interfaces:**

- Consumes: Task 1 (trait, kiểu), Task 7 (giao thức, tên lệnh, jar).
- Produces:
  - `fn install_bundle(data_dir: &Path, stem: &str, version: &str, bytes: &'static [u8]) -> Option<PathBuf>` và `fn clean_bundles(data_dir: &Path, stem: &str, current: &Path)` (tổng quát hoá phần thân hiện có của `usages_bundle`/`clean_usages_bundles`, hành vi không đổi); `pub fn usages_bundle(data_dir)` gọi `install_bundle(data_dir, "java-usages", "1.7.0", …)`; `pub fn jvm_inspect_bundle(data_dir: &Path) -> Option<PathBuf>` cài `jvm-inspect-1.0.0.jar` từ `include_bytes!("../../../java/jvm-inspect/openidea-jvm-inspect.jar")`.
  - `LspManager::java_debug_server` ghi `port → path`; `pub fn java_debug_server_module(&self, port: u16) -> Option<PathBuf>`.
  - `pub struct JdtJvmInspector { lsp: Arc<LspManager>, server: PathBuf }`, `impl JdtJvmInspector { pub fn new(lsp: Arc<LspManager>, server: PathBuf) -> Self }`, `impl JvmInspector for JdtJvmInspector`. Gọi `jdtls_command(server, "openidea.jvm.<op>", [target, …])` bọc `tokio::time::timeout`: `classes` 90 s, `referrers` 90 s, `instances` 30 s, `fields` 15 s. `{"error": e}` → `InspectError` cùng tên; lỗi "no delegateCommandHandler"/"unsupported command" (như `missing_bundle`) → `Unsupported("the JVM inspector bundle is not loaded")`; hết giờ → `TimedOut`.

- [ ] **Step 1: Viết test thất bại:**

```rust
// ide-sdk
#[test] fn jvm_inspect_bundle_installs_and_cleans_old_versions() // thư mục có jvm-inspect-0.9.0.jar và java-usages-1.7.0.jar → cài jvm-inspect-1.0.0.jar, xoá 0.9.0, không đụng java-usages
// mọi test usages_bundle_tests hiện có vẫn xanh
// ide-lsp mock_server.rs
#[tokio::test] async fn jvm_inspect_instances_round_trip()        // mock jdtls trả {"ok":[{"kind":"object","id":7,"typeName":"Foo"}]} → Vec<JvmValue>; đối số đầu là {"pid":null,"host":"localhost","port":5005,"generation":3}
#[tokio::test] async fn jvm_inspect_error_maps_to_inspect_error() // {"error":"stale"} → InspectError::Stale; {"error":"unsupported","detail":"x"} → Unsupported("x")
#[tokio::test] async fn jvm_inspect_missing_bundle_is_unsupported()
#[tokio::test] async fn debug_server_port_maps_to_module()        // java_debug_server(path) trả 4711 → java_debug_server_module(4711) == Some(path)
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo +1.96 test -p ide-sdk java` và `cargo +1.96 test -p ide-lsp --test mock_server jvm_inspect` → FAIL.
- [ ] **Step 3: Cài đặt** như Interfaces; thêm `.chain(ide_sdk::java::jvm_inspect_bundle(&data_dir))` vào danh sách bundle trong `project.rs`.
- [ ] **Step 4: Chạy lại** hai lệnh trên và `cargo +1.96 test -p ide-host project` → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-sdk/src/java.rs crates/ide-host/src/project.rs crates/ide-lsp && git commit -m "feat(debugger): load the JVM inspector bundle into jdtls"`

---

### Task 9: API inspect, dự phòng bảng class, capability và sự kiện trong `ide-dap`

**Files:**

- Create: `crates/ide-dap/src/jvm_memory/inspect.rs`, `crates/ide-dap/src/jvm_memory/fallback.rs`
- Modify: `crates/ide-dap/src/jvm_memory/mod.rs` (kiểu, `session_classes`), `crates/ide-dap/src/jvm_memory/snapshot.rs` (`diff_rows`, baseline trong `JvmMemoryState`), `crates/ide-dap/src/jvm_memory/tests.rs`, `crates/ide-dap/src/lib.rs` (`DebugCapabilities`, `capabilities_from`, `capabilities()`, method mới của `DebugManager`), `crates/ide-dap/src/session.rs` (khoá inspect), `crates/ide-core/src/event.rs` (`DebugEvent`)
- Test: `crates/ide-dap/src/jvm_memory/tests.rs`, `crates/ide-dap/src/tests.rs`

**Interfaces:**

- Consumes: Task 1, Task 6 (`jvm_inspector`, `attach_target`, `jdwp_link`), M1 (`stop_seq`, `suspended`, `debuggee_pid`, `take_snapshot`, `JvmMemoryUnavailable` gồm `ListenModeNotSupported`).
- Produces (serde như M1):

```rust
// ide-core event.rs
pub enum JvmBackendState { Ready, Unsupported { detail: String }, Degraded { detail: String }, Closed }
DebugEvent::Capabilities                       // không field: frontend tải lại capability
DebugEvent::JvmBackend { state: JvmBackendState }
// ide-dap
pub struct JvmObjectRef { pub generation: u64, pub id: u64 }
pub enum JvmInspectUnavailable { NoBackend, Unsupported { detail: String }, NotSuspended, Stale, Collected, ClassNotLoaded, VmNotFound, TimedOut, BackendClosed }
pub enum JvmInstancesResult { Ready { generation: u64, instances: Vec<JvmValue>, truncated: bool }, Unavailable { reason: JvmInspectUnavailable } }
pub enum JvmFieldsResult { Ready { fields: Vec<JvmField> }, Unavailable { reason: JvmInspectUnavailable } }
pub enum JvmReferrersResult { Ready { referrers: Vec<JvmReferrer>, truncated: bool }, Unavailable { reason: JvmInspectUnavailable } }
pub enum JvmMemorySource { Histogram, Debugger }            // JvmMemorySnapshot thêm `pub source: JvmMemorySource`
JvmMemoryResult::Unavailable { reason, can_count_when_paused: bool }  // true khi có inspector, phiên đang chạy và reason thuộc FALLBACK_REASONS
DebugCapabilities { …, pub jvm_instances: bool }            // = session.jvm_inspector.is_some()
impl DebugManager {
    pub fn set_jvm_inspector(&self, s: DebugSessionId, inspector: Arc<dyn JvmInspector>) -> IdeResult<()>; // emit Capabilities
    pub async fn jvm_memory_instances(&self, s: DebugSessionId, class_name: String, limit: u32) -> IdeResult<JvmInstancesResult>;
    pub async fn jvm_memory_fields(&self, s: DebugSessionId, object: JvmObjectRef) -> IdeResult<JvmFieldsResult>;
    pub async fn jvm_memory_referrers(&self, s: DebugSessionId, object: JvmObjectRef, limit: u32) -> IdeResult<JvmReferrersResult>;
}
pub(crate) fn vm_target(s: &Session) -> VmTarget  // launch: pid = debuggee_pid (>0); attach: host/port = attach_target; generation = stop_seq
pub(crate) const FALLBACK_REASONS: &[&str]        // kind: unsafeWhileSuspended, unsupportedPlatform, attachedJvmNotFound, listenerNotRunning, listenModeNotSupported, noJvmProcess
```

Quy tắc:

- Instance/field/referrer: không có inspector → `NoBackend`; `!suspended` → `NotSuspended`; `object.generation != stop_seq` → `Stale`; giữ khoá inspect của phiên (một yêu cầu một lúc); gọi inspector; `stop_seq` đổi trong lúc chờ → `Stale`. `limit` kẹp vào `1..=MAX_INSTANCES` / `1..=MAX_REFERRERS` (0 → `DEFAULT_REFERRERS`). `truncated = len == limit`.
- `InspectError::Unsupported(d)` lần đầu: bỏ inspector khỏi phiên, emit `JvmBackend { Unsupported { detail: d } }` rồi `Capabilities`. Link Kotlin: một task theo `link.subscribe()` phát `JvmBackend { Degraded }` / `{ Closed }` (khi phiên còn sống).
- Bảng class: kết quả attach của M1 là `Unavailable(reason)` với `reason` trong `FALLBACK_REASONS`, phiên có inspector và đang dừng → `inspector.class_counts(vm_target)` → hàng `bytes = 0`, `module = None`, `source = Debugger`, `taken_while_suspended = true`. Không dừng → `Unavailable { reason, can_count_when_paused: true }`. Lỗi inspector → `Unavailable` với reason gốc. Thứ tự giữ nguyên M1 cho mọi trường hợp histogram chạy được.
- Baseline: `JvmMemoryState.previous` giữ cả `JvmMemorySource`; khác nguồn → không delta, `has_baseline = false`.

- [ ] **Step 1: Viết test thất bại** (`FakeInspector` ghi lại `VmTarget` và trả kết quả theo kịch bản):

```rust
#[tokio::test] async fn instances_need_a_suspended_session()       // running → Unavailable(NotSuspended), inspector không được gọi
#[tokio::test] async fn object_from_previous_stop_is_stale()       // instances ở stop 1 (generation 1) → stopped lần 2 → fields(ref gen 1) → Stale, inspector không được gọi
#[tokio::test] async fn stop_during_request_is_stale()             // FakeInspector chờ; giữa chừng có stopped → Stale
#[tokio::test] async fn target_carries_pid_for_launch()            // java-debug launch, processid 4242 → VmTarget { pid: Some(4242), attach_*: None }
#[tokio::test] async fn target_carries_attach_port_and_host()      // attach hostName "10.0.0.5" port 5005 → pid None, host Some("10.0.0.5"), port Some(5005)
#[tokio::test] async fn unsupported_backend_turns_instances_off()  // Unsupported("x") → event JvmBackend{Unsupported{"x"}} rồi Capabilities; capabilities().jvm_instances == false; lần gọi sau → NoBackend
#[tokio::test] async fn limits_are_clamped()                       // limit 5000 → inspector nhận 1000; referrers 0 → 50, 900 → 200
#[tokio::test] async fn suspended_jdk11_falls_back_to_debugger_counts() // probe M1 trả UnsafeWhileSuspended{11} + inspector [("A", 3), ("B", 0)] → Ready, source Debugger, một hàng A, bytes 0
#[tokio::test] async fn running_without_listener_offers_counting_when_paused() // ListenerNotRunning, đang chạy, có inspector → Unavailable{ListenerNotRunning, canCountWhenPaused: true}
#[test] fn deltas_only_against_the_same_source()                   // baseline Histogram rồi snapshot Debugger → mọi delta None, has_baseline false
#[test] fn capability_follows_the_inspector()                      // set_jvm_inspector → jvm_instances true và emit Capabilities
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo +1.96 test -p ide-dap jvm_memory` → FAIL.
- [ ] **Step 3: Cài đặt** như Quy tắc. Không phải unix: M1 trả `UnsupportedPlatform`, rồi đi đường dự phòng như trên (Windows có bảng class qua debugger khi đang dừng).
- [ ] **Step 4: Chạy lại**: `cargo +1.96 test -p ide-dap` và `cargo +1.96 test -p ide-core` → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-dap crates/ide-core/src/event.rs && git commit -m "feat(debugger): list a debugged JVM's instances and fall back to debugger counts"`

---

### Task 10: Gắn bundle cho phiên java-debug, lệnh IPC và bindings

**Files:**

- Modify: `crates/ide-host/Cargo.toml` (dep `ide-jvm-inspect`), `crates/ide-host/src/ops/debug.rs` (`debug_start`, op mới cạnh `debug_jvm_memory_classes`, `register`, tests cuối file), `src-tauri/src/commands/debug.rs`, `src-tauri/src/commands/mod.rs`, `src/bindings.ts` (sinh lại)

**Interfaces:**

- Consumes: Task 8 (`JdtJvmInspector::new`, `java_debug_server_module`), Task 9 (`set_jvm_inspector`, ba method, kiểu kết quả).
- Produces:
  - `fn debug_server_port(config: &LaunchConfig) -> Option<u16>` (ide-host, private): `adapter == "java-debug"` và `extra_json.debugServer` là số khác 0 (chuỗi `"host:port"` → `None`: adapter ở máy khác).
  - Trong `debug_start`, sau khi `host.debugger.start` trả `id`: nếu có `debug_server_port` và `project.lsp.java_debug_server_module(port)` → `set_jvm_inspector(id, Arc::new(JdtJvmInspector::new(project.lsp.clone(), module)))`. Lỗi chỉ `tracing::debug!`.
  - Op (mỗi op gọi `host.require_trust(window)?`), đăng ký với tên và đối số: `"debug_jvm_memory_instances"` (`session`, `className`, `limit`), `"debug_jvm_memory_fields"` (`session`, `object`), `"debug_jvm_memory_referrers"` (`session`, `object`, `limit`).
  - Tauri cùng tên; TS: `commands.debugJvmMemoryInstances(session, className, limit)`, `commands.debugJvmMemoryFields(session, object)`, `commands.debugJvmMemoryReferrers(session, object, limit)`.

- [ ] **Step 1: Viết test thất bại** (`ops/debug.rs`, dùng helper `launch(adapter, request, extra)` có sẵn):

```rust
#[test] fn debug_server_port_only_for_local_java_debug() {
    assert_eq!(debug_server_port(&launch("java-debug", "launch", serde_json::json!({"debugServer": 4711}))), Some(4711));
    assert_eq!(debug_server_port(&launch("java-debug", "attach", serde_json::json!({"debugServer": 4711}))), Some(4711));
    assert_eq!(debug_server_port(&launch("java-debug", "launch", serde_json::json!({"debugServer": "10.0.0.5:4711"}))), None);
    assert_eq!(debug_server_port(&launch(ide_dap::kotlin::ADAPTER, "launch", serde_json::json!({"debugServer": 4711}))), None);
    assert_eq!(debug_server_port(&launch("java-debug", "launch", serde_json::json!({}))), None);
}
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo +1.96 test -p ide-host debug` → FAIL.
- [ ] **Step 3: Cài đặt** như Interfaces; thêm lệnh Tauri và liệt kê trong `mod.rs`.
- [ ] **Step 4: Chạy lại và sinh bindings**: `cargo +1.96 test -p ide-host debug` → PASS; `pnpm gen:bindings` → `src/bindings.ts` có ba lệnh mới, các kiểu `JvmValue`, `JvmObjectRef`, `JvmInstancesResult`, `JvmFieldsResult`, `JvmReferrersResult`, `JvmInspectUnavailable`, `JvmMemorySource`, `JvmBackendState`; `DebugCapabilities` có `jvmInstances`; `DebugEvent` có `capabilities` và `jvmBackend`; `JvmMemoryResult` unavailable có `canCountWhenPaused`.
- [ ] **Step 5: Commit**: `git add crates/ide-host src-tauri/src/commands/debug.rs src-tauri/src/commands/mod.rs src/bindings.ts && git commit -m "feat(debugger): expose JVM instances and referrers over IPC"`

---

### Task 11: Store instance và xử lý sự kiện phía frontend

**Files:**

- Create: `src/features/debugger/memory/instancesState.ts`, `src/features/debugger/memory/values.ts`
- Modify: `src/features/debugger/state.ts` (`DebugSession`, `handleDebugEvent`), `src/features/debugger/index.ts` hoặc chỗ `activate()` đang gọi `forgetMemory`
- Test: `src/features/debugger/__tests__/instancesState.test.ts`, `src/features/debugger/__tests__/memoryValues.test.ts`, `src/features/debugger/__tests__/executionState.test.ts` (hoặc test hiện có của `handleDebugEvent`)

**Interfaces:**

- Consumes: bindings Task 10, `call`, `useDebug` (`stops`).
- Produces:
  - `values.ts`: `export function formatJvmValue(v: JvmValue): string` (`null`; nguyên thuỷ: `text`; string có text: `"text"` (JSON-escape); string dài: `tx` "String ({n} chars)"; kiểu bọc: `text`; object: `<tên ngắn>@<id>` với tên ngắn = phần sau dấu `.` cuối; mảng: `int[3]`, `String[][2]` (bỏ cặp `[]` cuối của `typeName` rồi thêm `[length]`)); `export function objectRef(generation: number, v: JvmValue): JvmObjectRef | null`; `export function refKey(r: JvmObjectRef): string` (`"gen:id"`).
  - `instancesState.ts`: `export interface NodeEntry { fields: JvmFieldsResult | null; referrers: JvmReferrersResult | null; loadingFields: boolean; loadingReferrers: boolean; error: string | null }`; `export interface InstancesEntry { className: string; result: JvmInstancesResult | null; loading: boolean; error: string | null; takenAtStop: number; nodes: Record<string, NodeEntry> }`; `export const useInstances` (zustand, `bySession: Record<DebugSessionId, InstancesEntry>`); `export async function showInstances(id: DebugSessionId, className: string): Promise<void>` (limit 1000); `export function closeInstances(id)`; `export async function loadFields(id, ref: JvmObjectRef)`; `export async function loadReferrers(id, ref: JvmObjectRef)` (limit 50); `export function forgetInstances(id)`; `export function instancesOutdated(e: InstancesEntry, stops: number): boolean`.
  - `DebugSession` thêm `jvmBackend?: JvmBackendState`. `handleDebugEvent`: `case "capabilities": void loadCapabilities(id)`; `case "jvmBackend": patch(id, { jvmBackend: event.state })`.

- [ ] **Step 1: Viết test thất bại:**

```ts
it("formats values without calling toString", () => {
  expect(formatJvmValue({ kind: "object", id: 12, typeName: "com.x.Order" })).toBe("Order@12");
  expect(formatJvmValue({ kind: "array", id: 3, typeName: "java.lang.String[][]", length: 2 })).toBe("String[][2]");
  expect(formatJvmValue({ kind: "string", id: 4, text: 'a"b', length: 3 })).toBe('"a\\"b"');
  expect(formatJvmValue({ kind: "string", id: 5, text: null, length: 50000000 })).toBe("String (50,000,000 chars)");
  expect(formatJvmValue({ kind: "boxed", id: 6, typeName: "java.lang.Integer", text: "42" })).toBe("42");
});
it("showInstances stores the result and the stop it was taken at", ...)        // mock commands.debugJvmMemoryInstances; stops 3 → takenAtStop 3, gọi với limit 1000
it("a new class replaces the previous instances and their nodes", ...)
it("loadFields keys nodes by generation and id", ...)                           // nodes["2:7"].fields
it("a late reply for a closed or replaced list is ignored", ...)
it("loadReferrers asks for 50", ...)
it("capabilities event reloads capabilities; jvmBackend event is stored", ...)  // handleDebugEvent → commands.debugCapabilities được gọi; session.jvmBackend == state
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `pnpm vitest run src/features/debugger/__tests__/instancesState.test.ts src/features/debugger/__tests__/memoryValues.test.ts` → FAIL.
- [ ] **Step 3: Cài đặt.** Theo mẫu `memoryState.ts` (token chống reply muộn). `forgetInstances` gọi cùng chỗ với `forgetMemory`. Số trong "String ({n} chars)" dùng `formatCount` của `rows.ts`.
- [ ] **Step 4: Chạy lại** lệnh trên và test của `handleDebugEvent` → PASS; `pnpm typecheck` → 0 lỗi.
- [ ] **Step 5: Commit**: `git add src/features/debugger/memory/instancesState.ts src/features/debugger/memory/values.ts src/features/debugger/state.ts src/features/debugger/__tests__/instancesState.test.ts src/features/debugger/__tests__/memoryValues.test.ts <file activate và test sự kiện đã sửa> && git commit -m "feat(debugger): keep JVM instance lists per debug session"`

---

### Task 12: Khung instance, referrer, nhảy tới source và bảng class dự phòng trong UI

**Files:**

- Create: `src/features/debugger/memory/InstancesPane.tsx`, `src/features/debugger/memory/InstancesPane.module.css`, `src/features/debugger/memory/jumpToClass.ts`
- Modify: `src/features/debugger/memory/MemoryView.tsx`, `src/features/debugger/memory/MemoryView.module.css`, `src/features/debugger/memory/rows.ts` (cột theo nguồn), `src/features/debugger/actions.ts`, `src/platform/locales/text/en.json`, `src/platform/locales/text/zh.json`
- Test: `src/features/debugger/__tests__/memoryView.test.tsx`, `src/features/debugger/__tests__/instancesPane.test.tsx`

**Interfaces:**

- Consumes: Task 11; `sessionSupports("jvmInstances", session)`; `List`, `IconButton`, `Icon`, `T` từ `@/ui`; `maybeEditorService` từ `@/workbench/contributions`; `commands.lspWorkspaceSymbols`, `nextRequestId` từ `@/platform/ipc`.
- Produces:
  - `export function InstancesPane({ session }: { session: DebugSession })`.
  - `export async function jumpToClass(className: string): Promise<boolean>`: tên bỏ phần mảng `[]` và lấy class ngoài cùng trước `$`; `lspWorkspaceSymbols(nextRequestId(), simpleName)`; chọn ký hiệu có `name === simpleName`, `kind` là class/interface/enum/struct và `container` bằng package (hoặc kết thúc bằng package); mở `maybeEditorService()?.openFile(location.path, { selection: { line, col } })`; không tìm thấy → `false` và notification "Could not find the source of {name}.".
  - Action `debug.memory.showInstances` (title "Show Instances", category "Debug", `when: "debugSessionPaused"`, không phím mặc định; chạy cho dòng đang chọn của Memory view). Action `debug.memory.jumpToSource` (title "Jump to Source" — dùng chuỗi đã có, thêm vào `en.json` nếu thiếu).

Hành vi:

- Bảng class: chọn dòng bằng click/phím mũi tên; Enter, double-click hoặc nút icon "Show Instances" trên dòng (chỉ khi `jvmInstances`) → `showInstances`. `snapshot.source === "debugger"`: ẩn cột Shallow Size, chân bảng ghi "Counted by the debugger: reachable objects only, no sizes." thay câu của histogram. Đang tải mà `jvmInstances` và phiên đang dừng: dòng trạng thái "Counting objects through the debugger. This can take several seconds on a large heap.". `unavailable` với `canCountWhenPaused`: thêm câu "Pause the program to count objects through the debugger." sau lý do M1.
- Khung instance (dưới bảng, chiều cao cố định theo token, nút đóng): tiêu đề "Instances of {name}", nút "Jump to Source", danh sách ảo hoá; mỗi instance là một nút cây: mở ra gọi `loadFields` (một cấp; field là object thì mở tiếp được), nút "Show Referrers" gọi `loadReferrers` và hiện danh sách con "Referrers" (mỗi dòng: giá trị + `via` nối bằng `, `). `truncated`: "Showing the first {n} instances.". `instancesOutdated`: banner "These values are from before the last stop. Show the instances again to update them." và vô hiệu nút mở.
- `session.jvmBackend` là `unsupported`/`degraded`/`closed`: banner tương ứng ở đầu tab, bảng class (attach) vẫn chạy.

Chuỗi (en → zh), thêm cả hai file:

| en                                                                                    | zh                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Show Instances                                                                        | 显示实例                                         |
| Instances of {name}                                                                   | {name} 的实例                                    |
| Showing the first {n} instances.                                                      | 仅显示前 {n} 个实例。                            |
| Show Referrers                                                                        | 显示引用者                                       |
| Referrers                                                                             | 引用者                                           |
| No referrers                                                                          | 没有引用者                                       |
| Close Instances                                                                       | 关闭实例列表                                     |
| String ({n} chars)                                                                    | String（{n} 个字符）                             |
| Could not find the source of {name}.                                                  | 找不到 {name} 的源代码。                         |
| These values are from before the last stop. Show the instances again to update them.  | 这些值来自上次暂停之前。请重新显示实例以更新。   |
| Pause the program to see instances.                                                   | 暂停程序以查看实例。                             |
| The object has been garbage collected.                                                | 该对象已被垃圾回收。                             |
| The class is not loaded in the JVM.                                                   | JVM 中未加载该类。                               |
| This debugger cannot list instances.                                                  | 此调试器无法列出实例。                           |
| The debugger cannot list instances: {detail}                                          | 调试器无法列出实例：{detail}                     |
| Could not tell which JVM this session debugs.                                         | 无法确定此会话调试的是哪个 JVM。                 |
| The JVM did not answer in time.                                                       | JVM 未能及时响应。                               |
| The connection to the JVM is closed.                                                  | 与 JVM 的连接已关闭。                            |
| The debugger link stopped reading the JVM. Debugging continues.                       | 调试器链接已停止读取 JVM。调试仍在继续。         |
| Counting objects through the debugger. This can take several seconds on a large heap. | 正在通过调试器统计对象。堆较大时可能需要几秒钟。 |
| Counted by the debugger: reachable objects only, no sizes.                            | 由调试器统计：仅包含可达对象，不含大小。         |
| Pause the program to count objects through the debugger.                              | 暂停程序以通过调试器统计对象。                   |

Ánh xạ lý do: `noBackend` → "This debugger cannot list instances."; `unsupported` → "The debugger cannot list instances: {detail}"; `notSuspended` → "Pause the program to see instances."; `stale` → câu "These values are from before the last stop…"; `collected`, `classNotLoaded`, `vmNotFound`, `timedOut`, `backendClosed` → các câu tương ứng ở bảng.

- [ ] **Step 1: Viết test thất bại:**

```ts
// memoryView.test.tsx
it("opens the instances of the selected class with Enter", ...)        // jvmInstances true, chọn "com.x.Order", Enter → commands.debugJvmMemoryInstances(id, "com.x.Order", 1000)
it("has no Show Instances button without jvmInstances", ...)
it("hides Shallow Size for debugger counts", ...)                      // source "debugger" → không có columnheader "Shallow Size"; chân bảng có "Counted by the debugger…"
it("offers counting when paused", ...)                                 // unavailable { listenerNotRunning, canCountWhenPaused: true } → có "Pause the program to count objects through the debugger."
// instancesPane.test.tsx
it("lists instances with previews", ...)                               // "Order@12", "\"hi\"", "42", "int[3]"
it("expands fields one level on demand", ...)                          // mở Order@12 → debugJvmMemoryFields(id, { generation: 2, id: 12 }) một lần; field "items" hiện "ArrayList@15"
it("shows referrers with the field that points at the object", ...)    // via ["orders"] → "Book@3 · orders"
it("marks the list outdated after another stop", ...)                  // tăng stops → banner, nút mở bị vô hiệu
it("explains a collected object", ...)                                 // fields → unavailable { kind: "collected" } → "The object has been garbage collected."
it("shows Chinese text in zh", ...)                                    // locale zh → "显示实例", "引用者"
// jumpToClass
it("opens the class whose package matches", ...)                       // hai ký hiệu Order (com.a, com.x) → mở com.x
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `pnpm vitest run src/features/debugger/__tests__/memoryView.test.tsx src/features/debugger/__tests__/instancesPane.test.tsx` → FAIL.
- [ ] **Step 3: Cài đặt** view, action, chuỗi. Token trong `src/styles/tokens.css`; cây dùng `role="tree"`/`treeitem` với `aria-expanded`; nút icon có `aria-label`.
- [ ] **Step 4: Chạy lại** hai lệnh trên, `pnpm vitest run src/platform/locales` → PASS; `pnpm typecheck`, `pnpm lint`, `pnpm knip` → 0 lỗi.
- [ ] **Step 5: Commit**: `git add src/features/debugger/memory src/features/debugger/actions.ts src/platform/locales/text/en.json src/platform/locales/text/zh.json src/features/debugger/__tests__/memoryView.test.tsx src/features/debugger/__tests__/instancesPane.test.tsx && git commit -m "feat(debugger): show JVM instances, fields and referrers in the Memory view"`

---

### Task 13: Smoke, kiểm tra toàn bộ, xác minh trong app và PR

**Files:**

- Modify: `smoke/debug.test.ts` (kiểu `CASES`, hàm `smoke`)

**Interfaces:**

- Consumes: `commands.debugJvmMemoryInstances`, `commands.debugJvmMemoryFields`, `commands.debugJvmMemoryReferrers` (Task 10).

- [ ] **Step 1: Thêm vào smoke**: trường `instances?: { className: string; count: number; field: string }`; java `{ className: "com.example.orders.OrderBook", count: 1, field: "orders" }`, kotlin `{ className: "com.example.library.Book", count: 3, field: "title" }`. Sau bước memory của M1 (phiên đang dừng): `debugJvmMemoryInstances(s.id, className, 1000)` → `ready` và đúng `count` instance; `debugJvmMemoryFields` của instance đầu có field `field`; `debugJvmMemoryReferrers` của instance đầu `ready` và có ít nhất một referrer. `unavailable` là lỗi kèm `shown()`.
- [ ] **Step 2: Chạy smoke**: `cargo build -p ide-host --bin openidea-server`, rồi `pnpm smoke smoke/debug.test.ts -t java` và `pnpm smoke smoke/debug.test.ts -t kotlin` → PASS.
- [ ] **Step 3: Kiểm tra như CI** (từng lệnh một): `cargo fmt --all --check`; `cargo clippy --workspace --all-targets -- -D warnings`; `cargo nextest run --workspace`; `pnpm typecheck`; `pnpm lint`; `pnpm format:check`; `pnpm knip`; `pnpm test`; `pnpm build`. Mọi lệnh → 0 lỗi. Chạy lại test JVM thật của `ide-jdwp` (Task 4–5) và harness bundle (Task 7) với JDK 11 và 21.
- [ ] **Step 4: Xác minh trong app** bằng skill `verify` (Tauri MCP, `pnpm dev:status` để lấy cổng): `fixtures/java-app` dừng ở "Set a breakpoint here" → Memory → chọn `com.example.orders.OrderBook` → Show Instances → mở instance thấy `orders`, Show Referrers; Jump to Source mở `OrderBook.java`; Resume rồi dừng lại → banner outdated. `fixtures/kotlin-gradle`: `Book` 3 instance, field `title`. Phiên Java chạy JDK 11 (đặt JDK dự án 11 hoặc attach vào JVM JDK 11 tự chạy với agent JDWP) dừng ở breakpoint → bảng class có số liệu nguồn debugger, cột Shallow Size ẩn. Chụp ảnh sáng/tối và zh.
- [ ] **Step 5: Commit**: `git add smoke/debug.test.ts && git commit -m "feat(debugger): smoke-test JVM instances and referrers"`. Không mở PR: PR chung mở sau mốc cuối; lưu lệnh ở Step 2–3, kết quả test JVM thật và đường dẫn ảnh ở Step 4 vào report để đưa vào mục **How it was verified**.

---

## Sửa spec đề xuất (đã duyệt và áp vào spec)

1. **§7 "Ánh xạ phiên → VM"** (dòng "launch: pid … Attach: VM không có pid; khớp bằng danh sách `threads` của DAP (id + tên). Có thể mơ hồ…"): thay bằng "launch: `vm.process().pid()` trùng pid java-debug báo; attach (cả 'Listen to remote JVM' qua relay): cổng đầu xa của socket JDWP (`VirtualMachineImpl.packetReceiveManager()` → `fConnection` → `fSocket`) trùng `port` của request `attach`, lọc thêm theo host khi trùng cổng. Danh sách thread không dùng được: hai JVM cùng chương trình có cùng id và tên thread [XM, M2 G1]." Thêm ba điểm reflection này vào danh sách guard `unsupported` ở §7 "Giới hạn đã đo".
2. **§7 "Timeout gói JDWP của Eclipse JDI là toàn cục (~3 s)"**: thêm "Bundle nâng bằng `org.eclipse.jdi.VirtualMachine.setRequestTimeout` (API công khai) trong lệnh dài rồi trả lại. Đo trên JDK 21, 10M object: không nâng thì cả lệnh đếm lẫn `evaluate` của java-debug đang chờ hỏng ở 3 s; nâng thì `evaluate` chờ 4,5 s vẫn thành công [XM, M2 G3]." Đồng thời xoá ý "`ReferringObjects` ~1 s gần ngưỡng" vì đã có cách xử lý.
3. **§4 dòng "Bảng class"**, cột điều kiện: thay "dự phòng: JDWP `InstanceCounts` một lần, không chia lô, kèm cảnh báo thời gian" bằng "… chỉ khi phiên đang dừng; đo 10M object: JDK 8 1,3 s, JDK 11 0,8 s, JDK 21 5–8 s; không có shallow size; chênh lệch chỉ với baseline cùng nguồn".
4. **§5 "Windows"**: thay "v1: chạy `jcmd` của JDK của debuggee nếu có, nếu không thì dự phòng JDWP" bằng "M2: chỉ dự phòng JDWP (khi đang dừng); `jcmd` và stub native để sau" (xem quyết định 2).
5. **§6 câu mở đầu** ("Relay đặt giữa adapter Kotlin và JVM do app chạy") và **§9 bảng phạm vi**, dòng "Attach vào JVM có sẵn": mã hiện tại relay **mọi** phiên Kotlin (launch và attach, `lib.rs` dựng `StartupRelay` theo adapter, không theo request), nên link có ở cả phiên attach Kotlin. Đổi ô "Memory (instance)" thành "Có (JdwpLink)" và ô Coroutine thành "Có, agentless".
6. **§13 "Relay hiện có"** ("`ide-jdwp` ở M2 phải gộp hoặc dùng lại nó"): thay bằng "M2 không gộp: phiên 'Listen to remote JVM' là phiên java-debug, lấy instance qua bundle (khớp theo cổng relay); `jdwp.rs` giữ là bản copy byte. `kotlin_jdwp.rs` được thay bằng `JdwpLink`."
7. **§6.2** thêm hai gạch: "JVM đếm mỗi lần một ID xuất hiện trong reply, kể cả hai lần trong cùng một reply [XM 8/11/17/21/25, M2 G2]" và "Không dispose ReferenceTypeID: `DisposeObjects` lên nó không làm nó hết hiệu lực, nên không theo cùng quy tắc đếm [XM]".
8. **§2 bảng bằng chứng**: thêm ba dòng G1–G3 của plan này. **§15 thí nghiệm 3**: đánh dấu xong phần "`executeCommand` dài có chặn jdtls" (hover 5 ms trong lúc đếm 5,2 s) và "ánh xạ hai phiên attach cùng chương trình"; còn lại heap 4–6 GB.

## Cần chủ repo quyết định (đã chốt theo mặc định đề xuất)

Đã chốt: 1 tự chạy kèm dòng trạng thái; 2 Windows chỉ JDWP; 3 một PR chung ở cuối, trên cùng nhánh; 4 không gửi PR upstream trong M2; 5 giữ fwcd `hold_resumes = true` tới K0.

1. **Bảng class dự phòng tự chạy hay cần bấm nút.** Mặc định đề xuất: tự chạy khi mở tab hoặc bấm Refresh lúc phiên đang dừng (đã là thao tác chủ động), kèm dòng trạng thái về thời gian. Lý do: JDK 8/11 ≤ 1,3 s trên 10M object và request của debugger không hỏng; JDK ≥ 17 (Windows, JVM từ xa) 5–8 s nhưng bundle giữ java-debug sống.
2. **Windows ở M2 chỉ dùng dự phòng JDWP**, không chạy `jcmd` (spec §5 nói `jcmd` ở v1). Mặc định đề xuất: đồng ý, vì không có máy Windows để xác minh `jcmd` khi VM đang dừng, còn đường JDWP đã đo.
3. **Tạo issue GitHub cho M2 và push/PR** (quyết định 7 của spec, vẫn cần đồng ý riêng). Mặc định đề xuất: một issue "Debugger: JVM instances and referrers in the Memory view", một PR cho cả M2 trên nhánh M1 sau khi PR M1 được merge (hoặc PR nối tiếp nếu M1 còn mở).
4. **PR upstream cho microsoft/java-debug** để `connectedVirtualMachines()` trả đúng danh sách (spec §7). Mặc định đề xuất: chưa làm trong M2; chủ repo quyết định sau khi bundle đã chạy một bản phát hành.
5. **Kotlin**: M2 nhắm fwcd (`hold_resumes = true`); K0 (kotlin-lsp DAP) chưa làm. Mặc định đề xuất: giữ như vậy; khi K0 xong, chỉ đổi cờ `hold_resumes` theo adapter.

## Self-review

- **Phủ spec:** §8.3 (instance ≤ 1000, xem trước không `toString`, referrer theo yêu cầu) → Task 5, 7, 12; §8.5 nguồn số liệu → Task 9, 12; §8.6 nhảy tới source → Task 12; §6.1 bất biến 1–6 → Task 3–4; §6.2 → Task 4 (+ sửa spec 7); §6.4 trạng thái → Task 3; §7 lệnh bundle → Task 7 (`.values` của spec gộp vào `fields` cho mảng; đọc list cho Stream để S2); §5 Windows và JDK 8–16 khi dừng → Task 9; §13 IPC, `DebugEvent::Capabilities`, `DebugEvent::JvmBackend`, `jvm_instances` → Task 9–11; §14 test `ide-jdwp`, bundle, frontend, smoke → Task 2–5, 7, 11–13; R1 → Task 4 (proptest + JVM thật), R5 → Task 7–9.
- **Ngoài phạm vi M2 (có chủ đích):** coroutine (M3), Invoke Shield, Channel streaming cho bảng class, `jcmd` trên Windows.
- **Kiểu nhất quán:** `JvmValue`/`JvmField`/`JvmReferrer`/`VmTarget`/`InspectError` (Task 1) dùng ở Task 5, 8, 9; `JvmObjectRef` (Task 9) dùng ở Task 10–12; `ReplyIds` (Task 2) dùng ở Task 4–5; `LinkOptions`/`JdwpLink::start`/`release` (Task 3) dùng ở Task 6.
