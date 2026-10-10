using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace SS13.DM.Runtime
{
    public enum DMValueType
    {
        Null,
        Number,
        String,
        List,
        File,
        DatumRef,
        Path,
        Proc
    }

    /// <summary>
    /// A BYOND runtime error. Unwinds the whole DM call stack (the "thread")
    /// up to the scheduler root, matching BYOND, unless caught by try/catch.
    /// </summary>
    public sealed class DMRuntimeError : Exception
    {
        public DMRuntimeError(string message) : base(message) { }
    }

    /// <summary>
    /// A DM value. Semantics follow BYOND (cross-checked against OpenDream's
    /// DreamValue / DMOpcodeHandlers, MIT):
    ///   - numbers are 32-bit floats (every operation rounds to float);
    ///   - == is type-strict, text compares case-sensitively;
    ///   - only null, 0 and "" are false;
    ///   - lists and datums compare by reference; a deleted datum reads as null.
    /// </summary>
    public readonly struct DMValue : IEquatable<DMValue>
    {
        private readonly DMValueType _type;
        private readonly float _num;
        private readonly object? _ref;

        private DMValue(DMValueType type, float num, object? reference)
        {
            _type = type;
            _num = num;
            _ref = reference;
        }

        public DMValueType Type =>
            _type == DMValueType.DatumRef && (_ref == null || ((DMRuntime)_ref).Deleted) ? DMValueType.Null : _type;

        public bool IsNull => Type == DMValueType.Null;
        public float Float => _num;
        public double NumberValue => _num;
        public string StringValue => _type is DMValueType.String or DMValueType.Path ? (string)_ref! : "";
        public string FileValue => _type == DMValueType.File ? (string)_ref! : "";
        public DMList ListValue => (_type == DMValueType.List ? (DMList)_ref! : null)!;
        public object? DatumRef => Type == DMValueType.DatumRef ? _ref : null;

        public static DMValue Null => default;
        public static DMValue True => new(DMValueType.Number, 1, null);
        public static DMValue False => new(DMValueType.Number, 0, null);

        // The isFloat flag is accepted for source compatibility and ignored:
        // BYOND has no integer type (7 / 2 == 3.5).
        public static DMValue FromNumber(double val, bool isFloat = false) => new(DMValueType.Number, (float)val, null);
        public static DMValue FromBool(bool val) => new(DMValueType.Number, val ? 1 : 0, null);
        public static DMValue FromString(string? val) => new(DMValueType.String, 0, val ?? "");
        public static DMValue FromList(DMList? list) => list == null ? Null : new(DMValueType.List, 0, list);
        public static DMValue FromFile(string? path) => new(DMValueType.File, 0, path ?? "");
        public static DMValue FromPath(string? path) => new(DMValueType.Path, 0, DMTypes.NormalizePath(path ?? ""));
        public static DMValue FromDatum(DMRuntime? datum) => datum == null ? Null : new(DMValueType.DatumRef, 0, datum);
        public static DMValue FromProc(DMProcRef proc) => new(DMValueType.Proc, 0, proc);
        public static DMValue FromRef(object? obj) => obj switch
        {
            null => Null,
            DMRuntime d => FromDatum(d),
            DMList l => FromList(l),
            _ => throw new ArgumentException("Unsupported DM reference type " + obj.GetType())
        };

        public DMRuntime? AsDatum() => Type == DMValueType.DatumRef ? (DMRuntime)_ref! : null;
        public DMList? AsList() => _type == DMValueType.List ? (DMList)_ref! : null;
        public DMProcRef? AsProc() => _type == DMValueType.Proc ? (DMProcRef)_ref! : null;
        public bool IsText => _type == DMValueType.String;
        public bool IsNumber => _type == DMValueType.Number;

        public bool IsTrue() => Type switch
        {
            DMValueType.Null => false,
            DMValueType.Number => _num != 0,
            DMValueType.String => ((string)_ref!).Length != 0,
            _ => true
        };

        /// <summary>Numeric view; non-numbers read as 0 (BYOND's unchecked float coercion).</summary>
        public double ToNumber() => _type == DMValueType.Number ? _num : 0;

        public int ToInt() => _type == DMValueType.Number ? (int)_num : 0;

        /// <summary>DM text conversion, as performed by "[x]" embedding.</summary>
        public override string ToString() => Stringify();

        public string Stringify()
        {
            switch (Type)
            {
                case DMValueType.Null: return "";
                case DMValueType.Number: return FormatNumber(_num);
                case DMValueType.String:
                case DMValueType.Path:
                case DMValueType.File: return (string)_ref!;
                case DMValueType.List: return "/list";
                case DMValueType.DatumRef: return ((DMRuntime)_ref!).DisplayText();
                case DMValueType.Proc: return ((DMProcRef)_ref!).ToString();
                default: return "";
            }
        }

        /// <summary>Debug/probe rendering: lists show their contents, text is quoted inside lists.</summary>
        public string Repr()
        {
            switch (Type)
            {
                case DMValueType.Null: return "null";
                case DMValueType.List:
                {
                    var list = (DMList)_ref!;
                    var sb = new StringBuilder("list(");
                    for (var i = 1; i <= list.Count; i++)
                    {
                        if (i > 1) sb.Append(", ");
                        var key = list.Get(i);
                        sb.Append(key.Type == DMValueType.String ? "\"" + key.StringValue + "\"" : key.Repr());
                        if (list.TryGetAssocValue(key, out var assoc))
                            sb.Append(" = ").Append(assoc.Type == DMValueType.String ? "\"" + assoc.StringValue + "\"" : assoc.Repr());
                    }
                    return sb.Append(')').ToString();
                }
                default: return Stringify();
            }
        }

        public static string FormatNumber(float f)
        {
            if (float.IsPositiveInfinity(f)) return "inf";
            if (float.IsNegativeInfinity(f)) return "-inf";
            if (float.IsNaN(f)) return "nan";
            string s;
            if (f > 16777216f) s = f.ToString("g6", CultureInfo.InvariantCulture);
            else if (f >= 1000000 && (int)f == f) s = f.ToString("g8", CultureInfo.InvariantCulture);
            else s = f.ToString("g6", CultureInfo.InvariantCulture);
            return s.Replace("E", "e");
        }

        // ===== Equality =====

        public bool Equals(DMValue other)
        {
            var t = Type;
            if (t != other.Type) return false;
            return t switch
            {
                DMValueType.Null => true,
                DMValueType.Number => _num == other._num,
                DMValueType.String or DMValueType.Path or DMValueType.File => string.Equals((string)_ref!, (string)other._ref!, StringComparison.Ordinal),
                DMValueType.Proc => Equals(_ref, other._ref),
                _ => ReferenceEquals(_ref, other._ref)
            };
        }

        public override bool Equals(object? obj) => obj is DMValue v && Equals(v);

        public override int GetHashCode()
        {
            var t = Type;
            return t switch
            {
                DMValueType.Null => 0,
                DMValueType.Number => _num.GetHashCode(),
                DMValueType.String or DMValueType.Path or DMValueType.File => StringComparer.Ordinal.GetHashCode((string)_ref!) ^ (int)t,
                _ => System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(_ref!)
            };
        }

        public static bool operator ==(DMValue a, DMValue b) => a.Equals(b);
        public static bool operator !=(DMValue a, DMValue b) => !a.Equals(b);

        public static DMValue Equals(DMValue a, DMValue b) => FromBool(a.Equals(b));
        public static DMValue NotEquals(DMValue a, DMValue b) => FromBool(!a.Equals(b));

        /// <summary>DM ~= : lists compare element-wise (516 includes assoc values); datums may overload; else ==.</summary>
        public static bool IsEquivalent(DMValue a, DMValue b)
        {
            if (a.Type == DMValueType.List)
            {
                var la = a.ListValue;
                var lb = b.AsList();
                if (lb == null || la.Count != lb.Count) return false;
                for (var i = 1; i <= la.Count; i++)
                {
                    var ka = la.Get(i);
                    if (!ka.Equals(lb.Get(i))) return false;
                    var hasA = la.TryGetAssocValue(ka, out var va);
                    var hasB = lb.TryGetAssocValue(ka, out var vb);
                    if (hasA != hasB || (hasA && !va.Equals(vb))) return false;
                }
                return true;
            }
            return a.Equals(b);
        }

        public static DMValue Equivalent(DMValue a, DMValue b) => FromBool(IsEquivalent(a, b));
        public static DMValue NotEquivalent(DMValue a, DMValue b) => FromBool(!IsEquivalent(a, b));

        // ===== Arithmetic =====

        public static DMValue Add(DMValue a, DMValue b)
        {
            var ta = a.Type;
            if (ta == DMValueType.List) return FromList(a.ListValue.CopyWith(b));
            if (ta == DMValueType.Null) return b;
            var tb = b.Type;
            if (tb == DMValueType.Null && ta is DMValueType.Number or DMValueType.String) return a;
            if (ta == DMValueType.Number && tb == DMValueType.Number) return FromNumber(a._num + b._num);
            if (ta == DMValueType.String && tb == DMValueType.String) return FromString((string)a._ref! + (string)b._ref!);
            if (ta == DMValueType.DatumRef && a.AsDatum()!.TryOperator("operator+", out var r, b)) return r;
            throw Invalid("add", a, b);
        }

        public static DMValue Subtract(DMValue a, DMValue b)
        {
            var ta = a.Type;
            if (ta == DMValueType.List) return FromList(a.ListValue.CopyWithout(b));
            if ((ta is DMValueType.Number or DMValueType.Null) && (b.Type is DMValueType.Number or DMValueType.Null))
                return FromNumber(a._num - b._num);
            if (ta == DMValueType.DatumRef && a.AsDatum()!.TryOperator("operator-", out var r, b)) return r;
            throw Invalid("subtract", a, b);
        }

        public static DMValue Multiply(DMValue a, DMValue b)
        {
            var ta = a.Type;
            if (ta is DMValueType.Number or DMValueType.Null) return FromNumber(a._num * (float)b.ToNumber());
            if (ta == DMValueType.DatumRef && a.AsDatum()!.TryOperator("operator*", out var r, b)) return r;
            throw Invalid("multiply", a, b);
        }

        public static DMValue Divide(DMValue a, DMValue b)
        {
            var ta = a.Type;
            if (ta == DMValueType.Null) return FromNumber(0);
            if (ta == DMValueType.Number && b.Type == DMValueType.Number)
            {
                if (b._num == 0) throw new DMRuntimeError("Division by zero");
                return FromNumber(a._num / b._num);
            }
            if (ta == DMValueType.Number && b.Type == DMValueType.Null)
                throw new DMRuntimeError("Division by zero");
            if (ta == DMValueType.DatumRef && a.AsDatum()!.TryOperator("operator/", out var r, b)) return r;
            throw Invalid("divide", a, b);
        }

        public static DMValue Modulo(DMValue a, DMValue b)
        {
            if ((a.Type is DMValueType.Number or DMValueType.Null) && b.Type == DMValueType.Number)
            {
                var d = (int)b._num;
                if (d == 0) throw new DMRuntimeError("Division by zero");
                return FromNumber((int)a._num % d);
            }
            throw Invalid("modulus", a, b);
        }

        /// <summary>DM %% : B * fract(A / B) (sign follows the divisor).</summary>
        public static DMValue IntModulo(DMValue a, DMValue b)
        {
            if (a.Type == DMValueType.Number && b.Type == DMValueType.Number)
            {
                if (b._num == 0) throw new DMRuntimeError("Division by zero");
                var q = a._num / b._num;
                return FromNumber(b._num * (q - MathF.Floor(q)));
            }
            throw Invalid("%%", a, b);
        }

        public static DMValue Power(DMValue a, DMValue b)
        {
            if (!(a.Type is DMValueType.Number or DMValueType.Null)) throw Invalid("power", a, b);
            return FromNumber(MathF.Pow(a._num, (float)b.ToNumber()));
        }

        public static DMValue Negate(DMValue a) => FromNumber(-(float)a.ToNumber());

        // ===== Bitwise (BYOND: 24-bit integer semantics for ~) =====

        public static DMValue BitwiseAnd(DMValue a, DMValue b)
        {
            if (a.Type == DMValueType.List) return FromList(a.ListValue.Intersect(b));
            if (a.IsNull || b.IsNull) return FromNumber(0);
            if (a.Type == DMValueType.Number && b.Type == DMValueType.Number) return FromNumber((int)a._num & (int)b._num);
            throw Invalid("and", a, b);
        }

        public static DMValue BitwiseOr(DMValue a, DMValue b)
        {
            if (a.Type == DMValueType.List) return FromList(a.ListValue.Union(b));
            if (a.IsNull) return b;
            if (b.IsNull && a.Type == DMValueType.Number) return FromNumber((int)a._num);
            if (a.Type == DMValueType.Number && b.Type == DMValueType.Number) return FromNumber((int)a._num | (int)b._num);
            if (a.Type == DMValueType.DatumRef && a.AsDatum()!.TryOperator("operator|", out var r, b)) return r;
            throw Invalid("or", a, b);
        }

        public static DMValue BitwiseXor(DMValue a, DMValue b)
        {
            if (a.Type == DMValueType.List) return FromList(a.ListValue.SymmetricDifference(b));
            if (a.IsNull) return b.Type == DMValueType.Number ? b : FromNumber(0);
            if (b.IsNull && a.Type == DMValueType.Number) return a;
            if (a.Type == DMValueType.Number && b.Type == DMValueType.Number) return FromNumber((int)a._num ^ (int)b._num);
            throw Invalid("xor", a, b);
        }

        public static DMValue BitwiseNot(DMValue a) =>
            FromNumber(a.Type == DMValueType.Number ? (~(int)a._num) & 0xFFFFFF : 0xFFFFFF);

        public static DMValue ShiftLeft(DMValue a, DMValue b)
        {
            if (a.IsNull) return FromNumber(0);
            if (a.Type == DMValueType.Number && b.IsNull) return FromNumber((int)a._num);
            if (a.Type == DMValueType.Number && b.Type == DMValueType.Number) return FromNumber(Shift((int)a._num, (int)b._num));
            throw Invalid("shift left", a, b);
        }

        public static DMValue ShiftRight(DMValue a, DMValue b)
        {
            if (a.IsNull) return FromNumber(0);
            if (a.Type == DMValueType.Number && b.IsNull) return FromNumber((int)a._num);
            if (a.Type == DMValueType.Number && b.Type == DMValueType.Number) return FromNumber(Shift((int)a._num, -(int)b._num));
            throw Invalid("shift right", a, b);
        }

        private static int Shift(int value, int amount) =>
            amount >= 0 ? (amount >= 32 ? 0 : value << amount) : (-amount >= 32 ? 0 : value >> -amount);

        // ===== Comparison =====

        public static bool IsLess(DMValue a, DMValue b)
        {
            var ta = a.Type;
            var tb = b.Type;
            if (ta == DMValueType.Number && tb == DMValueType.Number) return a._num < b._num;
            if (ta == DMValueType.Number && tb == DMValueType.Null) return a._num < 0;
            if (ta == DMValueType.String && tb == DMValueType.String) return string.CompareOrdinal((string)a._ref!, (string)b._ref!) < 0;
            if (ta == DMValueType.Null)
            {
                if (tb == DMValueType.Number) return 0 < b._num;
                if (tb == DMValueType.String) return ((string)b._ref!).Length != 0;
                if (tb == DMValueType.Null) return false;
            }
            throw Invalid("less than comparison", a, b);
        }

        public static bool IsGreater(DMValue a, DMValue b)
        {
            var ta = a.Type;
            var tb = b.Type;
            if (ta == DMValueType.Number && tb == DMValueType.Number) return a._num > b._num;
            if (ta == DMValueType.Number && tb == DMValueType.Null) return a._num > 0;
            if (ta == DMValueType.String && tb == DMValueType.String) return string.CompareOrdinal((string)a._ref!, (string)b._ref!) > 0;
            if (ta == DMValueType.Null)
            {
                if (tb == DMValueType.Number) return 0 > b._num;
                if (tb is DMValueType.String or DMValueType.Null) return false;
            }
            throw Invalid("greater than comparison", a, b);
        }

        public static DMValue LessThan(DMValue a, DMValue b) => FromBool(IsLess(a, b));
        public static DMValue GreaterThan(DMValue a, DMValue b) => FromBool(IsGreater(a, b));
        public static DMValue LessOrEqual(DMValue a, DMValue b) => FromBool(a.Equals(b) || IsLess(a, b));
        public static DMValue GreaterOrEqual(DMValue a, DMValue b) => FromBool(a.Equals(b) || IsGreater(a, b));

        // ===== Logical / membership =====

        public static DMValue Not(DMValue a) => FromBool(!a.IsTrue());
        public static DMValue And(DMValue a, DMValue b) => FromBool(a.IsTrue() && b.IsTrue());
        public static DMValue Or(DMValue a, DMValue b) => FromBool(a.IsTrue() || b.IsTrue());

        /// <summary>DM `x in L`: membership in a list or an atom's contents; anything else is 0.</summary>
        public static DMValue InList(DMValue value, DMValue container)
        {
            var list = container.AsList() ?? container.AsDatum()?.ContentsList();
            return FromBool(list != null && list.Contains(value));
        }

        /// <summary>switch case `if (lo to hi)` and the `in lo to hi` form.</summary>
        public static DMValue InRange(DMValue value, DMValue lo, DMValue hi) =>
            FromBool((lo.Equals(value) || IsLess(lo, value)) && (value.Equals(hi) || IsLess(value, hi)));

        /// <summary>switch case match: plain == per candidate.</summary>
        public static DMValue In(DMValue value, params DMValue[] candidates)
        {
            if (candidates.Length == 1 && candidates[0].Type == DMValueType.List)
                return FromBool(candidates[0].ListValue.Contains(value));
            foreach (var c in candidates)
                if (value.Equals(c)) return True;
            return False;
        }

        public static DMValue Output(DMValue target, DMValue message)
        {
            DMRuntimeHelpers.OutputSink?.Invoke(target, message);
            return message;
        }

        public static implicit operator DMValue(double val) => FromNumber(val);
        public static implicit operator DMValue(string val) => FromString(val);
        public static implicit operator DMValue(bool val) => FromBool(val);

        private static DMRuntimeError Invalid(string op, DMValue a, DMValue b) =>
            new($"Invalid {op} operation on {a.Repr()} and {b.Repr()}");

        // ===== Text =====

        public static int CpLength(string s)
        {
            var n = 0;
            for (var i = 0; i < s.Length; i += char.IsSurrogatePair(s, i) ? 2 : 1) n++;
            return n;
        }

        public static int CpIndexToChar(string s, int cpIndex)
        {
            var cps = 0;
            var i = 0;
            while (i < s.Length && cps < cpIndex - 1)
            {
                i += char.IsSurrogatePair(s, i) ? 2 : 1;
                cps++;
            }
            return i;
        }
    }

    /// <summary>"[a] text [b]" — each embedded expression is converted with DM text rules.</summary>
    public static class DMText
    {
        public static DMValue Interp(params DMValue[] parts)
        {
            var sb = new StringBuilder();
            foreach (var p in parts) sb.Append(p.Stringify());
            return DMValue.FromString(sb.ToString());
        }
    }
}
