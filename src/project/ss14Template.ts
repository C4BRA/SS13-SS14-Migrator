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
    <!-- Real-SS14 layout: the engine's content mounts are relative to the
         binary (StartType.Content: ../../ = solution root). Without the
         flattened output path the mounts resolve into bin/Debug/net10.0
         and never find the resources (item 66). -->
    <AppendTargetFrameworkToOutputPath>false</AppendTargetFrameworkToOutputPath>
    <OutputPath>..\\bin\\Content.Server\\</OutputPath>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\\SS13.DM.Runtime\\SS13.DM.Runtime.csproj" />
    <ProjectReference Include="..\\Content.Shared\\Content.Shared.csproj" />
    <!-- Resources + config land next to the binary so the engine's content
         mount finds them at boot (item 66). -->
    <Content Include="..\\Resources\\**" Link="Resources/%(RecursiveDir)%(Filename)%(Extension)" CopyToOutputDirectory="PreserveNewest" />
    <Content Include="server_config.toml" CopyToOutputDirectory="PreserveNewest" />
  </ItemGroup>
  <!-- Engine references go through the official Imports (direct references
       are rejected by Robust.ProjectReferences.targets); the source
       generators produce the ISerializationGenerated implementations and
       entity-system subscriptions (item 66). <output>/RobustToolbox is a
       symlink to the engine checkout (created at transpile time). -->
  <Import Project="..\\RobustToolbox\\Imports\\Shared.props" />
  <Import Project="..\\RobustToolbox\\Imports\\Server.props" />
  <Import Project="..\\RobustToolbox\\MSBuild\\Robust.Properties.targets" />
  <Import Project="..\\RobustToolbox\\MSBuild\\Robust.EntitySystemSubscriptionsGenerator.targets" />
  <!-- The engine mounts content assemblies + resources from bin/RobustToolbox
       (contentBuildDir); mirror the build output there after build. -->
  <Target Name="CopyContentToBuildDir" AfterTargets="Build">
    <ItemGroup>
      <DmDlls Include="$(OutputPath)*.dll" />
      <DmRes Include="$(OutputPath)Resources\\**\\*" />
    </ItemGroup>
    <Copy SourceFiles="@(DmDlls)" DestinationFolder="..\\bin\\RobustToolbox\\" SkipUnchangedFiles="true" />
    <Copy SourceFiles="@(DmRes)" DestinationFiles="..\\bin\\RobustToolbox\\Resources\\%(RecursiveDir)%(Filename)%(Extension)" SkipUnchangedFiles="true" />
  </Target>
</Project>`;
    fs.writeFileSync(path.join(serverDir, 'Content.Server.csproj'), serverCsproj, 'utf-8');
    // server_config.toml is copied to the output by the csproj above.
    fs.writeFileSync(path.join(serverDir, 'server_config.toml'), `[net]\nport = 1212\n[engine]\ntick_rate = 60\n`, 'utf-8');

    // The mod loader bootstraps every GameShared subclass in the content
    // assembly as an entry point. Without one, the component factory never
    // auto-registers and the entity manager fails at Initialize with
    // 'Unknown type: MetaDataComponent' (item 66).
    const entryPointCS = `using Robust.Shared.ContentPack;
using Robust.Shared.GameObjects;
using Robust.Shared.IoC;

namespace Content.Server
{
    /// <summary>
    /// Minimal content entry point (item 66): registers components so the
    /// entity manager can initialize, then generates network IDs.
    /// </summary>
    public sealed class EntryPoint : GameServer
    {
        public override void Init()
        {
            base.Init();
            IoCManager.Resolve<IComponentFactory>().DoAutoRegistrations();
            IoCManager.Resolve<IComponentFactory>().GenerateNetIds();
        }

        public override void PostInit()
        {
            base.PostInit();
            // After the entity manager is up: bootstrap the DM world (default
            // map + world/New) — item 69, B-1.
            IoCManager.Resolve<IEntitySystemManager>().GetEntitySystem<Content.Server.DM.ConvertedDMSystem>().StartWorld();
        }
    }
}`;
    fs.writeFileSync(path.join(serverDir, 'EntryPoint.cs'), entryPointCS, 'utf-8');

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
    public sealed partial class DMRuntimeComponent : Component
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

    // Real Robust.Server boot entry (item 66): ContentStart.Start is the
    // engine's public host (Robust.Server.Program is internal at this pin) —
    // it loads the content assembly, resources and config, then enters the
    // game loop. Verification: `scripts/setup-engine.sh` then `dotnet run`
    // from the output directory — the server must reach "Ready" (lobby).
    const programCS = `using Robust.Server;

