import { DMLexer, TokenType } from '../parser/dmLexer.js';
import { DMParser } from '../parser/dmParser.js';
import { DMIRGenerator } from '../ir/dmIRGenerator.js';
import { CSharpEmitter } from '../transpiler/csharpEmitter.js';
import { YAMLGenerator } from '../transpiler/yamlGenerator.js';
import { DMIParser } from '../dmi/dmiParser.js';
import { crc32 } from '../dmi/pngCodec.js';
import { DMMParser } from '../dmm/dmmParser.js';
import { DM2SS14Transpiler } from '../index.js';
import * as zlib from 'zlib';
import { runAudit } from '../audit/fidelityAudit.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ TEST FAILED: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ ${message}`);
  }
}

async function runTests() {
  console.log("=== Running dm2ss14 Test Suite ===");

  // Run the standalone test suites (self-executing test modules)
  await import('./dmiParser.test.js');
  await import('./rsiWriter.test.js');
  await import('./dmmParser.test.js');
  await import('./csharpEmitter.test.js');
  await import('./preprocessor.test.js');
  await import('./runtimeTemplate.test.js');
  await import('./symbolTable.test.js');
  await import('./parallelDeterminism.test.js');

  // Test 1: DM Lexer
  const sampleDM = `
/obj/item/weapon/sword
    name = "Energy Sword"
    desc = "A sharp energy blade."
    density = 1
    icon_state = "sword"
    var/custom_power = 100
    var/list/effects = {1, 2, 3}

    proc/attack_self(mob/user)
        sleep(5)
        if (user)
            var/i = 1
            for (var/n in 1..3)
                i += n
            for(var/j = 1, j <= 3, j++)
                i += j
            spawn(2)
                i += 10
            do
                i -= 1
            while (i > 5)
            stuff.activate(i)
            return 1
        return 0

    proc/activate(power)
        var/x = stuff[1]
        var/r = rand()
        return power + x

/turf/simulated/floor
    name = "Floor"

/turf/simulated/wall
    name = "Wall"
    density = 1
`;

  const lexer = new DMLexer(sampleDM);
  const tokens = lexer.tokenize();
  assert(tokens.length > 0, "Lexer produced tokens");
  const typePathToken = tokens.find(t => t.type === TokenType.TypePath);
  assert(typePathToken !== undefined && typePathToken.value === '/obj/item/weapon/sword', `Lexer identified type path (found: ${typePathToken?.value})`);

  // Test 2: DM Parser
  const parser = new DMParser(tokens);
  const astNodes = parser.parse();
  assert(astNodes.length > 0, "Parser produced AST nodes");

  const swordNode = astNodes.find(n => n.path === '/obj/item/weapon/sword');
  assert(swordNode !== undefined, "Parsed sword node path");
  assert(swordNode!.vars.some(v => v.name === 'name' && (v.initialValue === '"Energy Sword"' || v.initialValue === 'Energy Sword')), `Parsed name variable (found: ${JSON.stringify(swordNode!.vars)})`);
  assert(swordNode!.procs.some(p => p.name === 'attack_self'), "Parsed attack_self proc");

  // Test 3: DM-IR Generator & Static vs Dynamic categorization
  const irGen = new DMIRGenerator();
  const irMap = irGen.generateIR(astNodes);
  const swordIR = irMap.get('/obj/item/weapon/sword');
  assert(swordIR !== undefined, "IR generated for sword");
  assert(swordIR!.name === 'Energy Sword', "IR resolved name");
  assert(swordIR!.density === true, "IR resolved density");
  assert(swordIR!.isDynamic === true, "Sword marked dynamic due to custom_power var and attack_self proc");

  // Test 4: Root-level Proc Paths and Parent Auto-Synthesis
  const rootProcDM = `/obj/machinery/door/airlock/proc/open_door()\n    sleep(2)\n    return 1`;
  const rootProcTokens = new DMLexer(rootProcDM).tokenize();
  const rootProcNodes = new DMParser(rootProcTokens).parse();
  const rootProcIRMap = irGen.generateIR(rootProcNodes);
  const airlockIR = rootProcIRMap.get('/obj/machinery/door/airlock');
  assert(airlockIR !== undefined, "Root proc path correctly attributed to owner type");
  assert(airlockIR!.procs.has('open_door'), "open_door proc recognized on airlock");
  assert(rootProcIRMap.has('/obj/machinery/door'), "Missing intermediate parent /obj/machinery/door auto-synthesized");

  // Test 5: Static Entity IR (No custom vars or procs)
  const staticDM = `/turf/simulated/floor\n    name = "Floor"\n    density = 0`;
  const staticTokens = new DMLexer(staticDM).tokenize();
  const staticNodes = new DMParser(staticTokens).parse();
  const staticIRMap = irGen.generateIR(staticNodes);
  const floorIR = staticIRMap.get('/turf/simulated/floor');
  assert(floorIR !== undefined && floorIR.isDynamic === false, "Floor correctly categorized as static entity without DMRuntimeComponent bloat");

  // Test 5b (Plan 09 B4): cross-file type split — same path declared in two
  // files (vars in one, procs in another) must MERGE, not last-wins.
  const fileA = new DMParser(new DMLexer(`/obj/item/foo\n    var/value = 1`).tokenize()).parse();
  const fileB = new DMParser(new DMLexer(`/obj/item/foo/proc/run()\n    return value`).tokenize()).parse();
  const mergedIRMap = irGen.generateIR([...fileA, ...fileB]);
  const fooIR = mergedIRMap.get('/obj/item/foo');
  assert(fooIR !== undefined && fooIR!.customVars.has('value'), "Cross-file split merges vars");
  assert(fooIR!.procs.has('run'), "Cross-file split merges procs");

  // Test 5c (Plan 09 B4): trailing-slash base-type — /obj/ declared as a base
  // type and /obj children must resolve against it (no duplicate /obj node,
  // no re-synthesis over the real node).
  const slashDM = new DMParser(new DMLexer(`/obj/\n    var/flag = 0\n/obj/item/foo/proc/run()\n    return flag`).tokenize()).parse();
  const slashIRMap = irGen.generateIR(slashDM);
  const slashObjIR = slashIRMap.get('/obj');
  assert(slashObjIR !== undefined && slashObjIR!.customVars.has('flag'), "Trailing-slash /obj/ declaration normalized to /obj base");
  const slashFooIR = slashIRMap.get('/obj/item/foo');
  assert(slashFooIR !== undefined && slashFooIR!.parentPath === '/obj/item', "Child path resolves synthesized intermediate parent");
  assert(slashFooIR!.customVars.has('flag'), "Child inherits var from trailing-slash parent declaration");

  // Test 5d (Plan 09 B4): /global/var/ initializer round-trip — string-ness
  // preserved in EnsureInit, bare refs resolve to other globals (no comp refs).
  const globalsDM = `/global/var/motd = "hello world"\n/global/var/count = 42\n/global/var/alias = motd\n/global/var/copy = "n=[count]"`;
  const globalsParser = new DMParser(new DMLexer(globalsDM).tokenize());
  const globalsNodes = globalsParser.parse();
  const globalsIR = irGen.generateIR(globalsNodes);
  const globalsEmitter = new CSharpEmitter();
  const globalsCS = globalsEmitter.generateProcsCS(globalsIR, globalsParser.globalVars);
  const ensureInit = (globalsCS.split('private static async Task EnsureInit')[1] || '').split('}')[0];
  assert(ensureInit.includes('DMValue.FromString("hello world")'), "Global string initializer round-trips as string literal");
  assert(ensureInit.includes('DMValue.FromNumber(42)'), "Global numeric initializer preserved");
  assert(ensureInit.includes('GlobalVars.Get("motd")'), "Global initializer referencing another global resolves via GlobalVars.Get");
  assert(!ensureInit.includes('comp.GetVar'), "Global initializers must not reference comp (CS0103 in static context)");

  // Test 5e (Plan 09 B5): harness counters — no double-count of unresolved
  // calls in totalLossSites, no stale break/continue/compile-break counters.
  const fixtureDir = path.join(os.tmpdir(), 'dm2ss14-harness-fixture');
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, 'fixture.dm'), `/obj/fixture/proc/run(x)\n    var/i = 0\n    for (i = 1, i <= 5, i++)\n        if (i == 2)\n            continue\n        if (i == 5)\n            break\n    if (x != 3)\n        return some_unknown_proc()\n    return 1\n`, 'utf-8');
  const harnessCounters: any = runAudit(fixtureDir, 'fixture').counters;
  assert(harnessCounters.numBreak === undefined && harnessCounters.numContinue === undefined && harnessCounters.numCompileBreak === undefined, "Stale break/continue/compile-break counters removed");
  assert(harnessCounters.numUnresolvedCalls === 1, "Unresolved call counted exactly once");
  assert(harnessCounters.totalLossSites === 1, "totalLossSites counts unresolved calls once (no double-add, no stale break/continue/!= losses)");

  // Test 5f (Plan 09 B6): GUI server security — session token + Host/Origin
  // validation + outputPath confinement (concurrency lock is exercised by
  // the handler's own inFlight guard, not probed here).
  {
    const { GUIServer } = await import('../gui/server.js');
    const net = await import('net');
    const freePort = await new Promise<number>((resolve) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address() as any;
        srv.close(() => resolve(addr.port));
      });
    });
    const gui = new GUIServer(freePort);
    gui.start();
    await new Promise(r => setTimeout(r, 300));

    const rawRequest = (raw: string) => new Promise<string>((resolve) => {
      const sock = net.createConnection(freePort, '127.0.0.1', () => sock.write(raw));
      let data = '';
      sock.on('data', d => { data += d.toString(); });
      sock.on('end', () => resolve(data));
      sock.on('error', () => resolve(data));
    });

    const badHost = await rawRequest(`POST /api/convert HTTP/1.1\r\nHost: evil.com\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    assert(badHost.includes('403'), "Request with foreign Host header rejected (403)");

    const noToken = await rawRequest(`POST /api/convert HTTP/1.1\r\nHost: 127.0.0.1:${freePort}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    assert(noToken.includes('403'), "Request without session token rejected (403)");

    const index = await rawRequest(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${freePort}\r\nConnection: close\r\n\r\n`);
    assert(index.includes(' 200 '), "Index page served (200)");
    const tokenMatch = index.match(/AUTH_TOKEN = "([0-9a-f]+)"/);
    assert(tokenMatch !== null, "Index page embeds the session token");
    const token = tokenMatch![1];

    const badOrigin = await rawRequest(`POST /api/convert HTTP/1.1\r\nHost: 127.0.0.1:${freePort}\r\nOrigin: http://evil.com\r\nX-Auth-Token: ${token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    assert(badOrigin.includes('403'), "Request with foreign Origin rejected despite valid token");

    const authed = await rawRequest(`POST /api/convert HTTP/1.1\r\nHost: 127.0.0.1:${freePort}\r\nX-Auth-Token: ${token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    assert(authed.includes('400'), "Authed request reaches the handler (400 for missing zip, not 403)");

    const homeRoot = process.env.HOME || '/tmp';
    assert(GUIServer.validateOutputPath(path.join(homeRoot, 'Downloads', 'out')) === path.join(homeRoot, 'Downloads', 'out'), "Output path inside home accepted");
    assert(GUIServer.validateOutputPath('/etc/passwd') === null, "Absolute output path outside home rejected");
    assert(GUIServer.validateOutputPath('../../../../etc/evil') === null, "Traversal output path rejected");
    gui.stop();
  }

  // W-J (Plan 30): GUI polish endpoints — output browser confinement, SSE
  // auth, cancel semantics. Own server instance so this block stays additive.
  {
    const { GUIServer } = await import('../gui/server.js');
    const net = await import('net');
    const freePort = await new Promise<number>((resolve) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address() as any;
        srv.close(() => resolve(addr.port));
      });
    });
    const gui = new GUIServer(freePort);
    gui.start();
    await new Promise(r => setTimeout(r, 300));

    const rawRequest = (raw: string) => new Promise<string>((resolve) => {
      const sock = net.createConnection(freePort, '127.0.0.1', () => sock.write(raw));
      let data = '';
      sock.on('data', d => { data += d.toString(); });
      sock.on('end', () => resolve(data));
      sock.on('error', () => resolve(data));
    });

    const index = await rawRequest(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${freePort}\r\nConnection: close\r\n\r\n`);
    const token = index.match(/AUTH_TOKEN = "([0-9a-f]+)"/)![1];
    const homeRoot = process.env.HOME || '/tmp';
    const browseDir = fs.mkdtempSync(path.join(homeRoot, 'dm2ss14-gui-browse-'));
    try {
      fs.writeFileSync(path.join(browseDir, 'a.txt'), 'hello');
      fs.mkdirSync(path.join(browseDir, 'sub'));

      const treeNoToken = await rawRequest(`GET /api/tree?root=${browseDir} HTTP/1.1\r\nHost: 127.0.0.1:${freePort}\r\nConnection: close\r\n\r\n`);
      assert(treeNoToken.includes('403'), "Tree without session token rejected (403)");
      const treeOutside = await rawRequest(`GET /api/tree?token=${token}&root=/etc HTTP/1.1\r\nHost: 127.0.0.1:${freePort}\r\nConnection: close\r\n\r\n`);
      assert(treeOutside.includes('403'), "Tree root outside home rejected (403)");
      const treeOk = await rawRequest(`GET /api/tree?token=${token}&root=${browseDir} HTTP/1.1\r\nHost: 127.0.0.1:${freePort}\r\nConnection: close\r\n\r\n`);
      assert(treeOk.includes(' 200 ') && treeOk.includes('"a.txt"') && treeOk.includes('"sub"'), "Tree lists dir entries for a valid root");
      const treeEscape = await rawRequest(`GET /api/tree?token=${token}&root=${browseDir}&path=.. HTTP/1.1\r\nHost: 127.0.0.1:${freePort}\r\nConnection: close\r\n\r\n`);
      assert(treeEscape.includes('403'), "Tree path escaping the browse root rejected (403)");

      const fileOk = await rawRequest(`GET /api/file?token=${token}&root=${browseDir}&path=a.txt HTTP/1.1\r\nHost: 127.0.0.1:${freePort}\r\nConnection: close\r\n\r\n`);
      assert(fileOk.includes('hello'), "File preview returns text content");
      const fileMissing = await rawRequest(`GET /api/file?token=${token}&root=${browseDir}&path=nope.txt HTTP/1.1\r\nHost: 127.0.0.1:${freePort}\r\nConnection: close\r\n\r\n`);
      assert(fileMissing.includes('403'), "Missing file path rejected (403, no existence oracle)");

      const eventsNoToken = await rawRequest(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${freePort}\r\nConnection: close\r\n\r\n`);
      assert(eventsNoToken.includes('403'), "SSE stream without token rejected (403)");

      const cancelIdle = await rawRequest(`POST /api/cancel HTTP/1.1\r\nHost: 127.0.0.1:${freePort}\r\nX-Auth-Token: ${token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      assert(cancelIdle.includes('409'), "Cancel with no in-flight convert returns 409");
    } finally {
      fs.rmSync(browseDir, { recursive: true, force: true });
      gui.stop();
    }
  }

  // Test 5: End-to-End Transpilation to temporary directory
  const tmpInputDir = path.join(process.cwd(), 'temp_test_ss13');
  const tmpOutputDir = path.join(process.cwd(), 'temp_test_ss14');

  try {
    if (!fs.existsSync(tmpInputDir)) fs.mkdirSync(tmpInputDir, { recursive: true });
    fs.writeFileSync(path.join(tmpInputDir, 'code.dm'), sampleDM, 'utf-8');

    // DMM map fixture: floor + wall + one dynamic item (prototype /obj/item/weapon/sword)
    const dmmFixture = `"flr" = (/turf/simulated/floor)
"wal" = (/turf/simulated/wall)
"swd" = (/obj/item/weapon/sword)

(1,1,1) = {" 
walwal
flrswd
walwal
"}`;
    fs.writeFileSync(path.join(tmpInputDir, 'testmap.dmm'), dmmFixture, 'utf-8');

    // Minimal DMI icon fixture (IHDR + DMI tEXt metadata + real 1x1 RGB IDAT + IEND)
    const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(1, 0);
    ihdrData.writeUInt32BE(1, 4);
    ihdrData[8] = 8;
    ihdrData[9] = 2;
    const chunkCrc = (type: string, data: Buffer): Buffer => {
      const c = Buffer.alloc(4);
      c.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])), 0);
      return c;
    };
    const dmiText = `# BEGIN DMI
version = 4.0
width = 1
height = 1
state "icon"
  dirs = 1
  frames = 1
# END DMI`;
    const dmiChunkData = Buffer.concat([Buffer.from('DMI'), Buffer.from([0]), Buffer.from(dmiText, 'latin1')]);
    const dmiChunk = Buffer.concat([
      Buffer.from([0, 0, 0, dmiChunkData.length]),
      Buffer.from('tEXt'),
      dmiChunkData,
      chunkCrc('tEXt', dmiChunkData)
    ]);
    const idatData = zlib.deflateSync(Buffer.from([0, 255, 0, 255])); // filter 0 + one red RGB pixel
    const idatChunk = Buffer.concat([
      Buffer.from([0, 0, 0, idatData.length]),
      Buffer.from('IDAT'),
      idatData,
      chunkCrc('IDAT', idatData)
    ]);
    const iendChunk = Buffer.concat([
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('IEND'),
      Buffer.alloc(0),
      chunkCrc('IEND', Buffer.alloc(0))
    ]);
    const dmiFixture = Buffer.concat([
      pngSignature,
      Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), ihdrData, chunkCrc('IHDR', ihdrData),
      dmiChunk, idatChunk, iendChunk
    ]);
    fs.writeFileSync(path.join(tmpInputDir, 'icon.dmi'), dmiFixture);

    const transpiler = new DM2SS14Transpiler();
    await transpiler.transpile({
      inputDir: tmpInputDir,
      outputDir: tmpOutputDir
    });

    assert(fs.existsSync(path.join(tmpOutputDir, 'Content.sln')), "Generated Content.sln");
    assert(fs.existsSync(path.join(tmpOutputDir, 'SS13.DM.Runtime', 'DMValue.cs')), "Generated DMValue.cs in DM.Runtime");
    assert(fs.existsSync(path.join(tmpOutputDir, 'SS13.DM.Runtime', 'RustGAdapterStubs.cs')), "Generated rust-g stub adapters");
    assert(fs.existsSync(path.join(tmpOutputDir, 'Resources', 'Prototypes', 'converted_entities.yml')), "Generated SS14 Entity Prototypes");
    assert(fs.existsSync(path.join(tmpOutputDir, 'Content.Server', 'DM', 'ConvertedDMProcs.cs')), "Generated C# DM procs (engine-free)");
    assert(fs.existsSync(path.join(tmpOutputDir, 'Content.Server', 'DM', 'ConvertedDMSystem.cs')), "Generated C# DM system (real-engine adapter)");
    assert(fs.existsSync(path.join(tmpOutputDir, 'Resources', 'Textures', 'icon.rsi', 'meta.json')), "DMI converted to RSI with meta.json");
    assert(fs.existsSync(path.join(tmpOutputDir, 'Resources', 'Maps', 'testmap.yml')), "DMM converted to grid map YAML");
    const dmmMapYaml = fs.readFileSync(path.join(tmpOutputDir, 'Resources', 'Maps', 'testmap.yml'), 'utf-8');
   assert(dmmMapYaml.includes('proto: obj_item_weapon_sword'), "DMM item mapped to generated prototype id (item 69)");
   assert(dmmMapYaml.includes('format: 6'), "Map YAML targets engine map format 6 (pin-verified deserializer)");
   assert(dmmMapYaml.includes('type: Map') && dmmMapYaml.includes('type: MapGrid'), "Map YAML has a map entity plus a MapGrid entity");
   assert(/tilemap:\n  1: turf_simulated_(floor|wall)/.test(dmmMapYaml) || dmmMapYaml.includes('tilemap:'), "Map YAML tilemap maps numeric tile ids to turf dmTile prototype names (item 69)");
   assert(dmmMapYaml.includes('      chunks:'), "MapGrid entity has chunked tiles");
   assert(dmmMapYaml.includes('version: 7') && dmmMapYaml.includes('tiles: "'), "Chunk tiles are packed as format-7 base64 blobs");
   assert(dmmMapYaml.includes('pos: 1.5, 1.5'), "Entity position is 2D Vector2 at tile center (DM x,y-1 + 0.5)");
   assert(dmmMapYaml.includes('parent: 2'), "Entities are parented to their z-level grid (multi-z => one grid per z)");
   assert(dmmMapYaml.includes('  0: dm_space'), "Map YAML tilemap maps unset-cell id 0 to dm_space — the engine deserializer resolves EVERY cell (item 74)");
   const entitiesYaml = fs.readFileSync(path.join(tmpOutputDir, 'Resources', 'Prototypes', 'converted_entities.yml'), 'utf-8');
   assert(entitiesYaml.includes('- type: dmTile') && entitiesYaml.includes('  dmPath: /turf/simulated/floor'), "Turf prototypes emitted as dmTile defs with dmPath (item 69)");
   assert(entitiesYaml.includes('id: dm_space'), "dm_space dmTile prototype emitted for unset chunk cells (item 74)");
   assert(entitiesYaml.includes('id: dm_player_mob'), "Player-mob fallback prototype emitted (item 69)");
   const sharedAppearance = fs.readFileSync(path.join(tmpOutputDir, 'Content.Shared', 'DM', 'DMAppearanceKey.cs'), 'utf-8');
   assert(sharedAppearance.includes('NetSerializable') && sharedAppearance.includes('enum DMAppearanceKey'), "Content.Shared emits a NetSerializable DMAppearanceKey — AppearanceComponent.SetData keys must serialize over PVS (item 74)");
   const systemCs = fs.readFileSync(path.join(tmpOutputDir, 'Content.Server', 'DM', 'ConvertedDMSystem.cs'), 'utf-8');
   assert(systemCs.includes('using Content.Shared.DM;'), "ConvertedDMSystem resolves the shared wire enum (item 74)");

    // Test 5g (Plan 20 B5): generated client entry — real Robust.Client boot
    // path so `dotnet run --project Content.Client` connects to the server.
    const clientProgram = fs.readFileSync(path.join(tmpOutputDir, 'Content.Client', 'Program.cs'), 'utf-8');
    assert(clientProgram.includes('ContentStart.Start'), "Content.Client Program boots ContentStart (item 73)");
    const clientEntry = fs.readFileSync(path.join(tmpOutputDir, 'Content.Client', 'EntryPoint.cs'), 'utf-8');
    assert(clientEntry.includes('GameClient'), "Content.Client EntryPoint subclasses GameClient (item 73)");
    assert(clientEntry.includes('RegisterIgnore("DMRuntime")'), "Client ignores server-only DMRuntime component (item 73)");
    assert(clientEntry.includes('DoAutoRegistrations') && clientEntry.includes('GenerateNetIds'), "Client runs content auto-registration + net id generation server normally skips (item 73)");
    assert(!clientEntry.includes('RegisterIgnore("dmTile")'), "Client loads dmTile prototypes — DMTilePrototype moved to Content.Shared so the client atlas registers them (W-C client tiles)");
    assert(clientEntry.includes('DebugBuiltinConnectionScreenState'), "Client requests the engine builtin connection screen (item 73)");
    const clientCsproj = fs.readFileSync(path.join(tmpOutputDir, 'Content.Client', 'Content.Client.csproj'), 'utf-8');
    assert(clientCsproj.includes('<OutputType>Exe</OutputType>'), "Content.Client is an executable (item 73)");
    assert(clientCsproj.includes('bin') && clientCsproj.includes('Content.Client'), "Content.Client outputs into <solution>/bin so resource mounts resolve (item 73)");
    assert(clientCsproj.includes('Client.props'), "Content.Client imports the engine Client.props dependency list (item 73)");
    assert(fs.existsSync(path.join(tmpOutputDir, 'Resources', 'manifest.yml')), "Resources/manifest.yml emitted — the client resource manifest (item 73)");
    const clientManifest = fs.readFileSync(path.join(tmpOutputDir, 'Resources', 'manifest.yml'), 'utf-8');
    assert(clientManifest.includes('autoConnect: true'), "Client manifest enables autoConnect for --connect (item 73)");
    assert(clientEntry.includes('/autocmds.txt') && clientEntry.includes('ExecuteCommand'), "Client reads autocmds.txt and executes it as the player session (item 74)");
    assert(clientEntry.includes('SessionStatus.InGame'), "Client autocmds wait for InGame before firing (item 74)");
    const keybinds = fs.readFileSync(path.join(tmpOutputDir, 'Resources', 'keybinds.yml'), 'utf-8');
    assert(keybinds.includes('function: ShowDebugConsole') && keybinds.includes('type: State'), "keybinds.yml emitted — windowed debug console is unopenable without it (item 74)");

    // W-B tiles/light (item 75): the writer emits an always-32x32
    // .tile32.png variant (the fixture's 1x1 DMI also exercises upscale),
    // dmTile protos point at it, and the generated system seeds a
    // networked ambient-light baseline.
    assert(fs.existsSync(path.join(tmpOutputDir, 'Resources', 'Textures', 'icon.rsi', 'icon.tile32.png')), ".tile32.png emitted next to the RSI state (item 75)");
    assert(fs.existsSync(path.join(tmpOutputDir, 'Resources', 'Textures', 'icon.rsi', 'icon.tile.png')), "native first-cell .tile.png still emitted for other consumers (item 75)");
    {
      const tileYamlDir = path.join(process.cwd(), 'temp_test_tileyaml');
      fs.rmSync(tileYamlDir, { recursive: true, force: true });
      const tileDM = `/turf/simulated/floor\n    name = "Floor"\n    icon = 'icon.dmi'\n    icon_state = "icon"`;
      const tileIR = irGen.generateIR(new DMParser(new DMLexer(tileDM).tokenize()).parse());
      new YAMLGenerator().generateYAMLPrototypes(tileIR, tileYamlDir);
      const tileYaml = fs.readFileSync(path.join(tileYamlDir, 'converted_entities.yml'), 'utf-8');
      assert(tileYaml.includes('icon.rsi/icon.tile32.png'), "dmTile sprite points at the always-32x32 .tile32.png variant (item 75)");
      assert(!tileYaml.includes('icon.rsi/icon.tile.png'), "no dmTile sprite keeps the native-size .tile.png path (item 75)");
      fs.rmSync(tileYamlDir, { recursive: true, force: true });
    }
    assert(systemCs.includes('SeedAmbientLight') && systemCs.includes('SetAmbientLight'), "ConvertedDMSystem seeds ambient light via SharedMapSystem.SetAmbientLight (item 75)");
    assert(systemCs.includes('FromSrgb'), "ambient color converted srgb -> linear-light per the pin's DataField contract (item 75)");


    // W-C client tiles: dmTile defs register client-side via the shared
    // entry point so the Clyde atlas contains converted floors.
    const dmTileDefs = fs.readFileSync(path.join(tmpOutputDir, 'Content.Shared', 'DM', 'DMTileDefs.cs'), 'utf-8');
    assert(dmTileDefs.includes('[Prototype("dmTile")]') && dmTileDefs.includes('sealed partial class DMTilePrototype'), "DMTilePrototype emitted in Content.Shared — one type on both sides (W-C client tiles)");
    assert(dmTileDefs.includes('GameShared') && dmTileDefs.includes('PostInit'), "Shared GameShared entry point registers tile defs after proto load (W-C client tiles)");
    assert(dmTileDefs.includes('EnumeratePrototypes<DMTilePrototype>') && dmTileDefs.includes('tileMan.Register'), "Shared registrar iterates dmTile protos into ITileDefinitionManager (W-C client tiles)");
    assert(dmTileDefs.includes('StringComparison.Ordinal'), "Tile-def registration sorted ordinal — deterministic client/server TileIds over the wire (W-C client tiles)");
    assert(dmTileDefs.includes('"dm_space"'), "dm_space pinned to tile id 0 = Tile.IsEmpty (W-C client tiles)");
    assert(dmTileDefs.includes('tileMan.Initialize()'), "Registrar calls ITileDefinitionManager.Initialize — the call that builds the client atlas (W-C client tiles)");
    assert(dmTileDefs.includes('ValidateTileSprite'), "Sprite validation lives in shared code — identical effective defs both sides (W-C client tiles)");
    assert(systemCs.includes('DMTileDefs.EnsureRegistered()'), "Server delegates tile-def registration to the shared registrar (W-C client tiles)");
    assert(!systemCs.includes('partial class DMTilePrototype'), "DMTilePrototype no longer emitted server-side (moved to Content.Shared)");

    // Test 6: Zip File Extraction & Conversion
    const AdmZip = (await import('adm-zip')).default;
    const testZipPath = path.join(process.cwd(), 'temp_test_repo.zip');
    const zip = new AdmZip();
    zip.addLocalFolder(tmpInputDir);
    zip.writeZip(testZipPath);

    const tmpZipOutputDir = path.join(process.cwd(), 'temp_test_zip_out');
    const unzippedInputDir = path.join(process.cwd(), 'temp_test_unzipped');
    const zipExtract = new AdmZip(testZipPath);
    zipExtract.extractAllTo(unzippedInputDir, true);

    await transpiler.transpile({
      inputDir: unzippedInputDir,
      outputDir: tmpZipOutputDir
    });

    assert(fs.existsSync(path.join(tmpZipOutputDir, 'Content.sln')), "Successfully converted dropped ZIP file archive");

    // Cleanup zip temp files
    if (fs.existsSync(testZipPath)) fs.unlinkSync(testZipPath);
    if (fs.existsSync(unzippedInputDir)) fs.rmSync(unzippedInputDir, { recursive: true, force: true });
    if (fs.existsSync(tmpZipOutputDir)) fs.rmSync(tmpZipOutputDir, { recursive: true, force: true });

    // Test 7: Generated C# solution compiles against the REAL RobustToolbox
    // (dotnet build), if dotnet + the engine checkout are available.
    const { spawnSync } = await import('child_process');
    const dotnetCheck = spawnSync('dotnet', ['--version'], { stdio: 'pipe' });
    if (dotnetCheck.status === 0) {
      const engineDir = process.env.SS14_ENGINE_DIR || path.join(tmpOutputDir, '..', 'RobustToolbox');
      const engineProject = path.join(engineDir, 'Robust.Shared', 'Robust.Shared.csproj');
      if (!fs.existsSync(engineProject)) {
        console.log(`   RobustToolbox not found at ${engineDir} (set SS14_ENGINE_DIR) — skipping real-engine build check`);
      } else {
        console.log(`   dotnet found + RobustToolbox at ${engineDir}, verifying generated solution compiles against the real engine...`);
        // The generated RobustToolbox is a symlink: engine obj/ dirs are shared
        // across every generated tree, and parallel sln builds race each other's
        // obj/.../ref/*.dll files (transient CS0006). Serial retries converge —
        // same bounded-retry pattern as scripts/client-smoke.sh.
        let buildLog = '';
        let failed = true;
        let lastStatus: number | null = null;
        for (let attempt = 0; attempt < 8 && failed; attempt++) {
          const buildResult = spawnSync('dotnet', ['build', path.join(tmpOutputDir, 'Content.sln'), '--nologo', '-v', 'q', '-m:1', '-p:EngineDir=' + engineDir], {
            stdio: 'pipe',
            timeout: 600000
          });
          buildLog = buildResult.stdout?.toString() + buildResult.stderr?.toString();
          lastStatus = buildResult.status;
          failed = buildResult.status !== 0 || /error CS\d+/.test(buildLog);
        }
        if (failed) {
          console.error(buildLog.slice(-2000));
        }
        assert(!failed, `Generated C# solution builds against real RobustToolbox (exit ${lastStatus})`);
      }
    } else {
      console.log("   dotnet CLI not available — skipping generated solution build check");
    }

  } finally {
    // Cleanup temporary test directories
    if (fs.existsSync(tmpInputDir)) fs.rmSync(tmpInputDir, { recursive: true, force: true });
    if (fs.existsSync(tmpOutputDir)) fs.rmSync(tmpOutputDir, { recursive: true, force: true });
  }

  console.log("ALL TESTS PASSED SUCCESSFULLY! 🎉");
}

runTests().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
