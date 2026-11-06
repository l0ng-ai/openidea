//! The flow of local variables through one function-like (or a file's top
//! level): which variables exist, with which type, at every place a
//! variable is read or written, and which statements can't be reached.
//!
//! Rather than lowering the body to basic blocks first, [`Builder`]
//! interprets the syntax tree's structured control flow directly (PHP's only
//! unstructured jump, `goto`, is approximated): it carries an environment
//! ([`Env`]) through the statements, forks it at branches, merges it where
//! paths meet, iterates loops to a fixed point (widening to `mixed` after a
//! few passes), and routes `break`/`continue`/`return`/`throw` to their
//! targets. The result ([`Flow`]) is the same information a flow graph
//! would give per variable occurrence. This is the scope-walking design
//! PHPStan and Psalm document for their analysers, written for this engine.
//!
//! What it covers:
//!
//! - assignments (plain and compound), `list()`/`[…]` destructuring
//!   (nested, keyed), writes into array elements (`$a['k'] = …`, `$a[] =
//!   …`), `++`/`--`, references and by-reference arguments;
//! - `foreach` keys and values, `catch` variables, `global` and `static`
//!   variables, `unset`;
//! - closures' `use` captures and the whole enclosing scope of arrow
//!   functions, at the point the function is created;
//! - narrowing by conditions: `instanceof`, the `is_*` functions, `null`
//!   comparisons, `isset`, `empty`, truthiness, `!`, `&&`/`||`, the ternary
//!   and `assert()`; an early `return`/`throw`/`continue` leaves the other
//!   branch's narrowing in force; `??=` removes `null`;
//! - `if`/`elseif`/`else`, `switch` with fall-through, `match`, loops of
//!   every kind, `try`/`catch`/`finally`, `exit`, `throw` and calls
//!   returning `never`.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ops::Range;
use std::rc::Rc;

use mago_span::HasSpan;
use mago_syntax::cst::{
    Access, Argument, ArgumentList, ArrayElement, Assignment, BinaryOperator, Call, ClassLikeMemberSelector, Construct,
    DirectVariable, DoWhile, Expression, For, ForBody, Foreach, ForeachBody, ForeachTarget, FunctionLikeParameterList,
    If, IfBody, Literal, MatchArm, MethodBody, Namespace, NamespaceBody, Node, Statement, StaticItem, Switch,
    SwitchBody, SwitchCase, Try, UnaryPostfix, UnaryPrefix, UnaryPrefixOperator, Variable, While, WhileBody,
};

use super::{ExprTypes, Frame, MAX_SHAPE_FIELDS, TOP_LEVEL, falsy_removed, shape_key};
use crate::summary::type_hint;
use crate::types::ops::{Op, is_float, is_int, op_type};
use crate::types::{Shape, ShapeField, ShapeKey, Signature, Type};

/// How many passes a loop body gets before the variables still changing
/// are generalised (literals widened, shapes made `list<V>`/`array<K, V>`);
/// two passes later, those still changing become `mixed`, after which one
/// more pass reaches the fixed point.
const WIDEN_AFTER: usize = 2;

/// Whether a variable holds a value at some point.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Defined {
    /// On every path.
    Yes,
    /// On some paths only.
    Maybe,
    /// On no path.
    No,
}

/// A variable at one point of the flow.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VarState {
    /// The type on the paths where it is defined (`mixed` when it isn't).
    pub ty: Type,
    pub defined: Defined,
}

impl VarState {
    fn undefined() -> Self {
        Self { ty: Type::Mixed, defined: Defined::No }
    }

    fn defined(ty: Type) -> Self {
        Self { ty, defined: Defined::Yes }
    }
}

/// The local variables of one function-like or of a file's top level.
#[derive(Clone, Debug, Default)]
pub struct Flow {
    /// By the offset of a variable read: its state just before the read.
    reads: HashMap<u32, VarState>,
    /// By the offset of a variable written (assigned, a parameter, a
    /// `foreach`/`catch`/`global`/`static` target): its state after.
    writes: HashMap<u32, VarState>,
    /// By the start of a closure or arrow function: the variables of this
    /// scope it can see (`use` captures, or all of them for `fn`).
    captures: HashMap<u32, BTreeMap<Vec<u8>, VarState>>,
    /// The first statement of each run of statements no path reaches,
    /// after a statement of the same list that some path reaches.
    unreachable: Vec<Range<u32>>,
    /// Some path runs off the end of the body (an implicit `return`).
    falls_through: bool,
    /// Variables may come from where the flow can't see (`extract`,
    /// `$$name`, `include`, `eval`, `get_defined_vars`, `parse_str`).
    dynamic: bool,
    /// By the offset of a read or write of [`PROBE_VARIABLE`]: every
    /// variable of the scope there (for completion).
    probes: HashMap<u32, BTreeMap<Vec<u8>, VarState>>,
    /// Offsets of variable reads that may bind rather than read: by-reference
    /// bindings (`&$x`, `use (&$x)`, arguments to by-reference parameters)
    /// and arguments of calls whose signature isn't known.
    bindings: HashSet<u32>,
}

/// The variable completion puts at the caret (`$__ideProbe`): the flow keeps
/// the whole environment at it ([`Flow::variables_at`]).
pub const PROBE_VARIABLE: &[u8] = b"__ideProbe";

impl Flow {
    /// The state of the variable read at byte `offset` (the `$`), before
    /// the read.
    pub fn read_at(&self, offset: u32) -> Option<&VarState> {
        self.reads.get(&offset)
    }

    /// The state of the variable written at byte `offset`, after the write.
    pub fn written_at(&self, offset: u32) -> Option<&VarState> {
        self.writes.get(&offset)
    }

    /// The variable at byte `offset`: what a write there stores, else what
    /// a read there sees.
    pub fn variable_at(&self, offset: u32) -> Option<&VarState> {
        self.writes.get(&offset).or_else(|| self.reads.get(&offset))
    }

    /// Byte ranges of the first statement of each unreachable run, in
    /// source order. Only runs that follow a reachable statement of the
    /// same list count: the body of `if (false) { … }` isn't one (a block
    /// no path enters is a constant condition, not dead code after a jump).
    pub fn unreachable(&self) -> &[Range<u32>] {
        &self.unreachable
    }

    /// True when some path reaches the end of the body, returning without
    /// a `return` statement.
    pub fn falls_through(&self) -> bool {
        self.falls_through
    }

    /// True when variables can appear in ways the flow doesn't follow.
    pub fn is_dynamic(&self) -> bool {
        self.dynamic
    }

    /// Every variable of the scope where [`PROBE_VARIABLE`] is read or
    /// written at byte `offset` (the `$`), as it is there; undefined ones
    /// included (with [`Defined::No`]).
    pub fn variables_at(&self, offset: u32) -> Option<&BTreeMap<Vec<u8>, VarState>> {
        self.probes.get(&offset)
    }

    /// True when the variable at byte `offset` may be bound there rather
    /// than read: a by-reference binding (`&$x`, `use (&$x)`, an argument
    /// for a by-reference parameter, which may create the variable) or an
    /// argument of a call whose signature isn't known.
    pub fn is_binding(&self, offset: u32) -> bool {
        self.bindings.contains(&offset)
    }
}

/// The variables at one point, and whether the point is reachable. An
/// unreachable environment keeps the variables it had, so code after a
/// `return` still gets sensible types.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Env {
    vars: BTreeMap<Vec<u8>, VarState>,
    reachable: bool,
}

impl Env {
    fn new() -> Self {
        Self { vars: BTreeMap::new(), reachable: true }
    }

    fn get(&self, name: &[u8]) -> VarState {
        self.vars.get(name).cloned().unwrap_or_else(VarState::undefined)
    }

    fn unreachable(mut self) -> Self {
        self.reachable = false;
        self
    }

