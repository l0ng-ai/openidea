# Debugger JVM: Memory view, Coroutine view và Stream Debugger (bản 2)

Ngày: 2026-11-07 · Cơ sở code: `verify/swipe-integration` (trên `main` sau v0.1.38) · Trạng thái: **chờ duyệt, chưa viết code sản phẩm**

Bản 2 thay bản 1 sau bảy bài nghiên cứu độc lập (A–F, mục 2). Quy ước: **[XM]** = đã xác minh bằng chạy thật hoặc đọc nguồn gốc. **[SL]** = suy luận, chưa kiểm chứng. Mã thử nghiệm nằm ngoài repo.

## 0. Tóm tắt và cái gì đổi so với bản 1

Mục tiêu không đổi: đưa ba tính năng debug JVM của IntelliJ vào OpenIDEA, và làm tốt hơn chỗ IntelliJ làm chưa tốt. Kiến trúc đổi nhiều:

| Chủ đề                           | Bản 1                                                    | Bản 2                                                                                                      | Lý do                                                                              |
| -------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Bảng class của Memory view       | JDWP `InstanceCounts` chia lô                            | **Attach socket `GC.class_histogram -all`**                                                                | 40–60 ms so với 4–8 s trên 10M object, có thêm shallow bytes (A, E)                |
| Truy cập instance/field cho Java | Relay, app tự chạy JVM, java-debug attach qua relay      | **Bundle jdtls `jvm-inspect` dùng JDI của java-debug**, không đổi launch                                   | Bundle chạm được VM thật ở cả launch và attach (D)                                 |
| Relay JDWP                       | Mọi phiên                                                | **Chỉ Kotlin** (JVM do app chạy)                                                                           | Java không cần                                                                     |
| Coroutine                        | Gọi `dumpCoroutinesInfoAsJson…` qua invoke               | **Chỉ đọc field, không invoke; không cần agent làm điều kiện**                                             | Invoke treo phiên trên 1.5/1.6, JSON thiếu field (B)                               |
| Stream trace                     | `peek` ghi `String.valueOf` vào `System.getProperties()` | **Ghi tham chiếu thật vào một `ArrayList`, resolver theo thời gian + danh tính**, tắt breakpoint khi trace | Chuỗi mất danh tính, sai tới 19%; breakpoint ở thread khác làm treo phiên (C1, C2) |
| Retained size, GC root           | Ngoài phạm vi                                            | **Có trong lộ trình (M4)**: heap dump + parser Rust                                                        | ~5 s trên 20M object (E). Agent JetBrains là Apache-2.0, nhưng chậm                |
| Adapter Kotlin                   | fwcd                                                     | **Khảo sát kotlin-lsp DAP trước**, fwcd là phương án dự phòng                                              | fwcd gần như bỏ hoang, evaluate là stub (F)                                        |
| Hồi quy launch Java (R1)         | Rủi ro cao nhất                                          | **Không còn**                                                                                              | Không đổi launch                                                                   |

## 1. Mục tiêu, không phải mục tiêu, anti-goals

**Mục tiêu**

- **Memory view:** bảng class (số instance, shallow bytes, chênh lệch so với lần dừng trước, lọc), danh sách instance, referrer một bước. Sau đó: retained size, đường tới GC root, so sánh snapshot, và allocation bằng profiler.
- **Coroutine view:** cây coroutine theo trạng thái và job cha, stack tạm dừng, stack lúc tạo khi có agent, nhảy tới source, sao chép dump.
- **Stream Debugger:** chế độ Flat và Split, ánh xạ phần tử giữa các bước, kết quả cuối, cảnh báo rõ khi chuỗi không trace được hoặc trace không đầy đủ.
- Chạy cả khi IDE ở chế độ remote development (`ide-host` / `openidea-server`), có test tự động ở mọi tầng.

**Không phải mục tiêu (v1)**

- Android (ART), JVM không có `canGetInstanceInfo`.
- OpenJ9 cho phần heap dump (định dạng PHD không có GC root).
- Stream Debugger cho Kotlin `Sequence`, Python, JS; chỉ Java `Stream`/`IntStream`/`LongStream`/`DoubleStream`.

**Anti-goals**

- Làm hỏng phiên debug thường dùng: adapter chết, breakpoint chạy khác, hoặc **JVM của người dùng abort** (mục 6).
- Sao chép mã của JetBrains. IntelliJ chỉ để hiểu kiến trúc. Mã của ta viết lại từ đặc tả JDWP/JVMTI, mã nguồn OpenJDK và `kotlinx-coroutines` (Apache-2.0). Agent `debugger-memory-agent` của JetBrains là Apache-2.0 nhưng ta không phụ thuộc vào nó.

## 2. Bằng chứng

Sáu thí nghiệm của tôi và bảy bài nghiên cứu (agent Opus). Thư mục thí nghiệm: `scratchpad/research-{A..F}`.

| #    | Câu hỏi                                                                         | Kết quả                                                                                                |
| ---- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| S1   | `evaluate` của fwcd gọi được hàm?                                               | **Không [XM]**: chỉ tra tên biến, mọi biểu thức khác trả `unknown`                                     |
| S2   | Relay chèn gói JDWP riêng khi fwcd là client?                                   | **Được [XM]**: `InstanceCounts`, `Instances`, `InvokeMethod`; fwcd vẫn bình thường                     |
| S3–4 | `evaluate` java-debug chạy stream + lambda; `peek` ghi log trong một biểu thức? | **Được, có giới hạn [XM]**                                                                             |
| S5   | `evaluate` có dừng ở breakpoint người dùng?                                     | **Không dừng ở cùng thread [XM]** (nhưng xem C2 về thread khác)                                        |
| S6   | Static không qualify trong lambda?                                              | **Lỗi JDT ở frame static [XM]**                                                                        |
| A    | Cách tốt nhất lấy dữ liệu heap                                                  | Attach histogram nhanh hơn JDWP ~100 lần; JDWP có bẫy refcount (mục 6). 7 thí nghiệm trên JDK 11/21/25 |
| B    | Coroutine                                                                       | Không invoke; đọc field; 1.5.2–1.11.0                                                                  |
| C1   | Ngữ nghĩa stream và IntelliJ                                                    | IntelliJ đã chuyển sang trace lần chạy thật; property test 20.000 chuỗi                                |
| C2   | Ma trận khả năng `evaluate` JDT                                                 | Nhiều lỗ; treo cả phiên khi chờ thread bị breakpoint                                                   |
| D    | Mở rộng java-debug                                                              | Bundle chạm JDI qua `JdtVirtualMachineManagerProvider`                                                 |
| E    | Phân tích heap                                                                  | hprof + dominator Rust ~4–5 s; agent JetBrains mở nhưng chậm                                           |
| F    | Adapter Kotlin                                                                  | fwcd bỏ hoang; kotlin-lsp có DAP                                                                       |

