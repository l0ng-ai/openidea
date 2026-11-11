use super::fake::{Fake, Heap, Val, packet, target};
use super::*;
use crate::codec::Reader;
use ide_jvm_inspect::{JvmInspector, REFERRER_ARRAY_SCAN, STRING_PREVIEW_CHARS};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

const WAIT: Duration = Duration::from_secs(10);

async fn within<T>(f: impl Future<Output = T>) -> T {
    tokio::time::timeout(WAIT, f).await.expect("timed out")
}

fn object(id: u64, type_name: &str) -> JvmValue {
    JvmValue::Object { id, type_name: type_name.into() }
}

fn int(n: i32) -> JvmValue {
    JvmValue::Primitive { type_name: "int".into(), text: n.to_string() }
}

/// `(id, id, int)` of a request body: the object or class, then the two numbers that follow.
fn ids_and_ints(body: &[u8]) -> (u64, i32, i32) {
    let mut r = Reader::new(body);
    (r.id(8).unwrap(), r.i32().unwrap_or(-1), r.i32().unwrap_or(-1))
}

fn foo_heap(count: usize) -> (Heap, Vec<u64>) {
    let mut heap = Heap::new();
    let foo = heap.class("Lcom/x/Foo;", heap.object_class, &[]);
    let objects = (0..count).map(|_| heap.object(foo, &[])).collect();
    (heap, objects)
}

#[tokio::test]
async fn previews_strings_boxed_objects_arrays() {
    let mut heap = Heap::new();
    let foo = heap.class("Lcom/x/Foo;", heap.object_class, &[]);
    let s = heap.string("hi");
    let i = heap.integer(42);
    let o = heap.object(foo, &[]);
    let a = heap.array("[I", 3, vec![Val::Int(1), Val::Int(2), Val::Int(3)]);
    heap.list_instances(heap.object_class, &[s, i, o, a]);
    let fake = Fake::start(heap).await;

    let values = within(fake.inspector.instances(&target(), "java.lang.Object", 1000)).await.unwrap();
    assert_eq!(
        values,
        vec![
            JvmValue::Str { id: s, text: Some("hi".into()), length: 2 },
            JvmValue::Boxed { id: i, type_name: "java.lang.Integer".into(), text: "42".into() },
            object(o, "com.x.Foo"),
            JvmValue::Array { id: a, type_name: "int[]".into(), length: 3 },
        ]
    );
}

#[tokio::test]
async fn long_string_preview_reads_length_only() {
    let mut heap = Heap::new();
    let long = heap.long_string(100_000_000, 1);
    heap.list_instances(heap.class_id("Ljava/lang/String;"), &[long]);
    let fake = Fake::start(heap).await;

    let values = within(fake.inspector.instances(&target(), "java.lang.String", 1000)).await.unwrap();
    assert_eq!(values, vec![JvmValue::Str { id: long, text: None, length: 50_000_000 }]);
    assert_eq!(fake.count(10, 1), 0, "the text of a long string is never read");
    assert_eq!(fake.count(13, 2), 0);
}

#[tokio::test]
async fn string_text_is_read_up_to_the_preview_limit() {
    let mut heap = Heap::new();
    let ok = heap.string(&"x".repeat(STRING_PREVIEW_CHARS as usize));
    let over = heap.string(&"y".repeat(STRING_PREVIEW_CHARS as usize + 1));
    heap.list_instances(heap.class_id("Ljava/lang/String;"), &[ok, over]);
    let fake = Fake::start(heap).await;

    let values = within(fake.inspector.instances(&target(), "java.lang.String", 1000)).await.unwrap();
    assert_eq!(
        values,
        vec![
            JvmValue::Str { id: ok, text: Some("x".repeat(1000)), length: 1000 },
            JvmValue::Str { id: over, text: None, length: 1001 },
        ]
    );
    assert_eq!(fake.count(10, 1), 1);
}

