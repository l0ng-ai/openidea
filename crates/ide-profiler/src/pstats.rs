//! cProfile / profile snapshots (`pstats` files): a marshal'd dict
//! `{(file, line, name): (cc, nc, tt, ct, {caller: (nc, cc, tt, ct)})}` in seconds,
//! read without a Python interpreter. `profile` (the pure-Python module) stores a bare
//! call count per caller instead of the tuple.

use crate::tree::{FrameKey, TreeBuilder};
use crate::{CallEdge, MethodStat, Profile, ProfileMode};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;

/// Whether `bytes` start like a marshal'd pstats dict rather than JSON (`{"nodes"…`).
pub(crate) fn looks_like_pstats(bytes: &[u8]) -> bool {
    // A dict (`{`, with or without the ref flag) whose first key is a tuple, or empty (`0`).
    matches!(bytes, [first, second, ..] if first & 0x7f == b'{' && matches!(second & 0x7f, b'(' | b')' | b'0'))
}

#[derive(Clone, Debug)]
enum Value {
    None,
    Int(f64),
    Float(f64),
    // Shared: a reference (`r`) to a key or file name is a cheap clone.
    Str(Rc<str>),
    Seq(Rc<[Value]>),
    Dict(Vec<(Value, Value)>),
}

impl Value {
    fn num(&self) -> Option<f64> {
        match self {
            Value::Int(v) | Value::Float(v) => Some(*v),
            _ => None,
        }
    }
}

/// The subset of marshal that Python 3 writes pstats files with (formats 2–5; Python 2's
/// `R` and `I` are not read).
struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
    refs: Vec<Value>,
}

const MAX_DEPTH: u32 = 32;

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], String> {
        let end = self.pos.checked_add(n).filter(|e| *e <= self.data.len()).ok_or("truncated")?;
        let s = &self.data[self.pos..end];
        self.pos = end;
        Ok(s)
    }

    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn i32(&mut self) -> Result<i32, String> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn len(&mut self, short: bool) -> Result<usize, String> {
        if short {
            return Ok(self.u8()? as usize);
        }
        usize::try_from(self.i32()?).map_err(|_| "negative length".to_owned())
    }

    fn str(&mut self, n: usize) -> Result<Value, String> {
        Ok(Value::Str(String::from_utf8_lossy(self.take(n)?).into()))
    }

    fn read(&mut self, depth: u32) -> Result<Value, String> {
        if depth > MAX_DEPTH {
            return Err("nested too deeply".into());
        }
        let code = self.u8()?;
        // FLAG_REF: the object is remembered for later `r` references. Containers take
        // their slot before their items, as CPython numbers them.
        let slot = (code & 0x80 != 0).then(|| {
            self.refs.push(Value::None);
            self.refs.len() - 1
        });
        let value = match code & 0x7f {
            b'N' | b'F' | b'T' => Value::None,
            b'i' => Value::Int(self.i32()? as f64),
            b'l' => {
                let n = self.i32()?;
                let mut v = 0.0;
                for i in 0..n.unsigned_abs() {
                    let digit = u16::from_le_bytes(self.take(2)?.try_into().unwrap());
                    v += f64::from(digit) * 2f64.powi(15 * i as i32);
                }
                Value::Int(if n < 0 { -v } else { v })
            }
            b'g' => Value::Float(f64::from_le_bytes(self.take(8)?.try_into().unwrap())),
            b'f' => {
                let n = self.len(true)?;
                let text = String::from_utf8_lossy(self.take(n)?).into_owned();
                Value::Float(text.trim().parse().map_err(|_| "bad float")?)
            }
            b'u' | b't' | b'a' | b'A' | b's' => {
                let n = self.len(false)?;
                self.str(n)?
            }
            b'z' | b'Z' => {
                let n = self.len(true)?;
                self.str(n)?
            }
            c @ (b'(' | b')' | b'[' | b'<' | b'>') => {
                let n = self.len(c == b')')?;
                let mut items = Vec::with_capacity(n.min(1024));
                for _ in 0..n {
                    items.push(self.read(depth + 1)?);
                }
                Value::Seq(items.into())
            }
            b'{' => {
                let mut items = Vec::new();
                loop {
                    if self.data.get(self.pos) == Some(&b'0') {
                        self.pos += 1;
                        break;
                    }
                    let k = self.read(depth + 1)?;
                    let v = self.read(depth + 1)?;
                    items.push((k, v));
                }
                // pstats never refers back to a dict, so its slot stays empty instead of
                // holding a copy of the whole table.
                return Ok(Value::Dict(items));
            }
            b'r' => {
                let i = usize::try_from(self.i32()?).map_err(|_| "bad reference")?;
                self.refs.get(i).cloned().ok_or("bad reference")?
            }
            other => return Err(format!("unexpected marshal type {:?}", other as char)),
        };
        if let Some(s) = slot {
            self.refs[s] = value.clone();
        }
        Ok(value)
    }
}

