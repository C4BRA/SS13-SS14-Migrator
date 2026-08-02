import { DMMParser, DMMMapData } from '../dmm/dmmParser.js';
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

function assertEqual(actual: any, expected: any, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`❌ TEST FAILED: ${message}`);
    console.error(`  Expected: ${JSON.stringify(expected)}`);
    console.error(`  Actual: ${JSON.stringify(actual)}`);
    process.exit(1);
  } else {
    console.log(`✅ ${message}`);
  }
}

async function runDMMParserTests() {
  console.log("=== Running DMM Parser Tests ===");

  const parser = new DMMParser();

  // Test 1: Non-existent file returns empty data
  const missingResult = parser.parseDMM('/nonexistent/path/file.dmm');
  assertEqual(missingResult.definitions.size, 0, 'Missing file returns empty definitions');
  assertEqual(missingResult.grids.length, 0, 'Missing file returns empty grids');

  // Test 2: Simple DMM with fixed-width keys
  const simpleDmm = `"aaa" = (/turf/simulated/floor)
"aab" = (/obj/item/sword)

(1,1,1) = {" 
aaaaabaaa
aaaaabaaa
aaaaabaaa
"}`;

  const simplePath = path.join(process.cwd(), 'temp_test_simple.dmm');
  fs.writeFileSync(simplePath, simpleDmm);

  const simpleResult = parser.parseDMM(simplePath);
  assertEqual(simpleResult.definitions.size, 2, 'Simple DMM parses 2 definitions');
  assert(simpleResult.definitions.has('aaa'), 'Definition "aaa" exists');
  assert(simpleResult.definitions.has('aab'), 'Definition "aab" exists');
  assertEqual(simpleResult.definitions.get('aaa')?.typePaths, ['/turf/simulated/floor'], 'Definition aaa has correct typePaths');
  assertEqual(simpleResult.definitions.get('aab')?.typePaths, ['/obj/item/sword'], 'Definition aab has correct typePaths');
  assertEqual(simpleResult.grids.length, 1, 'Simple DMM has 1 grid');
  assertEqual(simpleResult.grids[0].width, 3, 'Grid width is 3');
  assertEqual(simpleResult.grids[0].height, 3, 'Grid height is 3');
  assertEqual(simpleResult.grids[0].cells[0][0], 'aaa', 'Cell [0,0] is aaa');
  assertEqual(simpleResult.grids[0].cells[0][1], 'aab', 'Cell [0,1] is aab');
  assertEqual(simpleResult.grids[0].cells[0][2], 'aaa', 'Cell [0,2] is aaa');

  // Test 3: DMM with multiple type paths per key
  const multiTypeDmm = `"ground" = (/turf/simulated/floor, /obj/item/coin)
"wall" = (/turf/simulated/wall)

(1,1,1) = {" 
ground
wall
ground
"}`;

  const multiPath = path.join(process.cwd(), 'temp_test_multi.dmm');
  fs.writeFileSync(multiPath, multiTypeDmm);

  const multiResult = parser.parseDMM(multiPath);
  assertEqual(multiResult.definitions.get('ground')?.typePaths.length, 2, 'Multiple type paths for ground');
  assertEqual(multiResult.definitions.get('ground')?.typePaths, ['/turf/simulated/floor', '/obj/item/coin'], 'Ground type paths correct');
  assertEqual(multiResult.definitions.get('wall')?.typePaths, ['/turf/simulated/wall'], 'Wall type paths correct');

  // Test 4: Multi-Z level DMM
  const multiZDmm = `"floor" = (/turf/simulated/floor)
"ladder" = (/obj/structure/ladder)

(1,1,1) = {" 
floor
floor
floor
"}
(1,1,2) = {" 
floor
ladder
floor
"}`;

  const multiZPath = path.join(process.cwd(), 'temp_test_multiz.dmm');
  fs.writeFileSync(multiZPath, multiZDmm);

  const multiZResult = parser.parseDMM(multiZPath);
  assertEqual(multiZResult.grids.length, 2, 'Multi-Z DMM has 2 grids');
  assertEqual(multiZResult.grids[0].z, 1, 'First grid Z=1');
  assertEqual(multiZResult.grids[1].z, 2, 'Second grid Z=2');
  assertEqual(multiZResult.grids[0].cells[1][0], 'floor', 'Z=1 middle cell is floor');
  assertEqual(multiZResult.grids[1].cells[1][0], 'ladder', 'Z=2 middle cell is ladder');

  // Test 5: DMM with spaces in type paths (quoted)
  const quotedDmm = `"turf1" = ("/turf/simulated/floor", "/obj/item/sword")
"turf2" = (/turf/simulated/wall)

(1,1,1) = {" 
turf1
turf2
"}`;

  const quotedPath = path.join(process.cwd(), 'temp_test_quoted.dmm');
  fs.writeFileSync(quotedPath, quotedDmm);

  const quotedResult = parser.parseDMM(quotedPath);
  assertEqual(quotedResult.definitions.get('turf1')?.typePaths, ['/turf/simulated/floor', '/obj/item/sword'], 'Quoted paths parsed correctly');

  // Test 6: DMM with different key lengths (5-char keys)
  const longKeyDmm = `"floor" = (/turf/simulated/floor)
"wall_" = (/turf/simulated/wall)

(1,1,1) = {" 
floor
wall_
floor
"}`;

  const longKeyPath = path.join(process.cwd(), 'temp_test_longkey.dmm');
  fs.writeFileSync(longKeyPath, longKeyDmm);

  const longKeyResult = parser.parseDMM(longKeyPath);
  assertEqual(longKeyResult.definitions.size, 2, 'Long key DMM has 2 defs');
  assertEqual(longKeyResult.grids[0].width, 1, 'Long key grid width 1 (one column per row)');
  assertEqual(longKeyResult.grids[0].cells[0][0], 'floor', 'Long key cell [0,0]');
  assertEqual(longKeyResult.grids[0].cells[1][0], 'wall_', 'Long key cell [1,0]');

  // Test 7: Empty DMM file
  const emptyPath = path.join(process.cwd(), 'temp_test_empty.dmm');
  fs.writeFileSync(emptyPath, '');

  const emptyResult = parser.parseDMM(emptyPath);
  assertEqual(emptyResult.definitions.size, 0, 'Empty file has no definitions');
  assertEqual(emptyResult.grids.length, 0, 'Empty file has no grids');

  // Test 8: DMM with comments/whitespace
  const commentDmm = `
# This is a comment
"aaa" = (/turf/simulated/floor)

(1,1,1) = {" 
aaa
"}`;

  const commentPath = path.join(process.cwd(), 'temp_test_comment.dmm');
  fs.writeFileSync(commentPath, commentDmm);

  const commentResult = parser.parseDMM(commentPath);
  assertEqual(commentResult.definitions.size, 1, 'Comment DMM parses 1 definition');
  assertEqual(commentResult.warnings.length, 0, 'Comment lines do not produce warnings');

  // Test 9: Undefined tile keys and orphan definitions are flagged
  const orphanDmm = `"aaa" = (/turf/simulated/floor)
"unused" = (/obj/item/coin)

(1,1,1) = {" 
aaanone
aaa
"}`;

  const orphanPath = path.join(process.cwd(), 'temp_test_orphan.dmm');
  fs.writeFileSync(orphanPath, orphanDmm);

  const orphanResult = parser.parseDMM(orphanPath);
  assert(
    orphanResult.warnings.some(w => w.includes('undefined tile key "aaanone"')),
    'Undefined grid key is flagged'
  );
  assert(
    orphanResult.warnings.some(w => w.includes('never used in any grid')),
    'Orphan (unused) definition is flagged'
  );

  // Test 10: Non-rectangular grid is flagged
  const raggedDmm = `"aaa" = (/turf/simulated/floor)

(1,1,1) = {" 
aaaaaa
aaa
"}`;

  const raggedPath = path.join(process.cwd(), 'temp_test_ragged.dmm');
  fs.writeFileSync(raggedPath, raggedDmm);

  const raggedResult = parser.parseDMM(raggedPath);
  assert(
    raggedResult.warnings.some(w => w.includes('must be rectangular')),
    'Non-rectangular grid is flagged'
  );

  // Test 11: Per-tile attributes {attr=val} are parsed and stripped from paths
  const attrDmm = `"aaa" = (/turf/simulated/floor{dir=4;icon_state="wood"}, /obj/item/sword{layer=5})

(1,1,1) = {" 
aaa
"}`;

  const attrPath = path.join(process.cwd(), 'temp_test_attr.dmm');
  fs.writeFileSync(attrPath, attrDmm);

  const attrResult = parser.parseDMM(attrPath);
  const attrDef = attrResult.definitions.get('aaa');
  assertEqual(attrDef?.typePaths, ['/turf/simulated/floor', '/obj/item/sword'], 'Attribute braces stripped from type paths');
  assertEqual(attrDef?.attributes?.dir, '4', 'Tile attribute dir captured');
  assertEqual(attrDef?.attributes?.['icon_state'], '"wood"', 'Tile attribute icon_state captured');
  assertEqual(attrDef?.attributes?.layer, '5', 'Tile attribute layer captured');

  // Test 12 (Plan 09 B7): TGM multi-line definitions with `{...} =` continuations
  const tgmDmm = `"aaa" = (/turf/simulated/floor
/obj/structure/table{dir = 1}
/obj/item/sword)
"bbb" = (/turf/simulated/floor{icon_state = "wood"} = /obj/item/coin)
"ccc" = (/turf/simulated/floor,
/obj/item/shard)

(1,1,1) = {" 
aaabbb
ccc
"}`;

  const tgmPath = path.join(process.cwd(), 'temp_test_tgm.dmm');
  fs.writeFileSync(tgmPath, tgmDmm);

  const tgmResult = parser.parseDMM(tgmPath);
  assertEqual(tgmResult.definitions.get('aaa')?.typePaths, ['/turf/simulated/floor', '/obj/structure/table', '/obj/item/sword'], 'TGM multi-line definition accumulates paths');
  assertEqual(tgmResult.definitions.get('aaa')?.attributes?.dir, '1', 'TGM multi-line attrs captured');
  assertEqual(tgmResult.definitions.get('bbb')?.typePaths, ['/turf/simulated/floor', '/obj/item/coin'], 'TGM {attrs} = path continuation parsed');
  assertEqual(tgmResult.definitions.get('ccc')?.typePaths, ['/turf/simulated/floor', '/obj/item/shard'], 'TGM trailing-comma continuation parsed');
  assertEqual(tgmResult.grids[0].cells[0], ['aaa', 'bbb'], 'TGM grid cells decoded');

  // Test 13 (Plan 09 B7): per-column sections of the same z merge into ONE grid
  const colDmm = `"flr" = (/turf/simulated/floor)
"wal" = (/turf/simulated/wall)

(1,1,1) = {" 
walwal
flrflr
"}
(3,1,1) = {" 
wal
flr
"}`;

  const colPath = path.join(process.cwd(), 'temp_test_cols.dmm');
  fs.writeFileSync(colPath, colDmm);

  const colResult = parser.parseDMM(colPath);
  assertEqual(colResult.grids.length, 1, 'Per-column sections merge into one grid');
  assertEqual(colResult.grids[0].width, 3, 'Merged grid width spans both sections');
  assertEqual(colResult.grids[0].cells[0], ['wal', 'wal', 'wal'], 'Merged grid north row');
  assertEqual(colResult.grids[0].cells[1], ['flr', 'flr', 'flr'], 'Merged grid south row');

  // Test 14 (Plan 09 B7): negative coordinates in grid headers
  const negDmm = `"floor" = (/turf/simulated/floor)

(-2,-3,1) = {" 
floor
floor
"}`;

  const negPath = path.join(process.cwd(), 'temp_test_neg.dmm');
  fs.writeFileSync(negPath, negDmm);

  const negResult = parser.parseDMM(negPath);
  assertEqual(negResult.grids.length, 1, 'Negative-coord section parsed');
  assertEqual(negResult.grids[0].originX, -2, 'Negative origin X preserved');
  assertEqual(negResult.grids[0].width, 1, 'Negative-coord grid width');
  assertEqual(negResult.grids[0].cells[0][0], 'floor', 'Negative-coord grid cell');

  // Test 15 (Plan 10 B5): mixed-length keys decode by longest-match
  const mixedDmm = `"A" = (/turf/a)
"aa" = (/turf/aa)
"B" = (/turf/b)

(1,1,1) = {" 
Aaa
aaB
"}`;

  const mixedPath = path.join(process.cwd(), 'temp_test_mixed.dmm');
  fs.writeFileSync(mixedPath, mixedDmm);

  const mixedResult = parser.parseDMM(mixedPath);
  assertEqual(mixedResult.grids.length, 1, 'Mixed-key section parsed');
  assertEqual(mixedResult.grids[0].cells[0], ['A', 'aa'], 'Row 1 longest-match decodes A+aa (not A+a+a)');
  assertEqual(mixedResult.grids[0].cells[1], ['aa', 'B'], 'Row 2 longest-match decodes aa+B');
  assertEqual(mixedResult.grids[0].width, 2, 'Mixed-key grid width 2');

  // Test 16 (Plan 10 B5): space-separated rows skip whitespace, never treat
  // a space as a tile key
  const spacedDmm = `"a" = (/turf/a)
"b" = (/turf/b)

(1,1,1) = {" 
a b a b
"}`;

  const spacedPath = path.join(process.cwd(), 'temp_test_spaced.dmm');
  fs.writeFileSync(spacedPath, spacedDmm);

  const spacedResult = parser.parseDMM(spacedPath);
  assertEqual(spacedResult.grids[0].cells[0], ['a', 'b', 'a', 'b'], 'Space-separated row decodes to 4 tiles');
  assertEqual(spacedResult.grids[0].width, 4, 'Space-separated grid width 4');

  // Cleanup
  for (const f of ['temp_test_simple.dmm', 'temp_test_multi.dmm', 'temp_test_multiz.dmm', 
    'temp_test_quoted.dmm', 'temp_test_longkey.dmm', 'temp_test_empty.dmm', 'temp_test_comment.dmm',
    'temp_test_orphan.dmm', 'temp_test_ragged.dmm', 'temp_test_attr.dmm',
    'temp_test_tgm.dmm', 'temp_test_cols.dmm', 'temp_test_neg.dmm',
    'temp_test_mixed.dmm', 'temp_test_spaced.dmm']) {
    const fp = path.join(process.cwd(), f);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }

  console.log("\n✅ ALL DMM PARSER TESTS PASSED!");
}

runDMMParserTests().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});