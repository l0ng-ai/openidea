# Debugger JVM Heap snapshot (M4: heap dump, retained size, dominator, đường tới GC root, so sánh, mở `.hprof`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Từ tab **Memory** người dùng bấm "Capture Heap Snapshot" (khi VM đang dừng ở breakpoint hoặc đang chạy), IDE lấy heap dump qua attach socket, phân tích bằng crate mới `ide-heap` và mở một tab editor "Heap" có bảng class với retained size, cây dominator, đường ngắn nhất tới GC root, so sánh hai snapshot; tab Memory có thêm cột Retained Size. Cùng tab editor đó mở được file `.hprof` từ ngoài.

**Architecture:** `ide-jvm-attach` thêm lệnh `GC.heap_dump -all "<path>"` và `VM.flags`. `ide-dap` (module `jvm_memory/heap.rs`) dùng lại khoá attach theo phiên của M1, chặn theo JDK khi đang dừng, lấy histogram + `VM.flags` + dump trong cùng lần dừng, kiểm dung lượng đĩa. `ide-heap` đọc hprof bằng mmap qua ba lượt tuần tự, đánh số object bằng bitmap địa chỉ + rank (≈1 B/object), dựng CSR `u32`, tính dominator bằng semi-NCA không dùng stack, retained theo object và class, cha BFS tới GC root, và ghi các cột kết quả thành file mmap trong thư mục snapshot (chỉ mục trên đĩa); truy vấn đọc thẳng từ các cột đó. `ide-host` giữ `HeapRegistry`, nối dump → phân tích, phát tiến độ qua `Channel`, huỷ bằng `RequestId`. Frontend: nút và cột trong `debugger/memory`, editor kind `heap-snapshot` trong `debugger/heap`.

**Tech Stack:** Rust 2024 (`memmap2` 0.9 mới vào workspace, `libc` `statvfs`, `uuid`, `thiserror`, `proptest`, `criterion` 0.5), tokio `spawn_blocking` + `CancellationToken`, serde + specta (tauri-specta bindings), React + zustand + CSS Modules, `@tanstack/react-virtual` qua `src/ui/List.tsx`, vitest, smoke qua `openidea-server`.

**Spec:** `docs/superpowers/specs/2026-11-07-jvm-debug-link-design.md` (mục 1, 2 hàng E, 3.1 hàng `ide-heap`, 4 hàng "Retained size, GC root", 5, 11 gạch M4, 13, 14 hàng `ide-heap`, 15 thí nghiệm 8, 16, 18). Plan M1: `docs/superpowers/plans/2026-11-07-debugger-jvm-memory-m1.md`. Mục "Sửa spec đề xuất" ở cuối plan thay một số dòng của spec theo kết quả spike (chưa áp vào spec).

## Global Constraints

- Không bao giờ gửi `SIGQUIT` hay tạo `.attach_pid<pid>`; chỉ dùng socket có sẵn, cùng kiểm tra chủ sở hữu/quyền của M1 (`ide_jvm_attach::has_listener`).
- Lệnh dump duy nhất: `GC.heap_dump -all "<path>"`. **Không bao giờ** `-parallel`, `-gz`, `-overwrite` hay tham số nào khác: tham số mà DCmd từ chối (ném `IllegalArgumentException`) khi VM đang dừng làm treo listener trên 17/21/25 và các lệnh xếp sau chỉ chạy khi resume (Grounding H2). Đường dẫn luôn bọc `"`; từ chối đường dẫn chứa `"`, `\0`, `\n` hoặc `\r` trước khi gửi.
- Khi đang dừng: chỉ dump nếu JDK major ≥ 17, đọc từ file `release` không qua attach (`histogram_safe_while_suspended`, như M1). Khi đang chạy: JDK 8+ (đã đo 8 và 11).
- Một yêu cầu attach mỗi phiên tại một thời điểm: capture giữ `session.jvm_memory` (mutex của M1) trong lúc histogram + `VM.flags` + dump, nhả trước khi phân tích.
- Timeout dump: `30 s + histogram_total_bytes / 256 MiB/s` (đo 1,8 GB/s). Timeout hoặc huỷ trong lúc dump → xoá ngay thư mục snapshot (trên unix JVM ghi vào inode đã unlink, hoặc không tạo được file vì thư mục đã mất).
- Dung lượng đĩa: trước dump cần `free ≥ total_bytes + 106 × instances + 1 GiB` (số từ histogram cùng lần dừng: hprof ≈ `bytes + 16 × instances`, chỉ mục + mảng tạm ≈ `90 × instances`). Mở `.hprof` ngoài: kiểm `free ≥ 90 × objects + 1 GiB` sau lượt đọc đầu (đã biết số object thật).
- Thư mục snapshot: `<host.local_data_dir>/cache/heap-snapshots/<uuid>/` (file `owner` chứa pid của host). Đóng snapshot → xoá thư mục (kể cả dump đã capture, trừ khi người dùng đã "Save Heap Dump As…" ra chỗ khác). Khởi động host → xoá thư mục có `owner` là pid đã chết.
- Chỉ số object và cạnh là `u32`; vượt `u32::MAX - 2` object hoặc `u32::MAX` cạnh → `HeapError::TooLarge` (≈ heap 100 GB). Mọi lượt dài kiểm `CancellationToken` ít nhất mỗi `1 << 20` bước và chạy trong `spawn_blocking`.
- Parser không bao giờ panic với input bất kỳ: mọi đọc qua `Reader` có kiểm biên, trả `HeapError`.
- Cạnh `java.lang.ref.Reference.referent` không tính vào dominator, retained và đường tới GC root ("chỉ tham chiếu mạnh"); đếm số cạnh bỏ qua trong summary.
- HotSpot hprof 1.0.2/1.0.1, id 4 hoặc 8 byte. Không OpenJ9 (PHD), không Android hprof.
- IPC: `IdeResult<T>`, camelCase, mỗi lệnh gọi `host.require_trust(window)`, tên `debug_heap_*`; đăng ký ở `crates/ide-host/src/ops/heap.rs::register` (gọi từ `ops/mod.rs`) và `src-tauri/src/commands/{heap.rs,mod.rs}`; chạy `pnpm gen:bindings`, commit `src/bindings.ts`.
- Chuỗi hiển thị vào cả `src/platform/locales/text/en.json` và `zh.json`; title action có bản zh khác en. CSS Modules + tokens, không hex, icon từ `src/ui/icons.tsx`, `aria-label` cho nút icon. Không import feature khác.
- Không đưa mã thử nghiệm, dump thật hay bản sao nguồn OpenJDK vào repo: fixture hprof dựng bằng `HprofWriter` trong test. Test JVM thật để `#[ignore]`, đọc `OPENIDEA_TEST_JAVA`.
- Một nhánh `feat/debugger-jvm-memory`, một PR chung ở cuối mọi mốc: plan này **không** tạo issue hay PR. Commit: `feat(debugger): …`, stage từng đường dẫn, không trailer `Co-Authored-By`, không stage `openspec/` hay `*.sh`.

## Grounding

Mã spike (ngoài repo, đã xoá mọi dump): `scratchpad/m4-spike/` — `java/Gen.java` (debuggee: 8 class layout khác nhau với số lượng riêng biệt, mảng đủ kiểu, chuỗi `Node` 10 phần tử, payload dùng chung, `HashMap`, `WeakReference`, 100k rác), `dump_spike.py` (dừng ở `Gen.pause` bằng JDWP `SUSPEND_ALL`, gửi lệnh attach v1 trên socket có sẵn), `heapspike/` (Rust: bitmap+rank, CSR hai lượt, semi-NCA không stack, retained, BFS, so shallow với histogram).

**H1. `GC.heap_dump` qua attach khi VM dừng ở breakpoint chạy trên JDK nào, có `-parallel` không, mất bao lâu, phiên còn sống không?** Listener bật bằng `-XX:+StartAttachListener`, 50k unit (~270k object):

```
11 {"hist": ["TIMEOUT", 60006], "serial": {"rc": "TIMEOUT", "ms": 120006}, "second_stop": true}   → file dump xuất hiện SAU khi resume
17 {"hist": [0, 4], "serial": {"rc": 0, "ms": 20, "mb": 17.3}, "par17": {"rc": "TIMEOUT"}, "second_stop": true}
21 {"hist": [0, 5], "serial": {"rc": 0, "ms": 14, "mb": 16.0}, "par": {"rc": "TIMEOUT"}, "second_stop": true}
23 {"p6": {"rc": 0, "ms": 18, "body": "...Heap dump file created [17716161 bytes in 0.014 secs]"}, "second_stop": true}
25 {"serial": {"rc": 0, "ms": 19}, "par": {"rc": 0, "ms": 18}, "second_stop": true}   (cả -XX:+UseCompactObjectHeaders, -XX:-UseCompressedOops)
đang chạy: 21 "-all -parallel=6" → rc -1 "java.lang.IllegalArgumentException: Unknown argument '…p6.hprof' in diagnostic command."; JDK 8 "-all" → rc 0 "Heap dump file created"; 11 → rc 0
20M object (880 MB), đang dừng: 21 serial 410 ms; 25 không cờ 851 ms, "-parallel=6" 821 ms
100M object (4,3 GB), đang dừng, 21: 2413 ms
```

Kết luận: dump khi dừng chạy trên **17**, 21, 23, 25 (spec ghi ≥ 21 là sai); 11 treo và lệnh vẫn chạy sau khi resume. `-parallel` không có trên 21 và không nhanh hơn trên 25 → không dùng.

**H2. Lỗi khi VM đang dừng có làm treo listener không?**

```
17/21: "-all -parallel=6" (đang dừng) → TIMEOUT; hai dump "-all" hợp lệ xếp sau cũng TIMEOUT; sau resume: files_after_resume ["…-s1.hprof", "…-s2.hprof"]
25:    "-all -bogus=1" (đang dừng) → TIMEOUT, lệnh sau cũng TIMEOUT
17/21/25: "-all @/nonexistent/dir/x.hprof" → rc 0 "Unable to create /nonexistent/dir/x.hprof: No such file or directory" (3 ms, không treo)
25: file đã tồn tại → rc 0 "Unable to create s p/dq.hprof: File exists"
17/21/25: đường dẫn có dấu cách bọc "…" hoặc '…' → "Heap dump file created", lệnh sau vẫn chạy
```

Kết luận: chỉ lỗi tham số (exception Java) làm treo; lỗi IO trả về thông điệp với rc 0. Thành công nhận bằng chuỗi `Heap dump file created`.

**H3. Biểu diễn gọn tốn bao nhiêu byte/object, bao lâu, và mmap có chặn được RAM không?** (macOS, 12 nhân, 24 GB; `phys_footprint` = bộ nhớ ẩn danh)

```
20M:  file=880MB objects=20087504 reachable=20085676 edges=33606456 weak_referent_edges_skipped=70313
      timing: pass1+idmap=211ms types+csr(2 passes)=1.057s dominators=497ms retained=98ms bfs=119ms total=1.98s
      tracked peak arrays=1113MB = 58.1 B/object ; peak memory footprint 1505937544 (RAM) | 272746368 (mảng mmap, total 2.33s)
100M: file=4303MB objects=100471106 edges=168501565
      RAM : total=34.6s (12.2 user, 6.7 sys, máy bị nén bộ nhớ), footprint 6.7 GB
      mmap: total=19.3s (12.2 user), peak memory footprint 1289592368 (gồm 800 MB vec debug `top`, không có trong bản thật)
```

So với prototype (3,6 s, 2,8 GB, ~140 B/object): 58 B/object, nhanh gấp 1,8. Dùng offset CSR `u32` thay `u64` còn ≈ 50 B/object. Ngoại suy 8 GB heap (~200M object): CPU ≈ 24 s, mảng ≈ 10–12 GB file-backed, bộ nhớ ẩn danh ≈ 1 GB; dump ≈ 5 s.

**H4. Shallow size so với histogram của JVM (cùng lần dừng, cả hai `-all`).** Ba cách: công thức layout theo `VM.flags`, khoảng cách địa chỉ nhỏ nhất giữa các object liền nhau (id hprof là địa chỉ), và chính histogram.

