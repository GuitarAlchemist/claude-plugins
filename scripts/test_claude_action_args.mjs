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

async function argvFromAction(args) {
  const { sdkOptions } = context.parseSdkOptions({ claudeArgs: args, showFullOutput: 'false' });
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
  return captured;
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

const bad = await argvFromAction(cases.known_bad);
assert.ok(bad.includes('--tools'));
assert.equal(bad[bad.indexOf('--tools') + 1], '--strict-mcp-config');
assert.throws(() => assertEmptyToolsAndSeparateStrictMcp(bad), /empty tools value/);
console.log('PASS known old configuration loses empty tools and consumes strict-MCP flag');

for (const [name, args] of Object.entries(cases.workflows)) {
  assertEmptyToolsAndSeparateStrictMcp(await argvFromAction(args));
  console.log('PASS ' + name + ': actual pinned action + SDK preserve empty tools and strict MCP');
}
