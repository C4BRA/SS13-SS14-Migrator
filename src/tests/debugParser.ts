import { DMLexer } from '../parser/dmLexer.js';
import { DMParser } from '../parser/dmParser.js';

const code = `
/obj/item/weapon/energy_sword
    proc/activate(mob/user)
        if (!active)
            active = TRUE
            return 1
        return 0
`;

const lexer = new DMLexer(code);
const tokens = lexer.tokenize();
console.log('Tokens:', tokens.map(t => ({ type: t.type, value: t.value, line: t.line })));

const parser = new DMParser(tokens);
const ast = parser.parse();

console.log('\nAST:');
ast.forEach(n => {
  if (n.path === '/obj/item/weapon/energy_sword') {
    console.log('Type:', n.path);
    console.log('Procs:', n.procs.map(p => ({ 
      name: p.name, 
      statements: p.statements 
    })));
  }
});