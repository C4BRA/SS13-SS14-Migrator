import * as fs from 'fs';
import * as path from 'path';
import { DMRuntimeCS } from '../runtimeTemplate/dmRuntimeCS.js';

export class SS14Template {
  public generateSS14Solution(outputDir: string): void {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // 1. Solution File Content.sln
    const projects = [
      { name: 'Robust.Shared', file: 'Robust.Shared\\Robust.Shared.csproj', guid: '{00000000-0000-0000-0000-000000000001}' },
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

    // 2. Robust.Shared Shim Project (no NuGet packages exist for Robust, so the
    //    solution is fully self-contained; generated code uses a minimal subset)
    const robustDir = path.join(outputDir, 'Robust.Shared');
    fs.mkdirSync(robustDir, { recursive: true });

    const robustCsproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>`;
    fs.writeFileSync(path.join(robustDir, 'Robust.Shared.csproj'), robustCsproj, 'utf-8');

    const robustShim = `using System;

namespace Robust.Shared.GameObjects
{
    public readonly struct EntityUid : IEquatable<EntityUid>
    {
        public static readonly EntityUid Invalid = new EntityUid(0);

        public readonly int Id;

        public EntityUid(int id) { Id = id; }

        public bool Equals(EntityUid other) => Id == other.Id;
        public override bool Equals(object? obj) => obj is EntityUid other && Equals(other);
        public override int GetHashCode() => Id;
        public static bool operator ==(EntityUid a, EntityUid b) => a.Equals(b);
        public static bool operator !=(EntityUid a, EntityUid b) => !a.Equals(b);
        public override string ToString() => $"ent {Id}";
    }

    public class Component
    {
        public EntityUid Owner { get; set; }
        public bool Initialized { get; set; }
        public bool Running { get; set; }
        public bool Deleted { get; set; }
    }

    public sealed class ComponentInit { }

    [AttributeUsage(AttributeTargets.Class)]
    public sealed class RegisterComponent : Attribute { }

    public abstract class EntitySystem
    {
        public virtual void Initialize() { }

        protected void SubscribeLocalEvent<TComp, TEvent>(Action<EntityUid, TComp, TEvent> handler)
            where TComp : Component
        {
            // Engine integration point: event bus registration.
        }
    }

    public sealed class EntityManager
    {
        public static EntityManager Instance { get; } = new EntityManager();
        private EntityManager() { }

        public EntityUid SpawnEntity(string prototype, EntityUid? parent = null) => EntityUid.Invalid;
    }
}
`;
    fs.writeFileSync(path.join(robustDir, 'RobustShim.cs'), robustShim.trim(), 'utf-8');

    // 3. SS13.DM.Runtime Project
    const runtimeDir = path.join(outputDir, 'SS13.DM.Runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });

    const runtimeCsproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\\Robust.Shared\\Robust.Shared.csproj" />
  </ItemGroup>
</Project>`;
    fs.writeFileSync(path.join(runtimeDir, 'SS13.DM.Runtime.csproj'), runtimeCsproj, 'utf-8');

    for (const file of DMRuntimeCS.getRuntimeCSFiles()) {
      fs.writeFileSync(path.join(runtimeDir, file.filename), file.content, 'utf-8');
    }

    // 4. Content.Shared Project
    const sharedDir = path.join(outputDir, 'Content.Shared');
    fs.mkdirSync(sharedDir, { recursive: true });

    const sharedCsproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\\SS13.DM.Runtime\\SS13.DM.Runtime.csproj" />
  </ItemGroup>
</Project>`;
    fs.writeFileSync(path.join(sharedDir, 'Content.Shared.csproj'), sharedCsproj, 'utf-8');
    fs.writeFileSync(path.join(sharedDir, 'DummyShared.cs'), 'namespace Content.Shared { public class Dummy { } }', 'utf-8');

    // 5. Content.Server Project
    const serverDir = path.join(outputDir, 'Content.Server');
    fs.mkdirSync(serverDir, { recursive: true });

    const serverCsproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\\SS13.DM.Runtime\\SS13.DM.Runtime.csproj" />
    <ProjectReference Include="..\\Content.Shared\\Content.Shared.csproj" />
    <ProjectReference Include="..\\Robust.Shared\\Robust.Shared.csproj" />
  </ItemGroup>
</Project>`;
    fs.writeFileSync(path.join(serverDir, 'Content.Server.csproj'), serverCsproj, 'utf-8');

    const programCS = `using System;

namespace Content.Server
{
    public class Program
    {
        public static void Main(string[] args)
        {
            Console.WriteLine("SS14 Server Converted from SS13 DM initializing...");
            Console.WriteLine("Server ready.");
        }
    }
}`;
    fs.writeFileSync(path.join(serverDir, 'Program.cs'), programCS, 'utf-8');

    // 6. Content.Client Project
    const clientDir = path.join(outputDir, 'Content.Client');
    fs.mkdirSync(clientDir, { recursive: true });

    const clientCsproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
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

    // 7. Config files
    fs.writeFileSync(path.join(outputDir, 'server_config.toml'), `[net]\nport = 1212\n[engine]\ntick_rate = 60\n`, 'utf-8');
  }
}