    /// Where paths meet: unreachable paths contribute nothing; a variable
    /// missing on some path is only maybe defined.
    fn merge(envs: impl IntoIterator<Item = Env>) -> Env {
        let mut first_unreachable = None;
        let mut merged: Option<Env> = None;
        for env in envs {
            if !env.reachable {
                first_unreachable.get_or_insert(env);
                continue;
            }
            merged = Some(match merged {
                None => env,
                Some(acc) => acc.join(env),
            });
        }
        merged.or(first_unreachable).unwrap_or_else(|| Env::new().unreachable())
    }

    fn join(self, other: Env) -> Env {
        let mut vars = BTreeMap::new();
        let mut names: Vec<&Vec<u8>> = self.vars.keys().chain(other.vars.keys()).collect();
        names.sort();
        names.dedup();
        for name in names {
            let state = match (self.vars.get(name), other.vars.get(name)) {
                (Some(a), Some(b)) => VarState {
                    ty: capped(Type::union([a.ty.clone(), b.ty.clone()])),
                    defined: if a.defined == Defined::Yes && b.defined == Defined::Yes {
                        Defined::Yes
                    } else {
                        Defined::Maybe
                    },
                },
                (Some(one), None) | (None, Some(one)) => VarState { ty: one.ty.clone(), defined: Defined::Maybe },
                (None, None) => continue,
            };
            vars.insert(name.clone(), state);
        }
        Env { vars, reachable: true }
    }
}

/// Where `break` and `continue` go.
#[derive(Default)]
struct Jumps {
    breaks: Vec<Env>,
    continues: Vec<Env>,
    /// `continue` in a `switch` acts as `break`.
    switch: bool,
}

/// Builds the [`Flow`] of one scope.
pub(super) struct Builder<'t, 'a, 'r> {
    types: &'t ExprTypes<'a, 'r>,
    /// The scope's frames, ending with its function-like (empty for the
    /// top level).
    frames: &'t [Frame<'a>],
    flow: Rc<RefCell<Flow>>,
    env: Env,
    loops: Vec<Jumps>,
    /// For each enclosing `try` block: every environment a throw could
    /// leave it with.
    tries: Vec<Vec<Env>>,
}

fn name_of<'a>(variable: &DirectVariable<'a>) -> &'a [u8] {
    variable.name.strip_prefix(b"$").unwrap_or(variable.name)
}

impl<'t, 'a, 'r> Builder<'t, 'a, 'r> {
    pub(super) fn run(types: &'t ExprTypes<'a, 'r>, frames: &'t [Frame<'a>], flow: Rc<RefCell<Flow>>) {
        let mut builder = Builder { types, frames, flow, env: Env::new(), loops: Vec::new(), tries: Vec::new() };
        builder.body();
        let mut flow = builder.flow.borrow_mut();
        flow.falls_through = builder.env.reachable;
        flow.unreachable.sort_by_key(|range| (range.start, range.end));
        flow.unreachable.dedup();
    }

    fn body(&mut self) {
        let Some(frame) = self.frames.last() else {
            self.statements(self.types.program().statements.iter());
            return;
        };
        match frame {
            Frame::Function(function) => {
                self.parameters(&function.parameter_list, frame);
                self.statements(function.body.statements.iter());
            }
            Frame::Method(method) => {
                self.parameters(&method.parameter_list, frame);
                if let MethodBody::Concrete(body) = &method.body {
                    self.statements(body.statements.iter());
                }
            }
            Frame::Closure(closure) => {
                let outer = self.types.flow_cell(outer_scope(&self.frames[..self.frames.len() - 1]));
                for variable in closure.use_clause.iter().flat_map(|clause| clause.variables.iter()) {
                    let state = outer.borrow().reads.get(&variable.variable.span.start.offset).cloned();
                    // Inside, a captured variable always exists (`null` when
                    // it didn't outside, which the `use` clause reports).
                    let state = state.map_or_else(|| VarState::defined(Type::Mixed), |s| VarState::defined(s.ty));
                    self.env.vars.insert(name_of(&variable.variable).to_vec(), state);
                }
                self.parameters(&closure.parameter_list, frame);
                self.statements(closure.body.statements.iter());
            }
            Frame::Arrow(arrow) => {
                let outer = self.types.flow_cell(outer_scope(&self.frames[..self.frames.len() - 1]));
                if let Some(vars) = outer.borrow().captures.get(&arrow.span().start.offset) {
                    self.env.vars = vars.clone();
                }
                self.parameters(&arrow.parameter_list, frame);
                self.expr(arrow.expression);
            }
            Frame::Class(_) => {}
        }
    }

    fn parameters(&mut self, list: &'a FunctionLikeParameterList<'a>, frame: &Frame<'a>) {
        for parameter in list.parameters.iter() {
            let name = name_of(&parameter.variable);
            let ty = self.types.parameter(frame, name).unwrap_or(Type::Mixed);
            self.write(&parameter.variable, ty);
        }
    }

    // ------------------------------------------------------------ records

    fn read(&mut self, variable: &DirectVariable<'a>) {
        let name = name_of(variable);
        if name == b"this" {
            return;
        }
        let state = self.env.get(name);
        let mut flow = self.flow.borrow_mut();
        if name == PROBE_VARIABLE {
            flow.probes.insert(variable.span.start.offset, self.env.vars.clone());
        }
        flow.reads.insert(variable.span.start.offset, state);
    }

    fn write(&mut self, variable: &DirectVariable<'a>, ty: Type) {
        let name = name_of(variable);
        if name == b"this" {
            return;
        }
        let state = VarState::defined(ty);
        if name == PROBE_VARIABLE {
            self.flow.borrow_mut().probes.insert(variable.span.start.offset, self.env.vars.clone());
        }
        self.env.vars.insert(name.to_vec(), state.clone());
        self.flow.borrow_mut().writes.insert(variable.span.start.offset, state);
    }

    fn dynamic(&mut self) {
        self.flow.borrow_mut().dynamic = true;
    }

    fn binding(&mut self, variable: &DirectVariable<'a>) {
        self.flow.borrow_mut().bindings.insert(variable.span.start.offset);
    }

    fn type_of(&self, expr: &'a Expression<'a>) -> Type {
        self.types.expr(expr, self.frames)
    }

    // --------------------------------------------------------- statements

    fn statements(&mut self, statements: impl Iterator<Item = &'a Statement<'a>>) {
        // Whether a statement of this list was reached, and the current
        // unreachable run reported (or not to be: no reached statement
        // came before it).
        let mut reached = false;
        let mut reported = false;
        for statement in statements {
            if self.env.reachable {
                reached = true;
                reported = false;
            } else if !reached {
                reported = true;
            } else if !reported && !is_inert(statement) {
                let span = statement.span();
                self.flow.borrow_mut().unreachable.push(span.start.offset..span.end.offset);
                reported = true;
            }
            self.statement(statement);
            if let Some(points) = self.tries.last_mut() {
                points.push(self.env.clone());
            }
        }
    }

    fn statement(&mut self, statement: &'a Statement<'a>) {
        match statement {
            Statement::Expression(statement) => {
                self.expr(statement.expression);
                if self.env.reachable
                    && matches!(statement.expression, Expression::Call(_))
                    && super::chain_depth(statement.expression) <= super::MAX_CHAIN
                    && self.type_of(statement.expression) == Type::Never
                {
                    self.env.reachable = false;
                }
            }
            Statement::Echo(echo) => echo.values.iter().for_each(|value| self.expr(value)),
            Statement::EchoTag(echo) => echo.values.iter().for_each(|value| self.expr(value)),
            Statement::Return(statement) => {
                if let Some(value) = statement.value {
                    self.expr(value);
                }
                self.env.reachable = false;
            }
            Statement::Block(block) => self.statements(block.statements.iter()),
            Statement::Namespace(Namespace { body, .. }) => match body {
                NamespaceBody::Implicit(body) => self.statements(body.statements.iter()),
                NamespaceBody::BraceDelimited(block) => self.statements(block.statements.iter()),
            },
            Statement::Declare(declare) => {
                declare.items.iter().for_each(|item| self.expr(item.value));
                match &declare.body {
                    mago_syntax::cst::DeclareBody::Statement(statement) => self.statement(statement),
                    mago_syntax::cst::DeclareBody::ColonDelimited(body) => self.statements(body.statements.iter()),
                }
            }
            Statement::If(node) => self.r#if(node),
            Statement::While(node) => self.r#while(node),
            Statement::DoWhile(node) => self.do_while(node),
            Statement::For(node) => self.r#for(node),
            Statement::Foreach(node) => self.foreach(node),
            Statement::Switch(node) => self.switch(node),
            Statement::Try(node) => self.r#try(node),
            Statement::Break(node) => {
                if let Some(level) = node.level {
                    self.expr(level);
                }
                self.jump(node.level, true);
            }
            Statement::Continue(node) => {
                if let Some(level) = node.level {
                    self.expr(level);
                }
                self.jump(node.level, false);
            }
            Statement::Global(global) => {
                for variable in global.variables.iter() {
                    match variable {
                        Variable::Direct(direct) => self.write(direct, Type::Mixed),
                        other => self.variable(other),
                    }
                }
            }
            Statement::Static(statement) => {
                for item in statement.items.iter() {
                    match item {
                        // The value persists between calls: the initial
                        // value's type, widened.
                        StaticItem::Concrete(item) => {
                            self.expr(item.value);
                            let ty = self.type_of(item.value).widen();
                            self.write(&item.variable, ty);
                        }
                        StaticItem::Abstract(item) => self.write(&item.variable, Type::Mixed),
                    }
                }
            }
            Statement::Unset(unset) => {
                for value in unset.values.iter() {
                    match value {
                        Expression::Variable(Variable::Direct(direct)) => {
                            self.env.vars.remove(name_of(direct));
                        }
                        other => self.expr(other),
                    }
                }
            }
            Statement::Goto(_) => self.env.reachable = false,
            Statement::Label(_) => {
                // Any `goto` may land here: everything is only maybe set.
                self.env.reachable = true;
                for state in self.env.vars.values_mut() {
                    state.defined = Defined::Maybe;
                    state.ty = Type::Mixed;
                }
            }
            // Declarations have their own scopes; the rest holds no code.
            _ => {}
        }
    }

    fn jump(&mut self, level: Option<&'a Expression<'a>>, is_break: bool) {
        let level = match level {
            Some(Expression::Literal(Literal::Integer(integer))) => {
                integer.value.and_then(|value| usize::try_from(value).ok()).unwrap_or(1).max(1)
            }
            _ => 1,
        };
        let env = self.env.clone();
        if let Some(index) = self.loops.len().checked_sub(level) {
            let target = &mut self.loops[index];
            if is_break || target.switch { target.breaks.push(env) } else { target.continues.push(env) }
        }
        self.env.reachable = false;
    }

    fn r#if(&mut self, node: &'a If<'a>) {
        let (then, mut rest) = self.condition(node.condition);
        let mut ends = Vec::new();
        self.env = then;
        match &node.body {
            IfBody::Statement(body) => {
                self.statement(body.statement);
                ends.push(self.env.clone());
                for clause in body.else_if_clauses.iter() {
                    self.env = rest;
                    let (then, other) = self.condition(clause.condition);
                    self.env = then;
                    self.statement(clause.statement);
                    ends.push(self.env.clone());
                    rest = other;
                }
                match &body.else_clause {
                    Some(clause) => {
                        self.env = rest;
                        self.statement(clause.statement);
                        ends.push(self.env.clone());
                    }
                    None => ends.push(rest),
                }
            }
            IfBody::ColonDelimited(body) => {
                self.statements(body.statements.iter());
                ends.push(self.env.clone());
                for clause in body.else_if_clauses.iter() {
                    self.env = rest;
                    let (then, other) = self.condition(clause.condition);
                    self.env = then;
                    self.statements(clause.statements.iter());
                    ends.push(self.env.clone());
                    rest = other;
                }
                match &body.else_clause {
                    Some(clause) => {
                        self.env = rest;
                        self.statements(clause.statements.iter());
                        ends.push(self.env.clone());
                    }
                    None => ends.push(rest),
                }
            }
        }
        self.env = Env::merge(ends);
    }

