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
  <!-- Engine references go through the official Imports (direct references
       are rejected by Robust.ProjectReferences.targets): Shared.props gives
       the shared code Robust.Shared types (prototypes, tile defs, net
       serialization). Properties.targets wires the serialization source
       generator — WITHOUT it partial DataField types (DMTilePrototype) get
       no ISerializationGenerated impl and SerializationManager crashes at
       boot. -->
  <Import Project="..\\RobustToolbox\\Imports\\Shared.props" />
  <Import Project="..\\RobustToolbox\\MSBuild\\Robust.Properties.targets" />
  <Import Project="..\\RobustToolbox\\MSBuild\\Robust.EntitySystemSubscriptionsGenerator.targets" />
</Project>`;
    fs.writeFileSync(path.join(sharedDir, 'Content.Shared.csproj'), sharedCsproj, 'utf-8');
    fs.writeFileSync(path.join(sharedDir, 'DummyShared.cs'), 'namespace Content.Shared { public class Dummy { } }', 'utf-8');

    // W-C client tiles: the dmTile prototype class + tile-def registration
    // live in Content.Shared so ONE type and ONE registrar run on both sides
    // — the exact mechanism upstream SS14 uses (its shared EntryPoint calls
    // InitTileDefinitions from PostInit). Tile.TypeId is a raw int on the
    // wire, so client and server must assign identical ids; and the client's
    // ClydeTileDefinitionManager only builds its texture atlas when content
    // calls ITileDefinitionManager.Initialize() — the engine never calls it.
    const dmSharedDir = path.join(sharedDir, 'DM');
    fs.mkdirSync(dmSharedDir, { recursive: true });
    const dmTileDefsCS = `using System;
using System.Collections.Generic;
using System.Linq;
using Robust.Shared.ContentPack;
using Robust.Shared.IoC;
using Robust.Shared.Log;
using Robust.Shared.Map;
using Robust.Shared.Maths;
using Robust.Shared.Prototypes;
using Robust.Shared.Serialization.Manager.Attributes;
using Robust.Shared.Utility;

namespace Content.Shared.DM
{
    /// <summary>
    /// Converted /turf type as an engine tile definition (item 69, B-1):
    /// emitted prototypes (type: dmTile) register into ITileDefinitionManager
    /// so converted map YAML tiles resolve by name. dmPath carries the DM
    /// type path so loaded tiles mint their turf datums.
    /// Lives in Content.Shared (moved from Content.Server for W-C client
    /// tiles) so client and server materialize the same prototype type.
    /// </summary>
    [Prototype("dmTile")]
    public sealed partial class DMTilePrototype : ITileDefinition
    {
        [IdDataField]
        public string ID { get; private set; } = "";

        [DataField("dmPath")]
        public string DMPath { get; private set; } = "/turf";

        [DataField("name")]
        public string? NameField { get; private set; }

        public string Name => NameField ?? ID;

        // B-3: setters are public so the sprite validation pass can drop a
        // missing/oversized tile png and fix Variants before Register.
        [DataField("sprite")]
        public ResPath? Sprite { get; set; }

        public Dictionary<Direction, ResPath> EdgeSprites { get; } = new();

        [DataField("edgeSpritePriority")]
        public int EdgeSpritePriority { get; private set; }

        [DataField("friction")]
        public float Friction { get; private set; } = 0.2f;

        [DataField("variants")]
        public byte Variants { get; set; } = 1;

        public ushort TileId { get; private set; }

        public void AssignTileId(ushort id) => TileId = id;
    }

    /// <summary>
    /// Shared content entry point (W-C client tiles): the engine's mod loader
    /// instantiates every GameShared subclass in Content.* assemblies on BOTH
    /// client and server, and PostInit runs after prototype load — the right
    /// lifecycle point to register tile defs. On the client this also builds
    /// the tile texture atlas: ClydeTileDefinitionManager.Initialize (called
    /// via ITileDefinitionManager.Initialize below) runs _genTextureAtlas
    /// once over the registered defs; the engine itself never calls it, which
    /// is why converted floors rendered as nothing before.
    /// </summary>
    public sealed class DMTileDefsEntryPoint : GameShared
    {
        public override void PostInit()
        {
            base.PostInit();
            DMTileDefs.EnsureRegistered();
        }
    }

