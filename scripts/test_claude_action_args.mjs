// This harness executes public argument adapters, never the Claude executable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire, stripTypeScriptTypes, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';

const [fixtureRoot, caseFile] = process.argv.slice(2);
const cases = JSON.parse(fs.readFileSync(caseFile, 'utf8'));
const fixtureRequire = createRequire(path.join(fixtureRoot, 'fixture.cjs'));
const { parse: parseShellArgs } = fixtureRequire('./shell-quote/package');
const source = fs.readFileSync(path.join(fixtureRoot, 'parse-sdk-options.ts'), 'utf8');
const stripped = stripTypeScriptTypes(source)
  .replace(/^import .*?;\s*/gm, '')
  .replace('export function parseSdkOptions', 'function parseSdkOptions');
const context = vm.createContext({ parseShellArgs, process: { env: {} } });
vm.runInContext(stripped, context, { filename: 'pinned-parse-sdk-options.ts' });

const forbidden = () => { throw new Error('Boundary test forbids child processes and network'); };
for (const [moduleName, operations] of [
  ['node:child_process', ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
  ['node:http', ['request', 'get']],
  ['node:https', ['request', 'get']],
  ['node:net', ['connect', 'createConnection']],
  ['node:tls', ['connect']],
]) {
  const module = fixtureRequire(moduleName);
  for (const operation of operations) module[operation] = forbidden;
}
globalThis.fetch = forbidden;
syncBuiltinESMExports();

const { query } = await import(pathToFileURL(path.join(fixtureRoot, 'sdk/package/sdk.mjs')));
const stopBeforeSpawn = new Error('Captured SDK argv; do not start Claude');

async function argvFromAction(args, expectedTurns) {
  const { sdkOptions } = context.parseSdkOptions({ claudeArgs: args, showFullOutput: 'false' });
  assert.equal(sdkOptions.maxTurns, expectedTurns, 'Action must preserve the role-specific turn ceiling');
  let captured;
  let session;
  try {
    session = query({
      prompt: 'Argument serialization only; no model may run.',
      options: {
        ...sdkOptions,
        env: {},
        pathToClaudeCodeExecutable: path.join(fixtureRoot, 'not-an-executable'),
        spawnClaudeCodeProcess(request) {
          captured = request.args;
          throw stopBeforeSpawn;
        },
      },
    });
    for await (const ignored of session) {
      assert.fail('Mock spawn must never produce a Claude message');
    }
  } catch (error) {
    assert.ok(captured, 'SDK failed before reaching mock spawn: ' + error.message);
    assert.equal(error, stopBeforeSpawn, 'Only the deliberate capture sentinel may end the SDK query');
  } finally {
    session?.close();
  }
  assert.ok(captured, 'The real SDK must reach the capture-only spawn callback');
  const turnFlag = captured.findIndex(value => value === '--max-turns' || value.startsWith('--max-turns='));
  assert.notEqual(turnFlag, -1, 'SDK must forward the turn ceiling');
  const turnValue = captured[turnFlag] === '--max-turns'
    ? captured[turnFlag + 1] : captured[turnFlag].slice('--max-turns='.length);
  assert.equal(turnValue, String(expectedTurns), 'SDK must serialize the same bounded ceiling');
  return { argv: captured, sdkOptions };
}

function assertEmptyToolsAndSeparateStrictMcp(argv) {
  // Required CLI options accept either a separate value or --name=value.
  const toolFlag = argv.findIndex(value => value === '--tools' || value.startsWith('--tools='));
  assert.notEqual(toolFlag, -1, 'Missing explicit tools option');
  const emptyValue = argv[toolFlag] === '--tools'
    ? argv[toolFlag + 1]
    : argv[toolFlag].slice('--tools='.length);
  assert.equal(emptyValue, '', 'Action/SDK must preserve the explicit empty tools value');
  const strictFlag = argv.indexOf('--strict-mcp-config');
  assert.notEqual(strictFlag, -1, 'Missing strict MCP flag');
  assert.ok(argv[toolFlag] !== '--tools' || strictFlag !== toolFlag + 1,
    'Strict MCP flag must not be consumed as the tools value');
}

const { argv: bad } = await argvFromAction(cases.known_bad, 1);
assert.ok(bad.includes('--tools'));
assert.equal(bad[bad.indexOf('--tools') + 1], '--strict-mcp-config');
assert.throws(() => assertEmptyToolsAndSeparateStrictMcp(bad), /empty tools value/);
console.log('PASS known old configuration loses empty tools and consumes strict-MCP flag');

let reviewOptions;
for (const [name, args] of Object.entries(cases.workflows)) {
  const expectedTurns = name === 'claude-review.yml' ? 2 : 1;
  const { argv, sdkOptions } = await argvFromAction(args, expectedTurns);
  assertEmptyToolsAndSeparateStrictMcp(argv);
  if (name === 'claude-review.yml') reviewOptions = sdkOptions;
  console.log('PASS ' + name + ': actual action + SDK preserve empty tools, strict MCP and maxTurns=' + expectedTurns);
}

// Replay the actual pinned action result boundary, not a copy of its turn guard.
// The SDK iterator here is synthetic; no authenticated model result is claimed.
const runnerSource = fs.readFileSync(path.join(fixtureRoot, 'run-claude-sdk.ts'), 'utf8');
const runner = stripTypeScriptTypes(runnerSource)
  .replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*/gm, '')
  .replace('export async function runClaudeWithSdk', 'async function runClaudeWithSdk');