/// `(file, line, name)` as cProfile records it.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Func {
    file: Rc<str>,
    line: u32,
    name: Rc<str>,
}

#[derive(Default)]
struct Stat {
    cc: f64,
    nc: f64,
    tt: f64,
    ct: f64,
}

struct Edge {
    caller: usize,
    callee: usize,
    nc: f64,
    cc: f64,
    tt: f64,
    ct: f64,
}

fn func(key: &Value) -> Result<Func, String> {
    match key {
        Value::Seq(t) if t.len() == 3 => match (&t[0], t[1].num(), &t[2]) {
            (Value::Str(file), Some(line), Value::Str(name)) => {
                Ok(Func { file: file.clone(), line: line.max(0.0) as u32, name: name.clone() })
            }
            _ => Err("a function key is not (file, line, name)".into()),
        },
        _ => Err("a function key is not (file, line, name)".into()),
    }
}

/// Functions, their stats (same index) and caller edges.
type Graph = (Vec<Func>, Vec<Stat>, Vec<Edge>);

/// Every function and caller edge of a pstats file.
fn parse(bytes: &[u8]) -> Result<Graph, String> {
    let mut r = Reader { data: bytes, pos: 0, refs: Vec::new() };
    let Value::Dict(table) = r.read(0)? else { return Err("not a dict".into()) };
    let mut funcs: Vec<Func> = Vec::new();
    let mut ids: HashMap<Func, usize> = HashMap::new();
    let mut id = |f: Func, funcs: &mut Vec<Func>| {
        *ids.entry(f.clone()).or_insert_with(|| {
            funcs.push(f);
            funcs.len() - 1
        })
    };
    let mut stats: Vec<Stat> = Vec::new();
    let mut edges = Vec::new();
    for (key, value) in &table {
        let callee = id(func(key)?, &mut funcs);
        let Value::Seq(v) = value else { return Err("a function's stats are not a tuple".into()) };
        let n = |i: usize| v.get(i).and_then(Value::num).ok_or("a function's stats are not numbers");
        stats.resize_with(funcs.len(), Stat::default);
        stats[callee] = Stat { cc: n(0)?, nc: n(1)?, tt: n(2)?, ct: n(3)? };
        let Some(Value::Dict(callers)) = v.get(4) else { return Err("a function has no callers table".into()) };
        // References can make one callers table count for many functions: a small file could
        // otherwise unfold into more edges than memory holds. A real edge takes bytes of its own.
        if edges.len() + callers.len() > bytes.len() {
            return Err("more calls than the file can hold".into());
        }
        for (caller, e) in callers {
            let caller = id(func(caller)?, &mut funcs);
            let edge = match e {
                Value::Seq(t) => {
                    let n = |i: usize| t.get(i).and_then(Value::num).ok_or("a caller's stats are not numbers");
                    Edge { caller, callee, nc: n(0)?, cc: n(1)?, tt: n(2)?, ct: n(3)? }
                }
                // `profile` keeps only the call count.
                other => {
                    let nc = other.num().ok_or("a caller's stats are not numbers")?;
                    Edge { caller, callee, nc, cc: nc, tt: 0.0, ct: 0.0 }
                }
            };
            edges.push(edge);
        }
    }
    stats.resize_with(funcs.len(), Stat::default);
    Ok((funcs, stats, edges))
}

