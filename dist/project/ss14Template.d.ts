/**
 * Emits a Content solution that builds against the REAL RobustToolbox engine
 * (github.com/space-wizards/RobustToolbox, MIT). The engine source is located
 * via the MSBuild property `EngineDir`:
 *   - default: `$(MSBuildThisFileDirectory)..\..\RobustToolbox` (i.e. a
 *     `RobustToolbox` checkout next to the generated output dir)
 *   - override:  `dotnet build Content.sln -p:EngineDir=/path/to/RobustToolbox`
 *
 * Engine pin: see `engine.pin` in this repo. Verified against commit
 * 9cefa1167c9ac45f7258094129daf46b6c3516d3 (net10.0, LangVersion 14).
 *
 * SS13.DM.Runtime is engine-free by design (pure C# datum runtime); the only
 * engine-dependent surface is Content.Server/DM/DMRuntimeComponent.cs and
 * Content.Server/DM/ConvertedDMSystem.cs (generated).
 */
export declare class SS14Template {
    generateSS14Solution(outputDir: string): void;
}