```
j17      : 356 types, count equal 356, bytes equal (layout) 345, min address delta == hist size 293/293
j21      : 407 types, count 406 ([I +33 filler G1), layout 395, delta 330/330
j21 -coops: layout 395, delta 330/330 ; j25: layout 404, delta 332/332 ; j25 +UseCompactObjectHeaders: layout 403, delta 332/332
j25 ZGC  : layout 332/343, delta 227/264 ; j21 ParallelGC: layout 395, delta 330/330
lệch layout chỉ ở class có field VM chèn: java.lang.Module 48→56, Thread 104→120, MemberName 40→48, ResolvedMethodName 16→24, ClassLoaders$*ClassLoader 96→104
kích thước/instance (histogram): j21  A16 B24 C32 D32 E24 F16 G16 H24 Node32 ; j21 -coops: D40 E40 Node40 ; j25 compact: G8 B16 C24 D32 Node24
```

Kết luận: capture của IDE lấy kích thước instance từ histogram (`bytes / instances`, đúng cho mọi class không phải mảng), mảng theo layout từ `VM.flags`; `.hprof` ngoài dùng khoảng cách địa chỉ khi khớp, ngược lại dùng layout. Filler G1 là `int[]` không ai trỏ tới nên chỉ rơi vào phần "unreachable".

**H5. Semi-NCA có đúng không?**

```
domcheck small: 20000 random graphs (n<=64) vs dataflow Dom sets: 0 mismatches, 148ms
domcheck large n=1000000 deep_chain=false: mismatches vs CHK = 0 (snca 637ms, chk 660ms)
domcheck large n=1000000 deep_chain=true:  mismatches vs CHK = 0 (snca 118ms, chk 242ms)
```

## Review Focus

1. **Đường dẫn snapshot có dấu cách** (`~/Library/Application Support/…` trên macOS) khi VM đang dừng: không bọc nháy thì DCmd lỗi tham số và treo phiên attach. Test ở Task 9 (`heap_dump_command_quotes_path`, `real_jvm` dump vào thư mục `a b`) và Task 10 (`capture_dir_with_space_is_quoted`).
2. **Bấm Capture khi JDK 8–16 đang dừng**, hoặc phiên vừa dừng ngay lúc bấm: không gửi gì, nêu lý do; nếu lệnh đã gửi mà hết giờ thì thư mục đã bị xoá nên dump chạy muộn không để lại file. Test ở Task 10 (`suspended_jdk11_refuses_without_sending`, `timed_out_dump_removes_snapshot_dir`).
3. **Đĩa gần đầy hoặc dump bị cắt cụt**: từ chối trước khi dump với số cần/còn; file cụt báo lỗi có vị trí byte, không panic, không để thư mục tạm. Test ở Task 8 (`not_enough_space_for_estimate`), Task 10 (`not_enough_disk_space_refuses_before_dump`), Task 1 (`truncated_dump_reports_offset`, proptest `parser_never_panics`).
4. **Danh sách liên kết rất sâu** (1M node một chuỗi): DFS, duyệt cây dominator và retained theo class không tràn stack. Test ở Task 4 (`deep_chain_has_linear_dominators`) và Task 6 (`deep_chain_retained_by_class`).
5. **Huỷ giữa lúc phân tích dump lớn / đóng tab giữa chừng**: dừng trong ≤ 1 lượt kiểm, xoá thư mục snapshot, lần capture sau chạy được. Test ở Task 6 (`cancel_stops_analysis`), Task 8 (`closing_snapshot_removes_dir`, `stale_dirs_removed_on_start`), Task 11 (`cancelled_capture_releases_lock`).

---

### Task 0: Nhánh và plan

**Files:** `docs/superpowers/plans/2026-11-07-debugger-heap-m4.md`

- [ ] **Step 1: Làm tiếp trên nhánh** `feat/debugger-jvm-memory` trong worktree `../openidea-jvm-memory`. M4 không phụ thuộc mã M2; nếu M2 đã vào nhánh thì giữ nguyên `InstancesPane` và chỉ thêm nút/cột như Task 13. Không tạo issue, không push.
- [ ] **Step 2: Commit plan**: `git add docs/superpowers/plans/2026-11-07-debugger-heap-m4.md && git commit -m "feat(debugger): plan heap snapshots (M4)"`.

---

### Task 1: Crate `ide-heap`: reader, parser hprof, writer cho test, fuzz

**Files:**

- Create: `crates/ide-heap/Cargo.toml`, `crates/ide-heap/src/lib.rs`, `crates/ide-heap/src/error.rs`, `crates/ide-heap/src/reader.rs`, `crates/ide-heap/src/hprof.rs`, `crates/ide-heap/src/testing.rs`
- Modify: `Cargo.toml` (`[workspace.dependencies]`: `ide-heap = { path = "crates/ide-heap" }`, `memmap2 = "0.9"`)

**Interfaces:**

- Produces:

```rust
#[derive(Debug, thiserror::Error)] pub enum HeapError { Truncated { at: u64 }, NotHprof, UnsupportedIdSize(u32),
    UnknownSubRecord { tag: u8, at: u64 }, UnknownType { ty: u8, at: u64 }, MissingClass { id: u64, at: u64 },
    TooLarge, Cancelled, Io(#[from] std::io::Error) }
pub(crate) struct Reader<'a> { buf: &'a [u8], pos: usize, id_size: u8 }   // u1/u2/u4/u8/id/skip/bytes → Result<_, HeapError>
#[derive(Clone, Copy, Debug, PartialEq, Eq)] #[repr(u8)] pub enum BasicType { Object = 2, Boolean = 4, Char, Float, Double, Byte, Short, Int, Long }
impl BasicType { pub fn from_u8(v: u8) -> Option<Self>; pub fn hprof_size(self, id_size: u8) -> usize; pub fn heap_size(self, ref_size: u8) -> u64; pub fn array_name(self) -> &'static str /* "[I" */ }
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)] #[serde(rename_all = "camelCase")]
pub enum HeapRootKind { Unknown, JniGlobal, JniLocal, JavaFrame, NativeStack, StickyClass, ThreadBlock, MonitorUsed, ThreadObject }
pub struct HprofHeader { pub version: String, pub id_size: u8, pub timestamp_ms: u64, pub body_start: usize }
pub struct ClassDump { pub id: u64, pub super_id: u64, pub loader_id: u64,
    pub statics: Vec<(u64 /*name id*/, u64 /*object id*/)>, pub static_bytes: u64 /*heap bytes of primitive statics*/,
    pub fields: Vec<(u64 /*name id*/, BasicType)> }
pub enum HeapRecord<'a> { Root { kind: HeapRootKind, id: u64, thread_serial: Option<u32> }, Class(ClassDump),
    Instance { id: u64, class_id: u64, data: &'a [u8] }, ObjectArray { id: u64, class_id: u64, len: u32, data: &'a [u8] },
    PrimitiveArray { id: u64, ty: BasicType, len: u32 } }
pub enum Record<'a> { Utf8 { id: u64, text: &'a [u8] }, LoadClass { class_id: u64, name_id: u64 },
    Segment(std::ops::Range<usize>), Heap { at: usize, record: HeapRecord<'a> } }
pub fn parse_header(buf: &[u8]) -> Result<HprofHeader, HeapError>
pub fn scan<'a>(buf: &'a [u8], header: &HprofHeader, visit: &mut dyn FnMut(Record<'a>) -> Result<(), HeapError>) -> Result<(), HeapError>
pub fn scan_segment<'a>(buf: &'a [u8], segment: std::ops::Range<usize>, id_size: u8, visit: &mut dyn FnMut(usize, HeapRecord<'a>) -> Result<(), HeapError>) -> Result<(), HeapError>
pub fn record_at(buf: &[u8], at: usize, id_size: u8) -> Result<HeapRecord<'_>, HeapError>
// testing.rs, #[cfg(any(test, feature = "test-support"))]
pub struct HprofWriter { /* id_size 8 */ }
impl HprofWriter { pub fn new() -> Self; pub fn string(&mut self, id: u64, s: &str) -> &mut Self; pub fn load_class(&mut self, class_id: u64, name_id: u64) -> &mut Self;
    pub fn class(&mut self, id: u64, super_id: u64, fields: &[(u64, BasicType)], statics: &[(u64, u64)]) -> &mut Self;
    pub fn instance(&mut self, id: u64, class_id: u64, data: &[u8]) -> &mut Self; pub fn obj_array(&mut self, id: u64, class_id: u64, items: &[u64]) -> &mut Self;
    pub fn prim_array(&mut self, id: u64, ty: BasicType, len: u32) -> &mut Self; pub fn root(&mut self, kind: HeapRootKind, id: u64) -> &mut Self;
    pub fn finish(&self) -> Vec<u8> }
pub struct MiniHeap  // DSL trên HprofWriter: class theo tên (tự cấp id, string, LOAD CLASS, ROOT_STICKY_CLASS cho mọi class), object theo tên field
impl MiniHeap { pub fn new() -> Self; pub fn class(&mut self, name: &str, super_name: Option<&str>, fields: &[(&str, BasicType)]) -> &mut Self;
    pub fn object(&mut self, addr: u64, class: &str, values: &[(&str, u64)]) -> &mut Self /* field thiếu = 0 */;
    pub fn array_of(&mut self, addr: u64, class: &str, items: &[u64]) -> &mut Self; pub fn prim(&mut self, addr: u64, ty: BasicType, len: u32) -> &mut Self;
    pub fn root(&mut self, kind: HeapRootKind, addr: u64) -> &mut Self; pub fn bytes(&self) -> Vec<u8>; pub fn write_to(&self, path: &Path) }
```

Cargo: `edition/version/license.workspace`; deps `ide-core`, `memmap2`, `serde`, `serde_json`, `specta`, `thiserror`, `tracing`, `uuid`, `[target.'cfg(unix)'.dependencies] libc = "0.2"`; feature `test-support = []`; dev-deps `proptest`, `tempfile`.

Định dạng (hprof 1.0.2): header `"JAVA PROFILE 1.0.2\0"` (chấp nhận cả `1.0.1`), `u4` id size (4 hoặc 8), `u8` timestamp; record `u1 tag, u4 time, u4 len`: `0x01` UTF8, `0x02` LOAD CLASS (`u4 serial, id class, u4 stack, id name`), `0x0C`/`0x1C` heap dump (segment), còn lại bỏ qua theo `len`. Sub-record: `0xFF` (id), `0x01` (id, id), `0x02`/`0x03`/`0x08` (id, u4, u4), `0x04`/`0x06` (id, u4), `0x05`/`0x07` (id), `0x20` class dump (id, u4, super, loader, signers, protection domain, 2 reserved, u4 instance size, constant pool `u2 n × (u2, u1 type, value)`, statics `u2 n × (id name, u1 type, value)`, fields `u2 n × (id name, u1 type)`), `0x21` instance (id, u4, class id, u4 n, n byte), `0x22` object array (id, u4, u4 len, class id, len × id), `0x23` primitive array (id, u4, u4 len, u1 type, len × size). `thread_serial` có cho `0x02`, `0x03`, `0x04`, `0x06`, `0x08`.

- [ ] **Step 1: Viết test thất bại** (`hprof.rs`):

```rust
#[test] fn parses_header() // MiniHeap::new().bytes() → version "JAVA PROFILE 1.0.2", id_size 8; b"JAVA PROFILE 1.0.2\0\0\0\0\x03…" → UnsupportedIdSize(3); b"GIF89a" → NotHprof
#[test] fn scans_every_record_kind() // writer: 2 string, 1 load class, class có 1 static ref + field (Object, Long), 1 instance, obj array [0x10, 0], prim array Int×3, root JavaFrame + StickyClass → đếm đúng từng biến thể; Instance.data.len() == 16; Root JavaFrame có thread_serial Some(1)
#[test] fn record_at_reads_back_an_instance() // `at` lấy từ scan → record_at trả cùng id/class_id
#[test] fn truncated_dump_reports_offset() // bytes của MiniHeap cắt bỏ 5 byte cuối → Err(Truncated { at }) với at > body_start
#[test] fn unknown_sub_record_is_an_error() // chèn tag 0x99 trong segment → UnknownSubRecord { tag: 0x99, .. }
proptest! { #[test] fn parser_never_panics(bytes in vec(any::<u8>(), 0..4096)) { let _ = parse_header(&bytes).and_then(|h| scan(&bytes, &h, &mut |_| Ok(()))); }
            #[test] fn mutated_dump_never_panics(flips in vec((0usize..2048, any::<u8>()), 1..16)) { /* MiniHeap mẫu, ghi đè byte ở vị trí % len, chạy scan + scan_segment */ } }
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo nextest run -p ide-heap` → FAIL.
- [ ] **Step 3: Cài đặt** như Interfaces. `len` của record vượt cuối buffer → `Truncated`; sub-record phải kết thúc đúng ở cuối segment.
- [ ] **Step 4: Chạy lại** → PASS (proptest mặc định 256 ca mỗi test).
- [ ] **Step 5: Commit**: `git add Cargo.toml crates/ide-heap && git commit -m "feat(debugger): parse HotSpot heap dumps"`