#[tokio::test]
async fn fields_walk_superclasses_and_skip_statics() {
    let mut heap = Heap::new();
    let base = heap.class("Lcom/x/Base;", heap.object_class, &[("id", "I", false), ("COUNT", "I", true)]);
    let sub = heap.class(
        "Lcom/x/Sub;",
        base,
        &[("name", "Ljava/lang/String;", false), ("next", "Lcom/x/Sub;", false), ("NAMES", "Ljava/util/List;", true)],
    );
    let name = heap.string("bob");
    let target_object = heap.object(sub, &[("name", Val::Obj(name)), ("next", Val::Null), ("id", Val::Int(7))]);
    let fake = Fake::start(heap).await;

    let fields = within(fake.inspector.fields(&target(), target_object)).await.unwrap();
    let shown: Vec<_> = fields.iter().map(|f| (f.name.as_str(), f.value.clone())).collect();
    assert_eq!(
        shown,
        vec![
            ("name", JvmValue::Str { id: name, text: Some("bob".into()), length: 3 }),
            ("next", JvmValue::Null),
            ("id", int(7)),
        ]
    );
    let reads = fake.requests(9, 2);
    assert_eq!(reads.len(), 2, "one read for the object's fields, one for the string's");
    assert_eq!(ids_and_ints(&reads[0]).1, 3, "no static field is read");
    // Sub, Base, Object: the walk ends at the class without a superclass
    assert_eq!(fake.count(3, 1), 3);
}

#[tokio::test]
async fn array_fields_show_first_100() {
    let mut heap = Heap::new();
    let array = heap.array("[I", 5000, (0..5000).map(Val::Int).collect());
    let fake = Fake::start(heap).await;

    let fields = within(fake.inspector.fields(&target(), array)).await.unwrap();
    assert_eq!(fields.len(), 100);
    assert_eq!(fields[0].name, "[0]");
    assert_eq!(fields[99].name, "[99]");
    assert_eq!(fields[99].value, int(99));
    let reads = fake.requests(13, 2);
    assert_eq!(reads.len(), 1);
    assert_eq!(ids_and_ints(&reads[0]), (array, 0, 100));
}

#[tokio::test]
async fn short_and_empty_arrays_show_all_they_have() {
    let mut heap = Heap::new();
    let owner = heap.class("Lcom/x/Owner;", heap.object_class, &[]);
    let item = heap.object(owner, &[]);
    let short = heap.array("[Ljava/lang/Object;", 2, vec![Val::Obj(item), Val::Null]);
    let empty = heap.array("[I", 0, Vec::new());
    let fake = Fake::start(heap).await;

    let fields = within(fake.inspector.fields(&target(), short)).await.unwrap();
    let shown: Vec<_> = fields.iter().map(|f| (f.name.as_str(), f.value.clone())).collect();
    assert_eq!(shown, vec![("[0]", object(item, "com.x.Owner")), ("[1]", JvmValue::Null)]);
    assert_eq!(within(fake.inspector.fields(&target(), empty)).await.unwrap(), vec![]);
    assert_eq!(fake.count(13, 2), 1, "an empty array reads nothing");
}

#[tokio::test]
async fn referrers_name_the_field() {
    let mut heap = Heap::new();
    let item_class = heap.class("Lcom/x/Item;", heap.object_class, &[]);
    let owner_class = heap.class(
        "Lcom/x/Owner;",
        heap.object_class,
        &[("item", "Lcom/x/Item;", false), ("other", "Lcom/x/Item;", false)],
    );
    let item = heap.object(item_class, &[]);
    let other = heap.object(item_class, &[]);
    let owner = heap.object(owner_class, &[("item", Val::Obj(item)), ("other", Val::Obj(other))]);
    let array = heap.array("[Ljava/lang/Object;", 3, vec![Val::Null, Val::Obj(item), Val::Null]);
    let fake = Fake::start(heap).await;

    let referrers = within(fake.inspector.referrers(&target(), item, 50)).await.unwrap();
    assert_eq!(
        referrers,
        vec![
            JvmReferrer { value: object(owner, "com.x.Owner"), via: vec!["item".into()] },
            JvmReferrer {
                value: JvmValue::Array { id: array, type_name: "java.lang.Object[]".into(), length: 3 },
                via: vec!["[1]".into()],
            },
        ]
    );
    assert_eq!(ids_and_ints(&fake.requests(9, 10)[0]), (item, 50, -1));
}