| S7 | Attach lúc dừng ở breakpoint, listener bật bằng `-XX:+StartAttachListener`, không `SIGQUIT` | **[XM]** socket có ngay khi khởi động trên 8/11/17/21/25. Histogram `-all` khi dừng: 17 → 32 ms, 21 → 34 ms, 25 → 32 ms; **8 và 11 treo** (timeout 15 s, kể cả `VM.version`). Khi VM dừng lúc khởi động (`suspend=y`, chưa ai nối) `VM.version` trả lời trên mọi bản (5–16 ms). JDK 8 nhận `-all`. Mã: `scratchpad/m1-spike` |

**Chưa kiểm chứng [SL]** (mỗi mục có thí nghiệm ở mục 15): kotlin-lsp DAP qua relay có chịu gói chèn; Windows; JDK 12–16 khi attach lúc dừng (coi như 11); heap thật 4–8 GB; ECJ trên JRE-only.

## 3. Kiến trúc

```mermaid
flowchart LR
  UI[Frontend<br/>features/debugger] -- IPC + Channel --> HOST[ide-host ops/debug]
  HOST --> DAP[ide-dap<br/>DebugManager, Session]
  DAP -- attach socket --> ATT[ide-jvm-attach]
  ATT -. histogram, heap dump .-> JVM[(debuggee JVM)]
  DAP -- DAP --> JD[java-debug in jdtls]
  DAP -- executeCommand --> BUN[bundle jvm-inspect<br/>in jdtls]
  BUN -- JDI --> JVM
  JD -- JDI --> JVM
  DAP -- DAP --> KA[Kotlin adapter<br/>kotlin-lsp DAP or fwcd]
  KA -- JDWP --> LINK[ide-jdwp JdwpLink]
  DAP -- internal cmds --> LINK
  LINK -- JDWP --> JVM
  HOST --> STR[ide-streams]
  STR -. evaluate .-> DAP
```

### 3.1 Crate và thành phần mới

| Thành phần         | Trách nhiệm                                                                                                                                                                                               | Phụ thuộc                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `ide-jvm-attach`   | Client attach HotSpot bằng Rust thuần: tìm pid/socket, gửi lệnh `GC.class_histogram`, `GC.heap_dump`, `VM.version`. Unix trước, Windows qua `jcmd` rồi stub sau                                           | `ide-core`                                     |
| `ide-jvm-inspect`  | Trait `JvmInspector` (classes, instances, referrers, fields, arrays, strings) và các bộ giải mã dùng chung: diff histogram, dựng cây coroutine, parser `@DebugMetadata` từ `.class`. Không IO tới adapter | `ide-core`                                     |
| `ide-jdwp`         | Codec JDWP và `JdwpLink` (relay) cho Kotlin, cài `JvmInspector` bằng JDWP                                                                                                                                 | `ide-core`, `ide-jvm-inspect`                  |
| `java/jvm-inspect` | Bundle jdtls (mẫu `java/java-usages`), cài `JvmInspector` bằng JDI. Phía Rust gọi qua `workspace/executeCommand` (cạnh `crates/ide-lsp/src/jdtls/hierarchy.rs`)                                           | embed bằng `include_bytes!` như bundle hiện có |
| `ide-streams`      | Tìm chuỗi (tree-sitter-java qua `ide-syntax`), chuẩn hoá, sinh biểu thức, giải mã log, resolver                                                                                                           | `ide-core`, `ide-syntax`                       |
| `ide-heap` (M4)    | Parser hprof streaming, dominator tree, retained size, đường tới GC root, chỉ mục trên đĩa                                                                                                                | `ide-core`                                     |
| `ide-dap`          | Sở hữu backend theo phiên, chọn nguồn dữ liệu, capabilities, API cho `ide-host`                                                                                                                           | các crate trên                                 |

Theo `CLAUDE.md`, mỗi crate một domain; `src-tauri` chỉ có wrapper mỏng.

## 4. Mỗi câu hỏi lấy dữ liệu từ đâu

| Cần                          | Nguồn chính                                                   | Đo được                                                    | Điều kiện / dự phòng                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bảng class (số lượng, bytes) | Attach `GC.class_histogram -all`                              | 40–60 ms (10M object, G1/ZGC); 316 ms Shenandoah           | Cùng máy, HotSpot, listener sẵn sàng. JDK 11 treo khi dừng, JVM từ xa, Windows → dự phòng: JDWP `InstanceCounts` **một lần, không chia lô**, kèm cảnh báo thời gian |
| Danh sách instance           | `Instances(max ≤ 1000)` qua JDI (Java) hoặc JdwpLink (Kotlin) | 3–35 ms                                                    | Cần `canGetInstanceInfo`                                                                                                                                            |
| Referrer một bước            | `ReferringObjects`                                            | ~0,9–1 s mỗi lần (20M object, duyệt cả heap)               | Không gọi lặp để lần ngược                                                                                                                                          |
| Coroutine                    | Đọc field qua `JvmInspector`                                  | 15–22 ms (registry agent); 90–550 ms (quét heap, heap nhỏ) | Không invoke                                                                                                                                                        |
| Retained size, GC root       | Heap dump + `ide-heap`                                        | Dump 0,8–1,6 s + phân tích ~4–5 s (20M object)             | JDK ≥ 21 + listener; HotSpot                                                                                                                                        |
| Allocation                   | async-profiler `event=alloc[,live]`                           | —                                                          | Sau; không Windows                                                                                                                                                  |
| Stream trace                 | `evaluate` + `ide-streams`                                    | 15–30 ms mỗi evaluate                                      | Tắt breakpoint khi trace                                                                                                                                            |

## 5. ide-jvm-attach