---

### Task 2: Bảng id → chỉ số và cột lưu trên đĩa

**Files:**

- Create: `crates/ide-heap/src/ids.rs`, `crates/ide-heap/src/column.rs`

**Interfaces:**

- Produces:

```rust
pub const NONE: u32 = u32::MAX;
pub unsafe trait Pod: Copy + 'static {}  // u8, u32, u64
pub struct Column<T: Pod>   // Deref/DerefMut<[T]>
impl<T: Pod> Column<T> { pub fn ram(len: usize, fill: T) -> Self; pub fn file(path: &Path, len: usize, fill: T) -> io::Result<Self> /* giữ file */;
    pub fn scratch(dir: &Path, len: usize, fill: T) -> io::Result<Self> /* unlink ngay sau mmap */; pub fn open(path: &Path) -> io::Result<Self> /* chỉ đọc */ }
pub enum Store { Ram, Dir(PathBuf) }   // Dir: cột kết quả = file, mảng tạm = scratch
impl Store { pub fn column<T: Pod>(&self, name: &str, len: usize, fill: T) -> io::Result<Column<T>>; pub fn scratch<T: Pod>(&self, len: usize, fill: T) -> io::Result<Column<T>> }
pub struct IdMapBuilder;  impl IdMapBuilder { pub fn new() -> Self; pub fn insert(&mut self, id: u64); pub fn build(self, store: &Store) -> io::Result<IdMap> }
pub struct IdMap;  impl IdMap { pub fn len(&self) -> u32; pub fn rank(&self, id: u64) -> Option<u32>; pub fn id_at(&self, rank: u32) -> u64; pub fn ids(&self) -> impl Iterator<Item = u64> + '_ /* tăng dần */ }
```

Bản chính: id chia 8 thành slot; chunk `2^17` slot (1 MiB địa chỉ) là `2^11` word `u64`; bảng chunk dày `Vec<u32>` từ chunk nhỏ nhất tới lớn nhất (word đầu của chunk hoặc `NONE`), `wrank: u32` = số bit trước mỗi word; `rank = wrank[w] + popcount(word & ((1 << b) - 1))`. Dự phòng (một id không chia hết cho 8, hoặc khoảng chunk > `2^26`): id sắp xếp trong `Column<u64>` + tìm nhị phân. Chỉ số = thứ tự địa chỉ tăng dần (Task 5 dùng thứ tự này để tính khoảng cách địa chỉ).

- [ ] **Step 1: Viết test thất bại**:

```rust
#[test] fn rank_follows_address_order() // insert 0x2000, 0x1000, 0x1010, 0x7_0000_0000 → rank(0x1000)=0, 0x1010=1, 0x2000=2, 0x7_0000_0000=3; rank(0x1008)=None; rank(0)=None; id_at(2)=0x2000; ids() theo thứ tự tăng
#[test] fn unaligned_ids_use_sorted_fallback() // có id 0x1004 → rank vẫn đúng như trên
#[test] fn sparse_wide_span_uses_fallback()    // 0x1000 và 0x1000 + (1 << 50) → rank 0, 1
#[test] fn ten_million_ids_cost_about_a_byte_each() // 10M id cách nhau 32 byte → tổng byte của các cột < 16 MB
#[test] fn file_column_round_trips() // Column::file(dir/"x.u32", 4, 7) ghi [1,2,3,4] → drop → Column::<u32>::open == [1,2,3,4]
#[test] fn scratch_column_leaves_no_file() // sau tạo, dir rỗng
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo nextest run -p ide-heap ids column` → FAIL.
- [ ] **Step 3: Cài đặt.** Byte order của file cột: native (chỉ mục không chuyển máy).
- [ ] **Step 4: Chạy lại** → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-heap && git commit -m "feat(debugger): map heap object ids to dense indices"`

---

### Task 3: Dựng đồ thị object (CSR)

**Files:**

- Create: `crates/ide-heap/src/graph.rs`

**Interfaces:**

- Consumes: Task 1 (`scan`, `scan_segment`, `HeapRecord`, `ClassDump`), Task 2 (`IdMap`, `Store`, `Column`).
- Produces:

```rust
pub struct ClassInfo { pub id: u64, pub name: String /* dạng hprof, '/' → '.' */, pub super_index: Option<u32>,
    pub fields: Vec<(String, BasicType)> /* chỉ của class này */, pub statics: Vec<(String, u64)>, pub static_bytes: u64, pub weak_field: Option<usize> }
pub const PRIM_TYPE_BASE: u32;  // type id của mảng primitive = PRIM_TYPE_BASE + BasicType as u32; class dump: type = chỉ số java.lang.Class
pub struct HeapGraph { pub ids: IdMap, pub types: Column<u32>, pub lens: Column<u32> /* độ dài mảng, 0 cho instance */,
    pub offsets: Column<u64> /* vị trí record trong file */, pub out_start: Column<u32> /* n+2 */, pub out: Column<u32>,
    pub root: u32 /* = n, nút gốc ảo */, pub roots: Vec<(u32, HeapRootKind, Option<u32>)>, pub classes: Vec<ClassInfo>,
    pub thread_objects: HashMap<u32 /*serial*/, u32 /*object*/>, pub weak_edges_skipped: u64, pub id_size: u8, pub timestamp_ms: u64 }
pub fn build_graph(buf: &[u8], store: &Store, progress: &dyn Fn(Phase, u64, u64), cancel: &CancellationToken) -> Result<HeapGraph, HeapError>
```

Ba lượt: (1) `scan` toàn file: string, LOAD CLASS, class dump, root, `IdMapBuilder::insert` cho mọi class/instance/mảng, nhớ các segment; (2) mỗi segment: `types`, `lens`, `offsets`, đếm bậc ra vào `out_start[i + 1]`; (3) điền `out` (con trỏ ghi là `out_start[i]`, cuối lượt dịch lại một ô — không cần mảng thứ hai). Cạnh: instance → mọi field `Object` của class và các class cha (thứ tự trong `data`: field của class này trước, rồi của cha) trừ `Reference.referent` (đếm vào `weak_edges_skipped`), instance → class của nó; mảng object → phần tử; class dump → super, loader, static `Object`. Id 0 hoặc không có trong dump → bỏ. Gốc ảo `n` → mọi root (khử trùng). Instance có `class_id` không có class dump → `MissingClass`. `Phase` định nghĩa ở Task 6 (`Reading`, `Linking`); tiến độ theo byte đã đọc.

- [ ] **Step 1: Viết test thất bại** (MiniHeap, id 8 byte):

```rust
// fixture `sample()` dùng chung với Task 6: class Holder{a: Object, b: Object}, Node{next: Object, v: Long}, java.lang.ref.Reference{referent: Object, queue: Object},
// java.lang.ref.WeakReference extends Reference; object H=0x1000 Holder{a: N1, b: N2}, N1=0x1100 Node{next: N3}, N2=0x1200 Node{next: N3},
// N3=0x1300 Node{next: L}, L=0x1400 long[2], R=0x1500 Object[]{N1, 0, 0}, W=0x1600 WeakReference{referent: N4}, N4=0x1700 Node{};
// root JniGlobal H, JavaFrame N3 (thread serial 1), JniGlobal W
#[test] fn edges_follow_fields_and_skip_weak_referents() // out của H = [N1, N2, class Holder]; out của W = [class WeakReference] (không có N4); weak_edges_skipped == 1
#[test] fn object_arrays_skip_null_and_unknown() // out của R = [N1]
#[test] fn super_root_points_at_each_root_once() // root thêm JniGlobal H lần nữa → out của root có H một lần
#[test] fn class_dump_edges_cover_statics() // class có static ref tới N1 → out của class chứa N1
#[test] fn missing_class_is_an_error()
#[test] fn cancel_during_linking_returns_cancelled() // token huỷ trước → Err(Cancelled)
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo nextest run -p ide-heap graph` → FAIL.
- [ ] **Step 3: Cài đặt** như trên.
- [ ] **Step 4: Chạy lại** → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-heap && git commit -m "feat(debugger): build the heap object graph"`

---

### Task 4: Dominator (semi-NCA không dùng stack)

**Files:**

- Create: `crates/ide-heap/src/dominators.rs`

**Interfaces:**

- Consumes: Task 2 (`Store`, `Column`, `NONE`).
- Produces:

```rust
pub struct Dominators { pub idom: Column<u32> /* không gian nút; NONE = không reachable; idom[root] = root */,
    pub preorder: Column<u32> /* thứ tự DFS → nút, dài `reachable` */, pub reachable: u32 }
pub fn dominators(out_start: &[u32], out: &[u32], root: u32, store: &Store, cancel: &CancellationToken) -> Result<Dominators, HeapError>
```

Thuật toán (đã kiểm ở H5, viết lại cho sạch):

```text
DFS từ root, không stack: pre[v] (nút → số DFS), vertex[d], parent[d], cur[d] (số cạnh đã đi) — "stack" chính là chuỗi parent.
CSR ngược trong không gian số DFS (rs: u32 n+1, rt: u32), điền bằng con trỏ rs[w]++ rồi dịch lại một ô; bỏ pre.
semi = cur (dùng lại), label[d] = d, anc[d] = NONE.
for w = reachable-1 .. 1:  s = semi[w]
    for v in pred(w): u = (anc[v] == NONE) ? v : eval(v)   // eval nén đường v → gốc rừng, label giữ đỉnh có semi nhỏ nhất
                      s = min(s, semi[u])
    semi[w] = s; anc[w] = parent[w]
idom = anc (dùng lại); idom[0] = 0; for w = 1 .. reachable-1: x = parent[w]; while x > semi[w]: x = idom[x]; idom[w] = x
chuyển idom về không gian nút qua vertex.
```

Stack nén đường của `eval` là `Vec<u32>` tạm (độ sâu rừng sau nén, không phải độ sâu đồ thị).

- [ ] **Step 1: Viết test thất bại** (tham chiếu dataflow bitset và Cooper–Harvey–Kennedy viết trong `#[cfg(test)]`):

```rust
#[test] fn diamond() // 0→1, 0→2, 1→3, 2→3, 3→4 → idom [0, 0, 0, 0, 3]
#[test] fn unreachable_is_none() // nút 5 không có cạnh tới → idom[5] == NONE; reachable == 5
#[test] fn cycle_back_to_root() // 0→1→2→1, 2→0 → idom [0, 0, 1]
proptest! { #[test] fn matches_dataflow_on_random_graphs(n in 2usize..64, edges in vec((0u32..64, 0u32..64), 0..192)) } // so với Dom-set lặp: bằng nhau ở mọi nút
#[test] fn matches_chk_on_a_million_nodes()     // cây ngẫu nhiên 1M + 500k cạnh ngẫu nhiên, seed cố định → 0 khác biệt
#[test] fn deep_chain_has_linear_dominators()   // chuỗi 1M nút 0→1→…→999999 (+ cạnh 0→999999) → idom[i] = i-1 trừ idom[999999] = 0; không tràn stack trên thread test mặc định (2 MiB)
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo nextest run -p ide-heap dominators` → FAIL.
- [ ] **Step 3: Cài đặt** như trên; kiểm `cancel` mỗi `1 << 20` vòng ở DFS và vòng semi.
- [ ] **Step 4: Chạy lại** → PASS (`--release` không bắt buộc; hai test 1M phải < 10 s ở debug).
- [ ] **Step 5: Commit**: `git add crates/ide-heap && git commit -m "feat(debugger): compute heap dominators with semi-NCA"`

---

### Task 5: Shallow size và tên class

**Files:**

- Create: `crates/ide-heap/src/shallow.rs`, `crates/ide-heap/src/names.rs`

**Interfaces:**

- Consumes: Task 3 (`HeapGraph`, `ClassInfo`, `PRIM_TYPE_BASE`).
- Produces:

