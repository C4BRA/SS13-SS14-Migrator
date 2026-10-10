using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace SS13.DM.Runtime
{
    /// <summary>Operator forms the emitter lowers to (compound assignment, postfix, &lt;&lt;, ?.).</summary>
    public static class DMOps
    {
        /// <summary>a += b: lists append in place (shared references see it); datums use operator+=, else +.</summary>
        public static DMValue AddAssign(DMValue a, DMValue b)
        {
            if (a.Type == DMValueType.List)
            {
                a.ListValue.Append(b);
                return a;
            }
            if (a.AsDatum() is { } d && d.TryOperator("operator+=", out _, b)) return a;
            return DMValue.Add(a, b);
        }

        /// <summary>a -= b: lists remove in place.</summary>
        public static DMValue RemoveAssign(DMValue a, DMValue b)
        {
            if (a.Type == DMValueType.List)
            {
                a.ListValue.Remove(b);
                return a;
            }
            if (a.AsDatum() is { } d && d.TryOperator("operator-=", out _, b)) return a;
            return DMValue.Subtract(a, b);
        }

        /// <summary>a |= b: lists add missing elements in place.</summary>
        public static DMValue CombineAssign(DMValue a, DMValue b)
        {
            if (a.Type == DMValueType.List)
            {
                a.ListValue.Combine(b);
                return a;
            }
            if (a.AsDatum() is { } d && d.TryOperator("operator|=", out _, b)) return a;
            return DMValue.BitwiseOr(a, b);
        }

        /// <summary>a &amp;= b: lists keep the intersection in place.</summary>
        public static DMValue MaskAssign(DMValue a, DMValue b)
        {
            if (a.Type == DMValueType.List)
            {
                a.ListValue.Mask(b);
                return a;
            }
            if (a.AsDatum() is { } d && d.TryOperator("operator&=", out _, b)) return a;
            return DMValue.BitwiseAnd(a, b);
        }

        /// <summary>x++ / x--: evaluates to the value before the write (the write is the second argument).</summary>
        public static DMValue Post(DMValue old, DMValue _) => old;

        /// <summary>a &lt;&lt; b: a shift for numbers, output for anything else (world, mobs, clients, files, lists).</summary>
        public static DMValue ShiftOrOutput(DMValue a, DMValue b) =>
            a.Type is DMValueType.Number or DMValueType.Null && !b.IsNull && b.Type == DMValueType.Number
                ? DMValue.ShiftLeft(a, b)
                : DMValue.Output(a, b);

        public static DMValue SafeGet(DMValue target, string name) =>
            target.IsNull ? DMValue.Null : DMRuntimeHelpers.DMGetProperty(target, name);

        public static DMValue SafeIndex(DMValue target, DMValue index) =>
            target.IsNull ? DMValue.Null : DMRuntimeHelpers.DMListGet(target, index);

        public static Task<DMValue> SafeCall(DMValue target, string name, params DMValue[] args) =>
            target.IsNull ? Task.FromResult(DMValue.Null) : DMRuntimeHelpers.DMCallProc(target, name, args);

        /// <summary>L[i] = v as an expression: the value is v.</summary>
        public static DMValue IndexAssign(DMValue target, DMValue index, DMValue value)
        {
            DMRuntimeHelpers.DMListSet(target, index, value);
            return value;
        }

        /// <summary>L[i] op= v: target and index evaluate once (no duplicated is-var temps).</summary>
        public static DMValue IndexCompoundAssign(DMValue target, DMValue index, string op, DMValue rhs)
        {
            var next = CompoundApply(DMRuntimeHelpers.DMListGet(target, index), op, rhs);
            DMRuntimeHelpers.DMListSet(target, index, next);
            return next;
        }

        /// <summary>a.b op= v on a dynamic target: the target evaluates once.</summary>
        public static DMValue PropCompoundAssign(DMValue target, string prop, string op, DMValue rhs)
        {
            var next = CompoundApply(DMRuntimeHelpers.DMGetProperty(target, prop), op, rhs);
            DMRuntimeHelpers.DMSetProperty(target, prop, next);
            return next;
        }

        /// <summary>L[i]++ / L[i]--: evaluates to the old value.</summary>
        public static DMValue IndexPostfix(DMValue target, DMValue index, bool decrement)
        {
            var old = DMRuntimeHelpers.DMListGet(target, index);
            DMRuntimeHelpers.DMListSet(target, index, PostfixValue(old, decrement));
            return old;
        }

        /// <summary>a.b++ / a.b-- on a dynamic target: evaluates to the old value.</summary>
        public static DMValue PropPostfix(DMValue target, string prop, bool decrement)
        {
            var old = DMRuntimeHelpers.DMGetProperty(target, prop);
            DMRuntimeHelpers.DMSetProperty(target, prop, PostfixValue(old, decrement));
            return old;
        }

        private static DMValue CompoundApply(DMValue cur, string op, DMValue rhs) => op switch
        {
            "+=" => AddAssign(cur, rhs),
            "-=" => RemoveAssign(cur, rhs),
            "|=" => CombineAssign(cur, rhs),
            "&=" => MaskAssign(cur, rhs),
            _ => rhs,
        };

        private static DMValue PostfixValue(DMValue old, bool decrement) =>
            decrement ? DMValue.Subtract(old, DMValue.FromNumber(1)) : DMValue.Add(old, DMValue.FromNumber(1));

        /// <summary>f(a, name = v): one assoc arglist, bound to parameter names by DMProcs.</summary>
        public static DMValue[] NamedArgs(DMValue[] positional, params (string Name, DMValue Value)[] named)
        {
            var list = DMList.FromArray(positional);
            foreach (var (name, value) in named) list.SetIndex(DMValue.FromString(name), value);
            return new[] { DMValue.FromList(list) };
        }

        /// <summary>`..()` with no arguments passes the current values of the proc's arguments, plus any extras.</summary>
        public static DMValue[] ParentArgs(DMValue[] original, params DMValue[] current)
        {
            if (original.Length <= current.Length) return current;
            var all = new DMValue[original.Length];
            Array.Copy(current, all, current.Length);
            Array.Copy(original, current.Length, all, current.Length, original.Length - current.Length);
            return all;
        }

        /// <summary>Lazily-initialized proc static (`var/static/x` / `var/global/x` inside a proc).</summary>
        public static DMValue StaticLocal(Dictionary<string, DMValue> store, string key, Func<DMValue> init)
        {
            if (!store.TryGetValue(key, out var v)) store[key] = v = init();
            return v;
        }
    }
}