namespace Content.Server
{
    internal static class Program
    {
        public static void Main(string[] args) => ContentStart.Start(args);
    }
}`;
    fs.writeFileSync(path.join(serverDir, 'Program.cs'), programCS, 'utf-8');

    // 5. Content.Client Project — real Robust.Client content entry (item 73,
    //    B-5). Same engine mount conventions as the server: the binary must
    //    land in <solution>/bin/Content.Client so StartType.Content mounts it
    //    at /Assemblies/ and <solution>/Resources at /.
    const clientDir = path.join(outputDir, 'Content.Client');
    fs.mkdirSync(clientDir, { recursive: true });

    const clientCsproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <!-- Flattened output path: the engine's StartType.Content mount expects
         the client binary at <solution>/bin/Content.Client (mounts the dir
         at /Assemblies/ and loads Content.* modules from it). -->
    <AppendTargetFrameworkToOutputPath>false</AppendTargetFrameworkToOutputPath>
    <OutputPath>..\\bin\\Content.Client\\</OutputPath>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\\SS13.DM.Runtime\\SS13.DM.Runtime.csproj" />
    <ProjectReference Include="..\\Content.Shared\\Content.Shared.csproj" />
  </ItemGroup>
  <!-- Engine references go through the official Imports (direct references
       are rejected by Robust.ProjectReferences.targets). Client.props pulls
       in Robust.Client (which transitively carries Robust.Shared, SDL3,
       ImageSharp, etc.); the serialization generator produces the
       ISerializationGenerated implementations. -->
  <Import Project="..\\RobustToolbox\\Imports\\Shared.props" />
  <Import Project="..\\RobustToolbox\\Imports\\Client.props" />
  <Import Project="..\\RobustToolbox\\MSBuild\\Robust.Properties.targets" />
  <Import Project="..\\RobustToolbox\\MSBuild\\Robust.EntitySystemSubscriptionsGenerator.targets" />
</Project>`;
    fs.writeFileSync(path.join(clientDir, 'Content.Client.csproj'), clientCsproj, 'utf-8');

    // Real Robust.Client boot entry (item 73): ContentStart.Start is the
    // engine's public client host — it loads Content.* modules from
    // bin/Content.Client, mounts <solution>/Resources at /, and runs the
    // game loop. `--headless` boots without graphics/audio; `--connect
    // [--connect-address <addr>]` auto-connects to a server (default
    // localhost:1212). Verification: `scripts/client-smoke.sh`.
    const clientProgramCS = `using System;
using Robust.Client;

namespace Content.Client
{
    internal static class Program
    {
        [STAThread]
        public static void Main(string[] args) => ContentStart.Start(args);
    }
}`;
    fs.writeFileSync(path.join(clientDir, 'Program.cs'), clientProgramCS, 'utf-8');

    // Content entry point (item 73): the engine's mod loader instantiates
    // every GameShared subclass in the loaded Content.* modules. The client
    // MUST register components + net ids itself — the engine never calls
    // DoAutoRegistrations/GenerateNetIds internally, and once net ids are
    // generated the component table locks (ComponentRegistrationLockException).
    //
    // Two server-only emitted types need client-side ignores, mirroring how
    // the engine's ServerComponentFactory ignores client-only "Sprite":
    //   - DMRuntime component: skipping it silently keeps every converted
    //     entity prototype free of "Unknown component" errors; DMRuntime is
    //     not a networked component so nothing else needs it client-side.
    //   - dmTile prototypes: registered with ITileDefinitionManager by the
    //     server-side ConvertedDMSystem; the client's PrototypeManager has no
    //     dmTile kind and an unknown kind fails the WHOLE yaml document,
    //     which would drop every entity prototype.
    const clientEntryPointCS = `using Robust.Client.State;
using Robust.Client.UserInterface.States;
using Robust.Shared.ContentPack;
using Robust.Shared.GameObjects;
using Robust.Shared.IoC;
using Robust.Shared.Prototypes;

namespace Content.Client
{
    /// <summary>
    /// Content entry point for the generated client (item 73, B-5):
    /// registers content components + net ids, ignores the server-only
    /// emitted types, and shows the engine's builtin connect screen.
    /// </summary>
    public sealed class EntryPoint : GameClient
    {
        public override void Init()
        {
            base.Init();
            var componentFactory = IoCManager.Resolve<IComponentFactory>();
            componentFactory.RegisterIgnore("DMRuntime");
            componentFactory.DoAutoRegistrations();
            componentFactory.GenerateNetIds();
            IoCManager.Resolve<IPrototypeManager>().RegisterIgnore("dmTile");
        }

        public override void PostInit()
        {
            base.PostInit();
            // The engine's builtin connect screen: a working connect UI with
            // no content UI code (Robust debug screen, content-accessible).
            IoCManager.Resolve<IStateManager>()
                .RequestStateChange<DebugBuiltinConnectionScreenState>();
        }
    }
}`;
    fs.writeFileSync(path.join(clientDir, 'EntryPoint.cs'), clientEntryPointCS, 'utf-8');

    // 6. Config files — placed under Resources/ConfigFiles so the booted
    //    server (which loads resources from the output directory) finds them.
    const resourcesDir = path.join(outputDir, 'Resources');
    const configDir = path.join(resourcesDir, 'ConfigFiles');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'server_config.toml'), `[net]\nport = 1212\n[engine]\ntick_rate = 60\n`, 'utf-8');

    // Client resource manifest (item 73): /manifest.yml is read by the
    // client (ResourceManifestData) from the content root mount — the
    // Resources/ dir. autoConnect is the engine default but stated
    // explicitly since `--connect` depends on it.
    fs.writeFileSync(path.join(resourcesDir, 'manifest.yml'),
      `defaultWindowTitle: "dm2ss14"\nautoConnect: true\n`, 'utf-8');

    // The engine's content mounts resolve <solution>/RobustToolbox relative
    // to the binary (StartType.Content) — symlink the checkout there when it
    // is discoverable (SS14_ENGINE_DIR or the repo's sibling — item 66).
    const engineDir = process.env.SS14_ENGINE_DIR || path.resolve(__dirname, '../../../RobustToolbox');
    const engineLink = path.join(outputDir, 'RobustToolbox');
    if (fs.existsSync(engineDir) && !fs.existsSync(engineLink)) {
      try {
        fs.symlinkSync(engineDir, engineLink, 'dir');
      } catch {
        // Best-effort: without the link the engine resources mount fails and
        // the server cannot boot; the operator can create the link manually.
      }
    }
  }
}