```rust
pub fn display_name(hprof_name: &str) -> String  // cùng quy tắc với ide_jvm_attach::display_class_name, thêm '+0x' → '/0x' (class ẩn)
#[derive(Clone, Copy, Debug, PartialEq)] pub struct VmLayout { pub header: u8, pub ref_size: u8, pub length_offset: u8, pub legacy_array_base: bool, pub alignment: u8 }
impl VmLayout { pub const DEFAULT: VmLayout /* 12, 4, 12, false, 8 */; pub fn from_vm_flags(flags: &str, java_major: u32) -> Self;
    pub fn instance_size(&self, field_bytes: u64) -> u64; pub fn array_size(&self, ty: BasicType, len: u64) -> u64 }
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)] #[serde(rename_all = "camelCase")] pub enum SizeSource { Jvm, AddressGaps, Layout }
pub struct HistogramEntry { pub name: String /* dạng hiển thị */, pub instances: u64, pub bytes: u64 }
pub struct ShallowModel { pub source: SizeSource, /* kích thước instance theo type, layout cho mảng */ }
impl ShallowModel { pub fn new(graph: &HeapGraph, layout: VmLayout, histogram: Option<&[HistogramEntry]>) -> Self; pub fn size_of(&self, graph: &HeapGraph, object: u32) -> u64 }
```

Quy tắc:

- `from_vm_flags`: `UseCompactObjectHeaders` bật → header 8, length offset 8; ngược lại compressed class pointers (bật trừ khi có `-XX:-UseCompressedClassPointers`; JDK < 15: chỉ khi compressed oops bật) → 12/12; không → 16/16. `ref_size` 4 trừ khi `-XX:-UseCompressedOops`. `ObjectAlignmentInBytes=N` nếu có, mặc định 8. `legacy_array_base = java_major <= 21`.
- `instance_size = max(align(header + field_bytes, alignment), header == 8 ? 8 : 16)`; `field_bytes` = tổng `heap_size(ref_size)` của field mọi class trong chuỗi cha.
- `array_size`: base = `legacy ? align(length_offset + 4, 8) : align(length_offset + 4, elem)`; `align(base + elem × len, alignment)`; mảng object dùng `ref_size`.
- Class dump: `instance_size(java.lang.Class) + static_bytes + ref_size × số static ref`, căn theo alignment.
- Có histogram (capture của IDE) → `source = Jvm`: class không phải mảng có dòng histogram cùng tên với `bytes % instances == 0` → `bytes / instances`; còn lại theo layout.
- Không có (file ngoài): mỗi type instance, khoảng cách nhỏ nhất `id[i+1] - id[i]` giữa object liền nhau theo `IdMap::ids()` mà object kế tiếp có id lớn hơn; dùng nó nếu type có ≥ 2 instance và `layout ≤ gap ≤ layout + 64`, ngược lại layout. `source = AddressGaps` nếu ≥ 90% type instance dùng khoảng cách, ngược lại `Layout`.

- [ ] **Step 1: Viết test thất bại** (giá trị từ H4):

```rust
#[test] fn display_names() // ("[Z","boolean[]"), ("[J","long[]"), ("[[D","double[][]"), ("[Ljava/lang/String;","java.lang.String[]"), ("java/util/HashMap$Node","java.util.HashMap$Node"), ("Gen$$Lambda+0x0000007800000a00","Gen$$Lambda/0x0000007800000a00")
#[test] fn layout_from_flags() // "-XX:+UseCompressedOops -XX:+UseG1GC" 21 → DEFAULT với legacy true; "-XX:-UseCompressedOops" 21 → ref 8, header 12; "-XX:+UseCompactObjectHeaders" 25 → header 8; "-XX:-UseCompressedOops" 11 → header 16; "-XX:ObjectAlignmentInBytes=16" → alignment 16
#[test] fn instance_sizes_match_the_jvm() // field: A{byte} B{long} C{int,long,byte} D:C{short,Object} E{Object×3} F:A{byte} G{} H:B{int} Node{long,Object,Object}
    // coops (21): A16 B24 C32 D32 E24 F16 G16 H24 Node32 ; -coops (21): D40 E40 Node40 ; compact (25): G8 B16 C24 D32 Node24
#[test] fn array_sizes() // DEFAULT: long[2]=32, byte[5]=24, Object[3]=32 ; compact: byte[5]=24, int[1]=16, long[1]=24 ; 21 không ccp: byte[1]=32 ; 25 không ccp: byte[1]=24, long[1]=32
#[test] fn histogram_wins_for_instances() // histogram "java.lang.Thread" 13 instances 1560 bytes, layout cho 104 → size_of(thread) == 120; source Jvm
#[test] fn address_gaps_for_external_dumps() // ba instance A ở 0x1000, 0x1010, 0x1020 rồi object khác ở 0x1030 → 16; class Module duy nhất một instance → layout; source theo ngưỡng 90%
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo nextest run -p ide-heap shallow names` → FAIL.
- [ ] **Step 3: Cài đặt** như trên.
- [ ] **Step 4: Chạy lại** → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-heap && git commit -m "feat(debugger): compute shallow sizes of heap objects"`

---

### Task 6: Phân tích: retained, retained theo class, cha tới GC root, chỉ mục

**Files:**

- Create: `crates/ide-heap/src/analysis.rs`, `crates/ide-heap/src/index.rs` (phần ghi và kiểu)
- Modify: `crates/ide-heap/src/lib.rs`

**Interfaces:**

- Consumes: Task 3–5.
- Produces:

```rust
#[derive(Clone, Copy, Debug, Serialize, Deserialize, specta::Type)] #[serde(rename_all = "camelCase")]
pub enum HeapPhase { Reading, Linking, Dominators, Retained, Paths, Saving }
pub struct AnalyzeOptions { pub histogram: Option<Vec<HistogramEntry>>, pub vm_flags: Option<String>, pub java_major: Option<u32>, pub in_memory: bool }
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)] #[serde(rename_all = "camelCase")]
pub struct HeapSummary { pub objects: u64, pub reachable_objects: u64, pub reachable_bytes: u64, pub unreachable_objects: u64,
    pub unreachable_bytes: u64, pub classes: u32, pub weak_edges_skipped: u64, pub size_source: SizeSource, pub analysis_ms: u32 }
pub struct ClassStat { pub name: String /* display_name */, pub count: u64 /* reachable */, pub shallow: u64, pub retained: u64, pub unreachable_count: u64 }
pub struct HeapIndex { /* mmap: types, shallow8 (u32, đơn vị 8 byte), retained (u64), idom, kids_start, kids (con trên cây dominator, giảm dần theo retained),
    gc_parent, offsets, ids; classes: Vec<ClassStat>; roots: HashMap<u32, (HeapRootKind, Option<u32>)>; hprof: memmap2::Mmap; summary: HeapSummary */ }
pub fn analyze(hprof: &Path, index_dir: &Path, opts: AnalyzeOptions, progress: &dyn Fn(HeapPhase, u64, u64), cancel: &CancellationToken) -> Result<HeapIndex, HeapError>
```

Các bước sau `build_graph` + `dominators`:

- `retained[v] = shallow(v) + Σ retained` theo thứ tự DFS ngược (`preorder` từ cuối, cộng vào `idom`). Nút gốc ảo không tính vào summary.
- `kids_start`/`kids`: CSR con theo `idom` (đếm rồi điền), mỗi đoạn sắp giảm dần theo `retained`, bằng nhau thì theo chỉ số.
- Retained theo class = tổng `retained` của các instance không có tổ tiên (trên cây dominator) cùng class. Duyệt cây dominator **không stack**: con trỏ cha là `idom`, con trỏ con là cursor trong `kids` (cột tạm `u32`); mảng `active[type]` tăng khi vào nút, giảm khi ra; vào nút có `active[type] == 0` thì cộng `retained`.
- `gc_parent`: BFS từ gốc ảo trên `out` (hàng đợi là cột tạm `u32` dài n+1); dùng cho đường ngắn nhất. Object không reachable: `gc_parent = NONE`, tính vào `unreachable_*` và `ClassStat.unreachable_count`.
- Ghi cột vào `index_dir` (`Store::Dir`, hoặc `Store::Ram` khi `in_memory`), xoá mảng tạm, trả `HeapIndex`. Lỗi hoặc huỷ: xoá mọi file đã ghi trong `index_dir`.

- [ ] **Step 1: Viết test thất bại** (`analysis.rs`, fixture `sample()` của Task 3, layout `VmLayout::DEFAULT`, `in_memory: true`):

```rust
#[test] fn sample_retained_sizes() // shallow: Holder 24, Node 24, long[2] 32, WeakReference 24, Object[3] 32
    // retained: L 32, N3 56, N1 24, N2 24, H 72, W 24; idom: N1,N2 → H; N3 → root; L → N3
#[test] fn sample_class_table() // Node: count 3, shallow 72, retained 104, unreachable_count 1 ; Holder: 1/24/72 ; long[]: 1/32/32 ; WeakReference: 1/24/24 ; Object[]: count 0, unreachable_count 1
#[test] fn sample_summary() // reachable_objects 6 (không tính class dump), reachable_bytes 152, unreachable_objects 2, unreachable_bytes 56, weak_edges_skipped 1
#[test] fn cycle_is_retained_once() // A ↔ B, root A, Node 24 → retained(A) 48, retained(B) 24
#[test] fn deep_chain_retained_by_class() // 1M Node một chuỗi từ root → retained(head) 24_000_000; retained theo class Node 24_000_000; không tràn stack
#[test] fn histogram_sizes_flow_into_retained() // AnalyzeOptions.histogram có "Node" 3 instances 96 bytes → shallow Node 32 → retained N3 64
#[test] fn cancel_stops_analysis() // token huỷ trong progress callback ở phase Dominators → Err(Cancelled), index_dir rỗng
#[test] fn writes_index_files() // Store::Dir(tempdir) → có types.u32, shallow8.u32, retained.u64, idom.u32, kids_start.u32, kids.u32, gc_parent.u32, offsets.u64, ids.*, summary.json
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo nextest run -p ide-heap analysis` → FAIL.
- [ ] **Step 3: Cài đặt** như trên; `progress` gọi khi đổi phase và mỗi `1 << 20` bước.
- [ ] **Step 4: Chạy lại** → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-heap && git commit -m "feat(debugger): compute retained sizes and paths to GC roots"`

---

### Task 7: Truy vấn chỉ mục và so sánh snapshot

**Files:**

- Modify: `crates/ide-heap/src/index.rs` (truy vấn)
- Create: `crates/ide-heap/src/compare.rs`, `crates/ide-heap/src/strings.rs`

**Interfaces:**

- Consumes: Task 6 (`HeapIndex`, `ClassStat`).
- Produces (serde camelCase, `specta::Type`):

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)] #[serde(transparent)] pub struct HeapObjectRef(pub u32);
pub struct HeapClassRow { pub class_index: u32, pub name: String, pub count: u64, pub shallow: u64, pub retained: u64, pub unreachable_count: u64 }
pub struct HeapObjectRow { pub object: HeapObjectRef, pub class_name: String, pub address: String /* "0x1300" */, pub shallow: u64, pub retained: u64, pub has_children: bool, pub preview: Option<String> }
pub struct HeapObjectPage { pub rows: Vec<HeapObjectRow>, pub total: u32 }
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum HeapEdge { Field { name: String }, Element { index: u32 }, Static { name: String }, ClassOf, SuperClass, ClassLoader, Root { root: HeapRootKind, thread: Option<String> } }
pub struct HeapPathStep { pub object: HeapObjectRow, pub via: HeapEdge }   // via = cách object này được giữ bởi bước kế tiếp (bước cuối: Root)
pub struct HeapClassDiff { pub name: String, pub base_count: u64, pub count: u64, pub base_shallow: u64, pub shallow: u64, pub base_retained: u64, pub retained: u64 }
pub const MAX_PAGE: u32 = 500;
impl HeapIndex { pub fn summary(&self) -> &HeapSummary; pub fn class_rows(&self) -> Vec<HeapClassRow>;
    pub fn dominated(&self, parent: Option<HeapObjectRef>, class_index: Option<u32>, offset: u32, limit: u32) -> HeapObjectPage;
    pub fn path_to_root(&self, object: HeapObjectRef) -> Option<Vec<HeapPathStep>>; pub fn object_row(&self, object: HeapObjectRef) -> HeapObjectRow }