**Giao thức POSIX [XM, nguồn OpenJDK + client Python chạy được trên 11/21/25]:** tạo `.attach_pid<pid>` trong thư mục làm việc của JVM, gửi `SIGQUIT`, chờ socket UNIX `<tmp>/.java_pid<pid>`, gửi `"1\0" cmd\0 a1\0 a2\0 a3\0`, đọc dòng mã kết quả và output. Thư mục tạm: Linux `/tmp` (container: `/proc/<pid>/root`); macOS **`confstr(_CS_DARWIN_USER_TEMP_DIR)`, không phải `$TMPDIR`**. v2 của giao thức bị từ chối trên 11 và 21.

**Điểm sống còn: Attach Listener phải chạy trước khi VM dừng.** Khi JDWP đã suspend, thread `Signal Dispatcher` cũng bị suspend nên khởi tạo listener thất bại trên 11, 21, 25 **[XM]**. Cách xử lý:

- JVM do app chạy (Kotlin `start_kotlin_debuggee`, Java qua `vmArgs` của java-debug): thêm `-XX:+StartAttachListener`.
- JVM không do app chạy (attach, Gradle/Maven): gửi `VM.version` ngay khi phiên bắt đầu, lúc VM còn chạy.
- Không bao giờ gửi `SIGQUIT` khi VM đang dừng.

**Theo JDK khi VM đang dừng (listener đã sẵn):** 17, 21 và 25 chạy được **[XM, S7]**; 8 và 11 treo (listener tự chờ khi bị suspend) → chỉ lấy khi VM đang chạy, hoặc dự phòng JDWP (M2); 12–16 chưa kiểm **[SL]** → coi như 11. Phiên bản JDK đọc từ file `release` cạnh file thực thi của tiến trình (`/proc/<pid>/exe`, macOS `proc_pidpath`), không cần gửi lệnh attach.

**Phạm vi M1 (quyết định khi lập plan):** chỉ phiên _launch_ do app khởi động (java-debug launch, Kotlin `start_kotlin_debuggee`), vì chỉ ở đó app biết pid và tự thêm `-XX:+StartAttachListener` (đặt trước tham số của người dùng để `-XX:-StartAttachListener` hay `-XX:+DisableAttachMechanism` của họ thắng). M1 **không bao giờ gửi `SIGQUIT`**: chỉ dùng socket đã có, và chỉ khi socket thuộc user hiện tại với quyền `0600` (như `VirtualMachineImpl` của JDK). Phiên attach, Gradle/Maven, Windows và dự phòng JDWP chuyển sang M2, cùng lúc có bundle và `JdwpLink`. Trước đó tab Memory nêu lý do không có dữ liệu.

**Chế độ live** (`GC.class_histogram` không `-all`) luôn chạy Full GC và xoá `WeakReference` của chương trình **[XM]**; chỉ bật khi người dùng yêu cầu, kèm cảnh báo. `-all` có lẫn `jdk.internal.vm.FillerElement` của G1, phải lọc. Đối chiếu tên với `AllClasses` để xử lý nhiều classloader (đánh dấu mơ hồ).

**Windows:** attach dùng named pipe và `CreateRemoteThread` chạy stub gọi `JVM_EnqueueOperation`. v1: chạy `jcmd` của JDK của debuggee nếu có, nếu không thì dự phòng JDWP; stub native là việc sau **[SL]**.

**Không dùng được khi** `-XX:+DisableAttachMechanism`, hoặc OpenJ9 (giao thức khác) **[SL]**.

## 6. JdwpLink (cho Kotlin)

Relay đặt giữa adapter Kotlin và JVM do app chạy, thay `kotlin_jdwp.rs`. Phục vụ danh sách instance, referrer và phần đọc field của Coroutine view.

### 6.1 Bất biến

1. **Trong suốt.** Không sửa hay xoá gói của adapter. Ngoại lệ duy nhất: giữ `Resume` trước `release()` khi `hold_resumes = true` (fwcd cần, adapter khác thì `false`).
2. **Dải id tách biệt**: gói nội bộ dùng `[0x7000_0000, 0x7FFF_FFFF)`. Adapter phát id trong dải → link sang `Degraded` (chỉ chuyển tiếp) và báo UI.
3. **Chặn reply của ta**: reply thuộc dải id của ta không bao giờ tới adapter **[XM, đo 38/38 gói]**.
4. **Chỉ gửi khi VM đang dừng**, xác minh bằng `ThreadReference.SuspendCount (11/12)` trước mỗi lệnh, không chỉ suy từ gói.
5. **Mỗi lệnh nội bộ là một lệnh một lúc**; bản thân JDWP agent cũng xử lý tuần tự nên lệnh dài của ta chặn lệnh của adapter. Vì vậy không chia lô `InstanceCounts` (bản 1 sai chỗ này **[XM]**).
6. **Lỗi không lan**: lỗi của đường chèn chỉ làm hỏng lệnh đó. Hai chế độ lỗi: `Degraded` và `Closed`.

### 6.2 Quy tắc về ObjectID (từ A, xác minh bằng chạy thật)

- Hai "client" trên cùng kết nối nhận **cùng một ID** và dùng chung refcount. **`DisposeObjects` thừa dù một lần làm JVM abort** (`RefNode count < 0`, SIGABRT trên 11/21/25). Link phải đếm chính xác số lần nó nhận mỗi ID và chỉ dispose đúng số đó.
- **`EnableCollection` không đếm**: gọi nó có thể bỏ pin của adapter, làm object bị GC. Link không dùng `DisableCollection`/`EnableCollection`. Từ JDK 17, `suspendAll` đã pin mọi ID trong lúc VM dừng.
- Ghi nhận: ID ta đang giữ cũng làm object sống, tính vào số đếm.
- Tham chiếu nhận được chỉ dùng trong cùng `generation` của lần dừng; `Resume` của adapter huỷ mọi truy vấn nội bộ đang chờ.

### 6.3 Invoke (chỉ khi thật cần)

Bản 2 **không dùng invoke** cho coroutine và Memory. Khi một tính năng sau này cần (ví dụ xem trước `toString`): chỉ trên thread bị dừng **bởi event** (lỗi 10 nếu không), `INVOKE_SINGLE_THREADED`; event phát sinh bên trong làm invoke treo tới khi `Resume` đúng loại (`SUSPEND_ALL` → `VM.Resume`, `EVENT_THREAD` → `ThreadReference.Resume`); invoke của ta va chạm với `evaluate` của adapter trên cùng thread; có thể huỷ bằng `ThreadReference.Interrupt` rồi `Stop`. Đây là việc của "Invoke Shield" ở bản sau, không phải v1.