    /// Runs a loop to a fixed point. `pass` runs one iteration from the
    /// entry environment (in `self.env`) and returns the environment that
    /// goes back to the top and the one leaving through the condition.
    fn fixed_point(&mut self, mut pass: impl FnMut(&mut Self) -> (Env, Env)) {
        let pre = self.env.clone();
        let mut entry = pre.clone();
        let mut iteration = 0;
        loop {
            self.env = entry.clone();
            self.loops.push(Jumps::default());
            let (back, out) = pass(self);
            let jumps = self.loops.pop().unwrap_or_default();
            let mut next = Env::merge([pre.clone(), back]);
            if iteration >= WIDEN_AFTER {
                for (name, state) in &mut next.vars {
                    if entry.vars.get(name).is_none_or(|old| old.ty != state.ty) {
                        state.ty = if iteration >= WIDEN_AFTER + 2 { Type::Mixed } else { generalized(&state.ty) };
                    }
                }
            }
            iteration += 1;
            if next == entry || iteration > WIDEN_AFTER + 4 {
                self.env = Env::merge(std::iter::once(out).chain(jumps.breaks));
                return;
            }
            entry = next;
        }
    }

    /// The environment reaching the end of an iteration: the body's end and
    /// every `continue`.
    fn iteration_end(&mut self) -> Env {
        let continues = self.loops.last_mut().map(|jumps| std::mem::take(&mut jumps.continues)).unwrap_or_default();
        Env::merge(std::iter::once(self.env.clone()).chain(continues))
    }

