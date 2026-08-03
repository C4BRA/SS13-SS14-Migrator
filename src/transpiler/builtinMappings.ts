// Shared mapping of DM builtin proc calls to generated C#.
// Returns the C# expression string, or null for user-defined procs.

export const MAPPED_BUILTINS = [  'sleep', 'spawn', 'qdel', 'locate', 'istype', 'ispath', 'prob', 'pick', 'rand',
  'list', 'length', 'text', 'text2num', 'num2text', 'copytext', 'findtext', 'findtextex',
  'clamp', 'max', 'min', 'round', 'abs', 'uppertext', 'lowertext', 'hascall',
  'alert', 'input', 'icon', 'islist', 'replacetext',
  'isnull', 'isnum', 'istext', 'isturf', 'isobj', 'ismob', 'isarea', 'ismovable',
  'isloc', 'isitem', 'iscarbon', 'isliving', 'crash', 'nameof', 'typesof',
  'initial', 'call', 'turn', 'get_step', 'get_dist', 'get_dir', 'get_turf',
  'range', 'view', 'oview', 'block', 'splittext', 'jointext', 'params2list',
  'text2path', 'rgb', 'fexists', 'isnan', 'isinf', 'json_decode', 'animate',
  'image', 'flick', 'sound', 'matrix', 'browse', 'call_ext', '__detect_rust_g',
  'floor', 'ceil', 'sqrt', 'sin', 'cos', 'arccos', 'log', 'sign',
  'copytext_char', 'length_char', 'text2ascii', 'ascii2text', 'ckey', 'sorttext',
  'replacetextex', 'html_encode', 'html_decode', 'rgb2num', 'json_encode',
  'time2text', 'list2params', 'arglist', 'alist', 'spacemandmm_unlint', 'file',
  'isfile', 'fdel', 'fcopy', 'fcopy_rsc', 'flist', 'ref', 'refcount',
  'step', 'step_towards', 'step_away', 'get_step_away', 'get_step_towards',
  'orange', 'viewers', 'hearers',
  // Tier-3 wave (2026-08-02): remaining corpus backlog
  'regex', 'regex_quote', 'astype', 'isicon', 'icon_states', 'arctan',
  'findlasttext', 'values_sum', 'values_dot', 'values_min', 'values_max',
  'roll', 'winset', 'link', 'gradient', 'vector', 'openToolTip',
  'closeToolTip', 'browse_rsc', 'ftp'
];

// NOTE: every entry above is LOWERCASE. DM proc names are case-insensitive —
// callers must lowercase `name` before these lookups (item 57).

// Builtins whose runtime helpers are recognized stubs returning Null/0
// (engine/UI integration points). The audit counts their call sites as loss —
// they are NOT "resolved" just because the name is mapped (WS7-16).
export const STUBBED_BUILTINS = [
  'animate', 'image', 'flick', 'sound', 'matrix', 'browse', 'call_ext',
  '__detect_rust_g', 'alert', 'input', 'icon', 'locate', 'refcount',
  'winset', 'link', 'gradient', 'vector', 'openToolTip', 'closeToolTip',
  'browse_rsc', 'ftp'
];