    /// <summary>
    /// Registers every converted dmTile prototype into ITileDefinitionManager
    /// in a deterministic order identical on client and server (W-C client
    /// tiles), then calls Initialize so the client atlas includes them.
    /// Idempotent: the shared entry point and ConvertedDMSystem.StartWorld
    /// both call it — whichever runs first does the registration.
    /// </summary>
    public static class DMTileDefs
    {
        private static bool _registered;

        public static void EnsureRegistered()
        {
            if (_registered) return;
            _registered = true;

            var protoMan = IoCManager.Resolve<IPrototypeManager>();
            var tileMan = IoCManager.Resolve<ITileDefinitionManager>();
            var resMan = IoCManager.Resolve<IResourceManager>();

            var protos = protoMan.EnumeratePrototypes<DMTilePrototype>().ToList();

            // Prototype enumeration is FrozenDictionary order — hash-based,
            // so the order differs between the server and client processes
            // (.NET string hashing is seeded per process). TileId is a raw
            // int in networked tile data, so an explicit deterministic order
            // is the only way ids match on both sides. dm_space is pinned to
            // tile id 0 — Tile.IsEmpty, the engine's "no tile" cell every
            // converted tilemap's 0: entry resolves to (the same hardcoded
            // space-first hack upstream SS14 uses).
            protos.Sort((a, b) =>
            {
                var aSpace = a.ID == "dm_space";
                var bSpace = b.ID == "dm_space";
                if (aSpace != bSpace) return aSpace ? -1 : 1;
                return string.Compare(a.ID, b.ID, StringComparison.Ordinal);
            });

            var count = 0;
            foreach (var tileProto in protos)
            {
                ValidateTileSprite(tileProto, resMan);
                tileMan.Register(tileProto);
                count++;
            }
            tileMan.Initialize();
            Logger.InfoS("dm", "Registered {0} converted tile definitions", count);
        }

        /// <summary>
        /// dmTile sprites must be a plain PNG whose height is the tile size
        /// (32px) and whose width is 32*Variants — the pin's tile atlas
        /// builder throws otherwise. Protos point at .tile32.png files
        /// written by the RSI converter (W-B tiles, item 75): identical to
        /// the first-cell crop for 32x32 sources and nearest-resampled for
        /// free-sized BYOND cells, so they satisfy the rule by construction;
        /// anything still non-conforming is dropped to a blank tile with a
        /// warning rather than crashing the client. Runs identically on
        /// client and server (pure resource-file byte reads) so the
        /// effective def set stays identical.
        /// </summary>
        private static void ValidateTileSprite(DMTilePrototype proto, IResourceManager resMan)
        {
            if (proto.Sprite is not { } sprite) return;
            try
            {
                if (!resMan.ContentFileExists(sprite))
                {
                    Logger.WarningS("dm", "tile {0}: sprite {1} missing — blank tile", proto.ID, sprite);
                    proto.Sprite = null;
                    return;
                }
                using var stream = resMan.ContentFileRead(sprite);
                var head = new byte[24];
                var read = stream.Read(head, 0, head.Length);
                if (read < head.Length || head[0] != 0x89 || head[1] != 0x50)
                {
                    proto.Sprite = null;
                    return;
                }
                var w = (head[16] << 24) | (head[17] << 16) | (head[18] << 8) | head[19];
                var h = (head[20] << 24) | (head[21] << 16) | (head[22] << 8) | head[23];
                if (h != 32 || w % 32 != 0)
                {
                    proto.Sprite = null;
                    return;
                }
                proto.Variants = (byte)Math.Min(255, Math.Max(1, w / 32));
            }
            catch (Exception ex)
            {
                Logger.WarningS("dm", "tile {0}: sprite check failed ({1}) — blank tile", proto.ID, ex.Message);
                proto.Sprite = null;
            }
        }
    }
}
`;
    fs.writeFileSync(path.join(dmSharedDir, 'DMTileDefs.cs'), dmTileDefsCS, 'utf-8');

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
    //   dmTile prototypes load on the client too (W-C client tiles):
    //     DMTilePrototype lives in Content.Shared and the shared
    //     DMTileDefsEntryPoint registers the defs + builds the Clyde atlas
    //     at PostInit, so the client's tilemap resolves converted tiles.
    const clientEntryPointCS = `using System;