### 6.4 Trạng thái

`Connecting → Handshaking → (Held nếu hold_resumes) → Ready ⇄ Suspended(generation, thread) → Closed`; mọi lỗi đường chèn dẫn tới `Degraded`.

## 7. Bundle jdtls `jvm-inspect` (cho Java)

**Cơ chế [XM, đã chạy thật trên jdtls + java-debug 0.53.2, JDK 21]:** java-debug không có extension point cho lệnh DAP (enum `Command` đóng, provider gắn cứng). Nhưng `JdtVirtualMachineManagerProvider.getVirtualMachineManager()` là public và trả về `AdvancedVirtualMachineManager` giữ `connectedVMs` (package-private; `connectedVirtualMachines()` của Eclipse luôn rỗng). Bundle khai báo `delegateCommandHandler` (API ổn định của jdtls mà java-debug cũng dùng), lấy `connectedVMs` bằng reflection rồi dùng `com.sun.jdi` chuẩn. Hai class này không đổi từ 2020.

**Lệnh dự kiến:** `openidea.jvm.vms`, `.classes`, `.instances`, `.fields`, `.values`, `.referrers`. Chạy 3–4 ms mỗi class; `instanceCounts` toàn bộ ~600 class 6–9 ms (lần chậm nhất 108 ms) trên heap nhỏ.

**Ánh xạ phiên → VM:** launch: pid của DAP `process` trùng `vm.process().pid()`. Attach: VM không có pid; khớp bằng danh sách `threads` của DAP (id + tên). Có thể mơ hồ khi hai phiên attach cùng chương trình → thí nghiệm ở mục 15.

**Giới hạn đã đo:**

- Không dùng invoke thô: một breakpoint của người dùng trong `toString` làm java-debug phát `stopped` bất ngờ và invoke timeout ~3 s. DAP `evaluate` thì được che chắn (`isInEvaluation`).
- Timeout gói JDWP của Eclipse JDI là toàn cục (~3 s). `Instances` (max 1000) nhanh; `ReferringObjects` ~1 s trên 20M object, gần ngưỡng.
- Không ghim phiên bản java-debug (app cài bản mới nhất). Guard: thiếu class/field → trả `unsupported`, `caps.jvmInspect = false`; gửi PR upstream để `connectedVirtualMachines()` trả đúng danh sách; test trong CI "Language smoke" với bản cài thật.
- Launch Java của java-debug không chuyển tiếp stdin và luôn báo mã thoát 0 **[XM]**: không phải tính năng ta cần "giữ nguyên".

**Phương án đã loại:** relay + app tự chạy JVM cho Java (rủi ro hồi quy launch); adapter JDWP tự viết (ước 8–12 người-tháng, evaluate cần compiler Java).

## 8. Memory view

1. Mở tab (hoặc bấm Refresh) khi VM dừng: gọi histogram `-all` qua attach. Hiển thị theo lô khi có thể, danh sách ảo hoá.
2. Chênh lệch so với **lần lấy trước** (không tự lấy ở mỗi lần dừng) tính ở backend, chỉ giữa các lần cùng chế độ (`-all` hoặc live). Class trùng tên (nhiều classloader) giữ thành dòng riêng, đánh dấu mơ hồ, không tính chênh lệch.
3. Cửa sổ instance: `Instances(max ≤ 1000)`. Xem trước giá trị chỉ bằng `StringReference.Value` và đọc field kiểu bọc (`Integer.value`…); còn lại `Type@id`. Không gọi `toString`. Referrer một bước theo yêu cầu.
4. Mặc định **làm mới theo yêu cầu**, không tự cập nhật ở mỗi lần dừng; tuỳ chọn tự cập nhật tắt mặc định.
5. Ghi rõ nguồn số liệu trong UI ("đếm object reachable" cho JDWP; "bao gồm cả chưa được thu gom" cho histogram `-all`).
6. Nhảy tới source bằng điều hướng symbol hiện có (M2: debugger chưa có hàm mở class theo tên đầy đủ).

## 9. Coroutine view

**Không bao giờ invoke.** Mô hình: `CoroutineSnapshot { source, complete, coroutines[] }` mỗi coroutine có `key (ObjectId của job), name, debugId, job: New|Active|Completing|Cancelling|Cancelled|Completed, exec: Running{thread}|Suspended|Created|Unknown, dispatcher, parent, children, frames[origin Thread|Async|Creation], missing[]`.

**Hai nguồn, chung bộ giải mã (B, [XM] trên 1.5.2–1.11.0):**

- **A, registry của agent** (khi `DebugProbesImpl` đã nạp): đường đi `DebugProbesImpl.capturedCoroutinesMap → core → keys (AtomicReferenceArray) → HashedWeakRef.referent → CoroutineOwner{delegate, info} → DebugCoroutineInfoImpl`; cấu trúc giống hệt qua các bản; 12–20 coroutine đọc trong 15–22 ms, kể cả sau Pause. Có thêm creation stack.
- **B, đồ thị heap (không agent):** đi từ stack các thread (coroutine đang chạy) → `Job` → cây con qua `ChildHandleNode`; leaf suspended qua chuỗi `completion`; nối `withContext`/`coroutineScope` qua `ScopeCoroutine.uCont`. Tên, dispatcher từ `CombinedContext`. Dòng lệnh và biến spill từ `@DebugMetadata` (`l[label-1]`, `s`, `n`) đọc từ **bytes `.class` trên classpath** (JDWP không có lệnh đọc annotation). Trạng thái Job còn chính xác hơn agent (thấy `Cancelling`). Mất duy nhất creation stack. Quét `Instances` theo class chỉ khi người dùng bấm "Deep scan" (heap 30M object: ~450 ms mỗi class).
- Phải lọc: "lambda template" (`completion == null`, `label == 0`), `SafeCollector`, builder `sequence{}`/`iterator{}`; gộp `ScopeCoroutine`, `DispatchedCoroutine`, `UndispatchedCoroutine` vào coroutine sở hữu.