/// Where a recorded file is here: absolute, or relative to `bases` (the profile was
/// written with the run's working directory, which isn't recorded). `None` for
/// built-ins (`~`), `<frozen …>` / `<string>` and files that aren't on this machine.
fn source(file: &str, bases: &[&Path]) -> Option<PathBuf> {
    let p = Path::new(file);
    if file == "~" || file.starts_with('<') {
        return None;
    }
    if p.is_absolute() {
        return p.is_file().then(|| p.to_path_buf());
    }
    bases.iter().map(|b| b.join(p)).find(|p| p.is_file())
}

/// Where the rebuilt call tree starts, with the time spent there outside any recorded
/// caller. One start per strongly connected component of the call graph: a function that
/// calls back into itself through others (`exec` running an imported module, which runs
/// `exec`) has callers, yet they all run inside it. The component's heaviest function
/// stands for it, with its total minus what callers outside the component spent in it.
fn roots(stats: &[Stat], edges: &[Edge], callees: &[Vec<(usize, f64)>], min: f64) -> Vec<(usize, f64)> {
    let comp = components(callees);
    let count = comp.iter().max().map_or(0, |m| m + 1);
    let mut incoming = vec![0.0; count];
    for e in edges {
        if comp[e.caller] != comp[e.callee] {
            incoming[comp[e.callee]] += e.ct;
        }
    }
    let mut top: Vec<Option<usize>> = vec![None; count];
    for (f, c) in comp.iter().enumerate() {
        if top[*c].is_none_or(|t| stats[f].ct > stats[t].ct) {
            top[*c] = Some(f);
        }
    }
    let mut out: Vec<(usize, f64)> = top
        .iter()
        .enumerate()
        .filter_map(|(c, t)| {
            let t = (*t)?;
            let w = stats[t].ct - incoming[c];
            (w > min).then_some((t, w))
        })
        .collect();
    if out.is_empty()
        && let Some(f) = (0..stats.len()).max_by(|a, b| stats[*a].ct.total_cmp(&stats[*b].ct))
    {
        out.push((f, stats[f].ct));
    }
    out
}

/// The strongly connected component of every function (Tarjan's algorithm, iterative).
fn components(callees: &[Vec<(usize, f64)>]) -> Vec<usize> {
    const UNSEEN: usize = usize::MAX;
    let n = callees.len();
    let (mut index, mut low, mut comp, mut on_stack) = (vec![UNSEEN; n], vec![0; n], vec![UNSEEN; n], vec![false; n]);
    let (mut stack, mut next, mut count) = (Vec::new(), 0, 0);
    for start in 0..n {
        if index[start] != UNSEEN {
            continue;
        }
        let mut work = vec![(start, 0usize)];
        (index[start], low[start], on_stack[start]) = (next, next, true);
        stack.push(start);
        next += 1;
        while let Some(&(v, i)) = work.last() {
            if let Some(&(w, _)) = callees[v].get(i) {
                work.last_mut().unwrap().1 += 1;
                if index[w] == UNSEEN {
                    (index[w], low[w], on_stack[w]) = (next, next, true);
                    stack.push(w);
                    next += 1;
                    work.push((w, 0));
                } else if on_stack[w] {
                    low[v] = low[v].min(index[w]);
                }
                continue;
            }
            work.pop();
            if let Some(&(p, _)) = work.last() {
                low[p] = low[p].min(low[v]);
            }
            if low[v] == index[v] {
                while let Some(w) = stack.pop() {
                    on_stack[w] = false;
                    comp[w] = count;
                    if w == v {
                        break;
                    }
                }
                count += 1;
            }
        }
    }
    comp
}

