import { DMIParser, DMIMetadata, DMIState } from '../dmi/dmiParser.js';
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

async function runDMIParserTests() {
  console.log("=== Running DMI Parser Tests ===");

  const parser = new DMIParser();

  // Test 1: Non-existent file returns defaults
  const missingResult = parser.parseDMI('/nonexistent/path/file.dmi');
  assertEqual(missingResult.width, 32, 'Missing file returns default width');
  assertEqual(missingResult.height, 32, 'Missing file returns default height');
  assertEqual(missingResult.states.length, 1, 'Missing file returns default state');
  assertEqual(missingResult.states[0].name, 'default', 'Missing file returns default state name');

  // Test 2: Create a minimal PNG with tEXt chunk containing DMI metadata
  const testPngPath = path.join(process.cwd(), 'temp_test_dmi.png');
  
  // Create a minimal valid PNG with tEXt chunk
  const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  
  // IHDR chunk (13 bytes data)
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(32, 0);   // width
  ihdrData.writeUInt32BE(32, 4);   // height
  ihdrData[8] = 8;                 // bit depth
  ihdrData[9] = 2;                 // color type (RGB)
  ihdrData[10] = 0;                // compression
  ihdrData[11] = 0;                // filter
  ihdrData[12] = 0;                // interlace
  
  const ihdrCrc = Buffer.alloc(4);
  const ihdrType = Buffer.from('IHDR');
  const ihdrCrcCalc = crc32(Buffer.concat([ihdrType, ihdrData]));
  ihdrCrc.writeUInt32BE(ihdrCrcCalc, 0);
  
  const ihdrChunk = Buffer.concat([
    Buffer.from([0,0,0,13]), // length
    ihdrType,
    ihdrData,
    ihdrCrc
  ]);

  // tEXt chunk with DMI metadata
  const dmiText = `# BEGIN DMI
version = 4.0
width = 32
height = 32
state "icon"
  dirs = 4
  frames = 1
  delay = 10
# END DMI`;
  
  const textKeyword = Buffer.from('DMI');
  const textNull = Buffer.from([0]);
  const textData = Buffer.from(dmiText, 'latin1');
  const textChunkData = Buffer.concat([textKeyword, textNull, textData]);
  
  const textCrc = Buffer.alloc(4);
  const textType = Buffer.from('tEXt');
  const textCrcCalc = crc32(Buffer.concat([textType, textChunkData]));
  textCrc.writeUInt32BE(textCrcCalc, 0);
  
  const textChunk = Buffer.concat([
    Buffer.from([0,0,0,0]).fill(0), // placeholder for length
    textType,
    textChunkData,
    textCrc
  ]);
  textChunk.writeUInt32BE(textChunkData.length, 0);

  // IEND chunk
  const iendCrc = Buffer.alloc(4);
  const iendType = Buffer.from('IEND');
  const iendCrcCalc = crc32(iendType);
  iendCrc.writeUInt32BE(iendCrcCalc, 0);
  
  const iendChunk = Buffer.concat([
    Buffer.from([0,0,0,0]),
    iendType,
    Buffer.from([]),
    iendCrc
  ]);

  const pngBuffer = Buffer.concat([pngSignature, ihdrChunk, textChunk, iendChunk]);
  fs.writeFileSync(testPngPath, pngBuffer);

  try {
    // Test 3: Parse valid DMI PNG
    const result = parser.parseDMI(testPngPath);
    assertEqual(result.version, '4.0', 'DMI version parsed correctly');
    assertEqual(result.width, 32, 'DMI width parsed correctly');
    assertEqual(result.height, 32, 'DMI height parsed correctly');
    assertEqual(result.states.length, 1, 'DMI state count correct');
    assertEqual(result.states[0].name, 'icon', 'DMI state name correct');
    assertEqual(result.states[0].dirs, 4, 'DMI dirs correct');
    assertEqual(result.states[0].frames, 1, 'DMI frames correct');
    assertEqual(result.states[0].delay, [10], 'DMI delay correct');

    // Test 4: Multiple states
    const multiStateText = `# BEGIN DMI
version = 4.0
width = 64
height = 64
state "idle"
  dirs = 1
  frames = 3
  delay = 5,5,5
state "move"
  dirs = 4
  frames = 2
  delay = 10,10
# END DMI`;

    const multiTextData = Buffer.from(multiStateText, 'latin1');
    const multiChunkData = Buffer.concat([Buffer.from('DMI'), Buffer.from([0]), multiTextData]);
    const multiCrcCalc = crc32(Buffer.concat([Buffer.from('tEXt'), multiChunkData]));
    const multiCrc = Buffer.alloc(4);
    multiCrc.writeUInt32BE(multiCrcCalc, 0);
    
    const multiChunk = Buffer.concat([
      Buffer.alloc(4).fill(0),
      Buffer.from('tEXt'),
      multiChunkData,
      multiCrc
    ]);
    multiChunk.writeUInt32BE(multiChunkData.length, 0);

    const multiPng = Buffer.concat([pngSignature, ihdrChunk, multiChunk, iendChunk]);
    const multiPngPath = path.join(process.cwd(), 'temp_test_dmi_multi.png');
    fs.writeFileSync(multiPngPath, multiPng);

    const multiResult = parser.parseDMI(multiPngPath);
    assertEqual(multiResult.width, 64, 'Multi-state DMI width');
    assertEqual(multiResult.height, 64, 'Multi-state DMI height');
    assertEqual(multiResult.states.length, 2, 'Multi-state count');
    assertEqual(multiResult.states[0].name, 'idle', 'First state name');
    assertEqual(multiResult.states[0].dirs, 1, 'First state dirs');
    assertEqual(multiResult.states[0].frames, 3, 'First state frames');
    assertEqual(multiResult.states[0].delay, [5,5,5], 'First state delays');
    assertEqual(multiResult.states[1].name, 'move', 'Second state name');
    assertEqual(multiResult.states[1].dirs, 4, 'Second state dirs');
    assertEqual(multiResult.states[1].frames, 2, 'Second state frames');
    assertEqual(multiResult.states[1].delay, [10,10], 'Second state delays');

    // Test 5: PNG without DMI chunks returns defaults
    const noDmiPng = Buffer.concat([pngSignature, ihdrChunk, iendChunk]);
    const noDmiPath = path.join(process.cwd(), 'temp_test_no_dmi.png');
    fs.writeFileSync(noDmiPath, noDmiPng);

    const noDmiResult = parser.parseDMI(noDmiPath);
    assertEqual(noDmiResult.width, 32, 'No-DMI PNG returns default width');
    assertEqual(noDmiResult.states[0].name, 'default', 'No-DMI PNG returns default state');

    // Test 6: Malformed PNG doesn't crash
    const badPngPath = path.join(process.cwd(), 'temp_test_bad.png');
    fs.writeFileSync(badPngPath, Buffer.from('not a png'));
    const badResult = parser.parseDMI(badPngPath);
    assertEqual(badResult.width, 32, 'Malformed PNG returns defaults');

    // Test 7: zTXt chunk (zlib-compressed DMI metadata) is decompressed
    const zlib = require('zlib');
    const zText = `# BEGIN DMI
version = 4.0
width = 32
height = 32
state "zstate"
  dirs = 1
  frames = 2
  delay = 10,10
# END DMI`;
    const compressedText = zlib.deflateSync(Buffer.from(zText, 'latin1'));
    const zChunkData = Buffer.concat([Buffer.from('DMI'), Buffer.from([0]), Buffer.from([0]), compressedText]);
    const zCrc = Buffer.alloc(4);
    zCrc.writeUInt32BE(crc32(Buffer.concat([Buffer.from('zTXt'), zChunkData])), 0);
    const zChunk = Buffer.concat([
      Buffer.alloc(4).fill(0),
      Buffer.from('zTXt'),
      zChunkData,
      zCrc
    ]);
    zChunk.writeUInt32BE(zChunkData.length, 0);

    const zPng = Buffer.concat([pngSignature, ihdrChunk, zChunk, iendChunk]);
    const zPngPath = path.join(process.cwd(), 'temp_test_dmi_ztxt.png');
    fs.writeFileSync(zPngPath, zPng);

    const zResult = parser.parseDMI(zPngPath);
    assertEqual(zResult.states[0].name, 'zstate', 'zTXt chunk decompressed and parsed');
    assertEqual(zResult.states[0].delay, [10, 10], 'zTXt delays parsed');
    assertEqual(zResult.warnings.length, 0, 'zTXt valid state produces no warnings');

    // Test 8: Frame/delay mismatch produces a validation warning
    const badDelayText = `# BEGIN DMI
version = 4.0
width = 32
height = 32
state "bad"
  dirs = 1
  frames = 3
  delay = 10,10
# END DMI`;
    const bdChunkData = Buffer.concat([Buffer.from('DMI'), Buffer.from([0]), Buffer.from(badDelayText, 'latin1')]);
    const bdCrc = Buffer.alloc(4);
    bdCrc.writeUInt32BE(crc32(Buffer.concat([Buffer.from('tEXt'), bdChunkData])), 0);
    const bdChunk = Buffer.concat([
      Buffer.alloc(4).fill(0),
      Buffer.from('tEXt'),
      bdChunkData,
      bdCrc
    ]);
    bdChunk.writeUInt32BE(bdChunkData.length, 0);

    const bdPng = Buffer.concat([pngSignature, ihdrChunk, bdChunk, iendChunk]);
    const bdPngPath = path.join(process.cwd(), 'temp_test_dmi_baddelay.png');
    fs.writeFileSync(bdPngPath, bdPng);

    const bdResult = parser.parseDMI(bdPngPath);
    assert(bdResult.warnings.length > 0, 'Delay/frames mismatch produces a warning');
    assert(
      bdResult.warnings[0].includes('delay list length'),
      'Delay/frames mismatch warning message is descriptive'
    );

    // Test 9 (Plan 09 B7): `state = "x"` assignment syntax (with equals sign)
    const eqText = `# BEGIN DMI
version = 4.0
width = 64
height = 32
state = "eqstate"
  dirs = 4
# END DMI`;
    const eqChunkData = Buffer.concat([Buffer.from('DMI'), Buffer.from([0]), Buffer.from(eqText, 'latin1')]);
    const eqCrc = Buffer.alloc(4);
    eqCrc.writeUInt32BE(crc32(Buffer.concat([Buffer.from('tEXt'), eqChunkData])), 0);
    const eqChunk = Buffer.concat([Buffer.alloc(4).fill(0), Buffer.from('tEXt'), eqChunkData, eqCrc]);
    eqChunk.writeUInt32BE(eqChunkData.length, 0);
    const eqPng = Buffer.concat([pngSignature, ihdrChunk, eqChunk, iendChunk]);
    const eqPngPath = path.join(process.cwd(), 'temp_test_dmi_eq.png');
    fs.writeFileSync(eqPngPath, eqPng);

    const eqResult = parser.parseDMI(eqPngPath);
    assertEqual(eqResult.states[0].name, 'eqstate', 'state = "x" assignment syntax parses the state name');
    assertEqual(eqResult.width, 64, 'state = "x" form still parses width');

    // Test 10 (Plan 09 B7): iTXt with empty language tag + translated keyword
    // (adjacent NULs — 3 distinct NUL bytes, not 5) must still parse.
    // Layout: "DMI"\0 flag(0) method(0) \0(empty lang) \0(empty translated) text
    const itxtText = `# BEGIN DMI
version = 4.0
width = 32
height = 32
state "itxtstate"
  frames = 1
# END DMI`;
    const itxtChunkData = Buffer.concat([
      Buffer.from('DMI'), Buffer.from([0]),
      Buffer.from([0, 0]), // compression flag + method
      Buffer.from([0]),    // empty language tag
      Buffer.from([0]),    // empty translated keyword
      Buffer.from(itxtText, 'utf8')
    ]);
    const itxtCrc = Buffer.alloc(4);
    itxtCrc.writeUInt32BE(crc32(Buffer.concat([Buffer.from('iTXt'), itxtChunkData])), 0);
    const itxtChunk = Buffer.concat([Buffer.alloc(4).fill(0), Buffer.from('iTXt'), itxtChunkData, itxtCrc]);
    itxtChunk.writeUInt32BE(itxtChunkData.length, 0);
    const itxtPng = Buffer.concat([pngSignature, ihdrChunk, itxtChunk, iendChunk]);
    const itxtPngPath = path.join(process.cwd(), 'temp_test_dmi_itxt.png');
    fs.writeFileSync(itxtPngPath, itxtPng);

    const itxtResult = parser.parseDMI(itxtPngPath);
    assertEqual(itxtResult.states[0].name, 'itxtstate', 'iTXt with empty language/translated fields parses (3-NUL layout)');

    console.log("\n✅ ALL DMI PARSER TESTS PASSED!");

  } finally {
    // Cleanup
    for (const f of [testPngPath, 'temp_test_dmi_multi.png', 'temp_test_no_dmi.png', 'temp_test_bad.png', 'temp_test_dmi_ztxt.png', 'temp_test_dmi_baddelay.png', 'temp_test_dmi_eq.png', 'temp_test_dmi_itxt.png']) {
      const fp = path.join(process.cwd(), f);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
  }
}

// Simple CRC32 for PNG chunks
function crc32(buf: Buffer): number {
  const table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 1);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

runDMIParserTests().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});