    fn r#while(&mut self, node: &'a While<'a>) {
        self.fixed_point(|this| {
            let (then, out) = this.condition(node.condition);
            this.env = then;
            match &node.body {
                WhileBody::Statement(statement) => this.statement(statement),
                WhileBody::ColonDelimited(body) => this.statements(body.statements.iter()),
            }
            (this.iteration_end(), out)
        });
    }

    fn do_while(&mut self, node: &'a DoWhile<'a>) {
        self.fixed_point(|this| {
            this.statement(node.statement);
            this.env = this.iteration_end();
            this.condition(node.condition)
        });
    }

    fn r#for(&mut self, node: &'a For<'a>) {
        node.initializations.iter().for_each(|init| self.expr(init));
        self.fixed_point(|this| {
            // Every condition runs; the last one decides. None loops forever.
            let mut outcome = None;
            for condition in node.conditions.iter() {
                if let Some((then, _)) = outcome.take() {
                    this.env = then;
                }
                outcome = Some(this.condition(condition));
            }
            let (then, out) = outcome.unwrap_or_else(|| (this.env.clone(), this.env.clone().unreachable()));
            this.env = then;
            match &node.body {
                ForBody::Statement(statement) => this.statement(statement),
                ForBody::ColonDelimited(body) => this.statements(body.statements.iter()),
            }
            this.env = this.iteration_end();
            node.increments.iter().for_each(|increment| this.expr(increment));
            (this.env.clone(), out)
        });
    }

    fn foreach(&mut self, node: &'a Foreach<'a>) {
        self.expr(node.expression);
        let iterated = self.type_of(node.expression);
        let (key_type, value_type) = self.types.iteration_types(&iterated, self.frames);
        self.fixed_point(|this| {
            // Zero iterations leave by the top, as does the last one.
            let out = this.env.clone();
            match &node.target {
                ForeachTarget::Value(target) => this.assign_to(target.value, value_type.clone()),
                ForeachTarget::KeyValue(target) => {
                    this.assign_to(target.key, key_type.clone());
                    this.assign_to(target.value, value_type.clone());
                }
            }
            match &node.body {
                ForeachBody::Statement(statement) => this.statement(statement),
                ForeachBody::ColonDelimited(body) => this.statements(body.statements.iter()),
            }
            (this.iteration_end(), out)
        });
    }

    fn switch(&mut self, node: &'a Switch<'a>) {
        self.expr(node.expression);
        let start = self.env.clone();
        let cases = match &node.body {
            SwitchBody::BraceDelimited(body) => &body.cases,
            SwitchBody::ColonDelimited(body) => &body.cases,
        };
        self.loops.push(Jumps { switch: true, ..Jumps::default() });
        let mut fall_through: Option<Env> = None;
        let mut has_default = false;
        for case in cases.iter() {
            self.env = start.clone();
            let statements = match case {
                SwitchCase::Expression(case) => {
                    self.expr(case.expression);
                    &case.statements
                }
                SwitchCase::Default(case) => {
                    has_default = true;
                    &case.statements
                }
            };
            if let Some(previous) = fall_through.take() {
                self.env = Env::merge([self.env.clone(), previous]);
            }
            self.statements(statements.iter());
            fall_through = Some(self.env.clone());
        }
        let jumps = self.loops.pop().unwrap_or_default();
        let mut ends = jumps.breaks;
        ends.extend(fall_through);
        if !has_default {
            ends.push(start);
        }
        self.env = Env::merge(ends);
    }

    fn r#try(&mut self, node: &'a Try<'a>) {
        self.tries.push(vec![self.env.clone()]);
        self.statements(node.block.statements.iter());
        let points = self.tries.pop().unwrap_or_default();
        let mut thrown = Env::merge(points);
        thrown.reachable = true;
        let mut ends = vec![self.env.clone()];
        for clause in node.catch_clauses.iter() {
            self.env = thrown.clone();
            if let Some(variable) = &clause.variable {
                let hint = type_hint(self.types.scope(clause.hint.span().start.offset), &clause.hint);
                self.write(variable, Type::from_hint(&hint));
            }
            self.statements(clause.block.statements.iter());
            ends.push(self.env.clone());
        }
        self.env = Env::merge(ends);
        if let Some(finally) = &node.finally_clause {
            // `finally` also runs when every path left early.
            let reachable = self.env.reachable;
            if !reachable {
                self.env = Env::merge([thrown, self.env.clone()]);
                self.env.reachable = true;
            }
            self.statements(finally.block.statements.iter());
            if !reachable {
                self.env.reachable = false;
            }
        }
    }

    // -------------------------------------------------------- expressions

    fn expr(&mut self, expr: &'a Expression<'a>) {
        match expr {
            Expression::Parenthesized(inner) => self.expr(inner.expression),
            Expression::Variable(variable) => self.variable(variable),
            Expression::Assignment(assignment) => self.assignment(assignment),
            Expression::Binary(binary) => match binary.operator {
                BinaryOperator::And(_)
                | BinaryOperator::LowAnd(_)
                | BinaryOperator::Or(_)
                | BinaryOperator::LowOr(_) => {
                    let (then, other) = self.condition(expr);
                    self.env = Env::merge([then, other]);
                }
                BinaryOperator::NullCoalesce(_) => {
                    self.expr(binary.lhs);
                    let skipped = self.env.clone();
                    self.expr(binary.rhs);
                    self.env = Env::merge([skipped, self.env.clone()]);
                }
                _ => {
                    self.expr(binary.lhs);
                    self.expr(binary.rhs);
                }
            },
            Expression::Conditional(conditional) => {
                let (then, other) = self.condition(conditional.condition);
                self.env = then;
                if let Some(value) = conditional.then {
                    self.expr(value);
                }
                let then = std::mem::replace(&mut self.env, other);
                self.expr(conditional.r#else);
                self.env = Env::merge([then, self.env.clone()]);
            }
            Expression::Match(r#match) => {
                self.expr(r#match.expression);
                let start = self.env.clone();
                let mut ends = Vec::new();
                for arm in r#match.arms.iter() {
                    self.env = start.clone();
                    let value = match arm {
                        MatchArm::Expression(arm) => {
                            arm.conditions.iter().for_each(|condition| self.expr(condition));
                            arm.expression
                        }
                        MatchArm::Default(arm) => arm.expression,
                    };
                    self.expr(value);
                    ends.push(self.env.clone());
                }
                self.env = if ends.is_empty() { start } else { Env::merge(ends) };
            }
            Expression::Closure(closure) => {
                let mut captured = BTreeMap::new();
                for variable in closure.use_clause.iter().flat_map(|clause| clause.variables.iter()) {
                    self.read(&variable.variable);
                    let name = name_of(&variable.variable);
                    if variable.ampersand.is_some() {
                        self.binding(&variable.variable);
                    }
                    if variable.ampersand.is_some() && self.env.get(name).defined == Defined::No {
                        // Captured by reference: it exists from now on.
                        self.write(&variable.variable, Type::Null);
                    }
                    captured.insert(name.to_vec(), self.env.get(name));
                }
                self.created(closure.span().start.offset, closure.span().end.offset, captured);
            }
            Expression::ArrowFunction(arrow) => {
                let span = arrow.span();
                let vars = self.env.vars.clone();
                self.created(span.start.offset, span.end.offset, vars);
            }
            Expression::AnonymousClass(class) => {
                if let Some(arguments) = &class.argument_list {
                    self.node(Node::PartialArgumentList(arguments));
                }
            }
            Expression::UnaryPrefix(unary) => self.unary_prefix(unary),
            Expression::UnaryPostfix(UnaryPostfix { operand, .. }) => self.increment(operand),
            Expression::Construct(construct) => {
                self.children(expr);
                match construct {
                    Construct::Exit(_) | Construct::Die(_) => self.env.reachable = false,
                    Construct::Eval(_)
                    | Construct::Include(_)
                    | Construct::IncludeOnce(_)
                    | Construct::Require(_)
                    | Construct::RequireOnce(_) => self.dynamic(),
                    _ => {}
                }
            }
            Expression::Throw(_) => {
                self.children(expr);
                self.env.reachable = false;
            }
            Expression::Call(call) => self.call(call),
            Expression::Access(Access::StaticProperty(access)) => {
                // `Foo::$bar` names a property, not a variable.
                self.expr(access.class);
                match &access.property {
                    Variable::Direct(_) => {}
                    Variable::Indirect(indirect) => self.expr(indirect.expression),
                    Variable::Nested(nested) => self.variable(nested.variable),
                }
            }
            _ => self.children(expr),
        }
    }

    /// The children of an expression, in source order.
    fn children(&mut self, expr: &'a Expression<'a>) {
        Node::Expression(expr).visit_children(|child| self.node(child));
    }

    fn node(&mut self, node: Node<'a, 'a>) {
        match node {
            Node::Expression(expr) => self.expr(expr),
            Node::Variable(variable) => self.variable(variable),
            // Nested declarations have their own scopes.
            Node::Statement(_)
            | Node::Class(_)
            | Node::Interface(_)
            | Node::Trait(_)
            | Node::Enum(_)
            | Node::Function(_)
            | Node::DirectVariable(_) => {}
            other => other.visit_children(|child| self.node(child)),
        }
    }

    fn variable(&mut self, variable: &'a Variable<'a>) {
        match variable {
            Variable::Direct(direct) => self.read(direct),
            Variable::Indirect(indirect) => {
                self.dynamic();
                self.expr(indirect.expression);
            }
            Variable::Nested(nested) => {
                self.dynamic();
                self.variable(nested.variable);
            }
        }
    }

    /// A closure or arrow function is created here, seeing `vars`.
    fn created(&mut self, start: u32, end: u32, vars: BTreeMap<Vec<u8>, VarState>) {
        self.flow.borrow_mut().captures.insert(start, vars);
        // Flows already built inside it saw an older environment (an
        // earlier pass over a loop).
        self.types.flows.borrow_mut().retain(|key, _| !(start..=end).contains(key));
    }

    fn unary_prefix(&mut self, unary: &'a UnaryPrefix<'a>) {
        match &unary.operator {
            UnaryPrefixOperator::PreIncrement(_) | UnaryPrefixOperator::PreDecrement(_) => {
                self.increment(unary.operand)
            }
            UnaryPrefixOperator::Reference(_) => match unary.operand {
                // `&$x` creates `$x` (as `null`) when it doesn't exist.
                Expression::Variable(Variable::Direct(direct)) => {
                    self.read(direct);
                    self.binding(direct);
                    if self.env.get(name_of(direct)).defined == Defined::No {
                        self.write(direct, Type::Null);
                    }
                }
                operand => self.expr(operand),
            },
            _ => self.expr(unary.operand),
        }
    }

    /// `++`/`--` on an operand.
    fn increment(&mut self, operand: &'a Expression<'a>) {
        let Expression::Variable(Variable::Direct(direct)) = operand else {
            self.expr(operand);
            return;
        };
        self.read(direct);
        let state = self.env.get(name_of(direct));
        let ty = if state.defined == Defined::No || state.ty == Type::Null {
            Type::Int
        } else if state.ty.members().iter().all(|ty| is_int(ty) || is_float(ty)) {
            op_type(Op::Add, Some(&state.ty), Some(&Type::LiteralInt(1)))
        } else {
            state.ty.widen()
        };
        self.write(direct, ty);
    }

    fn assignment(&mut self, assignment: &'a Assignment<'a>) {
        match Op::of_assignment(&assignment.operator) {
            None => {
                if is_destination(assignment.lhs) {
                    self.expr(assignment.rhs);
                    let ty = if is_empty_array(assignment.rhs) {
                        empty_array()
                    } else {
                        self.types.assignment(assignment, self.frames)
                    };
                    self.assign_to(assignment.lhs, ty);
                } else {
                    self.expr(assignment.lhs);
                    self.expr(assignment.rhs);
                }
            }
            Some(op) => match assignment.lhs {
                Expression::Variable(Variable::Direct(direct)) => {
                    self.read(direct);
                    let before = self.env.clone();
                    self.expr(assignment.rhs);
                    if op == Op::Coalesce {
                        // The right side runs only when the left is null.
                        self.env = Env::merge([before, self.env.clone()]);
                    }
                    let ty = self.types.assignment(assignment, self.frames);
                    self.write(direct, ty);
                }
                lhs => {
                    self.expr(lhs);
                    self.expr(assignment.rhs);
                    if matches!(lhs, Expression::ArrayAccess(_) | Expression::ArrayAppend(_)) {
                        let ty = self.types.assignment(assignment, self.frames);
                        self.store(lhs, ty);
                    }
                }
            },
        }
    }

    /// Assigns a value of type `ty` to `target`: a variable, a destructuring
    /// pattern, an array element, or anything else (only visited).
    fn assign_to(&mut self, target: &'a Expression<'a>, ty: Type) {
        match target {
            Expression::Parenthesized(inner) => self.assign_to(inner.expression, ty),
            Expression::Variable(Variable::Direct(direct)) => self.write(direct, ty),
            Expression::UnaryPrefix(UnaryPrefix { operator: UnaryPrefixOperator::Reference(_), operand }) => {
                self.assign_to(operand, ty)
            }
            Expression::Array(array) => self.destructure(array.elements.iter(), &ty),
            Expression::LegacyArray(array) => self.destructure(array.elements.iter(), &ty),
            Expression::List(list) => self.destructure(list.elements.iter(), &ty),
            Expression::ArrayAccess(_) | Expression::ArrayAppend(_) => {
                self.indexes(target);
                self.store(target, ty);
            }
            other => self.expr(other),
        }
    }

    /// Visits what an array write evaluates besides the array variable at
    /// the bottom: the index expressions, outermost array first.
    fn indexes(&mut self, target: &'a Expression<'a>) {
        match target {
            Expression::Parenthesized(inner) => self.indexes(inner.expression),
            Expression::ArrayAccess(access) => {
                self.indexes(access.array);
                self.expr(access.index);
            }
            Expression::ArrayAppend(append) => self.indexes(append.array),
            Expression::Variable(Variable::Direct(_)) => {}
            other => self.expr(other),
        }
    }

    fn destructure<'b>(&mut self, elements: impl Iterator<Item = &'b ArrayElement<'a>>, ty: &Type)
    where
        'a: 'b,
    {
        let mut index: i64 = 0;
        for element in elements {
            match element {
                ArrayElement::KeyValue(element) => {
                    self.expr(element.key);
                    let key = self.type_of(element.key);
                    let value = self.types.element(ty, &key, self.frames);
                    self.assign_to(element.value, value);
                }
                ArrayElement::Value(element) => {
                    let value = self.types.element(ty, &Type::LiteralInt(index), self.frames);
                    index += 1;
                    self.assign_to(element.value, value);
                }
                ArrayElement::Missing(_) => index += 1,
                ArrayElement::Variadic(element) => self.expr(element.value),
            }
        }
    }

    /// `$a[k] = value` / `$a[] = value` (nested to any depth): the array
    /// variable at the bottom gets the updated type. The index expressions
    /// must have been visited ([`Self::indexes`]).
    fn store(&mut self, target: &'a Expression<'a>, value: Type) {
        let (base, key) = match target {
            Expression::ArrayAccess(access) => (access.array, Some(self.type_of(access.index))),
            Expression::ArrayAppend(append) => (append.array, None),
            Expression::Parenthesized(inner) => return self.store(inner.expression, value),
            Expression::Variable(Variable::Direct(direct)) => return self.write(direct, value),
            // A property or call result: no local variable changes.
            _ => return,
        };
        let current = self.current(base);
        let updated = put(current.as_ref(), key.as_ref(), value);
        self.store(base, updated);
    }

    /// The current value of an array being written into; `None` when it
    /// doesn't exist yet.
    fn current(&self, base: &'a Expression<'a>) -> Option<Type> {
        match base {
            Expression::Variable(Variable::Direct(direct)) => {
                let state = self.env.get(name_of(direct));
                (state.defined != Defined::No).then_some(state.ty)
            }
            Expression::ArrayAccess(access) => {
                let outer = self.current(access.array)?;
                let element = self.types.element(&outer, &self.type_of(access.index), self.frames);
                Some(element)
            }
            Expression::ArrayAppend(_) => None,
            other => Some(self.type_of(other)),
        }
    }

    fn call(&mut self, call: &'a Call<'a>) {
        let (arguments, signature) = match call {
            Call::Function(call) => {
                let name = match call.function {
                    Expression::Identifier(identifier) => {
                        String::from_utf8_lossy(identifier.value()).trim_start_matches('\\').to_ascii_lowercase()
                    }
                    callee => {
                        self.expr(callee);
                        String::new()
                    }
                };
                match name.as_str() {
                    "assert" => {
                        let mut arguments = call.argument_list.arguments.iter();
                        if let Some(first) = arguments.next() {
                            let (then, _) = self.condition(argument_value(first));
                            self.env = then;
                        }
                        arguments.for_each(|argument| self.expr(argument_value(argument)));
                        return;
                    }
                    "extract" | "get_defined_vars" | "parse_str" | "eval" => self.dynamic(),
                    _ => {}
                }
                let signature = match call.function {
                    Expression::Identifier(identifier) => {
                        let scope = self.types.scope(identifier.span().start.offset);
                        let name = String::from_utf8_lossy(identifier.value());
                        let resolved = scope.resolve(crate::names::NameKind::Function, &name);
                        resolved.resolution.candidates().find_map(|fqn| self.types.function_signature(fqn))
                    }
                    _ => None,
                };
                (&call.argument_list, signature)
            }
            // The receiver is only typed when an argument may be written
            // through a by-reference parameter: typing goes through the
            // whole call chain, which fluent builders make very long.
            Call::Method(call) => {
                self.expr(call.object);
                self.selector(&call.method);
                let signature = may_write(&call.argument_list, call.object).then(|| {
                    let receiver = self.type_of(call.object);
                    self.types.method_signature(&receiver, &call.method, self.frames)
                });
                (&call.argument_list, signature.flatten())
            }
            Call::NullSafeMethod(call) => {
                self.expr(call.object);
                self.selector(&call.method);
                let signature = may_write(&call.argument_list, call.object).then(|| {
                    let receiver = self.type_of(call.object).without_null();
                    self.types.method_signature(&receiver, &call.method, self.frames)
                });
                (&call.argument_list, signature.flatten())
            }
            Call::StaticMethod(call) => {
                self.expr(call.class);
                self.selector(&call.method);
                let class = self.types.class_ref(call.class, self.frames);
                (&call.argument_list, self.types.method_signature(&class, &call.method, self.frames))
            }
        };
        self.arguments(arguments, signature.as_ref());
    }

    fn selector(&mut self, selector: &'a ClassLikeMemberSelector<'a>) {
        self.node(Node::ClassLikeMemberSelector(selector));
    }

    /// The arguments of a call; those passed to a by-reference parameter
    /// are written (`preg_match($p, $s, $matches)` creates `$matches`).
    fn arguments(&mut self, arguments: &'a ArgumentList<'a>, signature: Option<&Signature>) {
        for (position, argument) in arguments.arguments.iter().enumerate() {
            let value = argument_value(argument);
            let param = signature.and_then(|signature| match argument {
                Argument::Named(named) => {
                    let name = String::from_utf8_lossy(named.name.value);
                    signature.params.iter().find(|param| param.name.as_deref() == Some(name.as_ref()))
                }
                Argument::Positional(_) => {
                    signature.params.get(position).or_else(|| signature.params.last().filter(|param| param.variadic))
                }
            });
            match param {
                Some(param) if param.by_ref && is_destination(value) => {
                    self.expr(value);
                    if let Some(variable) = direct(value) {
                        self.binding(variable);
                    }
                    let current = match value {
                        Expression::Variable(Variable::Direct(direct)) => {
                            let state = self.env.get(name_of(direct));
                            (state.defined != Defined::No).then_some(state.ty)
                        }
                        _ => None,
                    };
                    let ty = match (&param.ty, current) {
                        (Type::Mixed, Some(current)) => current,
                        (ty, _) => ty.clone(),
                    };
                    self.assign_to(value, ty);
                }
                Some(_) => self.expr(value),
                None => {
                    self.expr(value);
                    // Unknown callee: it may take the argument by reference.
                    if signature.is_none()
                        && let Some(variable) = direct(value)
                    {
                        self.binding(variable);
                        if self.env.get(name_of(variable)).defined != Defined::Yes {
                            self.write(variable, Type::Mixed);
                        }
                    }
                }
            }
        }
    }

    // --------------------------------------------------------- conditions

    /// Visits a condition and returns the environments where it is true
    /// and where it is false.
    fn condition(&mut self, condition: &'a Expression<'a>) -> (Env, Env) {
        match condition {
            Expression::Parenthesized(inner) => self.condition(inner.expression),
            Expression::UnaryPrefix(UnaryPrefix { operator: UnaryPrefixOperator::Not(_), operand }) => {
                let (then, other) = self.condition(operand);
                (other, then)
            }
            Expression::Literal(Literal::True(_)) => (self.env.clone(), self.env.clone().unreachable()),
            Expression::Literal(Literal::False(_)) => (self.env.clone().unreachable(), self.env.clone()),
            Expression::Binary(binary) => match &binary.operator {
                BinaryOperator::And(_) | BinaryOperator::LowAnd(_) => {
                    let (left_true, left_false) = self.condition(binary.lhs);
                    self.env = left_true;
                    let (then, right_false) = self.condition(binary.rhs);
                    (then, Env::merge([left_false, right_false]))
                }
                BinaryOperator::Or(_) | BinaryOperator::LowOr(_) => {
                    let (left_true, left_false) = self.condition(binary.lhs);
                    self.env = left_false;
                    let (right_true, other) = self.condition(binary.rhs);
                    (Env::merge([left_true, right_true]), other)
                }
                BinaryOperator::Instanceof(_) => {
                    self.expr(binary.lhs);
                    self.expr(binary.rhs);
                    let Some(variable) = direct(binary.lhs) else { return self.split() };
                    let class = self.types.class_ref(binary.rhs, self.frames);
                    if class == Type::Mixed {
                        return self.split();
                    }
                    self.narrow(variable, &class)
                }
                BinaryOperator::Identical(_)
                | BinaryOperator::NotIdentical(_)
                | BinaryOperator::Equal(_)
                | BinaryOperator::NotEqual(_)
                | BinaryOperator::AngledNotEqual(_) => {
                    self.expr(binary.lhs);
                    self.expr(binary.rhs);
                    let variable = match (binary.lhs, binary.rhs) {
                        (Expression::Literal(Literal::Null(_)), other)
                        | (other, Expression::Literal(Literal::Null(_))) => direct(other),
                        _ => None,
                    };
                    let Some(variable) = variable else { return self.split() };
                    let strict =
                        matches!(binary.operator, BinaryOperator::Identical(_) | BinaryOperator::NotIdentical(_));
                    let (mut is_null, mut not_null) = self.narrow(variable, &Type::Null);
                    if !strict {
                        // `== null` holds for every falsy value.
                        is_null = self.env.clone();
                        not_null = self.update(&not_null, variable, falsy_removed);
                    }
                    match binary.operator {
                        BinaryOperator::Identical(_) | BinaryOperator::Equal(_) => (is_null, not_null),
                        _ => (not_null, is_null),
                    }
                }
                _ => {
                    self.expr(condition);
                    self.split()
                }
            },
            Expression::Call(Call::Function(call)) => {
                let target = match call.function {
                    Expression::Identifier(identifier) => type_check(identifier.value()),
                    _ => None,
                };
                self.expr(condition);
                let mut arguments = call.argument_list.arguments.iter();
                match (target, arguments.next().map(argument_value).and_then(direct)) {
                    (Some((target, negatable)), Some(variable)) => {
                        let (then, other) = self.narrow(variable, &target);
                        (then, if negatable { other } else { self.env.clone() })
                    }
                    _ => self.split(),
                }
            }
            Expression::Construct(Construct::Isset(isset)) => {
                self.expr(condition);
                let mut then = self.env.clone();
                for value in isset.values.iter() {
                    if let Some(variable) = direct(value) {
                        let name = name_of(variable);
                        let ty = then.get(name).ty.without_null();
                        then.vars.insert(name.to_vec(), VarState::defined(ty));
                    } else if let Some(variable) = base_variable(value) {
                        // `isset($a['k'])`, `isset($o->p)`: `$a`/`$o` exists.
                        defined_in(&mut then, variable);
                    }
                }
                (then, self.env.clone())
            }
            Expression::Construct(Construct::Empty(empty)) => {
                self.expr(condition);
                match direct(empty.value) {
                    Some(variable) => {
                        let mut other = self.update(&self.env, variable, falsy_removed);
                        defined_in(&mut other, variable);
                        (self.env.clone(), other)
                    }
                    None => match base_variable(empty.value) {
                        Some(variable) => {
                            let mut other = self.env.clone();
                            defined_in(&mut other, variable);
                            (self.env.clone(), other)
                        }
                        None => self.split(),
                    },
                }
            }
            Expression::Variable(Variable::Direct(variable)) => {
                self.read(variable);
                (self.update(&self.env, variable, falsy_removed), self.env.clone())
            }
            Expression::Assignment(assignment) => {
                self.expr(condition);
                match (Op::of_assignment(&assignment.operator), direct(assignment.lhs)) {
                    (None, Some(variable)) => (self.update(&self.env, variable, falsy_removed), self.env.clone()),
                    _ => self.split(),
                }
            }
            _ => {
                self.expr(condition);
                self.split()
            }
        }
    }

    /// No narrowing: both outcomes are the current environment.
    fn split(&self) -> (Env, Env) {
        (self.env.clone(), self.env.clone())
    }

    /// `env` with `variable`'s type mapped (a no-op for variables that don't
    /// exist).
    fn update(&self, env: &Env, variable: &DirectVariable<'_>, map: impl Fn(&Type) -> Type) -> Env {
        let mut env = env.clone();
        if let Some(state) = env.vars.get_mut(name_of(variable)) {
            state.ty = map(&state.ty);
        }
        env
    }

    /// The environments where `variable` is / is not of type `target`.
    fn narrow(&self, variable: &DirectVariable<'_>, target: &Type) -> (Env, Env) {
        let name = name_of(variable);
        let state = self.env.get(name);
        let mut then = self.env.clone();
        then.vars.insert(name.to_vec(), VarState::defined(self.narrowed_to(&state.ty, target)));
        let other = self.update(&self.env, variable, |ty| self.narrowed_away(ty, target));
        (then, other)
    }

    /// The part of `ty` that is a `target`.
    fn narrowed_to(&self, ty: &Type, target: &Type) -> Type {
        let hierarchy = self.types.resolver;
        let mut kept = Vec::new();
        for member in ty.members() {
            if member.is_subtype_of(target, hierarchy) {
                kept.push(member.clone());
            } else if target.is_subtype_of(member, hierarchy) {
                kept.push(target.clone());
            }
        }
        if kept.is_empty() { target.clone() } else { Type::union(kept) }
    }

    /// The part of `ty` that is not a `target`.
    fn narrowed_away(&self, ty: &Type, target: &Type) -> Type {
        let hierarchy = self.types.resolver;
        match ty {
            Type::Mixed => Type::Mixed,
            Type::Bool => match target {
                Type::LiteralBool(value) => Type::LiteralBool(!value),
                _ if Type::Bool.is_subtype_of(target, hierarchy) => Type::Never,
                _ => Type::Bool,
            },
            _ => Type::union(ty.members().iter().filter(|member| !member.is_subtype_of(target, hierarchy)).cloned()),
        }
    }
}

