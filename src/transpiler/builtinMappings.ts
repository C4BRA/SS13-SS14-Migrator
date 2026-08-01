// Shared mapping of DM builtin proc calls to generated C#.
// Returns the C# expression string, or null for user-defined procs.

export const MAPPED_BUILTINS = [
  'sleep', 'spawn', 'qdel', 'locate', 'istype', 'ispath', 'prob', 'pick', 'rand',
  'list', 'length', 'text', 'text2num', 'num2text', 'copytext', 'findtext',
  'clamp', 'max', 'min', 'round', 'abs', 'uppertext', 'lowertext', 'hascall',
  'alert', 'input', 'icon', 'islist', 'replacetext',
  'isnull', 'isnum', 'istext', 'isturf', 'isobj', 'ismob', 'isarea', 'ismovable',
  'isloc', 'isitem', 'iscarbon', 'isliving', 'CRASH', 'nameof', 'typesof',
  'initial', 'call', 'turn', 'get_step', 'get_dist', 'get_dir', 'get_turf',
  'range', 'view', 'oview', 'block', 'splittext', 'jointext', 'params2list',
  'text2path', 'rgb', 'fexists', 'isnan', 'isinf', 'json_decode', 'animate',
  'image', 'flick', 'sound', 'matrix', 'browse', 'call_ext', '__detect_rust_g'
];

export function transpileBuiltinCall(name: string, args: string): string | null {
  switch (name) {
    case 'sleep':
      return `await DMTickScheduler.Sleep(${args || 'DMValue.FromNumber(1)'})`;
    case 'spawn':
      return `DMTickScheduler.Spawn(${args || 'DMValue.FromNumber(0)'}, async () => { /* spawn body */ })`;
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
      return `DMIsType(${args}, DMValue.FromString("/atom/movable"))`;
    case 'isloc':
      return `DMIsType(${args}, DMValue.FromString("/atom"))`;
    case 'isitem':
      return `DMIsType(${args}, DMValue.FromString("/obj/item"))`;
    case 'iscarbon':
      return `DMIsType(${args}, DMValue.FromString("/mob/living/carbon"))`;
    case 'isliving':
      return `DMIsType(${args}, DMValue.FromString("/mob/living"))`;
    case 'CRASH':
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
    default:
      return null;
  }
}