pub fn compare(base: &HeapIndex, current: &HeapIndex) -> Vec<HeapClassDiff>
pub(crate) fn string_preview(index: &HeapIndex, object: u32, max_chars: usize) -> Option<String>
```

- `dominated(None, None, …)`: con của gốc ảo, bỏ class dump (chúng có retained ≈ 0, không giúp gì); `dominated(Some(p), None, …)`: con của `p`; `dominated(None, Some(c), …)`: mọi instance reachable của class `c` giảm dần theo retained (top-k bằng heap nhỏ kích thước `offset + limit`). `limit` kẹp vào `MAX_PAGE`.
- `path_to_root`: theo `gc_parent` tới gốc ảo; tên field lấy bằng `record_at` của object cha rồi tìm field `Object` đầu tiên có id bằng id object con (`Element` cho mảng; class dump: `Static`, `SuperClass`, `ClassLoader`; instance → class của nó: `ClassOf`); bước cuối `Root` theo `roots`, `thread` là `string_preview` của field `name` của thread object (`thread_objects[serial]`). Không reachable → `None`.
- `string_preview`: chỉ `java.lang.String`: field `value` (`byte[]` + `coder` 0 Latin-1 / 1 UTF-16 BE theo hprof, hoặc `char[]` ở JDK 8), cắt `max_chars` thêm `…`. `HeapObjectRow.preview` dùng `max_chars = 100`.
- `compare`: khoá theo `name`, class chỉ có một bên thì bên kia 0; sắp giảm dần theo `|retained - base_retained|`, rồi theo tên.

- [ ] **Step 1: Viết test thất bại** (fixture `sample()`, thêm String S=0x1800 `"v42"` Latin-1 làm field `a` của một Holder thứ hai rooted):

```rust
#[test] fn top_level_dominators_sorted_by_retained() // dominated(None, None, 0, 10).rows: H(72), N3(56), W(24)…; total không gồm class dump
#[test] fn children_of_holder() // dominated(Some(H), None, 0, 10) → N1, N2 (retained 24, bằng nhau → theo chỉ số); has_children(N3) == true
#[test] fn largest_of_class() // dominated(None, Some(node), 0, 2) → [N3 (56), N1 (24)], total 3
#[test] fn path_to_root_names_fields_and_root() // path_to_root(L) → [L via Field "next", N3 via Root { JavaFrame, thread: None }]; path_to_root(N1) → [N1 via Field "a", H via Root { JniGlobal }]; path_to_root(N4) == None
#[test] fn thread_name_on_java_frame_root() // ROOT_THREAD_OBJECT serial 1 → Thread{name: String "main"} → Root.thread == Some("main")
#[test] fn string_preview_latin1_and_utf16() // "v42" → Some("v42"); UTF-16 "hé" → Some("hé"); 150 ký tự → 100 ký tự + "…"
#[test] fn compare_counts_by_class() // base sample(), current sample() + 2 Node rooted → Node: base_count 3, count 5, shallow +48; class chỉ có ở current: base_* = 0
#[test] fn page_limit_is_clamped() // limit 10_000 → ≤ 500 dòng
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo nextest run -p ide-heap index compare strings` → FAIL.
- [ ] **Step 3: Cài đặt** như trên.
- [ ] **Step 4: Chạy lại** → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-heap && git commit -m "feat(debugger): query dominators, paths and snapshot differences"`

---

### Task 8: Đĩa, thư mục snapshot và `HeapRegistry`

**Files:**

- Create: `crates/ide-heap/src/disk.rs`, `crates/ide-heap/src/registry.rs`

**Interfaces:**

- Consumes: Task 6–7.
- Produces:

```rust
pub const DISK_MARGIN: u64 = 1 << 30;
pub fn free_bytes(dir: &Path) -> Option<u64>               // unix: statvfs f_bavail × f_frsize; khác: None (bỏ kiểm)
pub fn capture_need(heap_bytes: u64, instances: u64) -> u64 // heap_bytes + 106 × instances + DISK_MARGIN
pub fn index_need(objects: u64) -> u64                      // 90 × objects + DISK_MARGIN
pub fn snapshots_root(local_data_dir: &Path) -> PathBuf     // <local>/cache/heap-snapshots
pub fn create_snapshot_dir(root: &Path) -> io::Result<PathBuf> // <root>/<uuid v4>/ + file `owner` = pid hiện tại
pub fn remove_stale(root: &Path, alive: impl Fn(u32) -> bool) // xoá thư mục có owner không đọc được hoặc pid chết
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)] #[serde(transparent)] pub struct HeapSnapshotId(pub u32);
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum HeapOrigin { Captured { session: DebugSessionId, pid: u32, java_version: String, taken_while_suspended: bool, dump_ms: u32 }, File { path: IpcPath } }
pub struct HeapSnapshotInfo { pub id: HeapSnapshotId, pub label: String, pub origin: HeapOrigin, pub summary: HeapSummary, pub created_ms: u64 }
pub struct OpenSnapshot { pub info: HeapSnapshotInfo, pub index: HeapIndex, pub dir: PathBuf, pub dump: PathBuf }  // Drop: xoá `dir`
pub struct HeapRegistry;
impl HeapRegistry { pub fn new(root: PathBuf) -> Self /* gọi remove_stale */; pub fn root(&self) -> &Path;
    pub fn insert(&self, make: impl FnOnce(HeapSnapshotId) -> OpenSnapshot) -> HeapSnapshotInfo; pub fn get(&self, id: HeapSnapshotId) -> Option<Arc<OpenSnapshot>>;
    pub fn close(&self, id: HeapSnapshotId) -> bool; pub fn list(&self) -> Vec<HeapSnapshotInfo> }
```

Dump đã capture nằm trong `dir` nên bị xoá cùng; file ngoài (`origin = File`) không bao giờ bị xoá, chỉ `dir` chứa chỉ mục. Label: capture → `"<pid> · HH:MM:SS"`, file → tên file.

- [ ] **Step 1: Viết test thất bại**:

```rust
#[test] fn estimates() // capture_need(664_018_520, 20_087_506) == 664_018_520 + 106 × 20_087_506 + (1 << 30); index_need(10) == 900 + (1 << 30)
#[test] fn not_enough_space_for_estimate() // free_bytes(tempdir) là Some(x) > 0 trên unix; capture_need(u64::MAX / 4, 0) > x
#[test] fn closing_snapshot_removes_dir() // insert snapshot có dir tạm chứa dump.hprof → close → dir không còn; close lần nữa → false
#[test] fn external_dump_is_never_deleted() // origin File, dump ngoài dir → sau close file vẫn còn
#[test] fn stale_dirs_removed_on_start() // root có a/owner = "999999" (alive false), b/owner = pid hiện tại, c/ không có owner → HeapRegistry::new: còn mỗi b
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo nextest run -p ide-heap disk registry` → FAIL.
- [ ] **Step 3: Cài đặt.** `alive` thật: `libc::kill(pid, 0) == 0 || errno == EPERM` (unix), Windows coi là còn sống.
- [ ] **Step 4: Chạy lại** → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-heap && git commit -m "feat(debugger): keep heap snapshots in removable directories"`

---

### Task 9: Lệnh `GC.heap_dump` và `VM.flags` trong `ide-jvm-attach`

**Files:**

- Create: `crates/ide-jvm-attach/src/heap_dump.rs`
- Modify: `crates/ide-jvm-attach/src/lib.rs`, `crates/ide-jvm-attach/tests/real_jvm.rs`

**Interfaces:**

- Consumes: `jcmd` của M1.
- Produces:

```rust
pub fn heap_dump_command(path: &Path) -> Result<String, AttachError>  // "GC.heap_dump -all \"<path>\""; path chứa '"', '\0', '\n', '\r' hoặc không UTF-8 → Err(Protocol)
#[derive(Debug, PartialEq)] pub enum HeapDumpReply { Created { bytes: Option<u64> }, Refused { message: String } }
pub fn parse_heap_dump_reply(body: &str) -> HeapDumpReply
pub fn heap_dump(pid: u32, path: &Path, timeout: Duration) -> Result<HeapDumpReply, AttachError>
pub fn vm_flags(pid: u32, timeout: Duration) -> Result<String, AttachError>   // jcmd "VM.flags"
pub fn dump_timeout(heap_bytes: u64) -> Duration                             // 30 s + heap_bytes / (256 MiB/s)
```

- [ ] **Step 1: Viết test thất bại**:

```rust
#[test] fn heap_dump_command_quotes_path() // "/a b/c.hprof" → r#"GC.heap_dump -all "/a b/c.hprof""#; "/x\"y" → Err; "/x\ny" → Err
#[test] fn heap_dump_replies() {
    assert_eq!(parse_heap_dump_reply("Heap dump file created\n"), HeapDumpReply::Created { bytes: None });   // JDK 8
    assert_eq!(parse_heap_dump_reply("Dumping heap to out/x.hprof ...\nHeap dump file created [16826526 bytes in 0.010 secs]\n"), HeapDumpReply::Created { bytes: Some(16826526) });
    assert_eq!(parse_heap_dump_reply("Dumping heap to /nonexistent/dir/x.hprof ...\nUnable to create /nonexistent/dir/x.hprof: No such file or directory"),
               HeapDumpReply::Refused { message: "Unable to create /nonexistent/dir/x.hprof: No such file or directory".into() });
    assert_eq!(parse_heap_dump_reply("Dumping heap to s p/dq.hprof ...\nUnable to create s p/dq.hprof: File exists"), HeapDumpReply::Refused { message: "Unable to create s p/dq.hprof: File exists".into() });
}
#[test] fn dump_timeout_scales() // 0 → 30 s; 4 GiB → 46 s
// real_jvm.rs (#[ignore], OPENIDEA_TEST_JAVA): chương trình M1 (1000 Main$Item) chạy với -XX:+StartAttachListener, đang chạy:
//   vm_flags chứa "-XX:+StartAttachListener"; heap_dump(pid, <tempdir>/"a b"/"x.hprof", 30 s) → Created, file > 0 byte
//   dump lần hai cùng đường dẫn → Refused chứa "File exists"
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo nextest run -p ide-jvm-attach heap_dump` → FAIL.
- [ ] **Step 3: Cài đặt.** Nhận `Created` khi có dòng chứa `Heap dump file created`; `Refused` lấy dòng cuối không rỗng không bắt đầu bằng `Dumping heap to`.
- [ ] **Step 4: Chạy lại**: lệnh trên → PASS; `OPENIDEA_TEST_JAVA=$HOME/.sdkman/candidates/java/21.0.4-tem/bin/java cargo nextest run -p ide-jvm-attach --test real_jvm --run-ignored only` → PASS (lặp với 11 và 25).
- [ ] **Step 5: Commit**: `git add crates/ide-jvm-attach && git commit -m "feat(debugger): request heap dumps over the attach listener"`

---

### Task 10: Capture theo phiên trong `ide-dap`

**Files:**

- Create: `crates/ide-dap/src/jvm_memory/heap.rs`
- Modify: `crates/ide-dap/Cargo.toml` (`ide-heap.workspace = true`), `crates/ide-dap/src/jvm_memory/mod.rs` (`mod heap; pub use heap::*;`), `crates/ide-dap/src/jvm_memory/snapshot.rs` (`AttachProbe` thêm `vm_flags`, `heap_dump`; `JdkProbe` cài), `crates/ide-dap/src/jvm_memory/tests.rs`, `crates/ide-dap/src/lib.rs` (`DebugCapabilities.jvm_heap`, method mới)

**Interfaces:**

- Consumes: Task 8 (`capture_need`, `free_bytes`), Task 9; M1 (`JvmTarget`, khoá `session.jvm_memory`, `Suspension`, `pick_jvm_pid`, `safe_while_suspended`, `scan_for_jvm`, `JvmMemoryUnavailable`).
- Produces:

```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum JvmHeapUnavailable { Memory { reason: JvmMemoryUnavailable }, NotEnoughDiskSpace { needed: u64, available: u64 }, DumpFailed { message: String }, DumpTimedOut { seconds: u32 } }
pub struct JvmHeapDump { pub path: PathBuf, pub histogram: Vec<ide_heap::HistogramEntry>, pub vm_flags: String, pub java_major: u32,
    pub java_version: String, pub pid: u32, pub taken_while_suspended: bool, pub dump_ms: u32 }