/// The frames of the scope around the end of `frames`: up to and including
/// its innermost function-like (none for the top level).
pub(super) fn outer_scope<'f, 'a>(frames: &'f [Frame<'a>]) -> &'f [Frame<'a>] {
    &frames[..frames.iter().rposition(Frame::is_function_like).map_or(0, |i| i + 1)]
}

/// The key a scope's flow is stored under.
pub(super) fn scope_key(scope: &[Frame<'_>]) -> u32 {
    scope.last().map_or(TOP_LEVEL, Frame::key)
}

fn argument_value<'a>(argument: &'a Argument<'a>) -> &'a Expression<'a> {
    match argument {
        Argument::Positional(argument) => argument.value,
        Argument::Named(argument) => argument.value,
    }
}

fn direct<'a>(expr: &'a Expression<'a>) -> Option<&'a DirectVariable<'a>> {
    match expr {
        Expression::Parenthesized(inner) => direct(inner.expression),
        Expression::Variable(Variable::Direct(variable)) if variable.name != b"$this" => Some(variable),
        _ => None,
    }
}

/// The variable at the bottom of an element or property access
/// (`$a['k']['l']`, `$o->p`, `$o?->p[0]`); not of a bare variable.
fn base_variable<'a>(expr: &'a Expression<'a>) -> Option<&'a DirectVariable<'a>> {
    let mut current = expr;
    let mut nested = false;
    loop {
        current = match current {
            Expression::Parenthesized(inner) => inner.expression,
            Expression::ArrayAccess(access) => access.array,
            Expression::Access(Access::Property(access)) => access.object,
            Expression::Access(Access::NullSafeProperty(access)) => access.object,
            _ => break,
        };
        nested = true;
    }
    if nested { direct(current) } else { None }
}

