using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace SS13.DM.Runtime
{
    /// <summary>
    /// Core operations referenced by transpiled code: object lifecycle, proc
    /// dispatch, indexing, properties and type checks.
    /// </summary>
    public static partial class DMRuntimeHelpers
    {
        public static readonly Random Rng = new();

        /// <summary>DM usr: the mob whose action started the current thread. Flows through sleeps and into spawns.</summary>
        public static DMValue CurrentUsr
        {
            get => DMProcs.CurrentUsr;
            set => DMProcs.CurrentUsr = value;
        }

        private static DMWorld? _world;
        public static DMWorld World => _world ??= new DMWorld();
        public static DMValue WorldValue => DMValue.FromDatum(World);

        /// <summary>Destination of world &lt;&lt; / usr &lt;&lt; output (engine adapter routes it to chat).</summary>
        public static Action<DMValue, DMValue>? OutputSink = (target, msg) => Console.WriteLine($"[DM] {msg.Stringify()}");

        /// <summary>Server hook: materializes a new atom as an engine entity (atom lowering).</summary>
        public static Action<string, DMValue, DMRuntime>? EntitySpawnBridge;

        /// <summary>Server hook: an atom was deleted.</summary>
        public static Action<DMRuntime>? EntityDeleteBridge;

        /// <summary>Datums created via new and not deleted (engine-free spatial builtins scan this).</summary>
        public static readonly List<DMRuntime> LiveDatums = new();

        /// <summary>Clears all runtime state (types, globals, scheduler, world). Generated code re-registers afterwards.</summary>
        public static void ResetRuntime()
        {
            DMTickScheduler.Reset();
            DMProcs.Reset();
            DMTypes.Reset();
            LiveDatums.Clear();
            _world = null;
            CurrentUsr = DMValue.Null;
        }

        // ===== lifecycle =====

        public static Task<DMValue> DMNew(DMRuntime? comp, string typePath, params DMValue[] args) =>
            DMNewValue(DMValue.FromPath(typePath.Length == 0 ? "/datum" : typePath), args);

        /// <summary>new T(args) where T is a runtime value (path or datum's type).</summary>
        public static async Task<DMValue> DMNewValue(DMValue type, params DMValue[] args)
        {
            var path = type.Type switch
            {
                DMValueType.Path => type.StringValue,
                DMValueType.String => type.StringValue,
                DMValueType.DatumRef => type.AsDatum()!.DMTypePath,
                _ => throw new DMRuntimeError($"Cannot create objects of type {type.Repr()}")
            };
            var t = DMTypes.GetOrThrow(path);
            if (t.Path == "/list")
            {
                var list = new DMList();
                if (args.Length > 0) list.Resize(args[0].ToInt());
                return DMValue.FromList(list);
            }
            var obj = new DMRuntime(t);
            await obj.RunInitializers();
            LiveDatums.Add(obj);
            if (t.IsAtom)
            {
                var loc = args.Length > 0 ? args[0] : DMValue.Null;
                if (loc.AsDatum() != null) obj.SetVar("loc", loc);
                EntitySpawnBridge?.Invoke(t.Path, loc, obj);
            }
            await obj.CallProc("New", args);
            return DMValue.FromDatum(obj);
        }

        /// <summary>del x: runs Del(), detaches from loc, nulls every reference (reads of a deleted ref are null).</summary>
        public static DMValue DMDelete(params DMValue[] targets)
        {
            var datum = targets.Length > 0 ? targets[0].AsDatum() : null;
            if (datum == null) return DMValue.Null;
            var del = datum.CallProc("Del");
            if (!del.IsCompleted) DMTickScheduler.Observe(del, "Del");
            if (datum.TypeInfo.IsAtom) EntityDeleteBridge?.Invoke(datum);
            datum.MarkForDeletion();
            LiveDatums.Remove(datum);
            return DMValue.Null;
        }

        // ===== dispatch =====

        public static Task<DMValue> DMCallProc(DMValue target, string procName, params DMValue[] args)
        {
            switch (target.Type)
            {
                case DMValueType.DatumRef:
                    return target.AsDatum()!.CallProc(procName, args);
                case DMValueType.List:
                    return Task.FromResult(DMListProcs.Call(target.ListValue, procName, args));
                case DMValueType.Null:
                    throw new DMRuntimeError($"Cannot execute null.{procName}()");
                default:
                    throw new DMRuntimeError($"Cannot execute {target.Repr()}.{procName}()");
            }
        }

        /// <summary>Global (/proc) call from a context with no src.</summary>
        public static Task<DMValue> DMCallGlobal(string procName, params DMValue[] args) => DMProcs.CallGlobal(procName, args);

        // ===== call() / proc references =====

        /// <summary>call(target, "name") / call(/proc/x) / call(/type/proc/x).</summary>
        public static DMValue MakeProcRef(DMValue target, DMValue procName = default)
        {
            if (procName.IsNull)
            {
                var path = target.StringValue;
                var cut = path.IndexOf("/proc/", StringComparison.Ordinal);
                if (cut < 0) cut = path.IndexOf("/verb/", StringComparison.Ordinal);
                if (cut == 0 || path.StartsWith("/proc/", StringComparison.Ordinal))
                    return DMValue.FromProc(new DMProcRef(null, DMProcs.ResolveGlobal(path.Substring(6)) ?? throw new DMRuntimeError($"undefined proc {path}")));
                if (cut > 0)
                {
                    var owner = DMTypes.GetOrThrow(path.Substring(0, cut));
                    return DMValue.FromProc(new DMProcRef(null, owner.ResolveProc(path.Substring(cut + 6)) ?? throw new DMRuntimeError($"undefined proc {path}")));
                }
                throw new DMRuntimeError($"invalid proc reference {target.Repr()}");
            }
            var datum = target.AsDatum() ?? throw new DMRuntimeError($"Cannot call {procName.Stringify()} on {target.Repr()}");
            var def = datum.TypeInfo.ResolveProc(procName.Stringify()) ?? throw new DMRuntimeError($"undefined proc {procName.Stringify()}");
            return DMValue.FromProc(new DMProcRef(datum, def));
        }

        public static Task<DMValue> InvokeProcRef(DMValue procRef, params DMValue[] args)
        {
            var p = procRef.AsProc() ?? throw new DMRuntimeError($"{procRef.Repr()} is not a proc");
            return DMProcs.Invoke(p.Def, p.Target, args);
        }

        // ===== arguments =====

        public static DMValue[] DMArgList(DMValue v) => v.Type == DMValueType.List ? ToArray(v.ListValue) : new[] { v };

        public static DMValue[] DMArgList(DMList list) => list == null ? Array.Empty<DMValue>() : ToArray(list);

        /// <summary>arglist(L) with assoc entries passes them as named arguments (bound by DMProcs).</summary>
        private static DMValue[] ToArray(DMList list) =>
            list.IsAssociative ? new[] { DMValue.FromList(list) } : new List<DMValue>(list.Values).ToArray();

        public static DMValue[] DMArgsConcat(params DMValue[][] segments)
        {
            var result = new List<DMValue>();
            foreach (var s in segments) result.AddRange(s);
            return result.ToArray();
        }

        // ===== indexing =====

        public static DMValue DMListGet(DMValue target, DMValue index)
        {
            switch (target.Type)
            {
                case DMValueType.List:
                    return target.ListValue.Index(index);
                case DMValueType.DatumRef:
                {
                    var d = target.AsDatum()!;
                    if (d.TryOperator("operator[]", out var r, index)) return r;
                    if (d.ContentsList() is { } contents && index.Type == DMValueType.Number) return contents.Index(index);
                    throw new DMRuntimeError($"Cannot index {target.Repr()}");
                }
                case DMValueType.String when index.Type == DMValueType.Number:
                {
                    var s = target.StringValue;
                    var i = index.ToInt();
                    var len = DMValue.CpLength(s);
                    if (i < 1 || i > len) throw new DMRuntimeError("index out of bounds");
                    var start = DMValue.CpIndexToChar(s, i);
                    return DMValue.FromString(s.Substring(start, char.IsSurrogatePair(s, start) ? 2 : 1));
                }
                case DMValueType.Null:
                    throw new DMRuntimeError("Cannot read null[" + index.Repr() + "]");
                default:
                    throw new DMRuntimeError($"Cannot index {target.Repr()}");
            }
        }

        /// <summary>L[i] = v mutates the shared list in place; returns the target so callers may store it back.</summary>
        public static DMValue DMListSet(DMValue target, DMValue index, DMValue value)
        {
            switch (target.Type)
            {
                case DMValueType.List:
                    target.ListValue.SetIndex(index, value);
                    return target;
                case DMValueType.DatumRef when target.AsDatum()!.TryOperator("operator[]=", out _, index, value):
                    return target;
                case DMValueType.Null:
                    throw new DMRuntimeError("Cannot write null[" + index.Repr() + "]");
                default:
                    throw new DMRuntimeError($"Cannot index {target.Repr()}");
            }
        }

        // ===== properties =====

        public static DMValue DMGetProperty(DMValue target, string name)
        {
            switch (target.Type)
            {
                case DMValueType.DatumRef:
                    return target.AsDatum()!.GetVar(name);
                case DMValueType.List when name == "len":
                    return DMValue.FromNumber(target.ListValue.Count);
                case DMValueType.Path:
                    // /type.var reads the compile-time default (BYOND: initial value of the type).
                    if (DMTypes.Get(target.StringValue) is { } t)
                    {
                        if (name == "type") return target;
                        if (name == "parent_type") return t.Parent == null ? DMValue.Null : DMValue.FromPath(t.Parent.Path);
                        if (t.TryGetDefault(name, out var v)) return v;
                    }
                    throw new DMRuntimeError($"undefined var {name} on {target.Repr()}");
                case DMValueType.Null:
                    throw new DMRuntimeError($"Cannot read null.{name}");
                default:
                    throw new DMRuntimeError($"Cannot read {target.Repr()}.{name}");
            }
        }

        public static DMValue DMSetProperty(DMValue target, string name, DMValue value)
        {
            switch (target.Type)
            {
                case DMValueType.DatumRef:
                    return target.AsDatum()!.SetVar(name, value);
                case DMValueType.List when name == "len":
                    target.ListValue.Resize(value.ToInt());
                    return value;
                case DMValueType.Null:
                    throw new DMRuntimeError($"Cannot modify null.{name}");
                default:
                    throw new DMRuntimeError($"Cannot modify {target.Repr()}.{name}");
            }
        }

        // ===== types =====

        private static DMType? TypeOfValue(DMValue v) => v.Type switch
        {
            DMValueType.Path => DMTypes.Get(v.StringValue),
            DMValueType.DatumRef => v.AsDatum()!.TypeInfo,
            DMValueType.List => DMTypes.Get("/list"),
            _ => null
        };

        /// <summary>istype(x, T): x is a datum (or list) whose type is T or derives from T.</summary>
        public static DMValue DMIsType(DMValue value, DMValue typePath = default)
        {
            var vt = value.Type == DMValueType.DatumRef ? value.AsDatum()!.TypeInfo
                   : value.Type == DMValueType.List ? DMTypes.Get("/list") : null;
            if (vt == null) return DMValue.False;
            if (typePath.IsNull) return DMValue.True;
            var t = TypeOfValue(typePath);
            return DMValue.FromBool(t != null && vt.IsSubtypeOf(t));
        }

        public static DMValue DMIsList(DMValue value) => DMValue.FromBool(value.Type == DMValueType.List);

        /// <summary>ispath(x) / ispath(x, T).</summary>
        public static DMValue DMIsPath(DMValue value, DMValue typePath = default)
        {
            if (value.Type != DMValueType.Path) return DMValue.False;
            if (typePath.IsNull) return DMValue.True;
            var vt = DMTypes.Get(value.StringValue);
            var t = TypeOfValue(typePath);
            return DMValue.FromBool(vt != null && t != null && vt.IsSubtypeOf(t));
        }

        /// <summary>typesof(T...): T and every subtype, as path values.</summary>
        public static DMValue TypesOf(params DMValue[] typePaths)
        {
            var list = new DMList();
            foreach (var tp in typePaths)
            {
                var t = TypeOfValue(tp);
                if (t == null) continue;
                foreach (var s in DMTypes.SubtypesOf(t))
                {
                    var p = DMValue.FromPath(s.Path);
                    if (!list.Contains(p)) list.Add(p);
                }
            }
            return DMValue.FromList(list);
        }

        /// <summary>subtypesof(T): typesof(T) minus T itself.</summary>
        public static DMValue SubtypesOf(params DMValue[] typePaths)
        {
            var all = TypesOf(typePaths).ListValue;
            foreach (var tp in typePaths) all.RemoveValue(DMValue.FromPath(TypeOfValue(tp)?.Path ?? ""));
            return DMValue.FromList(all);
        }

        /// <summary>initial(x.var): the compile-time default of the var on x's type.</summary>
        public static DMValue DMInitial(DMRuntime datum, string name) =>
            datum.TypeInfo.TryGetDefault(name, out var v) ? v : DMValue.Null;

        public static DMValue DMInitial(DMValue datumOrPath, string name = "")
        {
            var t = TypeOfValue(datumOrPath);
            return t != null && t.TryGetDefault(name, out var v) ? v : DMValue.Null;
        }

        public static DMValue DMInitial(DMValue datumOrPath, DMValue name) => DMInitial(datumOrPath, name.Stringify());

        // ===== misc lowering support =====

        /// <summary>catch(var/exception/e): runtime errors surface as /exception datums.</summary>
        public static DMValue ExceptionValue(Exception e)
        {
            var ex = new DMRuntime(DMTypes.GetOrThrow("/exception"));
            ex.SetVar("name", DMValue.FromString(e.Message));
            ex.SetVar("desc", DMValue.FromString(e.ToString()));
            return DMValue.FromDatum(ex);
        }

        /// <summary>Constructs the emitter could not lower: a runtime error at the use site.</summary>
        public static DMValue Unsupported(string what) => throw new DMRuntimeError("unsupported: " + what);

        /// <summary>A map/prototype var override written as DM source text ("text", 12, /type/path, 'file', null).</summary>
        public static DMValue ParseMapValue(string raw)
        {
            var s = raw.Trim();
            if (s.Length == 0 || s == "null") return DMValue.Null;
            if (s.Length >= 2 && s[0] == '"' && s[^1] == '"') return DMValue.FromString(s.Substring(1, s.Length - 2).Replace("\\\"", "\"").Replace("\\\\", "\\"));
            if (s.Length >= 2 && s[0] == '\'' && s[^1] == '\'') return DMValue.FromFile(s.Substring(1, s.Length - 2));
            if (s[0] == '/') return DMValue.FromPath(s);
            if (double.TryParse(s, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var n)) return DMValue.FromNumber(n);
            return DMValue.FromString(s);
        }

        // ===== lists =====

        public static DMValue MakeList(params DMValue[] values) => DMValue.FromList(DMList.FromArray(values));

        /// <summary>list(k = v, ...): keys may be text, paths or datums.</summary>
        public static DMValue MakeListAssoc(params DMValue[] kv)
        {
            var list = new DMList();
            for (var i = 0; i + 1 < kv.Length; i += 2) list.SetIndex(kv[i], kv[i + 1]);
            return DMValue.FromList(list);
        }

        /// <summary>Marks a positional entry inside MakeListAssoc (list(a, "b" = 2)).</summary>
        public static DMValue MakeListMixed(params (DMValue Key, DMValue Value, bool Assoc)[] entries)
        {
            var list = new DMList();
            foreach (var e in entries)
                if (e.Assoc) list.SetIndex(e.Key, e.Value);
                else list.Add(e.Key);
            return DMValue.FromList(list);
        }

        public static DMValue MakeRange(DMValue a, DMValue b)
        {
            var list = new DMList();
            var lo = a.ToInt();
            var hi = b.ToInt();
            if (lo <= hi) for (var i = lo; i <= hi; i++) list.Add(DMValue.FromNumber(i));
            else for (var i = lo; i >= hi; i--) list.Add(DMValue.FromNumber(i));
            return DMValue.FromList(list);
        }

        /// <summary>
        /// for (x in L): BYOND iterates a snapshot of the list's elements (keys
        /// of an assoc list); an atom iterates its contents; world iterates
        /// world.contents.
        /// </summary>
        public static IEnumerable<DMValue> DMListItems(DMValue value)
        {
            DMList? list = value.Type switch
            {
                DMValueType.List => value.ListValue,
                DMValueType.DatumRef => value.AsDatum()!.ContentsList(),
                _ => null
            };
            if (list == null) return Array.Empty<DMValue>();
            return new List<DMValue>(list.Values);
        }
    }

    /// <summary>Builtin /list procs.</summary>
    public static class DMListProcs
    {
        private static DMValue Arg(DMValue[] a, int i) => i < a.Length ? a[i] : DMValue.Null;

        public static DMValue Call(DMList list, string name, DMValue[] args)
        {
            switch (name)
            {
                case "Add":
                    foreach (var a in args) list.Append(a);
                    return DMValue.Null;
                case "Remove":
                {
                    var any = false;
                    foreach (var a in args) any |= list.Remove(a);
                    return DMValue.FromBool(any);
                }
                case "RemoveAll":
                {
                    var n = 0;
                    foreach (var a in args)
                        while (list.RemoveValue(a)) n++;
                    return DMValue.FromNumber(n);
                }
                case "Cut":
                    list.Cut(Arg(args, 0).IsNull ? 1 : Arg(args, 0).ToInt(), Arg(args, 1).ToInt());
                    return DMValue.Null;
                case "Copy":
                    return DMValue.FromList(list.Copy(Arg(args, 0).IsNull ? 1 : Arg(args, 0).ToInt(), Arg(args, 1).ToInt()));
                case "Find":
                    return DMValue.FromNumber(list.Find(Arg(args, 0), Arg(args, 1).IsNull ? 1 : Arg(args, 1).ToInt(), Arg(args, 2).ToInt()));
                case "Insert":
                {
                    var index = Arg(args, 0).ToInt();
                    for (var i = 1; i < args.Length; i++)
                    {
                        list.Insert(index, args[i]);
                        if (index != 0) index += args[i].Type == DMValueType.List ? args[i].ListValue.Count : 1;
                    }
                    return DMValue.FromNumber(index);
                }
                case "Join":
                {
                    var sep = Arg(args, 0).Stringify();
                    var start = Arg(args, 1).IsNull ? 1 : Arg(args, 1).ToInt();
                    var end = Arg(args, 2).ToInt();
                    if (end == 0 || end > list.Count + 1) end = list.Count + 1;
                    var parts = new List<string>();
                    for (var i = start; i < end; i++) parts.Add(list.Get(i).Stringify());
                    return DMValue.FromString(string.Join(sep, parts));
                }
                case "Swap":
                    list.Swap(Arg(args, 0).ToInt(), Arg(args, 1).ToInt());
                    return DMValue.Null;
                case "Splice":
                {
                    var start = Arg(args, 0).IsNull ? 1 : Arg(args, 0).ToInt();
                    var end = Arg(args, 1).ToInt();
                    list.Cut(start, end);
                    var at = start;
                    for (var i = 2; i < args.Length; i++)
                    {
                        list.Insert(at, args[i]);
                        at += args[i].Type == DMValueType.List ? args[i].ListValue.Count : 1;
                    }
                    return DMValue.Null;
                }
                default:
                    throw new DMRuntimeError($"undefined proc: /list.{name}()");
            }
        }
    }
}
