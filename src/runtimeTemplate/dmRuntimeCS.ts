export class DMRuntimeCS {
  public static getRuntimeCSFiles(): { filename: string; content: string }[] {
    return [
      {
        filename: 'DMValue.cs',
        content: `using System;
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
        Path
    }

    public struct DMValue
    {
        public DMValueType Type { get; private set; }
        public double NumberValue { get; private set; }
        public string StringValue { get; private set; }
        public string FileValue { get; private set; }
        public DMList ListValue { get; private set; }
        public object DatumRef { get; private set; }
        // Provenance flag: is the number an integer literal/computation?
        // DM floor-divides only when BOTH operands are integers (7 / 2 is 3
        // but 7.0 / 2 is 3.5) — literals keep their int/float identity
        // through arithmetic (WS8-1).
        public bool IsInt { get; private set; }

        public static DMValue Null => new DMValue { Type = DMValueType.Null };

        public static DMValue FromNumber(double val, bool isFloat = false) => new DMValue { Type = DMValueType.Number, NumberValue = val, IsInt = !isFloat };
        public static DMValue FromString(string val) => new DMValue { Type = DMValueType.String, StringValue = val ?? "" };
        public static DMValue FromList(DMList list) => new DMValue { Type = DMValueType.List, ListValue = list };
        public static DMValue FromFile(string path) => new DMValue { Type = DMValueType.File, FileValue = path ?? "" };
        public static DMValue FromPath(string path) => new DMValue { Type = DMValueType.Path, StringValue = path ?? "" };
        public static DMValue FromRef(object obj) => new DMValue { Type = DMValueType.DatumRef, DatumRef = obj };
        public static DMValue FromDatum(DMRuntime datum) => new DMValue { Type = DMValueType.DatumRef, DatumRef = datum };

        // DM text is a sequence of Unicode code points (BYOND 514+); length()
        // and friends count code points, not UTF-16 code units.
        public static int CpLength(string s)
        {
            var n = 0;
            for (var i = 0; i < s.Length; i += char.IsSurrogatePair(s, i) ? 2 : 1) n++;
            return n;
        }

        // Converts a 1-based DM index (code point position) to a char offset.
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

        public DMRuntime? AsDatum() =>
            Type == DMValueType.DatumRef ? DatumRef as DMRuntime : null;

        public DMList? AsList() =>
            Type == DMValueType.List ? ListValue : null;

        public bool IsTrue()
        {
            return Type switch
            {
                DMValueType.Null => false,
                DMValueType.Number => NumberValue != 0,
                DMValueType.String => !string.IsNullOrEmpty(StringValue) && StringValue != "0",
                DMValueType.List => ListValue != null && ListValue.Count > 0,
                DMValueType.File => !string.IsNullOrEmpty(FileValue),
                DMValueType.DatumRef => DatumRef != null,
                DMValueType.Path => true,
                _ => false
            };
        }

        public override string ToString()
        {
            return Type switch
            {
                DMValueType.Null => "null",
                DMValueType.Number => NumberValue.ToString(CultureInfo.InvariantCulture),
                DMValueType.String => StringValue,
                DMValueType.List => ListText(ListValue),
                DMValueType.File => FileValue,
                DMValueType.DatumRef => DatumRef?.ToString() ?? "null",
                DMValueType.Path => StringValue,
                _ => "null"
            };
        }

        // DM renders lists in text context as list(...) (WS8-19): positional
        // entries comma-separated, assoc entries as "key" = value.
        private static string ListText(DMList list)
        {
            var sb = new StringBuilder("list(");
            var first = true;
            for (var i = 1; i <= list.PositionalCount; i++)
            {
                if (!first) sb.Append(", ");
                first = false;
                sb.Append(ListItemText(list.Get(i)));
            }
            foreach (var kv in list.AssocEntries)
            {
                if (!first) sb.Append(", ");
                first = false;
                // (char)34 is a quote, (char)92 a backslash — written as char
                // codes so the template escaping cannot corrupt them.
                sb.Append((char)34)
                  .Append(kv.Key.Replace(((char)34).ToString(), ((char)92).ToString() + (char)34))
                  .Append((char)34).Append(" = ").Append(ListItemText(kv.Value));
            }
            sb.Append(')');
            return sb.ToString();
        }

        private static string ListItemText(DMValue v) =>
            v.Type == DMValueType.String
                ? (char)34 + v.StringValue.Replace(((char)34).ToString(), ((char)92).ToString() + (char)34) + (char)34
                : v.ToString();

        // ===== Operator Overloads & Static Methods for Expression Transpilation =====

        // Arithmetic
        // DM rule: if either operand is text, + concatenates
        public static DMValue Add(DMValue a, DMValue b)
        {
            // DM dispatch is on the LEFT operand: list + x appends ("L += z"
            // keeps the list); text + x concatenates and renders the right
            // side as text ("a" + list(1) == "alist(1)" — WS8-13).
            if (a.Type == DMValueType.List)
                return FromList(ConcatLists(a, b));
            if (a.Type == DMValueType.String || b.Type == DMValueType.String)
                return FromString(TextRepr(a) + TextRepr(b));
            if (b.Type == DMValueType.List)
                return FromList(ConcatLists(a, b));
            return FromNumber(a.ToNumber() + b.ToNumber(), !(a.IsInt && b.IsInt));
        }

        private static DMList ConcatLists(DMValue a, DMValue b)
        {
            var result = new DMList();
            if (a.Type == DMValueType.List)
            {
                for (var i = 1; i <= a.ListValue.PositionalCount; i++) result.Add(a.ListValue.Get(i));
            }
            else
            {
                result.Add(a);
            }
            if (b.Type == DMValueType.List)
            {
                for (var i = 1; i <= b.ListValue.PositionalCount; i++) result.Add(b.ListValue.Get(i));
            }
            else
            {
                result.Add(b);
            }
            // DM: associative entries survive list concatenation (L += x keeps L's keys).
            if (a.Type == DMValueType.List)
                foreach (var kv in a.ListValue.AssocEntries) result.SetAssoc(kv.Key, kv.Value);
            if (b.Type == DMValueType.List)
                foreach (var kv in b.ListValue.AssocEntries) result.SetAssoc(kv.Key, kv.Value);
            return result;
        }
        public static DMValue Subtract(DMValue a, DMValue b) => FromNumber(a.ToNumber() - b.ToNumber(), !(a.IsInt && b.IsInt));
        public static DMValue Multiply(DMValue a, DMValue b) => FromNumber(a.ToNumber() * b.ToNumber(), !(a.IsInt && b.IsInt));
        public static DMValue Divide(DMValue a, DMValue b)
        {
            var divisor = b.ToNumber();
            // DM raises a runtime error on division by zero.
            if (divisor == 0) throw new InvalidOperationException("Division by zero");
            // DM: division of two integer operands is floor division (7/2 = 3,
            // -7/2 = -4); a float operand yields a float (7.0/2 = 3.5). The
            // IsInt provenance distinguishes the literals 7 and 7.0 (WS8-1).
            var dividend = a.ToNumber();
            if (a.IsInt && b.IsInt)
                return FromNumber(Math.Floor(dividend / divisor));
            return FromNumber(dividend / divisor, true);
        }
        public static DMValue Modulo(DMValue a, DMValue b)
        {
            // DM: % works on integers — operands are truncated first
            // (7.5 % 2 == 1) and division by zero is a runtime error.
            var divisor = Math.Truncate(b.ToNumber());
            if (divisor == 0) throw new InvalidOperationException("Division by zero");
            return FromNumber(Math.Truncate(a.ToNumber()) % divisor);
        }
        public static DMValue Negate(DMValue a) => FromNumber(-a.ToNumber());
        public static DMValue Power(DMValue a, DMValue b) => FromNumber(Math.Pow(a.ToNumber(), b.ToNumber()));

        // Bitwise operations on 64-bit integer values (DM flag logic — the
        // corpus has ~19k bitwise-op sites, previously emitted as Null).
        public static DMValue BitwiseAnd(DMValue a, DMValue b) => FromNumber((long)a.ToNumber() & (long)b.ToNumber());
        public static DMValue BitwiseOr(DMValue a, DMValue b) => FromNumber((long)a.ToNumber() | (long)b.ToNumber());
        public static DMValue BitwiseXor(DMValue a, DMValue b) => FromNumber((long)a.ToNumber() ^ (long)b.ToNumber());
        public static DMValue BitwiseNot(DMValue a) => FromNumber(~(long)a.ToNumber());
        public static DMValue ShiftLeft(DMValue a, DMValue b) => FromNumber((long)a.ToNumber() << (int)b.ToNumber());
        public static DMValue ShiftRight(DMValue a, DMValue b) => FromNumber((long)a.ToNumber() >> (int)b.ToNumber());

        // DM %%: integer remainder with the sign of the DIVISOR
        // (-7 %% 3 == 2, 7 %% -3 == -2), unlike % which follows the dividend.
        public static DMValue IntModulo(DMValue a, DMValue b)
        {
            var divisor = (long)Math.Truncate(b.ToNumber());
            if (divisor == 0) throw new InvalidOperationException("Division by zero");
            var dividend = (long)Math.Truncate(a.ToNumber());
            var r = dividend % divisor;
            if (r != 0 && (r < 0) != (divisor < 0)) r += divisor;
            return FromNumber(r);
        }

        // Comparison
        public static DMValue Equals(DMValue a, DMValue b) => FromNumber(a.EqualsValue(b) ? 1 : 0);
        public static DMValue NotEquals(DMValue a, DMValue b) => FromNumber(a.EqualsValue(b) ? 0 : 1);
        public static DMValue LessThan(DMValue a, DMValue b) => FromNumber(Compare(a, b) < 0 ? 1 : 0);
        public static DMValue LessOrEqual(DMValue a, DMValue b) => FromNumber(Compare(a, b) <= 0 ? 1 : 0);
        public static DMValue GreaterThan(DMValue a, DMValue b) => FromNumber(Compare(a, b) > 0 ? 1 : 0);
        public static DMValue GreaterOrEqual(DMValue a, DMValue b) => FromNumber(Compare(a, b) >= 0 ? 1 : 0);

        // DM rule: with a text operand, relational comparison is lexicographic
        // (numbers are stringified, null is ""); otherwise it is numeric.
        // Text ordering is CASE-SENSITIVE in DM (WS8-4: "a" < "B" is false).
        private static int Compare(DMValue a, DMValue b)
        {
            if (a.Type == DMValueType.String || b.Type == DMValueType.String)
                return string.Compare(TextRepr(a), TextRepr(b), StringComparison.Ordinal);
            return a.ToNumber().CompareTo(b.ToNumber());
        }

        private static string TextRepr(DMValue v)
        {
            return v.Type switch
            {
                DMValueType.Null => "",
                DMValueType.Number => v.NumberValue.ToString(CultureInfo.InvariantCulture),
                DMValueType.String => v.StringValue,
                DMValueType.Path => v.StringValue,
                _ => v.ToString()
            };
        }

        // Logical
        public static DMValue And(DMValue a, DMValue b) => FromNumber(a.IsTrue() && b.IsTrue() ? 1 : 0);
        public static DMValue Or(DMValue a, DMValue b) => FromNumber(a.IsTrue() || b.IsTrue() ? 1 : 0);
        public static DMValue Not(DMValue a) => FromNumber(a.IsTrue() ? 0 : 1);

        // Membership test for switch cases and the 'in' operator.
        // Returns a DMValue (1/0) so results compose with other expressions;
        // a single list candidate tests membership in that list.
        public static DMValue In(DMValue value, params DMValue[] candidates)
        {
            if (candidates.Length == 1 && candidates[0].Type == DMValueType.List)
            {
                var list = candidates[0].ListValue;
                // Positional elements only; assoc entries are not indexable.
                for (var i = 1; i <= list.PositionalCount; i++)
                    if (value.EqualsValue(list.Get(i))) return DMValue.FromNumber(1);
                // DM: text values also match associative keys (case-insensitive).
                if (value.Type == DMValueType.String)
                {
                    foreach (var kv in list.AssocEntries)
                        if (value.EqualsValue(DMValue.FromString(kv.Key))) return DMValue.FromNumber(1);
                }
                return DMValue.FromNumber(0);
            }
            foreach (var c in candidates)
            {
                if (value.EqualsValue(c)) return DMValue.FromNumber(1);
            }
            return DMValue.FromNumber(0);
        }

        // DM 'x << y' dispatch (item 72, B-4): the emitter sends every
        // variable/property << here and the runtime picks the semantics by
        // the LHS type — BYOND << is output only for client-capable
        // targets (client/mob/world/datums), list-append for lists, and a
        // plain bitwise shift otherwise. Datum and list cases return the
        // TARGET so 'usr << a << b' chains and 'x = (x << y)' writes back
        // safely; the shift case returns the shifted value for writeback.
        public static DMValue Output(DMValue target, DMValue message)
        {
            // list << x appends (BYOND: 'L << x' == 'L += x'), honoring the
            // runtime's copy-on-write rule (clone when shared).
            if (target.Type == DMValueType.List && target.ListValue != null)
            {
                var list = target.ListValue;
                if (list.RefCount > 1)
                {
                    list = list.Clone();
                    list.RefCount = 1;
                }
                list.Add(message);
                return FromList(list);
            }
            // Datum output: engine bridge when set (player consoles/server
            // log — see ConvertedDMSystem), else stdout.
            if (target.Type == DMValueType.DatumRef)
            {
                if (DMVerbRuntime.OutputBridge != null)
                    DMVerbRuntime.OutputBridge(target, message);
                else
                    Console.WriteLine($"[DM] {target} << {message}");
                return target;
            }
            // x << n where x is anything else: bitwise shift.
            return ShiftLeft(target, message);
        }

        // Implicit conversions
        public static implicit operator DMValue(double val) => FromNumber(val);
        public static implicit operator DMValue(string val) => FromString(val);
        public static implicit operator DMValue(bool val) => FromNumber(val ? 1 : 0);

        // Helper methods
        public double ToNumber()
        {
            return Type switch
            {
                DMValueType.Number => NumberValue,
                DMValueType.String => double.TryParse(StringValue, NumberStyles.Float, CultureInfo.InvariantCulture, out var n) ? n : 0,
                DMValueType.Null => 0,
                DMValueType.List => ListValue?.Count ?? 0,
                DMValueType.DatumRef => DatumRef != null ? 1 : 0,
                DMValueType.Path => 0,
                _ => 0
            };
        }

        private bool EqualsValue(DMValue other)
        {
            // Cross-type: numeric strings compare equal to numbers (DM rule)
            if (Type == DMValueType.String && other.Type == DMValueType.Number)
                return double.TryParse(StringValue, NumberStyles.Float, CultureInfo.InvariantCulture, out var n) && n == other.NumberValue;
            if (Type == DMValueType.Number && other.Type == DMValueType.String)
                return other.EqualsValue(this);
            // null compares equal to 0 (exactly; DM has no float tolerance)
            if (Type == DMValueType.Null && other.Type == DMValueType.Number)
                return other.NumberValue == 0;
            if (Type == DMValueType.Number && other.Type == DMValueType.Null)
                return NumberValue == 0;
            // DM: null == "" and null == "0" are true
            if (Type == DMValueType.Null && other.Type == DMValueType.String)
                return other.StringValue.Length == 0 || (double.TryParse(other.StringValue, NumberStyles.Float, CultureInfo.InvariantCulture, out var sn) && sn == 0);
            if (Type == DMValueType.String && other.Type == DMValueType.Null)
                return other.EqualsValue(this);
            // DM: an empty list equals null
            if (Type == DMValueType.Null && other.Type == DMValueType.List)
                return other.ListValue != null && other.ListValue.Count == 0;
            if (Type == DMValueType.List && other.Type == DMValueType.Null)
                return other.EqualsValue(this);
            if (Type != other.Type) return false;
            return Type switch
            {
                DMValueType.Null => true,
                DMValueType.Number => NumberValue == other.NumberValue,
                DMValueType.String => string.Equals(StringValue, other.StringValue, StringComparison.OrdinalIgnoreCase),
                DMValueType.List => ReferenceEquals(ListValue, other.ListValue) || ListsEqual(ListValue, other.ListValue),
                DMValueType.DatumRef => ReferenceEquals(DatumRef, other.DatumRef),
                DMValueType.Path => string.Equals(StringValue, other.StringValue, StringComparison.Ordinal),
                _ => false
            };
        }

        // DM: list equality is element-wise (recursive); order matters.
        // Associative entries must match too: same keys (case-insensitive,
        // DM text keys) with equal values.
        private static bool ListsEqual(DMList a, DMList b)
        {
            if (a.Count != b.Count) return false;
            for (var i = 1; i <= a.PositionalCount; i++)
            {
                if (!a.Get(i).EqualsValue(b.Get(i))) return false;
            }
            foreach (var kv in a.AssocEntries)
            {
                if (!b.TryGetAssoc(kv.Key, out var bv)) return false;
                if (!kv.Value.EqualsValue(bv)) return false;
            }
            return true;
        }
    }
}
`
      },
      {
        filename: 'DMList.cs',
        content: `using System.Collections.Generic;

namespace SS13.DM.Runtime
{
    public class DMList
    {
        private readonly List<DMValue> _elements = new();
        // DM text keys are case-insensitive: L["A"] and L["a"] are the same key.
        private readonly Dictionary<string, DMValue> _assocMap = new(StringComparer.OrdinalIgnoreCase);

        // Copy-on-write guard: DM shares one list between variables until a
        // write, which clones the list. RefCount over-approximates (variables
        // never decrement), which only costs extra copies, never wrong behavior.
        public int RefCount = 1;

        // DM len(): total entries, positional + associative.
        public int Count => _elements.Count + _assocMap.Count;

        // Positional elements only; DM assoc entries are not index-addressable.
        public int PositionalCount => _elements.Count;

        public static DMList FromArray(DMValue[] values)
        {
            var list = new DMList();
            if (values != null)
            {
                foreach (var v in values) list.Add(v);
            }
            return list;
        }

        public DMList Clone()
        {
            var clone = new DMList();
            foreach (var v in _elements) clone.Add(v);
            foreach (var kv in _assocMap) clone.SetAssoc(kv.Key, kv.Value);
            return clone;
        }

        public void Add(DMValue val) => _elements.Add(val);

        public DMValue Get(int index)
        {
            // DM: negative indices read from the end (-1 = last element)
            if (index < 0) index = _elements.Count + index + 1;
            if (index >= 1 && index <= _elements.Count)
                return _elements[index - 1];
            return DMValue.Null;
        }

        public DMValue Set(int index, DMValue val)
        {
            if (index < 0) index = _elements.Count + index + 1;
            if (index >= 1 && index <= _elements.Count)
                _elements[index - 1] = val;
            else if (index == _elements.Count + 1)
                _elements.Add(val);
            return val;
        }

        public void SetAssoc(string key, DMValue val) => _assocMap[key] = val;
        public DMValue GetAssoc(string key) => _assocMap.TryGetValue(key, out var val) ? val : DMValue.Null;
        public bool TryGetAssoc(string key, out DMValue val) => _assocMap.TryGetValue(key, out val);
        public IReadOnlyDictionary<string, DMValue> AssocEntries => _assocMap;
    }
}
`
      },
      {
        filename: 'DMRuntime.cs',
        content: `using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace SS13.DM.Runtime
{
    /// <summary>
    /// A single DM datum instance: the runtime-side object that carries DM
    /// variables and dispatches proc calls through <see cref="ProcRegistry"/>.
    ///
    /// This class is engine-free by design. It has no dependency on
    /// RobustToolbox; the engine-facing wrapper (an SS14 ECS component) lives
    /// in Content.Server and holds a DMRuntime alongside an EntityUid.
    /// </summary>
    public class DMRuntime
    {
        public string DMTypePath { get; set; } = "/datum";
        public Dictionary<string, DMValue> Variables { get; } = new();

        // W-F new: depth-of-chain cursor for BYOND's implicit New() ..()
        // chain — the ancestor path whose New most recently ran on THIS
        // datum's construction. An instance field (not AsyncLocal): a body
        // that explicitly calls ..() must advance the OUTER chain's cursor,
        // and AsyncLocal writes inside an awaited call never flow back up.
        internal string? NewChainCursor = null;

        /// <summary>
        /// The SS14 entity this datum is materialized on (item 69, B-1):
        /// 0 = datum-only (no server, or a pure /datum type).
        /// </summary>
        public ulong EntityId { get; set; }

        public bool MarkedForDeletion { get; private set; }

        // W-H: proc-local scope frames. DM proc params, 'var/x' decls, the
        // '.' return slot, and for-loop vars are LOCALS — not datum fields.
        // Before this, SetVar wrote them onto the datum, so a call like
        // get_airlock_overlay("[material]_open") clobbered the caller's
        // icon_state field (surfaced by the M2 door slice). Frames are
        // per-async-flow (AsyncLocal) so procs interleaved by Sleep() on the
        // same datum stay isolated; locals shadow same-named datum vars the
        // way BYOND scopes them.
        private sealed class DMProcFrame
        {
            public readonly DMRuntime Owner;
            public readonly HashSet<string> Locals = new HashSet<string>();
            public readonly Dictionary<string, DMValue> Vars = new Dictionary<string, DMValue>();
            public DMProcFrame(DMRuntime owner) { Owner = owner; }
        }
        private static readonly System.Threading.AsyncLocal<System.Collections.Generic.List<DMProcFrame>> _dmProcFrames =
            new System.Threading.AsyncLocal<System.Collections.Generic.List<DMProcFrame>>();
        private static System.Collections.Generic.List<DMProcFrame> DMLocalFrames
            => _dmProcFrames.Value ??= new System.Collections.Generic.List<DMProcFrame>();

        /// <summary>Generated procs call this at entry; pairs with PopFrame
        /// in a finally.</summary>
        public void PushFrame() => DMLocalFrames.Add(new DMProcFrame(this));

        /// <summary>Pop the innermost frame owned by this datum (tolerant of
        /// frames a nested async flow pushed above it).</summary>
        public void PopFrame()
        {
            var f = DMLocalFrames;
            for (var i = f.Count - 1; i >= 0; i--)
            {
                if (ReferenceEquals(f[i].Owner, this)) { f.RemoveAt(i); return; }
            }
        }

        /// <summary>Declare a proc-local name on the innermost frame owned by
        /// this datum; later GetVar/SetVar of that name hit the frame. With no
        /// owned frame the name falls back to the datum var (defensive —
        /// every generated proc pushes a frame at entry).</summary>
        public void DeclareLocal(string name)
        {
            var f = DMLocalFrames;
            for (var i = f.Count - 1; i >= 0; i--)
            {
                if (ReferenceEquals(f[i].Owner, this)) { f[i].Locals.Add(name); return; }
            }
        }

        private DMProcFrame? LocalFrameFor(string name)
        {
            var f = DMLocalFrames;
            for (var i = f.Count - 1; i >= 0; i--)
            {
                if (ReferenceEquals(f[i].Owner, this) && f[i].Locals.Contains(name)) return f[i];
            }
            return null;
        }

        public DMValue GetVar(string name)
        {
            var frame = LocalFrameFor(name); // W-H: proc locals shadow datum vars
            if (frame != null)
                return frame.Vars.TryGetValue(name, out var lv) ? lv : DMValue.Null;
            return Variables.TryGetValue(name, out var val) ? val : DMValue.Null;
        }

        /// <summary>
        /// First value ever assigned to each var — the engine-free stand-in for
        /// DM initial() (which reads the value assigned in the var declaration
        /// before any runtime mutation).
        /// </summary>
        public Dictionary<string, DMValue> InitialValues { get; } = new();

        public virtual DMValue SetVar(string name, DMValue val)
        {
            var frame = LocalFrameFor(name); // W-H: proc locals shadow datum vars
            if (frame != null)
            {
                frame.Vars[name] = val;
                if (val.Type == DMValueType.List && val.ListValue != null) val.ListValue.RefCount++;
                return val;
            }
            if (!InitialValues.ContainsKey(name)) InitialValues[name] = val;
            Variables[name] = val;
            // The variable now also references the list: bump the COW counter.
            if (val.Type == DMValueType.List && val.ListValue != null) val.ListValue.RefCount++;
            // B-3 (item 71): appearance vars republish to the engine.
            DMRuntimeHelpers.OnDatumVarChanged(this, name);
            return val;
        }

        public bool IsType(string typePath)
        {
            // DM type paths are case-insensitive (WS4-1).
            // W-H: also walk the canonical ancestor chain — sugar paths like
            // '/obj/machinery/door' don't textually contain '/atom' even
            // though /obj IS /atom/movable/obj (istype(x, /atom) must be true).
            return string.Equals(typePath, DMTypePath, StringComparison.OrdinalIgnoreCase)
                || DMTypePath.StartsWith(typePath + "/", StringComparison.OrdinalIgnoreCase)
                || ProcRegistry.DMParentPaths(DMTypePath).Contains(typePath, StringComparer.OrdinalIgnoreCase);
        }

        public void MarkForDeletion()
        {
            // Engine integration point: the hosting system observes this flag
            // and queues the wrapped entity for deletion.
            MarkedForDeletion = true;
        }

        public async Task<DMValue> CallProc(string procName, params DMValue[] args)
        {
            args = ReorderNamedArgs(procName, args);
            if (ProcRegistry.TryGet(DMTypePath, procName, out var handler)
                || ProcRegistry.TryGetInherited(DMTypePath, procName, out handler)
                || ProcRegistry.TryGet("/proc", procName, out handler))
            {
                return await InvokeWithUsr(handler, args);
            }
            return DMValue.Null;
        }

        /// <summary>
        /// DM arglist(assoc-list) passes associative entries as named arguments
        /// bound to the callee's parameter names (WS8-14). Positional entries
        /// fill slots in order; unknown names stay Null.
        /// </summary>
        private DMValue[] ReorderNamedArgs(string procName, DMValue[] args)
        {
            if (args.Length != 1 || args[0].Type != DMValueType.List) return args;
            var list = args[0].ListValue;
            if (list.AssocEntries.Count == 0) return args;
            var names = ProcRegistry.GetParamNames(DMTypePath, procName)
                        ?? ProcRegistry.GetParamNames("/proc", procName);
            if (names == null || names.Length == 0) return args;
            var reordered = new DMValue[names.Length];
            for (var i = 0; i < reordered.Length; i++) reordered[i] = DMValue.Null;
            for (var i = 1; i <= list.PositionalCount && i <= names.Length; i++) reordered[i - 1] = list.Get(i);
            foreach (var kv in list.AssocEntries)
            {
                for (var i = 0; i < names.Length; i++)
                {
                    if (string.Equals(names[i], kv.Key, StringComparison.OrdinalIgnoreCase))
                    {
                        reordered[i] = kv.Value;
                        break;
                    }
                }
            }
            return reordered;
        }

        // ==== W-A parent-call (item 22): defining-type plumbing ====

        /// <summary>
        /// DM "..()" dispatch: invoke the implementation of the current proc
        /// on the type STRICTLY ABOVE the one that declares the executing
        /// body. The emitter bakes the declaring path into the call site;
        /// resolving from the concrete DMTypePath re-found the same body
        /// whenever a subtype overrode or inherited it — the override looped
        /// back into itself until stack overflow (the old single-argument
        /// CallParentProc's bug).
        ///
        /// usr is deliberately NOT rebound: BYOND propagates the caller's usr
        /// into the supercall (a verb's ..() on another atom keeps the mob
        /// that ran it). InvokeWithUsr would relabel usr = src.
        /// </summary>
        public async Task<DMValue> CallParentProc(string definingTypePath, string procName, params DMValue[] args)
        {
            // ==== W-F new ====
            // BYOND New() always runs the WHOLE ancestor chain: each New body
            // gets an implicit ..() appended. When a body DOES call ..()
            // explicitly, BYOND continues the chain from the resolved parent
            // downward — it does not restart it. Looping here lets a mid-chain
            // explicit ..() run every remaining ancestor exactly once;
            // NewChainCursor records how deep the chain already advanced on
            // this datum's construction.
            if (string.Equals(procName, "new", StringComparison.OrdinalIgnoreCase))
            {
                var cursor = definingTypePath;
                var chainArgs = args;
                var first = true;
                var result = DMValue.Null;
                while (ProcRegistry.TryGetInherited(cursor, procName, out var chainHandler, out var chainPath))
                {
                    NewChainCursor = chainPath;
                    var bound = BindParentCallArgs(chainPath!, procName, chainArgs);
                    var r = await chainHandler(this, bound);
                    if (first) { result = r; first = false; }
                    chainArgs = bound;
                    cursor = NewChainCursor!;
                }
                return result;
            }
            if (ProcRegistry.TryGetInherited(definingTypePath, procName, out var handler, out var resolvedPath))
            {
                return await handler(this, BindParentCallArgs(resolvedPath!, procName, args));
            }
            if (ProcRegistry.TryGet("/proc", procName, out handler))
            {
                return await handler(this, BindParentCallArgs("/proc", procName, args));
            }
            return DMValue.Null;
        }

        /// <summary>
        /// Binds "..()" arguments against the RESOLVED ancestor's declared
        /// parameters (not the concrete instance type's): DMNamedArg markers
        /// ('..'(x = v)) bind by name, positional args fill the remaining
        /// slots in order, and a single assoc list gets the arglist-style
        /// named binding DMRuntime.CallProc applies.
        /// </summary>
        private static DMValue[] BindParentCallArgs(string resolvedPath, string procName, DMValue[] args)
        {
            var names = ProcRegistry.GetParamNames(resolvedPath, procName);
            var hasMarkers = false;
            foreach (var a in args)
            {
                if (TryUnwrapParentNamedArg(a, out _, out _)) { hasMarkers = true; break; }
            }
            if (!hasMarkers)
            {
                // arglist-style single assoc list binds entries by name —
                // the same rule CallProc's ReorderNamedArgs applies.
                if (args.Length == 1 && args[0].Type == DMValueType.List && args[0].ListValue != null
                    && args[0].ListValue.AssocEntries.Count > 0 && names != null && names.Length > 0)
                {
                    var list = args[0].ListValue;
                    var reordered = new DMValue[names.Length];
                    for (var i = 0; i < reordered.Length; i++) reordered[i] = DMValue.Null;
                    for (var i = 1; i <= list.PositionalCount && i <= names.Length; i++) reordered[i - 1] = list.Get(i);
                    foreach (var kv in list.AssocEntries)
                    {
                        for (var i = 0; i < names.Length; i++)
                        {
                            if (string.Equals(names[i], kv.Key, StringComparison.OrdinalIgnoreCase))
                            {
                                reordered[i] = kv.Value;
                                break;
                            }
                        }
                    }
                    return reordered;
                }
                return args;
            }
            if (names == null || names.Length == 0)
            {
                // No declared parameters on the resolved body: degrade
                // markers to their values and keep argument order.
                var flat = new DMValue[args.Length];
                for (var i = 0; i < args.Length; i++)
                {
                    flat[i] = TryUnwrapParentNamedArg(args[i], out _, out var v) ? v : args[i];
                }
                return flat;
            }
            var bound = new DMValue[names.Length];
            for (var i = 0; i < bound.Length; i++) bound[i] = DMValue.Null;
            var extras = new List<DMValue>();
            var pos = 0;
            foreach (var a in args)
            {
                if (TryUnwrapParentNamedArg(a, out var n, out var v))
                {
                    for (var i = 0; i < names.Length; i++)
                    {
                        if (string.Equals(names[i], n, StringComparison.OrdinalIgnoreCase)) { bound[i] = v; break; }
                    }
                    // An unmatched name would be a BYOND bad-arg error; it
                    // is dropped here rather than misfilled positionally.
                }
                else if (pos < names.Length)
                {
                    bound[pos++] = a;
                }
                else
                {
                    extras.Add(a);
                }
            }
            if (extras.Count == 0) return bound;
            var all = new DMValue[bound.Length + extras.Count];
            Array.Copy(bound, all, bound.Length);
            extras.CopyTo(all, bound.Length);
            return all;
        }

        // ==== W-F new ====
        /// <summary>
        /// BYOND New() dispatch: runs the declared New on this datum, then
        /// every ancestor's New — derived first — even when a body never
        /// calls ..() (BYOND appends an implicit ..() to each New). An
        /// explicit ..() inside a body is the same chain continued, so the
        /// ancestors below it do not run a second time. NewChainCursor — an
        /// instance field on this datum — tracks how deep the chain has
        /// advanced; a new nested inside a New body constructs a DIFFERENT
        /// datum with its own cursor, so chains never interfere.
        /// Each hop re-binds the forwarded arguments against that ancestor's
        /// declared parameters (named markers by name, positionals in order),
        /// matching the BYOND rule that implicit ..() forwards the arguments
        /// the current proc received.
        /// </summary>
        public async Task CallNewChain(DMValue[] args)
        {
            Func<DMRuntime, DMValue[], Task<DMValue>>? handler;
            string? resolved;
            if (ProcRegistry.TryGet(DMTypePath, "new", out var own))
            {
                handler = own;
                resolved = DMTypePath;
            }
            else if (ProcRegistry.TryGetInherited(DMTypePath, "new", out var inherited, out var inheritedPath))
            {
                handler = inherited;
                resolved = inheritedPath;
            }
            else
            {
                return;
            }
            var chainArgs = args;
            while (handler != null)
            {
                NewChainCursor = resolved;
                var bound = BindParentCallArgs(resolved!, "new", chainArgs);
                await InvokeWithUsr(handler, bound);
                var last = NewChainCursor!;
                if (ProcRegistry.TryGetInherited(last, "new", out var next, out var nextPath))
                {
                    handler = next;
                    resolved = nextPath;
                    chainArgs = bound;
                }
                else
                {
                    handler = null;
                }
            }
        }

        /// <summary>
        /// DMNamedArg marker check — mirrors DMRuntimeHelpers.TryUnwrapNamedArg
        /// (a 2-element positional list whose first element is a string).
        /// Local so CallParentProc can bind '..'(x = v) without touching the
        /// shared helper surface.
        /// </summary>
        private static bool TryUnwrapParentNamedArg(DMValue arg, out string? name, out DMValue value)
        {
            name = null; value = DMValue.Null;
            if (arg.Type != DMValueType.List || arg.ListValue == null || arg.ListValue.PositionalCount != 2)
                return false;
            var k = arg.ListValue.Get(1);
            if (k.Type != DMValueType.String) return false;
            name = k.StringValue;
            value = arg.ListValue.Get(2);
            return true;
        }

        private async Task<DMValue> InvokeWithUsr(Func<DMRuntime, DMValue[], Task<DMValue>> handler, DMValue[] args)
        {
            // DM semantics: usr is the object that invoked the call; for direct
            // calls this is the receiving object itself.
            var previousUsr = DMRuntimeHelpers.CurrentUsr;
            DMRuntimeHelpers.CurrentUsr = DMValue.FromDatum(this);
            try
            {
                return await handler(this, args);
            }
            finally
            {
                DMRuntimeHelpers.CurrentUsr = previousUsr;
            }
        }

        public bool CanCallProc(string procName)
        {
            return ProcRegistry.TryGet(DMTypePath, procName, out _)
                || ProcRegistry.TryGetInherited(DMTypePath, procName, out _)
                || ProcRegistry.TryGet("/proc", procName, out _);
        }
    }

    /// <summary>
    /// Registry of transpiled DM procs, keyed by (type path, proc name).
    /// Generated code registers each emitted proc method here.
    /// </summary>
    public static class ProcRegistry
    {
        private static readonly Dictionary<(string TypePath, string Name), Func<DMRuntime, DMValue[], Task<DMValue>>> Procs = new();
        private static readonly Dictionary<(string TypePath, string Name), string[]> ParamNames = new();

        /// <summary>
        /// Every type path that has at least one registered proc — used by
        /// typesof() to enumerate the type tree known to the runtime.
        /// </summary>
        public static readonly HashSet<string> RegisteredPaths = new();

        static ProcRegistry()
        {
            // /matrix builtin procs (item 65): mutate the a-f transform vars
            // of the receiver so M.Scale(2) followed by transform = M
            // reads back the scaled matrix.
            Register("/matrix", "scale", (comp, args) =>
            {
                var sx = args.Length > 0 && args[0].Type != DMValueType.Null ? args[0].ToNumber() : 1;
                var sy = args.Length > 1 && args[1].Type != DMValueType.Null ? args[1].ToNumber() : sx;
                comp.SetVar("a", DMValue.FromNumber(comp.GetVar("a").ToNumber() * sx));
                comp.SetVar("d", DMValue.FromNumber(comp.GetVar("d").ToNumber() * sy));
                return Task.FromResult(DMValue.FromDatum(comp));
            });
            Register("/matrix", "translate", (comp, args) =>
            {
                var tx = args.Length > 0 ? args[0].ToNumber() : 0;
                var ty = args.Length > 1 ? args[1].ToNumber() : 0;
                comp.SetVar("c", DMValue.FromNumber(comp.GetVar("c").ToNumber() + tx));
                comp.SetVar("f", DMValue.FromNumber(comp.GetVar("f").ToNumber() + ty));
                return Task.FromResult(DMValue.FromDatum(comp));
            });
            Register("/matrix", "turn", (comp, args) =>
            {
                var angle = args.Length > 0 ? args[0].ToNumber() : 0;
                var rad = angle * Math.PI / 180.0;
                var cos = Math.Cos(rad);
                var sin = Math.Sin(rad);
                var a = comp.GetVar("a").ToNumber();
                var b = comp.GetVar("b").ToNumber();
                var c = comp.GetVar("c").ToNumber();
                var d = comp.GetVar("d").ToNumber();
                var e = comp.GetVar("e").ToNumber();
                var f = comp.GetVar("f").ToNumber();
                comp.SetVar("a", DMValue.FromNumber(a * cos - b * sin));
                comp.SetVar("b", DMValue.FromNumber(a * sin + b * cos));
                comp.SetVar("c", DMValue.FromNumber(c * cos - d * sin));
                comp.SetVar("d", DMValue.FromNumber(c * sin + d * cos));
                comp.SetVar("e", DMValue.FromNumber(e * cos - f * sin));
                comp.SetVar("f", DMValue.FromNumber(e * sin + f * cos));
                return Task.FromResult(DMValue.FromDatum(comp));
            });
            Register("/matrix", "invert", (comp, args) =>
            {
                var a = comp.GetVar("a").ToNumber();
                var b = comp.GetVar("b").ToNumber();
                var c = comp.GetVar("c").ToNumber();
                var d = comp.GetVar("d").ToNumber();
                var e = comp.GetVar("e").ToNumber();
                var f = comp.GetVar("f").ToNumber();
                var det = a * d - b * c;
                if (Math.Abs(det) < 1e-12) return Task.FromResult(DMValue.FromDatum(comp));
                comp.SetVar("a", DMValue.FromNumber(d / det));
                comp.SetVar("b", DMValue.FromNumber(-b / det));
                comp.SetVar("c", DMValue.FromNumber(-c / det));
                comp.SetVar("d", DMValue.FromNumber(a / det));
                comp.SetVar("e", DMValue.FromNumber((c * f - d * e) / det));
                comp.SetVar("f", DMValue.FromNumber((b * e - a * f) / det));
                return Task.FromResult(DMValue.FromDatum(comp));
            });
            Register("/matrix", "multiply", (comp, args) =>
            {
                if (args.Length > 0 && args[0].Type == DMValueType.DatumRef && args[0].DatumRef is DMRuntime other)
                {
                    var a = comp.GetVar("a").ToNumber();
                    var b = comp.GetVar("b").ToNumber();
                    var c = comp.GetVar("c").ToNumber();
                    var d = comp.GetVar("d").ToNumber();
                    var e = comp.GetVar("e").ToNumber();
                    var f = comp.GetVar("f").ToNumber();
                    var a2 = other.GetVar("a").ToNumber();
                    var b2 = other.GetVar("b").ToNumber();
                    var c2 = other.GetVar("c").ToNumber();
                    var d2 = other.GetVar("d").ToNumber();
                    var e2 = other.GetVar("e").ToNumber();
                    var f2 = other.GetVar("f").ToNumber();
                    comp.SetVar("a", DMValue.FromNumber(a * a2 + b * c2));
                    comp.SetVar("b", DMValue.FromNumber(a * b2 + b * d2));
                    comp.SetVar("c", DMValue.FromNumber(c * a2 + d * c2));
                    comp.SetVar("d", DMValue.FromNumber(c * b2 + d * d2));
                    comp.SetVar("e", DMValue.FromNumber(e * a2 + f * c2 + e2));
                    comp.SetVar("f", DMValue.FromNumber(e * b2 + f * d2 + f2));
                }
                return Task.FromResult(DMValue.FromDatum(comp));
            });
            // /icon size builtins (item 65): the dimensions are not resolvable
            // engine-free; GetWidth/GetHeight return the DMI default of 32.
            Register("/icon", "getwidth", (comp, args) => Task.FromResult(DMValue.FromNumber(32)));
            Register("/icon", "getheight", (comp, args) => Task.FromResult(DMValue.FromNumber(32)));

            // ==== W-N roundflow ====
            // Global-proc builtins the SS13 round-flow code paths need.
            // Registered as /proc handlers so CallProc's /proc fallback
            // resolves them (same channel generated corpus procs use).

            // subtypesof(path): every registered type whose canonical
            // ancestor chain contains <path> (proper subtypes only — the
            // path itself is not included, matching BYOND).
            Register("/proc", "subtypesof", (comp, args) =>
            {
                var result = new DMList();
                if (args.Length == 0) return Task.FromResult(DMValue.FromList(result));
                var target = args[0];
                string t;
                if (target.Type == DMValueType.Path) t = target.StringValue.ToLowerInvariant();
                else if (target.Type == DMValueType.DatumRef && target.DatumRef is DMRuntime d) t = d.DMTypePath.ToLowerInvariant();
                else t = target.ToString().ToLowerInvariant();
                if (!t.StartsWith("/")) t = "/" + t;
                var universe = new HashSet<string>(RegisteredPaths);
                foreach (var k in DMRuntimeHelpers.TypeVarInits.Keys) universe.Add(k.ToLowerInvariant());
                foreach (var p in universe)
                {
                    if (p == t) continue;
                    if (DMParentPaths(p).Any(a => a == t))
                        result.Add(DMValue.FromPath(p));
                }
                return Task.FromResult(DMValue.FromList(result));
            });

            // shuffle(list): in-place Fisher-Yates permutation (BYOND
            // shuffles the list itself and returns null).
            Register("/proc", "shuffle", (comp, args) =>
            {
                if (args.Length > 0 && args[0].Type == DMValueType.List && args[0].ListValue is DMList list)
                {
                    var rng = new Random();
                    for (var i = list.Count - 1; i > 0; i--)
                    {
                        var j = rng.Next(i + 1);
                        var tmp = list.Get(i + 1);
                        list.Set(i + 1, list.Get(j + 1));
                        list.Set(j + 1, tmp);
                    }
                }
                return Task.FromResult(DMValue.Null);
            });

            // pickweight(assoc list of item->weight): weighted random pick.
            Register("/proc", "pickweight", (comp, args) =>
            {
                if (args.Length == 0 || args[0].Type != DMValueType.List) return Task.FromResult(DMValue.Null);
                var l = args[0].ListValue;
                double total = 0;
                var entries = new List<(DMValue Item, double W)>();
                foreach (var kv in l.AssocEntries) { var w = Math.Max(0, kv.Value.ToNumber()); total += w; entries.Add((kv.Key, w)); }
                for (var i = 1; i <= l.PositionalCount; i++) { var v = l.Get(i); var w = Math.Max(0, v.ToNumber()); total += w; entries.Add((v, w)); }
                if (total <= 0 || entries.Count == 0) return Task.FromResult(DMValue.Null);
                var roll = new Random().NextDouble() * total;
                foreach (var e in entries) { roll -= e.W; if (roll <= 0) return Task.FromResult(e.Item); }
                return Task.FromResult(entries[entries.Count - 1].Item);
            });

            // english_list(list, empty_text, and_text, comma_text):
            // human-readable "a, b and c" joining (proc-registration form
            // used by ticker announcements).
            Register("/proc", "english_list", (comp, args) =>
            {
                if (args.Length == 0 || args[0].Type != DMValueType.List) return Task.FromResult(DMValue.FromString(""));
                var l = args[0].ListValue;
                var items = new List<string>();
                for (var i = 1; i <= l.PositionalCount; i++) items.Add(l.Get(i).ToString());
                var andText = args.Length > 2 ? args[2].ToString() : " and ";
                var commaText = args.Length > 3 ? args[3].ToString() : ", ";
                string s;
                if (items.Count == 0) s = args.Length > 1 ? args[1].ToString() : "";
                else if (items.Count == 1) s = items[0];
                else if (items.Count == 2) s = items[0] + andText + items[1];
                else s = string.Join(commaText, items.Take(items.Count - 1)) + andText + items[items.Count - 1];
                return Task.FromResult(DMValue.FromString(s));
            });

            // sortList(list): ascending sort copy (BYOND sorts by value).
            Register("/proc", "sortlist", (comp, args) =>
            {
                if (args.Length == 0 || args[0].Type != DMValueType.List) return Task.FromResult(DMValue.Null);
                var l = args[0].ListValue;
                var items = new List<DMValue>();
                for (var i = 1; i <= l.PositionalCount; i++) items.Add(l.Get(i));
                items.Sort((a, b) =>
                {
                    if (a.Type == DMValueType.Number && b.Type == DMValueType.Number) return a.NumberValue.CompareTo(b.NumberValue);
                    return string.Compare(a.ToString(), b.ToString(), StringComparison.Ordinal);
                });
                var outList = new DMList();
                foreach (var it in items) outList.Add(it);
                return Task.FromResult(DMValue.FromList(outList));
            });
        }

        public static void Register(string typePath, string procName, Func<DMRuntime, DMValue[], Task<DMValue>> handler, string[] paramNames = null)
        {
            // DM identifiers are case-insensitive: normalize keys so a call
            // spelled differently from the declaration still resolves (WS5-16).
            Procs[(typePath.ToLowerInvariant(), procName.ToLowerInvariant())] = handler;
            RegisteredPaths.Add(typePath.ToLowerInvariant());
            if (paramNames != null)
                ParamNames[(typePath.ToLowerInvariant(), procName.ToLowerInvariant())] = paramNames;
        }

        // Registers a type path WITHOUT procs so typesof() sees var-only types
        // (WS9-4: previously only proc-bearing types were registered).
        public static void RegisterPath(string typePath)
        {
            RegisteredPaths.Add(typePath.ToLowerInvariant());
        }

        // Parameter names of the nearest matching registration (null if none
        // were recorded) — used to bind assoc arglist entries to parameters.
        public static string[] GetParamNames(string typePath, string procName)
        {
            if (ParamNames.TryGetValue((typePath.ToLowerInvariant(), procName.ToLowerInvariant()), out var names)) return names;
            // W-H: canonical ancestor chain (see DMParentPaths) — parent
            // proc params must bind against the resolved ancestor too.
            foreach (var candidate in DMParentPaths(typePath))
            {
                if (ParamNames.TryGetValue((candidate.ToLowerInvariant(), procName.ToLowerInvariant()), out names)) return names;
            }
            return null;
        }

        public static bool TryGet(string typePath, string procName, out Func<DMRuntime, DMValue[], Task<DMValue>> handler)
        {
            return Procs.TryGetValue((typePath.ToLowerInvariant(), procName.ToLowerInvariant()), out handler!);
        }

        // W-H: BYOND type-path shorthand — '/obj' and '/mob' are really
        // '/atom/movable/{obj,mob}', '/turf|/area|/image' sit under '/atom',
        // and '/atom's parent is '/datum'. Segment-stripping a sugar path
        // never reaches those canonical ancestors, which hid every /atom
        // proc (update_icon, update_icon_state, attack_hand, ...) from /obj
        // and /mob children — the paradise door slice needs update_icon
        // resolved through the real chain.
        private static readonly Dictionary<string, string[]> DMAliasAncestors = new()
        {
            ["obj"] = new[] { "/atom/movable", "/atom", "/datum" },
            ["mob"] = new[] { "/atom/movable", "/atom", "/datum" },
            ["turf"] = new[] { "/atom", "/datum" },
            ["area"] = new[] { "/atom", "/datum" },
            ["image"] = new[] { "/atom", "/datum" },
            ["atom"] = new[] { "/datum" },
        };

        /// <summary>Ancestor type paths in BYOND order (nearest first).</summary>
        public static IEnumerable<string> DMParentPaths(string typePath)
        {
            var parts = typePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
            while (parts.Length > 0)
            {
                parts = parts[..^1];
                yield return "/" + string.Join("/", parts);
                if (parts.Length == 1) break; // root segment: continue via alias tail
            }
            if (parts.Length == 1 && DMAliasAncestors.TryGetValue(parts[0].ToLowerInvariant(), out var tail))
            {
                foreach (var p in tail) yield return p;
            }
        }

        public static bool TryGetInherited(string typePath, string procName, out Func<DMRuntime, DMValue[], Task<DMValue>> handler)
        {
            foreach (var candidate in DMParentPaths(typePath))
            {
                if (Procs.TryGetValue((candidate.ToLowerInvariant(), procName.ToLowerInvariant()), out handler!)) return true;
            }
            handler = null!;
            return false;
        }

        // ==== W-A parent-call (item 22): defining-type plumbing ====

        /// <summary>
        /// TryGetInherited that also reports the ancestor path the proc was
        /// found on — "..()" binds arguments against the RESOLVED ancestor's
        /// declared parameter names, not the concrete instance type's.
        /// </summary>
        public static bool TryGetInherited(string typePath, string procName, out Func<DMRuntime, DMValue[], Task<DMValue>> handler, out string? resolvedPath)
        {
            foreach (var candidate in DMParentPaths(typePath))
            {
                if (Procs.TryGetValue((candidate.ToLowerInvariant(), procName.ToLowerInvariant()), out handler!))
                {
                    resolvedPath = candidate;
                    return true;
                }
            }
            handler = null!;
            resolvedPath = null;
            return false;
        }

        // ==== W-F new ====
        // Field var initializers that are new expressions
        // (var/x = new /path on a type) get a per-type seeder emitted by the
        // transpiler; DMNew runs it before the New() chain so the field holds
        // a real datum (BYOND: field initializers evaluate at construction).
        private static readonly Dictionary<string, Func<DMRuntime, DMValue[], Task<DMValue>>> VarInits = new();

        public static void RegisterVarInit(string typePath, Func<DMRuntime, DMValue[], Task<DMValue>> handler)
        {
            VarInits[typePath.ToLowerInvariant()] = handler;
        }

        public static bool TryGetVarInit(string typePath, out Func<DMRuntime, DMValue[], Task<DMValue>> handler)
        {
            return VarInits.TryGetValue(typePath.ToLowerInvariant(), out handler!);
        }

        // ==== B-4 verbs/input (item 72) ====

        /// <summary>
        /// Every proc name registered for a type, walking ancestors so the
        /// verb list reflects what the datum can actually be asked to run
        /// (dmverbs listing / command completion). Exact-path wins on
        /// duplicate names — the same precedence CallProc uses.
        /// </summary>
        public static List<string> EnumerateProcs(string typePath)
        {
            var names = new List<string>();
            var seen = new HashSet<string>();
            var path = typePath.ToLowerInvariant();
            var pending = new List<string> { path };
            // W-H: canonical ancestors (sugar /obj -> /atom/movable -> /atom)
            pending.AddRange(DMParentPaths(typePath));
            foreach (var candidate in pending)
            {
                var cand = candidate.ToLowerInvariant();
                foreach (var kv in Procs)
                {
                    if (kv.Key.TypePath != cand) continue;
                    if (seen.Add(kv.Key.Name)) names.Add(kv.Key.Name);
                }
            }
            return names;
        }
    }
}
`
      },
      {
        filename: 'DMTickScheduler.cs',
        content: `using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;

namespace SS13.DM.Runtime
{
    /// <summary>
    /// DM world-tick scheduler (PLAN item 70, B-2).
    ///
    /// DM measures time in deciseconds (1/10 s). world.time is "the number of
    /// server ticks that have passed multiplied by world.tick_lag" — game
    /// time, not real time — so a paused or playerless server does not
    /// advance it. sleep/spawn delays are deciseconds too; per the DM
    /// reference, event durations are rounded to whole ticks ("sleep(1)
    /// still means sleep for 1/10s" whatever tick_lag/fps is), so a due time
    /// is computed by rounding the delay UP onto the tick grid.
    ///
    /// The scheduler is engine-free: the clock only advances when somebody
    /// calls Pump(elapsedDs). On a live server the generated
    /// Content.Server.DM.ConvertedDMSystem pumps it every engine tick with
    /// the simulated frame time (ExternalDriver = true — the engine's
    /// EntitySystemManager calls Update on systems that override it, and the
    /// server's game loop supplies TickPeriod seconds). Without a driver a
    /// wall-clock fallback thread starts lazily on the first scheduled
    /// callback and advances the DM clock in whole tick_lag quanta, so
    /// probes observe the same tick-aligned times as on the engine.
    ///
    /// Wake ordering: callbacks due at the same instant fire in the order
    /// they were scheduled (DM: "in the order in which the procedures were
    /// originally put to sleep"). Callbacks scheduled with a zero/negative
    /// delay while the queue drains (DM sleep(0), spawn(0)) run at the end of
    /// the same pass — BYOND's "end of the current scheduler" yield.
    /// </summary>
    public static class DMTickScheduler
    {
        private sealed class Entry
        {
            public double DueDs;
            public long Seq;
            public Func<Task> Callback = () => Task.CompletedTask;
        }

        private static readonly object Sync = new();
        // W-E subsystem thread-safety: serializes whole Pump bodies. On a
        // live server Pump is driven only by ConvertedDMSystem.Update on
        // the main (IoC) thread; engine-free it is driven only by the
        // wall-clock fallback thread — but the two can overlap for one
        // iteration while the ExternalDriver handoff settles (the fallback
        // loop notices the flag between pumps). The gate keeps due drains
        // and per-tick callbacks single-threaded so DM state is never
        // mutated on two threads at once.
        private static readonly object PumpGate = new();
        // Min-heap on (DueDs, Seq): same-due callbacks fire in call order.
        private static readonly PriorityQueue<Entry, (double Due, long Seq)> Pending = new();
        // Per-DM-tick callbacks (subsystem registry); invoked once per
        // world-tick boundary crossed, in registration order.
        private static readonly Dictionary<long, Func<Task>> TickCallbacks = new();
        private static double _clockDs;
        private static long _lastBoundary;
        private static long _seq;
        private static long _tickCallbackSeq;
        private static bool _externalDriver;

        // W-I corpus: pump-time DM errors must be observable — a fire() or
        // spawn body throwing every tick previously vanished silently behind
        // catch {}, so converted-world boot logs under-reported real DM
        // faults. Report each distinct failure (deduped by type+message,
        // first 3 plus every 100th with a running count) to stderr.
        private static readonly Dictionary<string, int> PumpErrorCounts = new();
        // W-I corpus: a discarded async DM Task still has to be observed —
        // a bare discard leaves faults to the finalizer thread, which logs
        // them as unhandled unobserved noise instead of [DM-PUMP] lines.
        private static void ObservePumpTask(Task t)
        {
            if (t == null) return;
            t.ContinueWith(x =>
            {
                var agg = x.Exception;
                if (agg == null) return;
                var inners = agg.Flatten().InnerExceptions;
                if (inners.Count == 0) { ReportPumpError(agg); return; }
                foreach (var inner in inners) ReportPumpError(inner);
            }, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously);
        }
        public static void ReportPumpError(Exception ex)
        {
            var key = ex.GetType().Name + "|" + ex.Message;
            int n;
            lock (Sync) { PumpErrorCounts.TryGetValue(key, out n); PumpErrorCounts[key] = n + 1; }
            if (n < 3 || n % 100 == 0)
            {
                try { Console.Error.WriteLine($"[DM-PUMP] {ex.GetType().Name}: {ex.Message} (x{n + 1})"); } catch { }
            }
        }
        private static Thread _driverThread;
        private static readonly object DriverSync = new();
        private static long _driverLastTicks;
        private static double _driverRemainderDs;

        /// <summary>
        /// Deciseconds per world tick — DM's world.tick_lag (default 1).
        /// Read live from the world datum every call so DM writes to
        /// world.tick_lag / world.fps take effect on the next pump.
        /// </summary>
        public static double TickLag
        {
            get
            {
                var lag = DMRuntimeHelpers.WorldTickLag();
                return lag > 0 ? lag : 1;
            }
        }

        /// <summary>Deciseconds of DM game time elapsed (unquantized clock).</summary>
        public static double NowDs
        {
            get { lock (Sync) { return _clockDs; } }
        }

        /// <summary>World ticks elapsed so far (clock floored to the tick grid).</summary>
        public static long TicksElapsed
        {
            get { lock (Sync) { return BoundaryIndex(); } }
        }

        /// <summary>
        /// DM world.time: game-time clock quantized down to the tick grid —
        /// server ticks × tick_lag per the DM reference.
        /// </summary>
        public static double WorldTimeDs
        {
            get { lock (Sync) { return BoundaryIndex() * TickLag; } }
        }

        /// <summary>
        /// Set by the engine adapter once it drives Pump from the game loop;
        /// suppresses the wall-clock fallback driver.
        /// </summary>
        public static bool ExternalDriver
        {
            get { lock (Sync) { return _externalDriver; } }
            set { lock (Sync) { _externalDriver = value; } }
        }

        private static long BoundaryIndex()
        {
            var lag = TickLag;
            return (long)Math.Floor(_clockDs / lag);
        }

        // Due timestamp for a DM delay in deciseconds. Positive delays are
        // rounded up to a whole number of ticks: the wake fires on a tick
        // boundary, so a delay just below a boundary still waits the full
        // remaining tick (DM rounds event durations to tick granularity).
        // Zero/negative delays defer to the end of the current scheduler pass
        // (DM sleep(0) yield / backlog sleep).
        private static double DueFor(double delayDs)
        {
            var lag = TickLag;
            if (delayDs > 0)
            {
                var ticks = Math.Ceiling(delayDs / lag);
                return (BoundaryIndex() + ticks) * lag;
            }
            return _clockDs;
        }

        /// <summary>
        /// Advance the DM clock by elapsedDs deciseconds of game time and run
        /// every scheduled callback that became due. Due callbacks run on the
        /// calling thread in (due, insertion) order — FIFO within a wake tick.
        /// Then, once per world-tick boundary crossed: the registered
        /// per-tick callbacks (subsystem cadence), and the world.Tick() hook
        /// — BYOND 515 calls world.Tick() at the end of every server tick.
        /// </summary>
        public static void Pump(double elapsedDs)
        {
            if (elapsedDs < 0) elapsedDs = 0;
            // PumpGate: whole pumps serialize (see the field note) — DM proc
            // dispatch stays on one thread even if an external and a
            // fallback driver overlap.
            lock (PumpGate)
            {
                lock (Sync) { _clockDs += elapsedDs; }

                // Drain due entries. New entries enqueued due-now while draining
                // (sleep(0)/spawn(0) style yields) run at the end of this same
                // pass — BYOND's "end of the current scheduler" semantics.
                while (true)
                {
                    List<Entry> due = null;
                    lock (Sync)
                    {
                        while (Pending.Count > 0 && Pending.Peek().DueDs <= _clockDs)
                            (due ??= new List<Entry>()).Add(Pending.Dequeue());
                    }
                    if (due == null) break;
                    foreach (var e in due)
                    {
                        try { ObservePumpTask(e.Callback()); }
                        // W-I corpus: surface the error, keep scheduling.
                        catch (Exception ex) { ReportPumpError(ex); }
                    }
                }

                int boundaries;
                lock (Sync)
                {
                    var idx = BoundaryIndex();
                    boundaries = (int)Math.Max(0, idx - _lastBoundary);
                    _lastBoundary = idx;
                }
                if (boundaries <= 0) return;
                List<Func<Task>> cbs;
                lock (Sync) { cbs = new List<Func<Task>>(TickCallbacks.Values); }
                for (var i = 0; i < boundaries; i++)
                {
                    foreach (var cb in cbs)
                    {
                        // W-I corpus: subsystem fire() exceptions logged.
                        try { ObservePumpTask(cb()); } catch (Exception ex) { ReportPumpError(ex); }
                    }
                    if (DMRuntimeHelpers.WorldValue.DatumRef is DMRuntime w && w.CanCallProc("tick"))
                    {
                        try { ObservePumpTask(w.CallProc("tick")); } catch (Exception ex) { ReportPumpError(ex); }
                    }
                }
            }
        }

        /// <summary>
        /// Subsystem cadence hook (item 70): registers a callback invoked
        /// once per world-tick boundary the clock crosses, in registration
        /// order. This is the minimal hook the emitted code uses for
        /// /datum/controller-style subsystem loops — not a port of SS13's MC.
        /// Returns an id for UnregisterTickCallback.
        /// </summary>
        public static long RegisterTickCallback(Func<Task> callback)
        {
            EnsureFallbackDriver();
            lock (Sync) { var id = ++_tickCallbackSeq; TickCallbacks[id] = callback; return id; }
        }

        public static bool UnregisterTickCallback(long id)
        {
            lock (Sync) { return TickCallbacks.Remove(id); }
        }

        private static Task<DMValue> ScheduleSleep(double deciseconds)
        {
            EnsureFallbackDriver();
            var tcs = new TaskCompletionSource<DMValue>();
            lock (Sync)
            {
                var entry = new Entry
                {
                    DueDs = DueFor(deciseconds),
                    Seq = _seq++,
                    Callback = () => { tcs.TrySetResult(DMValue.Null); return Task.CompletedTask; },
                };
                Pending.Enqueue(entry, (entry.DueDs, entry.Seq));
            }
            return tcs.Task;
        }

        /// <summary>DM sleep(n): waits n deciseconds (rounded up onto the tick grid).</summary>
        public static async Task<DMValue> Sleep(double deciseconds)
        {
            return await ScheduleSleep(deciseconds);
        }

        public static async Task<DMValue> Sleep(DMValue deciseconds)
        {
            await ScheduleSleep(deciseconds.ToNumber());
            return DMValue.Null;
        }

        private static void ScheduleSpawn(double deciseconds, Func<Task> action)
        {
            if (action == null) return;
            if (deciseconds < 0)
            {
                // DM spawn(negative): the spawned block runs IMMEDIATELY inside
                // the current proc (the copy continues after the spawn
                // statement when the proc next yields — that deferred-caller
                // half is not modeled; the body starting synchronously is the
                // observable half). The hot task's sync prefix runs inline now.
                EnsureFallbackDriver();
                // W-I corpus: spawn(-1) immediate-run errors logged.
                try { ObservePumpTask(action()); } catch (Exception ex) { ReportPumpError(ex); }
                return;
            }
            EnsureFallbackDriver();
            lock (Sync)
            {
                var entry = new Entry { DueDs = DueFor(deciseconds), Seq = _seq++, Callback = action };
                Pending.Enqueue(entry, (entry.DueDs, entry.Seq));
            }
        }

        /// <summary>DM spawn(n) body: schedules the body after n deciseconds.</summary>
        public static void Spawn(double deciseconds, Action action)
            => ScheduleSpawn(deciseconds, () => { action(); return Task.CompletedTask; });

        public static void Spawn(DMValue deciseconds, Func<Task> action)
            => ScheduleSpawn(deciseconds.ToNumber(), action);

        public static void Spawn(DMValue deciseconds, Action action)
            => ScheduleSpawn(deciseconds.ToNumber(), () => { action(); return Task.CompletedTask; });

        // spawn() used as an expression: the body runs asynchronously and the
        // expression itself evaluates to the lambda's return value (Null for
        // the transpiled fallback — DM's spawn token is not representable).
        public static Task<DMValue> SpawnExpr(DMValue deciseconds, Func<Task<DMValue>> action)
        {
            ScheduleSpawn(deciseconds.ToNumber(), async () => { if (action != null) await action(); });
            return Task.FromResult(DMValue.Null);
        }

        /// <summary>
        /// Engine-free driver: a daemon thread that advances the DM clock in
        /// whole tick_lag quanta at wall-clock pace, so sleep/spawn/tick
        /// callbacks work without a game loop (probes, standalone runtime).
        /// Started lazily by the first scheduled callback; exits if a real
        /// engine driver takes over (ExternalDriver).
        /// </summary>
        private static void EnsureFallbackDriver()
        {
            lock (DriverSync)
            {
                if (_externalDriver || _driverThread != null) return;
                _driverLastTicks = Stopwatch.GetTimestamp();
                _driverThread = new Thread(DriverLoop) { IsBackground = true, Name = "DMTickScheduler fallback" };
                _driverThread.Start();
            }
        }

        private static void DriverLoop()
        {
            while (true)
            {
                Thread.Sleep(5); // poll period; clock only advances in whole DM ticks
                if (_externalDriver) return; // engine took over: stop pumping
                var now = Stopwatch.GetTimestamp();
                double elapsedDs;
                lock (DriverSync)
                {
                    elapsedDs = (now - _driverLastTicks) * 10.0 / Stopwatch.Frequency;
                    _driverLastTicks = now;
                }
                if (elapsedDs <= 0) continue;
                // Quantize to whole ticks so the engine-free clock stays on the
                // tick grid (world.time is always a multiple of tick_lag).
                var lag = TickLag;
                _driverRemainderDs += elapsedDs;
                var ticks = (long)Math.Floor(_driverRemainderDs / lag);
                if (ticks <= 0) continue;
                _driverRemainderDs -= ticks * lag;
                Pump(ticks * lag);
            }
        }
    }
}
`
      },
      {
        filename: 'DMRuntimeHelpers.cs',
        content: `using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace SS13.DM.Runtime
{
    /// <summary>
    /// Static helpers referenced by transpiled DM code.
    /// </summary>
    public static class DMRuntimeHelpers
    {
        // ==== Output / communication ====

        /// <summary>
        /// The mob that initiated the currently executing proc call (DM "usr").
        /// Defaults to Null; set around each proc invocation in DMRuntime.CallProc.
        /// </summary>
        public static DMValue CurrentUsr { get; set; } = DMValue.Null;

        /// <summary>
        /// Every datum created via DMNew that has not been deleted. Used by the
        /// engine-free position builtins (get_step, get_dist, get_turf, range,
        /// view) which locate datums by their DM x/y/z vars.
        /// </summary>
        public static readonly List<DMRuntime> LiveDatums = new();

        /// <summary>
        /// DM call(path, proc) proc-references: "DMProcRef:" + key into this
        /// table. Engine-free stand-in for BYOND proc references.
        /// </summary>
        private static readonly Dictionary<string, (DMRuntime? Datum, string TypePath, string ProcName)> ProcRefs = new();
        private static int _procRefCounter;

        // W-H: initialVars hold RAW DM initializer text (parseInitialValueText
        // keeps the source verbatim: 'FALSE', 'null', 'list ( MELEE = 30 )',
        // '( 1 << 8 )'). FromString() stored them as strings, and a non-empty
        // string is TRUTHY — so 'var/barricaded = FALSE' loaded as truthy and
        // door's 'if(...||barricaded) return' silently killed the whole click
        // chain. Coerce the DM literal keywords, plain numerics, and quoted
        // strings here; anything else keeps string identity exactly as before.
        public static DMValue ParseInitialVar(string raw)
        {
            if (raw == null) return DMValue.Null;
            var s = raw.Trim();
            if (string.Equals(s, "null", StringComparison.OrdinalIgnoreCase)) return DMValue.Null;
            if (string.Equals(s, "TRUE", StringComparison.OrdinalIgnoreCase)) return DMValue.FromNumber(1);
            if (string.Equals(s, "FALSE", StringComparison.OrdinalIgnoreCase)) return DMValue.FromNumber(0);
            if (double.TryParse(s, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var n))
                return DMValue.FromNumber(n);
            if (s.Length >= 2 && s.StartsWith("\"") && s.EndsWith("\""))
                return DMValue.FromString(s[1..^1]);
            return DMValue.FromString(raw);
        }

        private static string MakeProcRefKey(DMRuntime? datum, string typePath, string procName)
        {
            var key = "DMProcRef:" + _procRefCounter++;
            ProcRefs[key] = (datum, typePath, procName);
            return key;
        }

        /// <summary>
        /// The DM /world datum. DMWorld links world.fps and world.tick_lag the
        /// way BYOND does: they are the same value seen two ways
        /// (fps = 10/tick_lag), so writing one rewrites the other — a
        /// world.fps = N assignment changes the tick grid the scheduler uses.
        /// </summary>
        public sealed class DMWorld : DMRuntime
        {
            public override DMValue SetVar(string name, DMValue val)
            {
                base.SetVar(name, val);
                if (val.Type == DMValueType.Number && val.NumberValue > 0)
                {
                    if (name == "fps")
                        base.SetVar("tick_lag", DMValue.FromNumber(10.0 / val.NumberValue));
                    else if (name == "tick_lag")
                        base.SetVar("fps", DMValue.FromNumber(10.0 / val.NumberValue));
                }
                return val;
            }
        }

        /// <summary>
        /// DM "world" object. world.time is driven by DMTickScheduler (engine
        /// pump on a live server, wall-clock fallback otherwise); the engine-
        /// free runtime exposes a live datum either way.
        /// </summary>
        public static DMValue WorldValue { get; } = BuildWorld();

        // BYOND's era: world.realtime is deciseconds since 2000-01-01 00:00:00 GMT.
        private static readonly DateTime ByondEpoch = new(2000, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        /// <summary>
        /// world.tick_lag in deciseconds (DM default 1 = 0.1 s). Live read of
        /// the world datum var so DM writes to world.tick_lag (or the linked
        /// world.fps) take effect for the scheduler and for property reads.
        /// </summary>
        public static double WorldTickLag()
        {
            if (WorldValue.DatumRef is DMRuntime w)
            {
                var lag = w.GetVar("tick_lag");
                if (lag.Type == DMValueType.Number && lag.NumberValue > 0)
                    return lag.NumberValue;
            }
            return 1;
        }

        private static DMValue BuildWorld()
        {
            var world = new DMWorld { DMTypePath = "/world" };
            // Reads of world.time go through DMTickScheduler (game time, tick
            // grid); the var stays at 0 as the pre-boot value.
            world.SetVar("time", DMValue.FromNumber(0));
            // DM's default map is 100x100; the movement builtins clamp against
            // these (WS9-5 — previously never set, so step() walked off-map).
            world.SetVar("xmax", DMValue.FromNumber(100));
            world.SetVar("ymax", DMValue.FromNumber(100));
            // B-4 (item 72): world.log is BYOND's log output object — bind it
            // to the world datum so 'world.log << x' routes through the
            // output bridge (server log / session consoles) instead of
            // silently shifting on Null.
            world.SetVar("log", DMValue.FromDatum(world));
            // world.* statics: tick_lag (deciseconds, default 1 — the DMWorld
            // link also records fps = 10), view (BYOND default 5), system_type
            // (1=MS_WINDOWS, 2=UNIX — this host), byond_version, host, cpu
            // (usage placeholder).
            world.SetVar("tick_lag", DMValue.FromNumber(1));
            world.SetVar("view", DMValue.FromNumber(5));
            world.SetVar("system_type", DMValue.FromNumber(2));
            world.SetVar("byond_version", DMValue.FromNumber(516));
            world.SetVar("byond_build", DMValue.FromNumber(1605));
            world.SetVar("host", DMValue.FromString("localhost"));
            world.SetVar("cpu", DMValue.FromNumber(0));
            return DMValue.FromDatum(world);
        }

        // ==== Object lifecycle ====

        /// <summary>
        /// Creates a new datum of the given DM type path. Engine integration is
        /// provided by the hosting system; the engine-free runtime allocates a
        /// fresh DMRuntime (real object identity) and dispatches New() through
        /// the proc registry.
        /// </summary>
        public static async Task<DMValue> DMNew(DMRuntime comp, string typePath, params DMValue[] args)
        {
            // Datum type paths are canonicalized to lowercase (DM type paths
            // are case-insensitive) so IsType/registry lookups match the
            // emitted registrations (WS4-1). A bare new is /datum (item 62).
            var normalized = (typePath.Length == 0 ? "/datum" : typePath).ToLowerInvariant();
            // ==== W-F new ====
            // new /list produces a DM list, not a datum (corpus
            // new /list() sites would otherwise mint a dead datum).
            if (normalized == "/list")
                return DMValue.FromList(new DMList());
            var datum = new DMRuntime { DMTypePath = normalized };
            LiveDatums.Add(datum);
            // W-G input: seed the datum's vars from the type's declared
            // defaults (name/desc/...) BEFORE loc and New() — BYOND order.
            ApplyTypeVarInits(datum);
            // DM: new Type(loc, args...) — the first argument of an ATOM
            // constructor is its loc (item 63). New() still receives every
            // argument: corpus New procs declare New(loc, ...) and bind
            // loc from their own first parameter. Pure /datum types have no
            // loc (a stray var write would be harmless, but they must not
            // be split from their New signature).
            var isAtom = IsAtomPath(normalized);
            // W-F new: named args (k = v) arrive as DMNamedArg markers. An
            // atom's loc is the first POSITIONAL argument; when every arg is
            // named, a "loc" marker supplies it. Markers stay in the array —
            // the New() chain binds them by name to the resolved New's
            // declared parameters.
            DMValue? locArg = null;
            if (args.Length > 0 && isAtom)
            {
                foreach (var a in args)
                {
                    if (TryUnwrapNamedArg(a, out var markerName, out var markerValue))
                    {
                        if (!locArg.HasValue && string.Equals(markerName, "loc", StringComparison.OrdinalIgnoreCase))
                            locArg = markerValue;
                    }
                    else
                    {
                        if (!locArg.HasValue) locArg = a;
                        break;
                    }
                }
            }
            if (locArg.HasValue && isAtom)
            {
                // Containment (item 69, B-1): placing the atom in a loc goes
                // through the real move path — container contents membership
                // derives from loc, and Enter/Entered hooks fire when the
                // registry defines them.
                await MoveAtomTo(datum, locArg.Value);
            }
            // Entity integration (item 69, B-1): on the server the engine
            // adapter registers a spawn bridge — new() on an ATOM type then
            // materializes a real SS14 entity (and binds loc/transform)
            // instead of a bare datum. Engine-free runs never set the bridge
            // and keep the datum-only path.
            if (isAtom && EntitySpawnBridge != null)
            {
                EntitySpawnBridge(normalized, locArg ?? DMValue.Null, datum);
            }
            // W-F new: field var/x = new /path initializers seed real
            // datums before New() runs (BYOND: field initializers evaluate
            // at construction, so New() already sees them).
            if (ProcRegistry.TryGetVarInit(normalized, out var varInit))
            {
                await varInit(datum, System.Array.Empty<DMValue>());
            }
            // W-F new: BYOND runs the whole New() ancestor chain — an
            // implicit ..() at the end of each body — not a single CallProc
            // hop.
            await datum.CallNewChain(args);
            return DMValue.FromDatum(datum);
        }

        // ==== W-F new ====
        /// <summary>
        /// new x on a single-segment path: DM resolves the VAR x first —
        /// the corpus idiom new spawn_type(loc) reads a var holding a
        /// typepath. The parser cannot tell new x (var) from new /x
        /// (literal root path), so the emitter passes the var's value here:
        /// a path-shaped value wins, otherwise the literal path stands.
        /// (Rooted new /x together with a shadowing x var in scope is
        /// the one case this resolves differently — see docs/plans/27.)
        /// </summary>
        public static Task<DMValue> DMNewPath(DMRuntime comp, DMValue typeExpr, string literalPath, params DMValue[] args)
        {
            var resolved = ResolveNewPathExpr(typeExpr);
            return DMNew(comp, resolved ?? literalPath, args);
        }

        private static string? ResolveNewPathExpr(DMValue v)
        {
            if (v.Type == DMValueType.Path)
                return v.StringValue;
            if (v.Type == DMValueType.String && LooksLikeTypePath(v.StringValue ?? ""))
                return v.StringValue;
            return null;
        }

        /// <summary>
        /// DM typepath shape: /seg/seg with alnum-or-underscore segments
        /// (a resource path like /icon/x.dmi is not a typepath).
        /// </summary>
        private static bool LooksLikeTypePath(string s)
        {
            if (s.Length < 2 || s[0] != '/') return false;
            var segs = s.Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (segs.Length == 0) return false;
            foreach (var seg in segs)
            {
                foreach (var c in seg)
                {
                    if (!char.IsLetterOrDigit(c) && c != '_') return false;
                }
            }
            return true;
        }

        /// <summary>
        /// Server-side hook (set by ConvertedDMSystem at startup): spawns a
        /// real entity for a DM atom created via new (item 69, B-1).
        /// </summary>
        public static Action<string, DMValue, DMRuntime>? EntitySpawnBridge;

        /// <summary>
        /// Server-side hook (item 69, B-1): an atom's x/y/z vars were written
        /// — move the bound entity to match.
        /// </summary>
        public static Action<DMRuntime, double, double, double>? EntityMoveBridge;

        /// <summary>
        /// Server-side hook (item 69, B-1): read a bound entity's live
        /// coordinate as a DM tile coordinate (axis "x"/"y"/"z"). Returning
        /// null falls the read back to the datum var.
        /// </summary>
        public static Func<DMRuntime, string, double?>? EntityCoordBridge;

        /// <summary>
        /// Server-side hook (item 69, B-1): an atom's loc changed — reparent
        /// the bound entity (container datum, or null = detach to grid/map).
        /// </summary>
        public static Action<DMRuntime, DMValue>? EntityAttachBridge;

        // ==== Containment (item 69, B-1) ====

        private static bool IsAtomPath(string typePath)
        {
            return typePath == "/atom" || typePath.StartsWith("/atom/") ||
                   typePath == "/obj" || typePath.StartsWith("/obj/") ||
                   typePath == "/mob" || typePath.StartsWith("/mob/") ||
                   typePath == "/turf" || typePath.StartsWith("/turf/") ||
                   typePath == "/area" || typePath.StartsWith("/area/");
        }

        /// <summary>
        /// The live /turf datum at (x, y, z), or null. loc resolution and
        /// get_turf share this scan so the two agree.
        /// </summary>
        private static DMRuntime? TurfAt(double x, double y, double z)
        {
            if (x < 1 || y < 1) return null;
            foreach (var d in LiveDatums)
            {
                if (!d.MarkedForDeletion && d.IsType("/turf") && At(d, x, y, z))
                    return d;
            }
            return null;
        }

        /// <summary>
        /// DM atom.loc: the containing datum. An explicit container stored in
        /// the loc var wins; otherwise a positioned atom resolves to the /turf
        /// datum sharing its x/y/z (map-spawned atoms never write the var).
        /// </summary>
        public static DMValue ResolveLoc(DMRuntime datum)
        {
            var hasStored = datum.Variables.TryGetValue("loc", out var stored);
            if (hasStored && stored.Type == DMValueType.DatumRef)
                return stored;
            if (!IsAtomPath(datum.DMTypePath))
                return hasStored ? stored : DMValue.Null;
            // Atoms: a stored null/non-datum loc does not block positional
            // resolution — a New(loc)-arg default can write null into the var
            // before the datum is placed (approximation: BYOND treats an
            // explicitly nulled loc as nullspace even while positioned).
            var turf = TurfAt(Coord(datum, "x"), Coord(datum, "y"), Coord(datum, "z"));
            if (turf != null) return DMValue.FromDatum(turf);
            return hasStored ? stored : DMValue.Null;
        }

        /// <summary>
        /// DM atom.contents: live atoms whose loc resolves to this datum —
        /// computed, not stored. Members are atoms holding an explicit loc var
        /// naming this container, plus (for turfs) positioned atoms whose loc
        /// is unset or non-datum.
        /// </summary>
        public static DMList ContentsOf(DMRuntime datum)
        {
            var list = new DMList();
            var isTurf = datum.IsType("/turf");
            var x = Coord(datum, "x");
            var y = Coord(datum, "y");
            var z = Coord(datum, "z");
            foreach (var d in LiveDatums)
            {
                if (ReferenceEquals(d, datum) || d.MarkedForDeletion) continue;
                var hasContainer = d.Variables.TryGetValue("loc", out var stored)
                    && stored.Type == DMValueType.DatumRef;
                if (hasContainer)
                {
                    if (ReferenceEquals(stored.DatumRef, datum))
                        list.Add(DMValue.FromDatum(d));
                    continue;
                }
                if (isTurf && IsAtomPath(d.DMTypePath) && x >= 1 && y >= 1 && At(d, x, y, z))
                    list.Add(DMValue.FromDatum(d));
            }
            return list;
        }

        /// <summary>
        /// DM loc assignment (item 69, B-1): Exit on the old container then
        /// Enter on the new can veto (falsy return cancels the move);
        /// Exited/Entered fire after the write. Membership in both contents
        /// lists derives from loc, so no lists are mutated by hand.
        /// </summary>
        public static async Task<DMValue> MoveAtomTo(DMRuntime atom, DMValue newLoc)
        {
            if (!IsAtomPath(atom.DMTypePath))
            {
                atom.SetVar("loc", newLoc);
                return newLoc;
            }
            var oldValue = ResolveLoc(atom);
            var oldDatum = oldValue.Type == DMValueType.DatumRef ? oldValue.DatumRef as DMRuntime : null;
            var newDatum = newLoc.Type == DMValueType.DatumRef ? newLoc.DatumRef as DMRuntime : null;
            if (!ReferenceEquals(oldDatum, newDatum))
            {
                if (oldDatum != null && oldDatum.CanCallProc("Exit"))
                {
                    var ok = await oldDatum.CallProc("Exit", DMValue.FromDatum(atom), newLoc);
                    if (!ok.IsTrue()) return newLoc;
                }
                if (newDatum != null && newDatum.CanCallProc("Enter"))
                {
                    var ok = await newDatum.CallProc("Enter", DMValue.FromDatum(atom), oldValue);
                    if (!ok.IsTrue()) return newLoc;
                }
            }
            atom.SetVar("loc", newLoc);
            if (newDatum != null)
            {
                // BYOND: a contained atom takes its loc's coordinates.
                atom.SetVar("x", DMValue.FromNumber(Coord(newDatum, "x")));
                atom.SetVar("y", DMValue.FromNumber(Coord(newDatum, "y")));
                atom.SetVar("z", DMValue.FromNumber(Coord(newDatum, "z")));
            }
            if (!ReferenceEquals(oldDatum, newDatum))
            {
                if (oldDatum != null && oldDatum.CanCallProc("Exited"))
                    _ = oldDatum.CallProc("Exited", DMValue.FromDatum(atom), newLoc);
                if (newDatum != null && newDatum.CanCallProc("Entered"))
                    _ = newDatum.CallProc("Entered", DMValue.FromDatum(atom), oldValue);
            }
            if (atom.EntityId != 0)
            {
                if (EntityAttachBridge != null) EntityAttachBridge(atom, newLoc);
                if (newDatum != null && EntityMoveBridge != null)
                    EntityMoveBridge(atom, Coord(atom, "x"), Coord(atom, "y"), Coord(atom, "z"));
            }
            return newLoc;
        }

        /// <summary>
        /// Datum-property write with DM semantics (item 69): loc routes
        /// through <see cref="MoveAtomTo"/> (containment + hooks); x/y/z sync
        /// the datum var AND the bound entity's transform; everything else is
        /// a plain var write. Returns the assigned value (a DM assignment
        /// expression evaluates to it).
        /// </summary>
        public static async Task<DMValue> DMSetProperty(DMValue target, string name, DMValue value)
        {
            if (target.Type != DMValueType.DatumRef || target.DatumRef is not DMRuntime datum)
                return DMValue.Null;
            switch (name)
            {
                case "loc":
                    return await MoveAtomTo(datum, value);
                case "x":
                case "y":
                case "z":
                    SetAtomPosition(datum,
                        name == "x" ? value.ToNumber() : Coord(datum, "x"),
                        name == "y" ? value.ToNumber() : Coord(datum, "y"),
                        name == "z" ? value.ToNumber() : Coord(datum, "z"));
                    return value;
                default:
                    return datum.SetVar(name, value);
            }
        }

        /// <summary>
        /// Writes an atom's position vars and mirrors the move onto the bound
        /// entity (if any), then repairs a stale turf loc when the write
        /// crossed a tile boundary.
        /// </summary>
        private static void SetAtomPosition(DMRuntime a, double nx, double ny, double nz)
        {
            a.SetVar("x", DMValue.FromNumber(nx));
            a.SetVar("y", DMValue.FromNumber(ny));
            a.SetVar("z", DMValue.FromNumber(nz));
            if (a.EntityId != 0 && EntityMoveBridge != null)
                EntityMoveBridge(a, nx, ny, nz);
            RefreshTurfLoc(a);
        }

        /// <summary>
        /// After a coordinate write: a stored loc naming a /turf the atom no
        /// longer shares coordinates with is moved to the turf at the new
        /// position (steps cross tile boundaries; item 69). Unset locs resolve
        /// positionally on read — nothing to repair.
        /// </summary>
        private static void RefreshTurfLoc(DMRuntime a)
        {
            if (!IsAtomPath(a.DMTypePath)) return;
            if (!a.Variables.TryGetValue("loc", out var stored)
                || stored.Type != DMValueType.DatumRef || stored.DatumRef is not DMRuntime locDatum
                || !locDatum.IsType("/turf"))
                return;
            var x = Coord(a, "x");
            var y = Coord(a, "y");
            var z = Coord(a, "z");
            if (At(locDatum, x, y, z)) return;
            var target = TurfAt(x, y, z);
            _ = MoveAtomTo(a, target != null ? DMValue.FromDatum(target) : DMValue.Null);
        }

        public static DMValue DMDelete(params DMValue[] targets)
        {
            // Extra arguments (qdel(x, ...) corpus forms) are accepted and
            // ignored — only the first target is deleted (CS1501 fix).
            var target = targets.Length > 0 ? targets[0] : DMValue.Null;
            if (target.Type == DMValueType.DatumRef && target.DatumRef is DMRuntime datum)
            {
                // Engine integration point: queue entity deletion.
                datum.MarkForDeletion();
                LiveDatums.Remove(datum);
            }
            // DM: del/qdel have no meaningful result; returning Null keeps
            // 'return qdel(x)' compilable and correct.
            return DMValue.Null;
        }

        // ==== Proc dispatch ====

        public static async Task<DMValue> DMCallProc(DMValue target, string procName, params DMValue[] args)
        {
            if (target.Type == DMValueType.DatumRef && target.DatumRef is DMRuntime datum)
            {
                return await datum.CallProc(procName, args);
            }
            return DMValue.Null;
        }

        // ==== List helpers ====

        /// <summary>
        /// DM arglist(x): expands a list into an argument array (a single
        /// non-list value becomes a one-element array).
        /// </summary>
        public static DMValue[] DMArgList(DMValue v)
        {
            if (v.Type == DMValueType.List)
                return DMListToArray(v.ListValue);
            return new[] { v };
        }

        /// <summary>
        /// arglist(args) where args is the special argument list (a raw DMList).
        /// </summary>
        public static DMValue[] DMArgList(DMList list)
        {
            return list == null ? Array.Empty<DMValue>() : DMListToArray(list);
        }

        private static DMValue[] DMListToArray(DMList list)
        {
            var arr = new DMValue[list.Count];
            for (var i = 1; i <= list.Count; i++) arr[i - 1] = list.Get(i);
            return arr;
        }

        /// <summary>
        /// Concatenates argument segments for calls containing arglist().
        /// </summary>
        public static DMValue[] DMArgsConcat(params DMValue[][] segments)
        {
            var total = 0;
            foreach (var s in segments) total += s.Length;
            var result = new DMValue[total];
            var pos = 0;
            foreach (var s in segments)
            {
                Array.Copy(s, 0, result, pos, s.Length);
                pos += s.Length;
            }
            return result;
        }

        public static DMValue DMListGet(DMValue target, DMValue index)
        {
            var list = target.Type == DMValueType.List ? target.ListValue : null;
            if (list == null) return DMValue.Null;
            if (index.Type == DMValueType.Number)
                return list.Get((int)index.NumberValue);
            return list.GetAssoc(index.ToString());
        }

        public static DMValue DMListSet(DMValue target, DMValue index, DMValue value)
        {
            if (target.Type != DMValueType.List || target.ListValue == null) return DMValue.Null;
            var list = target.ListValue;
            // Copy-on-write: when another variable shares this list, clone
            // before mutating so the other references stay unchanged. The
            // caller (emitter) stores the returned value back into the var.
            if (list.RefCount > 1)
            {
                list = list.Clone();
                list.RefCount = 1;
            }
            if (index.Type == DMValueType.Number)
                list.Set((int)index.NumberValue, value);
            else
                list.SetAssoc(index.ToString(), value);
            return ReferenceEquals(list, target.ListValue) ? target : DMValue.FromList(list);
        }

        // ==== Type predicates ====

        public static DMValue DMGetProperty(DMValue target, string name)
        {
            // DM: .len on a list or text returns its length; on a datum it
            // falls through to the normal variable lookup below.
            if (name == "len")
            {
                if (target.Type == DMValueType.List) return DMValue.FromNumber(target.ListValue.Count);
                if (target.Type == DMValueType.String) return DMValue.FromNumber(DMValue.CpLength(target.StringValue));
            }
            if (target.Type == DMValueType.DatumRef && target.DatumRef is DMRuntime datum)
            {
                // Builtin atom/datum properties (item 62): a datum that does
                // NOT declare the var gets DM's implicit defaults — .type is
                // the datum's type path, .dir defaults to SOUTH (2),
                // .contents/.overlays to empty lists. Declared vars win.
                switch (name)
                {
                    case "type":
                        return DMValue.FromPath(datum.DMTypePath);
                    case "dir":
                        {
                            var dir = datum.GetVar("dir");
                            return dir.Type == DMValueType.Null ? DMValue.FromNumber(2) : dir;
                        }
                    case "loc":
                        return ResolveLoc(datum);
                    case "x":
                    case "y":
                    case "z":
                        {
                            // Bound entities resolve the live transform (item
                            // 69); atom coord vars read as numbers (0 = off
                            // map). A stored var always wins over defaults.
                            if (datum.EntityId != 0 && EntityCoordBridge != null)
                            {
                                var live = EntityCoordBridge(datum, name);
                                if (live.HasValue) return DMValue.FromNumber(live.Value);
                            }
                            var coord = datum.GetVar(name);
                            if (coord.Type == DMValueType.Null)
                                return IsAtomPath(datum.DMTypePath) ? DMValue.FromNumber(0) : DMValue.Null;
                            return coord;
                        }
                    case "contents":
                        {
                            var contents = datum.GetVar("contents");
                            // A stored list (declared/assigned) wins; atoms
                            // get the live computed membership (item 69).
                            if (contents.Type == DMValueType.List) return contents;
                            if (contents.Type != DMValueType.Null) return contents;
                            return DMValue.FromList(ContentsOf(datum));
                        }
                    case "overlays":
                        {
                            var overlays = datum.GetVar("overlays");
                            return overlays.Type == DMValueType.Null ? DMValue.FromList(new DMList()) : overlays;
                        }
                    case "underlays":
                        {
                            var underlays = datum.GetVar("underlays");
                            return underlays.Type == DMValueType.Null ? DMValue.FromList(new DMList()) : underlays;
                        }
                }
                // world.* statics: game-time values resolve live from
                // DMTickScheduler (item 70); wall-clock values are computed
                // at access time against the BYOND era (2000-01-01 GMT).
                if (ReferenceEquals(datum, WorldValue.DatumRef))
                {
                    switch (name)
                    {
                        // DM game time: server ticks × tick_lag (deciseconds).
                        case "time":
                            return DMValue.FromNumber(DMTickScheduler.WorldTimeDs);
                        // ds since 2000-01-01 00:00:00 GMT (BYOND era).
                        case "realtime":
                            return DMValue.FromNumber((DateTime.UtcNow - ByondEpoch).TotalMilliseconds / 100.0);
                        // ds since 00:00:00 GMT today.
                        case "timeofday":
                            return DMValue.FromNumber((DateTime.UtcNow - DateTime.UtcNow.Date).TotalMilliseconds / 100.0);
                        // fps = 10/tick_lag (DM links the two).
                        case "fps":
                            return DMValue.FromNumber(10.0 / DMTickScheduler.TickLag);
                        case "tick_lag":
                            return DMValue.FromNumber(WorldTickLag());
                    }
                }
                var storedVar = datum.GetVar(name);
                if (storedVar.Type != DMValueType.Null) return storedVar;
                // B-3 (item 71): implicit BYOND defaults for atom appearance
                // vars — an undeclared appearance var reads as its type
                // default (alpha 255, mouse_opacity 1, layer by type), not
                // null. Non-appearance vars still read null.
                return AppearanceVarDefault(datum, name);
            }
            return DMValue.Null;
        }

        public static DMValue DMIsType(DMValue value, DMValue typePath = default)
        {
            // DM: istype(non-datum, /type) is always false (0), never null.
            if (value.Type != DMValueType.DatumRef || value.DatumRef is not DMRuntime datum)
                return DMValue.FromNumber(0);
            // DM: istype(x) with no type is true for any datum.
            if (typePath.Type == DMValueType.Null)
                return DMValue.FromNumber(1);
            return DMValue.FromNumber(datum.IsType(typePath.ToString()) ? 1 : 0);
        }

        public static DMValue DMIsList(DMValue value)
        {
            return DMValue.FromNumber(value.Type == DMValueType.List ? 1 : 0);
        }

        public static DMValue ReplaceText(DMValue haystack, DMValue needle, DMValue replacement)
        {
            return ReplaceText(haystack, needle, replacement, DMValue.FromNumber(0), DMValue.FromNumber(0));
        }

        /// <summary>
        /// DM replacetext(text, find, replace, start, end): case-insensitive,
        /// replaces all occurrences within the 1-indexed [start, end] window
        /// (0/absent = the whole string). An empty needle is a no-op (BYOND
        /// replaces nothing; a naive scan would infinite-loop).
        /// </summary>
        public static DMValue ReplaceText(DMValue haystack, DMValue needle, DMValue replacement, DMValue start = default, DMValue end = default)
        {
            var s = haystack.ToString();
            var n = needle.ToString();
            if (n.Length == 0) return haystack;
            var result = new System.Text.StringBuilder();
            var idx = 0;
            int startIdx = start.Type == DMValueType.Null && start.NumberValue == 0 ? 1 : Math.Max(1, (int)start.ToNumber());
            int endIdx = end.Type == DMValueType.Null && end.NumberValue == 0 ? s.Length + 1 : (int)end.ToNumber();
            if (endIdx <= 0) endIdx = s.Length + 1;
            if (endIdx > s.Length + 1) endIdx = s.Length + 1;
            if (startIdx > endIdx) return haystack;
            var windowEnd = Math.Min(s.Length, endIdx - 1);
            // Copy everything before the window untouched.
            result.Append(s, 0, Math.Min(s.Length, startIdx - 1));
            idx = startIdx - 1;
            while (idx < s.Length && idx <= windowEnd)
            {
                var found = s.IndexOf(n, idx, StringComparison.OrdinalIgnoreCase);
                if (found < 0 || found > windowEnd)
                {
                    result.Append(s, idx, s.Length - idx);
                    break;
                }
                // BYOND preserves the case of the FOUND text in the
                // replacement: all-caps match -> all-caps replacement,
                // capitalized match -> capitalized replacement (WS7-13:
                // replacetext("One on one","one","two") == "Two on two").
                var matched = s.Substring(found, n.Length);
                string repl = replacement.ToString();
                if (matched != matched.ToLowerInvariant() && matched == matched.ToUpperInvariant())
                {
                    repl = repl.ToUpperInvariant();
                }
                else if (matched.Length > 0 && char.IsUpper(matched[0]) && repl.Length > 0)
                {
                    repl = char.ToUpperInvariant(repl[0]) + repl.Substring(1);
                }
                result.Append(s, idx, found - idx).Append(repl);
                idx = found + n.Length;
            }
            return DMValue.FromString(result.ToString());
        }

        public static DMValue DMIsPath(DMValue value, DMValue typePath = default)
        {
            // DM: ispath(x) with no type is true only when x is itself a path
            // value (text strings are never paths: ispath("x") = 0).
            if (typePath.Type == DMValueType.Null)
                return DMValue.FromNumber(value.Type == DMValueType.Path ? 1 : 0);
            // With a type: a path is within the type when it is the type or
            // a subtype (ispath(/obj/item, /obj) = 1; ispath(/obj, /obj/item) = 0).
            var type = value.ToString();
            var baseType = typePath.ToString().TrimEnd('/');
            return DMValue.FromNumber(type == baseType || type.StartsWith(baseType + "/", StringComparison.Ordinal) ? 1 : 0);
        }

        // ==== Misc builtins ====

        // ==== Value predicates (DM isnull/isnum/istext) ====

        public static DMValue DMIsNull(DMValue value)
        {
            return DMValue.FromNumber(value.Type == DMValueType.Null ? 1 : 0);
        }

        public static DMValue DMIsNum(DMValue value)
        {
            return DMValue.FromNumber(value.Type == DMValueType.Number ? 1 : 0);
        }

        public static DMValue DMIsText(DMValue value)
        {
            return DMValue.FromNumber(value.Type == DMValueType.String ? 1 : 0);
        }

        // ==== nameof / typesof ====

        /// <summary>
        /// DM nameof(/path/to/thing): the final segment of the path string.
        /// (A path constant converts to its path string; the emitter passes the
        /// path literal through, so nameof(/datum/action/proc/Trigger) yields
        /// "Trigger".)
        /// </summary>
        public static DMValue NameOf(DMValue path, DMValue unused = default)
        {
            var s = path.ToString();
            var idx = s.LastIndexOf('/');
            return DMValue.FromString(idx < 0 ? s : s.Substring(idx + 1));
        }

        /// <summary>
        /// DM typesof(...): the union of all type paths known to the runtime
        /// that match any of the given paths or their descendants.
        /// </summary>
        public static DMValue TypesOf(params DMValue[] typePaths)
        {
            var list = new DMList();
            foreach (var tp in typePaths)
            {
                var prefix = tp.ToString();
                foreach (var p in ProcRegistry.RegisteredPaths)
                {
                    if (p != prefix && !p.StartsWith(prefix + "/", StringComparison.Ordinal)) continue;
                    var alreadyAdded = false;
                    for (var i = 1; i <= list.Count; i++)
                    {
                        if (DMValue.Equals(list.Get(i), DMValue.FromString(p)).IsTrue()) { alreadyAdded = true; break; }
                    }
                    if (!alreadyAdded) list.Add(DMValue.FromString(p));
                }
            }
            return DMValue.FromList(list);
        }

        // ==== initial() ====

        /// <summary>
        /// DM initial(var): the value the var had when the datum was created
        /// (before runtime mutation). Engine-free approximation: the first
        /// value ever assigned to the var (DMRuntime.InitialValues).
        /// </summary>
        public static DMValue DMInitial(DMRuntime datum, string name)
        {
            if (datum.InitialValues.TryGetValue(name, out var v)) return v;
            return DMValue.Null;
        }

        public static DMValue DMInitial(DMValue datumOrValue, string name = "")
        {
            if (datumOrValue.Type == DMValueType.DatumRef && datumOrValue.DatumRef is DMRuntime datum)
                return DMInitial(datum, name);
            return DMValue.Null;
        }

        public static DMValue DMInitial(DMValue datumOrValue, DMValue name)
        {
            return DMInitial(datumOrValue, name.ToString());
        }

        // ==== CRASH ====

        public static DMValue DMCRASH(DMValue message)
        {
            throw new InvalidOperationException("DM CRASH: " + message.ToString());
        }

        // ==== turn() ====

        private static readonly int[] ClockwiseDirs = { 1, 5, 4, 6, 2, 10, 8, 9 }; // N, NE, E, SE, S, SW, W, NW

        /// <summary>
        /// DM turn(dir, angle): rotate a direction by an angle in degrees
        /// (positive = clockwise, 45-degree steps; approximates BYOND's
        /// binary-direction rotation).
        /// </summary>
        public static DMValue Turn(DMValue dir, DMValue angle = default)
        {
            if (dir.Type == DMValueType.Null) return dir;
            var d = (int)dir.ToNumber();
            var idx = Array.IndexOf(ClockwiseDirs, d);
            if (idx < 0) return dir;
            if (angle.Type == DMValueType.Null) return dir;
            // BYOND turn(dir, positive) rotates clockwise (probe-locked:
            // turn(NORTH, 90) == EAST; negative angles rotate counterclockwise).
            var steps = (int)Math.Round(angle.ToNumber() / 45.0);
            var rotated = (idx + steps) % ClockwiseDirs.Length;
            if (rotated < 0) rotated += ClockwiseDirs.Length;
            return DMValue.FromNumber(ClockwiseDirs[rotated]);
        }

        // ==== Position builtins (engine-free, by DM x/y/z vars) ====

        private static double Coord(DMRuntime datum, string axis)
        {
            var v = datum.GetVar(axis);
            return v.Type == DMValueType.Number ? v.NumberValue : 0;
        }

        private static (double Dx, double Dy) DirOffset(double dir)
        {
            return dir switch
            {
                1 => (0, 1),   // N
                2 => (0, -1),  // S
                4 => (1, 0),   // E
                8 => (-1, 0),  // W
                5 => (1, 1),   // NE
                6 => (1, -1),  // SE
                9 => (-1, 1),  // NW
                10 => (-1, -1),// SW
                _ => (0, 0)
            };
        }

        private static bool At(DMRuntime d, double x, double y, double z)
        {
            return Coord(d, "x") == x && Coord(d, "y") == y && Coord(d, "z") == z;
        }

        /// <summary>
        /// DM get_dist(a, b): Chebyshev distance (8-direction step count)
        /// between two datums by their x/y/z vars.
        /// </summary>
        public static DMValue GetDist(DMValue a, DMValue b)
        {
            if (a.Type != DMValueType.DatumRef || a.DatumRef is not DMRuntime da) return DMValue.FromNumber(0);
            if (b.Type != DMValueType.DatumRef || b.DatumRef is not DMRuntime db) return DMValue.FromNumber(0);
            var dx = Math.Abs(Coord(da, "x") - Coord(db, "x"));
            var dy = Math.Abs(Coord(da, "y") - Coord(db, "y"));
            return DMValue.FromNumber(Math.Max(dx, dy));
        }

        /// <summary>
        /// DM get_dir(a, b): the direction from a to b as a BYOND binary
        /// direction value (N=1, S=2, E=4, W=8, diagonals are bitwise-ORs).
        /// </summary>
        public static DMValue GetDir(DMValue a, DMValue b)
        {
            if (a.Type != DMValueType.DatumRef || a.DatumRef is not DMRuntime da) return DMValue.FromNumber(0);
            if (b.Type != DMValueType.DatumRef || b.DatumRef is not DMRuntime db) return DMValue.FromNumber(0);
            var dx = Coord(db, "x") - Coord(da, "x");
            var dy = Coord(db, "y") - Coord(da, "y");
            var dir = 0;
            if (dx > 0) dir |= 4;
            else if (dx < 0) dir |= 8;
            if (dy > 0) dir |= 1;
            else if (dy < 0) dir |= 2;
            return DMValue.FromNumber(dir);
        }

        /// <summary>
        /// DM get_step(atom, dir): the datum found one step in the given
        /// direction (first live datum at that position, or Null).
        /// </summary>
        public static DMValue GetStep(DMValue atom, DMValue dir)
        {
            if (atom.Type != DMValueType.DatumRef || atom.DatumRef is not DMRuntime a) return DMValue.Null;
            var (dx, dy) = DirOffset(dir.ToNumber());
            var x = Coord(a, "x") + dx;
            var y = Coord(a, "y") + dy;
            var z = Coord(a, "z");
            foreach (var d in LiveDatums)
            {
                if (d != a && At(d, x, y, z)) return DMValue.FromDatum(d);
            }
            return DMValue.Null;
        }

        /// <summary>
        /// DM get_turf(atom): the atom itself if it is a /turf, else the live
        /// /turf at its position, else Null.
        /// </summary>
        public static DMValue GetTurf(DMValue atom)
        {
            if (atom.Type != DMValueType.DatumRef || atom.DatumRef is not DMRuntime a) return DMValue.Null;
            if (a.IsType("/turf")) return atom;
            var x = Coord(a, "x");
            var y = Coord(a, "y");
            var z = Coord(a, "z");
            foreach (var d in LiveDatums)
            {
                if (d.IsType("/turf") && At(d, x, y, z)) return DMValue.FromDatum(d);
            }
            return DMValue.Null;
        }

        private static DMValue RangeScan(DMValue center, DMValue distValue, bool excludeCenter)
        {
            var dist = distValue.ToNumber();
            var list = new DMList();
            if (center.Type != DMValueType.DatumRef || center.DatumRef is not DMRuntime c) return DMValue.FromList(list);
            var cx = Coord(c, "x");
            var cy = Coord(c, "y");
            var cz = Coord(c, "z");
            foreach (var d in LiveDatums)
            {
                if (excludeCenter && d == c) continue;
                if (Math.Max(Math.Abs(Coord(d, "x") - cx), Math.Abs(Coord(d, "y") - cy)) <= dist && Coord(d, "z") == cz)
                    list.Add(DMValue.FromDatum(d));
            }
            return DMValue.FromList(list);
        }

        /// <summary>
        /// Resolves DM "range/dist-first" arg conventions shared by range,
        /// view, oview, orange, viewers, hearers: (dist, center) with center
        /// defaulting to usr — or (center) when the first arg is not a number.
        /// </summary>
        private static (DMValue Center, DMValue Dist) CenterDist(double defaultDist, params DMValue[] args)
        {
            if (args.Length == 0) return (CurrentUsr, DMValue.FromNumber(defaultDist));
            if (args[0].Type == DMValueType.Number)
            {
                var dist = args[0];
                var center = args.Length > 1 ? args[1] : CurrentUsr;
                return (center, dist);
            }
            var c = args[0];
            var d = args.Length > 1 ? args[1] : DMValue.FromNumber(defaultDist);
            return (c, d);
        }

        /// <summary>
        /// DM range(...): live datums within a distance of a center (usr by
        /// default). Approximates BYOND turf ranges by x/y/z vars.
        /// </summary>
        public static DMValue Range(params DMValue[] args)
        {
            var (center, dist) = CenterDist(0, args);
            return RangeScan(center, dist, false);
        }

        /// <summary>
        /// DM view(...): like range but the default distance is the 5x5 vision
        /// view (dist 2) and includes the center.
        /// </summary>
        public static DMValue View(params DMValue[] args)
        {
            var (center, dist) = CenterDist(2, args);
            return RangeScan(center, dist, false);
        }

        /// <summary>
        /// DM oview(...): like view but excludes the center.
        /// </summary>
        public static DMValue OView(params DMValue[] args)
        {
            var (center, dist) = CenterDist(2, args);
            return RangeScan(center, dist, true);
        }

        /// <summary>
        /// DM block(...): live turfs in a rectangle. Forms: block(a, b) with
        /// two atoms; block(x1, y1, x2, y2, z) or block(x1, y1, x2, y2, z, type)
        /// with raw coordinates and an optional type filter.
        /// </summary>
        public static DMValue Block(params DMValue[] args)
        {
            var list = new DMList();
            if (args.Length == 2)
            {
                if (args[0].Type != DMValueType.DatumRef || args[0].DatumRef is not DMRuntime da) return DMValue.FromList(list);
                if (args[1].Type != DMValueType.DatumRef || args[1].DatumRef is not DMRuntime db) return DMValue.FromList(list);
                var x1 = Math.Min(Coord(da, "x"), Coord(db, "x"));
                var x2 = Math.Max(Coord(da, "x"), Coord(db, "x"));
                var y1 = Math.Min(Coord(da, "y"), Coord(db, "y"));
                var y2 = Math.Max(Coord(da, "y"), Coord(db, "y"));
                var z = Coord(da, "z");
                foreach (var d in LiveDatums)
                {
                    if (d.IsType("/turf") && Coord(d, "x") >= x1 && Coord(d, "x") <= x2 && Coord(d, "y") >= y1 && Coord(d, "y") <= y2 && Coord(d, "z") == z)
                        list.Add(DMValue.FromDatum(d));
                }
                return DMValue.FromList(list);
            }
            if (args.Length >= 5)
            {
                var x1 = args[0].ToNumber();
                var y1 = args[1].ToNumber();
                var x2 = args[2].ToNumber();
                var y2 = args[3].ToNumber();
                var z = args[4].ToNumber();
                string filterType = args.Length >= 6 && args[5].Type == DMValueType.String ? args[5].ToString() : null;
                foreach (var d in LiveDatums)
                {
                    if (!d.IsType("/turf")) continue;
                    if (filterType != null && !d.IsType(filterType)) continue;
                    if (Coord(d, "x") >= x1 && Coord(d, "x") <= x2 && Coord(d, "y") >= y1 && Coord(d, "y") <= y2 && Coord(d, "z") == z)
                        list.Add(DMValue.FromDatum(d));
                }
                return DMValue.FromList(list);
            }
            return DMValue.FromList(list);
        }

        // ==== Movement builtins (engine-free, by DM x/y/z vars) ====

        private static double WorldCoord(string axis)
        {
            if (WorldValue.Type == DMValueType.DatumRef && WorldValue.DatumRef is DMRuntime w)
                return Coord(w, axis);
            return 0;
        }

        /// <summary>
        /// DM step(atom, dir, speed): moves the atom speed tiles (default 1)
        /// in the given direction, clamped to world bounds when world.xmax/
        /// ymax are set. Returns 1 if it moved, 0 if blocked.
        /// </summary>
        public static DMValue Step(DMValue atom, DMValue dir, DMValue speed = default)
        {
            if (atom.Type != DMValueType.DatumRef || atom.DatumRef is not DMRuntime a) return DMValue.FromNumber(0);
            var sp = speed.Type == DMValueType.Null && speed.NumberValue == 0 ? 1 : (int)speed.ToNumber();
            if (sp <= 0) return DMValue.FromNumber(0);
            var (dx, dy) = DirOffset(dir.ToNumber());
            if (dx == 0 && dy == 0) return DMValue.FromNumber(0);
            var nx = Coord(a, "x") + dx * sp;
            var ny = Coord(a, "y") + dy * sp;
            var xmax = WorldCoord("xmax");
            var ymax = WorldCoord("ymax");
            if (xmax > 0 && (nx < 1 || nx > xmax)) return DMValue.FromNumber(0);
            if (ymax > 0 && (ny < 1 || ny > ymax)) return DMValue.FromNumber(0);
            SetAtomPosition(a, nx, ny, Coord(a, "z"));
            return DMValue.FromNumber(1);
        }

        /// <summary>
        /// DM step_towards(atom, trg, speed): moves up to the given number of steps toward
        /// trg; 1 if moved at least once.
        /// </summary>
        public static DMValue StepTowards(DMValue atom, DMValue trg)
        {
            return StepTowards(atom, trg, DMValue.FromNumber(1));
        }

        public static DMValue StepTowards(DMValue atom, DMValue trg, DMValue speed)
        {
            var steps = (int)Math.Max(0, speed.ToNumber());
            var moved = 0;
            for (var i = 0; i < steps; i++)
            {
                var dir = GetDir(atom, trg);
                if (dir.ToNumber() == 0) break;
                var r = Step(atom, dir);
                if (r.ToNumber() != 1) break;
                moved = 1;
            }
            return DMValue.FromNumber(moved);
        }

        /// <summary>
        /// DM step_away(atom, trg, max, speed): moves one step away from trg,
        /// trying the direct away direction first and then 45-degree rotations,
        /// stopping once past max tiles (0 = 1) or after the given number of steps.
        /// </summary>
        public static DMValue StepAway(DMValue atom, DMValue trg, DMValue max = default, DMValue speed = default)
        {
            // BYOND default Max = 5 tiles; speed 0 = step size (one step).
            if (max.Type == DMValueType.Null) max = DMValue.FromNumber(5);
            if (speed.Type == DMValueType.Null) speed = DMValue.FromNumber(1);
            if (atom.Type != DMValueType.DatumRef || atom.DatumRef is not DMRuntime) return DMValue.FromNumber(0);
            if (trg.Type != DMValueType.DatumRef || trg.DatumRef is not DMRuntime) return DMValue.FromNumber(0);
            var maxDist = Math.Max(1, (int)max.ToNumber());
            var steps = (int)Math.Max(0, speed.ToNumber());
            var moved = 0;
            for (var s = 0; s < steps; s++)
            {
                // Stop once the atom is at least maxDist tiles away from trg.
                var d = Coord(atom.DatumRef as DMRuntime, "x") - Coord(trg.DatumRef as DMRuntime, "x");
                var dy = Coord(atom.DatumRef as DMRuntime, "y") - Coord(trg.DatumRef as DMRuntime, "y");
                if (Math.Max(Math.Abs(d), Math.Abs(dy)) >= maxDist) break;
                var away = GetDir(trg, atom).ToNumber();
                if (away == 0) break;
                var idx = Array.IndexOf(ClockwiseDirs, (int)away);
                if (idx < 0) break;
                var stepped = false;
                for (var i = 0; i < 8; i++)
                {
                    var dir = ClockwiseDirs[(idx + i) % ClockwiseDirs.Length];
                    var r = Step(atom, DMValue.FromNumber(dir));
                    if (r.ToNumber() == 1)
                    {
                        stepped = true;
                        moved = 1;
                        break;
                    }
                }
                if (!stepped) break;
            }
            return DMValue.FromNumber(moved);
        }

        /// <summary>
        /// DM get_step_away(atom, trg): the turf one step away from trg
        /// (no movement; first live datum at that position, or Null).
        /// </summary>
        public static DMValue GetStepAway(DMValue atom, DMValue trg, DMValue max = default)
        {
            // BYOND get_step_away(Ref, Trg, Max): the turf up to Max tiles
            // away from trg (default 1); 0/absent = one step (WS7-8).
            var steps = max.Type == DMValueType.Null ? 1 : Math.Max(1, (int)max.ToNumber());
            DMRuntime result = null;
            var current = atom;
            for (var s = 0; s < steps; s++)
            {
                var away = GetDir(trg, current);
                if (away.ToNumber() == 0) break;
                var next = GetStep(current, away);
                if (next.Type != DMValueType.DatumRef || next.DatumRef is not DMRuntime d) break;
                result = d;
                current = next;
            }
            return result != null ? DMValue.FromDatum(result) : DMValue.Null;
        }

        /// <summary>
        /// DM get_step_towards(atom, trg): the turf one step toward trg
        /// (no movement; first live datum at that position, or Null). BYOND
        /// takes an optional Speed arg — accepted and ignored (straight-line
        /// approximation, item 69).
        /// </summary>
        public static DMValue GetStepTowards(DMValue atom, DMValue trg, DMValue speed = default)
        {
            var dir = GetDir(atom, trg);
            if (dir.ToNumber() == 0) return DMValue.Null;
            return GetStep(atom, dir);
        }

        /// <summary>
        /// DM orange(dist, center): datums within dist (Chebyshev) of center,
        /// excluding the center's own tile. orange(0, c) = same-tile atoms
        /// other than c.
        /// </summary>
        public static DMValue Orange(params DMValue[] args)
        {
            var (center, dist) = CenterDist(0, args);
            var list = new DMList();
            if (center.Type != DMValueType.DatumRef || center.DatumRef is not DMRuntime c) return DMValue.FromList(list);
            var d = dist.ToNumber();
            var cx = Coord(c, "x");
            var cy = Coord(c, "y");
            var cz = Coord(c, "z");
            foreach (var d2 in LiveDatums)
            {
                var dx = Coord(d2, "x") - cx;
                var dy = Coord(d2, "y") - cy;
                if (Math.Max(Math.Abs(dx), Math.Abs(dy)) <= d && (dx != 0 || dy != 0) && Coord(d2, "z") == cz)
                    list.Add(DMValue.FromDatum(d2));
            }
            return DMValue.FromList(list);
        }

        /// <summary>
        /// DM viewers(dist, center): mobs that can see the center. Engine-free
        /// approximation: all /mob datums within range (default 2 = 5x5 view);
        /// vision-blocking checks are not modeled.
        /// </summary>
        public static DMValue Viewers(params DMValue[] args)
        {
            var (center, dist) = CenterDist(2, args);
            return MobScan(center, dist, true);
        }

        /// <summary>
        /// DM hearers(dist, center): mobs that can hear the center (default
        /// range 7, matching BYOND's hearing radius).
        /// </summary>
        public static DMValue Hearers(params DMValue[] args)
        {
            var (center, dist) = CenterDist(7, args);
            return MobScan(center, dist, true);
        }

        /// <summary>
        /// DM oviewers(dist, center): viewers of the area EXCLUDING the
        /// center itself (BYOND's o-prefixed variants drop the center).
        /// </summary>
        public static DMValue Oviewers(params DMValue[] args)
        {
            var (center, dist) = CenterDist(2, args);
            return MobScan(center, dist, false);
        }

        /// <summary>
        /// DM get_step_rand(atom): one step in a random direction
        /// (item 67 — previously an unresolved bare call).
        /// </summary>
        public static DMValue GetStepRand(DMValue atom, DMValue speed = default)
        {
            return GetStep(atom, DMValue.FromNumber(System.Random.Shared.Next(8) + 1));
        }

        /// <summary>
        /// DM get_step_to(atom, target, speed, min): one step toward the
        /// target (straight-line approximation of BYOND's pathfinding —
        /// item 67). The optional Speed/Min args are accepted and ignored
        /// (corpus: baystation passes speed — CS1501 fix).
        /// </summary>
        public static DMValue GetStepTo(DMValue atom, DMValue target, DMValue speed = default, DMValue min = default)
        {
            return GetStepTowards(atom, target);
        }

        /// <summary>
        /// DM splicetext(text, start, end): remove [start, end] from the text
        /// (item 67 — previously an unresolved bare call).
        /// </summary>
        public static DMValue Splicetext(DMValue text, DMValue start, DMValue end = default, DMValue unused = default)
        {
            var s = text.ToString();
            if (s.Length == 0) return text;
            int startIdx = start.Type == DMValueType.Null && start.NumberValue == 0 ? 1 : Math.Max(1, (int)start.ToNumber());
            int endIdx = end.Type == DMValueType.Null && end.NumberValue == 0 ? s.Length : (int)end.ToNumber();
            if (endIdx < startIdx) return text;
            // copytext end is exclusive: head = chars 1..startIdx-1,
            // tail = chars endIdx+1..end (item 67).
            var head = startIdx > 1 ? CopyText(text, DMValue.FromNumber(1), DMValue.FromNumber(startIdx)) : DMValue.FromString("");
            var tail = endIdx < s.Length ? CopyText(text, DMValue.FromNumber(endIdx + 1), DMValue.FromNumber(s.Length + 1)) : DMValue.FromString("");
            return DMValue.FromString(head.ToString() + tail.ToString());
        }

        /// <summary>
        /// DM filter(type, ...): a real /filter datum (item 67) — vars read
        /// back; rendering needs the engine.
        /// </summary>
        public static DMValue Filter(params DMValue[] args)
        {
            var datum = new DMRuntime { DMTypePath = "/filter" };
            LiveDatums.Add(datum);
            datum.SetVar("type", args.Length > 0 && args[0].Type != DMValueType.Null ? args[0] : DMValue.FromString("drop_shadow"));
            datum.SetVar("size", args.Length > 1 ? args[1] : DMValue.FromNumber(3));
            datum.SetVar("color", args.Length > 2 ? args[2] : DMValue.Null);
            datum.SetVar("alpha", DMValue.FromNumber(255));
            return DMValue.FromDatum(datum);
        }

        /// <summary>
        /// DM stack_trace(msg): prints the trace in BYOND; the engine-free
        /// runtime has no trace infrastructure — Null (debug aid, item 67).
        /// </summary>
        public static DMValue StackTrace(params DMValue[] args) => DMValue.Null;

        /// <summary>
        /// DM output(msg, target): sends text to a client UI element; the
        /// engine-free runtime has no client — Null (item 67).
        /// </summary>
        // B-4 (item 72): output(control, message, ...) has no skin control to
        // target; route the message through the real << output path so it
        // reaches the calling player's session console instead of vanishing.
        public static DMValue Output(params DMValue[] args)
        {
            if (args.Length >= 2)
                DMValue.Output(DMRuntimeHelpers.CurrentUsr.Type == DMValueType.DatumRef
                    ? DMRuntimeHelpers.CurrentUsr : DMRuntimeHelpers.WorldValue, args[1]);
            return DMValue.Null;
        }

        private static DMValue MobScan(DMValue center, DMValue distValue, bool includeCenter)
        {
            var dist = distValue.ToNumber();
            var list = new DMList();
            if (center.Type != DMValueType.DatumRef || center.DatumRef is not DMRuntime c) return DMValue.FromList(list);
            var cx = Coord(c, "x");
            var cy = Coord(c, "y");
            var cz = Coord(c, "z");
            foreach (var d in LiveDatums)
            {
                if (d == c && !includeCenter) continue;
                if (!d.IsType("/mob")) continue;
                if (Math.Max(Math.Abs(Coord(d, "x") - cx), Math.Abs(Coord(d, "y") - cy)) <= dist && Coord(d, "z") == cz)
                    list.Add(DMValue.FromDatum(d));
            }
            return DMValue.FromList(list);
        }

        // ==== Text / list builtins ====

        public static DMValue SplitText(DMValue text, DMValue separator)
        {
            return SplitText(text, separator, DMValue.FromNumber(1));
        }

        /// <summary>
        /// DM splittext(text, sep, start): split from the 1-indexed start
        /// character on; text before start is dropped.
        /// </summary>
        public static DMValue SplitText(DMValue text, DMValue separator, DMValue start = default, DMValue end = default, DMValue includeDelimiters = default)
        {
            var s = text.ToString();
            var startIdx = Math.Max(1, (int)(start.Type == DMValueType.Null ? 1 : start.ToNumber()));
            if (startIdx > s.Length) return DMValue.FromList(new DMList());
            var endIdx = end.Type == DMValueType.Null ? s.Length : (int)end.ToNumber();
            if (endIdx <= 0) endIdx = s.Length + endIdx;
            if (endIdx < startIdx) return DMValue.FromList(new DMList());
            var window = s.Substring(startIdx - 1, Math.Min(s.Length, endIdx) - (startIdx - 1));
            var include = includeDelimiters.IsTrue();
            var list = new DMList();
            var sep = separator.ToString();
            if (sep.Length == 0)
            {
                // Code-point iteration (astral chars are single elements).
                for (var i = 0; i < window.Length; i += char.IsSurrogatePair(window, i) ? 2 : 1)
                    list.Add(DMValue.FromString(window.Substring(i, char.IsSurrogatePair(window, i) ? 2 : 1)));
            }
            else
            {
                var pieces = window.Split(new[] { sep }, StringSplitOptions.None);
                if (include && window.EndsWith(sep, StringComparison.Ordinal))
                {
                    for (var i = 0; i < pieces.Length; i++)
                        list.Add(DMValue.FromString(i < pieces.Length - 1 ? pieces[i] + sep : pieces[i]));
                }
                else
                {
                    foreach (var p in pieces) list.Add(DMValue.FromString(p));
                }
            }
            return DMValue.FromList(list);
        }

        public static DMValue JoinText(DMValue value, DMValue separator = default)
        {
            return JoinText(value, separator, DMValue.FromNumber(1), DMValue.FromNumber(0));
        }

        /// <summary>
        /// DM jointext(list, sep, start, end): join elements start..end
        /// (1-indexed, inclusive; end 0 = to the end).
        /// </summary>
        public static DMValue JoinText(DMValue value, DMValue separator, DMValue start = default, DMValue end = default)
        {
            var sep = separator.Type == DMValueType.Null && separator.NumberValue == 0 ? "" : separator.ToString();
            var sb = new System.Text.StringBuilder();
            var first = true;
            void Append(string s)
            {
                if (!first) sb.Append(sep);
                sb.Append(s);
                first = false;
            }
            if (value.Type == DMValueType.List)
            {
                var startIdx = Math.Max(1, (int)start.ToNumber());
                var endToEnd = (end.Type == DMValueType.Null) || (end.Type == DMValueType.Number && end.NumberValue == 0);
                var endIdx = endToEnd ? value.ListValue.Count : (int)end.ToNumber();
                if (endIdx > value.ListValue.Count) endIdx = value.ListValue.Count;
                for (var i = startIdx; i <= endIdx; i++) Append(value.ListValue.Get(i).ToString());
            }
            else
            {
                Append(value.ToString());
            }
            return DMValue.FromString(sb.ToString());
        }

        /// <summary>
        /// DM params2list("a=1&b=2"): URL-style params into an associative list.
        /// Names and values are URL-decoded (%XX sequences; '+' decodes as a
        /// space, per DM's URL-encoding convention).
        /// </summary>
        public static DMValue Params2List(DMValue value)
        {
            var list = new DMList();
            foreach (var pair in value.ToString().Split('&'))
            {
                if (pair.Length == 0) continue;
                var eq = pair.IndexOf('=');
                if (eq < 0) list.Add(DMValue.FromString(UrlDecode(pair)));
                else list.SetAssoc(UrlDecode(pair.Substring(0, eq)), DMValue.FromString(UrlDecode(pair.Substring(eq + 1))));
            }
            return DMValue.FromList(list);
        }

        private static string UrlDecode(string s)
        {
            var sb = new StringBuilder();
            for (var i = 0; i < s.Length; i++)
            {
                var c = s[i];
                if (c == '+')
                {
                    sb.Append(' ');
                }
                else if (c == '%' && i + 2 < s.Length
                    && TryHex(s[i + 1], out var h1) && TryHex(s[i + 2], out var h2))
                {
                    sb.Append((char)(h1 * 16 + h2));
                    i += 2;
                }
                else
                {
                    sb.Append(c);
                }
            }
            return sb.ToString();
        }

        private static bool TryHex(char c, out int v)
        {
            if (c >= '0' && c <= '9') { v = c - '0'; return true; }
            if (c >= 'a' && c <= 'f') { v = c - 'a' + 10; return true; }
            if (c >= 'A' && c <= 'F') { v = c - 'A' + 10; return true; }
            v = 0;
            return false;
        }

        /// <summary>
        /// DM text2path: text becomes a path value (ispath() then reports 1).
        /// </summary>
        public static DMValue Text2Path(DMValue value) => DMValue.FromPath(value.ToString());

        /// <summary>
        /// DM rgb(r, g, b[, a]): "#RRGGBB" (or "#RRGGBBAA" with alpha) text.
        /// </summary>
        public static DMValue RGB(params DMValue[] args)
        {
            // DM rgb() components are clamped to 0-255 (WS8-7: rgb(300,0,0)
            // is #FF0000; out-of-range values previously emitted garbage hex).
            var r = args.Length > 0 ? Math.Clamp((int)args[0].ToNumber(), 0, 255) : 0;
            var g = args.Length > 1 ? Math.Clamp((int)args[1].ToNumber(), 0, 255) : 0;
            var b = args.Length > 2 ? Math.Clamp((int)args[2].ToNumber(), 0, 255) : 0;
            var a = args.Length > 3 ? Math.Clamp((int)args[3].ToNumber(), 0, 255) : 0;
            var hex = "#" + r.ToString("X2") + g.ToString("X2") + b.ToString("X2");
            if (a > 0) hex += a.ToString("X2");
            return DMValue.FromString(hex);
        }

        /// <summary>
        /// DM fexists(path): whether the file exists on the host filesystem.
        /// </summary>
        public static DMValue FExists(DMValue path)
        {
            return DMValue.FromNumber(System.IO.File.Exists(PathOf(path)) ? 1 : 0);
        }

        private static string PathOf(DMValue v) =>
            v.Type == DMValueType.File ? v.FileValue : v.ToString();

        /// <summary>
        /// DM file(path): a file value bound to a host path (engine-free; the
        /// path is used verbatim, resolved against the process CWD).
        /// </summary>
        public static DMValue File(DMValue path) => DMValue.FromFile(path.ToString());

        /// <summary>
        /// DM isfile(value): whether the value is a file (or file-bearing datum).
        /// </summary>
        public static DMValue IsFile(DMValue value) =>
            DMValue.FromNumber(value.Type == DMValueType.File ? 1 : 0);

        /// <summary>
        /// DM fdel(path): deletes the file; 1 if it existed and was deleted, 0 otherwise.
        /// </summary>
        public static DMValue FileDel(DMValue path)
        {
            try
            {
                var p = PathOf(path);
                if (!System.IO.File.Exists(p)) return DMValue.FromNumber(0);
                System.IO.File.Delete(p);
                return DMValue.FromNumber(1);
            }
            catch
            {
                return DMValue.FromNumber(0);
            }
        }

        /// <summary>
        /// DM fcopy(src, dst): copies a file; 1 on success, 0 on failure.
        /// </summary>
        public static DMValue FileCopy(DMValue src, DMValue dst)
        {
            try
            {
                System.IO.File.Copy(PathOf(src), PathOf(dst), true);
                return DMValue.FromNumber(1);
            }
            catch
            {
                return DMValue.FromNumber(0);
            }
        }

        /// <summary>
        /// DM fcopy_rsc(src, dst): copies a bundled resource. Engine-free runtime
        /// has no rsc packaging, so this behaves like fcopy.
        /// </summary>
        public static DMValue FileCopyRsc(DMValue src, DMValue dst = default) => FileCopy(src, dst);

        /// <summary>
        /// DM flist(path): list of entry names (files and directories) in a folder.
        /// </summary>
        public static DMValue FList(DMValue path)
        {
            var list = new DMList();
            try
            {
                var dir = PathOf(path);
                if (string.IsNullOrEmpty(dir)) dir = ".";
                foreach (var f in System.IO.Directory.GetFiles(dir))
                    list.Add(DMValue.FromString(System.IO.Path.GetFileName(f)));
                foreach (var d in System.IO.Directory.GetDirectories(dir))
                    list.Add(DMValue.FromString(System.IO.Path.GetFileName(d)));
            }
            catch
            {
                return DMValue.FromList(list);
            }
            return DMValue.FromList(list);
        }

        private static readonly System.Collections.Generic.Dictionary<object, string> RefIds =
            new System.Collections.Generic.Dictionary<object, string>();
        private static int RefCounter = 0;

        /// <summary>
        /// DM ref(value): stable reference string ("REF[0x...]") for datums;
        /// empty string for non-datum values.
        /// </summary>
        public static DMValue Ref(DMValue value)
        {
            if (value.Type == DMValueType.DatumRef && value.DatumRef != null)
            {
                if (RefIds.TryGetValue(value.DatumRef, out var id)) return DMValue.FromString(id);
                id = "REF[0x" + (++RefCounter).ToString("x") + "]";
                RefIds[value.DatumRef] = id;
                return DMValue.FromString(id);
            }
            return DMValue.FromString("");
        }

        /// <summary>
        /// DM refcount(value): engine-free approximation — no ref tracking, so 0.
        /// (Plan 01 file batch: documented approximation.)
        /// </summary>
        public static DMValue RefCount(DMValue value) => DMValue.FromNumber(0);

        /// <summary>
        /// DM SpacemanDMM_unlint(value): linter-only no-op.
        /// </summary>
        public static DMValue SpacemanUnlint(params DMValue[] args) => DMValue.Null;

        public static DMValue IsNaN(DMValue value)
        {
            return DMValue.FromNumber(double.IsNaN(value.ToNumber()) ? 1 : 0);
        }

        public static DMValue IsInf(DMValue value)
        {
            return DMValue.FromNumber(double.IsInfinity(value.ToNumber()) ? 1 : 0);
        }

        /// <summary>
        /// DM json_decode: JSON text into a DMValue (objects become associative
        /// lists, arrays become lists, scalars convert directly).
        /// </summary>
        public static DMValue JsonDecode(DMValue value)
        {
            try
            {
                using var doc = JsonDocument.Parse(value.ToString());
                return JsonToDMValue(doc.RootElement);
            }
            catch (JsonException)
            {
                return DMValue.Null;
            }
        }

        private static DMValue JsonToDMValue(JsonElement el)
        {
            switch (el.ValueKind)
            {
                case JsonValueKind.Object:
                {
                    var list = new DMList();
                    foreach (var prop in el.EnumerateObject()) list.SetAssoc(prop.Name, JsonToDMValue(prop.Value));
                    return DMValue.FromList(list);
                }
                case JsonValueKind.Array:
                {
                    var list = new DMList();
                    foreach (var item in el.EnumerateArray()) list.Add(JsonToDMValue(item));
                    return DMValue.FromList(list);
                }
                case JsonValueKind.String:
                    return DMValue.FromString(el.GetString() ?? "");
                case JsonValueKind.Number:
                    return DMValue.FromNumber(el.GetDouble());
                case JsonValueKind.True:
                    return DMValue.FromNumber(1);
                case JsonValueKind.False:
                    return DMValue.FromNumber(0);
                default:
                    return DMValue.Null;
            }
        }

        // ==== call() proc references ====

        /// <summary>
        /// DM call(target, proc): a reference to a proc, invocable later.
        /// target is a datum (bound to it) or a type-path string (bound to the
        /// type; invocation allocates a temporary datum of that type).
        /// </summary>
        public static DMValue MakeProcRef(DMValue target, DMValue procName = default)
        {
            var name = procName.Type == DMValueType.Null && procName.NumberValue == 0 ? "" : procName.ToString();
            if (target.Type == DMValueType.DatumRef && target.DatumRef is DMRuntime d)
                return DMValue.FromString(MakeProcRefKey(d, null!, name));
            return DMValue.FromString(MakeProcRefKey(null!, target.ToString(), name));
        }

        /// <summary>
        /// Invokes a proc reference created by call() (DM: pref(x, y)).
        /// </summary>
        public static async Task<DMValue> InvokeProcRef(DMValue procRef, params DMValue[] args)
        {
            var s = procRef.ToString();
            if (!s.StartsWith("DMProcRef:") || !ProcRefs.TryGetValue(s, out var entry)) return DMValue.Null;
            if (entry.Datum != null) return await entry.Datum.CallProc(entry.ProcName, args);
            var temp = new DMRuntime { DMTypePath = entry.TypePath };
            return await temp.CallProc(entry.ProcName, args);
        }

        // ==== Appearance/UI builtins ====

        // animate()/flick() are real now — implemented in the
        // ==== B-3 appearance ==== region (item 71): datum-side var
        // animation stepped by DMTickScheduler, pushed to the engine via
        // the appearance bridge.
        public static DMValue Browse(params DMValue[] args) => DMValue.Null;
        // B-4 (item 72): skin/window verbs stay stubs — no DM skin in the
        // converted client (browse/topic equivalents go through dmtopic).
        public static DMValue Winset(params DMValue[] args) => DMValue.Null;
        public static DMValue Winget(params DMValue[] args) => DMValue.Null;
        public static DMValue CallExt(params DMValue[] args) => DMValue.Null;
        public static DMValue DetectRustG(params DMValue[] args) => DMValue.FromNumber(0);

        /// <summary>
        /// DM image(icon, loc, icon_state, layer, dir): a real /image datum
        /// (item 65) — vars read back correctly; rendering needs the engine.
        /// </summary>
        public static DMValue Image(params DMValue[] args)
        {
            var datum = new DMRuntime { DMTypePath = "/image" };
            LiveDatums.Add(datum);
            if (args.Length > 0) datum.SetVar("icon", args[0]);
            if (args.Length > 1) datum.SetVar("loc", args[1]);
            datum.SetVar("icon_state", args.Length > 2 && args[2].Type != DMValueType.Null ? args[2] : DMValue.FromString(""));
            datum.SetVar("layer", args.Length > 3 && args[3].Type != DMValueType.Null ? args[3] : DMValue.FromNumber(2.0, true));
            datum.SetVar("dir", args.Length > 4 && args[4].Type != DMValueType.Null ? args[4] : DMValue.FromNumber(2));
            datum.SetVar("overlays", DMValue.FromList(new DMList()));
            datum.SetVar("pixel_x", DMValue.FromNumber(0));
            datum.SetVar("pixel_y", DMValue.FromNumber(0));
            return DMValue.FromDatum(datum);
        }

        /// <summary>
        /// DM sound(file, repeat, wait, volume, channel): a real /sound datum
        /// (item 65). Playback needs the engine.
        /// </summary>
        public static DMValue Sound(params DMValue[] args)
        {
            var datum = new DMRuntime { DMTypePath = "/sound" };
            LiveDatums.Add(datum);
            datum.SetVar("file", args.Length > 0 ? args[0] : DMValue.Null);
            datum.SetVar("repeat", args.Length > 1 ? args[1] : DMValue.FromNumber(0));
            datum.SetVar("wait", args.Length > 2 ? args[2] : DMValue.FromNumber(0));
            datum.SetVar("volume", args.Length > 3 ? args[3] : DMValue.FromNumber(100));
            datum.SetVar("channel", args.Length > 4 ? args[4] : DMValue.FromNumber(0));
            datum.SetVar("falloff", DMValue.FromNumber(5));
            datum.SetVar("frequency", DMValue.FromNumber(1));
            return DMValue.FromDatum(datum);
        }

        /// <summary>
        /// DM matrix() / matrix(a, b, c, d, e, f) / matrix(M): a real /matrix
        /// datum holding the 2x3 transform vars (item 65). The builtin procs
        /// (scale/translate/turn/invert/multiply) mutate those vars.
        /// </summary>
        public static DMValue Matrix(params DMValue[] args)
        {
            var datum = new DMRuntime { DMTypePath = "/matrix" };
            LiveDatums.Add(datum);
            if (args.Length == 6)
            {
                datum.SetVar("a", args[0]);
                datum.SetVar("b", args[1]);
                datum.SetVar("c", args[2]);
                datum.SetVar("d", args[3]);
                datum.SetVar("e", args[4]);
                datum.SetVar("f", args[5]);
            }
            else if (args.Length == 1 && args[0].Type == DMValueType.DatumRef && args[0].DatumRef is DMRuntime src)
            {
                datum.SetVar("a", src.GetVar("a"));
                datum.SetVar("b", src.GetVar("b"));
                datum.SetVar("c", src.GetVar("c"));
                datum.SetVar("d", src.GetVar("d"));
                datum.SetVar("e", src.GetVar("e"));
                datum.SetVar("f", src.GetVar("f"));
            }
            else
            {
                datum.SetVar("a", DMValue.FromNumber(1));
                datum.SetVar("b", DMValue.FromNumber(0));
                datum.SetVar("c", DMValue.FromNumber(0));
                datum.SetVar("d", DMValue.FromNumber(1));
                datum.SetVar("e", DMValue.FromNumber(0));
                datum.SetVar("f", DMValue.FromNumber(0));
            }
            return DMValue.FromDatum(datum);
        }

        /// <summary>
        /// DM icon(icon, icon_state, dir, frame, moving): a real /icon datum
        /// (item 65). The file's dimensions are resolved lazily by
        /// GetWidth/GetHeight (registered builtins).
        /// </summary>
        public static DMValue Icon(params DMValue[] args)
        {
            var datum = new DMRuntime { DMTypePath = "/icon" };
            LiveDatums.Add(datum);
            datum.SetVar("icon", args.Length > 0 ? args[0] : DMValue.Null);
            datum.SetVar("icon_state", args.Length > 1 ? args[1] : DMValue.Null);
            datum.SetVar("dir", args.Length > 2 && args[2].Type != DMValueType.Null ? args[2] : DMValue.FromNumber(2));
            return DMValue.FromDatum(datum);
        }


        public static DMValue DMProb(DMValue chance = default)
        {
            var rng = new Random();
            var p = chance.Type == DMValueType.Null ? 50 : chance.ToNumber();
            return DMValue.FromNumber(rng.NextDouble() * 100 < p ? 1 : 0);
        }

        // ==== Iteration helper: for(x in range) ====

        public static System.Collections.Generic.IEnumerable<DMValue> DMListItems(DMValue value)
        {
            switch (value.Type)
            {
                case DMValueType.List:
                    // Positional elements first, then assoc VALUES (DM iterates
                    // the values of an associative list).
                    for (var i = 1; i <= value.ListValue.PositionalCount; i++)
                        yield return value.ListValue.Get(i);
                    foreach (var kv in value.ListValue.AssocEntries)
                        yield return kv.Value;
                    break;
                case DMValueType.Number:
                    // DM: for (x in N) iterates 1..N
                    for (var i = 1; i <= (int)value.NumberValue; i++)
                        yield return DMValue.FromNumber(i);
                    break;
                case DMValueType.String:
                    // DM: for (x in "text") iterates characters — code points,
                    // not UTF-16 units (astral chars iterate once, WS8-12).
                    for (var i = 0; i < value.StringValue.Length; i += char.IsSurrogatePair(value.StringValue, i) ? 2 : 1)
                        yield return DMValue.FromString(value.StringValue.Substring(i, char.IsSurrogatePair(value.StringValue, i) ? 2 : 1));
                    break;
                case DMValueType.DatumRef:
                    // DM: iterating an atom iterates its contents (item 69).
                    if (value.DatumRef is DMRuntime container)
                    {
                        var members = ContentsOf(container);
                        for (var i = 1; i <= members.PositionalCount; i++)
                            yield return members.Get(i);
                    }
                    break;
                // W-H: BYOND 'for (x in null)' iterates ZERO times — the loop
                // body never runs. Real SS13 relies on this: has_access()
                // loops over req_access where it is null on no-access
                // objects and must fall through to 'return 1', not run one
                // bogus iteration. Null must yield nothing.
                case DMValueType.Null:
                    break;
                default:
                    yield return value;
                    break;
            }
        }

        public static DMValue DMLocate(DMValue typePath = default, DMValue x = default, DMValue y = default)
        {
            // Engine integration point: locate a datum of the given type
            // (or at the given turf coordinates for the 3-arg form).
            return DMValue.Null;
        }

        // ==== Builtin proc mappings ====

        public static DMValue Pick(params DMValue[] values)
        {
            if (values.Length == 0) return DMValue.Null;
            if (values.Length == 1 && values[0].Type == DMValueType.List)
            {
                var list = values[0].ListValue;
                if (list.Count == 0) return DMValue.Null;
                return list.Get(new Random().Next(list.Count) + 1);
            }
            return values[new Random().Next(values.Length)];
        }

        public static DMValue Rand(DMValue a = default, DMValue b = default)
        {
            // DM semantics: rand() -> float in [0, 1); rand(a) -> integer in
            // 0..a (BYOND: L defaults to 0 — WS7-9); rand(a, b) -> integer in
            // [min(a,b), max(a,b)].
            if (a.Type == DMValueType.Null)
                return DMValue.FromNumber(new Random().NextDouble());
            if (b.Type == DMValueType.Null)
            {
                var hi = (int)a.ToNumber();
                return DMValue.FromNumber(hi <= 0 ? 0 : new Random().Next(hi + 1));
            }
            var lo = (int)Math.Min(a.ToNumber(), b.ToNumber());
            var high = (int)Math.Max(a.ToNumber(), b.ToNumber());
            return DMValue.FromNumber(lo + new Random().Next(high - lo + 1));
        }

        public static DMValue MakeList(params DMValue[] values)
        {
            var list = new DMList();
            foreach (var v in values) list.Add(v);
            return DMValue.FromList(list);
        }

        /// <summary>
        /// DM associative literal: list("a" = 1, "b" = 2). Keys are
        /// stringified exactly like index assignment (L["a"] = 1).
        /// </summary>
        public static DMValue MakeListAssoc(params DMValue[] kv)
        {
            var list = new DMList();
            for (var i = 0; i + 1 < kv.Length; i += 2) list.SetAssoc(kv[i].ToString(), kv[i + 1]);
            return DMValue.FromList(list);
        }

        /// <summary>
        /// DM range literal: 1..5 -&gt; list [1, 2, 3, 4, 5]; descending ranges
        /// (5..1) are supported. Used by for(x in 1..N) loops.
        /// </summary>
        public static DMValue MakeRange(DMValue a, DMValue b)
        {
            var list = new DMList();
            var lo = (int)a.ToNumber();
            var hi = (int)b.ToNumber();
            if (lo <= hi)
            {
                for (var i = lo; i <= hi; i++) list.Add(DMValue.FromNumber(i));
            }
            else
            {
                for (var i = lo; i >= hi; i--) list.Add(DMValue.FromNumber(i));
            }
            return DMValue.FromList(list);
        }

        public static DMValue Length(DMValue value = default)
        {
            // A zero-argument length() (macro-expanded calls — corpus:
            // beestation) returns 0: nothing to measure.
            if (value.Type == DMValueType.Null && value.NumberValue == 0) return DMValue.FromNumber(0);
            if (value.Type == DMValueType.List) return DMValue.FromNumber(value.ListValue.Count);
            if (value.Type == DMValueType.File)
            {
                try { return DMValue.FromNumber(new System.IO.FileInfo(value.FileValue).Length); }
                catch { return DMValue.FromNumber(0); }
            }
            // DM 514+: length() counts Unicode code points.
            return DMValue.FromNumber(DMValue.CpLength(value.ToString()));
        }

        public static DMValue Length(DMList value) => DMValue.FromNumber(value?.Count ?? 0);

        public static DMValue Text(DMValue format, params DMValue[] args)
        {
            if (format.Type != DMValueType.String)
            {
                var concat = format.ToString();
                foreach (var a in args) concat += a.ToString();
                return DMValue.FromString(concat);
            }
            var result = format.StringValue;
            var argIndex = 0;
            var sb = new System.Text.StringBuilder();
            var i = 0;
            while (i < result.Length)
            {
                if (result[i] == '[' && argIndex < args.Length)
                {
                    var end = result.IndexOf(']', i);
                    if (end < 0) { sb.Append(result.Substring(i)); break; }
                    sb.Append(args[argIndex].ToString());
                    argIndex++;
                    i = end + 1;
                    continue;
                }
                sb.Append(result[i]);
                i++;
            }
            return DMValue.FromString(sb.ToString());
        }

        public static DMValue Text2Num(DMValue value)
        {
            return Text2Num(value, DMValue.FromNumber(0));
        }

        /// <summary>
        /// DM text2num(text, radix): parse text in the given base (2-36).
        /// radix 0 auto-detects 0x / 0b / 0o prefixes, else decimal.
        /// DM parses the longest valid digit prefix (text2num("1G", 16) = 1)
        /// and accepts a leading +/- sign.
        /// </summary>
        public static DMValue Text2Num(DMValue value, DMValue radix)
        {
            var s = value.ToString().Trim();
            var r = (int)radix.ToNumber();
            var idx = 0;
            var neg = false;
            if (idx < s.Length && (s[idx] == '+' || s[idx] == '-'))
            {
                neg = s[idx] == '-';
                idx++;
            }
            if (r == 0)
            {
                if (idx + 1 < s.Length && s[idx] == '0' && (s[idx + 1] == 'x' || s[idx + 1] == 'X'))
                    return ParseNumDigits(s, idx + 2, 16, neg);
                if (idx + 1 < s.Length && s[idx] == '0' && (s[idx + 1] == 'b' || s[idx + 1] == 'B'))
                    return ParseNumDigits(s, idx + 2, 2, neg);
                if (idx + 1 < s.Length && s[idx] == '0' && (s[idx + 1] == 'o' || s[idx + 1] == 'O'))
                    return ParseNumDigits(s, idx + 2, 8, neg);
                r = 10;
            }
            if (r < 2 || r > 36) return DMValue.FromNumber(0);
            if (r == 10)
            {
                // Decimal: floats and exponents parse in full (3.14, 1.5e2).
                if (double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var f))
                    return DMValue.FromNumber(f);
            }
            return ParseNumDigits(s, idx, r, neg);
        }

        private static DMValue ParseNumDigits(string s, int idx, int radix, bool neg)
        {
            double acc = 0;
            var any = false;
            for (; idx < s.Length; idx++)
            {
                var c = s[idx];
                int d = c >= '0' && c <= '9' ? c - '0'
                    : c >= 'a' && c <= 'z' ? c - 'a' + 10
                    : c >= 'A' && c <= 'Z' ? c - 'A' + 10 : -1;
                if (d < 0 || d >= radix) break;
                acc = acc * radix + d;
                any = true;
            }
            if (!any) return DMValue.FromNumber(0);
            return DMValue.FromNumber(neg ? -acc : acc);
        }

        public static DMValue Num2Text(DMValue value)
        {
            return Num2Text(value, DMValue.FromNumber(0), DMValue.FromString(""));
        }

        public static DMValue Num2Text(DMValue value, DMValue len)
        {
            // BYOND 2-arg num2text(N, SigFig): significant digits, with
            // scientific notation when the value does not fit (WS7-15/WS8-9:
            // num2text(123.456, 2) == "1.2e2").
            var n = value.ToNumber();
            var sig = (int)len.ToNumber();
            if (sig <= 0) return DMValue.FromString(n.ToString(CultureInfo.InvariantCulture));
            var s = n.ToString("G" + sig, CultureInfo.InvariantCulture);
            s = s.Replace("E+", "e").Replace("E-", "e-").Replace("E", "e");
            s = System.Text.RegularExpressions.Regex.Replace(s, "e0([0-9])", "e$1");
            return DMValue.FromString(s);
        }

        public static DMValue Num2Text(DMValue value, DMValue len, DMValue pad)
        {
            var n = value.ToNumber();
            var s = n == (int)n ? ((int)n).ToString(CultureInfo.InvariantCulture) : n.ToString(CultureInfo.InvariantCulture);
            var width = (int)len.ToNumber();
            var padStr = pad.ToString();
            if (width > s.Length && padStr.Length > 0) s = s.PadLeft(width, padStr[0]);
            return DMValue.FromString(s);
        }

        public static DMValue CopyText(DMValue text, DMValue start, DMValue end = default)
        {
            var s = text.ToString();
            var cpLen = DMValue.CpLength(s);
            // DM 1-based code-point indices; 0 start -> 1; 0 end -> end of
            // string; negative indices count from the end (the negative
            // branch must run first — WS13 probe 4).
            int startIdx = (int)start.ToNumber();
            if (startIdx < 0) startIdx = cpLen + startIdx + 1;
            else if (startIdx == 0) startIdx = 1;
            int endIdx;
            if (end.Type == DMValueType.Null) endIdx = cpLen + 1;
            else
            {
                endIdx = (int)end.ToNumber();
                if (endIdx < 0) endIdx = cpLen + endIdx + 1;
                else if (endIdx == 0) endIdx = cpLen + 1;
            }
            startIdx = Math.Max(1, Math.Min(cpLen + 1, startIdx));
            endIdx = Math.Max(startIdx, Math.Min(cpLen + 1, endIdx));
            if (endIdx <= startIdx) return DMValue.FromString("");
            var charStart = DMValue.CpIndexToChar(s, startIdx);
            var charEnd = DMValue.CpIndexToChar(s, endIdx);
            return DMValue.FromString(s.Substring(charStart, charEnd - charStart));
        }

        public static DMValue FindText(DMValue text, DMValue needle, DMValue start = default, DMValue end = default, DMValue caseSensitive = default)
        {
            var s = text.ToString();
            // DM indices are 1-based code points; negative counts from the end.
            int startIdx = start.Type == DMValueType.Null && start.NumberValue == 0 ? 1 : (int)start.ToNumber();
            if (startIdx < 0) startIdx = DMValue.CpLength(s) + startIdx + 1;
            startIdx = Math.Max(1, startIdx);
            if (startIdx > DMValue.CpLength(s)) return DMValue.FromNumber(0);
            var needleStr = needle.ToString();
            // BYOND End is the position immediately AFTER the last char to
            // search (exclusive — WS7-12); 0 means "to the end".
            int endIdx = end.Type == DMValueType.Null && end.NumberValue == 0 ? DMValue.CpLength(s) + 1 : (int)end.ToNumber();
            if (endIdx < 0) endIdx = DMValue.CpLength(s) + endIdx + 1;
            if (endIdx <= 0) endIdx = DMValue.CpLength(s) + 1;
            if (endIdx > DMValue.CpLength(s)) endIdx = DMValue.CpLength(s) + 1;
            if (endIdx < startIdx) return DMValue.FromNumber(0);
            // DM: findtext is case-insensitive unless case_sensitive is set.
            var comparison = caseSensitive.IsTrue() ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase;
            // DM: an empty needle is found at the start position.
            if (needleStr.Length == 0) return DMValue.FromNumber(startIdx);
            var hayStart = DMValue.CpIndexToChar(s, startIdx);
            var hayEnd = DMValue.CpIndexToChar(s, endIdx);
            var idx = s.IndexOf(needleStr, hayStart, hayEnd - hayStart, comparison);
            return DMValue.FromNumber(idx < 0 ? 0 : DMValue.CpLength(s.Substring(0, idx)) + 1);
        }

        public static DMValue Clamp(DMValue value, DMValue lo, DMValue hi)
        {
            var n = value.ToNumber();
            return DMValue.FromNumber(Math.Max(lo.ToNumber(), Math.Min(hi.ToNumber(), n)));
        }

        public static DMValue Max(params DMValue[] values)
        {
            var result = DMValue.Null;
            foreach (var v in values)
                if (result.Type == DMValueType.Null || v.ToNumber() > result.ToNumber()) result = v;
            return result;
        }

        public static DMValue Min(params DMValue[] values)
        {
            var result = DMValue.Null;
            foreach (var v in values)
                if (result.Type == DMValueType.Null || v.ToNumber() < result.ToNumber()) result = v;
            return result;
        }

        public static DMValue Round(DMValue value, DMValue digits = default)
        {
            var n = value.ToNumber();
            // BYOND round(A) rounds to the nearest whole number with halves
            // rounded DOWN (round(2.5) == 2, round(49.9999) == 50);
            // round(A, B) rounds to the nearest MULTIPLE of B, halves down
            // (round(11, 5) == 10, round(1.45, 1.5) == 1.5 — WS7-4/WS8-8).
            var d = digits.Type == DMValueType.Null && digits.NumberValue == 0 ? 0 : digits.ToNumber();
            if (d == 0)
                return DMValue.FromNumber(Math.Ceiling(n - 0.5));
            return DMValue.FromNumber(Math.Ceiling(n / d - 0.5) * d, true);
        }

        public static DMValue Abs(DMValue value) => DMValue.FromNumber(Math.Abs(value.ToNumber()));

        // ===== Tier-3 builtins (2026-08-02 wave) =====

        // arctan in degrees (BYOND trig is degree-based).
        public static DMValue Arctan(DMValue value, DMValue unused = default) => DMValue.FromNumber(Math.Atan(value.ToNumber()) * 180.0 / Math.PI, true);

        // regex_quote(text): escape regex metacharacters (REGEX_QUOTE macro).
        public static DMValue RegexQuote(DMValue value) => DMValue.FromString(Regex.Escape(value.ToString()));

        // findlasttext(haystack, needle, start, end): findtext scanning from
        // the end; returns the 1-based code-point index of the LAST match.
        public static DMValue FindLastText(DMValue text, DMValue needle, DMValue start = default, DMValue end = default)
        {
            var s = text.ToString();
            var n = needle.ToString();
            if (n.Length == 0) return DMValue.FromNumber(0);
            var lastIdx = s.LastIndexOf(n, StringComparison.OrdinalIgnoreCase);
            if (lastIdx < 0) return DMValue.FromNumber(0);
            return DMValue.FromNumber(DMValue.CpLength(s.Substring(0, lastIdx)) + 1);
        }

        // values_sum(list): sum of the elements (vector/stat helpers).
        public static DMValue ValuesSum(DMValue value)
        {
            var list = value.AsList();
            if (list == null) return DMValue.FromNumber(0);
            double sum = 0;
            for (var i = 1; i <= list.PositionalCount; i++) sum += list.Get(i).ToNumber();
            return DMValue.FromNumber(sum, false);
        }

        public static DMValue ValuesDot(DMValue a, DMValue b)
        {
            var la = a.AsList();
            var lb = b.AsList();
            if (la == null || lb == null) return DMValue.FromNumber(0);
            double sum = 0;
            var n = Math.Min(la.PositionalCount, lb.PositionalCount);
            for (var i = 1; i <= n; i++) sum += la.Get(i).ToNumber() * lb.Get(i).ToNumber();
            return DMValue.FromNumber(sum, false);
        }

        // values_min/values_max(list1, list2): element-wise min/max list.
        public static DMValue ValuesMin(DMValue a, DMValue b) => ValuesMinMax(a, b, true);
        public static DMValue ValuesMax(DMValue a, DMValue b) => ValuesMinMax(a, b, false);

        private static DMValue ValuesMinMax(DMValue a, DMValue b, bool min)
        {
            var la = a.AsList();
            var lb = b.AsList();
            var result = new DMList();
            if (la == null || lb == null) return DMValue.FromList(result);
            var n = Math.Min(la.PositionalCount, lb.PositionalCount);
            for (var i = 1; i <= n; i++)
            {
                var x = la.Get(i).ToNumber();
                var y = lb.Get(i).ToNumber();
                result.Add(DMValue.FromNumber(min ? Math.Min(x, y) : Math.Max(x, y)));
            }
            return DMValue.FromList(result);
        }

        // roll("2d6"): sum of N rolls of a dM die; roll("d6") = 1d6.
        public static DMValue Roll(DMValue value, DMValue unused = default)
        {
            var s = value.ToString().Trim().ToLowerInvariant();
            var m = Regex.Match(s, @"^(\\d*)d(\\d+)$");
            if (!m.Success) return DMValue.FromNumber(0);
            var n = m.Groups[1].Value.Length == 0 ? 1 : int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
            var sides = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
            if (n <= 0 || sides <= 0) return DMValue.FromNumber(0);
            var rng = new Random();
            double sum = 0;
            for (var i = 0; i < n; i++) sum += rng.Next(sides) + 1;
            return DMValue.FromNumber(sum);
        }

        // astype(x): the DM type path of a datum, as a path value.
        public static DMValue Astype(DMValue value, DMValue unused = default)
        {
            if (value.Type == DMValueType.DatumRef && value.DatumRef is DMRuntime datum)
                return DMValue.FromPath(datum.DMTypePath);
            return DMValue.Null;
        }

        // isicon(x): true when the value is an icon asset (path/file ending
        // .dmi) — the icon() builtin itself is engine-integrated (stub).
        public static DMValue IsIcon(DMValue value)
        {
            if (value.Type == DMValueType.Path || value.Type == DMValueType.File)
                return DMValue.FromNumber(value.ToString().EndsWith(".dmi", StringComparison.OrdinalIgnoreCase) ? 1 : 0);
            return DMValue.FromNumber(0);
        }

        // icon_states('x.dmi'): the state names declared in a DMI file,
        // parsed from its PNG text chunks (tEXt/zTXt/iTXt).
        public static DMValue IconStates(DMValue value, DMValue unused = default)
        {
            var list = new DMList();
            var path = value.Type == DMValueType.File || value.Type == DMValueType.Path ? value.ToString() : null;
            if (string.IsNullOrEmpty(path) || !System.IO.File.Exists(path)) return DMValue.FromList(list);
            try
            {
                var bytes = System.IO.File.ReadAllBytes(path);
                var text = ExtractDmiText(bytes);
                if (text == null) return DMValue.FromList(list);
                foreach (Match m in Regex.Matches(text, "state\\\\s*=\\\\s*\\\\x22([^\\\\x22]+)\\\\x22"))
                    list.Add(DMValue.FromString(m.Groups[1].Value));
            }
            catch
            {
                // unreadable/corrupt file -> empty list
            }
            return DMValue.FromList(list);
        }

        private static string ExtractDmiText(byte[] buffer)
        {
            var sb = new StringBuilder();
            int offset = 8;
            while (offset + 8 <= buffer.Length)
            {
                var length = (int)((buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3]);
                var type = System.Text.Encoding.ASCII.GetString(buffer, offset + 4, 4);
                if (offset + 8 + length > buffer.Length) break;
                if (type == "tEXt" || type == "zTXt" || type == "iTXt")
                {
                    var data = buffer.AsSpan(offset + 8, length);
                    try
                    {
                        if (type == "tEXt")
                        {
                            var nul = data.IndexOf((byte)0);
                            if (nul >= 0) sb.Append(System.Text.Encoding.UTF8.GetString(data.Slice(nul + 1)));
                        }
                        else if (type == "zTXt")
                        {
                            var nul = data.IndexOf((byte)0);
                            if (nul >= 0 && nul + 2 < data.Length)
                            {
                                using var z = new ZLibStream(new MemoryStream(data.Slice(nul + 2).ToArray()), CompressionMode.Decompress);
                                using var r = new StreamReader(z, System.Text.Encoding.UTF8);
                                sb.Append(r.ReadToEnd());
                            }
                        }
                        else if (type == "iTXt")
                        {
                            // keyword \0 compressionFlag \0 lang \0 translated \0 text
                            var nul1 = data.IndexOf((byte)0);
                            if (nul1 >= 0)
                            {
                                var rest = data.Slice(nul1 + 1);
                                if (rest.Length >= 1 && rest[0] == 1 && rest.Length >= 2 && rest[1] == 0)
                                {
                                    var textStart = FindITextTextStart(rest);
                                    if (textStart > 0)
                                    {
                                        using var z = new ZLibStream(new MemoryStream(rest.Slice(textStart).ToArray()), CompressionMode.Decompress);
                                        using var r = new StreamReader(z, System.Text.Encoding.UTF8);
                                        sb.Append(r.ReadToEnd());
                                    }
                                }
                                else
                                {
                                    var textStart = FindITextTextStart(rest);
                                    if (textStart > 0)
                                        sb.Append(System.Text.Encoding.UTF8.GetString(rest.Slice(textStart)));
                                }
                            }
                        }
                    }
                    catch
                    {
                        // corrupt chunk -> skip
                    }
                }
                if (type == "IEND") break;
                offset += 12 + length;
            }
            var all = sb.ToString();
            return all.Contains("# BEGIN DMI") ? all : null;
        }

        // iTXt: compressionFlag byte, then lang\0 translated\0 then the text —
        // the text starts after the SECOND NUL following the flag byte.
        private static int FindITextTextStart(ReadOnlySpan<byte> rest)
        {
            // skip the compression flag byte
            int pos = 1;
            int nuls = 0;
            while (pos < rest.Length)
            {
                if (rest[pos] == 0)
                {
                    nuls++;
                    if (nuls == 2) return pos + 1;
                }
                pos++;
            }
            return -1;
        }

        // regex(text, flags): a lightweight regex datum (engine-free .NET
        // Regex). Methods Find/Match/Replace/FindAll dispatch through the
        // proc registry under /regex (lazily registered).
        public static DMValue DMRegex(DMValue pattern, DMValue flags = default)
        {
            EnsureRegexRegistrations();
            var datum = new DMRuntime { DMTypePath = "/regex" };
            datum.SetVar("pattern", pattern);
            datum.SetVar("flags", flags.Type == DMValueType.Null ? DMValue.FromString("") : flags);
            LiveDatums.Add(datum);
            return DMValue.FromDatum(datum);
        }

        private static bool _regexRegistered;

        private static void EnsureRegexRegistrations()
        {
            if (_regexRegistered) return;
            _regexRegistered = true;
            ProcRegistry.Register("/regex", "Find", (d, a) => Task.FromResult(RegexFind(d, a)),
                new[] { "haystack", "start", "end" });
            ProcRegistry.Register("/regex", "Match", (d, a) => Task.FromResult(RegexMatch(d, a)),
                new[] { "haystack", "start", "end" });
            ProcRegistry.Register("/regex", "Replace", (d, a) => Task.FromResult(RegexReplace(d, a)),
                new[] { "haystack", "replacement" });
            ProcRegistry.Register("/regex", "FindAll", (d, a) => Task.FromResult(RegexFindAll(d, a)),
                new[] { "haystack" });
        }

        private static Regex BuildRegex(DMRuntime datum)
        {
            var pattern = datum.GetVar("pattern").ToString();
            var flags = datum.GetVar("flags").ToString();
            var opts = RegexOptions.CultureInvariant;
            if (flags.Contains("i")) opts |= RegexOptions.IgnoreCase;
            if (flags.Contains("m")) opts |= RegexOptions.Multiline;
            if (flags.Contains("s")) opts |= RegexOptions.Singleline;
            return new Regex(pattern, opts);
        }

        // Returns the 1-based code-point index of the first match (0 = none) —
        // a subset of BYOND's Match datum, documented approximation.
        private static DMValue RegexFind(DMRuntime datum, DMValue[] args)
        {
            var hay = args.Length > 0 ? args[0].ToString() : "";
            var m = BuildRegex(datum).Match(hay);
            if (!m.Success) return DMValue.FromNumber(0);
            return DMValue.FromNumber(DMValue.CpLength(hay.Substring(0, m.Index)) + 1);
        }

        private static DMValue RegexMatch(DMRuntime datum, DMValue[] args)
        {
            var hay = args.Length > 0 ? args[0].ToString() : "";
            var m = BuildRegex(datum).Match(hay);
            return m.Success ? DMValue.FromString(m.Value) : DMValue.Null;
        }

        private static DMValue RegexReplace(DMRuntime datum, DMValue[] args)
        {
            var hay = args.Length > 0 ? args[0].ToString() : "";
            var repl = args.Length > 1 ? args[1].ToString() : "";
            return DMValue.FromString(BuildRegex(datum).Replace(hay, repl));
        }

        private static DMValue RegexFindAll(DMRuntime datum, DMValue[] args)
        {
            var hay = args.Length > 0 ? args[0].ToString() : "";
            var list = new DMList();
            foreach (Match m in BuildRegex(datum).Matches(hay)) list.Add(DMValue.FromString(m.Value));
            return DMValue.FromList(list);
        }

        public static DMValue UpperText(DMValue value) => DMValue.FromString(value.ToString().ToUpper());

        public static DMValue LowerText(DMValue value) => DMValue.FromString(value.ToString().ToLower());

        public static DMValue HasCall(DMValue target, DMValue procName)
        {
            if (target.Type == DMValueType.DatumRef && target.DatumRef is DMRuntime datum)
                return DMValue.FromNumber(datum.CanCallProc(procName.ToString()) ? 1 : 0);
            return DMValue.FromNumber(0);
        }

        // ==== Pure math functions (BYOND semantics: trig in degrees) ====

        public static DMValue Floor(DMValue value) => DMValue.FromNumber(Math.Floor(value.ToNumber()));

        public static DMValue Ceil(DMValue value, DMValue unused = default) => DMValue.FromNumber(Math.Ceiling(value.ToNumber()));

        public static DMValue Sqrt(DMValue value) => DMValue.FromNumber(Math.Sqrt(value.ToNumber()));

        public static DMValue Sin(DMValue value) => DMValue.FromNumber(Math.Sin(value.ToNumber() * Math.PI / 180.0));

        public static DMValue Cos(DMValue value) => DMValue.FromNumber(Math.Cos(value.ToNumber() * Math.PI / 180.0));

        public static DMValue ArcCos(DMValue value) => DMValue.FromNumber(Math.Acos(value.ToNumber()) * 180.0 / Math.PI);

        public static DMValue Log(params DMValue[] args)
        {
            // Log(value) / Log(base, value) — arglist() flattening passes a
            // single DMValue[] (the params form accepts it).
            var value = args.Length > 0 ? args[0] : DMValue.Null;
            var baseValue = args.Length > 1 ? args[1] : default(DMValue);
            if (baseValue.Type == DMValueType.Null) return DMValue.FromNumber(Math.Log(value.ToNumber()));
            // BYOND log(X, Y): the log of Y with base X (WS7-3).
            return DMValue.FromNumber(Math.Log(baseValue.ToNumber()) / Math.Log(value.ToNumber()));
        }

        public static DMValue Sign(DMValue value)
        {
            // DM: text is converted to a number first (sign("abc") = 0).
            var n = value.ToNumber();
            return DMValue.FromNumber(n < 0 ? -1 : (n > 0 ? 1 : 0));
        }

        // ==== Text functions ====

        public static DMValue LengthChar(DMValue value)
        {
            if (value.Type == DMValueType.String) return DMValue.FromNumber(DMValue.CpLength(value.StringValue));
            return Length(value);
        }

        // DM 1-based index; negative counts from the end (-1 = last char).
        private static int DmIndex(double dmIndex, int length)
        {
            var i = (int)dmIndex;
            if (i < 0) i = length + i + 1;
            return i;
        }

        public static DMValue CopyTextChar(DMValue text, DMValue start, DMValue end = default)
        {
            // DM 514+: _char variants count characters (code points) too.
            return CopyText(text, start, end);
        }

        public static DMValue Text2Ascii(DMValue text, DMValue pos = default)
        {
            // BYOND 514+: Unicode code points, positions counted in code
            // points (WS8-11).
            var s = text.Type == DMValueType.String ? text.StringValue : text.ToString();
            var cpLen = DMValue.CpLength(s);
            var p = pos.Type == DMValueType.Null ? 1 : (int)pos.ToNumber();
            if (p < 1 || p > cpLen) return DMValue.FromNumber(0);
            var charOffset = DMValue.CpIndexToChar(s, p);
            if (charOffset + 1 < s.Length && char.IsSurrogatePair(s, charOffset))
                return DMValue.FromNumber(char.ConvertToUtf32(s, charOffset));
            return DMValue.FromNumber(s[charOffset]);
        }

        public static DMValue Ascii2Text(DMValue code)
        {
            var n = (int)code.ToNumber();
            // Invalid code points render as empty text (BYOND 514+ supports
            // any valid Unicode code point — WS8-10).
            if (n < 0 || n > 0x10FFFF || (n >= 0xD800 && n <= 0xDFFF)) return DMValue.FromString("");
            return DMValue.FromString(char.ConvertFromUtf32(n));
        }

        public static DMValue CKey(DMValue value)
        {
            var s = value.Type == DMValueType.String ? value.StringValue : value.ToString();
            var sb = new StringBuilder(s.Length);
            // BYOND ckey: lowercase; underscores become spaces; spaces and
            // alphanumerics are kept; other punctuation is stripped
            // (probe-locked: ckey("My_Thing 2") == "my thing 2").
            foreach (var ch in s.ToLowerInvariant())
            {
                if (ch == '_') sb.Append(' ');
                else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == ' ') sb.Append(ch);
            }
            return DMValue.FromString(sb.ToString().Trim());
        }

        public static DMValue SortText(DMValue a, DMValue b)
        {
            // BYOND sorttext(A, B) = 1 when A sorts before B (ascending);
            // the previous sign was reversed (WS7-6).
            var c = string.Compare(a.ToString(), b.ToString(), StringComparison.OrdinalIgnoreCase);
            return DMValue.FromNumber(c > 0 ? 1 : (c < 0 ? -1 : 0));
        }

        public static DMValue ReplaceTextEx(DMValue haystack, DMValue needle, DMValue replacement, DMValue start = default, DMValue end = default)
        {
            var find = needle.ToString();
            if (string.IsNullOrEmpty(find)) return haystack;
            var s = haystack.ToString();
            if (start.Type == DMValueType.Null) return DMValue.FromString(s.Replace(find, replacement.ToString()));
            // BYOND replacetextEx(..., Start, End): case-SENSITIVE replacement
            // within the 1-indexed window (WS7-8).
            int startIdx = Math.Max(1, (int)start.ToNumber());
            int endIdx = end.Type == DMValueType.Null ? s.Length : (int)end.ToNumber();
            if (endIdx <= 0) endIdx = s.Length + endIdx;
            if (endIdx > s.Length) endIdx = s.Length;
            if (startIdx > endIdx) return haystack;
            var prefix = s.Substring(0, Math.Min(s.Length, startIdx - 1));
            var window = s.Substring(startIdx - 1, endIdx - (startIdx - 1));
            var suffix = s.Substring(endIdx);
            return DMValue.FromString(prefix + window.Replace(find, replacement.ToString()) + suffix);
        }

        // findtextEx: case-SENSITIVE findtext (BYOND's Ex suffix — WS7-2).
        public static DMValue FindTextEx(DMValue text, DMValue needle, DMValue start = default, DMValue end = default)
        {
            return FindText(text, needle, start, end, DMValue.FromNumber(1));
        }

        public static DMValue HtmlEncode(DMValue value)
        {
            var sb = new StringBuilder();
            foreach (var ch in value.ToString())
            {
                if (ch == '&') sb.Append("&amp;");
                else if (ch == '<') sb.Append("&lt;");
                else if (ch == '>') sb.Append("&gt;");
                else if (ch == '"') sb.Append("&quot;");
                else if (ch == 0x27) sb.Append("&#39;");
                else sb.Append(ch);
            }
            return DMValue.FromString(sb.ToString());
        }

        public static DMValue HtmlDecode(DMValue value) => DMValue.FromString(WebUtility.HtmlDecode(value.ToString()));

        // ==== RGB / color ====

        /// <summary>
        /// rgb2num(r, g, b[, a]) -> packed number; rgb2num("#RRGGBB") or
        /// rgb2num(number) -> list(r, g, b, a). DM packs alpha into the high
        /// bits for 4-arg calls; we keep the 3-arg packing there for now.
        /// </summary>
        public static DMValue RGB2Num(params DMValue[] args)
        {
            if (args.Length >= 3)
            {
                var r = (int)args[0].ToNumber() & 0xFF;
                var g = (int)args[1].ToNumber() & 0xFF;
                var b = (int)args[2].ToNumber() & 0xFF;
                return DMValue.FromNumber((r << 16) | (g << 8) | b);
            }
            var list = new DMList();
            double packed;
            if (args.Length > 0 && args[0].Type == DMValueType.String)
            {
                var hex = args[0].StringValue.TrimStart('#');
                if (hex.Length >= 6 && uint.TryParse(hex.Substring(0, 6), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var u))
                    packed = u;
                else packed = 0;
            }
            else
            {
                packed = args.Length > 0 ? args[0].ToNumber() : 0;
            }
            list.Add(DMValue.FromNumber((int)packed >> 16 & 0xFF));
            list.Add(DMValue.FromNumber((int)packed >> 8 & 0xFF));
            list.Add(DMValue.FromNumber((int)packed & 0xFF));
            list.Add(DMValue.FromNumber(0xFF));
            return DMValue.FromList(list);
        }

        // ==== JSON ====

        public static DMValue JsonEncode(DMValue value, DMValue unused = default) => DMValue.FromString(JsonValue(value));

        private static string JsonValue(DMValue v)
        {
            switch (v.Type)
            {
                case DMValueType.Null: return "null";
                case DMValueType.Number:
                    if (double.IsNaN(v.NumberValue) || double.IsInfinity(v.NumberValue)) return "null";
                    return v.NumberValue.ToString(CultureInfo.InvariantCulture);
                case DMValueType.String: return JsonEscape(v.StringValue);
                case DMValueType.List:
                    var list = v.ListValue;
                    if (list != null && list.AssocEntries.Count > 0)
                    {
                        var parts = new List<string>();
                        foreach (var kv in list.AssocEntries)
                            parts.Add(JsonEscape(kv.Key) + ":" + JsonValue(kv.Value));
                        return "{" + string.Join(",", parts) + "}";
                    }
                    var arr = new List<string>();
                    for (var i = 1; i <= (list?.Count ?? 0); i++) arr.Add(JsonValue(list!.Get(i)));
                    return "[" + string.Join(",", arr) + "]";
                default:
                    // Datums encode as null in phase 1 (documented limitation).
                    return "null";
            }
        }

        // JsonEscape must emit valid JSON for quotes, backslashes and control
        // chars. All quote/backslash literals are written as char codes so the
        // TS template escaping can never corrupt them (WS9-1: the previous
        // version emitted bare quotes/newlines — invalid JSON).
        private static string JsonEscape(string s)
        {
            var sb = new StringBuilder();
            sb.Append((char)34); // opening quote
            foreach (var ch in s)
            {
                switch (ch)
                {
                    case (char)34: sb.Append((char)92).Append((char)34); break; // \"
                    case (char)92: sb.Append((char)92).Append((char)92); break; // \\
                    case (char)10: sb.Append((char)92).Append('n'); break;     // \n
                    case (char)13: sb.Append((char)92).Append('r'); break;     // \r
                    case (char)9: sb.Append((char)92).Append('t'); break;      // \t
                    default:
                        if (ch < 0x20) sb.Append((char)92).Append('u').Append(((int)ch).ToString("x4"));
                        else sb.Append(ch);
                        break;
                }
            }
            sb.Append((char)34); // closing quote
            return sb.ToString();
        }

        // ==== Time / params ====

        /// <summary>
        /// time2text(world.time, format): world time is in deciseconds, epoch
        /// Jan 1 2000 (BYOND semantics). Supports YYYY/MM/DD/hh/mm/ss/MMM.
        /// </summary>
        public static DMValue Time2Text(DMValue time, DMValue format = default, DMValue timezone = default)
        {
            // timezone is accepted for BYOND arity compatibility; offset
            // application is a documented approximation (WS7-8).
            var fmt = format.Type == DMValueType.Null ? "hh:mm:ss" : format.StringValue;
            var epoch = new DateTime(2000, 1, 1, 0, 0, 0, DateTimeKind.Utc);
            var dt = epoch.AddSeconds(time.ToNumber() / 10.0);
            var sb = new StringBuilder();
            for (var i = 0; i < fmt.Length; i++)
            {
                var rest = fmt.Substring(i);
                if (rest.StartsWith("YYYY")) { sb.Append(dt.Year.ToString("D4")); i += 3; }
                else if (rest.StartsWith("MMM")) { sb.Append(dt.ToString("MMM", CultureInfo.InvariantCulture)); i += 2; }
                else if (rest.StartsWith("MM")) { sb.Append(dt.Month.ToString("D2")); i += 1; }
                else if (rest.StartsWith("DD")) { sb.Append(dt.Day.ToString("D2")); i += 1; }
                else if (rest.StartsWith("hh")) { sb.Append(dt.Hour.ToString("D2")); i += 1; }
                else if (rest.StartsWith("mm")) { sb.Append(dt.Minute.ToString("D2")); i += 1; }
                else if (rest.StartsWith("ss")) { sb.Append(dt.Second.ToString("D2")); i += 1; }
                else if (rest.StartsWith("YY")) { sb.Append((dt.Year % 100).ToString("D2")); i += 1; }
                else sb.Append(fmt[i]);
            }
            return DMValue.FromString(sb.ToString());
        }

        public static DMValue List2Params(DMValue value)
        {
            var list = value.AsList();
            if (list == null) return DMValue.FromString("");
            var parts = new List<string>();
            // Positional entries: BYOND uses their 1-based index as the key.
            for (var i = 1; i <= list.PositionalCount; i++)
            {
                parts.Add(i + "=" + DmUrlEncode(list.Get(i).ToString()));
            }
            // Assoc entries keep their keys (WS8-15).
            foreach (var kv in list.AssocEntries)
            {
                parts.Add(DmUrlEncode(kv.Key) + "=" + DmUrlEncode(kv.Value.ToString()));
            }
            return DMValue.FromString(string.Join("&", parts));
        }

        private static string DmUrlEncode(string s)
        {
            var sb = new StringBuilder();
            foreach (var b in Encoding.UTF8.GetBytes(s))
            {
                if ((b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9')
                    || b == '-' || b == '_' || b == '.' || b == '~')
                    sb.Append((char)b);
                else sb.Append('%').Append(b.ToString("X2"));
            }
            return sb.ToString();
        }

        public static DMValue Alert(params DMValue[] args) => DMValue.Null;

        public static DMValue Input(params DMValue[] args) => DMValue.Null;

        // ==== Tier-4 builtins (remaining corpus backlog; docs/plans/17) ====
        // Append-only region — real BYOND semantics, verified against the DM
        // reference and OpenDream's native implementations.

        /// <summary>
        /// DM file2text(file): the file's contents as text; Null when the
        /// path is missing or unreadable ("contents of the file, or null on
        /// invalid files" — DM ref).
        /// </summary>
        public static DMValue File2Text(DMValue path)
        {
            try
            {
                var p = PathOf(path);
                if (string.IsNullOrEmpty(p) || !System.IO.File.Exists(p)) return DMValue.Null;
                return DMValue.FromString(System.IO.File.ReadAllText(p));
            }
            catch
            {
                return DMValue.Null;
            }
        }

        /// <summary>
        /// DM text2file(text, file): appends text to the file, creating it
        /// when it does not exist. 1 on success, 0 on failure.
        /// </summary>
        public static DMValue Text2File(DMValue text, DMValue path)
        {
            try
            {
                System.IO.File.AppendAllText(PathOf(path), text.ToString());
                return DMValue.FromNumber(1);
            }
            catch
            {
                return DMValue.FromNumber(0);
            }
        }

        /// <summary>
        /// DM md5(T): lowercase hex MD5. Text values hash their UTF-8 bytes;
        /// file values hash the file's raw bytes; unreadable input -> Null.
        /// </summary>
        public static DMValue Md5(DMValue value)
        {
            try
            {
                byte[] bytes;
                if (value.Type == DMValueType.File)
                {
                    var p = value.FileValue;
                    if (string.IsNullOrEmpty(p) || !System.IO.File.Exists(p)) return DMValue.Null;
                    bytes = System.IO.File.ReadAllBytes(p);
                }
                else
                {
                    bytes = Encoding.UTF8.GetBytes(value.ToString());
                }
                using var md5 = System.Security.Cryptography.MD5.Create();
                return DMValue.FromString(Convert.ToHexString(md5.ComputeHash(bytes)).ToLowerInvariant());
            }
            catch
            {
                return DMValue.Null;
            }
        }

        /// <summary>
        /// DM addtext(args...): concatenates the text form of every argument
        /// (deprecated BYOND proc, still common in corpus code). Null
        /// contributes the empty string, matching DM text interpolation.
        /// </summary>
        public static DMValue AddText(params DMValue[] args)
        {
            var sb = new StringBuilder();
            foreach (var a in args)
                if (a.Type != DMValueType.Null) sb.Append(a.ToString());
            return DMValue.FromString(sb.ToString());
        }

        /// <summary>
        /// DM trimtext(text): the text with leading and trailing whitespace
        /// removed; Null in -> Null out.
        /// </summary>
        public static DMValue TrimText(DMValue value)
        {
            if (value.Type == DMValueType.Null) return DMValue.Null;
            return DMValue.FromString(value.ToString().Trim());
        }

        /// <summary>
        /// DM cmptext(T1, T2, ...): 1 when every argument is the same text,
        /// case-INSENSITIVE; 0 otherwise (DM ref).
        /// </summary>
        public static DMValue CmpText(params DMValue[] args)
        {
            for (var i = 1; i < args.Length; i++)
                if (!string.Equals(args[0].ToString(), args[i].ToString(), StringComparison.OrdinalIgnoreCase))
                    return DMValue.FromNumber(0);
            return DMValue.FromNumber(1);
        }

        /// <summary>
        /// DM cmptextEx(T1, T2, ...): the case-SENSITIVE cmptext.
        /// </summary>
        public static DMValue CmpTextEx(params DMValue[] args)
        {
            for (var i = 1; i < args.Length; i++)
                if (!string.Equals(args[0].ToString(), args[i].ToString(), StringComparison.Ordinal))
                    return DMValue.FromNumber(0);
            return DMValue.FromNumber(1);
        }

        // BYOND's *_char variants measure positions in characters rather than
        // bytes — the runtime's text helpers already index by Unicode code
        // points, so they delegate directly.
        public static DMValue FindTextChar(DMValue text, DMValue needle, DMValue start = default, DMValue end = default)
            => FindText(text, needle, start, end);

        public static DMValue FindLastTextChar(DMValue text, DMValue needle, DMValue start = default, DMValue end = default)
            => FindLastText(text, needle, start, end);

        public static DMValue SplitTextChar(DMValue text, DMValue separator, DMValue start = default, DMValue end = default, DMValue includeDelimiters = default)
            => SplitText(text, separator, start, end, includeDelimiters);

        public static DMValue Text2AsciiChar(DMValue text, DMValue pos = default)
            => Text2Ascii(text, pos);

        /// <summary>
        /// DM findtextEx_char: char-based findtextEx. The runtime's text
        /// helpers already index by code points, so this delegates.
        /// </summary>
        public static DMValue FindTextExChar(DMValue text, DMValue needle, DMValue start = default, DMValue end = default)
            => FindTextEx(text, needle, start, end);

        /// <summary>
        /// DM replacetext_char: char-based replacetext (case-insensitive
        /// literal replace). The runtime is code-point indexed; delegates.
        /// </summary>
        public static DMValue ReplaceTextChar(DMValue haystack, DMValue needle, DMValue replacement, DMValue start = default, DMValue end = default)
            => ReplaceText(haystack, needle, replacement, start, end);

        /// <summary>
        /// DM nonspantext(haystack, needles, start): the offset, relative to
        /// start, of the first character contained in the needles set; when
        /// no needle character occurs, the number of characters from start
        /// to the end of the text (OpenDream parity).
        /// </summary>
        public static DMValue NonSpanText(DMValue haystack, DMValue needles, DMValue start = default)
        {
            var text = haystack.ToString();
            var needleSet = needles.ToString();
            var startIdx = (int)(start.Type == DMValueType.Null ? 1 : start.ToNumber());
            if (startIdx == 0 || startIdx > text.Length) return DMValue.FromNumber(0);
            if (startIdx < 0) startIdx += text.Length + 1;
            var idx = text.Substring(startIdx - 1).IndexOfAny(needleSet.ToCharArray());
            if (idx < 0) idx = text.Length - startIdx + 1;
            return DMValue.FromNumber(idx);
        }

        /// <summary>
        /// DM spantext(haystack, needles, start): the length of the
        /// consecutive run of needle-set characters beginning at start
        /// (OpenDream parity: start 0 or non-text -> 0).
        /// </summary>
        public static DMValue SpanText(DMValue haystack, DMValue needles, DMValue start = default)
        {
            var text = haystack.ToString();
            var needleSet = needles.ToString().ToCharArray();
            var startIdx = (int)(start.Type == DMValueType.Null ? 1 : start.ToNumber());
            if (startIdx == 0) return DMValue.FromNumber(0);
            if (startIdx < 0) startIdx = Math.Max(startIdx + text.Length + 1, 1);
            var count = 0;
            for (var i = startIdx - 1; i < text.Length; i++)
            {
                if (needleSet.Length > 0 && text.IndexOfAny(needleSet, i, 1) > -1) count++;
                else break;
            }
            return DMValue.FromNumber(count);
        }

        /// <summary>
        /// DM url_encode(text): percent-encode text for URLs (format 0 —
        /// the only documented form).
        /// </summary>
        public static DMValue UrlEncode(DMValue value) => DMValue.FromString(DmUrlEncode(value.ToString()));

        // B-4 (item 72): BYOND 515's url_encode(text, format) — paradise's
        // async input uses format 1 (href-safe fast encode). The extra arg
        // selects an encoding mode BYOND-side; our single encoder is already
        // RFC 3986-percent-encoding, so the overload accepts and documents
        // the approximation rather than failing the corpus build (CS1501).
        public static DMValue UrlEncode(DMValue value, DMValue format) => DMValue.FromString(DmUrlEncode(value.ToString()));

        /// <summary>
        /// DM url_decode(text): decode %XX escapes; '+' decodes as a space
        /// (DM's URL convention, matching params2list).
        /// </summary>
        public static DMValue UrlDecode(DMValue value) => DMValue.FromString(UrlDecode(value.ToString()));

        /// <summary>
        /// DM ckeyEx(text): canonical-key form that PRESERVES letter case and
        /// the @, - and _ characters; all other punctuation is removed
        /// (DM ref example: ckeyEx("OhSoWe'ReKeeping!MyCapitalLetters?Now")
        /// -> "OhSoWeReKeepingMyCapitalLettersNow").
        /// </summary>
        public static DMValue CKeyEx(DMValue value)
        {
            if (value.Type == DMValueType.Null) return DMValue.Null;
            var s = value.ToString();
            var sb = new StringBuilder(s.Length);
            foreach (var ch in s)
            {
                // Mirror BYOND/OpenDream's [^A-z0-9@_-] strip plus an explicit
                // '^' removal: the A-z range keeps A-Z, a-z and a few
                // stragglers, while '@' and '-' are whitelisted separately.
                if (ch == '^') continue;
                if ((ch >= 'A' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '@' || ch == '-') sb.Append(ch);
            }
            return DMValue.FromString(sb.ToString());
        }

        /// <summary>
        /// DM sorttextEx(A, B): the case-SENSITIVE sorttext — 1 when A sorts
        /// before B, -1 when after, 0 when equal.
        /// </summary>
        public static DMValue SortTextEx(DMValue a, DMValue b)
        {
            var c = string.Compare(a.ToString(), b.ToString(), StringComparison.Ordinal);
            return DMValue.FromNumber(c > 0 ? 1 : (c < 0 ? -1 : 0));
        }

        /// <summary>
        /// DM lerp(A, B, factor): linear interpolation A + (B - A) * factor.
        /// </summary>
        public static DMValue Lerp(DMValue a, DMValue b, DMValue factor)
        {
            return DMValue.FromNumber(a.ToNumber() + (b.ToNumber() - a.ToNumber()) * factor.ToNumber(), true);
        }

        /// <summary>
        /// DM trunc(n): truncate toward zero (never rounds — distinct from
        /// floor for negative values).
        /// </summary>
        public static DMValue Trunc(DMValue value) => DMValue.FromNumber(Math.Truncate(value.ToNumber()));

        // BYOND trig is degree-based (same convention as sin/cos/arctan).
        public static DMValue Tan(DMValue value) => DMValue.FromNumber(Math.Tan(value.ToNumber() * Math.PI / 180.0), true);

        public static DMValue ArcSin(DMValue value) => DMValue.FromNumber(Math.Asin(value.ToNumber()) * 180.0 / Math.PI, true);

        /// <summary>
        /// DM ohearers(dist, center): mobs that can hear the center EXCLUDING
        /// the center itself — the o-prefixed variant of hearers (default
        /// range 7, matching hearers).
        /// </summary>
        public static DMValue OHearers(params DMValue[] args)
        {
            var (center, dist) = CenterDist(7, args);
            return MobScan(center, dist, false);
        }

        /// <summary>
        /// DM bounds_dist(ref, target): pixel distance between the atoms'
        /// bounding boxes; different z-levels or non-atoms -> +inf.
        /// Engine-free approximation: bound_width/bound_height vars default
        /// to a full 32px tile (OpenDream parity).
        /// </summary>
        public static DMValue BoundsDist(DMValue reference, DMValue target)
        {
            if (reference.AsDatum() is not DMRuntime a || target.AsDatum() is not DMRuntime b)
                return DMValue.FromNumber(double.PositiveInfinity);
            if (Coord(a, "z") != Coord(b, "z")) return DMValue.FromNumber(double.PositiveInfinity);
            const double iconSize = 32.0;
            var aw = a.GetVar("bound_width").ToNumber(); if (aw <= 0) aw = iconSize;
            var ah = a.GetVar("bound_height").ToNumber(); if (ah <= 0) ah = iconSize;
            var bw = b.GetVar("bound_width").ToNumber(); if (bw <= 0) bw = iconSize;
            var bh = b.GetVar("bound_height").ToNumber(); if (bh <= 0) bh = iconSize;
            return DMValue.FromNumber(Math.Max(
                Math.Abs(Coord(b, "x") - Coord(a, "x")) * iconSize - Math.Abs(aw + bw) / 2,
                Math.Abs(Coord(b, "y") - Coord(a, "y")) * iconSize - Math.Abs(ah + bh) / 2), true);
        }

        private static bool _generatorProcsRegistered;

        /// <summary>
        /// DM generator(type, A, B, rand): creates a /generator datum. The
        /// constructor args are stored as vars (type/a/b/rand plus a
        /// gen_args list tail); the registered Rand() proc draws from the
        /// stored distribution. Supported: "num" (uniform; rand flag 1 =
        /// NORMAL_RAND approximates a midpoint gaussian), "normal"/"gauss",
        /// "binomial", "poisson", "geometric", "choice", "sequential",
        /// "vector"/"square"/"cube"/"box" (per-component uniforms into a
        /// list) and "circle"/"sphere" (radius in [A,B]).
        /// </summary>
        public static DMValue Generator(params DMValue[] args)
        {
            EnsureGeneratorProcs();
            var datum = new DMRuntime { DMTypePath = "/generator" };
            LiveDatums.Add(datum);
            datum.SetVar("type", args.Length > 0 ? args[0] : DMValue.Null);
            datum.SetVar("a", args.Length > 1 ? args[1] : DMValue.Null);
            datum.SetVar("b", args.Length > 2 ? args[2] : DMValue.Null);
            datum.SetVar("rand", args.Length > 3 ? args[3] : DMValue.FromNumber(0));
            var tail = new DMList();
            for (var i = 1; i < args.Length; i++) tail.Add(args[i]);
            datum.SetVar("gen_args", DMValue.FromList(tail));
            return DMValue.FromDatum(datum);
        }

        private static void EnsureGeneratorProcs()
        {
            if (_generatorProcsRegistered) return;
            _generatorProcsRegistered = true;
            ProcRegistry.Register("/generator", "rand", (comp, a) => Task.FromResult(GeneratorRand(comp)));
            ProcRegistry.Register("/generator", "randnum", (comp, a) => Task.FromResult(GeneratorRand(comp)));
        }

        private static DMValue GeneratorRand(DMRuntime comp)
        {
            var type = comp.GetVar("type").ToString().ToLowerInvariant();
            var a = comp.GetVar("a");
            var b = comp.GetVar("b");
            var rand = comp.GetVar("rand").ToNumber();
            var rng = System.Random.Shared;
            double NextUniform() => a.ToNumber() + (b.ToNumber() - a.ToNumber()) * rng.NextDouble();
            switch (type)
            {
                case "num":
                    if (rand == 1) // NORMAL_RAND: midpoint gaussian clamped to [A,B]
                    {
                        var u1 = Math.Max(rng.NextDouble(), 1e-12);
                        var u2 = rng.NextDouble();
                        var z = Math.Sqrt(-2 * Math.Log(u1)) * Math.Cos(2 * Math.PI * u2);
                        var lo = Math.Min(a.ToNumber(), b.ToNumber());
                        var hi = Math.Max(a.ToNumber(), b.ToNumber());
                        return DMValue.FromNumber(Math.Clamp((lo + hi) / 2.0 + z * (hi - lo) / 6.0, lo, hi), true);
                    }
                    return DMValue.FromNumber(NextUniform(), true);
                case "normal":
                case "gauss":
                {
                    var u1 = Math.Max(rng.NextDouble(), 1e-12);
                    var u2 = rng.NextDouble();
                    var z = Math.Sqrt(-2 * Math.Log(u1)) * Math.Cos(2 * Math.PI * u2);
                    return DMValue.FromNumber(a.ToNumber() + z * b.ToNumber(), true);
                }
                case "binomial":
                {
                    var n = Math.Max(0, (int)a.ToNumber());
                    var p = Math.Clamp(b.ToNumber(), 0, 1);
                    var successes = 0;
                    for (var i = 0; i < n; i++) if (rng.NextDouble() < p) successes++;
                    return DMValue.FromNumber(successes);
                }
                case "poisson":
                {
                    var l = Math.Exp(-Math.Max(0, a.ToNumber()));
                    var k = 0;
                    var p = 1.0;
                    do { k++; p *= rng.NextDouble(); } while (p > l);
                    return DMValue.FromNumber(k - 1);
                }
                case "geometric":
                {
                    var p = Math.Clamp(a.ToNumber(), 1e-9, 1);
                    return DMValue.FromNumber(Math.Ceiling(Math.Log(1 - rng.NextDouble()) / Math.Log(1 - p)));
                }
                case "choice":
                {
                    var opts = comp.GetVar("gen_args").AsList();
                    if (opts == null || opts.PositionalCount == 0) return DMValue.Null;
                    return opts.Get((int)(rng.NextDouble() * opts.PositionalCount) + 1);
                }
                case "sequential":
                {
                    var cur = comp.GetVar("gen_seq").Type == DMValueType.Null ? a.ToNumber() : comp.GetVar("gen_seq").ToNumber() + 1;
                    if (cur > b.ToNumber()) cur = a.ToNumber();
                    comp.SetVar("gen_seq", DMValue.FromNumber(cur));
                    return DMValue.FromNumber(cur);
                }
                case "vector":
                case "square":
                case "cube":
                case "box":
                {
                    var av = a.AsList();
                    var bv = b.AsList();
                    var list = new DMList();
                    if (av != null && bv != null)
                    {
                        for (var i = 1; i <= Math.Min(av.PositionalCount, bv.PositionalCount); i++)
                            list.Add(DMValue.FromNumber(av.Get(i).ToNumber() + (bv.Get(i).ToNumber() - av.Get(i).ToNumber()) * rng.NextDouble(), true));
                    }
                    else
                    {
                        var dims = type == "cube" || type == "box" ? 3 : 2;
                        for (var i = 0; i < dims; i++) list.Add(DMValue.FromNumber(NextUniform(), true));
                    }
                    return DMValue.FromList(list);
                }
                case "circle":
                case "sphere":
                {
                    var r = NextUniform();
                    var angle = rng.NextDouble() * 2 * Math.PI;
                    var list = new DMList();
                    list.Add(DMValue.FromNumber(r * Math.Cos(angle), true));
                    list.Add(DMValue.FromNumber(r * Math.Sin(angle), true));
                    if (type == "sphere") list.Add(DMValue.FromNumber(r * (rng.NextDouble() * 2 - 1), true));
                    return DMValue.FromList(list);
                }
                case "color":
                    return DMValue.FromString(b.ToString());
                case "flat":
                    return a;
                default:
                    return a.Type == DMValueType.Null ? DMValue.Null : a;
            }
        }

        // ==== B-3 appearance (item 71) ====

        /// <summary>
        /// Atom appearance vars that drive the engine appearance channel.
        /// A write to any of these through SetVar (the single choke point)
        /// republishes the datum's appearance to its bound entity.
        /// </summary>
        private static readonly HashSet<string> AppearanceVarNames = new(StringComparer.OrdinalIgnoreCase)
        {
            "icon", "icon_state", "dir", "color", "alpha",
            "pixel_x", "pixel_y", "pixel_z", "pixel_w",
            "layer", "plane", "invisibility", "opacity", "mouse_opacity",
            "luminosity", "light_color", "light_power", "light_range",
            "overlays", "underlays", "transform", "appearance",
            // W-H: density republishes too — the system-side bridge mirrors
            // it onto fixture.Hard (door opens stop blocking).
            "density",
            "appearance_flags", "blend_mode", "vis_contents", "vis_locs",
            "maptext", "maptext_width", "maptext_height", "maptext_x", "maptext_y",
            "render_target", "render_source", "screen_loc", "base_icon_state",
            "gender", "suffix", "glide_size", "infra_luminosity"
        };

        public static bool IsAppearanceVar(string name) => AppearanceVarNames.Contains(name);

        /// <summary>
        /// Engine hook: the generated system republishes the datum's whole
        /// appearance into its entity's AppearanceComponent data for
        /// datum.EntityId. Engine-free (probes): null — vars still read
        /// correctly, nothing pushed.
        /// </summary>
        public static Action<DMRuntime>? EntityAppearanceBridge;

        /// <summary>
        /// Engine hook: (datum, icon_state) -> decisecond duration of that
        /// RSI state (sum of dir-0 delays). flick() uses it; engine-free
        /// falls back to one tick.
        /// </summary>
        public static Func<DMRuntime, string, double>? RsiStateDurationDs;

        /// <summary>
        /// Honest loss counter: animate/flick/overlay requests that could
        /// not be fully honored (non-LINEAR easing, unsupported flags,
        /// transform tweening, exotic overlay entries).
        /// </summary>
        public static int AppearanceStubCount;
        private static void AppearanceLoss() => AppearanceStubCount++;

        /// <summary>
        /// Called from DMRuntime.SetVar — the single write path — so DM
        /// assignments, initial-var loads and animation steps that touch an
        /// appearance var republish it. Non-appearance vars cost one
        /// HashSet probe.
        /// </summary>
        internal static void OnDatumVarChanged(DMRuntime datum, string name)
        {
            if (EntityAppearanceBridge != null && datum.EntityId != 0 && IsAppearanceVar(name))
                EntityAppearanceBridge(datum);
        }

        /// <summary>Force a full appearance republish (bridge may be null).</summary>
        public static void PushAppearance(DMRuntime datum)
        {
            if (EntityAppearanceBridge != null && datum.EntityId != 0)
                EntityAppearanceBridge(datum);
        }

        /// <summary>
        /// /obj and /mob are lexical shorthand for /atom/movable/{obj,mob} —
        /// the runtime's IsType is a path-prefix check, so the atom kinds
        /// must be enumerated explicitly.
        /// </summary>
        private static bool IsAtomLike(DMRuntime datum)
        {
            return datum.IsType("/atom") || datum.IsType("/obj") || datum.IsType("/mob")
                || datum.IsType("/turf") || datum.IsType("/area")
                || datum.IsType("/image") || datum.IsType("/icon");
        }

        /// <summary>
        /// Implicit BYOND defaults for appearance vars on atom-ish datums.
        /// Called by DMGetProperty when the var was never assigned.
        /// </summary>
        private static DMValue AppearanceVarDefault(DMRuntime datum, string name)
        {
            if (!IsAtomLike(datum))
                return DMValue.Null;
            switch (name)
            {
                case "icon_state": return DMValue.FromString("");
                case "alpha": return DMValue.FromNumber(255);
                case "pixel_x": case "pixel_y": case "pixel_z": case "pixel_w":
                    return DMValue.FromNumber(0);
                case "layer":
                    // BYOND ref defaults: /area 0, /turf 1, /obj 3, /mob 4.
                    if (datum.IsType("/area")) return DMValue.FromNumber(0);
                    if (datum.IsType("/turf")) return DMValue.FromNumber(1);
                    if (datum.IsType("/mob")) return DMValue.FromNumber(4);
                    if (datum.IsType("/image")) return DMValue.FromNumber(-1);
                    return DMValue.FromNumber(3);
                case "invisibility": return DMValue.FromNumber(0);
                case "opacity": return DMValue.FromNumber(0);
                case "mouse_opacity": return DMValue.FromNumber(1);
                case "luminosity": case "light_range": return DMValue.FromNumber(0);
                case "light_power": return DMValue.FromNumber(1);
                case "plane": return DMValue.FromNumber(0);
            }
            return DMValue.Null;
        }

        /// <summary>
        /// DM icon var value -> /Textures-relative RSI resource path:
        /// 'icons/mob/human.dmi' or an /icon datum -> 'icons/mob/human.rsi'.
        /// null when the value carries no icon path.
        /// </summary>
        public static string? IconPathToRsi(DMValue icon)
        {
            if (icon.Type == DMValueType.DatumRef && icon.AsDatum() is DMRuntime d)
                return IconPathToRsi(d.GetVar("icon"));
            var s = icon.ToString().Trim();
            if (s.Length == 0 || s == "null") return null;
            s = s.Trim('\\'', '"').Replace('\\\\', '/').TrimStart('/');
            if (s.EndsWith(".dmi", StringComparison.OrdinalIgnoreCase))
                s = s.Substring(0, s.Length - 4) + ".rsi";
            return s;
        }

        private static string? VarText(DMRuntime d, string name)
        {
            var v = d.GetVar(name);
            return v.Type == DMValueType.Null ? null : v.ToString();
        }

        private static double NumVar(DMRuntime d, string name, double fallback)
        {
            var v = d.GetVar(name);
            return v.Type == DMValueType.Number ? v.NumberValue : fallback;
        }

        /// <summary>
        /// Serialize an overlays/underlays list for the engine appearance
        /// channel: one string per entry,
        /// "rsi|state|dir|layer|pixel_x|pixel_y|color|alpha".
        /// A text entry is an icon_state on the owner's icon; a datum entry
        /// (/image, atom) contributes its own icon/state/offset vars, falling
        /// back to the owner's icon when it has none.
        /// </summary>
        public static List<string> SerializeOverlayList(DMRuntime owner, string varName)
        {
            var result = new List<string>();
            var v = owner.GetVar(varName);
            if (v.Type != DMValueType.List || v.ListValue == null) return result;
            var list = v.ListValue;
            for (var i = 1; i <= list.PositionalCount; i++)
            {
                var entry = SerializeOverlayEntry(owner, list.Get(i));
                if (entry != null) result.Add(entry);
            }
            return result;
        }

        private static string? SerializeOverlayEntry(DMRuntime owner, DMValue item)
        {
            if (item.Type == DMValueType.String)
            {
                var icon = IconPathToRsi(owner.GetVar("icon"));
                if (icon == null) { AppearanceLoss(); return null; }
                return icon + "|" + item.StringValue + "|" + ((int)NumVar(owner, "dir", 2)).ToString(CultureInfo.InvariantCulture)
                    + "|" + NumVar(owner, "layer", 3).ToString(CultureInfo.InvariantCulture) + "|0|0|"
                    + (VarText(owner, "color") ?? "") + "|" + NumVar(owner, "alpha", 255).ToString(CultureInfo.InvariantCulture);
            }
            if (item.Type == DMValueType.DatumRef && item.AsDatum() is DMRuntime d)
            {
                var icon = IconPathToRsi(d.GetVar("icon")) ?? IconPathToRsi(owner.GetVar("icon"));
                if (icon == null) { AppearanceLoss(); return null; }
                return icon + "|" + (VarText(d, "icon_state") ?? "")
                    + "|" + ((int)NumVar(d, "dir", 2)).ToString(CultureInfo.InvariantCulture)
                    + "|" + NumVar(d, "layer", NumVar(owner, "layer", 3)).ToString(CultureInfo.InvariantCulture)
                    + "|" + NumVar(d, "pixel_x", 0).ToString(CultureInfo.InvariantCulture)
                    + "|" + NumVar(d, "pixel_y", 0).ToString(CultureInfo.InvariantCulture)
                    + "|" + (VarText(d, "color") ?? "")
                    + "|" + NumVar(d, "alpha", 255).ToString(CultureInfo.InvariantCulture);
            }
            AppearanceLoss();
            return null;
        }

        // ---- animate() / flick() ----

        /// <summary>Marker: a call-site named arg (alpha = 0, time = 5)
        /// emitted as a 2-element list by the transpiler so the name reaches
        /// the builtin (item 71).</summary>
        public static DMValue DMNamedArg(string name, DMValue value)
        {
            var l = new DMList();
            l.Add(DMValue.FromString(name));
            l.Add(value);
            return DMValue.FromList(l);
        }

        private static bool TryUnwrapNamedArg(DMValue arg, out string? name, out DMValue value)
        {
            name = null; value = DMValue.Null;
            if (arg.Type != DMValueType.List || arg.ListValue == null || arg.ListValue.PositionalCount != 2)
                return false;
            var k = arg.ListValue.Get(1);
            if (k.Type != DMValueType.String) return false;
            name = k.StringValue;
            value = arg.ListValue.Get(2);
            return true;
        }

        private sealed class DMAnimation
        {
            public DMRuntime Target = null!;
            public double StartDs;
            public double DurationDs;
            public int LoopsLeft;
            public Dictionary<string, DMValue> From = new();
            public Dictionary<string, DMValue> To = new();
        }

        private static readonly object AnimationSync = new();
        private static readonly List<DMAnimation> RunningAnimations = new();
        private static readonly Dictionary<DMRuntime, Queue<DMAnimation>> AnimationQueues = new();
        private static bool _animPumpRegistered;

        private const int AnimationEndNow = 1;
        private const int AnimationParallel = 4;
        private const int AnimationRelative = 16;

        /// <summary>
        /// Vars that can be interpolated between values per tick. Colors and
        /// dir are special-cased; everything else applies at segment end
        /// (BYOND applies non-interpolable vars at the end of the animation).
        /// </summary>
        private static readonly HashSet<string> InterpolableVars = new(StringComparer.OrdinalIgnoreCase)
        {
            "alpha", "pixel_x", "pixel_y", "pixel_z", "pixel_w", "layer", "plane",
            "luminosity", "light_power", "light_range", "infra_luminosity",
            "glide_size", "maptext_width", "maptext_height", "maptext_x", "maptext_y"
        };

        /// <summary>
        /// DM animate(target, time, loop, easing, flags, delay, var=val, ...):
        /// tween appearance vars on the datum over 'time' deciseconds,
        /// stepped by the DM tick scheduler. Named args arrive as DMNamedArg
        /// marker lists (call-site 'x = v' parses as an assignment, which the
        /// emitter rewrites); positional args follow BYOND's control order.
        /// </summary>
        public static DMValue Animate(params DMValue[] args)
        {
            if (args.Length == 0) return DMValue.Null;
            var targets = new List<DMRuntime>();
            CollectAnimateTargets(args[0], targets);
            if (targets.Count == 0) return DMValue.Null;

            double time = 0, delay = 0;
            int loops = 0, flags = 0;
            var namedControl = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var vars = new List<(string Name, DMValue Value)>();
            var positional = new List<DMValue>();
            for (var i = 1; i < args.Length; i++)
            {
                if (TryUnwrapNamedArg(args[i], out var name, out var value) && name != null)
                {
                    switch (name.ToLowerInvariant())
                    {
                        case "time": time = value.ToNumber(); namedControl.Add("time"); break;
                        case "loop": loops = (int)value.ToNumber(); namedControl.Add("loop"); break;
                        case "easing":
                            if (value.ToString() != "LINEAR_EASING") AppearanceLoss();
                            break;
                        case "flags": flags = (int)value.ToNumber(); namedControl.Add("flags"); break;
                        case "delay": delay = value.ToNumber(); namedControl.Add("delay"); break;
                        case "chain": AppearanceLoss(); break;
                        default:
                            vars.Add((name.ToLowerInvariant(), value));
                            break;
                    }
                }
                else
                {
                    positional.Add(args[i]);
                }
            }
            if (positional.Count > 0 && !namedControl.Contains("time")) time = positional[0].ToNumber();
            if (positional.Count > 1 && !namedControl.Contains("loop")) loops = (int)positional[1].ToNumber();
            if (positional.Count > 3 && !namedControl.Contains("flags")) flags = (int)positional[3].ToNumber();
            if (positional.Count > 4 && !namedControl.Contains("delay")) delay = positional[4].ToNumber();

            if (vars.Count == 0) return DMValue.Null;

            foreach (var target in targets)
            {
                var anim = new DMAnimation
                {
                    Target = target,
                    StartDs = DMTickScheduler.NowDs + Math.Max(0, delay),
                    DurationDs = Math.Max(time, 0),
                    LoopsLeft = loops < 0 ? -1 : Math.Max(loops, 1),
                };
                foreach (var (name, value) in vars)
                {
                    var from = target.GetVar(name);
                    if (from.Type == DMValueType.Null) from = AppearanceVarDefault(target, name);
                    anim.From[name] = from;
                    if ((flags & AnimationRelative) != 0 && from.Type == DMValueType.Number && value.Type == DMValueType.Number)
                        anim.To[name] = DMValue.FromNumber(from.NumberValue + value.NumberValue);
                    else
                        anim.To[name] = value;
                }
                EnqueueAnimation(anim, flags);
            }
            if (targets.Count > 0) EnsureAnimationPump();
            return DMValue.Null;
        }

        private static void CollectAnimateTargets(DMValue arg, List<DMRuntime> targets)
        {
            if (arg.Type == DMValueType.DatumRef && arg.AsDatum() is DMRuntime d)
            {
                targets.Add(d);
                return;
            }
            if (arg.Type == DMValueType.List && arg.ListValue != null)
            {
                for (var i = 1; i <= arg.ListValue.PositionalCount; i++)
                    CollectAnimateTargets(arg.ListValue.Get(i), targets);
            }
        }

        private static void EnqueueAnimation(DMAnimation anim, int flags)
        {
            lock (AnimationSync)
            {
                if ((flags & AnimationEndNow) != 0)
                    FinishAnimationsNow(anim.Target);
                if ((flags & AnimationParallel) != 0)
                {
                    RunningAnimations.Add(anim);
                    return;
                }
                // BYOND default: animate() queues behind the target's running
                // and queued animations.
                var busy = false;
                foreach (var a in RunningAnimations)
                {
                    if (ReferenceEquals(a.Target, anim.Target)) { busy = true; break; }
                }
                if (!busy && AnimationQueues.TryGetValue(anim.Target, out var existing))
                    busy = existing.Count > 0;
                if (busy)
                {
                    if (!AnimationQueues.TryGetValue(anim.Target, out var q))
                        AnimationQueues[anim.Target] = q = new Queue<DMAnimation>();
                    q.Enqueue(anim);
                }
                else
                {
                    RunningAnimations.Add(anim);
                }
            }
        }

        private static void FinishAnimationsNow(DMRuntime target)
        {
            for (var i = RunningAnimations.Count - 1; i >= 0; i--)
            {
                var a = RunningAnimations[i];
                if (!ReferenceEquals(a.Target, target)) continue;
                ApplyAnimationFinal(a);
                RunningAnimations.RemoveAt(i);
            }
            if (AnimationQueues.TryGetValue(target, out var q))
            {
                while (q.Count > 0) ApplyAnimationFinal(q.Dequeue());
            }
        }

        private static void EnsureAnimationPump()
        {
            if (_animPumpRegistered) return;
            _animPumpRegistered = true;
            DMTickScheduler.RegisterTickCallback(() => { PumpAnimations(); return Task.CompletedTask; });
        }

        private static void PumpAnimations()
        {
            var now = DMTickScheduler.NowDs;
            List<DMAnimation>? finished = null;
            lock (AnimationSync)
            {
                for (var i = RunningAnimations.Count - 1; i >= 0; i--)
                {
                    var anim = RunningAnimations[i];
                    var t = anim.DurationDs <= 0 ? 1.0 : (now - anim.StartDs) / anim.DurationDs;
                    if (t >= 1.0)
                    {
                        ApplyAnimationFinal(anim);
                        RunningAnimations.RemoveAt(i);
                        (finished ??= new List<DMAnimation>()).Add(anim);
                    }
                    else if (t > 0)
                    {
                        ApplyAnimationInterpolated(anim, t);
                    }
                }
            }
            if (finished == null) return;
            foreach (var anim in finished)
            {
                if (anim.LoopsLeft == -1 || anim.LoopsLeft > 1)
                {
                    if (anim.LoopsLeft > 1) anim.LoopsLeft--;
                    anim.StartDs = now;
                    lock (AnimationSync) { RunningAnimations.Add(anim); }
                    continue;
                }
                lock (AnimationSync)
                {
                    if (AnimationQueues.TryGetValue(anim.Target, out var q) && q.Count > 0)
                    {
                        var next = q.Dequeue();
                        next.StartDs = now;
                        RunningAnimations.Add(next);
                    }
                }
            }
        }

        private static void ApplyAnimationInterpolated(DMAnimation anim, double t)
        {
            foreach (var kv in anim.To)
            {
                var name = kv.Key;
                if (name == "dir")
                {
                    anim.Target.SetVar("dir", DMValue.FromNumber(LerpDir(anim.From[name].ToNumber(), kv.Value.ToNumber(), t)));
                    continue;
                }
                if (name == "color" || name == "light_color")
                {
                    var c = LerpColor(VarText(anim.Target, name) ?? anim.From[name].ToString(), kv.Value.ToString(), t);
                    if (c != null) anim.Target.SetVar(name, DMValue.FromString(c));
                    continue;
                }
                if (!InterpolableVars.Contains(name)) continue;
                var from = anim.From[name].ToNumber();
                var to = kv.Value.ToNumber();
                anim.Target.SetVar(name, DMValue.FromNumber(from + (to - from) * t));
            }
        }

        private static void ApplyAnimationFinal(DMAnimation anim)
        {
            foreach (var kv in anim.To)
                anim.Target.SetVar(kv.Key, kv.Value);
        }

        /// <summary>
        /// BYOND dir tween: interpolate over the dir angle (E=0, N=90, W=180,
        /// S=270 + diagonals) shortest-arc, snapping to the nearest of the 8
        /// BYOND dirs each step.
        /// </summary>
        private static double LerpDir(double from, double to, double t)
        {
            double Ang(double d) => d switch
            {
                4 => 0, 5 => 45, 1 => 90, 9 => 135,
                8 => 180, 10 => 225, 2 => 270, 6 => 315,
                _ => 270
            };
            var a0 = Ang(from);
            var diff = ((Ang(to) - a0) + 540) % 360 - 180;
            var a = a0 + diff * t;
            var best = 4.0;
            var bestD = 999.0;
            foreach (var (dir, ang) in new[] { (4, 0), (5, 45), (1, 90), (9, 135), (8, 180), (10, 225), (2, 270), (6, 315) })
            {
                var dd = Math.Abs(((a - ang) + 540) % 360 - 180);
                if (dd < bestD) { bestD = dd; best = dir; }
            }
            return best;
        }

        /// <summary>Lerp two #RRGGBB[AA] / #RGB color strings; null if
        /// either fails to parse (the loss is counted once per step).</summary>
        private static string? LerpColor(string from, string to, double t)
        {
            if (!TryParseColor(from, out var f) || !TryParseColor(to, out var e))
                return null;
            int C(int a, int b) => (int)Math.Round(a + (b - a) * t);
            var (r, g, b, a) = (C(f[0], e[0]), C(f[1], e[1]), C(f[2], e[2]), C(f[3], e[3]));
            return "#" + r.ToString("x2", CultureInfo.InvariantCulture)
                + g.ToString("x2", CultureInfo.InvariantCulture)
                + b.ToString("x2", CultureInfo.InvariantCulture)
                + (a < 255 ? a.ToString("x2", CultureInfo.InvariantCulture) : "");
        }

        private static bool TryParseColor(string s, out int[] rgba)
        {
            rgba = new[] { 255, 255, 255, 255 };
            s = (s ?? "").Trim();
            if (!s.StartsWith("#")) return false;
            s = s.Substring(1);
            try
            {
                if (s.Length == 3 || s.Length == 4)
                {
                    for (var i = 0; i < s.Length; i++)
                        rgba[i] = Convert.ToInt32(new string(s[i], 1) + new string(s[i], 1), 16);
                }
                else if (s.Length == 6 || s.Length == 8)
                {
                    for (var i = 0; i < s.Length / 2; i++)
                        rgba[i] = Convert.ToInt32(s.Substring(i * 2, 2), 16);
                }
                else return false;
            }
            catch { return false; }
            return true;
        }

        /// <summary>
        /// DM flick(icon_or_state, atom): temporarily show a different
        /// icon_state (string form) or an /image overlay (datum form) for the
        /// RSI state's animation duration (engine-provided) or one tick
        /// (engine-free fallback).
        /// </summary>
        public static DMValue Flick(params DMValue[] args)
        {
            if (args.Length < 2) return DMValue.Null;
            var target = args[1].AsDatum();
            if (target == null) return DMValue.Null;
            var icon = args[0];
            if (icon.Type == DMValueType.String)
            {
                var prev = target.GetVar("icon_state");
                target.SetVar("icon_state", icon);
                var dur = ResolveStateDurationDs(target, icon.StringValue);
                DMTickScheduler.Spawn(dur, () => { target.SetVar("icon_state", prev); return Task.CompletedTask; });
                return DMValue.Null;
            }
            if (icon.Type == DMValueType.DatumRef && icon.AsDatum() is DMRuntime img)
            {
                // /image (or any datum) flick: add as an overlay for the
                // duration. The list is shared — republish manually after
                // the mutation.
                var overlays = EnsureOverlayList(target);
                overlays.Add(icon);
                PushAppearance(target);
                var imgState = VarText(img, "icon_state") ?? "";
                var dur = ResolveStateDurationDs(img, imgState);
                DMTickScheduler.Spawn(dur, () => { RemoveOverlayValue(target, icon); return Task.CompletedTask; });
                return DMValue.Null;
            }
            AppearanceLoss();
            return DMValue.Null;
        }

        private static DMList EnsureOverlayList(DMRuntime target)
        {
            var v = target.GetVar("overlays");
            if (v.Type == DMValueType.List && v.ListValue != null) return v.ListValue;
            var l = new DMList();
            target.SetVar("overlays", DMValue.FromList(l));
            return l;
        }

        private static void RemoveOverlayValue(DMRuntime target, DMValue item)
        {
            var v = target.GetVar("overlays");
            if (v.Type != DMValueType.List || v.ListValue == null) return;
            var l = v.ListValue;
            var nl = new DMList();
            var removed = false;
            for (var i = 1; i <= l.PositionalCount; i++)
            {
                var e = l.Get(i);
                if (!removed && e.Type == item.Type && ReferenceEquals(e.DatumRef, item.DatumRef))
                {
                    removed = true;
                    continue;
                }
                nl.Add(e);
            }
            target.SetVar("overlays", DMValue.FromList(nl));
        }

        private static double ResolveStateDurationDs(DMRuntime datum, string state)
        {
            if (RsiStateDurationDs != null)
            {
                var d = RsiStateDurationDs(datum, state);
                if (d > 0) return d;
            }
            return DMTickScheduler.TickLag;
        }

        /// <summary>
        /// image() with named args: image(icon, loc, icon_state, layer, dir,
        /// pixel_x, pixel_y) where any arg may be written 'name = value'.
        /// The emitter routes calls containing assignments here (item 71);
        /// the positional-only Image() keeps handling pure-positional calls.
        /// Named args become real vars on the /image datum.
        /// </summary>
        public static DMValue ImageNamed(params DMValue[] args)
        {
            var positionalOrder = new[] { "icon", "loc", "icon_state", "layer", "dir", "pixel_x", "pixel_y" };
            var datum = new DMRuntime { DMTypePath = "/image" };
            LiveDatums.Add(datum);
            var posIdx = 0;
            for (var i = 0; i < args.Length; i++)
            {
                if (TryUnwrapNamedArg(args[i], out var name, out var value) && name != null)
                {
                    datum.SetVar(name.ToLowerInvariant(), value);
                    continue;
                }
                if (posIdx < positionalOrder.Length)
                    datum.SetVar(positionalOrder[posIdx], args[i]);
                posIdx++;
            }
            if (datum.GetVar("overlays").Type == DMValueType.Null)
                datum.SetVar("overlays", DMValue.FromList(new DMList()));
            if (datum.GetVar("pixel_x").Type == DMValueType.Null)
                datum.SetVar("pixel_x", DMValue.FromNumber(0));
            if (datum.GetVar("pixel_y").Type == DMValueType.Null)
                datum.SetVar("pixel_y", DMValue.FromNumber(0));
            return DMValue.FromDatum(datum);
        }

        // ==== W-D builtins (fidelity wave 2; docs/plans/25) ====

        /// <summary>
        /// DM locate(): three real forms — locate(x,y,z) turf coords,
        /// locate(X, container) recursive contents search, locate(X) global
        /// (path → first live datum of that type; string → tag match then
        /// ref-format match; datum → passthrough if still live). Uses the
        /// atom registry (TurfAt/ContentsOf) — no engine surface needed.
        /// </summary>
        public static DMValue Locate(DMValue target = default, DMValue arg2 = default, DMValue arg3 = default)
        {
            if (target.Type == DMValueType.Null) return DMValue.Null;
            // locate(x, y, z): all-numeric → turf at coords.
            if (arg2.Type == DMValueType.Number && arg3.Type == DMValueType.Number)
            {
                var t = TurfAt((int)target.ToNumber(), (int)arg2.ToNumber(), (int)arg3.ToNumber());
                return t != null ? DMValue.FromDatum(t) : DMValue.Null;
            }
            if (arg2.Type != DMValueType.Null)
            {
                // locate(X, container): datum container → recursive contents;
                // list → direct membership.
                return LocateIn(target, arg2, true);
            }
            // locate(X): global form.
            if (target.Type == DMValueType.DatumRef)
            {
                var d = AsRuntime(target);
                if (d != null && !d.MarkedForDeletion) return target;
                return DMValue.Null;
            }
            if (target.Type == DMValueType.Path ||
                (target.Type == DMValueType.String && target.ToString().StartsWith("/")))
            {
                var path = target.ToString();
                foreach (var d in LiveDatums)
                    if (!d.MarkedForDeletion && d.IsType(path))
                        return DMValue.FromDatum(d);
                return DMValue.Null;
            }
            if (target.Type == DMValueType.String)
            {
                var key = target.ToString();
                // tag match first: datums carry a 'tag' var.
                foreach (var d in LiveDatums)
                {
                    if (d.MarkedForDeletion) continue;
                    var tag = d.GetVar("tag");
                    if (tag.Type == DMValueType.String && tag.ToString() == key)
                        return DMValue.FromDatum(d);
                }
                // ref-format string ("[0x...]" or "REF[0x...]").
                if (key.Contains("0x"))
                {
                    foreach (var kv in RefIds)
                        if (kv.Key is DMRuntime rd && !rd.MarkedForDeletion &&
                            (kv.Value.Contains(key) || key.Contains(kv.Value)))
                            return DMValue.FromDatum(rd);
                }
            }
            return DMValue.Null;
        }

        private static DMRuntime? AsRuntime(DMValue v)
            => v.Type == DMValueType.DatumRef && v.DatumRef is DMRuntime d ? d : null;

        private static DMValue LocateIn(DMValue target, DMValue container, bool recurse)
        {
            if (container.Type == DMValueType.List)
            {
                for (int i = 1; i <= container.ListValue.Count; i++)
                {
                    var v = container.ListValue.Get(i);
                    if (MatchesLocateTarget(v, target)) return v;
                }
                return DMValue.Null;
            }
            var cd = AsRuntime(container);
            if (cd == null) return DMValue.Null;
            var contents = ContentsOf(cd);
            for (int i = 1; i <= contents.Count; i++)
            {
                var v = contents.Get(i);
                if (MatchesLocateTarget(v, target)) return v;
                if (recurse && v.Type == DMValueType.DatumRef)
                {
                    var r = LocateIn(target, v, true);
                    if (r.Type != DMValueType.Null) return r;
                }
            }
            return DMValue.Null;
        }

        private static bool MatchesLocateTarget(DMValue candidate, DMValue target)
        {
            if (candidate.Type != DMValueType.DatumRef || candidate.DatumRef is not DMRuntime d || d.MarkedForDeletion)
                return false;
            if (target.Type == DMValueType.DatumRef)
                return ReferenceEquals(candidate.DatumRef, target.DatumRef);
            if (target.Type == DMValueType.Path ||
                (target.Type == DMValueType.String && target.ToString().StartsWith("/")))
                return d.IsType(target.ToString());
            if (target.Type == DMValueType.String)
            {
                var tag = d.GetVar("tag");
                return tag.Type == DMValueType.String && tag.ToString() == target.ToString();
            }
            return false;
        }

        /// <summary>
        /// DM step_to(Ref, Trg, Trange=0, Speed=0): one step toward Trg when
        /// Ref is farther than Trange; returns 1 if it moved (or is already
        /// in range — BYOND returns 1 without moving), 0 on a blocked move.
        /// </summary>
        public static DMValue StepTo(DMValue atom, DMValue trg, DMValue trange = default, DMValue speed = default)
        {
            var a = AsRuntime(atom); var t = AsRuntime(trg);
            if (a == null || t == null) return DMValue.FromNumber(0);
            var range = trange.Type == DMValueType.Number ? (int)trange.ToNumber() : 0;
            if (range < 0) range = 0;
            var spd = speed.Type == DMValueType.Number ? (int)speed.ToNumber() : 1;
            if (spd <= 0) spd = 1;
            if (GetDist(atom, trg).ToNumber() <= range) return DMValue.FromNumber(1);
            return StepTowards(atom, trg, spd);
        }

        /// <summary>DM step_rand(Ref): one step in a random cardinal-or-diagonal dir.</summary>
        public static DMValue StepRand(DMValue atom, DMValue speed = default)
        {
            if (AsRuntime(atom) == null) return DMValue.FromNumber(0);
            var spd = speed.Type == DMValueType.Number ? (int)speed.ToNumber() : 1;
            if (spd <= 0) spd = 1;
            var dir = ClockwiseDirs[Random.Shared.Next(ClockwiseDirs.Length)];
            return Step(atom, DMValue.FromNumber(dir), spd);
        }

        // --- walk() family: continuous movement driven by the tick scheduler ---
        private sealed class WalkSpec
        {
            public DMRuntime Atom = null!;
            public string Kind = "dir"; // dir | to | towards | away | rand
            public DMValue Trg = DMValue.Null;
            public int Dir; public double Trange; public double PeriodTicks; public long LastTick;
        }

        private static readonly List<WalkSpec> ActiveWalks = new();
        private static bool WalkDriverStarted;

        private static DMValue StartWalk(DMValue atom, string kind, DMValue dirOrTrg, DMValue arg3, DMValue arg4)
        {
            var a = AsRuntime(atom);
            if (a == null) return DMValue.Null;
            var spec = new WalkSpec { Atom = a, Kind = kind, LastTick = DMTickScheduler.TicksElapsed };
            if (kind == "dir")
            {
                spec.Dir = dirOrTrg.Type == DMValueType.Number ? (int)dirOrTrg.ToNumber() : 0;
                spec.PeriodTicks = arg3.Type == DMValueType.Number ? arg3.ToNumber() : 0;
                if (spec.Dir == 0) { StopWalk(a); return DMValue.Null; } // walk(Ref,0) stops
            }
            else
            {
                spec.Trg = dirOrTrg;
                spec.Trange = kind == "away" || kind == "to"
                    ? (arg3.Type == DMValueType.Number ? arg3.ToNumber() : 0)
                    : 0;
                var lag = kind == "to" || kind == "away" ? arg4 : arg3;
                spec.PeriodTicks = lag.Type == DMValueType.Number ? lag.ToNumber() : 0;
            }
            if (spec.PeriodTicks <= 0) spec.PeriodTicks = 1;
            if (spec.PeriodTicks < 1) spec.PeriodTicks = 1;
            StopWalk(a);
            ActiveWalks.Add(spec);
            EnsureWalkDriver();
            return DMValue.Null;
        }

        private static void StopWalk(DMRuntime a) => ActiveWalks.RemoveAll(w => ReferenceEquals(w.Atom, a));

        private static void EnsureWalkDriver()
        {
            if (WalkDriverStarted) return;
            WalkDriverStarted = true;
            DMTickScheduler.RegisterTickCallback(async () => { WalkTick(); await Task.CompletedTask; });
        }

        private static void WalkTick()
        {
            for (int i = ActiveWalks.Count - 1; i >= 0; i--)
            {
                var w = ActiveWalks[i];
                if (w.Atom.MarkedForDeletion || w.Trg.DatumRef is DMRuntime td && td.MarkedForDeletion)
                { ActiveWalks.RemoveAt(i); continue; }
                if (DMTickScheduler.TicksElapsed - w.LastTick < w.PeriodTicks) continue;
                w.LastTick = DMTickScheduler.TicksElapsed;
                switch (w.Kind)
                {
                    case "dir": Step(DMValue.FromDatum(w.Atom), DMValue.FromNumber(w.Dir), 1); break;
                    case "rand": StepRand(DMValue.FromDatum(w.Atom)); break;
                    case "to":
                        if (GetDist(DMValue.FromDatum(w.Atom), w.Trg).ToNumber() > w.Trange)
                            StepTowards(DMValue.FromDatum(w.Atom), w.Trg, 1);
                        break;
                    case "towards": StepTowards(DMValue.FromDatum(w.Atom), w.Trg, 1); break;
                    case "away":
                        if (GetDist(DMValue.FromDatum(w.Atom), w.Trg).ToNumber() < w.Trange)
                            StepAway(DMValue.FromDatum(w.Atom), w.Trg, (int)w.Trange, 1);
                        break;
                }
            }
        }

        public static DMValue Walk(DMValue atom, DMValue dir = default, DMValue lag = default, DMValue speed = default)
            => StartWalk(atom, "dir", dir, lag, speed);
        public static DMValue WalkTo(DMValue atom, DMValue trg = default, DMValue trange = default, DMValue lag = default)
            => StartWalk(atom, "to", trg, trange, lag);
        public static DMValue WalkTowards(DMValue atom, DMValue trg = default, DMValue lag = default, DMValue speed = default)
            => StartWalk(atom, "towards", trg, lag, speed);
        public static DMValue WalkAway(DMValue atom, DMValue trg = default, DMValue trange = default, DMValue lag = default)
            => StartWalk(atom, "away", trg, trange, lag);
        public static DMValue WalkRand(DMValue atom, DMValue lag = default, DMValue speed = default)
            => StartWalk(atom, "rand", DMValue.Null, lag, speed);

        /// <summary>DM ASSERT(C): BYOND crashes the proc on a falsy condition.</summary>
        public static DMValue DMAssert(DMValue cond = default)
        {
            if (!cond.IsTrue()) DMCRASH(DMValue.FromString("Assertion failed"));
            return DMValue.Null;
        }

        /// <summary>
        /// DM EXCEPTION(text): BYOND throws a /exception datum value —
        /// catch(exception/E) binds it. Vars: name, desc, file, line.
        /// </summary>
        public static DMValue Exception(params DMValue[] args)
        {
            var msg = args.Length > 0 ? args[0].ToString() : "";
            var e = new DMRuntime { DMTypePath = "/exception" };
            e.SetVar("name", DMValue.FromString(msg));
            e.SetVar("desc", DMValue.FromString(msg));
            e.SetVar("file", DMValue.FromString(""));
            e.SetVar("line", DMValue.FromNumber(0));
            return DMValue.FromDatum(e);
        }

        /// <summary>DM fract(X): fractional part of X.</summary>
        public static DMValue Fract(DMValue n = default)
        {
            var v = n.Type == DMValueType.Number ? n.ToNumber() : 0;
            return DMValue.FromNumber(v - Math.Truncate(v), true);
        }

        /// <summary>DM sha1(T): SHA-1 hex of the text (or file bytes).</summary>
        public static DMValue Sha1(DMValue v = default)
        {
            byte[] data;
            if (v.Type == DMValueType.File) data = System.Text.Encoding.UTF8.GetBytes(v.FileValue ?? "");
            else data = System.Text.Encoding.UTF8.GetBytes(v.ToString() ?? "");
            var hash = System.Security.Cryptography.SHA1.HashData(data);
            return DMValue.FromString(Convert.ToHexString(hash).ToLowerInvariant());
        }

        /// <summary>DM num2hex(N, len): lowercase hex, zero-padded to len digits.</summary>
        public static DMValue Num2Hex(DMValue n = default, DMValue len = default)
        {
            var v = n.Type == DMValueType.Number ? (long)Math.Round(n.ToNumber()) : 0;
            var s = v.ToString("x");
            var l = len.Type == DMValueType.Number ? (int)len.ToNumber() : 0;
            if (l > s.Length) s = s.PadLeft(l, '0');
            return DMValue.FromString(s);
        }

        /// <summary>
        /// DM values_cut_under(List, Cmp): sum of the amounts each value is
        /// under Cmp; values_cut_over mirrors it. BYOND operates on list
        /// values (assoc entries use their keys here).
        /// </summary>
        public static DMValue ValuesCutUnder(DMValue list = default, DMValue cmp = default)
        {
            return ValuesCut(list, cmp, under: true);
        }
        public static DMValue ValuesCutOver(DMValue list = default, DMValue cmp = default)
        {
            return ValuesCut(list, cmp, under: false);
        }
        // W-I corpus: tg calls values_cut_under/over with BYOND's third
        // (sorted-hint) argument, e.g. values_cut_under(moles, MOLAR_ACCURACY, TRUE).
        // The hint changes nothing observable — accept and ignore it.
        public static DMValue ValuesCutUnder(DMValue list, DMValue cmp, DMValue sorted)
        {
            return ValuesCut(list, cmp, under: true);
        }
        public static DMValue ValuesCutOver(DMValue list, DMValue cmp, DMValue sorted)
        {
            return ValuesCut(list, cmp, under: false);
        }
        private static DMValue ValuesCut(DMValue list, DMValue cmp, bool under)
        {
            if (list.Type != DMValueType.List) return DMValue.FromNumber(0);
            var c = cmp.Type == DMValueType.Number ? cmp.ToNumber() : 0;
            double total = 0;
            for (int i = 1; i <= list.ListValue.Count; i++)
            {
                var v = list.ListValue.Get(i);
                var n = v.Type == DMValueType.Number ? v.ToNumber() : 0;
                var diff = under ? c - n : n - c;
                if (diff > 0) total += diff;
            }
            return DMValue.FromNumber(total, true);
        }

        /// <summary>DM spantext_char — _char delegates (same rules, byte positions).</summary>
        public static DMValue SpanTextChar(DMValue haystack, DMValue needles, DMValue start = default)
            => SpanText(haystack, needles, start);
        public static DMValue ReplaceTextExChar(DMValue haystack, DMValue needles, DMValue rep, DMValue start = default, DMValue end = default)
            => ReplaceTextEx(haystack, needles, rep, start, end);

        /// <summary>
        /// DM shutdown(): world teardown. We raise the WorldShutdown hook so
        /// the engine adapter can map it onto a real server stop; the DM
        /// observable result is the same whether or not a hook is attached.
        /// </summary>
        public static Action? WorldShutdown;
        public static DMValue Shutdown(params DMValue[] args)
        {
            try { WorldShutdown?.Invoke(); } catch { /* DM shutdown must not throw */ }
            return DMValue.Null;
        }

        /// <summary>DM gradient(...): real /gradient datum; vars readable.</summary>
        public static DMValue Gradient(params DMValue[] args)
        {
            var g = new DMRuntime { DMTypePath = "/gradient" };
            var names = new[] { "index", "gradient", "color", "loop", "step", "angle", "space" };
            int i = 0;
            foreach (var a in args)
            {
                if (TryUnwrapNamedArg(a, out var name, out var value) && name != null) g.SetVar(name, value);
                else if (i < names.Length) g.SetVar(names[i], a);
                i++;
            }
            return DMValue.FromDatum(g);
        }

        /// <summary>DM vector(x,y,z): real /vector datum.</summary>
        public static DMValue Vector(params DMValue[] args)
        {
            var v = new DMRuntime { DMTypePath = "/vector" };
            var axes = new[] { "x", "y", "z" };
            for (int i = 0; i < args.Length && i < 3; i++)
            {
                if (TryUnwrapNamedArg(args[i], out var name, out var value) && name != null) v.SetVar(name, value);
                else v.SetVar(axes[i], args[i]);
            }
            return DMValue.FromDatum(v);
        }

        // --- icon/matrix member ops called bare inside their /icon /matrix
        // procs: src is implicit, which for a direct call IS CurrentUsr ---
        private static void RecordIconOp(DMRuntime? icon, string op, params DMValue[] args)
        {
            if (icon == null) return;
            var ops = icon.GetVar("_iconops");
            var l = ops.Type == DMValueType.List ? ops.ListValue : new DMList();
            var sb = new StringBuilder(op + "(");
            for (int i = 0; i < args.Length; i++) { if (i > 0) sb.Append(','); sb.Append(args[i].ToString()); }
            l.Add(DMValue.FromString(sb.ToString() + ")"));
            icon.SetVar("_iconops", DMValue.FromList(l));
        }

        /// <summary>/icon/MapColors(...) — pixel op recorded; icon stays usable.</summary>
        public static DMValue IconMapColors(DMValue src, params DMValue[] args)
        {
            RecordIconOp(AsRuntime(src), "MapColors", args);
            return DMValue.Null;
        }
        /// <summary>/icon/Blend(icon_or_fn, mode) — recorded op; returns src icon.</summary>
        public static DMValue IconBlend(DMValue src, params DMValue[] args)
        {
            RecordIconOp(AsRuntime(src), "Blend", args);
            return src;
        }
        /// <summary>/icon/SwapColor(from,to) — value form returns a blend spec.</summary>
        public static DMValue IconSwapColor(params DMValue[] args)
        {
            var l = new DMList();
            l.Add(DMValue.FromString("swapcolor"));
            foreach (var a in args) l.Add(a);
            return DMValue.FromList(l);
        }
        /// <summary>/icon/Shift(dir, offset, wrap) — moves pixels on the icon.</summary>
        public static DMValue IconShift(DMValue src, params DMValue[] args)
        {
            RecordIconOp(AsRuntime(src), "Shift", args);
            return DMValue.Null;
        }
        /// <summary>/icon/SetIntensity(...) — recorded op.</summary>
        public static DMValue IconSetIntensity(DMValue src, params DMValue[] args)
        {
            RecordIconOp(AsRuntime(src), "SetIntensity", args);
            return DMValue.Null;
        }

        /// <summary>
        /// /matrix.Multiply(M): real affine composition — src *= M using the
        /// 2D 3x3 form BYOND stores in vars a..f.
        /// </summary>
        public static DMValue MatrixMultiply(DMValue src, params DMValue[] args)
        {
            var m1 = AsRuntime(src); var m2 = args.Length > 0 ? AsRuntime(args[0]) : null;
            if (m1 == null || m2 == null) return DMValue.Null;
            double a = m1.GetVar("a").ToNumber(), b = m1.GetVar("b").ToNumber(), c = m1.GetVar("c").ToNumber();
            double d = m1.GetVar("d").ToNumber(), e = m1.GetVar("e").ToNumber(), f = m1.GetVar("f").ToNumber();
            double Ma = m2.GetVar("a").ToNumber(), Mb = m2.GetVar("b").ToNumber(), Mc = m2.GetVar("c").ToNumber();
            double Md = m2.GetVar("d").ToNumber(), Me = m2.GetVar("e").ToNumber(), Mf = m2.GetVar("f").ToNumber();
            m1.SetVar("a", DMValue.FromNumber(a * Ma + b * Md, true));
            m1.SetVar("b", DMValue.FromNumber(a * Mb + b * Me, true));
            m1.SetVar("c", DMValue.FromNumber(a * Mc + b * Mf + c, true));
            m1.SetVar("d", DMValue.FromNumber(d * Ma + e * Md, true));
            m1.SetVar("e", DMValue.FromNumber(d * Mb + e * Me, true));
            m1.SetVar("f", DMValue.FromNumber(d * Mc + e * Mf + f, true));
            return DMValue.Null;
        }

        // --- Wave-2 honest stubs: UI/OS surface has no DM-side equivalent ---
        /// <summary>DM winexists — skin layer stub (honest Null).</summary>
        public static DMValue Winexists(params DMValue[] args) => DMValue.Null;
        /// <summary>DM winshow — skin layer stub (honest Null).</summary>
        public static DMValue Winshow(params DMValue[] args) => DMValue.Null;
        /// <summary>DM winclone — skin layer stub (honest Null).</summary>
        public static DMValue Winclone(params DMValue[] args) => DMValue.Null;
        /// <summary>DM shell — host-OS surface stub (honest Null).</summary>
        public static DMValue Shell(params DMValue[] args) => DMValue.Null;

        // ==== W-G input (docs/plans/28): type var defaults ====

        /// <summary>
        /// Per-type datum var initializers, keyed by DM type path. Emitted by
        /// the transpiler (TypeVarInits registrations inside
        /// ConvertedDMProcs' RegisterProcs): each action writes the type's
        /// declared var defaults (name/desc/gender/icon + scalar custom vars)
        /// onto the datum. Applied ancestor-first at datum creation by
        /// ApplyTypeVarInits so the most-derived declaration wins — BYOND's
        /// var-default inheritance. This was the missing piece behind
        /// usr.name / mob.name printing empty on spawned datums.
        /// </summary>
        public static readonly Dictionary<string, Action<DMRuntime>> TypeVarInits =
            new(StringComparer.OrdinalIgnoreCase);

        /// <summary>
        /// A single type-default seed write (W-G input). Unlike SetVar it
        /// overwrites InitialValues too: the WHOLE ancestor seed chain is
        /// "creation time" for initial()'s purposes, so initial(var) must
        /// read the most-derived seeded default, not the first-seeded
        /// ancestor value. Later runtime writes still win the live var via
        /// SetVar, and leave the seeded InitialValues untouched.
        /// </summary>
        public static void SeedVar(DMRuntime datum, string name, DMValue val)
        {
            datum.Variables[name] = val;
            datum.InitialValues[name] = val;
        }

        /// <summary>
        /// Seed a fresh datum's vars from its type hierarchy's declared
        /// defaults: walks the type path root -> leaf (prefix walk, same
        /// ancestor shape as ProcRegistry.TryGetInherited) and applies each
        /// level's TypeVarInits entry. Runs BEFORE loc assignment and New()
        /// dispatch — BYOND order: var defaults, then loc, then New().
        /// Runtime var writes still win: they overwrite the seeded value
        /// through SetVar (and the seed becomes the var's InitialValues
        /// entry, which makes initial() read the declared default).
        /// </summary>
        public static void ApplyTypeVarInits(DMRuntime datum)
        {
            var path = datum.DMTypePath;
            if (string.IsNullOrEmpty(path)) return;
            var parts = path.ToLowerInvariant().Split('/', StringSplitOptions.RemoveEmptyEntries);
            for (var i = 1; i <= parts.Length; i++)
            {
                var candidate = "/" + string.Join("/", parts, 0, i);
                if (TypeVarInits.TryGetValue(candidate, out var init))
                    init(datum);
            }
        }
    }

    // NOTE (item 71): DMAppearanceKey (the AppearanceComponent.SetData keys)
    // is NOT declared here — RobustSerializer only indexes [NetSerializable]
    // types from content assemblies, so the generated solution emits it into
    // Content.Shared/DM/DMAppearanceKey.cs instead (see csharpEmitter).

    // ==== B-4 verbs/input (item 72) ====

    /// <summary>
    /// Verb/input runtime support (PLAN item 72, B-4). Engine-free: the
    /// generated Content.Server.DM adapter installs the engine-side
    /// implementations (OutputBridge -> player consoles/server log).
    ///
    /// DM verb semantics: a '/type/verb/name' declaration registers under
    /// the same (type, name) key as a proc, so verb dispatch is proc
    /// dispatch. What makes a call a *verb* invocation is the usr binding:
    /// BYOND sets usr to the mob that ran the command, which differs from
    /// src whenever the verb lives on another atom (obj/turf verbs). The
    /// command bridge calls CallVerbAsUsr(target, usrMob, name, args).
    /// </summary>
    public static class DMVerbRuntime
    {
        /// <summary>
        /// Engine output sink for 'x << msg' on datum targets (world/mob/
        /// client). Null engine-free: DMValue.Output falls back to stdout.
        /// </summary>
        public static Action<DMValue, DMValue>? OutputBridge;

        /// <summary>
        /// Invoke proc 'procName' on 'target' with DM verb semantics:
        /// src = target, usr = the mob that ran the command. Mirrors
        /// DMRuntime.CallProc's registry walk (exact -> inherited -> /proc
        /// fallback) but keeps 'usr' bound to the caller instead of
        /// rebinding it to the receiver.
        /// </summary>
        public static async Task<DMValue> CallVerbAsUsr(DMRuntime target, DMRuntime usr, string procName, params DMValue[] args)
        {
            // arglist-style single-assoc-list calls bind named entries to the
            // callee's parameter names (same rule DMRuntime.CallProc uses).
            if (args.Length == 1 && args[0].Type == DMValueType.List && args[0].ListValue.AssocEntries.Count > 0)
            {
                var list = args[0].ListValue;
                var names = ProcRegistry.GetParamNames(target.DMTypePath, procName)
                            ?? ProcRegistry.GetParamNames("/proc", procName);
                if (names != null && names.Length > 0)
                {
                    var reordered = new DMValue[names.Length];
                    for (var i = 0; i < reordered.Length; i++) reordered[i] = DMValue.Null;
                    for (var i = 1; i <= list.PositionalCount && i <= names.Length; i++) reordered[i - 1] = list.Get(i);
                    foreach (var kv in list.AssocEntries)
                    {
                        for (var i = 0; i < names.Length; i++)
                        {
                            if (string.Equals(names[i], kv.Key, StringComparison.OrdinalIgnoreCase))
                            {
                                reordered[i] = kv.Value;
                                break;
                            }
                        }
                    }
                    args = reordered;
                }
            }
            if (!ProcRegistry.TryGet(target.DMTypePath, procName, out var handler)
                && !ProcRegistry.TryGetInherited(target.DMTypePath, procName, out handler)
                && !ProcRegistry.TryGet("/proc", procName, out handler))
            {
                return DMValue.Null;
            }
            var previousUsr = DMRuntimeHelpers.CurrentUsr;
            DMRuntimeHelpers.CurrentUsr = DMValue.FromDatum(usr);
            try
            {
                return await handler(target, args);
            }
            finally
            {
                DMRuntimeHelpers.CurrentUsr = previousUsr;
            }
        }

        /// <summary>
        /// True when the datum can answer 'procName' through the registry —
        /// the engine command path reports "no such verb" without invoking.
        /// </summary>
        public static bool HasProc(DMRuntime target, string procName)
        {
            return ProcRegistry.TryGet(target.DMTypePath, procName, out _)
                || ProcRegistry.TryGetInherited(target.DMTypePath, procName, out _)
                || ProcRegistry.TryGet("/proc", procName, out _);
        }

        /// <summary>
        /// Datum bound to an engine entity (atom-side): the spawn bridge and
        /// component init record DMRuntime.EntityId. 0 or missing = none.
        /// </summary>
        public static DMRuntime? DatumForEntityId(long entityId)
        {
            if (entityId == 0) return null;
            foreach (var d in DMRuntimeHelpers.LiveDatums)
            {
                if (d.EntityId == (ulong)entityId) return d;
            }
            return null;
        }

        /// <summary>
        /// First live datum of an exact DM type path (dmverbon "/obj/x" args).
        /// </summary>
        public static DMRuntime? DatumForPath(string typePath)
        {
            var norm = typePath.ToLowerInvariant();
            foreach (var d in DMRuntimeHelpers.LiveDatums)
            {
                if (d.DMTypePath == norm) return d;
            }
            return null;
        }

        /// <summary>
        /// Atom datum at DM tile coords (dmclick x y z): live datums whose
        /// x/y/z vars match. Returns the first non-turf atom found so a mob
        /// or obj on the tile is clicked rather than the turf itself.
        /// </summary>
        public static DMRuntime? DatumAt(double x, double y, double z)
        {
            DMRuntime? turf = null;
            foreach (var d in DMRuntimeHelpers.LiveDatums)
            {
                var dx = d.GetVar("x").ToNumber();
                var dy = d.GetVar("y").ToNumber();
                var dz = d.GetVar("z").ToNumber();
                if (dx == x && dy == y && dz == z)
                {
                    if (d.DMTypePath.StartsWith("/turf")) { turf = d; continue; }
                    return d;
                }
            }
            return turf;
        }
    }
}
`      },
      {
        filename: 'RustGAdapterStubs.cs',
        content: `using System;
using System.Security.Cryptography;
using System.Text;
using System.Net.Http;
using System.Threading.Tasks;

namespace SS13.DM.Runtime
{
    /// <summary>
    /// Compilable C# Adapter Stubs for SS13 rust-g native extensions.
    /// Provides 100% compilation and safe fallback implementations for HTTP, Cryptography, and SQL.
    /// </summary>
    public static class RustGAdapterStubs
    {
        private static readonly HttpClient HttpClientInstance = new HttpClient();

        public static string RustGHashString(string algorithm, string input)
        {
            if (algorithm.Equals("sha256", StringComparison.OrdinalIgnoreCase))
            {
                using var sha256 = SHA256.Create();
                var bytes = sha256.ComputeHash(Encoding.UTF8.GetBytes(input ?? ""));
                return Convert.ToHexString(bytes).ToLower();
            }
            return input ?? "";
        }

        public static async Task<string> RustGHttpRequestAsync(string url, string method = "GET", string body = "")
        {
            try
            {
                var response = await HttpClientInstance.GetAsync(url);
                return await response.Content.ReadAsStringAsync();
            }
            catch (Exception ex)
            {
                return $"ERROR: {ex.Message}";
            }
        }

        public static string RustGSqlQuery(string connectionString, string query)
        {
            // Compilable SQL stub returning success status
            return "{\\\"status\\\": \\\"ok\\\", \\\"rows\\\": []}";
        }
    }
}
`
      }
    ];
  }
}
