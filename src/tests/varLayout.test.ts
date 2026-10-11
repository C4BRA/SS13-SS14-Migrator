import { DMLexer } from '../parser/dmLexer.js';
import { DMParser } from '../parser/dmParser.js';
import { DMIRGenerator } from '../ir/dmIRGenerator.js';
import { computeVarLayouts } from '../ir/varLayout.js';

async function runVarLayoutTests() {
  console.log('=== Var Layout Tests ===');

  const check = (cond: boolean, msg: string) => {
    if (!cond) {
      console.error(`❌ TEST FAILED: ${msg}`);
      process.exit(1);
    }
    console.log(`✅ ${msg}`);
  };

  const parser = new DMParser(new DMLexer(`
/datum/thing
    var/a = 1
    var/b = 2

/datum/thing/sub
    var/c = 3
    a = 10

/obj/item
    var/force = 5
    density = 1
    loc = null
`).tokenize());
  const layouts = computeVarLayouts(new DMIRGenerator().generateIR(parser.parse()));

  const thing = layouts.get('/datum/thing')!;
  const sub = layouts.get('/datum/thing/sub')!;
  check(thing.own.join(',') === 'a,b', 'a type adds its declared vars in order');
  check(sub.own.join(',') === 'c', 'an override of an inherited var adds no new slot');
  check(sub.index.get('a') === thing.index.get('a') && sub.index.get('b') === thing.index.get('b'),
    'inherited vars keep their slot index in descendants');
  check(sub.index.get('c') === thing.index.size, 'new vars are appended after the parent layout');

  const atom = layouts.get('/atom')!;
  check(['name', 'desc', 'icon', 'icon_state'].every((n, i) => atom.index.get(n) === i),
    '/atom built-ins take the first atom slots');
  const item = layouts.get('/obj/item')!;
  check(item.index.has('force') && item.index.has('density'), 'declared and overridden atom vars get slots');
  check(!item.index.has('loc'), 'loc stays in dictionary storage');
  check(item.parentPath === '/obj' && layouts.get('/obj')!.parentPath === '/atom/movable',
    'layouts follow the IR parent chain');
}

runVarLayoutTests().catch(err => {
  console.error(err);
  process.exit(1);
});