**Agent là tuỳ chọn.** Chi phí đo trên 1.9.0: `yield` ×2, resume chuỗi suspend sâu 20 tầng ×45, creation trace bật làm `launch` 200k mất 1470 ms so với 276 ms. Nếu bật, phải dùng **đúng file jar đang trên classpath** (agent và app khác ABI qua ranh giới 1.6/1.7 làm JVM chết lúc khởi động **[XM]**), và truyền qua `vmArguments` của phiên app khởi động, không dùng `JAVA_TOOL_OPTIONS` (áp cho cả Gradle/Kotlin daemon). **Mặc định tắt** (quyết định của mình, dựa trên chi phí và rủi ro ABI; sẽ đo lại trước khi chốt), tuỳ chọn "Capture coroutine creation stacks" trong run config.

**Phạm vi theo loại phiên Kotlin:**

| Phiên                               | Memory (bảng class) | Memory (instance)     | Coroutine                                      |
| ----------------------------------- | ------------------- | --------------------- | ---------------------------------------------- |
| Run/Debug do app khởi động          | Có (attach)         | Có (JdwpLink)         | Có                                             |
| Gradle/Maven debug do frontend chạy | Có                  | Có nếu qua link       | Có, agentless; agent qua `jvmArgs` của task    |
| Attach vào JVM có sẵn               | Có nếu cùng máy     | Không (không có link) | Chỉ nếu đi qua link; nếu không, tab hiện lý do |

**Async stack trong panel Frames và smart step-over (M3b):** frame thật của thread tới `invokeSuspend` đầu tiên, rồi nối chuỗi `completion`. Step qua điểm treo: Kotlin ≥ 2.2 có trường `nl` trong `DebugMetadata` v2 → breakpoint ở dòng đó lọc theo continuation; bản cũ dùng method-entry `invokeSuspend` + `InstanceOnly($continuation)`. Cần kiểm với adapter thật.

**Dự phòng:** thiếu metadata → hiện class/method; không có agent → "Creation stack: bật agent"; không có dependency coroutines → tab ẩn hoặc "không dùng kotlinx-coroutines".

## 10. Stream Debugger

### 10.1 Quy trình (engine A: `evaluate` + chuẩn hoá)

1. Action `debug.traceStreamChain` (khi `debugSessionPaused`, frame Java). `ide-streams` tìm chuỗi bằng tree-sitter-java quanh dòng đang dừng.
2. **Điều kiện được trace** (xem 10.2); không đạt thì từ chối kèm lý do.
3. **Chuẩn hoá** theo quy tắc ở 10.3, ghi lại mọi điều chỉnh và hiện trong hộp thoại.
4. **Sinh biểu thức:** chèn `peek` sau nguồn và sau mỗi bước trung gian. Bộ ghi là một `ArrayList` đặt vào `System.getProperties()` dưới khoá `oi.<nonce>` (E0). Mỗi `peek` của bước `k` thêm hai phần tử liên tiếp: `Integer.valueOf(k)` rồi chính đối tượng `x`. Chỉ số trong list là thời gian (đơn điệu, duy nhất). Không gọi `toString` trong lúc stream chạy. Bộ ghi ném `IllegalStateException("oi-budget")` khi vượt ngân sách (mặc định 100.000 mục) hoặc khi `Thread.currentThread()` khác luồng ghi đầu tiên.
5. **Bốn bước:** E0 tạo bộ ghi; E1 chạy chuỗi (lấy kết quả cuối); E2 đọc list bằng `JvmInspector` (giữ danh tính đối tượng; trong phiên Java bằng bundle); E3 dọn `oi.<nonce>` (luôn chạy).
6. **Giải mã** thành các cột theo bước, resolver theo phép toán (10.4), hiển thị giá trị theo kiểu lười và có giới hạn.

### 10.2 Chuỗi nào được trace

| Trường hợp                                                                                                                                                           | Xử lý                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Gốc là biến/field/biểu thức không phải lời gọi tạo stream                                                                                                            | Từ chối: chạy lại sẽ tiêu thụ stream của chương trình                                                                                  |
| Gốc là lời gọi tạo stream mới (`x.stream()`, `parallelStream()`, `Stream.of/iterate/generate/concat`, `IntStream.range…`, `Arrays.stream`, `String.chars()/lines()`) | Cho phép                                                                                                                               |
| `Stream.generate`/`iterate` với hàm có trạng thái, `reader.lines()`, `Scanner.tokens()`, `Files.*`                                                                   | Cảnh báo "thay đổi trạng thái chương trình / đọc lại tài nguyên" (chạy lại `Random` làm đổi giá trị kế tiếp của chương trình **[XM]**) |
| Phép kết thúc là `iterator()`/`spliterator()`                                                                                                                        | Từ chối (không chạy pipeline)                                                                                                          |
| Có `parallel()` trong chuỗi                                                                                                                                          | Xoá mọi `.parallel()`/`.sequential()` rồi thêm `.sequential()` **ngay trước phép kết thúc** (cờ cuối thắng **[XM]**), kèm banner       |
| Nhiều câu lệnh / thiếu phép kết thúc                                                                                                                                 | Từ chối ở v1                                                                                                                           |
| Frame là frame lambda giữa chuỗi                                                                                                                                     | Chỉ cho chuỗi nằm trong thân lambda đó                                                                                                 |
| `count()` trên nguồn có kích thước biết trước (JDK ≥ 9, mở rộng ở 21+)                                                                                               | Pipeline không chạy, `peek` không ghi gì: banner "JDK tính count từ kích thước nguồn"                                                  |

### 10.3 Chuẩn hoá cho bộ evaluate của JDT (đo trên java-debug 0.53.2)

1. Bọc thành `Object __r = <expr>; return __r;` (khối lambda có `return` lỗi, ternary cấp ngoài lỗi).
2. Bỏ kiểu tham số lambda `(Integer x) ->` → `(x) ->`.
3. Biến bắt có kiểu generic (`List<Integer> nums`): khai alias kiểu thô rồi cast lại trong lambda.
4. Qualify hàm/field static không qualify trong lambda bằng tên class khai báo (luôn với field private static).
5. Method private, `this::priv`, `super::m` trong lambda: từ chối hoặc chuyển engine khác.
6. `instanceof` pattern → `instanceof` + cast; switch expression: từ chối.
7. Primitive trong `Object[]{…}` → `valueOf`; varargs rỗng → mảng rỗng tường minh.
8. Frame record: dùng tên đầy đủ; frame generic: cast về erasure; frame class ẩn danh/local/top-level phụ: từ chối lambda.
9. Ngoại lệ do code người dùng ném ra được `evaluate` trả như giá trị thành công: nhận diện kết quả kiểu `Throwable`.

