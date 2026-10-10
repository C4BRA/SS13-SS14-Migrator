using System;
using System.Collections.Generic;

namespace SS13.DM.Runtime
{
    /// <summary>
    /// A DM list: an ordered sequence of values, any of which may carry an
    /// associated value (list("a" = 1) has len 1, L[1] == "a", L["a"] == 1).
    /// Lists are shared references — assignment never copies; `+=` mutates in
    /// place, `+` returns a copy. Assoc keys use DM == (text is case-sensitive,
    /// datums/paths are valid keys).
    /// </summary>
    public class DMList
    {
        private readonly List<DMValue> _values;
        private Dictionary<DMValue, DMValue>? _assoc;

        /// <summary>Optional write hook (atom contents/overlays lowering).</summary>
        public Action<DMList>? OnChanged;

        public DMList() => _values = new List<DMValue>();
        public DMList(int capacity) => _values = new List<DMValue>(capacity);

        public int Count => _values.Count;
        public int PositionalCount => _values.Count;
        public bool IsAssociative => _assoc is { Count: > 0 };
        public IReadOnlyList<DMValue> Values => _values;

        public static DMList FromArray(DMValue[]? values)
        {
            var list = new DMList(values?.Length ?? 0);
            if (values != null) list._values.AddRange(values);
            return list;
        }

        public DMList Clone()
        {
            var clone = new DMList(_values.Count);
            clone._values.AddRange(_values);
            if (_assoc != null) clone._assoc = new Dictionary<DMValue, DMValue>(_assoc);
            return clone;
        }

        private void Changed() => OnChanged?.Invoke(this);

        // ===== Index access =====

        private int CheckIndex(int index)
        {
            if (index < 1 || index > _values.Count)
                throw new DMRuntimeError($"list index out of bounds ({index}, len {_values.Count})");
            return index - 1;
        }

        public DMValue Get(int index) => _values[CheckIndex(index)];

        public DMValue Set(int index, DMValue val)
        {
            var i = CheckIndex(index);
            var old = _values[i];
            if (_assoc != null && !old.Equals(val) && _assoc.Remove(old, out var carried) && !Contains(old))
                _assoc[val] = carried;
            _values[i] = val;
            Changed();
            return val;
        }

        /// <summary>L[k]: numeric k is an index, anything else an assoc lookup.</summary>
        public DMValue Index(DMValue key)
        {
            if (key.Type == DMValueType.Number) return Get((int)key.Float);
            return _assoc != null && _assoc.TryGetValue(key, out var v) ? v : DMValue.Null;
        }

        /// <summary>L[k] = v: numeric k writes the index, anything else (re)associates k, appending it if absent.</summary>
        public DMValue SetIndex(DMValue key, DMValue value)
        {
            if (key.Type == DMValueType.Number) return Set((int)key.Float, value);
            if (key.IsNull) throw new DMRuntimeError("Invalid list index: null");
            if (!Contains(key)) _values.Add(key);
            (_assoc ??= new Dictionary<DMValue, DMValue>())[key] = value;
            Changed();
            return value;
        }

        public bool TryGetAssocValue(DMValue key, out DMValue value)
        {
            if (_assoc != null && _assoc.TryGetValue(key, out value)) return true;
            value = DMValue.Null;
            return false;
        }

        // Text-keyed convenience accessors used by the builtin helpers.
        public void SetAssoc(string key, DMValue val) => SetIndex(DMValue.FromString(key), val);
        public DMValue GetAssoc(string key) => Index(DMValue.FromString(key));
        public bool TryGetAssoc(string key, out DMValue val) => TryGetAssocValue(DMValue.FromString(key), out val);

        /// <summary>Entries that carry an associated value, in list order.</summary>
        public IEnumerable<KeyValuePair<DMValue, DMValue>> AssocPairs
        {
            get
            {
                if (_assoc == null) yield break;
                foreach (var k in _values)
                    if (_assoc.TryGetValue(k, out var v)) yield return new KeyValuePair<DMValue, DMValue>(k, v);
            }
        }

        // ===== Membership / search =====

        public bool Contains(DMValue value)
        {
            for (var i = 0; i < _values.Count; i++)
                if (_values[i].Equals(value)) return true;
            return false;
        }

        public int Find(DMValue value, int start = 1, int end = 0)
        {
            if (end == 0 || end > _values.Count) end = _values.Count + 1;
            for (var i = Math.Max(start, 1); i < end; i++)
                if (_values[i - 1].Equals(value)) return i;
            return 0;
        }

        // ===== Mutation =====

        public void Add(DMValue val)
        {
            _values.Add(val);
            Changed();
        }

        /// <summary>L.Add(x) / L += x: a list argument appends its elements (and their associations).</summary>
        public void Append(DMValue val)
        {
            if (val.Type == DMValueType.List)
            {
                var other = val.ListValue;
                var count = other.Count;
                for (var i = 0; i < count; i++)
                {
                    var v = other._values[i];
                    _values.Add(v);
                    if (other._assoc != null && other._assoc.TryGetValue(v, out var a))
                        (_assoc ??= new Dictionary<DMValue, DMValue>())[v] = a;
                }
            }
            else
            {
                _values.Add(val);
            }
            Changed();
        }

