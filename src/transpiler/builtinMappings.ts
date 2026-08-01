// Shared mapping of DM builtin proc calls to generated C#.
// Returns the C# expression string, or null for user-defined procs.
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
    default:
      return null;
  }
}