**An toàn phiên (C2, [XM]):** `evaluate` có thể chờ một thread khác đang dừng ở breakpoint, và vì java-debug xử lý request tuần tự, không có DAP `cancel`, cả phiên chết. Vì vậy: **tắt mọi breakpoint và exception breakpoint trước khi trace, khôi phục sau** (kiểm id/verified/điều kiện còn nguyên), timeout phía app, và nếu hết giờ thì báo phiên có thể treo và đề nghị khởi động lại. Mỗi lần evaluate có lambda để lại ~3 class không bao giờ unload.

### 10.4 Resolver (từ C1, property test 20.000 chuỗi ngẫu nhiên)

- **Phép toán đồng bộ** (`map*/boxed/asXStream/peek/filter/skip/limit/takeWhile/dropWhile/flatMap/mapMulti`, `distinct` phần tử được giữ): bản ghi cha của bước k+1 tại thời điểm t là bản ghi bước k gần nhất trước t. **0 lỗi**, kể cả Integer cache.
- **`sorted`:** khớp theo danh tính cộng thứ tự xuất hiện; đánh dấu "mơ hồ" với primitive trùng. Nhận ra trường hợp `sorted` không làm gì (nguồn đã SORTED) qua log xen kẽ.
- **`distinct`, phần tử bị loại:** gán cho phần tử giữ lại có `equals` bằng nó, tính ở E2 (gọi `equals` của người dùng, có cảnh báo).
- **`gather`/`mapConcurrent`/phép toán phát trễ:** chỉ hiện giá trị từng bước, không vẽ đường nối (thứ tự thay đổi theo bản JDK).
- Khớp tham lam theo giá trị (kiểu IntelliJ cũ) sai: `skip` 3,9%, filter có trạng thái 18%, `sorted` theo khoá ẩn 19%. Không dùng.

### 10.5 Các engine sau (khi số đo chứng minh cần)

- **S3, trace lần chạy thật** (cách IntelliJ mặc định hiện nay: `MethodExit` + `ForceEarlyReturn`, không chạy lambda hai lần). Dùng JDI trong bundle. Chỉ áp dụng khi đang dừng trước phép toán đầu tiên.
- **S4, compile-and-define cho JDK ≥ 23:** sinh class trace là class lồng static trong bản sao file nguồn, dịch bằng ECJ có trong jdtls, gửi bytes qua `evaluate` và `defineHiddenClass(NESTMATE)` (truy cập private, một lần evaluate, không cần chuẩn hoá). **JDK 21 hỏng với lambda trong hidden class** (JDK-8330467, sửa ở 23) nên chỉ cho JDK ≥ 23.
- **Tiêu chí chọn:** bộ ~30 chuỗi đại diện (helper private, biến generic, lambda khối, method ref, record) đo trên JDK 17, 21, 25; engine A cần ≥ 70% đúng, B ≥ 95%; độ trễ mỗi trace < 300 ms. Nếu A dưới 70% thì v1 chỉ hỗ trợ JDK ≥ 23 hoặc đầu tư S3.

## 11. Phân tích heap và allocation

- **M4, `ide-heap`:** lấy dump bằng `GC.heap_dump -parallel` qua attach (khi đang dừng, JDK ≥ 21 + listener); parser hprof streaming qua mmap; đồ thị CSR; dominator (Lengauer-Tarjan lặp hoặc semi-NCA); retained theo class và object; đường ngắn nhất tới GC root; so sánh hai snapshot; chỉ mục lưu trên đĩa kiểu MAT. Đo thử: 840 MB / 20M object: dump 0,8–1,6 s, phân tích 3,6 s, RAM đỉnh 2,8 GB; ước 8 GB: 35–60 s, nên bản thật phải thu gọn bộ nhớ (bản thử ~140 B/object). Shallow size phải tính lại theo compressed oops/header (hprof không ghi layout). Chạy `spawn_blocking`, tôn trọng `CancellationToken`, kiểm dung lượng đĩa trước khi dump, dọn file tạm. Dùng lại được để mở `.hprof` từ ngoài. Không hỗ trợ OpenJ9.
- **M5, allocation:** `async-profiler event=alloc[,live]` qua cơ chế `JAVA_TOOL_OPTIONS` của `ide-profiler` (hiện chỉ `event=cpu`, `plan.rs:144-146`), đổ vào cây gọi đã có. Ghi stack cấp phát ngay trong phiên debug cần `SampledObjectAlloc` (JVMTI): dùng agent JetBrains (Apache-2.0, kèm NOTICE) hoặc agent tự viết; để sau.
- Agent nạp động (`JVMTI.agent_load`) vào VM đang suspend treo **[XM]**; chỉ nạp lúc launch (`-agentpath`).

## 12. Adapter Kotlin

fwcd 0.4.4: release cuối 2023-10, 43 issue mở không phản hồi; evaluate là stub; `configurationDone` không trả lời; báo breakpoint "verified" không kiểm tra, nên class khai báo trong `Main.kt` và thân hàm inline không bao giờ trúng; tên class suy từ đường dẫn file (lý do cần `SourceMirror`); resume `VMStart` quá sớm (lý do cần hold-Resume) **[XM]**. Lần "verified nhưng không trúng" trong hàm `suspend` ở spike 1 không phải giới hạn coroutine (3/3 lần trúng khi chạy lại) mà là lỗi fwcd/harness.

kotlin-lsp (JetBrains, đã dùng làm LSP): có DAP tích hợp, khởi động bằng `workspace/executeCommand start_debug_server`, `adapterID` `intellij_jvm`. Bản 263.7084 **[XM]** cho: evaluate Kotlin đầy đủ (`name.uppercase()`, `Later(name).run(3)`), breakpoint trong hàm inline và class khác tên file, step qua `delay` đúng dòng, ẩn biến tổng hợp, async stack coroutine. Phải chờ import xong mới attach (trước đó breakpoint "verified" nhưng 0 lần trúng). Client cần xử lý `invalidated`, thread id không ổn định, `source.path` dạng `file://`, `reason: "breakpoint"` khi step. **Rủi ro:** Alpha, một phần mã đóng, có lệnh `license`/EULA (bản thử báo "does not require a license"), chưa thử qua relay, chưa thử launch.

