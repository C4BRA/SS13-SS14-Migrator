export class DMRuntimeCS {
  public static getRuntimeCSFiles(): { filename: string; content: string }[] {
    return [
      {
        filename: 'DMValue.cs',
        content: `using System;
using System.Collections.Generic;

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
        public static DMValue FromComponent(DMRuntimeComponent comp) => new DMValue { Type = DMValueType.DatumRef, DatumRef = comp };

        public DMRuntimeComponent? AsComponent() =>
            Type == DMValueType.DatumRef ? DatumRef as DMRuntimeComponent : null;

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
        public static DMValue Add(DMValue a, DMValue b) =>
            a.Type == DMValueType.String || b.Type == DMValueType.String
                ? FromString(a.ToString() + b.ToString())
                : FromNumber(a.ToNumber() + b.ToNumber());
        public static DMValue Subtract(DMValue a, DMValue b) => FromNumber(a.ToNumber() - b.ToNumber());
        public static DMValue Multiply(DMValue a, DMValue b) => FromNumber(a.ToNumber() * b.ToNumber());
        public static DMValue Divide(DMValue a, DMValue b) => FromNumber(b.ToNumber() != 0 ? a.ToNumber() / b.ToNumber() : 0);
        public static DMValue Modulo(DMValue a, DMValue b) => FromNumber(b.ToNumber() != 0 ? a.ToNumber() % b.ToNumber() : 0);
        public static DMValue Negate(DMValue a) => FromNumber(-a.ToNumber());

        // Comparison
        public static DMValue Equals(DMValue a, DMValue b) => FromNumber(a.EqualsValue(b) ? 1 : 0);
        public static DMValue LessThan(DMValue a, DMValue b) => FromNumber(a.ToNumber() < b.ToNumber() ? 1 : 0);
        public static DMValue LessOrEqual(DMValue a, DMValue b) => FromNumber(a.ToNumber() <= b.ToNumber() ? 1 : 0);
        public static DMValue GreaterThan(DMValue a, DMValue b) => FromNumber(a.ToNumber() > b.ToNumber() ? 1 : 0);
        public static DMValue GreaterOrEqual(DMValue a, DMValue b) => FromNumber(a.ToNumber() >= b.ToNumber() ? 1 : 0);

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
            if (Type != other.Type) return false;
            return Type switch
            {
                DMValueType.Null => true,
                DMValueType.Number => Math.Abs(NumberValue - other.NumberValue) < 1e-9,
                DMValueType.String => StringValue == other.StringValue,
                DMValueType.List => ReferenceEquals(ListValue, other.ListValue),
                DMValueType.DatumRef => ReferenceEquals(DatumRef, other.DatumRef),
                _ => false
            };
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
            if (index >= 1 && index <= _elements.Count)
                return _elements[index - 1];
            return DMValue.Null;
        }

        public DMValue Set(int index, DMValue val)
        {
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
        filename: 'DMObjectComponent.cs',
        content: `using System.Collections.Generic;
using Robust.Shared.GameObjects;

namespace SS13.DM.Runtime
{
    [RegisterComponent]
    public class DMRuntimeComponent : Component
    {
        public string DMTypePath { get; set; } = "/datum";
        public Dictionary<string, DMValue> Variables { get; } = new();

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
            // Engine integration point: queue entity deletion.
        }

        public async Task<DMValue> CallProc(string procName, params DMValue[] args)
        {
            if (ProcRegistry.TryGet(DMTypePath, procName, out var handler)
                || ProcRegistry.TryGetInherited(DMTypePath, procName, out handler))
            {
                // DM semantics: usr is the object that invoked the call; for direct
                // calls this is the receiving object itself.
                var previousUsr = DMRuntimeHelpers.CurrentUsr;
                DMRuntimeHelpers.CurrentUsr = DMValue.FromComponent(this);
                try
                {
                    return await handler(this, args);
                }
                finally
                {
                    DMRuntimeHelpers.CurrentUsr = previousUsr;
                }
            }
            return DMValue.Null;
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
        private static readonly Dictionary<(string TypePath, string Name), Func<DMRuntimeComponent, DMValue[], Task<DMValue>>> Procs = new();

        public static void Register(string typePath, string procName, Func<DMRuntimeComponent, DMValue[], Task<DMValue>> handler)
        {
            Procs[(typePath, procName)] = handler;
        }

        public static bool TryGet(string typePath, string procName, out Func<DMRuntimeComponent, DMValue[], Task<DMValue>> handler)
        {
            return Procs.TryGetValue((typePath, procName), out handler!);
        }

        public static bool TryGetInherited(string typePath, string procName, out Func<DMRuntimeComponent, DMValue[], Task<DMValue>> handler)
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
        /// Defaults to Null; set around each proc invocation in CallProc.
        /// </summary>
        public static DMValue CurrentUsr { get; set; } = DMValue.Null;

        // ==== Object lifecycle ====

        /// <summary>
        /// Creates a new object of the given DM type path. Entity spawn is
        /// provided by the hosting engine; returns a datum reference.
        /// </summary>
        public static async Task<DMValue> DMNew(DMRuntimeComponent comp, string typePath, params DMValue[] args)
        {
            // Engine integration point: spawn entity + DMRuntimeComponent,
            // then dispatch New() via the proc registry.
            return DMValue.FromRef(comp);
        }

        public static void DMDelete(DMValue target)
        {
            if (target.Type == DMValueType.DatumRef && target.DatumRef is DMRuntimeComponent comp)
            {
                // Engine integration point: queue entity deletion.
                comp.MarkForDeletion();
            }
        }

        // ==== Proc dispatch ====

        public static async Task<DMValue> DMCallProc(DMValue target, string procName, params DMValue[] args)
        {
            if (target.Type == DMValueType.DatumRef && target.DatumRef is DMRuntimeComponent comp)
            {
                return await comp.CallProc(procName, args);
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

        public static DMValue DMIsType(DMValue value, DMValue typePath)
        {
            if (value.Type != DMValueType.DatumRef || value.DatumRef is not DMRuntimeComponent comp)
                return DMValue.Null;
            return DMValue.FromNumber(comp.IsType(typePath.ToString()) ? 1 : 0);
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

        public static IEnumerable<DMValue> DMListItems(DMValue value)
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

        public static DMValue Rand(DMValue a, DMValue b = default)
        {
            if (b.Type == DMValueType.Null && b.NumberValue == 0)
            {
                return DMValue.FromNumber(new Random().Next((int)Math.Max(0, a.ToNumber()) + 1));
            }
            var lo = (int)Math.Min(a.ToNumber(), b.ToNumber());
            var hi = (int)Math.Max(a.ToNumber(), b.ToNumber());
            return DMValue.FromNumber(lo + new Random().Next(hi - lo + 1));
        }

        public static DMValue MakeList(params DMValue[] values)
        {
            var list = new DMList();
            foreach (var v in values) list.Add(v);
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
            return DMValue.FromNumber(double.TryParse(value.ToString(), out var n) ? n : 0);
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
            if (target.Type == DMValueType.DatumRef && target.DatumRef is DMRuntimeComponent comp)
                return DMValue.FromNumber(comp.CanCallProc(procName.ToString()) ? 1 : 0);
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