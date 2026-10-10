"""Network-backed regression of pinned public action/SDK argument boundaries.

No npm install, native execution, provider call, or credentials are required.
--verify-cli additionally checks public Linux CLI bytes, without executing them.
Requires Node >=22.13 with node:module.stripTypeScriptTypes.
"""
import argparse
import base64
import hashlib
import io
import json
import os
import pathlib
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
ACTION = '1d6de8cb0c237e7c15e9e1bdf973826ebae490cc'
CLI = '2.1.293'
PARSER_URL = f'https://raw.githubusercontent.com/anthropics/claude-code-action/{ACTION}/base-action/src/parse-sdk-options.ts'
PARSER_SHA256 = 'b42cc8daa1d15fb00321784cec375b1c855bb2e41bf03b37dfd462385f9e5548'
PACKAGES = {
    'shell-quote': (
        'https://registry.npmjs.org/shell-quote/-/shell-quote-1.8.4.tgz',
        'sha512-VsC6n6vz1ihYYyZZwX7YZSF5l5x36ca17OC+a69h94YqB7X6XLwf+5MOgynYir2SLFUbl8gIYvBo8K8RoNQ6bQ==',
    ),
    'sdk': (
        'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.296.tgz',
        'sha512-Y+cZ2BT8X94mQ9GJOVyIqhjC/nWGvwozUVLjdkzX7aSt+zuo5tgk7Hdv9V7tEUQ9fKnEuiL6moYNWDeHqCD4Lw==',
    ),
    'cli': (
        'https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.293.tgz',
        'sha512-tYTbeVuhqD0TW2WJs90Tq+JaKLLnrX5JuxYTLG3pxf4Vr3QMonqsMLu4hZkgVSfEDPZhneFuDDgULQ3/FZzAIw==',
    ),
}


def download(url, limit):
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f'Public fixture exceeds size limit: {url}')
    return data


def verified_package(name):
    url, expected = PACKAGES[name]
    data = download(url, 125_000_000 if name == 'cli' else 10_000_000)
    actual = 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode('ascii')
    if actual != expected:
        raise ValueError(f'Integrity mismatch for pinned public {name} fixture')
    return data


def extract_public_package(data, destination):
    # SDK and shell-quote fixtures contain source only; never run package scripts.
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        total_size = 0
        for member in archive.getmembers():
            path = pathlib.PurePosixPath(member.name)
            if (path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != 'package'
                    or '\\' in member.name or ':' in member.name or member.issym() or member.islnk()):
                raise ValueError('Unsafe path in public package fixture')
            if member.isfile():
                total_size += member.size
                if member.size > 10_000_000 or total_size > 20_000_000:
                    raise ValueError('Public package fixture exceeds extraction bounds')
                target = destination.joinpath(*path.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.extractfile(member).read())


def workflow_args(path):
    text = path.read_text(encoding='utf-8')
    if f'anthropics/claude-code-action@{ACTION}' not in text or f'@anthropic-ai/claude-code@{CLI}' not in text:
        raise ValueError(f'{path.name}: fixture pins must match workflow pins')
    lines = text.splitlines()
    starts = [i for i, line in enumerate(lines) if line.strip() == 'claude_args: >-']
    if len(starts) != 1:
        raise ValueError(f'{path.name}: expected one folded claude_args block')
    start = starts[0]
    indent = len(lines[start]) - len(lines[start].lstrip())
    block = []
    for line in lines[start + 1:]:
        if not line.strip():
            continue
        if len(line) - len(line.lstrip()) <= indent:
            break
        block.append(line.strip())
    if not block:
        raise ValueError(f'{path.name}: empty claude_args')
    return ' '.join(block)


def verify_native_cli():
    with tarfile.open(fileobj=io.BytesIO(verified_package('cli')), mode='r:gz') as archive:
        binary = archive.extractfile('package/claude').read()
    # Exact release contains its public minified JS alongside native bytecode.
    # These checks establish option parsing only, never the model/tool loop.
    required_tools = b'.option("--tools <tools...>"'
    consume_required = b'if(h.required){let u=s.shift();if(u===void 0)this.optionMissingArgument(h);this.emit(`option:${h.name()}`,u)}'
    accept_inline_empty = b'if(/^--[^=]+=/.test(o)){let h=o.indexOf("="),u=this._findOption(o.slice(0,h));if(u&&(u.required||u.optional)){this.emit(`option:${u.name()}`,o.slice(h+1));continue}}'
    safe_mode = b'.option("--safe-mode"'
    for label, fragment in [('required tools', required_tools), ('required value consumption', consume_required),
                            ('equals accepts empty value', accept_inline_empty), ('safe mode', safe_mode)]:
        if binary.count(fragment) != 1:
            raise AssertionError(f'Pinned CLI static parser evidence changed: {label}')
    print(f'PASS CLI {CLI}: integrity verified; tools, equals-empty, strict-flag consumption and safe-mode static evidence')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify-cli', action='store_true', help='also download ~113 MB for static native CLI parser checks')
    options = parser.parse_args()
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Node >=22.13 is required for the public TypeScript parser fixture')
    workflows = {name: workflow_args(ROOT / '.github/workflows' / name)
                 for name in ['claude-review.yml', 'claude-implement.yml']}
    with tempfile.TemporaryDirectory(prefix='claude-action-args-') as temporary:
        fixture_root = pathlib.Path(temporary)
        source = download(PARSER_URL, 100_000)
        if hashlib.sha256(source).hexdigest() != PARSER_SHA256:
            raise ValueError('Integrity mismatch for pinned public action parser')
        (fixture_root / 'parse-sdk-options.ts').write_bytes(source)
        for name in ['shell-quote', 'sdk']:
            extract_public_package(verified_package(name), fixture_root / name)
        cases = {
            'known_bad': "--safe-mode --tools '' --disallowedTools 'mcp__*' --strict-mcp-config --mcp-config '{\"mcpServers\":{}}' --max-turns 1",
            'workflows': workflows,
        }
        case_file = fixture_root / 'cases.json'
        case_file.write_text(json.dumps(cases), encoding='utf-8')
        # Read only ordinary launch variables; never inherit token/secret values.
        environment = {name: os.environ[name] for name in ['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP'] if name in os.environ}
        environment.update(HOME=temporary, USERPROFILE=temporary, XDG_CONFIG_HOME=temporary,
                           CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', DISABLE_TELEMETRY='1', DO_NOT_TRACK='1')
        subprocess.run([node, str(ROOT / 'scripts/test_claude_action_args.mjs'), temporary, str(case_file)],
                       cwd=temporary, env=environment, check=True, timeout=60)
    if options.verify_cli:
        verify_native_cli()
    print('No Claude executable, provider call, or credentials were used; model-loop compatibility remains untested.')


if __name__ == '__main__':
    main()