**Hướng:** K0 = spike (relay + gói chèn, launch, đọc EULA đầy đủ). Nếu đạt: kotlin-lsp DAP làm debugger chính khi nó là LSP đang hoạt động, fwcd chỉ là dự phòng; `JdwpLink` giữ trung lập adapter (`hold_resumes`). Nếu giấy phép chưa rõ: gắn `needs-decision` theo quy ước repo. Không làm proxy sửa evaluate cho fwcd, không fork java-debug cho Kotlin, không viết adapter Kotlin riêng.

## 13. Tích hợp

- **IPC** (`IdeResult<T>`, `Channel<T>` cho streaming, `RequestId` để huỷ), mỗi lệnh gọi `host.require_trust(window)` và được đăng ký ở `ops/debug.rs::register` để smoke gọi được:
  `debug_jvm_memory_classes(session, request, on_chunk)`, `debug_jvm_memory_instances(session, class_ref, limit)`, `debug_jvm_memory_referrers(session, object_ref, limit)`, `debug_jvm_coroutines(session)`, `debug_stream_chains(session, frame_id)`, `debug_stream_trace(session, frame_id, chain, request)`, và ở M4 `debug_heap_*`.
- **Capabilities và sự kiện:** thêm `jvm_memory`, `jvm_instances`, `jvm_coroutines`, `stream_trace` vào `DebugCapabilities` (`ide-dap/src/lib.rs:117`). `loadCapabilities` chỉ chạy lúc phiên bắt đầu (`state.ts:213`, `:609`), không tải lại, nên từ M2 thêm `DebugEvent::Capabilities` và `DebugEvent::JvmBackend { state }` vào `crates/ide-core/src/event.rs:205`, xử lý trong `handleDebugEvent` (`state.ts:1034`, switch không có `default`). `jvm_memory` của M1 tĩnh (adapter + `launch`) nên chưa cần sự kiện mới.
- **Relay hiện có:** `crates/ide-dap/src/jdwp.rs` đã relay JDWP Java cho "Listen to remote JVM" (`debug_listen_for_jvm`); `ide-jdwp` ở M2 phải gộp hoặc dùng lại nó, và nó có thể là đường dự phòng JDWP cho các phiên đó.
- **Frontend:** `src/features/debugger/{memory,coroutines,streams}/`; tab trong `DebugToolWindow.tsx` (`type Tab` ~dòng 106, mảng tab ~174–179) mở rộng và gắn `sessionSupports`. Không import tính năng khác. Action: `debug.memory.refresh`, `debug.coroutines.copyDump`, `debug.traceStreamChain`; action không có phím mặc định thì không cần dòng trong preset (như `debug.reloadChangedClasses`); nếu thêm phím thì thêm cho cả cặp macOS/Windows của IntelliJ và VS Code vì `windows.test.ts` so khớp bộ khoá (preset Eclipse kế thừa IntelliJ). Chuỗi hiển thị vào `en.json` và `zh.json`; title action phải có bản zh khác en. CSS Modules + tokens, icon trong `src/ui/icons.tsx`, `aria-label` cho nút icon.

## 14. Kiểm thử

| Tầng                             | Cách làm                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ide-jvm-attach`                 | Test giao thức với JVM thật trên JDK 11/21/25 (đã có client Python để đối chiếu); test lọc FillerElement, nhiều classloader; test từ chối khi listener chưa chạy                                                                                                                                                                                |
| `ide-jdwp`                       | JVM giả bằng script qua loopback: bit-exact passthrough, hold Resume, va chạm id, chèn xen kẽ, đếm/dispose ID (không bao giờ dispose thừa), `Degraded`. JVM thật `#[ignore]` trong CI                                                                                                                                                           |
| Bundle                           | Test Java của bundle + test tích hợp qua jdtls thật (mẫu `java/java-usages`); test `NoSuchFieldException` → `unsupported`                                                                                                                                                                                                                       |
| `ide-streams`                    | Test chuỗi/chuẩn hoá/snapshot biểu thức; **property test resolver** với fixture log thật + đáp án theo con trỏ cha (từ `ResolverProp.java`), ma trận JDK 11/17/21/25; test vàng: `count` không chạy pipeline, `sorted` không làm gì, `sorted+limit`, `[1,1,1].skip(2)`, `distinct` khi `equals ≠ toString`, ngoại lệ giữa chừng, vượt ngân sách |
| Coroutine                        | Fixture đủ trường hợp (`NonCancellable`, `GlobalScope`, `suspendCoroutine` thô, Mutex/select, shaded jar); so quét heap với registry; ma trận 1.5.2–mới nhất                                                                                                                                                                                    |
| `ide-heap`                       | Dump nhỏ với đáp án tính tay; property test dominator; fuzz parser                                                                                                                                                                                                                                                                              |
| `ide-dap`, frontend, smoke, perf | Mở rộng `FakeLauncher`, vitest, e2e Playwright, `smoke/debug.test.ts` cho java (Stream + Memory) và kotlin (Memory + Coroutines), ngân sách `perf/budgets.json`                                                                                                                                                                                 |

Trước mỗi PR chạy đúng bộ lệnh trong `CLAUDE.md`. Xác minh runtime bằng skill `verify` kèm ảnh chụp.

## 15. Lộ trình, PR và thí nghiệm còn lại

| Mốc        | Nội dung                                                                                                                     | Phụ thuộc                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **M1**     | `ide-jvm-attach` + bảng class + tab Memory (phiên launch do app khởi động, HotSpot, macOS/Linux; JDK 8–16 chỉ khi đang chạy) | độc lập                                        |
| **M2**     | Instance list và referrer: bundle `jvm-inspect` (Java) + `JdwpLink` (Kotlin), trait `JvmInspector`                           | M1 cho UI                                      |
| **K0**     | Spike kotlin-lsp DAP (relay, launch, EULA)                                                                                   | độc lập                                        |
| **M3**     | Coroutine view (đọc field, agentless; agent tuỳ chọn)                                                                        | M2 (link/inspector), K0 cho quyết định adapter |
| **M3b**    | Async stack, smart step-over                                                                                                 | M3                                             |
| **S1**     | `ide-streams` + fixture + property test                                                                                      | độc lập                                        |
| **S2**     | UI + engine A + an toàn phiên                                                                                                | S1, M2 (đọc list)                              |
| **S3, S4** | Trace lần chạy thật; engine JDK ≥ 23                                                                                         | S2, số đo                                      |
| **M4**     | `ide-heap`                                                                                                                   | M1                                             |
| **M5**     | Allocation                                                                                                                   | M4                                             |

