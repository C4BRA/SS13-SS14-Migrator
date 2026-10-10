using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace SS13.DM.Runtime
{
    public delegate Task<DMValue> DMProcHandler(DMRuntime src, DMValue[] args);
    public delegate Task<DMValue> DMVarInitializer(DMRuntime src);

    /// <summary>One definition of a proc. A type may define the same proc
    /// several times (later definitions override earlier ones, and `..()` in a
    /// later one reaches the earlier one before the parent type's).</summary>
    public sealed class DMProcDef
    {
        public required string Name { get; init; }
        public required DMType Owner { get; init; }
        public required DMProcHandler Handler { get; init; }
        public int Index { get; init; }
        public string[] ParamNames { get; init; } = Array.Empty<string>();
        /// <summary>`set waitfor = 0`: the caller resumes when this proc first sleeps.</summary>
        public bool WaitFor { get; init; } = true;
    }

    public sealed class DMType
    {
        public string Path { get; }
        public string? DeclaredParent { get; internal set; }
        public DMType? Parent { get; internal set; }
        public int Id { get; internal set; }
        public int SubtreeEnd { get; internal set; }
        public readonly List<DMType> Children = new();

        internal readonly Dictionary<string, DMValue> OwnDefaults = new();
        internal readonly Dictionary<string, DMVarInitializer> OwnInitializers = new();
        internal readonly Dictionary<string, List<DMProcDef>> OwnProcs = new(StringComparer.OrdinalIgnoreCase);

        /// <summary>Flattened var table: root-to-leaf, most-derived initializer wins.</summary>
        internal (string Name, DMValue Value, DMVarInitializer? Init)[] Layout = Array.Empty<(string, DMValue, DMVarInitializer?)>();
        internal Dictionary<string, int> LayoutIndex = new();
        private readonly Dictionary<string, DMProcDef?> _procCache = new(StringComparer.OrdinalIgnoreCase);
        private int _procCacheVersion = -1;

        internal DMType(string path) => Path = path;

        public bool IsSubtypeOf(DMType other) => Id >= other.Id && Id < other.SubtreeEnd;

        public bool IsAtom => DMTypes.Atom != null && IsSubtypeOf(DMTypes.Atom);

        /// <summary>The definition a call on an instance of this type dispatches to.</summary>
        public DMProcDef? ResolveProc(string name)
        {
            if (_procCacheVersion != DMTypes.ProcVersion)
            {
                _procCache.Clear();
                _procCacheVersion = DMTypes.ProcVersion;
            }
            if (_procCache.TryGetValue(name, out var cached)) return cached;
            DMProcDef? found = null;
            for (var t = this; t != null && found == null; t = t.Parent)
                if (t.OwnProcs.TryGetValue(name, out var defs) && defs.Count > 0) found = defs[^1];
            _procCache[name] = found;
            return found;
        }

        /// <summary>`..()` from definition <paramref name="index"/> of <paramref name="name"/> on this type.</summary>
        public DMProcDef? ResolveParentProc(string name, int index)
        {
            if (index > 0 && OwnProcs.TryGetValue(name, out var defs) && index - 1 < defs.Count) return defs[index - 1];
            return Parent?.ResolveProc(name);
        }

        public bool TryGetDefault(string name, out DMValue value)
        {
            if (LayoutIndex.TryGetValue(name, out var i) && Layout[i].Init == null)
            {
                value = Layout[i].Value;
                return true;
            }
            value = DMValue.Null;
            return LayoutIndex.ContainsKey(name);
        }

        public bool HasVar(string name) => LayoutIndex.ContainsKey(name);

        public override string ToString() => Path;
    }

    /// <summary>
    /// The DM type tree. Generated code declares every type with its parent,
    /// compile-time var defaults and non-constant initializers, then calls
    /// <see cref="Seal"/>. Builtin types (/datum, /atom, /list, ...) are
    /// installed by <see cref="DMBuiltinTypes"/>.
    /// </summary>
    public static class DMTypes
    {
        private static readonly Dictionary<string, DMType> ByPath = new(StringComparer.OrdinalIgnoreCase);
        private static bool _finalized;

        /// <summary>Bumped on any proc/tree change; per-type dispatch caches compare against it.</summary>
        public static int ProcVersion { get; private set; }

        public static DMType Root { get; private set; } = null!;
        public static DMType? Atom { get; private set; }
        public static DMType? Movable { get; private set; }
        public static IEnumerable<DMType> All => ByPath.Values;

        static DMTypes() => Reset();

        public static void Reset()
        {
            ByPath.Clear();
            _finalized = false;
            Root = Declare("/datum");
            DMBuiltinTypes.Install();
        }

        public static string NormalizePath(string path)
        {
            if (path.Length == 0) return path;
            var p = path.TrimEnd('/');
            if (p.Length == 0) return "/";
            return p[0] == '/' ? p : "/" + p;
        }

        /// <summary>BYOND's implicit parent: /obj and /mob are /atom/movable, /turf and /area are /atom, otherwise the path prefix.</summary>
        public static string? ImplicitParent(string path)
        {
            switch (path.ToLowerInvariant())
            {
                case "/datum": return null;
                case "/obj":
                case "/mob": return "/atom/movable";
                case "/turf":
                case "/area": return "/atom";
                case "/atom": return "/datum";
            }
            var cut = path.LastIndexOf('/');
            return cut <= 0 ? "/datum" : path.Substring(0, cut);
        }

        public static DMType Declare(string path, string? parent = null)
        {
            path = NormalizePath(path);
            if (!ByPath.TryGetValue(path, out var type))
            {
                type = new DMType(path);
                ByPath[path] = type;
                _finalized = false;
            }
            if (parent != null) type.DeclaredParent = NormalizePath(parent);
            return type;
        }

        public static void DefineVar(string path, string name, DMValue value)
        {
            var t = Declare(path);
            t.OwnDefaults[name] = value;
            t.OwnInitializers.Remove(name);
            _finalized = false;
        }

        public static void DefineVarInit(string path, string name, DMVarInitializer init)
        {
            var t = Declare(path);
            t.OwnInitializers[name] = init;
            t.OwnDefaults.Remove(name);
            _finalized = false;
        }

        public static DMProcDef DefineProc(string path, string name, DMProcHandler handler, string[]? paramNames = null, bool waitFor = true)
        {
            var t = Declare(path);
            if (!t.OwnProcs.TryGetValue(name, out var defs)) t.OwnProcs[name] = defs = new List<DMProcDef>();
            var def = new DMProcDef
            {
                Name = name, Owner = t, Handler = handler, Index = defs.Count,
                ParamNames = paramNames ?? Array.Empty<string>(), WaitFor = waitFor
            };
            defs.Add(def);
            ProcVersion++;
            return def;
        }

        public static DMType? Get(string path)
        {
            EnsureFinalized();
            return ByPath.TryGetValue(NormalizePath(path), out var t) ? t : null;
        }

        public static DMType GetOrThrow(string path) =>
            Get(path) ?? throw new DMRuntimeError($"undefined type: {path}");

        public static void EnsureFinalized()
        {
            if (!_finalized) Seal();
        }

        public static void Seal()
        {
            // Synthesize undeclared intermediate parents, then link.
            foreach (var t in new List<DMType>(ByPath.Values))
                for (var p = t.DeclaredParent ?? ImplicitParent(t.Path); p != null && !ByPath.ContainsKey(p); p = ImplicitParent(p))
                    Declare(p);
            foreach (var t in ByPath.Values) t.Children.Clear();
            foreach (var t in ByPath.Values)
            {
                var parentPath = t.DeclaredParent ?? ImplicitParent(t.Path);
                t.Parent = parentPath == null ? null : ByPath[parentPath];
                t.Parent?.Children.Add(t);
            }
            ProcVersion++;
            // Pre-order ids: subtype checks are a range test.
            var next = 0;
            void Number(DMType t)
            {
                t.Id = next++;
                t.Children.Sort((a, b) => string.CompareOrdinal(a.Path, b.Path));
                foreach (var c in t.Children) Number(c);
                t.SubtreeEnd = next;
            }
            Number(Root);
            foreach (var t in ByPath.Values)
                if (t.Parent == null && t != Root) throw new InvalidOperationException($"type {t.Path} has no root");
            void Layout(DMType t)
            {
                var names = new List<string>();
                var values = new Dictionary<string, (DMValue, DMVarInitializer?)>();
                if (t.Parent != null)
                    foreach (var e in t.Parent.Layout)
                    {
                        names.Add(e.Name);
                        values[e.Name] = (e.Value, e.Init);
                    }
                foreach (var (k, v) in t.OwnDefaults)
                {
                    if (!values.ContainsKey(k)) names.Add(k);
                    values[k] = (v, null);
                }
                foreach (var (k, init) in t.OwnInitializers)
                {
                    if (!values.ContainsKey(k)) names.Add(k);
                    values[k] = (DMValue.Null, init);
                }
                t.Layout = new (string, DMValue, DMVarInitializer?)[names.Count];
                t.LayoutIndex = new Dictionary<string, int>(names.Count);
                for (var i = 0; i < names.Count; i++)
                {
                    var (v, init) = values[names[i]];
                    t.Layout[i] = (names[i], v, init);
                    t.LayoutIndex[names[i]] = i;
                }
                foreach (var c in t.Children) Layout(c);
            }
            Layout(Root);
            Atom = ByPath.GetValueOrDefault("/atom");
            Movable = ByPath.GetValueOrDefault("/atom/movable");
            _finalized = true;
        }

        /// <summary>Every type that is <paramref name="baseType"/> or derives from it, in tree order.</summary>
        public static IEnumerable<DMType> SubtypesOf(DMType baseType)
        {
            yield return baseType;
            foreach (var c in baseType.Children)
                foreach (var s in SubtypesOf(c))
                    yield return s;
        }
    }

    /// <summary>A DM datum instance (named DMRuntime for source compatibility).</summary>
    public class DMRuntime
    {
        private DMType _type;
        private readonly Dictionary<string, DMValue> _vars = new();

        public DMRuntime() : this(DMTypes.Root) { }

        public DMRuntime(DMType type)
        {
            _type = type;
            foreach (var e in type.Layout)
                if (e.Init == null) _vars[e.Name] = e.Value;
        }

        public DMType TypeInfo => _type;

        /// <summary>Retypes a bare datum (used by engine-created components); applies the new type's defaults.</summary>
        public string DMTypePath
        {
            get => _type.Path;
            set
            {
                _type = DMTypes.GetOrThrow(value);
                foreach (var e in _type.Layout)
                    if (e.Init == null && !_vars.ContainsKey(e.Name)) _vars[e.Name] = e.Value;
            }
        }

        public Dictionary<string, DMValue> Variables => _vars;

        public ulong EntityId { get; set; }
        public bool Deleted { get; private set; }
        public bool MarkedForDeletion => Deleted;

        /// <summary>Engine lowering hooks (atom ↔ entity): called after a builtin var write.</summary>
        public static Action<DMRuntime, string, DMValue, DMValue>? VarWriteHook;

        public virtual DMValue GetVar(string name)
        {
            switch (name)
            {
                case "type": return DMValue.FromPath(_type.Path);
                case "parent_type": return _type.Parent == null ? DMValue.Null : DMValue.FromPath(_type.Parent.Path);
                case "vars": return DMValue.FromList(VarsList());
            }
            return _vars.TryGetValue(name, out var v) ? v : DMValue.Null;
        }

        public virtual DMValue SetVar(string name, DMValue value)
        {
            if (name == "loc" && _type.IsAtom)
            {
                SetLoc(value);
                return value;
            }
            _vars.TryGetValue(name, out var old);
            _vars[name] = value;
            VarWriteHook?.Invoke(this, name, old, value);
            return value;
        }

        public bool HasVar(string name) => _vars.ContainsKey(name) || name is "type" or "parent_type" or "vars";

        /// <summary>Runs the non-constant initializers (BYOND's hidden init proc), root to leaf.</summary>
        public async Task RunInitializers()
        {
            foreach (var e in _type.Layout)
                if (e.Init != null) _vars[e.Name] = await e.Init(this);
        }

        private DMList VarsList()
        {
            var list = new DMList();
            foreach (var k in _vars.Keys) list.SetIndex(DMValue.FromString(k), _vars[k]);
            return list;
        }

        // ===== atom containment =====

        public DMList? ContentsList() => _vars.TryGetValue("contents", out var c) ? c.AsList() : null;

        private void SetLoc(DMValue loc)
        {
            _vars.TryGetValue("loc", out var old);
            if (old.Equals(loc)) return;
            old.AsDatum()?.ContentsList()?.RemoveValue(DMValue.FromDatum(this));
            var newLoc = loc.AsDatum();
            _vars["loc"] = newLoc == null ? DMValue.Null : loc;
            newLoc?.ContentsList()?.Add(DMValue.FromDatum(this));
            VarWriteHook?.Invoke(this, "loc", old, loc);
        }

        public bool IsType(string typePath)
        {
            var t = DMTypes.Get(typePath);
            return t != null && _type.IsSubtypeOf(t);
        }

        public bool IsType(DMType t) => _type.IsSubtypeOf(t);

        public void MarkForDeletion()
        {
            if (Deleted) return;
            if (_type.IsAtom) SetLoc(DMValue.Null);
            Deleted = true;
        }

        public string DisplayText()
        {
            if (_type.IsAtom && _vars.TryGetValue("name", out var n)) return n.Stringify();
            return _type.Path;
        }

        public override string ToString() => DisplayText();

        // ===== proc dispatch =====

        public Task<DMValue> CallProc(string procName, params DMValue[] args)
        {
            var def = _type.ResolveProc(procName);
            if (def == null) throw new DMRuntimeError($"undefined proc: {procName}() on {_type.Path}");
            return DMProcs.Invoke(def, this, args);
        }

        public bool CanCallProc(string procName) => _type.ResolveProc(procName) != null;

        /// <summary>Bare call inside a proc: src's procs first, then global procs.</summary>
        public Task<DMValue> CallProcOrGlobal(string procName, params DMValue[] args)
        {
            var def = _type.ResolveProc(procName) ?? DMProcs.ResolveGlobal(procName);
            if (def == null) throw new DMRuntimeError($"undefined proc: {procName}()");
            return DMProcs.Invoke(def, this, args);
        }

        /// <summary>`..()` from definition <paramref name="index"/> of a proc declared on <paramref name="ownerPath"/>.</summary>
        public Task<DMValue> CallParentProc(string ownerPath, int index, string procName, params DMValue[] args)
        {
            var owner = DMTypes.GetOrThrow(ownerPath);
            var def = owner.ResolveParentProc(procName, index);
            return def == null ? Task.FromResult(DMValue.Null) : DMProcs.Invoke(def, this, args);
        }

        /// <summary>Synchronous operator overload (operator+ etc.); false if the type defines none.</summary>
        public bool TryOperator(string op, out DMValue result, params DMValue[] args)
        {
            var def = _type.ResolveProc(op);
            if (def == null)
            {
                result = DMValue.Null;
                return false;
            }
            var task = DMProcs.Invoke(def, this, args);
            if (!task.IsCompleted) throw new DMRuntimeError($"{op} slept");
            result = task.GetAwaiter().GetResult();
            return true;
        }
    }

    public sealed class DMProcRef
    {
        public DMRuntime? Target { get; }
        public DMProcDef Def { get; }
        public DMProcRef(DMRuntime? target, DMProcDef def)
        {
            Target = target;
            Def = def;
        }
        public override bool Equals(object? obj) => obj is DMProcRef p && p.Def == Def && p.Target == Target;
        public override int GetHashCode() => HashCode.Combine(Def, Target);
        public override string ToString() => $"{Def.Owner.Path}/proc/{Def.Name}";
    }

    /// <summary>Proc invocation: global procs, named-argument binding, waitfor, usr.</summary>
    public static class DMProcs
    {
        public const string GlobalOwner = "/proc";
        private static readonly Dictionary<string, List<DMProcDef>> Globals = new(StringComparer.OrdinalIgnoreCase);
        private static readonly AsyncLocalUsr Usr = new();

        public static DMValue CurrentUsr
        {
            get => Usr.Value;
            set => Usr.Value = value;
        }

        public static void Reset() => Globals.Clear();

        public static DMProcDef DefineGlobal(string name, DMProcHandler handler, string[]? paramNames = null, bool waitFor = true)
        {
            if (!Globals.TryGetValue(name, out var defs)) Globals[name] = defs = new List<DMProcDef>();
            var def = new DMProcDef
            {
                Name = name, Owner = DMTypes.Root, Handler = handler, Index = defs.Count,
                ParamNames = paramNames ?? Array.Empty<string>(), WaitFor = waitFor
            };
            defs.Add(def);
            return def;
        }

        public static DMProcDef? ResolveGlobal(string name) =>
            Globals.TryGetValue(name, out var defs) && defs.Count > 0 ? defs[^1] : null;

        public static IEnumerable<string> GlobalNames => Globals.Keys;

        public static Task<DMValue> CallGlobal(string name, params DMValue[] args)
        {
            var def = ResolveGlobal(name) ?? throw new DMRuntimeError($"undefined proc: {name}()");
            return Invoke(def, null, args);
        }

        /// <summary>`..()` inside definition <paramref name="index"/> of a global proc.</summary>
        public static Task<DMValue> CallGlobalParent(string name, int index, params DMValue[] args) =>
            index > 0 && Globals.TryGetValue(name, out var defs) && index - 1 < defs.Count
                ? Invoke(defs[index - 1], null, args)
                : Task.FromResult(DMValue.Null);

        public static async Task<DMValue> Invoke(DMProcDef def, DMRuntime? src, DMValue[] args)
        {
            args = BindNamedArgs(def, args);
            var task = def.Handler(src!, args);
            if (def.WaitFor || task.IsCompleted) return await task;
            DMTickScheduler.Observe(task, def.Name);
            return DMValue.Null;
        }

        /// <summary>arglist(assoc-list): positional entries fill slots in order, "name" = v entries bind by parameter name.</summary>
        private static DMValue[] BindNamedArgs(DMProcDef def, DMValue[] args)
        {
            if (args.Length != 1 || args[0].Type != DMValueType.List || def.ParamNames.Length == 0) return args;
            var list = args[0].ListValue;
            if (!list.IsAssociative) return args;
            var bound = new DMValue[def.ParamNames.Length];
            var positional = 0;
            for (var i = 1; i <= list.Count; i++)
            {
                var key = list.Get(i);
                if (list.TryGetAssocValue(key, out var value) && key.Type == DMValueType.String)
                {
                    var idx = Array.FindIndex(def.ParamNames, n => n == key.StringValue);
                    if (idx >= 0) bound[idx] = value;
                }
                else if (positional < bound.Length)
                {
                    bound[positional++] = key;
                }
            }
            return bound;
        }

        private sealed class AsyncLocalUsr
        {
            private readonly System.Threading.AsyncLocal<DMValue> _local = new();
            public DMValue Value
            {
                get => _local.Value;
                set => _local.Value = value;
            }
        }
    }

    /// <summary>Source-compatible facade over <see cref="DMTypes"/> / <see cref="DMProcs"/>.</summary>
    public static class ProcRegistry
    {
        public static IEnumerable<string> RegisteredPaths
        {
            get
            {
                DMTypes.EnsureFinalized();
                foreach (var t in DMTypes.All) yield return t.Path;
            }
        }

        public static void Register(string typePath, string procName, Func<DMRuntime, DMValue[], Task<DMValue>> handler, string[]? paramNames = null, bool waitFor = true)
        {
            var h = new DMProcHandler(handler);
            if (string.Equals(typePath, DMProcs.GlobalOwner, StringComparison.OrdinalIgnoreCase))
                DMProcs.DefineGlobal(procName, h, paramNames, waitFor);
            else
                DMTypes.DefineProc(typePath, procName, h, paramNames, waitFor);
        }

        public static void RegisterPath(string typePath) => DMTypes.Declare(typePath);

        public static string[]? GetParamNames(string typePath, string procName) =>
            (DMTypes.Get(typePath)?.ResolveProc(procName) ?? DMProcs.ResolveGlobal(procName))?.ParamNames;

        public static bool TryGet(string typePath, string procName, out Func<DMRuntime, DMValue[], Task<DMValue>> handler)
        {
            DMProcDef? def = null;
            if (string.Equals(typePath, DMProcs.GlobalOwner, StringComparison.OrdinalIgnoreCase))
                def = DMProcs.ResolveGlobal(procName);
            else if (DMTypes.Get(typePath) is { } t && t.OwnProcs.TryGetValue(procName, out var defs) && defs.Count > 0)
                def = defs[^1];
            handler = def == null ? null! : (src, args) => DMProcs.Invoke(def, src, args);
            return def != null;
        }

        public static bool TryGetInherited(string typePath, string procName, out Func<DMRuntime, DMValue[], Task<DMValue>> handler)
        {
            var def = DMTypes.Get(typePath)?.Parent?.ResolveProc(procName);
            handler = def == null ? null! : (src, args) => DMProcs.Invoke(def, src, args);
            return def != null;
        }
    }
}
