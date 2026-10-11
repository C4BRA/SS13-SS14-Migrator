import { DMIRType } from './dmIRGenerator.js';

// Typed vars, step 1: a fixed slot layout per DM type. A type's layout is
// its parent's layout followed by the vars the type adds, so a var declared
// on an ancestor keeps the SAME slot index in every descendant. The runtime
// (DMVarLayouts in the runtime template) rebuilds layouts from the same
// (parent, own vars) registrations, so indices computed here match the
// runtime by construction.

// Built-in atom vars the IR consumes into dedicated fields instead of
// customVars. They still live on the datum at runtime, so they get slots.
const ATOM_BUILTIN_VARS = ['name', 'desc', 'icon', 'icon_state'];

// Vars the runtime computes or reads through its own storage paths
// (containment, coordinates, type identity). They stay in the dictionary.
const UNSLOTTED_VARS = new Set([
  'loc', 'contents', 'x', 'y', 'z', 'type', 'parent_type', 'vars', 'verbs',
]);

export interface VarLayout {
  path: string;
  parentPath: string | null;
  /** Vars this type adds to its parent's layout, in slot order. */
  own: string[];
  /** Full layout: name -> slot index. */
  index: Map<string, number>;
}

export function computeVarLayouts(irMap: Map<string, DMIRType>): Map<string, VarLayout> {
  const layouts = new Map<string, VarLayout>();

  const build = (path: string, depth: number): VarLayout | null => {
    const existing = layouts.get(path);
    if (existing) return existing;
    const ir = irMap.get(path);
    if (!ir || depth > 256) return null;

    // Mirrors DMVarLayouts.Build: an unregistered parent contributes nothing.
    const parent = ir.parentPath ? build(ir.parentPath, depth + 1) : null;
    const index = new Map<string, number>(parent ? parent.index : []);
    const own: string[] = [];
    const add = (name: string) => {
      if (UNSLOTTED_VARS.has(name) || index.has(name)) return;
      index.set(name, index.size);
      own.push(name);
    };
    if (path === '/atom') ATOM_BUILTIN_VARS.forEach(add);
    for (const name of ir.customVars.keys()) add(name);

    const layout: VarLayout = { path, parentPath: ir.parentPath, own, index };
    layouts.set(path, layout);
    return layout;
  };

  for (const path of irMap.keys()) build(path, 0);
  return layouts;
}
