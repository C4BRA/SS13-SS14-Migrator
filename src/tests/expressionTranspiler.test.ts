import { DMExpressionTranspiler } from '../transpiler/expressionTranspiler.js';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ TEST FAILED: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ ${message}`);
  }
}

function assertContains(haystack: string, needle: string, message: string) {
  if (!haystack.includes(needle)) {
    console.error(`❌ TEST FAILED: ${message}`);
    console.error(`  Expected to contain: "${needle}"`);
    console.error(`  Actual: "${haystack}"`);
    process.exit(1);
  } else {
    console.log(`✅ ${message}`);
  }
}

async function runExpressionTranspilerTests() {
  console.log("=== Running DM Expression Transpiler Tests ===");

  const transpiler = new DMExpressionTranspiler();

  // Test 1: Number literal
  const numResult = transpiler.transpileExpressionString('42');
  assertContains(numResult.csharp, 'DMValue.FromNumber(42)', 'Number literal transpilation');

  // Test 2: String literal
  const strResult = transpiler.transpileExpressionString('"hello world"');
  assertContains(strResult.csharp, 'DMValue.FromString("hello world")', 'String literal transpilation');

  // Test 3: Boolean literals
  const trueResult = transpiler.transpileExpressionString('TRUE');
  assertContains(trueResult.csharp, 'DMValue.FromNumber(1)', 'TRUE literal transpilation');

  const falseResult = transpiler.transpileExpressionString('FALSE');
  assertContains(falseResult.csharp, 'DMValue.FromNumber(0)', 'FALSE literal transpilation');

  // Test 4: Null literal
  const nullResult = transpiler.transpileExpressionString('NULL');
  assertContains(nullResult.csharp, 'DMValue.Null', 'NULL literal transpilation');

  // Test 5: Variable access
  const varResult = transpiler.transpileExpressionString('myVar');
  assertContains(varResult.csharp, 'comp.GetVar("myVar")', 'Variable access transpilation');

  // Test 6: Binary arithmetic - addition
  const addResult = transpiler.transpileExpressionString('a + b');
  assertContains(addResult.csharp, 'DMValue.Add(', 'Addition transpilation');

  // Test 7: Binary arithmetic - subtraction
  const subResult = transpiler.transpileExpressionString('a - b');
  assertContains(subResult.csharp, 'DMValue.Subtract(', 'Subtraction transpilation');

  // Test 8: Binary arithmetic - multiplication
  const mulResult = transpiler.transpileExpressionString('a * b');
  assertContains(mulResult.csharp, 'DMValue.Multiply(', 'Multiplication transpilation');

  // Test 9: Binary arithmetic - division
  const divResult = transpiler.transpileExpressionString('a / b');
  assertContains(divResult.csharp, 'DMValue.Divide(', 'Division transpilation');

  // Test 10: Binary arithmetic - modulo
  const modResult = transpiler.transpileExpressionString('a % b');
  assertContains(modResult.csharp, 'DMValue.Modulo(', 'Modulo transpilation');

  // Test 11: Comparison - equality
  const eqResult = transpiler.transpileExpressionString('a == b');
  assertContains(eqResult.csharp, 'DMValue.Equals(', 'Equality transpilation');

  // Test 12: Comparison - inequality
  const neqResult = transpiler.transpileExpressionString('a != b');
  assertContains(neqResult.csharp, '!DMValue.Equals(', 'Inequality transpilation');

  // Test 13: Comparison - less than
  const ltResult = transpiler.transpileExpressionString('a < b');
  assertContains(ltResult.csharp, 'DMValue.LessThan(', 'Less than transpilation');

  // Test 14: Comparison - greater than
  const gtResult = transpiler.transpileExpressionString('a > b');
  assertContains(gtResult.csharp, 'DMValue.GreaterThan(', 'Greater than transpilation');

  // Test 15: Comparison - less or equal
  const leResult = transpiler.transpileExpressionString('a <= b');
  assertContains(leResult.csharp, 'DMValue.LessOrEqual(', 'Less or equal transpilation');

  // Test 16: Comparison - greater or equal
  const geResult = transpiler.transpileExpressionString('a >= b');
  assertContains(geResult.csharp, 'DMValue.GreaterOrEqual(', 'Greater or equal transpilation');

  // Test 17: Logical AND
  const andResult = transpiler.transpileExpressionString('a && b');
  assertContains(andResult.csharp, 'DMValue.And(', 'Logical AND transpilation');

  // Test 18: Logical OR
  const orResult = transpiler.transpileExpressionString('a || b');
  assertContains(orResult.csharp, 'DMValue.Or(', 'Logical OR transpilation');

  // Test 19: Logical NOT
  const notResult = transpiler.transpileExpressionString('!a');
  assertContains(notResult.csharp, 'DMValue.Not(', 'Logical NOT transpilation');

  // Test 20: Unary minus
  const negResult = transpiler.transpileExpressionString('-a');
  assertContains(negResult.csharp, 'DMValue.Negate(', 'Unary minus transpilation');

  // Test 21: Parenthesized expression
  const parenResult = transpiler.transpileExpressionString('(a + b) * c');
  assertContains(parenResult.csharp, 'DMValue.Multiply(', 'Parenthesized expression');
  assertContains(parenResult.csharp, 'DMValue.Add(', 'Parenthesized expression contains addition');

  // Test 22: Proc call - sleep
  const sleepResult = transpiler.transpileExpressionString('sleep(5)');
  assertContains(sleepResult.csharp, 'DMTickScheduler.Sleep(DMValue.FromNumber(5))', 'sleep() proc transpilation');

  // Test 23: Proc call - spawn
  const spawnResult = transpiler.transpileExpressionString('spawn(2)');
  assertContains(spawnResult.csharp, 'DMTickScheduler.Spawn(DMValue.FromNumber(2)', 'spawn() proc transpilation');

  // Test 24: User-defined proc call
  const procResult = transpiler.transpileExpressionString('myProc(arg1, arg2)');
  assertContains(procResult.csharp, 'comp.CallProc("myProc"', 'User proc call transpilation');

  // Test 25: Ternary operator
  const ternaryResult = transpiler.transpileExpressionString('a ? b : c');
  assertContains(ternaryResult.csharp, '.IsTrue() ?', 'Ternary operator transpilation');

  // Test 26: Complex expression with precedence
  const complexResult = transpiler.transpileExpressionString('a + b * c');
  assertContains(complexResult.csharp, 'DMValue.Add(', 'Complex expression - addition at top level');
  assertContains(complexResult.csharp, 'DMValue.Multiply(', 'Complex expression - multiplication nested');

  // Test 27: Expression with variable and literal
  const mixedResult = transpiler.transpileExpressionString('damage + 10');
  assertContains(mixedResult.csharp, 'DMValue.Add(', 'Mixed variable and literal');
  assertContains(mixedResult.csharp, 'DMValue.FromNumber(10)', 'Literal in mixed expression');

  // Test 28: chained comparisons
  const chainedResult = transpiler.transpileExpressionString('a == b && c != d');
  assertContains(chainedResult.csharp, 'DMValue.And(', 'Chained comparisons');
  assertContains(chainedResult.csharp, 'DMValue.Equals(', 'Chained - equality');
  assertContains(chainedResult.csharp, '!DMValue.Equals(', 'Chained - inequality');

  // Test 29: usr/src special variables
  const usrResult = transpiler.transpileExpressionString('usr');
  assertContains(usrResult.csharp, 'DMRuntimeHelpers.CurrentUsr', 'usr variable');

  const srcResult = transpiler.transpileExpressionString('src');
  assertContains(srcResult.csharp, 'DMValue.FromComponent(comp)', 'src variable');

  // Test 30: Empty expression
  const emptyResult = transpiler.transpileExpressionString('');
  assert(emptyResult.csharp === 'DMValue.Null', 'Empty expression returns Null');

  console.log("\n✅ ALL EXPRESSION TRANSPILER TESTS PASSED!");
}

runExpressionTranspilerTests().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});