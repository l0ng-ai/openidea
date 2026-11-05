//! The types of PHP literals and operators, shared by summary-time
//! inference (`summary::extract::infer`, lazy) and expression types at a
//! caret ([`super::expr`], resolved).

use mago_syntax::cst::{AssignmentOperator, BinaryOperator, Literal, UnaryPrefixOperator};

use super::Type;

/// The type of a literal, keeping its value.
pub(crate) fn literal_type(literal: &Literal<'_>) -> Type {
    match literal {
        Literal::String(string) => match string.value {
            Some(value) => Type::LiteralString(String::from_utf8_lossy(value).into_owned()),
            None => Type::string(),
        },
        Literal::Integer(integer) => match integer.value.and_then(|value| i64::try_from(value).ok()) {
            Some(value) => Type::LiteralInt(value),
            None => Type::Int,
        },
        Literal::Float(float) => Type::LiteralFloat(String::from_utf8_lossy(float.raw).into_owned()),
        Literal::True(_) => Type::LiteralBool(true),
        Literal::False(_) => Type::LiteralBool(false),
        Literal::Null(_) => Type::Null,
    }
}

pub(crate) fn is_int(ty: &Type) -> bool {
    matches!(ty, Type::Int | Type::LiteralInt(_) | Type::IntRange { .. })
}

pub(crate) fn is_float(ty: &Type) -> bool {
    matches!(ty, Type::Float | Type::LiteralFloat(_))
}

pub(crate) fn is_string(ty: &Type) -> bool {
    matches!(ty, Type::String(_) | Type::LiteralString(_))
}

pub(crate) fn is_array(ty: &Type) -> bool {
    matches!(ty, Type::Array { .. } | Type::List { .. } | Type::Shape(_))
}

/// What a binary or compound-assignment operator computes, as far as its
/// result type goes. `??` is left to the caller (it needs the operands'
/// nullability).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Op {
    Concat,
    Add,
    Sub,
    Mul,
    Exp,
    Div,
    /// `%`, bitwise operators, shifts and `<=>`.
    Int,
    /// Comparisons, logical operators and `instanceof`.
    Bool,
    Coalesce,
}

impl Op {
    pub(crate) fn of_binary(operator: &BinaryOperator<'_>) -> Self {
        use BinaryOperator as B;
        match operator {
            B::StringConcat(..) => Self::Concat,
            B::NullCoalesce(..) => Self::Coalesce,
            B::Addition(..) => Self::Add,
            B::Subtraction(..) => Self::Sub,
            B::Multiplication(..) => Self::Mul,
            B::Exponentiation(..) => Self::Exp,
            B::Division(..) => Self::Div,
            B::Modulo(..)
            | B::BitwiseAnd(..)
            | B::BitwiseOr(..)
            | B::BitwiseXor(..)
            | B::LeftShift(..)
            | B::RightShift(..)
            | B::Spaceship(..) => Self::Int,
            _ => Self::Bool,
        }
    }

    /// The operator of `$a op= $b`; `None` for a plain `=`.
    pub(crate) fn of_assignment(operator: &AssignmentOperator) -> Option<Self> {
        use AssignmentOperator as A;
        Some(match operator {
            A::Assign(_) => return None,
            A::Concat(_) => Self::Concat,
            A::Coalesce(_) => Self::Coalesce,
            A::Addition(_) => Self::Add,
            A::Subtraction(_) => Self::Sub,
            A::Multiplication(_) => Self::Mul,
            A::Exponentiation(_) => Self::Exp,
            A::Division(_) => Self::Div,
            A::Modulo(_)
            | A::BitwiseAnd(_)
            | A::BitwiseOr(_)
            | A::BitwiseXor(_)
            | A::LeftShift(_)
            | A::RightShift(_) => Self::Int,
        })
    }
}

/// The result type of `left op right`; an operand is `None` when its type
/// isn't known yet. `??` gives the left side without `null`, or the right.
pub(crate) fn op_type(op: Op, left: Option<&Type>, right: Option<&Type>) -> Type {
    match op {
        Op::Concat => Type::string(),
        Op::Bool => Type::Bool,
        Op::Int => Type::Int,
        Op::Div => Type::union([Type::Int, Type::Float]),
        Op::Coalesce => match (left, right) {
            (Some(left), Some(right)) => Type::union([left.without_null(), right.clone()]),
            _ => Type::Mixed,
        },
        Op::Add | Op::Sub | Op::Mul | Op::Exp => {
            let (Some(left), Some(right)) = (left, right) else {
                return Type::union([Type::Int, Type::Float]);
            };
            let numeric = |ty: &Type| is_int(ty) || is_float(ty);
            if op == Op::Add && is_array(left) && is_array(right) {
                Type::array()
            } else if is_int(left) && is_int(right) && op != Op::Exp {
                Type::Int
            } else if numeric(left) && numeric(right) && (is_float(left) || is_float(right)) {
                Type::Float
            } else {
                Type::union([Type::Int, Type::Float])
            }
        }
    }
}

/// The type of a prefix operator applied to an operand of type `operand`
/// (`None` when unknown). `None` for the operators that give their
/// operand's value (`@`, `&`, `++`, `--`).
pub(crate) fn unary_type(operator: &UnaryPrefixOperator<'_>, operand: Option<&Type>) -> Option<Type> {
    use UnaryPrefixOperator as U;
    Some(match operator {
        U::ArrayCast(..) => Type::array(),
        U::BoolCast(..) | U::BooleanCast(..) | U::Not(..) => Type::Bool,
        U::DoubleCast(..) | U::RealCast(..) | U::FloatCast(..) => Type::Float,
        U::IntCast(..) | U::IntegerCast(..) | U::BitwiseNot(..) => Type::Int,
        U::ObjectCast(..) => Type::Object,
        U::StringCast(..) | U::BinaryCast(..) => Type::string(),
        U::UnsetCast(..) | U::VoidCast(..) => Type::Null,
        U::Negation(..) | U::Plus(..) => {
            let negate = matches!(operator, U::Negation(..));
            match operand {
                Some(Type::LiteralInt(value)) if negate => Type::LiteralInt(value.wrapping_neg()),
                Some(Type::LiteralFloat(text)) if negate => Type::LiteralFloat(format!("-{text}")),
                Some(ty) if is_int(ty) || is_float(ty) => ty.clone(),
                _ => Type::union([Type::Int, Type::Float]),
            }
        }
        _ => return None,
    })
}