/// Smallest share of the total a rebuilt call-tree node keeps, and the most nodes the
/// tree may have: a call graph with many paths would otherwise unfold exponentially.
const MIN_SHARE: f64 = 0.0005;
const MAX_NODES: usize = 200_000;
const MAX_DEPTH_TREE: u32 = 256;

/// Reads a pstats file. Times become milliseconds. The method list and call edges are
/// exact; the call tree is rebuilt from the edges by sharing each function's time among
/// its callees in proportion, so it is an estimate below the first level.
pub(crate) fn read(bytes: &[u8], bases: &[&Path], profiler: &str) -> Result<Profile, String> {
    let (funcs, stats, edges) = parse(bytes)?;
    let mut b = TreeBuilder::new();
    // Functions share files: look each one up once.
    let mut sources: HashMap<Rc<str>, Option<PathBuf>> = HashMap::new();
    let frames: Vec<u32> = funcs
        .iter()
        .map(|f| {
            let file = sources.entry(f.file.clone()).or_insert_with(|| source(&f.file, bases)).clone();
            let name = if &*f.file == "~" || file.is_some() {
                f.name.to_string()
            } else {
                // Keep functions of files that aren't here apart, and say where they were.
                format!("{} ({}:{})", f.name, f.file, f.line)
            };
            let line = file.as_ref().map(|_| f.line.saturating_sub(1));
            b.frame(FrameKey { name, file, line, kind: Default::default() })
        })
        .collect();

    let mut callees: Vec<Vec<(usize, f64)>> = vec![Vec::new(); funcs.len()];
    for e in &edges {
        callees[e.caller].push((e.callee, e.ct));
    }
    let min = stats.iter().map(|s| s.tt).sum::<f64>() * MIN_SHARE;
    // `profile` records no time per caller: without it only own times can be drawn.
    let timed = edges.iter().any(|e| e.ct > 0.0);
    let roots = if timed { roots(&stats, &edges, &callees, min) } else { Vec::new() };
    if !timed {
        for (f, s) in stats.iter().enumerate() {
            let node = b.child(0, frames[f]);
            b.add_self(node, s.tt * 1000.0);
        }
    }

    enum Step {
        Enter { parent: u32, func: usize, weight: f64, depth: u32 },
        Exit(usize),
    }
    let mut on_path = vec![false; funcs.len()];
    let mut stack: Vec<Step> =
        roots.iter().map(|&(f, weight)| Step::Enter { parent: 0, func: f, weight, depth: 0 }).collect();
    while let Some(step) = stack.pop() {
        let (parent, func, weight, depth) = match step {
            Step::Exit(f) => {
                on_path[f] = false;
                continue;
            }
            Step::Enter { parent, func, weight, depth } => (parent, func, weight, depth),
        };
        let node = b.child(parent, frames[func]);
        if b.len() >= MAX_NODES || depth >= MAX_DEPTH_TREE {
            b.add_self(node, weight * 1000.0);
            continue;
        }
        on_path[func] = true;
        stack.push(Step::Exit(func));
        let ct = stats[func].ct;
        let scale = if ct > 0.0 { weight / ct } else { 0.0 };
        // A recursive call's time is already in the outer call's.
        let kids: Vec<(usize, f64)> =
            callees[func].iter().filter(|(c, _)| !on_path[*c]).map(|&(c, ect)| (c, ect * scale)).collect();
        let sum: f64 = kids.iter().map(|k| k.1).sum();
        // Mutual recursion can make the callees add up to more than the caller.
        let fit = if sum > weight && sum > 0.0 { weight / sum } else { 1.0 };
        let mut kept = 0.0;
        for (c, w) in kids {
            let w = w * fit;
            if w >= min && w > 0.0 {
                kept += w;
                stack.push(Step::Enter { parent: node, func: c, weight: w, depth: depth + 1 });
            }
        }
        b.add_self(node, (weight - kept).max(0.0) * 1000.0);
    }

    let mut profile = b.finish(profiler, "ms", ProfileMode::Cpu);
    // Two recorded names of one file (`work.py`, `/p/work.py`) are one frame: add them up.
    let mut methods: HashMap<u32, MethodStat> = HashMap::new();
    for (f, s) in stats.iter().enumerate().filter(|(_, s)| s.nc > 0.0 || s.ct > 0.0) {
        let m = methods.entry(frames[f]).or_insert(MethodStat {
            frame: frames[f],
            self_weight: 0.0,
            total: 0.0,
            calls: Some(0.0),
            primitive_calls: Some(0.0),
        });
        m.self_weight += s.tt * 1000.0;
        m.total += s.ct * 1000.0;
        m.calls = m.calls.map(|c| c + s.nc);
        m.primitive_calls = m.primitive_calls.map(|c| c + s.cc);
    }
    profile.methods = methods.into_values().collect();
    profile.methods.sort_by(|a, b| {
        b.self_weight.total_cmp(&a.self_weight).then(b.total.total_cmp(&a.total)).then(a.frame.cmp(&b.frame))
    });
    let mut calls: HashMap<(u32, u32), CallEdge> = HashMap::new();
    for e in &edges {
        let (caller, callee) = (frames[e.caller], frames[e.callee]);
        let c = calls.entry((caller, callee)).or_insert(CallEdge {
            caller,
            callee,
            self_weight: 0.0,
            total: 0.0,
            calls: 0.0,
            primitive_calls: 0.0,
        });
        c.self_weight += e.tt * 1000.0;
        c.total += e.ct * 1000.0;
        c.calls += e.nc;
        c.primitive_calls += e.cc;
    }
    profile.calls = calls.into_values().collect();
    profile.calls.sort_by_key(|c| (c.caller, c.callee));
    Ok(profile)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tiny marshal writer for the shapes pstats uses (format 4: refs, short tuples and strings).
    #[derive(Default)]
    struct W(Vec<u8>);
    impl W {
        fn s(&mut self, v: &str) -> &mut Self {
            self.0.push(b'z');
            self.0.push(v.len() as u8);
            self.0.extend(v.as_bytes());
            self
        }
        fn i(&mut self, v: i32) -> &mut Self {
            self.0.push(b'i');
            self.0.extend(v.to_le_bytes());
            self
        }
        fn g(&mut self, v: f64) -> &mut Self {
            self.0.push(b'g');
            self.0.extend(v.to_le_bytes());
            self
        }
        fn tuple(&mut self, n: u8) -> &mut Self {
            self.0.extend([b')', n]);
            self
        }
        fn key(&mut self, (file, line, name): (&str, i32, &str)) -> &mut Self {
            self.tuple(3).s(file).i(line).s(name)
        }
    }

    type Key<'a> = (&'a str, i32, &'a str);
    /// `(caller, nc, cc, tt, ct)`.
    type CallerRow<'a> = (Key<'a>, i32, i32, f64, f64);
    /// `(func, cc, nc, tt, ct, callers)`.
    type Row<'a> = (Key<'a>, i32, i32, f64, f64, &'a [CallerRow<'a>]);

    /// `rows` as a pstats file.
    fn pstats(rows: &[Row]) -> Vec<u8> {
        let mut w = W::default();
        w.0.push(b'{');
        for (f, cc, nc, tt, ct, callers) in rows {
            w.key(*f).tuple(5).i(*cc).i(*nc).g(*tt).g(*ct);
            w.0.push(b'{');
            for (c, nc, cc, tt, ct) in *callers {
                w.key(*c).tuple(4).i(*nc).i(*cc).g(*tt).g(*ct);
            }
            w.0.push(b'0');
        }
        w.0.push(b'0');
        w.0
    }

    fn name(p: &Profile, frame: u32) -> &str {
        &p.frames[frame as usize].name
    }

    fn method<'a>(p: &'a Profile, n: &str) -> &'a MethodStat {
        p.methods.iter().find(|m| name(p, m.frame).starts_with(n)).unwrap()
    }

    const EXEC: Key = ("~", 0, "<built-in method builtins.exec>");

    #[test]
    fn reads_a_file_written_by_cprofile() {
        // `python -m cProfile -o out.prof work.py` (3.14), trimmed: refs, interned strings.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("work.py"), "").unwrap();
        let bytes = pstats(&[
            (EXEC, 1, 1, 0.000_01, 0.004, &[]),
            (("work.py", 1, "<module>"), 1, 1, 0.000_002, 0.0039, &[(EXEC, 1, 1, 0.000_002, 0.0039)]),
            (("work.py", 6, "main"), 1, 1, 0.000_002, 0.0038, &[(("work.py", 1, "<module>"), 1, 1, 0.000_002, 0.0038)]),
            (
                ("work.py", 1, "fib"),
                1,
                8361,
                0.002,
                0.002,
                &[(("work.py", 1, "fib"), 8360, 2, 0.0019, 0.002), (("work.py", 6, "main"), 1, 1, 0.000_001, 0.002)],
            ),
            (
                ("/ci/runner/lib.py", 3, "helper"),
                2,
                2,
                0.0018,
                0.0018,
                &[(("work.py", 6, "main"), 2, 2, 0.0018, 0.0018)],
            ),
        ]);
        assert!(looks_like_pstats(&bytes));
        let p = read(&bytes, &[dir.path()], "cProfile").unwrap();
        assert_eq!((p.unit.as_str(), p.profiler.as_str()), ("ms", "cProfile"));
        assert!((p.total - 4.0).abs() < 1e-9, "{}", p.total);

        // Recursion: 8361 calls, 1 primitive; own and total time as recorded.
        let fib = method(&p, "fib");
        assert_eq!((fib.calls, fib.primitive_calls), (Some(8361.0), Some(1.0)));
        assert!((fib.self_weight - 2.0).abs() < 1e-9 && (fib.total - 2.0).abs() < 1e-9);
        let frame = &p.frames[fib.frame as usize];
        assert_eq!(frame.file.as_deref(), Some(dir.path().join("work.py").as_path()));
        assert_eq!(frame.line, Some(0));

        // A file that isn't here keeps its recorded location in the name, without a link.
        let helper = &p.frames[method(&p, "helper").frame as usize];
        assert_eq!((helper.name.as_str(), helper.file.as_ref()), ("helper (/ci/runner/lib.py:3)", None));
        assert_eq!(name(&p, method(&p, "<built-in").frame), "<built-in method builtins.exec>");

        // Exact edges, including the recursive one.
        let edge = |caller: &str, callee: &str| {
            p.calls.iter().find(|e| name(&p, e.caller).starts_with(caller) && name(&p, e.callee).starts_with(callee))
        };
        assert_eq!(edge("fib", "fib").map(|e| (e.calls, e.primitive_calls)), Some((8360.0, 2.0)));
        assert_eq!(edge("main", "helper").map(|e| e.calls), Some(2.0));

        // The tree: exec → <module> → main → {fib, helper}; fib's self-call is not unfolded.
        let path = |names: &[&str]| {
            let mut node = 0usize;
            for n in names {
                node = *p.nodes[node]
                    .children
                    .iter()
                    .find(|c| name(&p, p.nodes[**c as usize].frame).starts_with(n))
                    .unwrap_or_else(|| panic!("no {n}")) as usize;
            }
            &p.nodes[node]
        };
        let fib_node = path(&["<built-in", "<module>", "main", "fib"]);
        assert!(fib_node.children.is_empty());
        assert!((fib_node.total - 2.0).abs() < 1e-9);
        assert!((path(&["<built-in", "<module>", "main"]).total - 3.8).abs() < 1e-9);
    }

    #[test]
    fn reads_cpythons_own_output() {
        // `python3.14 -m cProfile -o fib.prof work.py`: interned strings, refs, short tuples.
        let p = read(include_bytes!("../testdata/fib.prof"), &[], "cProfile").unwrap();
        let fib = method(&p, "fib");
        assert_eq!((fib.calls, fib.primitive_calls), (Some(8361.0), Some(1.0)));
        assert_eq!(name(&p, fib.frame), "fib (work.py:1)");
        assert!(p.methods.iter().any(|m| name(&p, m.frame) == "<method 'disable' of '_lsprof.Profiler' objects>"));
        let module = method(&p, "<module>");
        assert!(p.total >= module.total && module.total > 0.0);
    }

    #[test]
    fn a_shared_callee_splits_its_time_by_caller() {
        // a and b both call leaf; leaf spends 4 ms for a and 1 ms for b.
        let bytes = pstats(&[
            (("m.py", 1, "a"), 1, 1, 0.0, 0.004, &[]),
            (("m.py", 2, "b"), 1, 1, 0.0, 0.001, &[]),
            (
                ("m.py", 3, "leaf"),
                5,
                5,
                0.005,
                0.005,
                &[(("m.py", 1, "a"), 4, 4, 0.004, 0.004), (("m.py", 2, "b"), 1, 1, 0.001, 0.001)],
            ),
        ]);
        let p = read(&bytes, &[], "cProfile").unwrap();
        let under = |n: &str| {
            let root =
                p.nodes[0].children.iter().find(|c| name(&p, p.nodes[**c as usize].frame).starts_with(n)).unwrap();
            p.nodes[p.nodes[*root as usize].children[0] as usize].total
        };
        assert!((under("a ") - 4.0).abs() < 1e-9 && (under("b ") - 1.0).abs() < 1e-9);
    }

    #[test]
    fn a_function_that_calls_back_into_itself_through_others_is_still_the_root() {
        // exec runs the script, whose import runs exec again: exec has a caller, inside itself.
        let import: Key = ("<frozen importlib._bootstrap>", 1, "_call_with_frames_removed");
        let bytes = pstats(&[
            (EXEC, 2, 3, 0.0, 0.010, &[(import, 1, 1, 0.0, 0.003)]),
            (("main.py", 1, "<module>"), 1, 1, 0.006, 0.010, &[(EXEC, 1, 1, 0.006, 0.010)]),
            (import, 1, 1, 0.0, 0.004, &[(("main.py", 1, "<module>"), 1, 1, 0.0, 0.004)]),
            (("~", 0, "<method 'disable' of '_lsprof.Profiler' objects>"), 1, 1, 0.000_001, 0.000_001, &[]),
        ]);
        let p = read(&bytes, &[], "cProfile").unwrap();
        let roots: Vec<&str> = p.nodes[0].children.iter().map(|c| name(&p, p.nodes[*c as usize].frame)).collect();
        assert_eq!(roots, ["<built-in method builtins.exec>"], "disable is below the share kept");
        assert!((p.total - 10.0).abs() < 1e-9, "{}", p.total);
        let exec = &p.nodes[p.nodes[0].children[0] as usize];
        assert_eq!(name(&p, p.nodes[exec.children[0] as usize].frame), "<module> (main.py:1)");
    }

    #[test]
    fn without_times_per_caller_the_tree_is_flat() {
        let mut w = W::default();
        w.0.push(b'{');
        w.key(("m.py", 1, "f")).tuple(5).i(1).i(1).g(0.002).g(0.003);
        w.0.push(b'{');
        w.key(("m.py", 9, "g")).i(1);
        w.0.push(b'0');
        w.key(("m.py", 9, "g")).tuple(5).i(1).i(1).g(0.001).g(0.003);
        w.0.extend(b"{00");
        let p = read(&w.0, &[], "profile").unwrap();
        assert_eq!(p.nodes[0].children.len(), 2);
        assert!((p.total - 3.0).abs() < 1e-9, "{}", p.total);
    }

    #[test]
    fn a_dense_call_graph_stays_bounded() {
        // f0 → f1 → … with every fi also calling every fj (j > i): exponentially many paths.
        let n = 60;
        let keys: Vec<String> = (0..n).map(|i| format!("f{i}")).collect();
        let mut rows = Vec::new();
        let callers: Vec<Vec<CallerRow>> =
            (0..n).map(|j| (0..j).map(|i| (("m.py", i as i32, keys[i].as_str()), 1, 1, 0.0, 1.0)).collect()).collect();
        for j in 0..n {
            rows.push((("m.py", j as i32, keys[j].as_str()), 1, 1, 0.001, 1.0, callers[j].as_slice()));
        }
        let p = read(&pstats(&rows), &[], "cProfile").unwrap();
        assert!(p.nodes.len() <= MAX_NODES + 1, "{}", p.nodes.len());
        assert_eq!(p.methods.len(), n);
    }

    #[test]
    fn profile_module_caller_counts_and_long_ints() {
        let mut w = W::default();
        w.0.push(b'{');
        w.key(("m.py", 1, "f")).tuple(5).i(1);
        // 2**31 calls as a marshal long: digits 0, 0, 2 (15 bits each).
        w.0.extend([b'l', 3, 0, 0, 0, 0, 0, 0, 0, 2, 0]);
        w.g(0.5).g(0.5);
        w.0.push(b'{');
        w.key(("m.py", 9, "g")).i(7);
        w.0.extend(b"00");
        let p = read(&w.0, &[], "profile").unwrap();
        let f = method(&p, "f");
        assert_eq!(f.calls, Some(2f64.powi(31)));
        assert_eq!(p.calls.iter().map(|e| e.calls).collect::<Vec<_>>(), [7.0]);
    }

    #[test]
    fn a_callers_table_referenced_by_many_functions_is_refused() {
        // 2,000 functions share one stats tuple (by reference) whose callers table has 200
        // entries: a 60 KB file that would unfold into 400,000 edges.
        let mut w = W::default();
        w.0.push(b'{');
        w.key(("m.py", 0, "f0"));
        w.0.push(b')' | 0x80);
        w.0.push(5);
        w.i(1).i(1).g(0.0).g(0.0);
        w.0.push(b'{');
        for i in 0..200 {
            w.key(("m.py", i, "c")).i(1);
        }
        w.0.push(b'0');
        // The tuple is the first object marked for reference: number 0.
        for i in 1..2_000 {
            w.key(("m.py", i, "f"));
            w.0.push(b'r');
            w.0.extend(0i32.to_le_bytes());
        }
        w.0.push(b'0');
        let err = read(&w.0, &[], "cProfile").unwrap_err();
        assert!(err.contains("more calls than the file can hold"), "{err}");
    }

    #[test]
    fn two_names_of_one_file_are_one_method() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("work.py");
        std::fs::write(&file, "").unwrap();
        let abs = file.to_string_lossy().into_owned();
        let bytes = pstats(&[
            (("work.py", 1, "f"), 1, 1, 0.001, 0.001, &[(EXEC, 1, 1, 0.001, 0.001)]),
            ((abs.as_str(), 1, "f"), 2, 2, 0.002, 0.002, &[(EXEC, 2, 2, 0.002, 0.002)]),
            (EXEC, 1, 1, 0.0, 0.003, &[]),
        ]);
        let p = read(&bytes, &[dir.path()], "cProfile").unwrap();
        let f: Vec<_> = p.methods.iter().filter(|m| name(&p, m.frame) == "f").collect();
        assert_eq!(f.len(), 1);
        assert_eq!((f[0].calls, f[0].primitive_calls), (Some(3.0), Some(3.0)));
        assert!((f[0].total - 3.0).abs() < 1e-9);
        assert_eq!(p.calls.iter().filter(|e| name(&p, e.callee) == "f").map(|e| e.calls).collect::<Vec<_>>(), [3.0]);
    }

    #[test]
    fn garbage_is_an_error_not_a_panic() {
        for bytes in [&b"{)"[..], b"{)\x03z\xff", b"{\xff", b"{)\x03z\x01~i\x00\x00\x00\x00r\xff\xff\xff\x7f"] {
            assert!(read(bytes, &[], "cProfile").is_err(), "{bytes:?}");
        }
        assert!(!looks_like_pstats(br#"{"nodes":[]}"#));
        assert!(looks_like_pstats(b"\xfb)\x03"));
    }
}