#[tokio::test]
async fn referrer_arrays_are_scanned_only_up_to_the_limit() {
    let (mut heap, items) = foo_heap(1);
    let item = items[0];
    let mut scanned = vec![Val::Null; REFERRER_ARRAY_SCAN as usize];
    scanned[9999] = Val::Obj(item);
    let scanned_id = heap.array("[Ljava/lang/Object;", REFERRER_ARRAY_SCAN, scanned);
    let big_id = heap.array("[Ljava/lang/Object;", REFERRER_ARRAY_SCAN + 1, vec![Val::Obj(item)]);
    let fake = Fake::start(heap).await;

    let referrers = within(fake.inspector.referrers(&target(), item, 50)).await.unwrap();
    assert_eq!(referrers.len(), 2);
    assert_eq!(referrers[0].value.object_id(), Some(scanned_id));
    assert_eq!(referrers[0].via, vec!["[9999]".to_string()]);
    assert_eq!(referrers[1].value.object_id(), Some(big_id));
    assert_eq!(referrers[1].via, Vec::<String>::new(), "too large to look for the index");
    assert_eq!(fake.count(13, 2), 1);
}

#[tokio::test]
async fn class_counts_send_one_instance_counts_packet() {
    let mut heap = Heap::new();
    let mut classes = Vec::new();
    while heap.class_count() < 599 {
        let name = format!("Lcom/x/C{};", heap.class_count());
        classes.push(heap.class(&name, heap.object_class, &[]));
    }
    heap.array("[I", 0, Vec::new());
    assert_eq!(heap.class_count(), 600);
    for _ in 0..2 {
        heap.object(classes[0], &[]);
    }
    heap.object(classes[10], &[]);
    let fake = Fake::start(heap).await;

    let counts = within(fake.inspector.class_counts(&target())).await.unwrap();
    assert_eq!(
        counts,
        vec![
            ClassCount { name: "com.x.C3".into(), instances: 2 },
            ClassCount { name: "com.x.C13".into(), instances: 1 },
            ClassCount { name: "int[]".into(), instances: 1 },
        ]
    );
    let packets = fake.requests(1, 21);
    assert_eq!(packets.len(), 1);
    assert_eq!(Reader::new(&packets[0]).count().unwrap(), 600);
    assert_eq!(packets[0].len(), 4 + 600 * 8);
}

#[tokio::test]
async fn invalid_object_maps_to_collected() {
    let (mut heap, objects) = foo_heap(2);
    heap.fail(9, 1, objects[0], 20);
    heap.fail(9, 10, objects[1], 20);
    let fake = Fake::start(heap).await;

    assert_eq!(within(fake.inspector.fields(&target(), objects[0])).await, Err(InspectError::Collected));
    assert_eq!(within(fake.inspector.referrers(&target(), objects[1], 50)).await, Err(InspectError::Collected));
}

#[tokio::test]
async fn missing_class_is_not_loaded() {
    let (mut heap, _) = foo_heap(1);
    let foo = heap.class_id("Lcom/x/Foo;");
    heap.fail(2, 16, foo, 21);
    let fake = Fake::start(heap).await;

    let t = target();
    let missing = fake.inspector.instances(&t, "com.x.Missing", 10);
    assert_eq!(within(missing).await, Err(InspectError::ClassNotLoaded));
    assert_eq!(within(fake.inspector.instances(&t, "", 10)).await, Err(InspectError::ClassNotLoaded));
    assert_eq!(fake.count(2, 16), 0);
    // JDWP INVALID_CLASS for a class that is known but not usable yet
    let unusable = fake.inspector.instances(&t, "com.x.Foo", 10);
    assert_eq!(within(unusable).await, Err(InspectError::ClassNotLoaded));
}