using Robust.Client.Console;
using Robust.Client.Player;
using Robust.Client.State;
using Robust.Client.UserInterface.States;
using Robust.Shared.ContentPack;
using Robust.Shared.Enums;
using Robust.Shared.GameObjects;
using Robust.Shared.IoC;
using Robust.Shared.Prototypes;
using Robust.Shared.Timing;

namespace Content.Client
{
    /// <summary>
    /// Content entry point for the generated client (item 73, B-5):
    /// registers content components + net ids, ignores the server-only
    /// emitted types, and shows the engine's builtin connect screen.
    /// </summary>
    public sealed class EntryPoint : GameClient
    {
        // ==== B-6 (item 74): headless QA autocmd channel ====
        // The engine's client console never reads stdin (SystemConsoleManager
        // is server-only), so a headless --connect client can never type a
        // command. If Resources/autocmds.txt exists, each non-empty line is a
        // console command the client executes as its own session once InGame
        // — the SAME path a player typing in the debug console takes
        // (ExecuteCommand -> ServerDummyCommand -> MsgConCmd -> server
        // executes with shell.Player = this session). '{attached}'
        // substitutes the mob uid. (Environment.GetEnvironmentVariable is
        // sandbox-banned, hence a content file, not an env var.)
        private string[]? _autoCmds;
        private int _autoCmdIdx;
        private bool _autoCmdArmed;
        private TimeSpan _nextAutoCmdAt;

        public override void Init()
        {
            base.Init();
            var componentFactory = IoCManager.Resolve<IComponentFactory>();
            componentFactory.RegisterIgnore("DMRuntime");
            componentFactory.DoAutoRegistrations();
            componentFactory.GenerateNetIds();

            var res = IoCManager.Resolve<IResourceManager>();
            if (res.ContentFileExists("/autocmds.txt"))
                _autoCmds = res.ContentFileReadAllText("/autocmds.txt")
                    .Split('\\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        }

        public override void PostInit()
        {
            base.PostInit();
            // The engine's builtin connect screen: a working connect UI with
            // no content UI code (Robust debug screen, content-accessible).
            IoCManager.Resolve<IStateManager>()
                .RequestStateChange<DebugBuiltinConnectionScreenState>();
        }

        public override void Update(ModUpdateLevel level, FrameEventArgs frameEventArgs)
        {
            base.Update(level, frameEventArgs);
            if (_autoCmds == null || _autoCmdIdx >= _autoCmds.Length) return;
            var session = IoCManager.Resolve<IPlayerManager>().LocalSession;
            if (session?.Status != SessionStatus.InGame) return;
            var timing = IoCManager.Resolve<IGameTiming>();
            if (!_autoCmdArmed)
            {
                // Give the server-side player-attach (B-1) a beat to spawn
                // and bind the mob before the first dm* command lands.
                _autoCmdArmed = true;
                _nextAutoCmdAt = timing.RealTime + TimeSpan.FromSeconds(2);
                return;
            }
            if (timing.RealTime < _nextAutoCmdAt) return;
            _nextAutoCmdAt = timing.RealTime + TimeSpan.FromSeconds(1);
            var cmd = _autoCmds[_autoCmdIdx++]
                .Replace("{attached}", session.AttachedEntity?.ToString() ?? "0");
            IoCManager.Resolve<IClientConsoleHost>().ExecuteCommand(null, cmd);
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

    // Keybinds (item 74): without a content-side Resources/keybinds.yml,
    // ShowDebugConsole has no default bind and the engine debug console can
    // never open in a windowed client. KeyBindingType at this pin is
    // State|Toggle|Command only — a Press bind crashes the client at boot.
    fs.writeFileSync(path.join(resourcesDir, 'keybinds.yml'),
      `binds:\n- function: ShowDebugConsole\n  key: Tilde\n  type: State\n`, 'utf-8');

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