/// `env` with `variable` known to exist (its type kept).
fn defined_in(env: &mut Env, variable: &DirectVariable<'_>) {
    let name = name_of(variable);
    let ty = env.vars.get(name).map_or(Type::Mixed, |state| state.ty.clone());
    env.vars.insert(name.to_vec(), VarState::defined(ty));
}

/// Members a type joined from several paths keeps before its arrays are
/// collapsed.
const MAX_JOINED: usize = 16;

/// A joined type kept small: past [`MAX_JOINED`] members its array shapes,
/// arrays and lists become one `array<K, V>`, and if that isn't enough it
/// is `mixed`. Without it, a variable gaining a key under each of `n`
/// consecutive `if`s (`if (…) { $meta['a'] = …; } if (…) { $meta['b'] = …; }`)
/// would be a union of 2^n shapes.
fn capped(ty: Type) -> Type {
    if ty.members().len() <= MAX_JOINED {
        if size(&ty, MAX_JOINED_SIZE) <= MAX_JOINED_SIZE {
            return ty;
        }
        // Nested shapes grown too big (`$schema['properties'][…] = …` on a
        // large literal across branches): plain arrays.
        return ty.map(&mut |member| match member {
            Type::Shape(_) | Type::Array { .. } | Type::List { .. } => Some(Type::array()),
            _ => None,
        });
    }
    let (mut keys, mut values, mut others) = (Vec::new(), Vec::new(), Vec::new());
    for member in ty.members() {
        match member {
            Type::Shape(shape) => {
                keys.push(shape.key_type());
                values.push(shape.value_type());
            }
            Type::Array { key, value, .. } => {
                keys.push((**key).clone());
                values.push((**value).clone());
            }
            Type::List { value, .. } => {
                keys.push(Type::Int);
                values.push((**value).clone());
            }
            other => others.push(other.clone()),
        }
    }
    if !keys.is_empty() {
        others.push(Type::array_of(Type::union(keys).widen(), Type::union(values).widen()));
    }
    let out = Type::union(others);
    if out.members().len() > MAX_JOINED { Type::Mixed } else { out }
}