namespace SS13.DM.Runtime
{
    public static partial class DMRuntimeHelpers
    {
        /// <summary>cmptext(T1, T2, ...): all arguments equal ignoring case.</summary>
        public static DMValue CmpText(params DMValue[] args)
        {
            for (var i = 1; i < args.Length; i++)
                if (!string.Equals(args[0].Stringify(), args[i].Stringify(), StringComparison.OrdinalIgnoreCase)) return DMValue.False;
            return DMValue.True;
        }

        /// <summary>cmptextEx(T1, T2, ...): all arguments equal, case-sensitive.</summary>
        public static DMValue CmpTextEx(params DMValue[] args)
        {
            for (var i = 1; i < args.Length; i++)
                if (!string.Equals(args[0].Stringify(), args[i].Stringify(), StringComparison.Ordinal)) return DMValue.False;
            return DMValue.True;
        }

        /// <summary>ckeyEx(): keep [A-Za-z0-9@_-], preserving case.</summary>
        public static DMValue CKeyEx(DMValue value)
        {
            if (value.Type != DMValueType.String) return DMValue.Null;
            var sb = new System.Text.StringBuilder();
            foreach (var ch in value.StringValue)
                if (char.IsAsciiLetterOrDigit(ch) || ch is '@' or '_' or '-') sb.Append(ch);
            return DMValue.FromString(sb.ToString());
        }
    }
}
