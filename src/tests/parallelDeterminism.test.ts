import { DM2SS14Transpiler } from '../index.js';
import { crc32 } from '../dmi/pngCodec.js';
import * as fs from 'fs';
import * as zlib from 'zlib';
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

/** Relative-path -> file bytes for every file under dir (recursive, sorted). */
function snapshotTree(dir: string, base = dir, out = new Map<string, Buffer>()): Map<string, Buffer> {
  for (const entry of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, entry);
    if (fs.statSync(p).isDirectory()) snapshotTree(p, base, out);
    else out.set(path.relative(base, p), fs.readFileSync(p));
  }
  return out;
}

/** Minimal 1x1 RGB DMI fixture (same bytes as the runTests end-to-end fixture). */
function dmiFixture(): Buffer {
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
  const idatData = zlib.deflateSync(Buffer.from([0, 255, 0, 255]));
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
  return Buffer.concat([
    pngSignature,
    Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), ihdrData, chunkCrc('IHDR', ihdrData),
    dmiChunk, idatChunk, iendChunk
  ]);
}

async function runParallelDeterminismTests() {
  console.log("=== Running Parallel Determinism Tests ===");

  const inputDir = path.join(process.cwd(), 'temp_test_par_in');
  const outSeq = path.join(process.cwd(), 'temp_test_par_seq');
  const outPar = path.join(process.cwd(), 'temp_test_par_par');

  try {
    fs.rmSync(inputDir, { recursive: true, force: true });
    fs.mkdirSync(inputDir, { recursive: true });

    // Shared global defines (object-like + function-like) visible to all files.
    fs.writeFileSync(path.join(inputDir, '__defines.dm'),
      '#define SHARED_CONST 7\n#define WRAP(x) (x + 1)\n', 'utf-8');

    // File that locally overrides the shared define — copy-on-write must keep
    // the override scoped to this file even when it runs in a different worker.
    fs.writeFileSync(path.join(inputDir, 'a_override.dm'),
      '#undef SHARED_CONST\n#define SHARED_CONST 99\n/obj/alpha\n    var/v = SHARED_CONST\n    var/w = WRAP(1)\n', 'utf-8');

    // Plain consumers of the shared defines + a global var decl.
    fs.writeFileSync(path.join(inputDir, 'b_types.dm'),
      '/obj/beta\n    var/v = SHARED_CONST\n    var/w = WRAP(SHARED_CONST)\n/global/var/motd = "hi"\n', 'utf-8');
    fs.writeFileSync(path.join(inputDir, 'c_procs.dm'),
      '/obj/gamma/proc/run(x)\n    var/i = 0\n    for (i = 1, i <= SHARED_CONST, i++)\n        if (i == 3)\n            continue\n    return i + x\n', 'utf-8');

    // DMM with an orphan key (referenced but undefined) → forces a per-file
    // warning so the diagnostics merge is exercised, not just the happy path.
    fs.writeFileSync(path.join(inputDir, 'map.dmm'),
      '"flr" = (/turf/simulated/floor)\n\n(1,1,1) = {"\nflrZZZ\n"}', 'utf-8');

    fs.writeFileSync(path.join(inputDir, 'icon.dmi'), dmiFixture());

    const runConvert = async (outputDir: string, jobs: number) => {
      const warnings: string[] = [];
      const errors: string[] = [];
      const origWarn = console.warn;
      const origError = console.error;
      console.warn = (msg: any) => { warnings.push(String(msg)); };
      console.error = (msg: any) => { errors.push(String(msg)); };
      try {
        await new DM2SS14Transpiler().transpile({ inputDir, outputDir, jobs });
      } finally {
        console.warn = origWarn;
        console.error = origError;
      }
      return { warnings, errors };
    };

    const seq = await runConvert(outSeq, 1);
    const par = await runConvert(outPar, 4);

    // Diagnostics streams must be identical (same messages, same order).
    assertEqual(par.warnings, seq.warnings, 'Parallel warnings identical to sequential (order + content)');
    assertEqual(par.errors, seq.errors, 'Parallel errors identical to sequential (order + content)');

    // Every emitted file must be byte-identical.
    const seqTree = snapshotTree(outSeq);
    const parTree = snapshotTree(outPar);
    assertEqual([...parTree.keys()].sort(), [...seqTree.keys()].sort(),
      'Parallel run emits identical file set');
    const diffs: string[] = [];
    for (const [rel, buf] of seqTree) {
      const other = parTree.get(rel);
      if (!other || !other.equals(buf)) diffs.push(rel);
    }
    assert(diffs.length === 0,
      `All emitted outputs byte-identical between -j1 and -j4 (diffs: ${diffs.slice(0, 5).join(', ') || 'none'})`);

    // Spot-check semantics that exercise the shared/override define split.
    const proto = fs.readFileSync(path.join(outPar, 'Resources', 'Prototypes', 'converted_entities.yml'), 'utf-8');
    assert(proto.includes('99') || proto.includes('v: 99') || /v:\s*99/.test(proto) || proto.includes('= 99'),
      'Per-file #define override applied in worker (obj/alpha v = 99)');

    console.log("\n✅ ALL PARALLEL DETERMINISM TESTS PASSED!");
  } finally {
    for (const d of [inputDir, outSeq, outPar]) {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    }
  }
}

runParallelDeterminismTests().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