/// Nodes a type joined from several paths may have before its arrays
/// become plain `array`s.
const MAX_JOINED_SIZE: usize = 256;

/// The number of nodes of `ty`, counted up to a little past `limit`.
fn size(ty: &Type, limit: usize) -> usize {
    fn count(ty: &Type, total: &mut usize, limit: usize) {
        *total += 1;
        if *total > limit {
            return;
        }
        match ty {
            Type::Union(members) | Type::Intersection(members) => {
                members.iter().for_each(|member| count(member, total, limit))
            }
            Type::Shape(shape) => {
                for field in &shape.fields {
                    count(&field.ty, total, limit);
                }
                if let Some((key, value)) = &shape.rest {
                    count(key, total, limit);
                    count(value, total, limit);
                }
            }
            Type::Array { key, value, .. } | Type::Iterable { key, value } => {
                count(key, total, limit);
                count(value, total, limit);
            }
            Type::List { value, .. } => count(value, total, limit),
            Type::Named { args, .. } => args.iter().for_each(|arg| count(arg, total, limit)),
            _ => {}
        }
    }
    let mut total = 0;
    count(ty, &mut total, limit);
    total
}

/// Whether a method call on `object` may write one of its arguments
/// (one is a possible by-reference destination and the receiver's chain
/// is short enough to type).
fn may_write(arguments: &ArgumentList<'_>, object: &Expression<'_>) -> bool {
    arguments.arguments.iter().any(|argument| is_destination(argument_value(argument)))
        && super::chain_depth(object) <= super::MAX_CHAIN
}