Hai nhánh làm song song trong worktree riêng. Theo quy tắc repo: một vấn đề mỗi PR, `Closes #n`, mở issue trước.

**Thí nghiệm còn thiếu (mỗi cái chốt một rủi ro):**

1. kotlin-lsp DAP qua relay + gói chèn; launch; EULA đầy đủ (K0).
2. ~~Attach lúc dừng trên JDK 17~~ (đã làm, S7); JDK 12–16; Windows x64/ARM64 (stub, antivirus).
3. Bundle: heap 4–6 GB với timeout JDI ~3 s; `executeCommand` dài có chặn jdtls (đo độ trễ hover/completion); ánh xạ hai phiên attach cùng chương trình.
4. `evaluate` khi bật exception breakpoint "mọi exception" (có `stopped`/treo?).
5. Tắt và khôi phục breakpoint không đổi id/verified/điều kiện.
6. Bộ 30 chuỗi đại diện trên JDK 17/21/25 cho engine A/B.
7. Gradle/Kotlin daemon với `JAVA_TOOL_OPTIONS` chứa agent (đã quyết không dùng; chỉ để xác nhận).
8. Heap thật 8 GB cho `ide-heap` (RAM, thời gian).
9. ECJ trên JRE-only; JDK 11–16 cho engine B.

## 16. Rủi ro

| #   | Rủi ro                                                            | Mức         | Giảm thiểu                                                                        |
| --- | ----------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------- |
| R1  | JVM abort do `DisposeObjects` thừa; gỡ pin của adapter            | Cao nếu sai | Đếm refcount chính xác, không dùng Enable/DisableCollection, test xen kẽ          |
| R2  | Adapter Kotlin: kotlin-lsp Alpha/giấy phép; fwcd bỏ hoang         | Cao         | K0; giữ fwcd làm dự phòng; `needs-decision` nếu giấy phép chưa rõ                 |
| R3  | Treo cả phiên khi `evaluate` chờ thread bị breakpoint             | Cao         | Tắt breakpoint khi trace, timeout, banner                                         |
| R4  | Attach lúc dừng không chạy (listener chưa có, JDK 11/17, Windows) | Trung bình  | `-XX:+StartAttachListener`, attach sớm, dự phòng JDWP                             |
| R5  | Reflection vào java-debug gãy khi cập nhật                        | Trung bình  | Guard `unsupported`, CI với bản mới nhất, PR upstream                             |
| R6  | Bộ evaluate của JDT không chạy được chuỗi của người dùng          | Trung bình  | Chuẩn hoá có ghi lại, từ chối rõ, đo tỉ lệ đúng, engine S3/S4                     |
| R7  | Khác biệt phiên bản `kotlinx-coroutines`; tên field nội bộ đổi    | Trung bình  | Ma trận phiên bản trong CI, probe `Methods`                                       |
| R8  | Trace sai mà không báo (mapping sai, `count` short-circuit)       | Trung bình  | Resolver có property test, banner cho các ca đã biết, không vẽ nối khi không chắc |
| R9  | Histogram live xoá WeakReference/chạy GC                          | Thấp        | Mặc định `-all`, cảnh báo ở chế độ live                                           |
| R10 | Bản quyền                                                         | Thấp        | Clean-room từ đặc tả và nguồn mở                                                  |

## 17. Quyết định cần chốt (kèm mặc định)

1. **Thứ tự giao:** M1 (bảng class qua attach, không cần relay hay bundle) và S1/S2 (Stream) trước, song song.
2. **Java:** bundle jdtls thay relay; không đổi cách launch.
3. **Kotlin:** làm K0 trước; nếu đạt, kotlin-lsp DAP là debugger chính, fwcd dự phòng. Giấy phép cần chủ repo xem (`needs-decision`).
4. **Coroutine:** agentless mặc định, agent tuỳ chọn trong run config.
5. **Retained size, GC root, allocation:** đưa vào lộ trình (M4, M5) bằng hprof + Rust và async-profiler.
6. **Stream:** engine A (evaluate + chuẩn hoá) cho v1; chọn S3/S4 dựa trên số đo bộ 30 chuỗi.
7. **Issue theo dõi:** tạo issue (Memory, Coroutines, Stream, Kotlin adapter, Heap) trước PR đầu tiên. Việc này đẩy nội dung ra GitHub nên cần bạn đồng ý.

**Trạng thái (2026-11-07):** chủ repo duyệt bản 2 và các mặc định 1–6. Mặc định 7 (tạo issue) vẫn cần đồng ý riêng trước PR đầu tiên.

**Câu hỏi của builder check, đã chốt khi lập plan:** JDK 8 là debuggee được hỗ trợ với cùng quy tắc như 11 (S7); không đưa mã thử nghiệm hay bản sao nguồn OpenJDK (GPL) vào repo: fixture viết lại nhỏ gọn, test JVM thật để `#[ignore]` với biến `OPENIDEA_TEST_JAVA`; S1 lấy thông tin kiểu ở đâu (jdtls hay chỉ cú pháp) được quyết khi lập plan S1; Kotlin chạy qua java-debug (dự án trộn) được xét ở M3.

## 18. Để lại cho người xây

Bố cục, hoạt ảnh và tên cụ thể của tab/hộp thoại (theo `src/styles/tokens.css`); kích thước lô, ngân sách bộ ghi, timeout; cách đóng gói test JVM giả; thứ tự resolver cho phép toán hiếm (`takeWhile`, `dropWhile`, `mapMulti`); định dạng chỉ mục của `ide-heap`.

## Phụ lục: những gì lấy từ IntelliJ (chỉ để hiểu)

- Memory view cơ bản dùng JDI (`vm.instanceCounts`, `ReferenceType.instances`); phần nặng dùng agent native, nay là mã nguồn mở Apache-2.0 (`JetBrains/debugger-memory-agent`).
- Coroutine: `-javaagent` của `kotlinx-coroutines-core` + gọi `DebugProbesImpl` qua JDI. Ta chọn đọc field vì invoke treo trên bản cũ.
- Stream Debugger: mã mở trong `intellij-community/plugins/stream-debugger`; mặc định hiện nay trace lần chạy thật (registry `debugger.streams.use.breakpoint.based.tracing`), engine `peek` là dự phòng. Ta bắt đầu bằng `peek` vì không cần JDI trong mọi phiên, nhưng ghi tham chiếu thay vì chuỗi.
