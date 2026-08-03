import * as fs from 'fs';
import * as path from 'path';
import { DMRuntimeCS } from '../runtimeTemplate/dmRuntimeCS.js';

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
export class SS14Template {
  public generateSS14Solution(outputDir: string): void {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // 1. Solution file Content.sln (engine projects are pulled in via
    //    ProjectReference and do not need to be listed here).
    const projects = [
      { name: 'SS13.DM.Runtime', file: 'SS13.DM.Runtime\\SS13.DM.Runtime.csproj', guid: '{11111111-1111-1111-1111-111111111111}' },
      { name: 'Content.Shared', file: 'Content.Shared\\Content.Shared.csproj', guid: '{22222222-2222-2222-2222-222222222222}' },
      { name: 'Content.Server', file: 'Content.Server\\Content.Server.csproj', guid: '{33333333-3333-3333-3333-333333333333}' },
      { name: 'Content.Client', file: 'Content.Client\\Content.Client.csproj', guid: '{44444444-4444-4444-4444-444444444444}' },
    ];

    let slnContent = `
Microsoft Visual Studio Solution File, Format Version 12.00
# Visual Studio Version 17
VisualStudioVersion = 17.0.31903.59
MinimumVisualStudioVersion = 10.0.40219.1
`;
    for (const p of projects) {
      slnContent += `Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "${p.name}", "${p.file}", "${p.guid}"\nEndProject\n`;
    }
    slnContent += `Global
\tGlobalSection(SolutionConfigurationPlatforms) = preSolution
\t\tDebug|Any CPU = Debug|Any CPU
\t\tRelease|Any CPU = Release|Any CPU
\tEndGlobalSection
\tGlobalSection(ProjectConfigurationPlatforms) = postSolution
`;
    for (const p of projects) {
      slnContent += `\t\t${p.guid}.Debug|Any CPU.ActiveCfg = Debug|Any CPU\n`;
      slnContent += `\t\t${p.guid}.Debug|Any CPU.Build.0 = Debug|Any CPU\n`;
      slnContent += `\t\t${p.guid}.Release|Any CPU.ActiveCfg = Release|Any CPU\n`;
      slnContent += `\t\t${p.guid}.Release|Any CPU.Build.0 = Release|Any CPU\n`;
    }
    slnContent += `\tEndGlobalSection
EndGlobal
`;
    fs.writeFileSync(path.join(outputDir, 'Content.sln'), slnContent.trim(), 'utf-8');

    // Shared MSBuild props: TFM + engine location.
    const engineDirProp = `<PropertyGroup>
    <EngineDir Condition="'$(EngineDir)' == ''">$(MSBuildThisFileDirectory)..\\..\\RobustToolbox</EngineDir>
  </PropertyGroup>`;

    // 2. SS13.DM.Runtime Project — engine-free datum runtime.
    const runtimeDir = path.join(outputDir, 'SS13.DM.Runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });

    const runtimeCsproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>`;
    fs.writeFileSync(path.join(runtimeDir, 'SS13.DM.Runtime.csproj'), runtimeCsproj, 'utf-8');

    for (const file of DMRuntimeCS.getRuntimeCSFiles()) {
      fs.writeFileSync(path.join(runtimeDir, file.filename), file.content, 'utf-8');
    }

    // 3. Content.Shared Project
    const sharedDir = path.join(outputDir, 'Content.Shared');
    fs.mkdirSync(sharedDir, { recursive: true });

    const sharedCsproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\\SS13.DM.Runtime\\SS13.DM.Runtime.csproj" />
  </ItemGroup>
</Project>`;
    fs.writeFileSync(path.join(sharedDir, 'Content.Shared.csproj'), sharedCsproj, 'utf-8');
    fs.writeFileSync(path.join(sharedDir, 'DummyShared.cs'), 'namespace Content.Shared { public class Dummy { } }', 'utf-8');

    // 4. Content.Server Project — references the REAL RobustToolbox.
    const serverDir = path.join(outputDir, 'Content.Server');
    fs.mkdirSync(serverDir, { recursive: true });

    const serverCsproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  ${engineDirProp}
  <ItemGroup>
    <ProjectReference Include="..\\SS13.DM.Runtime\\SS13.DM.Runtime.csproj" />
    <ProjectReference Include="..\\Content.Shared\\Content.Shared.csproj" />
    <ProjectReference Include="$(EngineDir)/Robust.Shared/Robust.Shared.csproj" />
    <ProjectReference Include="$(EngineDir)/Robust.Server/Robust.Server.csproj" />
  </ItemGroup>
</Project>`;
    fs.writeFileSync(path.join(serverDir, 'Content.Server.csproj'), serverCsproj, 'utf-8');

    // Engine-facing adapter: SS14 component holding the DM datum. The YAML
    // prototype emitter writes `type: DMRuntime` (component name = class name
    // minus the "Component" suffix) with dmTypePath + initialVars data fields.
    const dmServerDir = path.join(serverDir, 'DM');
    fs.mkdirSync(dmServerDir, { recursive: true });
    const dmComponentCS = `using System.Collections.Generic;
using Robust.Shared.GameObjects;
using Robust.Shared.Serialization.Manager.Attributes;
using SS13.DM.Runtime;

namespace Content.Server.DM
{
    /// <summary>
    /// SS14 ECS component that carries a DM datum (SS13.DM.Runtime.DMRuntime)
    /// on a real engine entity. Prototype YAML:
    ///   - type: DMRuntime
    ///     dmTypePath: /obj/item/...
    ///     initialVars:
    ///       custom_var: value
    /// Initialization (DMTypePath/InitialVars -> runtime) and New() dispatch
    /// happen in ConvertedDMSystem.OnDMComponentInit.
    /// </summary>
    [RegisterComponent]
    public sealed class DMRuntimeComponent : Component
    {
        [DataField("dmTypePath")]
        public string DMTypePath { get; set; } = "/datum";

        [DataField("initialVars")]
        public Dictionary<string, string> InitialVars { get; set; } = new();

        public DMRuntime Runtime { get; } = new();
    }
}
`;
    fs.writeFileSync(path.join(dmServerDir, 'DMRuntimeComponent.cs'), dmComponentCS, 'utf-8');

    // Real Robust.Server boot entry (item 66): RobustServerHost.Run loads the
    // content assembly, resources and config, then enters the game loop.
    // Verification: `scripts/setup-engine.sh` then `dotnet run` from the
    // output directory — the server must reach "Running" (lobby, no rules).
    const programCS = `using Robust.Server;

namespace Content.Server
{
    internal static class Program
    {
        public static void Main(string[] args) => RobustServerHost.Run(args);
    }
}`;
    fs.writeFileSync(path.join(serverDir, 'Program.cs'), programCS, 'utf-8');

    // 5. Content.Client Project (console stub; full Robust.Client integration
    //    is out of scope for Phase 0 — see PLAN.md).
    const clientDir = path.join(outputDir, 'Content.Client');
    fs.mkdirSync(clientDir, { recursive: true });

    const clientCsproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\\SS13.DM.Runtime\\SS13.DM.Runtime.csproj" />
    <ProjectReference Include="..\\Content.Shared\\Content.Shared.csproj" />
  </ItemGroup>
</Project>`;
    fs.writeFileSync(path.join(clientDir, 'Content.Client.csproj'), clientCsproj, 'utf-8');
    fs.writeFileSync(path.join(clientDir, 'Program.cs'), `using System; namespace Content.Client { public class Program { public static void Main(string[] args) { Console.WriteLine("SS14 Client Initialized"); } } }`, 'utf-8');

    // 6. Config files — placed under Resources/ConfigFiles so the booted
    //    server (which loads resources from the output directory) finds them.
    const resourcesDir = path.join(outputDir, 'Resources');
    const configDir = path.join(resourcesDir, 'ConfigFiles');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'server_config.toml'), `[net]\nport = 1212\n[engine]\ntick_rate = 60\n`, 'utf-8');
  }
}
