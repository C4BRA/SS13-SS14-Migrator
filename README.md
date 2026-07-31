# dm2ss14

Automated transpiler that converts SS13 / BYOND (Dream Maker) codebases into SS14
(RobustToolbox) C# solutions. Parses DM source, DMI icons, and DMM maps and emits
entity prototypes, ECS systems, RSI textures, and grid maps.

## Requirements

- Node.js >= 18
- (Optional) .NET SDK 8+ to compile the generated C# solution

## Install & Build

```bash
npm install
npm run build       # compiles TypeScript to dist/
npm test            # runs the full test suite (parser, transpiler, DMI, DMM)
```

## Usage

### CLI

```bash
node dist/cli.js --input <ss13-repo-path> --output <ss14-output-path>
# or
npm start -- --input <ss13-repo-path> --output <ss14-output-path>
```

### GUI

```bash
node dist/cli.js            # or: node dist/cli.js gui
```

Serves a local web app at `http://localhost:3456` — drag in a `.zip` of an SS13
repository and the converted solution is written to your Downloads folder.

## What it does

1. **Bootstraps an SS14 solution** — `Content.sln` with `SS13.DM.Runtime`
   (a dynamic `DMValue` runtime), `Content.Shared`, `Content.Server`, `Content.Client`.
2. **Preprocesses & parses DM source** — a `#include`/`#define`/`#if`-aware
   preprocessor feeds a hand-written lexer and indentation-sensitive parser that
   builds an AST (type declarations, vars, procs, `if`/`else if`/`switch`/
   `for`/`for-in`/`while`, `spawn`/`sleep`, verbs with `set` modifiers, and full
   expressions including string interpolation).
3. **Builds a DM-IR** — merges all files into a type hierarchy, auto-synthesizes
   missing parents, and classifies types as *static* (plain YAML prototype) or
   *dynamic* (needs the DM runtime component).
4. **Emits output**:
   - `Resources/Prototypes/converted_entities.yml` — entity prototypes with
     SS14-correct components (`Sprite`, `Physics`/`Fixtures`, `DMRuntime` with
     `initialVars`), parent chains (`/obj→BaseItem`, `/turf→BaseFloor/BaseWall`,
     `/mob→BaseMobDummy`), and `{attr=val}` tile attributes
   - `Content.Server/DM/ConvertedDMSystems.cs` — one async method per proc with
     runtime support for `usr`/`src`/`args`, DM truthiness (`"0"` is falsy),
     text/number coercion, and string-concat `+`
   - `Resources/Textures/**/*.rsi` — DMI icons converted to RSI (tEXt/iTXt/zTXt
     metadata, per-direction delays)
   - `Resources/Maps/**/*.yml` — DMM maps converted to grid maps
5. **Reports diagnostics** — errors and warnings are aggregated per file with
   source positions (including orphan DMM tile keys, non-rectangular grids,
   DMI frame/delay mismatches); the CLI exits non-zero if any errors were found.

Builtins (`pick`, `rand`, `list`, `length`, `text`, `text2num`, `num2text`,
`copytext`, `findtext`, `clamp`, `max`, `min`, `round`, `abs`, `uppertext`,
`lowertext`, `hascall`, `alert`, `input`, `icon`, `sleep`, `spawn`, `qdel`,
`locate`, `istype`, `ispath`, `prob`) map to runtime helpers in the generated
solution.

## Architecture

```
src/
  parser/      dmLexer.ts, dmParser.ts        DM tokenizer + AST parser
  preprocessor.ts                             #include/#define/#if handling
  ir/          dmIRGenerator.ts               type hierarchy + static/dynamic split
  transpiler/  csharpEmitter.ts, expressionTranspiler.ts,
               yamlGenerator.ts, builtinMappings.ts
  dmi/         dmiParser.ts, rsiWriter.ts     DMI (PNG chunk) -> RSI
  dmm/         dmmParser.ts, mapConverter.ts  DMM -> grid YAML
  project/     ss14Template.ts                solution scaffolding
  runtimeTemplate/ dmRuntimeCS.ts             embedded C# runtime (DMValue, ...)
  gui/         server.ts                      local web UI
  tests/       runTests.ts + suites           test runner (no framework deps)
```

## Known limitations

See `PLAN.md` ("Out of scope"). Notable items: no argument macros, no
screen/overlay/appearance handling, verb-to-command mapping is stubbed, and the
generated solution builds against a vendored minimal `Robust.Shared` shim rather
than the real engine.

## License

MIT