        /// <summary>Removes the LAST occurrence (BYOND Remove semantics).</summary>
        public bool RemoveValue(DMValue value)
        {
            var idx = _values.LastIndexOf(value);
            if (idx < 0) return false;
            _values.RemoveAt(idx);
            if (_assoc != null && !Contains(value)) _assoc.Remove(value);
            Changed();
            return true;
        }

        /// <summary>L -= x / L.Remove(x): a list argument removes each of its elements.</summary>
        public bool Remove(DMValue val)
        {
            if (val.Type == DMValueType.List)
            {
                var any = false;
                foreach (var v in val.ListValue._values.ToArray()) any |= RemoveValue(v);
                return any;
            }
            return RemoveValue(val);
        }

        /// <summary>L |= x: append each element not already present.</summary>
        public void Combine(DMValue val)
        {
            if (val.Type == DMValueType.List)
            {
                var other = val.ListValue;
                foreach (var v in other._values.ToArray())
                {
                    if (!Contains(v))
                    {
                        _values.Add(v);
                        if (other._assoc != null && other._assoc.TryGetValue(v, out var a))
                            (_assoc ??= new Dictionary<DMValue, DMValue>())[v] = a;
                    }
                }
            }
            else if (!Contains(val))
            {
                _values.Add(val);
            }
            Changed();
        }

        /// <summary>L &amp;= x: keep only elements also in x.</summary>
        public void Mask(DMValue val)
        {
            var kept = Intersect(val);
            _values.Clear();
            _values.AddRange(kept._values);
            _assoc = kept._assoc;
            Changed();
        }

        public void Insert(int index, DMValue val)
        {
            if (index == 0) index = _values.Count + 1;
            if (index < 1 || index > _values.Count + 1) throw new DMRuntimeError("list index out of bounds");
            if (val.Type == DMValueType.List)
                _values.InsertRange(index - 1, val.ListValue._values);
            else
                _values.Insert(index - 1, val);
            Changed();
        }

        public void Cut(int start = 1, int end = 0)
        {
            if (start == 0) start = 1;
            if (end == 0 || end > _values.Count + 1) end = _values.Count + 1;
            if (start < 1 || start > end) throw new DMRuntimeError("list index out of bounds");
            var removed = _values.GetRange(start - 1, end - start);
            _values.RemoveRange(start - 1, end - start);
            if (_assoc != null)
                foreach (var k in removed)
                    if (!Contains(k)) _assoc.Remove(k);
            Changed();
        }

        public DMList Copy(int start = 1, int end = 0)
        {
            if (start == 0) start = 1;
            if (end == 0 || end > _values.Count + 1) end = _values.Count + 1;
            var copy = new DMList();
            for (var i = start; i < end; i++)
            {
                var v = _values[i - 1];
                copy._values.Add(v);
                if (_assoc != null && _assoc.TryGetValue(v, out var a)) (copy._assoc ??= new())[v] = a;
            }
            return copy;
        }

        public void Swap(int a, int b)
        {
            var ia = CheckIndex(a);
            var ib = CheckIndex(b);
            (_values[ia], _values[ib]) = (_values[ib], _values[ia]);
            Changed();
        }

        public void Resize(int size)
        {
            if (size < 0) size = 0;
            if (size < _values.Count)
            {
                Cut(size + 1);
                return;
            }
            while (_values.Count < size) _values.Add(DMValue.Null);
            Changed();
        }

        public void Clear()
        {
            _values.Clear();
            _assoc = null;
            Changed();
        }

        // ===== Copying set operations (+ - & | ^) =====

        public DMList CopyWith(DMValue val)
        {
            var copy = Clone();
            copy.Append(val);
            return copy;
        }

        public DMList CopyWithout(DMValue val)
        {
            var copy = Clone();
            copy.Remove(val);
            return copy;
        }

        public DMList Union(DMValue val)
        {
            var copy = Clone();
            copy.Combine(val);
            return copy;
        }

        /// <summary>Intersection keeps min(left, right) occurrences in left order.</summary>
        public DMList Intersect(DMValue val)
        {
            var result = new DMList();
            var other = val.AsList();
            Dictionary<DMValue, int>? remaining = null;
            if (other != null)
            {
                remaining = new Dictionary<DMValue, int>();
                foreach (var v in other._values) remaining[v] = remaining.GetValueOrDefault(v) + 1;
            }
            var scalarAvailable = true;
            foreach (var v in _values)
            {
                bool keep;
                if (remaining != null)
                {
                    keep = remaining.TryGetValue(v, out var n) && n > 0;
                    if (keep) remaining[v] = n - 1;
                }
                else
                {
                    keep = scalarAvailable && v.Equals(val);
                    if (keep) scalarAvailable = false;
                }
                if (!keep) continue;
                result._values.Add(v);
                if (_assoc != null && _assoc.TryGetValue(v, out var a)) (result._assoc ??= new())[v] = a;
            }
            return result;
        }

        public DMList SymmetricDifference(DMValue val)
        {
            var other = val.AsList() ?? FromArray(new[] { val });
            var result = new DMList();
            foreach (var v in _values)
                if (!other.Contains(v)) result.AddWithAssoc(v, this);
            foreach (var v in other._values)
                if (!Contains(v)) result.AddWithAssoc(v, other);
            return result;
        }

        private void AddWithAssoc(DMValue v, DMList source)
        {
            _values.Add(v);
            if (source._assoc != null && source._assoc.TryGetValue(v, out var a)) (_assoc ??= new())[v] = a;
        }
    }
}