pub enum JvmHeapOutcome { Ready(JvmHeapDump), Unavailable(JvmHeapUnavailable), Cancelled }
impl DebugManager { pub async fn jvm_heap_dump(&self, s: DebugSessionId, dir: PathBuf, cancel: CancellationToken) -> IdeResult<JvmHeapOutcome> }
// trait AttachProbe thêm:
fn vm_flags(&self, pid: u32) -> Result<String, AttachError>;
fn heap_dump(&self, pid: u32, path: &Path, timeout: Duration) -> Result<HeapDumpReply, AttachError>;
fn free_bytes(&self, dir: &Path) -> Option<u64>;
pub(crate) fn take_heap_dump(probe: &dyn AttachProbe, tree: &[i32], suspended: bool, dir: &Path, cancel: &CancellationToken) -> Result<JvmHeapDump, JvmHeapUnavailable>
```

`DebugCapabilities.jvm_heap = JVM_MEMORY_ADAPTERS.contains(adapter)` (như `jvm_memory`). Thứ tự trong `take_heap_dump`:

1. Tìm pid như `take_snapshot` của M1 (cùng lý do `Memory { … }` khi không có).
2. Phiên bản từ `probe.version(pid)` (file `release`). `suspended && !safe_while_suspended(version)` → `Memory { UnsafeWhileSuspended { java_major } }`, **không gửi lệnh nào**.
3. `probe.histogram(pid)` (`GC.class_histogram -all`, M1) → `parse_class_histogram` → tổng bytes/instances → `capture_need`; `free_bytes(dir)` nhỏ hơn → `NotEnoughDiskSpace`. `cancel` → `Cancelled` (trước khi dump).
4. `probe.vm_flags(pid)` (timeout 2 s; lỗi → chuỗi rỗng, layout mặc định).
5. `probe.heap_dump(pid, dir/"dump.hprof", dump_timeout(total_bytes))`: `Created` → `Ready`; `Refused` → `DumpFailed { message }`; `Timeout` → `DumpTimedOut { seconds }`; `Refused`/`NoListener` của socket → `Memory { ProgramExited | ListenerNotRunning }` như M1. Mọi kết quả khác `Ready` (kể cả huỷ trong lúc dump): `remove_dir_all(dir)`.

`jvm_heap_dump` khoá `session.jvm_memory` (giữ suốt phần đồng bộ, như M1), đọc `suspended` sau khi có khoá, chạy `take_heap_dump` trong `spawn_blocking`. Huỷ trong lúc dump: task chờ không bị bỏ (khoá nhả khi JVM trả lời), nhưng hàm trả `Cancelled` ngay và xoá `dir`.

- [ ] **Step 1: Viết test thất bại** (`tests.rs`, probe giả ghi lại các lệnh đã gọi):

```rust
#[test] fn suspended_jdk11_refuses_without_sending()   // version 11, suspended → Memory(UnsafeWhileSuspended { java_major: 11 }); probe không nhận histogram/flags/dump
#[test] fn suspended_jdk17_dumps()                      // version 17, suspended → Ready; thứ tự lệnh: histogram, vm_flags, heap_dump; path == dir/"dump.hprof"
#[test] fn running_jdk8_dumps()                         // version 8, không dừng → Ready
#[test] fn not_enough_disk_space_refuses_before_dump()  // histogram Total 1 GiB / 10M instances, free 512 MiB → NotEnoughDiskSpace { needed: 1 GiB + 1_060_000_000 + 1 GiB, available: 512 MiB }; không gọi heap_dump
#[test] fn refused_dump_reports_message()               // Refused("Unable to create …: File exists") → DumpFailed { message } và dir bị xoá
#[test] fn timed_out_dump_removes_snapshot_dir()        // heap_dump Err(Timeout) → DumpTimedOut { seconds: 30 } (histogram nhỏ), dir không còn
#[test] fn capture_dir_with_space_is_quoted()           // dir "<tmp>/a b" → probe giả nhận path có dấu cách; heap_dump_command(path) Ok
#[tokio::test] async fn cancelled_capture_releases_lock() // probe heap_dump chặn 300 ms; cancel ở 50 ms → Cancelled; jvm_memory_classes ngay sau đó chờ tới khi dump xong rồi chạy được (không song song)
#[tokio::test] async fn capability_matches_memory()     // java-debug / kotlin → jvm_heap true; adapter khác false
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo nextest run -p ide-dap jvm_memory` → FAIL.
- [ ] **Step 3: Cài đặt** như trên.
- [ ] **Step 4: Chạy lại**: `cargo nextest run -p ide-dap` → PASS (test M1 vẫn xanh).
- [ ] **Step 5: Commit**: `git add crates/ide-dap && git commit -m "feat(debugger): take a heap dump of a debugged JVM"`

---

### Task 11: IPC `debug_heap_*`, tiến độ và huỷ

**Files:**

- Create: `crates/ide-host/src/ops/heap.rs`, `src-tauri/src/commands/heap.rs`
- Modify: `crates/ide-host/Cargo.toml` (`ide-heap.workspace = true`), `crates/ide-host/src/lib.rs` (`Host.heap: Arc<ide_heap::HeapRegistry>` tạo bằng `HeapRegistry::new(snapshots_root(&local_data_dir))`), `crates/ide-host/src/ops/mod.rs` (`heap::register(d)`), `src-tauri/src/commands/mod.rs`, `src/bindings.ts` (sinh lại)

**Interfaces:**

- Consumes: Task 6–8, Task 10.
- Produces (ide-host; tên RPC = tên hàm; tham số camelCase):

```rust
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum HeapProgress { Dumping, Analyzing { phase: HeapPhase, done: u64, total: u64 } }
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum HeapCaptureResult { Ready { snapshot: HeapSnapshotInfo }, Unavailable { reason: JvmHeapUnavailable }, Cancelled }
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum HeapOpenResult { Ready { snapshot: HeapSnapshotInfo }, NotEnoughDiskSpace { needed: u64, available: u64 }, Cancelled }
pub async fn debug_heap_capture(host: &Host, window: &str, session: DebugSessionId, request: RequestId, on_progress: Channel<HeapProgress>) -> IdeResult<HeapCaptureResult>
pub async fn debug_heap_open(host: &Host, window: &str, path: IpcPath, request: RequestId, on_progress: Channel<HeapProgress>) -> IdeResult<HeapOpenResult>
pub async fn debug_heap_classes(host: &Host, window: &str, snapshot: HeapSnapshotId) -> IdeResult<Vec<HeapClassRow>>
pub async fn debug_heap_dominators(host: &Host, window: &str, snapshot: HeapSnapshotId, parent: Option<HeapObjectRef>, class_index: Option<u32>, offset: u32, limit: u32) -> IdeResult<HeapObjectPage>
pub async fn debug_heap_path(host: &Host, window: &str, snapshot: HeapSnapshotId, object: HeapObjectRef) -> IdeResult<Option<Vec<HeapPathStep>>>
pub async fn debug_heap_compare(host: &Host, window: &str, base: HeapSnapshotId, current: HeapSnapshotId) -> IdeResult<Vec<HeapClassDiff>>
pub async fn debug_heap_save(host: &Host, window: &str, snapshot: HeapSnapshotId, path: IpcPath) -> IdeResult<()>   // copy dump; target tồn tại → ghi đè (dialog đã hỏi)
pub async fn debug_heap_close(host: &Host, window: &str, snapshot: HeapSnapshotId) -> IdeResult<()>
```

Capture: `require_trust` → `begin_request(request)` → `create_snapshot_dir` → gửi `Dumping` → `host.debugger.jvm_heap_dump(session, dir, cancel)` → `Ready` thì `spawn_blocking(analyze(dump, dir, AnalyzeOptions { histogram, vm_flags, java_major, in_memory: false }, progress → Analyzing, &cancel))` → `HeapRegistry::insert` → `end_request`. `HeapError::Cancelled` → `Cancelled` (thư mục đã xoá). `HeapError` khác → `IdeError::invalid(format!("{e}"))` và xoá thư mục. Open: tương tự, không có dump; kiểm `index_need` sau phase `Reading` (callback trả `Err` nếu thiếu chỗ → `NotEnoughDiskSpace`). Gửi tiến độ ít nhất cách nhau 100 ms (bỏ bớt). Truy vấn chạy `spawn_blocking`; id không tồn tại → `IdeError::not_found`. Tauri: wrapper mỏng như `inspect_code` (`crate::commands::sender(on_progress)`).

- [ ] **Step 1: Viết test thất bại** (`ops/heap.rs`, fixture `MiniHeap` ghi ra tempdir; `Host` test có sẵn trong crate):

```rust
#[tokio::test] async fn open_and_query_a_dump()   // debug_heap_open(sample.hprof) → Ready; classes có "Node" count 3 retained 104; dominators(None) đầu tiên retained 72; path(L) dài 2; close → thư mục index mất, file mẫu còn
#[tokio::test] async fn open_reports_progress_in_order() // channel nhận Analyzing theo phase không giảm, kết thúc bằng Saving
#[tokio::test] async fn cancelled_open_leaves_nothing()  // cancel_request trước khi chạy → Cancelled; snapshots_root rỗng
#[tokio::test] async fn not_a_dump_is_an_error()          // file "hello" → Err với message chứa "not a heap dump" (HeapError::NotHprof Display)
#[tokio::test] async fn compare_two_snapshots()           // mở sample và sample+2 Node → Node count 3 → 5
#[tokio::test] async fn unknown_snapshot_is_not_found()
#[tokio::test] async fn capture_without_jvm_session_is_unavailable() // session không phải JVM → Unavailable { Memory { NoJvmProcess } }
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo nextest run -p ide-host heap` → FAIL.
- [ ] **Step 3: Cài đặt** op, đăng ký trong `register`, lệnh Tauri trong `commands/heap.rs` và `mod.rs`.
- [ ] **Step 4: Chạy lại và sinh bindings**: lệnh trên → PASS; `pnpm gen:bindings` → `src/bindings.ts` có `debugHeapCapture`…`debugHeapClose`, `HeapProgress`, `HeapCaptureResult`, `JvmHeapUnavailable`, `HeapSnapshotInfo`; `DebugCapabilities` có `jvmHeap`.
- [ ] **Step 5: Commit**: `git add crates/ide-host src-tauri/src/commands/heap.rs src-tauri/src/commands/mod.rs src/bindings.ts && git commit -m "feat(debugger): expose heap snapshots over IPC"`

---

### Task 12: Store heap snapshot phía frontend

**Files:**

- Create: `src/features/debugger/heap/heapState.ts`, `src/features/debugger/heap/heapInput.ts`
- Test: `src/features/debugger/__tests__/heapState.test.ts`

**Interfaces:**

- Consumes: `commands.debugHeap*`, `call`, `nextRequestId`, `Channel`, `useDebug` (`sessions[id].stops`), `maybeEditorService` (`openInput`).
- Produces:

```ts
export const HEAP_KIND = "heap-snapshot";
export function heapInput(snapshot: HeapSnapshotInfo): EditorInput            // key `heap-snapshot:${id}`, data { id, label }
export interface CaptureState { request: number; progress: HeapProgress | null; error: string | null; unavailable: JvmHeapUnavailable | null }
export interface HeapSnapshotEntry { info: HeapSnapshotInfo; takenAtStop: number | null; classes: HeapClassRow[] | null }
export const useHeap: UseBoundStore<StoreApi<{ snapshots: Record<number, HeapSnapshotEntry>; captures: Record<DebugSessionId, CaptureState> }>>;
export async function captureHeap(session: DebugSessionId): Promise<void>   // bỏ qua nếu đang capture; Ready → lưu takenAtStop = stops lúc bấm, tải classes, mở editor
export function cancelCapture(session: DebugSessionId): void               // commands.cancelRequest(request)
export async function openHeapFile(path: string): Promise<void>
export async function closeHeapSnapshot(id: number): Promise<void>         // gọi từ onClose của editor kind
export function retainedForSession(session: DebugSessionId, stops: number): Map<string, number> | null // snapshot mới nhất của phiên có takenAtStop === stops
export function progressFraction(p: HeapProgress | null): number | null    // Dumping → null; Analyzing → (thứ tự phase + done/total) / 6
```

- [ ] **Step 1: Viết test thất bại** (mock `commands`, `Channel` giả phát sự kiện):

```ts
it("captures, stores the stop and opens the snapshot", ...)   // stops 4 → takenAtStop 4; openInput gọi với key "heap-snapshot:7"
it("ignores a second capture while one runs", ...)
it("keeps the reason when the JVM cannot dump", ...)           // { status: "unavailable", reason: { kind: "dumpTimedOut", seconds: 30 } } → captures[s].unavailable
it("clears the capture on cancel", ...)                        // { status: "cancelled" } → captures[s] bị xoá, không mở editor
it("retained per class only for the current stop", ...)        // takenAtStop 4: stops 4 → Map("Node" → 104); stops 5 → null
it("progress fraction", () => { expect(progressFraction({ type: "dumping" })).toBeNull(); expect(progressFraction({ type: "analyzing", phase: "dominators", done: 0, total: 1 })).toBeCloseTo(2 / 6); });
it("closing forgets the snapshot and tells the host", ...)
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `pnpm vitest run src/features/debugger/__tests__/heapState.test.ts` → FAIL.
- [ ] **Step 3: Cài đặt.** Khi phiên bị xoá khỏi `useDebug`, chỉ xoá `captures[session]` (snapshot vẫn mở tới khi đóng tab).
- [ ] **Step 4: Chạy lại** → PASS.
- [ ] **Step 5: Commit**: `git add src/features/debugger/heap src/features/debugger/__tests__/heapState.test.ts && git commit -m "feat(debugger): keep heap snapshots in the frontend"`