export function transpileBuiltinCall(name: string, args: string): string | null {
  switch (name) {
    case 'sleep':
      return `await DMTickScheduler.Sleep(${args || 'DMValue.FromNumber(1)'})`;
    case 'spawn':
      // spawn() as an *expression* (`x = spawn(2) body`) is a statement in DM;
      // the emitter pre-empts statement-form spawn. This fallback keeps value
      // position compile-valid: the body runs async, the expression evaluates
      // to Null (DM's spawn token is not representable — WS5-7).
      return `(await DMTickScheduler.SpawnExpr(${args || 'DMValue.FromNumber(0)'}, async () => { return DMValue.Null; }))`;
    case 'qdel':
      return `DMDelete(${args})`;
    case 'locate':
      return `DMLocate(${args})`;
    case 'istype':
      return `DMIsType(${args})`;
    case 'ispath':
      return `DMIsPath(${args})`;
    case 'islist':
      return `DMIsList(${args})`;
    case 'replacetext':
      return `ReplaceText(${args})`;
    case 'prob':
      return `DMProb(${args})`;
    case 'pick':
      return `DMRuntimeHelpers.Pick(${args})`;
    case 'rand':
      return `DMRuntimeHelpers.Rand(${args})`;
    case 'list':
      return `DMRuntimeHelpers.MakeList(${args})`;
    case 'length':
      return `DMRuntimeHelpers.Length(${args})`;
    case 'text':
      return `DMRuntimeHelpers.Text(${args})`;
    case 'text2num':
      return `DMRuntimeHelpers.Text2Num(${args})`;
    case 'num2text':
      return `DMRuntimeHelpers.Num2Text(${args})`;
    case 'copytext':
      return `DMRuntimeHelpers.CopyText(${args})`;
    case 'findtext':
      return `DMRuntimeHelpers.FindText(${args})`;
    case 'findtextex':
      return `DMRuntimeHelpers.FindTextEx(${args})`;
    case 'clamp':
      return `DMRuntimeHelpers.Clamp(${args})`;
    case 'max':
      return `DMRuntimeHelpers.Max(${args})`;
    case 'min':
      return `DMRuntimeHelpers.Min(${args})`;
    case 'round':
      return `DMRuntimeHelpers.Round(${args})`;
    case 'abs':
      return `DMRuntimeHelpers.Abs(${args})`;
    case 'uppertext':
      return `DMRuntimeHelpers.UpperText(${args})`;
    case 'lowertext':
      return `DMRuntimeHelpers.LowerText(${args})`;
    case 'hascall':
      return `DMRuntimeHelpers.HasCall(${args})`;
    case 'alert':
      return `DMRuntimeHelpers.Alert(${args})`;
    case 'input':
      return `DMRuntimeHelpers.Input(${args})`;
    case 'icon':
      return `DMRuntimeHelpers.Icon(${args})`;
    case 'isnull':
      return `DMRuntimeHelpers.DMIsNull(${args})`;
    case 'isnum':
      return `DMRuntimeHelpers.DMIsNum(${args})`;
    case 'istext':
      return `DMRuntimeHelpers.DMIsText(${args})`;
    case 'isturf':
      return `DMIsType(${args}, DMValue.FromString("/turf"))`;
    case 'isobj':
      return `DMIsType(${args}, DMValue.FromString("/obj"))`;
    case 'ismob':
      return `DMIsType(${args}, DMValue.FromString("/mob"))`;
    case 'isarea':
      return `DMIsType(${args}, DMValue.FromString("/area"))`;
    case 'ismovable':
      // BYOND ismovable = isobj || ismob (movable atoms); a single
      // "/atom/movable" base never matches real datum paths (WS7-7).
      return `(DMIsType(${args}, DMValue.FromString("/obj")).IsTrue() || DMIsType(${args}, DMValue.FromString("/mob")).IsTrue() ? DMValue.FromNumber(1) : DMValue.FromNumber(0))`;
    case 'isloc':
      // BYOND isloc = isturf || isarea || isobj || ismob (WS7-7).
      return `(DMIsType(${args}, DMValue.FromString("/turf")).IsTrue() || DMIsType(${args}, DMValue.FromString("/area")).IsTrue() || DMIsType(${args}, DMValue.FromString("/obj")).IsTrue() || DMIsType(${args}, DMValue.FromString("/mob")).IsTrue() ? DMValue.FromNumber(1) : DMValue.FromNumber(0))`;
    case 'isitem':
      return `DMIsType(${args}, DMValue.FromString("/obj/item"))`;
    case 'iscarbon':
      return `DMIsType(${args}, DMValue.FromString("/mob/living/carbon"))`;
    case 'isliving':
      return `DMIsType(${args}, DMValue.FromString("/mob/living"))`;
    case 'crash':
      return `DMRuntimeHelpers.DMCRASH(${args})`;
    case 'nameof':
      return `DMRuntimeHelpers.NameOf(${args})`;
    case 'typesof':
      return `DMRuntimeHelpers.TypesOf(${args})`;
    case 'initial':
      return `DMRuntimeHelpers.DMInitial(${args})`;
    case 'call':
      return `DMRuntimeHelpers.MakeProcRef(${args})`;
    case 'turn':
      return `DMRuntimeHelpers.Turn(${args})`;
    case 'get_step':
      return `DMRuntimeHelpers.GetStep(${args})`;
    case 'get_dist':
      return `DMRuntimeHelpers.GetDist(${args})`;
    case 'get_dir':
      return `DMRuntimeHelpers.GetDir(${args})`;
    case 'get_turf':
      return `DMRuntimeHelpers.GetTurf(${args})`;
    case 'range':
      return `DMRuntimeHelpers.Range(${args})`;
    case 'view':
      return `DMRuntimeHelpers.View(${args})`;
    case 'oview':
      return `DMRuntimeHelpers.OView(${args})`;
    case 'block':
      return `DMRuntimeHelpers.Block(${args})`;
    case 'splittext':
      return `DMRuntimeHelpers.SplitText(${args})`;
    case 'jointext':
      return `DMRuntimeHelpers.JoinText(${args})`;
    case 'params2list':
      return `DMRuntimeHelpers.Params2List(${args})`;
    case 'text2path':
      return `DMRuntimeHelpers.Text2Path(${args})`;
    case 'rgb':
      return `DMRuntimeHelpers.RGB(${args})`;
    case 'fexists':
      return `DMRuntimeHelpers.FExists(${args})`;
    case 'isnan':
      return `DMRuntimeHelpers.IsNaN(${args})`;
    case 'isinf':
      return `DMRuntimeHelpers.IsInf(${args})`;
    case 'json_decode':
      return `DMRuntimeHelpers.JsonDecode(${args})`;
    case 'animate':
      return `DMRuntimeHelpers.Animate(${args})`;
    case 'image':
      return `DMRuntimeHelpers.Image(${args})`;
    case 'flick':
      return `DMRuntimeHelpers.Flick(${args})`;
    case 'sound':
      return `DMRuntimeHelpers.Sound(${args})`;
    case 'matrix':
      return `DMRuntimeHelpers.Matrix(${args})`;
    case 'browse':
      return `DMRuntimeHelpers.Browse(${args})`;
    case 'call_ext':
      return `DMRuntimeHelpers.CallExt(${args})`;
    case '__detect_rust_g':
      return `DMRuntimeHelpers.DetectRustG(${args})`;
    case 'floor':
      return `DMRuntimeHelpers.Floor(${args})`;
    case 'ceil':
      return `DMRuntimeHelpers.Ceil(${args})`;
    case 'sqrt':
      return `DMRuntimeHelpers.Sqrt(${args})`;
    case 'sin':
      return `DMRuntimeHelpers.Sin(${args})`;
    case 'cos':
      return `DMRuntimeHelpers.Cos(${args})`;
    case 'arccos':
      return `DMRuntimeHelpers.ArcCos(${args})`;
    case 'log':
      return `DMRuntimeHelpers.Log(${args})`;
    case 'arctan':
      return `DMRuntimeHelpers.Arctan(${args})`;
    case 'regex_quote':
      return `DMRuntimeHelpers.RegexQuote(${args})`;
    case 'findlasttext':
      return `DMRuntimeHelpers.FindLastText(${args})`;
    case 'values_sum':
      return `DMRuntimeHelpers.ValuesSum(${args})`;
    case 'values_dot':
      return `DMRuntimeHelpers.ValuesDot(${args})`;
    case 'values_min':
      return `DMRuntimeHelpers.ValuesMin(${args})`;
    case 'values_max':
      return `DMRuntimeHelpers.ValuesMax(${args})`;
    case 'roll':
      return `DMRuntimeHelpers.Roll(${args})`;
    case 'astype':
      return `DMRuntimeHelpers.Astype(${args})`;
    case 'isicon':
      return `DMRuntimeHelpers.IsIcon(${args})`;
    case 'icon_states':
      return `DMRuntimeHelpers.IconStates(${args})`;
    case 'regex':
      return `DMRuntimeHelpers.DMRegex(${args})`;
    case 'sign':
      return `DMRuntimeHelpers.Sign(${args})`;
    case 'copytext_char':
      return `DMRuntimeHelpers.CopyTextChar(${args})`;
    case 'length_char':
      return `DMRuntimeHelpers.LengthChar(${args})`;
    case 'text2ascii':
      return `DMRuntimeHelpers.Text2Ascii(${args})`;
    case 'ascii2text':
      return `DMRuntimeHelpers.Ascii2Text(${args})`;
    case 'ckey':
      return `DMRuntimeHelpers.CKey(${args})`;
    case 'sorttext':
      return `DMRuntimeHelpers.SortText(${args})`;
    case 'replacetextex':
      return `DMRuntimeHelpers.ReplaceTextEx(${args})`;
    case 'html_encode':
      return `DMRuntimeHelpers.HtmlEncode(${args})`;
    case 'html_decode':
      return `DMRuntimeHelpers.HtmlDecode(${args})`;
    case 'rgb2num':
      return `DMRuntimeHelpers.RGB2Num(${args})`;
    case 'json_encode':
      return `DMRuntimeHelpers.JsonEncode(${args})`;
    case 'time2text':
      return `DMRuntimeHelpers.Time2Text(${args})`;
    case 'list2params':
      return `DMRuntimeHelpers.List2Params(${args})`;
    case 'arglist':
      return `DMRuntimeHelpers.DMArgList(${args})`;
    case 'alist':
      return `DMRuntimeHelpers.MakeList(${args})`;
    case 'spacemandmm_unlint':
      return `DMRuntimeHelpers.SpacemanUnlint(${args})`;
    case 'file':
      return `DMRuntimeHelpers.File(${args})`;
    case 'isfile':
      return `DMRuntimeHelpers.IsFile(${args})`;
    case 'fdel':
      return `DMRuntimeHelpers.FileDel(${args})`;
    case 'fcopy':
      return `DMRuntimeHelpers.FileCopy(${args})`;
    case 'fcopy_rsc':
      return `DMRuntimeHelpers.FileCopyRsc(${args})`;
    case 'flist':
      return `DMRuntimeHelpers.FList(${args})`;
    case 'ref':
      return `DMRuntimeHelpers.Ref(${args})`;
    case 'refcount':
      return `DMRuntimeHelpers.RefCount(${args})`;
    case 'step':
      return `DMRuntimeHelpers.Step(${args})`;
    case 'step_towards':
      return `DMRuntimeHelpers.StepTowards(${args})`;
    case 'step_away':
      return `DMRuntimeHelpers.StepAway(${args})`;
    case 'get_step_away':
      return `DMRuntimeHelpers.GetStepAway(${args})`;
    case 'get_step_towards':
      return `DMRuntimeHelpers.GetStepTowards(${args})`;
    case 'orange':
      return `DMRuntimeHelpers.Orange(${args})`;
    case 'viewers':
      return `DMRuntimeHelpers.Viewers(${args})`;
    case 'hearers':
      return `DMRuntimeHelpers.Hearers(${args})`;
    default:
      return null;
  }
}