function resultBoundary(result, options = reviewOptions, hasJsonSchema = true) {
  const state = { queryCalls: 0, capturedOptions: null };
  const sandbox = vm.createContext({
    console: { log() {}, error() {} }, readFile: async () => 'Immutable synthetic diff',
    access: async () => { throw new Error('No request file'); }, dirname: path.dirname, join: path.join,
    query: async function* ({options}) { state.queryCalls++; state.capturedOptions = options; yield result; },
    writeExecutionFile: async () => 'synthetic-output.json',
    core: { info() {}, error() {}, setFailed() {} },
  });
  vm.runInContext(runner, sandbox, { filename: 'pinned-run-claude-sdk.ts', timeout: 1000 });
  return { state, run: () => sandbox.runClaudeWithSdk('synthetic-prompt.txt', {
    sdkOptions: options, showFullOutput: false, hasJsonSchema,
  }) };
}
const syntheticReport = {tldr:'Fixture only',verdict:'no_findings',checklist:[{evidence:'fixture',result:'fixture'}]};
const twoTurns = {type:'result',subtype:'success',is_error:false,num_turns:2,structured_output:syntheticReport};
const review = resultBoundary(twoTurns);
const accepted = await review.run();
assert.equal(accepted.conclusion, 'success');
assert.deepEqual(JSON.parse(accepted.structuredOutput), syntheticReport);
assert.equal(review.state.queryCalls, 1, 'One query, no retry loop');
assert.equal(review.state.capturedOptions.maxTurns, 2);
await assert.rejects(resultBoundary(twoTurns, {...reviewOptions,maxTurns:1}).run,
  /after 2 turns, exceeding the configured maximum of 1/);
await assert.rejects(resultBoundary({...twoTurns,num_turns:3}).run,
  /after 3 turns, exceeding the configured maximum of 2/);
await assert.rejects(resultBoundary({...twoTurns,structured_output:undefined}).run,
  /did not return structured_output/);
await assert.rejects(resultBoundary({...twoTurns,is_error:true}).run, /did not return structured_output/);
await assert.rejects(resultBoundary({...twoTurns,is_error:true},reviewOptions,false).run, /result is_error:true/);
console.log('PASS actual result guard accepts a two-turn fixture only within the review ceiling; stale one-turn, three-turn, missing-output and error controls refuse');