/// Something a value can be stored into.
fn is_destination(expr: &Expression<'_>) -> bool {
    matches!(
        expr,
        Expression::Variable(Variable::Direct(_))
            | Expression::Array(_)
            | Expression::LegacyArray(_)
            | Expression::List(_)
            | Expression::ArrayAccess(_)
            | Expression::ArrayAppend(_)
    ) || matches!(expr, Expression::Parenthesized(inner) if is_destination(inner.expression))
}

/// Statements that are never "reached" as code.
fn is_inert(statement: &Statement<'_>) -> bool {
    matches!(
        statement,
        Statement::OpeningTag(_)
            | Statement::ClosingTag(_)
            | Statement::Inline(_)
            | Statement::Noop(_)
            | Statement::Use(_)
            | Statement::Class(_)
            | Statement::Interface(_)
            | Statement::Trait(_)
            | Statement::Enum(_)
            | Statement::Function(_)
            | Statement::Constant(_)
            | Statement::HaltCompiler(_)
            | Statement::Label(_)
    )
}

/// The type a type-checking function tests for, and whether its negation
/// narrows too (`!is_numeric($x)` says little about `$x`).
fn type_check(name: &[u8]) -> Option<(Type, bool)> {
    let name = String::from_utf8_lossy(name).trim_start_matches('\\').to_ascii_lowercase();
    Some(match name.as_str() {
        "is_null" => (Type::Null, true),
        "is_string" => (Type::string(), true),
        "is_int" | "is_integer" | "is_long" => (Type::Int, true),
        "is_float" | "is_double" => (Type::Float, true),
        "is_bool" => (Type::Bool, true),
        "is_array" => (Type::array(), true),
        "is_object" => (Type::Object, true),
        "is_resource" => (Type::Resource, true),
        "is_scalar" => (Type::Scalar, true),
        "is_iterable" => (Type::iterable(), false),
        "is_numeric" => (Type::Numeric, false),
        "is_callable" => (Type::Callable(None), false),
        _ => return None,
    })
}

/// `array{}`: what `[]` stores, so elements written later make a shape.
fn empty_array() -> Type {
    Type::Shape(Box::new(Shape { list: false, fields: Vec::new(), rest: None }))
}

fn is_empty_array(expr: &Expression<'_>) -> bool {
    match expr {
        Expression::Parenthesized(inner) => is_empty_array(inner.expression),
        Expression::Array(array) => array.elements.is_empty(),
        Expression::LegacyArray(array) => array.elements.is_empty(),
        _ => false,
    }
}

/// A type that changes from one loop pass to the next, made general so the
/// passes converge: literals widened, shapes turned into `list<V>` or
/// `array<K, V>` (possibly empty when `array{}` was among them).
fn generalized(ty: &Type) -> Type {
    let mut out = Vec::new();
    let mut empty = false;
    for member in ty.widen().members() {
        match member {
            Type::Shape(shape) if shape.fields.is_empty() && shape.rest.is_none() => empty = true,
            Type::Shape(shape) => {
                let value = Box::new(shape.value_type().widen());
                let non_empty = shape.is_non_empty();
                out.push(if shape.list {
                    Type::List { value, non_empty }
                } else {
                    Type::Array { key: Box::new(shape.key_type().widen()), value, non_empty }
                });
            }
            other => out.push(other.clone()),
        }
    }
    if empty {
        let mut arrays = false;
        for member in &mut out {
            if let Type::List { non_empty, .. } | Type::Array { non_empty, .. } = member {
                *non_empty = false;
                arrays = true;
            }
        }
        if !arrays {
            out.push(empty_array());
        }
    }
    Type::union(out)
}

/// The type of an array after `[key] = value` (`None` key: `[] = value`);
/// `None` base: the array didn't exist.
fn put(base: Option<&Type>, key: Option<&Type>, value: Type) -> Type {
    let Some(base) = base else {
        return put(Some(&Type::Null), key, value);
    };
    Type::union(base.members().iter().map(|member| put_one(member, key, value.clone())))
}

fn put_one(base: &Type, key: Option<&Type>, value: Type) -> Type {
    let literal = key.and_then(shape_key);
    let key_type = |key: &Type| {
        if key.members().iter().all(is_int) {
            Type::Int
        } else if key.members().iter().all(crate::types::ops::is_string) {
            Type::string()
        } else {
            Type::ArrayKey
        }
    };
    match base {
        Type::Null => match (key, literal) {
            (None, _) => Type::Shape(Box::new(Shape {
                list: true,
                fields: vec![ShapeField { key: ShapeKey::Int(0), ty: value, optional: false }],
                rest: None,
            })),
            (Some(_), Some(literal)) => Type::Shape(Box::new(Shape {
                list: literal == ShapeKey::Int(0),
                fields: vec![ShapeField { key: literal, ty: value, optional: false }],
                rest: None,
            })),
            (Some(key), None) => {
                Type::Array { key: Box::new(key_type(key)), value: Box::new(value.widen()), non_empty: true }
            }
        },
        Type::Shape(shape) if shape.rest.is_none() => {
            let next = shape
                .fields
                .iter()
                .filter_map(|field| match field.key {
                    ShapeKey::Int(int) => Some(int.saturating_add(1)),
                    ShapeKey::String(_) => None,
                })
                .max()
                .unwrap_or(0)
                .max(0);
            let literal = match key {
                None => Some(ShapeKey::Int(next)),
                Some(_) => literal,
            };
            match literal {
                Some(literal) => {
                    let mut fields = shape.fields.clone();
                    let appended = !fields.iter().any(|field| field.key == literal);
                    let list = (shape.list || shape.fields.is_empty()) && (!appended || literal == ShapeKey::Int(next));
                    match fields.iter_mut().find(|field| field.key == literal) {
                        Some(field) => *field = ShapeField { key: literal, ty: value, optional: false },
                        None => fields.push(ShapeField { key: literal, ty: value, optional: false }),
                    }
                    if fields.len() > MAX_SHAPE_FIELDS {
                        let shape = Shape { list, fields, rest: None };
                        return Type::Array {
                            key: Box::new(shape.key_type().widen()),
                            value: Box::new(shape.value_type().widen()),
                            non_empty: true,
                        };
                    }
                    Type::Shape(Box::new(Shape { list, fields, rest: None }))
                }
                None => Type::Array {
                    key: Box::new(Type::union([shape.key_type().widen(), key.map_or(Type::Int, key_type)])),
                    value: Box::new(Type::union([shape.value_type().widen(), value.widen()])),
                    non_empty: true,
                },
            }
        }
        Type::List { value: old, .. } if key.is_none() => {
            Type::List { value: Box::new(Type::union([(**old).clone(), value.widen()])), non_empty: true }
        }
        Type::Array { key: old_key, value: old, .. } => Type::Array {
            key: Box::new(Type::union([(**old_key).clone(), key.map_or(Type::Int, key_type)])),
            value: Box::new(Type::union([(**old).clone(), value.widen()])),
            non_empty: true,
        },
        Type::List { value: old, .. } => Type::Array {
            key: Box::new(Type::union([Type::Int, key.map_or(Type::Int, key_type)])),
            value: Box::new(Type::union([(**old).clone(), value.widen()])),
            non_empty: true,
        },
        // `ArrayAccess` objects, strings and the unknown keep their type.
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests;