#[tokio::test]
async fn instances_skip_objects_gone_mid_preview() {
    let (mut heap, objects) = foo_heap(3);
    heap.fail(9, 1, objects[1], 20);
    let fake = Fake::start(heap).await;

    let values = within(fake.inspector.instances(&target(), "com.x.Foo", 1000)).await.unwrap();
    assert_eq!(values, vec![object(objects[0], "com.x.Foo"), object(objects[2], "com.x.Foo")]);
}

#[tokio::test]
async fn referrers_skip_objects_gone_mid_preview() {
    let mut heap = Heap::new();
    let owner_class = heap.class("Lcom/x/Owner;", heap.object_class, &[("item", "Ljava/lang/Object;", false)]);
    let target_object = heap.object(owner_class, &[]);
    let owners: Vec<u64> = (0..4).map(|_| heap.object(owner_class, &[("item", Val::Obj(target_object))])).collect();
    heap.fail(9, 1, owners[1], 20);
    heap.fail(9, 2, owners[2], 20);
    let fake = Fake::start(heap).await;

    let referrers = within(fake.inspector.referrers(&target(), target_object, 50)).await.unwrap();
    let kept: Vec<_> = referrers.iter().map(|r| (r.value.object_id().unwrap(), r.via.clone())).collect();
    assert_eq!(kept, vec![(owners[0], vec!["item".to_string()]), (owners[3], vec!["item".to_string()])]);
}

#[tokio::test]
async fn limits_are_capped_and_zero_asks_for_nothing() {
    let (heap, objects) = foo_heap(3);
    let fake = Fake::start(heap).await;
    let t = target();

    assert_eq!(within(fake.inspector.instances(&t, "com.x.Foo", 0)).await.unwrap(), vec![]);
    assert_eq!(fake.count(2, 16), 0, "a count of 0 would mean every instance to the JVM");
    within(fake.inspector.instances(&t, "com.x.Foo", 5000)).await.unwrap();
    assert_eq!(ids_and_ints(&fake.requests(2, 16)[0]).1, 1000);

    assert_eq!(within(fake.inspector.referrers(&t, objects[0], 0)).await.unwrap(), vec![]);
    assert_eq!(fake.count(9, 10), 0);
    within(fake.inspector.referrers(&t, objects[0], 500)).await.unwrap();
    assert_eq!(ids_and_ints(&fake.requests(9, 10)[0]).1, 200);
}

#[tokio::test]
async fn instances_continue_over_classes_until_the_limit() {
    let mut heap = Heap::new();
    let first = heap.class("Lcom/x/Dup;", heap.object_class, &[]);
    let second = heap.class("Lcom/x/Dup;", heap.object_class, &[]);
    let a: Vec<u64> = (0..2).map(|_| heap.object(first, &[])).collect();
    let b: Vec<u64> = (0..2).map(|_| heap.object(second, &[])).collect();
    let fake = Fake::start(heap).await;

    let values = within(fake.inspector.instances(&target(), "com.x.Dup", 3)).await.unwrap();
    let ids: Vec<_> = values.iter().filter_map(JvmValue::object_id).collect();
    assert_eq!(ids, vec![a[0], a[1], b[0]]);
    let asked: Vec<_> = fake.requests(2, 16).iter().map(|body| ids_and_ints(body)).collect();
    assert_eq!(asked, vec![(first, 3, -1), (second, 1, -1)]);
}

