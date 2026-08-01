import { DMLexer, TokenType } from '../parser/dmLexer.js';
import { DMParser } from '../parser/dmParser.js';
import { DMIRGenerator } from '../ir/dmIRGenerator.js';
import { YAMLGenerator } from '../transpiler/yamlGenerator.js';
import { DMIParser } from '../dmi/dmiParser.js';
import { DMMParser } from '../dmm/dmmParser.js';
import { DM2SS14Transpiler } from '../index.js';
import * as fs from 'fs';
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
  await import('./dmmParser.test.js');
  await import('./csharpEmitter.test.js');
  await import('./preprocessor.test.js');

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

    // Minimal DMI icon fixture (IHDR + DMI tEXt metadata + IEND)
    const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(32, 0);
    ihdrData.writeUInt32BE(32, 4);
    ihdrData[8] = 8;
    ihdrData[9] = 2;
    const dmiText = `# BEGIN DMI
version = 4.0
width = 32
height = 32
state "icon"
  dirs = 1
  frames = 1
# END DMI`;
    const dmiChunkData = Buffer.concat([Buffer.from('DMI'), Buffer.from([0]), Buffer.from(dmiText, 'latin1')]);
    const dmiChunk = Buffer.concat([
      Buffer.from([0, 0, 0, dmiChunkData.length]),
      Buffer.from('tEXt'),
      dmiChunkData,
      Buffer.alloc(4)
    ]);
    const iendChunk = Buffer.concat([
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('IEND'),
      Buffer.alloc(0),
      Buffer.alloc(4)
    ]);
    const dmiFixture = Buffer.concat([pngSignature, Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), ihdrData, Buffer.alloc(4), dmiChunk, iendChunk]);
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
    assert(fs.existsSync(path.join(tmpOutputDir, 'Content.Server', 'DM', 'ConvertedDMSystems.cs')), "Generated C# DM Systems");
    assert(fs.existsSync(path.join(tmpOutputDir, 'Resources', 'Textures', 'icon.rsi', 'meta.json')), "DMI converted to RSI with meta.json");
    assert(fs.existsSync(path.join(tmpOutputDir, 'Resources', 'Maps', 'testmap.yml')), "DMM converted to grid map YAML");
    const dmmMapYaml = fs.readFileSync(path.join(tmpOutputDir, 'Resources', 'Maps', 'testmap.yml'), 'utf-8');
    assert(dmmMapYaml.includes('proto: obj_item_weapon_sword'), "DMM item mapped to generated prototype id");

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

    // Test 7: Generated C# solution compiles (dotnet build), if dotnet is available
    const { spawnSync } = await import('child_process');
    const dotnetCheck = spawnSync('dotnet', ['--version'], { stdio: 'pipe' });
    if (dotnetCheck.status === 0) {
      console.log("   dotnet found, verifying generated solution compiles...");
      const buildResult = spawnSync('dotnet', ['build', path.join(tmpOutputDir, 'Content.sln'), '--nologo', '-v', 'q'], {
        stdio: 'pipe',
        timeout: 300000
      });
      const buildLog = buildResult.stdout?.toString() + buildResult.stderr?.toString();
      const failed = buildResult.status !== 0 || /error CS\d+/.test(buildLog);
      if (failed) {
        console.error(buildLog.slice(-2000));
      }
      assert(!failed, `Generated C# solution builds (exit ${buildResult.status})`);
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