---

### Task 13: Tab Memory: Capture, tiến độ, cột Retained Size

**Files:**

- Modify: `src/features/debugger/memory/MemoryView.tsx`, `src/features/debugger/memory/MemoryView.module.css`, `src/features/debugger/memory/rows.ts` (`SortKey` thêm `"retained"`), `src/features/debugger/actions.ts`, `src/ui/icons.tsx` (icon `heap-snapshot`), `src/platform/locales/text/en.json`, `zh.json`
- Test: `src/features/debugger/__tests__/memoryView.test.tsx`, `src/features/debugger/__tests__/memoryRows.test.ts`

**Interfaces:**

- Consumes: Task 12 (`captureHeap`, `cancelCapture`, `useHeap`, `retainedForSession`, `progressFraction`), `sessionSupports("jvmHeap", session)`.
- Produces: action `debug.heap.capture` (title "Capture Heap Snapshot", category "Debug", icon `heap-snapshot`, `when: "debugHasJvmMemory"`, không phím mặc định, chạy cho phiên đang chọn). `visibleRows(rows, q, retained?: Map<string, number>)` sắp theo `retained` với giá trị thiếu ở cuối cả hai chiều.

Hành vi: nút icon Capture trên thanh công cụ (cạnh Refresh, chỉ khi `jvmHeap`), tooltip kèm câu "Writing the dump pauses the program for about a second per gigabyte of heap."; đang capture: nút thành Cancel, dòng trạng thái theo phase + thanh tiến độ (`progressFraction`); `unavailable` hiện văn bản theo `kind` (lý do `memory` dùng lại `unavailableText` của M1). Cột "Retained Size" chỉ hiện khi `retainedForSession(session, stops)` khác `null`; ô thiếu là "—".

Chuỗi (en → zh):

| en                                                                           | zh                                                              |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Capture Heap Snapshot                                                        | 捕获堆快照                                                      |
| Writing the dump pauses the program for about a second per gigabyte of heap. | 写入转储时程序会暂停，每 GB 堆约一秒。                          |
| Writing the heap dump…                                                       | 正在写入堆转储…                                                 |
| Reading the dump…                                                            | 正在读取转储…                                                   |
| Linking objects…                                                             | 正在关联对象…                                                   |
| Computing dominators…                                                        | 正在计算支配树…                                                 |
| Computing retained sizes…                                                    | 正在计算保留大小…                                               |
| Finding paths to GC roots…                                                   | 正在查找到 GC 根的路径…                                         |
| Saving the index…                                                            | 正在保存索引…                                                   |
| Cancel Heap Snapshot                                                         | 取消堆快照                                                      |
| Retained Size                                                                | 保留大小                                                        |
| Not enough disk space for the heap dump: {needed} needed, {available} free.  | 磁盘空间不足，无法保存堆转储：需要 {needed}，可用 {available}。 |
| The JVM could not write the heap dump: {message}                             | JVM 无法写入堆转储：{message}                                   |
| The JVM did not finish the heap dump within {n} seconds.                     | JVM 未能在 {n} 秒内完成堆转储。                                 |

- [ ] **Step 1: Viết test thất bại**:

```ts
it("shows Capture only for sessions with jvmHeap", ...)
it("runs a capture and shows its phase", ...)          // channel phát analyzing/dominators → "Computing dominators…"; nút có aria-label "Cancel Heap Snapshot"
it("explains a refused capture", ...)                  // notEnoughDiskSpace { needed: 3221225472, available: 536870912 } → "Not enough disk space for the heap dump: 3.0 GB needed, 512.0 MB free."
it("shows retained sizes from a snapshot of this stop", ...) // "Node" → "104 B"; sau khi stops tăng → cột biến mất
// memoryRows.test.ts
it("sorts by retained with missing values last", ...)
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `pnpm vitest run src/features/debugger/__tests__/memoryView.test.tsx src/features/debugger/__tests__/memoryRows.test.ts` → FAIL.
- [ ] **Step 3: Cài đặt** như trên (token trong `src/styles/tokens.css`, số canh phải `tabular-nums`).
- [ ] **Step 4: Chạy lại**: hai lệnh trên, `pnpm vitest run src/platform/locales` → PASS; `pnpm typecheck` → 0 lỗi.
- [ ] **Step 5: Commit**: `git add src/features/debugger/memory src/features/debugger/actions.ts src/ui/icons.tsx src/platform/locales/text/en.json src/platform/locales/text/zh.json src/features/debugger/__tests__/memoryView.test.tsx src/features/debugger/__tests__/memoryRows.test.ts && git commit -m "feat(debugger): capture heap snapshots from the Memory tab"`

---

### Task 14: Editor "Heap": class, dominator, đường tới GC root, so sánh, mở và lưu `.hprof`

**Files:**

- Create: `src/features/debugger/heap/HeapSnapshotEditor.tsx`, `src/features/debugger/heap/HeapSnapshotEditor.module.css`, `src/features/debugger/heap/HeapClasses.tsx`, `src/features/debugger/heap/HeapDominators.tsx`, `src/features/debugger/heap/HeapPath.tsx`, `src/features/debugger/heap/edgeText.ts`
- Modify: `src/features/debugger/index.ts` (`registerEditorKind({ kind: HEAP_KIND, title, icon: () => "heap-snapshot", onClose })`), `src/features/debugger/actions.ts`, `src/platform/locales/text/en.json`, `zh.json`
- Test: `src/features/debugger/__tests__/heapEditor.test.tsx`, `src/features/debugger/__tests__/heapEdgeText.test.ts`

**Interfaces:**

- Consumes: Task 11 (`commands.debugHeap*`), Task 12; `List`, `IconButton`, `Input`, `Select` từ `@/ui`; `formatBytes`, `formatCount` từ `../memory/rows`; `isRemoteWindow` từ `@/platform/remote`.
- Produces:
  - `export function HeapSnapshotEditor({ input }: { input: EditorInput })`; `export function edgeText(edge: HeapEdge): string` (`Field` → `.name`, `Element` → `[i]`, `Static` → tx `static {name}`, `ClassOf` → tx "class", `SuperClass` → tx "superclass", `ClassLoader` → tx "class loader", `Root` → nhãn theo `root` kèm thread).
  - Action `debug.heap.open` (title "Open Heap Dump…", category "Debug", không `when`, chạy `open({ filters: [{ name: "Heap dump", extensions: ["hprof"] }] })` rồi `openHeapFile`; trong cửa sổ remote: notification "Heap dumps can be opened in local windows only.").
  - Action `debug.heap.saveDump` (title "Save Heap Dump As…", `when` editor đang hiện là `heap-snapshot` có `origin.kind === "captured"`): dialog `save` → `debugHeapSave`.

Hành vi:

- Đầu editor: label, nguồn (pid · JDK · "taken while suspended" / đường dẫn file), tổng "{n} objects · {size} reachable · {u} unreachable", dòng nhỏ theo `sizeSource` ("Sizes from the JVM." / "Sizes estimated from the dump." / "Sizes computed from the default layout."). Nút Save (chỉ captured), chọn "Compare with…" (snapshot khác đang mở, mục đầu "No comparison").
- Chuyển view: **Classes** | **Dominators**. Classes: bảng ảo hoá Class, Count, Shallow Size, Retained Size (+ Count Diff, Retained Diff khi so sánh; bấm tiêu đề để sắp), ô lọc. Chọn class → khung dưới "Biggest objects of {name}" (`debugHeapDominators(null, classIndex, 0, 100)`).
- Dominators: cây ảo hoá, gốc là `debugHeapDominators(null, null, 0, 100)`; mở nút → con (100 mỗi lần, dòng "Show more"); cột Object (`className@address` + preview chuỗi), Shallow, Retained, % retained của `reachableBytes`.
- Chọn object ở bất kỳ đâu → khung "Path to GC Root": các bước từ object lên root, mỗi dòng `className@address` + `edgeText`. `null` → "This object is not reachable from a GC root.".
- Đóng tab → `closeHeapSnapshot`. Editor không `restorable` (snapshot không giữ qua lần khởi động).

Chuỗi (en → zh):

| en                                                       | zh                                       |
| -------------------------------------------------------- | ---------------------------------------- |
| Open Heap Dump…                                          | 打开堆转储…                              |
| Save Heap Dump As…                                       | 堆转储另存为…                            |
| Heap dumps can be opened in local windows only.          | 堆转储只能在本地窗口中打开。             |
| Heap: {label}                                            | 堆：{label}                              |
| Classes                                                  | 类                                       |
| Dominators                                               | 支配树                                   |
| Object                                                   | 对象                                     |
| Biggest objects of {name}                                | {name} 中最大的对象                      |
| Path to GC Root                                          | 到 GC 根的路径                           |
| This object is not reachable from a GC root.             | 此对象无法从 GC 根访问。                 |
| Show more                                                | 显示更多                                 |
| Compare with…                                            | 与…比较                                  |
| No comparison                                            | 不比较                                   |
| Count Diff                                               | 数量差异                                 |
| Retained Diff                                            | 保留大小差异                             |
| {n} objects · {size} reachable · {u} unreachable         | {n} 个对象 · 可达 {size} · 不可达 {u}    |
| Sizes from the JVM.                                      | 大小来自 JVM。                           |
| Sizes estimated from the dump.                           | 大小根据转储估算。                       |
| Sizes computed from the default layout.                  | 大小按默认布局计算。                     |
| taken while suspended                                    | 暂停时获取                               |
| This file is not a heap dump the IDE can read: {message} | 此文件不是 IDE 可读取的堆转储：{message} |
| static {name}                                            | 静态 {name}                              |
| class                                                    | 类对象                                   |
| superclass                                               | 父类                                     |
| class loader                                             | 类加载器                                 |
| JNI global                                               | JNI 全局引用                             |
| JNI local                                                | JNI 局部引用                             |
| Local variable in {thread}                               | {thread} 中的局部变量                    |
| Local variable                                           | 局部变量                                 |
| Native stack                                             | 本地栈                                   |
| System class                                             | 系统类                                   |
| Thread block                                             | 线程块                                   |
| Monitor                                                  | 监视器                                   |
| Thread {thread}                                          | 线程 {thread}                            |
| Unknown root                                             | 未知根                                   |

- [ ] **Step 1: Viết test thất bại**:

```ts
// heapEdgeText.test.ts
it("formats edges", () => { expect(edgeText({ kind: "field", name: "next" })).toBe(".next"); expect(edgeText({ kind: "element", index: 12 })).toBe("[12]");
  expect(edgeText({ kind: "root", root: "javaFrame", thread: "main" })).toBe("Local variable in main"); expect(edgeText({ kind: "root", root: "javaFrame", thread: null })).toBe("Local variable"); });
// heapEditor.test.tsx (mock commands)
it("lists classes with retained sizes", ...)            // "Node" · "3" · "72 B" · "104 B"
it("expands a dominator and shows more", ...)           // total 150 → dòng "Show more" → gọi offset 100
it("shows the path to the GC root of the selection", ...) // ".next", "Local variable in main"
it("compares with another open snapshot", ...)          // chọn snapshot 2 → cột Count Diff "+2"
it("hides Save for files opened from disk", ...)
it("closing the tab closes the snapshot", ...)          // onClose → commands.debugHeapClose(7)
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `pnpm vitest run src/features/debugger/__tests__/heapEditor.test.tsx src/features/debugger/__tests__/heapEdgeText.test.ts` → FAIL.
- [ ] **Step 3: Cài đặt** như trên.
- [ ] **Step 4: Chạy lại**: hai lệnh trên, `pnpm vitest run src/platform/locales` → PASS; `pnpm typecheck`, `pnpm lint`, `pnpm knip` → 0 lỗi.
- [ ] **Step 5: Commit**: `git add src/features/debugger/heap src/features/debugger/index.ts src/features/debugger/actions.ts src/platform/locales/text/en.json src/platform/locales/text/zh.json src/features/debugger/__tests__/heapEditor.test.tsx src/features/debugger/__tests__/heapEdgeText.test.ts && git commit -m "feat(debugger): browse heap snapshots in an editor tab"`

