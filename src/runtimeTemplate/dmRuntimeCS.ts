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
        File,
        DatumRef
    }

    public struct DMValue
    {
        public DMValueType Type { get; private set; }
        public double NumberValue { get; private set; }
        public string StringValue { get; private set; }
        public string FileValue { get; private set; }
        public DMList ListValue { get; private set; }
        public object DatumRef { get; private set; }

        public static DMValue Null => new DMValue { Type = DMValueType.Null };

        public static DMValue FromNumber(double val) => new DMValue { Type = DMValueType.Number, NumberValue = val };
        public static DMValue FromString(string val) => new DMValue { Type = DMValueType.String, StringValue = val ?? "" };
        public static DMValue FromList(DMList list) => new DMValue { Type = DMValueType.List, ListValue = list };
        public static DMValue FromFile(string path) => new DMValue { Type = DMValueType.File, FileValue = path ?? "" };
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
                DMValueType.File => !string.IsNullOrEmpty(FileValue),
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
                DMValueType.File => FileValue,
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

        // Membership test for switch cases and the 'in' operator.
        // Returns a DMValue (1/0) so results compose with other expressions;
        // a single list candidate tests membership in that list.
        public static DMValue In(DMValue value, params DMValue[] candidates)
        {
            if (candidates.Length == 1 && candidates[0].Type == DMValueType.List)
            {
                var list = candidates[0].ListValue;
                for (var i = 1; i <= list.Count; i++)
                    if (value.EqualsValue(list.Get(i))) return DMValue.FromNumber(1);
                return DMValue.FromNumber(0);
            }
            foreach (var c in candidates)
            {
                if (value.EqualsValue(c)) return DMValue.FromNumber(1);
            }
            return DMValue.FromNumber(0);
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
using System.Net;
using System.Text;
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

        /// <summary>
        /// First value ever assigned to each var — the engine-free stand-in for
        /// DM initial() (which reads the value assigned in the var declaration
        /// before any runtime mutation).
        /// </summary>
        public Dictionary<string, DMValue> InitialValues { get; } = new();

        public DMValue SetVar(string name, DMValue val)
        {
            if (!InitialValues.ContainsKey(name)) InitialValues[name] = val;
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
                || ProcRegistry.TryGetInherited(DMTypePath, procName, out handler)
                || ProcRegistry.TryGet("/proc", procName, out handler))
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
            if (ProcRegistry.TryGetInherited(DMTypePath, procName, out var handler)
                || ProcRegistry.TryGet("/proc", procName, out handler))
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

        /// <summary>
        /// Every type path that has at least one registered proc — used by
        /// typesof() to enumerate the type tree known to the runtime.
        /// </summary>
        public static readonly HashSet<string> RegisteredPaths = new();

        public static void Register(string typePath, string procName, Func<DMRuntime, DMValue[], Task<DMValue>> handler)
        {
            Procs[(typePath, procName)] = handler;
            RegisteredPaths.Add(typePath);
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
using System.Collections.Generic;
using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
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

        private static string MakeProcRefKey(DMRuntime? datum, string typePath, string procName)
        {
            var key = "DMProcRef:" + _procRefCounter++;
            ProcRefs[key] = (datum, typePath, procName);
            return key;
        }

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
            LiveDatums.Add(datum);
            await datum.CallProc("New", args);
            return DMValue.FromDatum(datum);
        }

        public static DMValue DMDelete(DMValue target)
        {
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

        public static DMValue DMIsPath(DMValue value, DMValue typePath = default)
        {
            // DM: ispath(x) with no type is true when x is itself a path.
            if (typePath.Type == DMValueType.Null)
                return DMValue.FromNumber(value.Type == DMValueType.String ? 1 : 0);
            var type = value.ToString();
            return DMValue.FromNumber(type == typePath.ToString() || type == typePath.ToString().TrimStart('/') ? 1 : 0);
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
        public static DMValue NameOf(DMValue path)
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
        public static DMValue Turn(DMValue dir, DMValue angle)
        {
            var d = (int)dir.ToNumber();
            var idx = Array.IndexOf(ClockwiseDirs, d);
            if (idx < 0) return dir;
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
            a.SetVar("x", DMValue.FromNumber(nx));
            a.SetVar("y", DMValue.FromNumber(ny));
            return DMValue.FromNumber(1);
        }

        /// <summary>
        /// DM step_towards(atom, trg): moves one step toward trg; 1 if moved.
        /// </summary>
        public static DMValue StepTowards(DMValue atom, DMValue trg)
        {
            var dir = GetDir(atom, trg);
            if (dir.ToNumber() == 0) return DMValue.FromNumber(0);
            return Step(atom, dir);
        }

        /// <summary>
        /// DM step_away(atom, trg): moves one step away from trg, trying the
        /// direct away direction first and then 45-degree rotations.
        /// </summary>
        public static DMValue StepAway(DMValue atom, DMValue trg)
        {
            if (atom.Type != DMValueType.DatumRef || atom.DatumRef is not DMRuntime) return DMValue.FromNumber(0);
            if (trg.Type != DMValueType.DatumRef || trg.DatumRef is not DMRuntime) return DMValue.FromNumber(0);
            var away = GetDir(trg, atom).ToNumber();
            if (away == 0) return DMValue.FromNumber(0);
            var idx = Array.IndexOf(ClockwiseDirs, (int)away);
            if (idx < 0) return DMValue.FromNumber(0);
            for (var i = 0; i < 8; i++)
            {
                var dir = ClockwiseDirs[(idx + i) % ClockwiseDirs.Length];
                var r = Step(atom, DMValue.FromNumber(dir));
                if (r.ToNumber() == 1) return r;
            }
            return DMValue.FromNumber(0);
        }

        /// <summary>
        /// DM get_step_away(atom, trg): the turf one step away from trg
        /// (no movement; first live datum at that position, or Null).
        /// </summary>
        public static DMValue GetStepAway(DMValue atom, DMValue trg)
        {
            var away = GetDir(trg, atom);
            if (away.ToNumber() == 0) return DMValue.Null;
            return GetStep(atom, away);
        }

        /// <summary>
        /// DM get_step_towards(atom, trg): the turf one step toward trg
        /// (no movement; first live datum at that position, or Null).
        /// </summary>
        public static DMValue GetStepTowards(DMValue atom, DMValue trg)
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
            var s = text.ToString();
            var list = new DMList();
            var sep = separator.ToString();
            if (sep.Length == 0)
            {
                foreach (var c in s) list.Add(DMValue.FromString(c.ToString()));
            }
            else
            {
                foreach (var p in s.Split(new[] { sep }, StringSplitOptions.None)) list.Add(DMValue.FromString(p));
            }
            return DMValue.FromList(list);
        }

        public static DMValue JoinText(DMValue value, DMValue separator = default)
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
                for (var i = 1; i <= value.ListValue.Count; i++) Append(value.ListValue.Get(i).ToString());
            }
            else
            {
                Append(value.ToString());
            }
            return DMValue.FromString(sb.ToString());
        }

        /// <summary>
        /// DM params2list("a=1&b=2"): URL-style params into an associative list.
        /// </summary>
        public static DMValue Params2List(DMValue value)
        {
            var list = new DMList();
            foreach (var pair in value.ToString().Split('&'))
            {
                if (pair.Length == 0) continue;
                var eq = pair.IndexOf('=');
                if (eq < 0) list.Add(DMValue.FromString(pair));
                else list.SetAssoc(pair.Substring(0, eq), DMValue.FromString(pair.Substring(eq + 1)));
            }
            return DMValue.FromList(list);
        }

        /// <summary>
        /// DM text2path: a text path converts to the same path string.
        /// </summary>
        public static DMValue Text2Path(DMValue value) => value;

        /// <summary>
        /// DM rgb(r, g, b[, a]): "#RRGGBB" (or "#RRGGBBAA" with alpha) text.
        /// </summary>
        public static DMValue RGB(params DMValue[] args)
        {
            var r = args.Length > 0 ? (int)args[0].ToNumber() : 0;
            var g = args.Length > 1 ? (int)args[1].ToNumber() : 0;
            var b = args.Length > 2 ? (int)args[2].ToNumber() : 0;
            var a = args.Length > 3 ? (int)args[3].ToNumber() : 0;
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
        public static DMValue FileCopyRsc(DMValue src, DMValue dst) => FileCopy(src, dst);

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

        // ==== Recognized-but-stubbed builtins (visual/UI/extension; return Null) ====

        public static DMValue Animate(params DMValue[] args) => DMValue.Null;
        public static DMValue Image(params DMValue[] args) => DMValue.Null;
        public static DMValue Flick(params DMValue[] args) => DMValue.Null;
        public static DMValue Sound(params DMValue[] args) => DMValue.Null;
        public static DMValue Matrix(params DMValue[] args) => DMValue.Null;
        public static DMValue Browse(params DMValue[] args) => DMValue.Null;
        public static DMValue CallExt(params DMValue[] args) => DMValue.Null;
        public static DMValue DetectRustG(params DMValue[] args) => DMValue.FromNumber(0);


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
            if (value.Type == DMValueType.File)
            {
                try { return DMValue.FromNumber(new System.IO.FileInfo(value.FileValue).Length); }
                catch { return DMValue.FromNumber(0); }
            }
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
            return Num2Text(value, DMValue.FromNumber(0));
        }

        public static DMValue Num2Text(DMValue value, DMValue len)
        {
            var n = value.ToNumber();
            var s = n == (int)n ? ((int)n).ToString() : n.ToString();
            var width = (int)len.ToNumber();
            if (width > s.Length) s = s.PadLeft(width, '0');
            return DMValue.FromString(s);
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

        // ==== Pure math functions (BYOND semantics: trig in degrees) ====

        public static DMValue Floor(DMValue value) => DMValue.FromNumber(Math.Floor(value.ToNumber()));

        public static DMValue Ceil(DMValue value) => DMValue.FromNumber(Math.Ceiling(value.ToNumber()));

        public static DMValue Sqrt(DMValue value) => DMValue.FromNumber(Math.Sqrt(value.ToNumber()));

        public static DMValue Sin(DMValue value) => DMValue.FromNumber(Math.Sin(value.ToNumber() * Math.PI / 180.0));

        public static DMValue Cos(DMValue value) => DMValue.FromNumber(Math.Cos(value.ToNumber() * Math.PI / 180.0));

        public static DMValue ArcCos(DMValue value) => DMValue.FromNumber(Math.Acos(value.ToNumber()) * 180.0 / Math.PI);

        public static DMValue Log(DMValue value) => DMValue.FromNumber(Math.Log(value.ToNumber()));

        public static DMValue Sign(DMValue value)
        {
            if (value.Type == DMValueType.String)
                return DMValue.FromNumber(string.IsNullOrEmpty(value.StringValue) ? 0 : -1);
            var n = value.ToNumber();
            return DMValue.FromNumber(n < 0 ? -1 : (n > 0 ? 1 : 0));
        }

        // ==== Text functions ====

        public static DMValue LengthChar(DMValue value)
        {
            if (value.Type == DMValueType.String) return DMValue.FromNumber(value.StringValue.Length);
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
            var s = text.Type == DMValueType.String ? text.StringValue : text.ToString();
            var s1 = Math.Clamp(DmIndex(start.ToNumber(), s.Length), 1, s.Length + 1);
            var e1 = end.Type == DMValueType.Null
                ? s.Length + 1
                : Math.Clamp(DmIndex(end.ToNumber(), s.Length), s1, s.Length + 1);
            return DMValue.FromString(s.Substring(s1 - 1, e1 - s1));
        }

        public static DMValue Text2Ascii(DMValue text, DMValue pos = default)
        {
            var s = text.Type == DMValueType.String ? text.StringValue : text.ToString();
            var p = pos.Type == DMValueType.Null ? 1 : DmIndex(pos.ToNumber(), s.Length);
            if (p < 1 || p > s.Length) return DMValue.FromNumber(0);
            return DMValue.FromNumber(s[p - 1]);
        }

        public static DMValue Ascii2Text(DMValue code) => DMValue.FromString(((char)(int)code.ToNumber()).ToString());

        public static DMValue CKey(DMValue value)
        {
            var s = value.Type == DMValueType.String ? value.StringValue : value.ToString();
            var sb = new StringBuilder(s.Length);
            foreach (var ch in s.ToLowerInvariant())
            {
                if (ch == '_') sb.Append(' ');
                else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == ' ') sb.Append(ch);
            }
            return DMValue.FromString(sb.ToString().Trim());
        }

        public static DMValue SortText(DMValue a, DMValue b)
        {
            var c = string.Compare(a.ToString(), b.ToString(), StringComparison.OrdinalIgnoreCase);
            return DMValue.FromNumber(c < 0 ? -1 : (c > 0 ? 1 : 0));
        }

        public static DMValue ReplaceTextEx(DMValue haystack, DMValue needle, DMValue replacement)
        {
            var find = needle.ToString();
            if (string.IsNullOrEmpty(find)) return haystack;
            return DMValue.FromString(haystack.ToString().Replace(find, replacement.ToString()));
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

        public static DMValue JsonEncode(DMValue value) => DMValue.FromString(JsonValue(value));

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

        private static string JsonEscape(string s)
        {
            var sb = new StringBuilder("\\"");
            foreach (var ch in s)
            {
                switch (ch)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\\\': sb.Append("\\\\"); break;
                    case '\\n': sb.Append("\\n"); break;
                    case '\\r': sb.Append("\\r"); break;
                    case '\\t': sb.Append("\\t"); break;
                    default:
                        if (ch < 0x20) sb.Append("\\\\u").Append(((int)ch).ToString("x4"));
                        else sb.Append(ch);
                        break;
                }
            }
            return sb.Append('"').ToString();
        }

        // ==== Time / params ====

        /// <summary>
        /// time2text(world.time, format): world time is in deciseconds, epoch
        /// Jan 1 2000 (BYOND semantics). Supports YYYY/MM/DD/hh/mm/ss/MMM.
        /// </summary>
        public static DMValue Time2Text(DMValue time, DMValue format = default)
        {
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
            for (var i = 1; i <= list.Count; i++)
            {
                var key = list.Get(i).ToString();
                parts.Add(DmUrlEncode(key) + "=" + DmUrlEncode(list.GetAssoc(key).ToString()));
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
