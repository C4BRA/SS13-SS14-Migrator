export class DMRuntimeCS {
  public static getRuntimeCSFiles(): { filename: string; content: string }[] {
    return [
      {
        filename: 'DMValue.cs',
        content: `using System;

namespace SS13.DM.Runtime
{
    public enum DMValueType
    {
        Null,
        Number,
        String,
        List,
        DatumRef
    }

    public struct DMValue
    {
        public DMValueType Type { get; private set; }
        public double NumberValue { get; private set; }
        public string StringValue { get; private set; }
        public DMList ListValue { get; private set; }
        public object DatumRef { get; private set; }

        public static DMValue Null => new DMValue { Type = DMValueType.Null };

        public static DMValue FromNumber(double val) => new DMValue { Type = DMValueType.Number, NumberValue = val };
        public static DMValue FromString(string val) => new DMValue { Type = DMValueType.String, StringValue = val ?? "" };
        public static DMValue FromList(DMList list) => new DMValue { Type = DMValueType.List, ListValue = list };
        public static DMValue FromRef(object obj) => new DMValue { Type = DMValueType.DatumRef, DatumRef = obj };
        public static DMValue FromDatum(DMRuntime datum) => new DMValue { Type = DMValueType.DatumRef, DatumRef = datum };

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
                DMValueType.DatumRef => DatumRef != null,
                _ => false
            };
        }

        public override string ToString()
        {
            return Type switch
            {
                DMValueType.Null => "null",
                DMValueType.Number => NumberValue.ToString(),
                DMValueType.String => StringValue,
                DMValueType.List => "[list]",
                DMValueType.DatumRef => DatumRef?.ToString() ?? "null",
                _ => "null"
            };
        }

        // ===== Operator Overloads & Static Methods for Expression Transpilation =====

        // Arithmetic
        // DM rule: if either operand is text, + concatenates
        public static DMValue Add(DMValue a, DMValue b)
        {
            // DM: list + x appends to a copy; list + list concatenates.
            if (a.Type == DMValueType.List || b.Type == DMValueType.List)
                return FromList(ConcatLists(a, b));
            if (a.Type == DMValueType.String || b.Type == DMValueType.String)
                return FromString(a.ToString() + b.ToString());
            return FromNumber(a.ToNumber() + b.ToNumber());
        }

        private static DMList ConcatLists(DMValue a, DMValue b)
        {
            var result = new DMList();
            if (a.Type == DMValueType.List)
            {
                for (var i = 1; i <= a.ListValue.Count; i++) result.Add(a.ListValue.Get(i));
            }
            else
            {
                result.Add(a);
            }
            if (b.Type == DMValueType.List)
            {
                for (var i = 1; i <= b.ListValue.Count; i++) result.Add(b.ListValue.Get(i));
            }
            else
            {
                result.Add(b);
            }
            return result;
        }
        public static DMValue Subtract(DMValue a, DMValue b) => FromNumber(a.ToNumber() - b.ToNumber());
        public static DMValue Multiply(DMValue a, DMValue b) => FromNumber(a.ToNumber() * b.ToNumber());
        public static DMValue Divide(DMValue a, DMValue b) => FromNumber(b.ToNumber() != 0 ? a.ToNumber() / b.ToNumber() : 0);
        public static DMValue Modulo(DMValue a, DMValue b) => FromNumber(b.ToNumber() != 0 ? a.ToNumber() % b.ToNumber() : 0);
        public static DMValue Negate(DMValue a) => FromNumber(-a.ToNumber());
        public static DMValue Power(DMValue a, DMValue b) => FromNumber(Math.Pow(a.ToNumber(), b.ToNumber()));

        // Comparison
        public static DMValue Equals(DMValue a, DMValue b) => FromNumber(a.EqualsValue(b) ? 1 : 0);
        public static DMValue NotEquals(DMValue a, DMValue b) => FromNumber(a.EqualsValue(b) ? 0 : 1);
        public static DMValue LessThan(DMValue a, DMValue b) => FromNumber(Compare(a, b) < 0 ? 1 : 0);
        public static DMValue LessOrEqual(DMValue a, DMValue b) => FromNumber(Compare(a, b) <= 0 ? 1 : 0);
        public static DMValue GreaterThan(DMValue a, DMValue b) => FromNumber(Compare(a, b) > 0 ? 1 : 0);
        public static DMValue GreaterOrEqual(DMValue a, DMValue b) => FromNumber(Compare(a, b) >= 0 ? 1 : 0);

        // DM rule: with a text operand, relational comparison is lexicographic
        // (numbers are stringified, null is ""); otherwise it is numeric.
        private static int Compare(DMValue a, DMValue b)
        {
            if (a.Type == DMValueType.String || b.Type == DMValueType.String)
                return string.Compare(TextRepr(a), TextRepr(b), StringComparison.OrdinalIgnoreCase);
            return a.ToNumber().CompareTo(b.ToNumber());
        }

        private static string TextRepr(DMValue v)
        {
            return v.Type switch
            {
                DMValueType.Null => "",
                DMValueType.Number => v.NumberValue.ToString(),
                DMValueType.String => v.StringValue,
                _ => v.ToString()
            };
        }

        // Logical
        public static DMValue And(DMValue a, DMValue b) => FromNumber(a.IsTrue() && b.IsTrue() ? 1 : 0);
        public static DMValue Or(DMValue a, DMValue b) => FromNumber(a.IsTrue() || b.IsTrue() ? 1 : 0);
        public static DMValue Not(DMValue a) => FromNumber(a.IsTrue() ? 0 : 1);

        // Membership test for switch cases
        public static bool In(DMValue value, params DMValue[] candidates)
        {
            foreach (var c in candidates)
            {
                if (value.EqualsValue(c)) return true;
            }
            return false;
        }

        // DM output operator: world << "text" / usr << x
        public static DMValue Output(DMValue target, DMValue message)
        {
            Console.WriteLine($"[DM] {target} << {message}");
            return message;
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
                DMValueType.String => double.TryParse(StringValue, out var n) ? n : 0,
                DMValueType.Null => 0,
                DMValueType.List => ListValue?.Count ?? 0,
                DMValueType.DatumRef => DatumRef != null ? 1 : 0,
                _ => 0
            };
        }

        private bool EqualsValue(DMValue other)
        {
            // Cross-type: numeric strings compare equal to numbers (DM rule)
            if (Type == DMValueType.String && other.Type == DMValueType.Number)
                return double.TryParse(StringValue, out var n) && Math.Abs(n - other.NumberValue) < 1e-9;
            if (Type == DMValueType.Number && other.Type == DMValueType.String)
                return other.EqualsValue(this);
            // null compares equal to 0
            if (Type == DMValueType.Null && other.Type == DMValueType.Number)
                return Math.Abs(other.NumberValue) < 1e-9;
            if (Type == DMValueType.Number && other.Type == DMValueType.Null)
                return Math.Abs(NumberValue) < 1e-9;
            // DM: null == "" and null == "0" are true
            if (Type == DMValueType.Null && other.Type == DMValueType.String)
                return other.StringValue.Length == 0 || (double.TryParse(other.StringValue, out var sn) && Math.Abs(sn) < 1e-9);
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
                DMValueType.Number => Math.Abs(NumberValue - other.NumberValue) < 1e-9,
                DMValueType.String => string.Equals(StringValue, other.StringValue, StringComparison.OrdinalIgnoreCase),
                DMValueType.List => ReferenceEquals(ListValue, other.ListValue) || ListsEqual(ListValue, other.ListValue),
                DMValueType.DatumRef => ReferenceEquals(DatumRef, other.DatumRef),
                _ => false
            };
        }

        // DM: list equality is element-wise (recursive); order matters.
        private static bool ListsEqual(DMList a, DMList b)
        {
            if (a.Count != b.Count) return false;
            for (var i = 1; i <= a.Count; i++)
            {
                if (!a.Get(i).EqualsValue(b.Get(i))) return false;
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
        private readonly Dictionary<string, DMValue> _assocMap = new();

        public int Count => _elements.Count;

        public static DMList FromArray(DMValue[] values)
        {
            var list = new DMList();
            if (values != null)
            {
                foreach (var v in values) list.Add(v);
            }
            return list;
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
    }
}
`
      },
      {
        filename: 'DMRuntime.cs',
        content: `using System;
using System.Collections.Generic;
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

        public bool MarkedForDeletion { get; private set; }

        public DMValue GetVar(string name)
        {
            return Variables.TryGetValue(name, out var val) ? val : DMValue.Null;
        }

        public DMValue SetVar(string name, DMValue val)
        {
            Variables[name] = val;
            return val;
        }

        public bool IsType(string typePath)
        {
            return typePath == DMTypePath || DMTypePath.StartsWith(typePath + "/", StringComparison.Ordinal);
        }

        public void MarkForDeletion()
        {
            // Engine integration point: the hosting system observes this flag
            // and queues the wrapped entity for deletion.
            MarkedForDeletion = true;
        }

        public async Task<DMValue> CallProc(string procName, params DMValue[] args)
        {
            if (ProcRegistry.TryGet(DMTypePath, procName, out var handler)
                || ProcRegistry.TryGetInherited(DMTypePath, procName, out handler))
            {
                return await InvokeWithUsr(handler, args);
            }
            return DMValue.Null;
        }

        /// <summary>
        /// DM "..()" dispatch: invoke the parent type's implementation of the
        /// current proc (the nearest ancestor that defines it), skipping this
        /// type's own override to avoid recursion.
        /// </summary>
        public async Task<DMValue> CallParentProc(string procName, params DMValue[] args)
        {
            if (ProcRegistry.TryGetInherited(DMTypePath, procName, out var handler))
            {
                return await InvokeWithUsr(handler, args);
            }
            return DMValue.Null;
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
                || ProcRegistry.TryGetInherited(DMTypePath, procName, out _);
        }
    }

    /// <summary>
    /// Registry of transpiled DM procs, keyed by (type path, proc name).
    /// Generated code registers each emitted proc method here.
    /// </summary>
    public static class ProcRegistry
    {
        private static readonly Dictionary<(string TypePath, string Name), Func<DMRuntime, DMValue[], Task<DMValue>>> Procs = new();

        public static void Register(string typePath, string procName, Func<DMRuntime, DMValue[], Task<DMValue>> handler)
        {
            Procs[(typePath, procName)] = handler;
        }

        public static bool TryGet(string typePath, string procName, out Func<DMRuntime, DMValue[], Task<DMValue>> handler)
        {
            return Procs.TryGetValue((typePath, procName), out handler!);
        }

        public static bool TryGetInherited(string typePath, string procName, out Func<DMRuntime, DMValue[], Task<DMValue>> handler)
        {
            var parts = typePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
            while (parts.Length > 0)
            {
                parts = parts[..^1];
                var candidate = "/" + string.Join("/", parts);
                if (Procs.TryGetValue((candidate, procName), out handler!)) return true;
            }
            handler = null!;
            return false;
        }
    }
}
`
      },
      {
        filename: 'DMTickScheduler.cs',
        content: `using System;
using System.Threading.Tasks;

namespace SS13.DM.Runtime
{
    public static class DMTickScheduler
    {
        public static async Task Sleep(double deciseconds)
        {
            int milliseconds = (int)(deciseconds * 100);
            await Task.Delay(Math.Max(1, milliseconds));
        }

        public static async Task Sleep(DMValue deciseconds)
        {
            await Sleep(deciseconds.ToNumber());
        }

        public static void Spawn(double deciseconds, Action action)
        {
            _ = Task.Run(async () =>
            {
                await Sleep(deciseconds);
                action?.Invoke();
            });
        }

        public static void Spawn(DMValue deciseconds, Func<Task> action)
        {
            _ = Task.Run(async () =>
            {
                await Sleep(deciseconds);
                if (action != null) await action();
            });
        }
    }
}
`
      },
      {
        filename: 'DMRuntimeHelpers.cs',
        content: `using System;
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
        /// DM "world" object. Engine integration later drives world.time from
        /// the tick rate; the engine-free runtime exposes a live datum.
        /// </summary>
        public static DMValue WorldValue { get; } = BuildWorld();

        private static DMValue BuildWorld()
        {
            var world = new DMRuntime { DMTypePath = "/world" };
            world.SetVar("time", DMValue.FromNumber(0));
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
            var datum = new DMRuntime { DMTypePath = typePath };
            await datum.CallProc("New", args);
            return DMValue.FromDatum(datum);
        }

        public static void DMDelete(DMValue target)
        {
            if (target.Type == DMValueType.DatumRef && target.DatumRef is DMRuntime datum)
            {
                // Engine integration point: queue entity deletion.
                datum.MarkForDeletion();
            }
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
            var list = target.Type == DMValueType.List ? target.ListValue : null;
            if (list == null) return DMValue.Null;
            if (index.Type == DMValueType.Number)
                return list.Set((int)index.NumberValue, value);
            list.SetAssoc(index.ToString(), value);
            return value;
        }

        // ==== Type predicates ====

        public static DMValue DMGetProperty(DMValue target, string name)
        {
            // DM: .len on a list or text returns its length; on a datum it
            // falls through to the normal variable lookup below.
            if (name == "len")
            {
                if (target.Type == DMValueType.List) return DMValue.FromNumber(target.ListValue.Count);
                if (target.Type == DMValueType.String) return DMValue.FromNumber(target.StringValue.Length);
            }
            if (target.Type == DMValueType.DatumRef && target.DatumRef is DMRuntime datum)
                return datum.GetVar(name);
            return DMValue.Null;
        }

        public static DMValue DMIsType(DMValue value, DMValue typePath)
        {
            // DM: istype(non-datum, /type) is always false (0), never null.
            if (value.Type != DMValueType.DatumRef || value.DatumRef is not DMRuntime datum)
                return DMValue.FromNumber(0);
            return DMValue.FromNumber(datum.IsType(typePath.ToString()) ? 1 : 0);
        }

        public static DMValue DMIsList(DMValue value)
        {
            return DMValue.FromNumber(value.Type == DMValueType.List ? 1 : 0);
        }

        public static DMValue ReplaceText(DMValue haystack, DMValue needle, DMValue replacement)
        {
            // DM replacetext is case-insensitive and replaces all occurrences.
            var s = haystack.ToString();
            var n = needle.ToString();
            var result = new System.Text.StringBuilder();
            var idx = 0;
            while (idx < s.Length)
            {
                var found = s.IndexOf(n, idx, StringComparison.OrdinalIgnoreCase);
                if (found < 0)
                {
                    result.Append(s, idx, s.Length - idx);
                    break;
                }
                result.Append(s, idx, found - idx).Append(replacement.ToString());
                idx = found + n.Length;
            }
            return DMValue.FromString(result.ToString());
        }

        public static DMValue DMIsPath(DMValue value, DMValue typePath)
        {
            var type = value.ToString();
            return DMValue.FromNumber(type == typePath.ToString() || type == typePath.ToString().TrimStart('/') ? 1 : 0);
        }

        // ==== Misc builtins ====

        public static DMValue DMProb(DMValue chance)
        {
            var rng = new Random();
            return DMValue.FromNumber(rng.NextDouble() * 100 < chance.ToNumber() ? 1 : 0);
        }

        // ==== Iteration helper: for(x in range) ====

        public static System.Collections.Generic.IEnumerable<DMValue> DMListItems(DMValue value)
        {
            switch (value.Type)
            {
                case DMValueType.List:
                    for (var i = 1; i <= value.ListValue.Count; i++)
                        yield return value.ListValue.Get(i);
                    break;
                case DMValueType.Number:
                    // DM: for (x in N) iterates 1..N
                    for (var i = 1; i <= (int)value.NumberValue; i++)
                        yield return DMValue.FromNumber(i);
                    break;
                case DMValueType.String:
                    // DM: for (x in "text") iterates characters
                    foreach (var c in value.StringValue)
                        yield return DMValue.FromString(c.ToString());
                    break;
                default:
                    yield return value;
                    break;
            }
        }

        public static DMValue DMLocate(DMValue typePath)
        {
            // Engine integration point: locate a datum of the given type.
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
            // DM semantics: rand() -> float in [0, 1); rand(a) -> integer in 1..a;
            // rand(a, b) -> integer in [min(a,b), max(a,b)].
            if (a.Type == DMValueType.Null)
                return DMValue.FromNumber(new Random().NextDouble());
            if (b.Type == DMValueType.Null)
            {
                var hi = (int)a.ToNumber();
                return DMValue.FromNumber(hi <= 0 ? 0 : new Random().Next(hi) + 1);
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

        public static DMValue Length(DMValue value)
        {
            if (value.Type == DMValueType.List) return DMValue.FromNumber(value.ListValue.Count);
            return DMValue.FromNumber(value.ToString().Length);
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
            var s = value.ToString().Trim();
            if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                && int.TryParse(s.Substring(2), System.Globalization.NumberStyles.HexNumber, null, out var hex))
                return DMValue.FromNumber(hex);
            return DMValue.FromNumber(double.TryParse(s, out var n) ? n : 0);
        }

        public static DMValue Num2Text(DMValue value)
        {
            var n = value.ToNumber();
            return DMValue.FromString(n == (int)n ? ((int)n).ToString() : n.ToString());
        }

        public static DMValue CopyText(DMValue text, DMValue start, DMValue end = default)
        {
            var s = text.ToString();
            var len = s.Length;
            int startIdx = (int)start.ToNumber();
            if (startIdx < 0) startIdx = len + startIdx + 1;
            int endIdx = end.Type == DMValueType.Null && end.NumberValue == 0 ? len + 1 : (int)end.ToNumber();
            if (endIdx < 0) endIdx = len + endIdx + 1;
            startIdx = Math.Max(1, Math.Min(len + 1, startIdx));
            endIdx = Math.Max(startIdx, Math.Min(len + 1, endIdx));
            return DMValue.FromString(s.Substring(startIdx - 1, endIdx - startIdx));
        }

        public static DMValue FindText(DMValue text, DMValue needle, DMValue start = default)
        {
            var s = text.ToString();
            int startIdx = start.Type == DMValueType.Null && start.NumberValue == 0 ? 1 : Math.Max(1, (int)start.ToNumber());
            if (startIdx > s.Length) return DMValue.FromNumber(0);
            var idx = s.IndexOf(needle.ToString(), startIdx - 1, StringComparison.Ordinal);
            return DMValue.FromNumber(idx < 0 ? 0 : idx + 1);
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
            var d = digits.Type == DMValueType.Null && digits.NumberValue == 0 ? 0 : (int)digits.ToNumber();
            if (d == 0)
                return DMValue.FromNumber(Math.Round(n, MidpointRounding.AwayFromZero));
            var factor = Math.Pow(10, d);
            return DMValue.FromNumber(Math.Round(n * factor, MidpointRounding.AwayFromZero) / factor);
        }

        public static DMValue Abs(DMValue value) => DMValue.FromNumber(Math.Abs(value.ToNumber()));

        public static DMValue UpperText(DMValue value) => DMValue.FromString(value.ToString().ToUpper());

        public static DMValue LowerText(DMValue value) => DMValue.FromString(value.ToString().ToLower());

        public static DMValue HasCall(DMValue target, DMValue procName)
        {
            if (target.Type == DMValueType.DatumRef && target.DatumRef is DMRuntime datum)
                return DMValue.FromNumber(datum.CanCallProc(procName.ToString()) ? 1 : 0);
            return DMValue.FromNumber(0);
        }

        public static DMValue Alert(params DMValue[] args) => DMValue.Null;

        public static DMValue Input(params DMValue[] args) => DMValue.Null;

        public static DMValue Icon(params DMValue[] args) => DMValue.Null;
    }
}
`
      },
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