---

### Task 15: Bench, ngân sách, smoke, kiểm tra toàn bộ, xác minh trong app

**Files:**

- Create: `crates/ide-heap/benches/heap.rs`
- Modify: `crates/ide-heap/Cargo.toml` (`[[bench]] name = "heap" harness = false`, dev-dep `criterion = { version = "0.5", default-features = false }`, feature `test-support` bật cho bench), `perf/rust.ts` (`PACKAGES` thêm `"ide-heap"`), `perf/budgets.json` (`rust`), `smoke/debug.test.ts`

- [ ] **Step 1: Bench**: `heap/index_1m_objects` (MiniHeap sinh 1M object: 100k chuỗi `Node` dài 5, mỗi node một `byte[16]`, 1/7 payload dùng chung; `analyze` với `in_memory: true`) và `heap/dominators_1m_random` (cây ngẫu nhiên 1M nút + 500k cạnh, seed cố định). Ngân sách (µs, trung bình): `"heap/index_1m_objects": 400000`, `"heap/dominators_1m_random": 1000000` (spike: 20M object 1,98 s → ~0,1 s/1M; dominator ngẫu nhiên 1M 0,64 s).
- [ ] **Step 2: Chạy**: `pnpm perf:rust --package ide-heap` → hai bench dưới ngân sách. Nếu vượt: ghi số đo vào report và sửa mã, không nâng ngân sách.
- [ ] **Step 3: Smoke** (`smoke/debug.test.ts`): trường tuỳ chọn `heap?: { className: string; instances: number }` (java `com.example.orders.OrderBook` / 1, kotlin `com.example.library.Book` / 3). Sau bước memory: `debugHeapCapture(s.id, nextRequestId(), channel)`; `ready` → `debugHeapClasses` có dòng `className` với `count === instances` và `retained >= shallow > 0`; `debugHeapDominators(id, null, classIndex, 0, 1)` → một dòng; `debugHeapPath` của nó có bước cuối `via.kind === "root"`; `debugHeapClose`; thư mục `cache/heap-snapshots` không còn thư mục con nào của lần chạy. `unavailable` chỉ chấp nhận `memory`/`unsafeWhileSuspended` với `javaMajor < 17`. Chạy: `cargo build -p ide-host --bin openidea-server`, `pnpm smoke smoke/debug.test.ts -t java`, `pnpm smoke smoke/debug.test.ts -t kotlin` → PASS.
- [ ] **Step 4: Kiểm tra như CI** (từng lệnh một): `cargo fmt --all --check`; `cargo clippy --workspace --all-targets -- -D warnings`; `cargo nextest run --workspace`; test JVM thật Task 9 với JDK 11/21/25; `pnpm typecheck`; `pnpm lint`; `pnpm format:check`; `pnpm knip`; `pnpm test`; `pnpm build`. Mọi lệnh → 0 lỗi.
- [ ] **Step 5: Xác minh trong app** bằng skill `verify` (Tauri MCP; `pnpm dev:status` lấy cổng): `fixtures/java-app` dừng ở "Set a breakpoint here" → Memory → Capture Heap Snapshot → thấy tiến độ, tab "Heap" mở; Classes có `OrderBook` với Retained; Dominators mở được 2 cấp; chọn object → Path to GC Root kết thúc bằng một root; cột Retained Size trong tab Memory; Resume rồi dừng lại → cột biến mất; capture lần hai → Compare with… snapshot đầu → Count Diff. Open Heap Dump… với file "Save Heap Dump As…" vừa lưu → mở được, không có nút Save. Đóng tab → thư mục snapshot bị xoá (`ls <local data>/cache/heap-snapshots`). Chụp ảnh sáng/tối và zh.
- [ ] **Step 6: Commit**: `git add crates/ide-heap/benches crates/ide-heap/Cargo.toml perf/rust.ts perf/budgets.json smoke/debug.test.ts && git commit -m "feat(debugger): benchmark and smoke-test heap snapshots"`. Không mở PR: PR chung mở sau mốc cuối; lưu lệnh ở Step 2–4, số bench và ảnh ở Step 5 vào report cho mục **How it was verified**.

---

## Sửa spec đề xuất (đã duyệt và áp vào spec)

1. **§4 hàng "Retained size, GC root"**: cột "Đo được" thay "Dump 0,8–1,6 s + phân tích ~4–5 s (20M object)" bằng "20M object (880 MB): dump 0,41 s (JDK 21) / 0,85 s (JDK 25), phân tích 2,0–2,3 s; 100M object (4,3 GB): dump 2,4 s, phân tích 19–35 s **[XM, M4 H1/H3]**"; cột điều kiện thay "JDK ≥ 21 + listener; HotSpot" bằng "Đang dừng: JDK ≥ 17 + listener (17/21/23/25 **[XM, M4 H1]**); đang chạy: JDK 8+; HotSpot".
2. **§5 "Theo JDK khi VM đang dừng"**, thêm sau câu về 8 và 11: "Lệnh mà DCmd từ chối tham số (ném `IllegalArgumentException`, ví dụ `-parallel` trên 17/21 hay `-bogus` trên 25) khi VM đang dừng làm treo listener; các lệnh xếp sau chỉ chạy khi VM resume (JDK 11 cũng vậy: dump đã treo vẫn được ghi sau khi resume). Lỗi IO (`Unable to create …`) trả về bình thường. Vì vậy chỉ gửi tham số đã biết hợp lệ cho bản JDK đó **[XM, M4 H2]**."
3. **§11 gạch M4**: thay "lấy dump bằng `GC.heap_dump -parallel` qua attach (khi đang dừng, JDK ≥ 21 + listener)" bằng "lấy dump bằng `GC.heap_dump -all \"<path>\"` qua attach, không bao giờ `-parallel` (21 không nhận; 22+ đã song song mặc định và không nhanh hơn); khi đang dừng cần JDK ≥ 17"; thay "Đo thử: … RAM đỉnh 2,8 GB; ước 8 GB: 35–60 s, nên bản thật phải thu gọn bộ nhớ (bản thử ~140 B/object)" bằng "Đo bản gọn (bitmap địa chỉ + rank, CSR `u32`, semi-NCA không stack): 58 B/object mảng, bộ nhớ ẩn danh 0,27 GB khi mảng nằm trong file mmap (20M object); ước 8 GB heap ≈ 200M object: CPU ≈ 24 s, ≈ 10–12 GB file-backed, ≈ 1 GB ẩn danh **[XM, M4 H3]**"; thay "Shallow size phải tính lại theo compressed oops/header (hprof không ghi layout)" bằng "Shallow size: capture của IDE lấy từ histogram cùng lần dừng (`bytes / instances`, đúng cả class có field do VM chèn), mảng theo layout từ `VM.flags`; `.hprof` ngoài: khoảng cách địa chỉ nhỏ nhất (khớp 100% class trên G1/Parallel, 86% trên ZGC) rồi layout **[XM, M4 H4]**". Thêm: "Cạnh `Reference.referent` không tính vào retained và đường tới GC root."
4. **§3.1 hàng `ide-heap`**: cột phụ thuộc thành "`ide-core`, `memmap2`"; thêm "registry snapshot, so sánh theo class" vào trách nhiệm. Hàng `ide-dap`: phụ thuộc gồm `ide-heap` (ước lượng dung lượng).
5. **§2 bảng bằng chứng**: thêm bốn dòng H1–H4 (tóm tắt Grounding của plan này). **§15 thí nghiệm 8** ("Heap thật 8 GB"): ghi "đã đo 4,3 GB / 100M object (M4 H3); 8 GB còn ngoại suy".
6. **§14 hàng `ide-heap`**: "fuzz parser" → "proptest trên byte ngẫu nhiên và dump mẫu bị đột biến (chạy trong `cargo nextest`, không cần nightly)".

## Cần chủ repo quyết định (đã chốt theo mặc định đề xuất; chủ repo có thể đổi)

1. **Snapshot hiện ở đâu.** Mặc định đề xuất: tab editor riêng (`heap-snapshot`) cho class/dominator/đường tới root/so sánh; tab Memory chỉ có nút Capture, tiến độ và cột Retained Size. Lý do: dominator và đường đi cần chỗ rộng, và file `.hprof` mở được khi không có phiên debug.
2. **Tham chiếu yếu.** Mặc định đề xuất: bỏ mọi `Reference.referent` (Weak/Soft/Phantom/Final) khỏi retained và đường tới GC root, ghi số cạnh đã bỏ trong summary; chưa có công tắc ở M4.
3. **Vòng đời file.** Mặc định đề xuất: dump đã capture và chỉ mục bị xoá khi đóng tab (trừ khi đã "Save Heap Dump As…"), không khôi phục tab sau khi khởi động lại; thư mục mồ côi xoá lúc host khởi động.
4. **Capture khi chương trình đang chạy.** Mặc định đề xuất: cho phép (JDK 8+), tooltip ghi chương trình tạm dừng khoảng một giây mỗi GB heap (đo 0,5–1 s/GB).
5. **Mở `.hprof` trong cửa sổ remote.** Mặc định đề xuất: chưa hỗ trợ ở M4 (hộp thoại file là của máy local, còn phân tích chạy trên host); capture trong phiên remote vẫn chạy vì dump nằm trên host.
6. **`.hprof.gz` và dump OpenJ9/Android.** Mặc định đề xuất: không hỗ trợ ở M4; lỗi "not a heap dump" kèm lý do.
7. **Dependency mới `memmap2 = "0.9"`** trong workspace. Mặc định đề xuất: đồng ý (crate phổ biến, đã dùng trong spike; không có lựa chọn std).
8. **Áp các sửa spec ở mục trên.** Mặc định đề xuất: áp nguyên văn trước khi bắt đầu Task 1.

## Self-review

- **Phủ spec:** §11 M4 dump qua attach → Task 9–10; hprof streaming qua mmap → Task 1–3; CSR → Task 3; dominator semi-NCA → Task 4; retained theo object và class → Task 6; đường ngắn nhất tới GC root → Task 6–7; so sánh snapshot → Task 7, 11, 14; chỉ mục trên đĩa → Task 2, 6; shallow theo compressed oops/header → Task 5; `spawn_blocking` + `CancellationToken` → Task 6, 10, 11; kiểm đĩa và dọn tạm → Task 8, 10, 11; mở `.hprof` ngoài → Task 11, 14; không OpenJ9 → Global Constraints; §13 IPC `debug_heap_*`, capability, chuỗi en/zh, icon → Task 10–14; §14 dump nhỏ tính tay, property test dominator, fuzz parser → Task 1, 4, 6–7; §15 thí nghiệm 8 → Grounding H3; ngân sách perf → Task 15; §1 Memory view "retained size, đường tới GC root, so sánh snapshot" → Task 13–14.
- **Ngoài phạm vi M4 (có chủ đích):** allocation (M5), mở `.gz`, khôi phục snapshot sau khởi động lại, công tắc tham chiếu yếu, Windows capture (attach unix của M1; mở `.hprof` ngoài vẫn chạy trên Windows, bỏ kiểm đĩa).
- **Kiểu nhất quán:** `HeapGraph`/`ClassInfo`/`PRIM_TYPE_BASE` (Task 3) dùng ở 5–6; `Dominators` (4) ở 6; `VmLayout`/`ShallowModel`/`HistogramEntry`/`SizeSource` (5) ở 6, 10; `HeapIndex`/`HeapSummary`/`HeapPhase` (6) ở 7, 8, 11; `HeapObjectRef`/`HeapClassRow`/`HeapObjectPage`/`HeapPathStep`/`HeapEdge`/`HeapClassDiff` (7) ở 11, 14; `HeapSnapshotId`/`HeapSnapshotInfo`/`HeapOrigin`/`HeapRegistry` (8) ở 11–14; `HeapDumpReply`/`heap_dump`/`vm_flags`/`dump_timeout` (9) ở 10; `JvmHeapUnavailable`/`JvmHeapOutcome` (10) ở 11, 13; `HeapProgress`/`HeapCaptureResult`/`HeapOpenResult` (11) ở 12–14.