#[tokio::test]
async fn a_resume_is_stale_not_a_skipped_object() {
    let (mut heap, objects) = foo_heap(2);
    heap.hold(9, 1, objects[1]);
    let mut fake = Fake::start(heap).await;

    let t = target();
    let call = fake.inspector.instances(&t, "com.x.Foo", 1000);
    let resume = async {
        fake.held.notified().await;
        fake.adapter.write_all(&packet(50, 1, 9, &[])).await.unwrap();
    };
    let (result, ()) = within(async { tokio::join!(call, resume) }).await;
    assert_eq!(result, Err(InspectError::Stale));
}

#[tokio::test]
async fn class_and_field_lookups_are_cached_within_a_stop() {
    let mut heap = Heap::new();
    let foo = heap.class("Lcom/x/Foo;", heap.object_class, &[]);
    let objects: Vec<u64> = (0..3).map(|_| heap.object(foo, &[])).collect();
    let strings = [heap.string("a"), heap.string("b")];
    heap.list_instances(heap.class_id("Ljava/lang/String;"), &strings);
    let mut fake = Fake::start(heap).await;
    let t = target();

    within(fake.inspector.instances(&t, "com.x.Foo", 1000)).await.unwrap();
    within(fake.inspector.instances(&t, "java.lang.String", 1000)).await.unwrap();
    within(fake.inspector.instances(&t, "com.x.Foo", 1000)).await.unwrap();
    assert_eq!(objects.len(), 3);
    assert_eq!(fake.count(2, 1), 2, "one signature per class");
    assert_eq!(fake.count(2, 4), 1, "String's fields are listed once");

    // reference types are only valid for the stop they were read in
    fake.next_stop().await;
    within(fake.inspector.instances(&t, "com.x.Foo", 1000)).await.unwrap();
    assert_eq!(fake.count(2, 1), 3);
}

#[tokio::test]
async fn only_reads_are_sent() {
    let mut heap = Heap::new();
    let owner_class = heap.class("Lcom/x/Owner;", heap.object_class, &[("item", "Ljava/lang/Object;", false)]);
    let item = heap.object(owner_class, &[]);
    let name = heap.string("n");
    let number = heap.integer(1);
    let owner = heap.object(owner_class, &[("item", Val::Obj(item))]);
    let array = heap.array("[Ljava/lang/Object;", 3, vec![Val::Obj(item), Val::Obj(name), Val::Obj(number)]);
    let fake = Fake::start(heap).await;
    let t = target();

    within(fake.inspector.class_counts(&t)).await.unwrap();
    within(fake.inspector.instances(&t, "com.x.Owner", 1000)).await.unwrap();
    within(fake.inspector.fields(&t, owner)).await.unwrap();
    within(fake.inspector.fields(&t, array)).await.unwrap();
    within(fake.inspector.referrers(&t, item, 50)).await.unwrap();

    // never an invoke, a resume, DisposeObjects or Enable/DisableCollection
    const READS: [(u8, u8); 13] =
        [(1, 2), (1, 3), (1, 21), (2, 1), (2, 4), (2, 16), (3, 1), (9, 1), (9, 2), (9, 10), (10, 1), (13, 1), (13, 2)];
    for command in fake.commands() {
        assert!(READS.contains(&command), "unexpected command {command:?}");
    }
}

#[test]
fn link_errors_map_to_inspect_errors() {
    for (error, mapped) in [
        (LinkError::NotSuspended, InspectError::NotSuspended),
        (LinkError::Stale, InspectError::Stale),
        (LinkError::Degraded, InspectError::Unsupported("the JDWP link stopped inspecting".into())),
        (LinkError::Closed, InspectError::Closed),
        (LinkError::TimedOut, InspectError::TimedOut),
        (LinkError::Busy, InspectError::TimedOut),
        (LinkError::Jdwp(20), InspectError::Collected),
        (LinkError::Jdwp(21), InspectError::ClassNotLoaded),
        (LinkError::Jdwp(113), InspectError::Failed("JDWP error 113".into())),
        (LinkError::Protocol("short".into()), InspectError::Failed("malformed JDWP reply: short".into())),
    ] {
        assert_eq!(map_link_error(error), mapped);
    }
}
