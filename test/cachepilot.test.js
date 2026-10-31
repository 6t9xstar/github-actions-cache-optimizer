import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { matchFiles, globToRegExp, expandBraces } from '../src/glob.js';
import { analyze, expressions, hashFilesCalls, parseUses } from '../src/analyzer.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'cachepilot.js');

function repo(workflow, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cachepilot-'));
  fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
  const wf = path.join(dir, '.github', 'workflows', 'ci.yml');
  fs.writeFileSync(wf, workflow);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return { dir, wf };
}

function ids(workflow, files) {
  const { dir, wf } = repo(workflow, files);
  return analyze({ root: dir, files: [wf] }).findings.map((f) => f.ruleId);
}

const job = (steps, extra = '') => `on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n${extra}    steps:\n${steps}`;

test('glob matching follows @actions/glob semantics', () => {
  const files = ['package-lock.json', 'web/package-lock.json', 'src/a.ts', 'src/deep/b.ts', '.config/x.json', 'docs/readme.md'];
  assert.deepEqual(matchFiles(['**/package-lock.json'], files), ['package-lock.json', 'web/package-lock.json']);
  assert.deepEqual(matchFiles(['package-lock.json'], files), ['package-lock.json']);
  assert.deepEqual(matchFiles(['src/*.ts'], files), ['src/a.ts']);
  assert.deepEqual(matchFiles(['src/**'], files), ['src/a.ts', 'src/deep/b.ts']);
  assert.deepEqual(matchFiles(['src'], files), ['src/a.ts', 'src/deep/b.ts']);
  assert.deepEqual(matchFiles(['**/*.ts', '!src/deep/**'], files), ['src/a.ts']);
  assert.deepEqual(matchFiles(['.config/*.json'], files), ['.config/x.json']);
  assert.deepEqual(matchFiles(['**/*.{ts,md}'], files), ['src/a.ts', 'src/deep/b.ts', 'docs/readme.md']);
  assert.deepEqual(expandBraces('a{b,c}d'), ['abd', 'acd']);
  assert.ok(globToRegExp('**/x').test('x'));
});

test('expression helpers', () => {
  assert.deepEqual(expressions('a-${{ runner.os }}-${{hashFiles(\'x\')}}'), ['runner.os', "hashFiles('x')"]);
  assert.deepEqual(hashFilesCalls("${{ hashFiles('a', '**/b') }}-${{ hashFiles('it''s') }}"), [['a', '**/b'], ["it's"]]);
  assert.deepEqual(parseUses('actions/cache/restore@v4.2.0'), { name: 'actions/cache/restore', ref: 'v4.2.0', major: 4 });
  assert.equal(parseUses('actions/cache@0123456789abcdef0123456789abcdef01234567').major, null);
});

test('a well-configured workflow is clean', () => {
  const wf = job(`      - uses: actions/checkout@v7
      - uses: actions/cache@v6
        with:
          path: ~/.npm
          key: \${{ runner.os }}-npm-\${{ hashFiles('**/package-lock.json') }}
          restore-keys: |
            \${{ runner.os }}-npm-
      - run: npm ci
`);
  assert.deepEqual(ids(wf, { 'package-lock.json': '{}' }), []);
});

test('setup-node with cache and lockfile is clean', () => {
  const wf = job(`      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: npm
      - run: npm ci
`);
  assert.deepEqual(ids(wf, { 'package-lock.json': '{}' }), []);
});

test('volatile keys: error without restore-keys, warning with', () => {
  const base = (restore) => job(`      - uses: actions/cache@v6
        with:
          path: ~/.npm
          key: npm-\${{ github.sha }}
${restore ? '          restore-keys: npm-\n' : ''}      - run: npm ci
`);
  const { dir, wf } = repo(base(false), { 'package-lock.json': '{}' });
  const f1 = analyze({ root: dir, files: [wf] }).findings.find((f) => f.ruleId === 'CP001');
  assert.equal(f1.severity, 'error');
  const r2 = repo(base(true), { 'package-lock.json': '{}' });
  const f2 = analyze({ root: r2.dir, files: [r2.wf] }).findings.find((f) => f.ruleId === 'CP001');
  assert.equal(f2.severity, 'warning');
});

test('static keys, unmatched hashFiles and restore-key problems', () => {
  const found = ids(job(`      - uses: actions/cache@v6
        with:
          path: ~/.cache/pip
          key: pip
          restore-keys: pip
      - uses: actions/cache@v6
        with:
          path: ~/.m2/repository
          key: maven-\${{ hashFiles('pom.xml') }}
      - uses: actions/cache@v6
        with:
          path: ~/.cargo/registry
          key: cargo-\${{ hashFiles('/abs/Cargo.lock') }}
          restore-keys: other-
`));
  for (const id of ['CP002', 'CP003', 'CP004', 'CP005', 'CP013']) assert.ok(found.includes(id), id);
});

test('multi-OS matrix without runner.os in the key', () => {
  const found = ids(
    job(
      `      - uses: actions/cache@v6
        with:
          path: ~/.npm
          key: npm-\${{ hashFiles('**/package-lock.json') }}
          restore-keys: npm-
`,
      '    strategy:\n      matrix:\n        os: [ubuntu-latest, windows-latest]\n',
    ).replace('runs-on: ubuntu-latest', 'runs-on: ${{ matrix.os }}'),
    { 'package-lock.json': '{}' },
  );
  assert.ok(found.includes('CP006'));
});

test('node_modules caching, duplicates, outdated versions and ordering', () => {
  const found = ids(job(`      - uses: actions/setup-node@v3
        with:
          cache: npm
      - run: npm ci
      - uses: actions/cache@v2
        with:
          path: node_modules
          key: \${{ runner.os }}-nm-\${{ hashFiles('**/package-lock.json') }}
          restore-keys: \${{ runner.os }}-nm-
`), { 'package-lock.json': '{}' });
  for (const id of ['CP007', 'CP008', 'CP009', 'CP011']) assert.ok(found.includes(id), id);
});

test('setup action cache without the required lockfile', () => {
  const { dir, wf } = repo(job(`      - uses: actions/setup-node@v7
        with:
          cache: npm
      - uses: actions/setup-python@v7
        with:
          cache: pip
`), { 'web/package-lock.json': '{}' });
  const f = analyze({ root: dir, files: [wf] }).findings.filter((x) => x.ruleId === 'CP010');
  assert.equal(f.length, 2);
  assert.match(f[0].fix, /cache-dependency-path: web\/package-lock.json/);
});

test('yarn repository with cache: npm suggests cache: yarn', () => {
  const { dir, wf } = repo(job('      - uses: actions/setup-node@v7\n        with:\n          cache: npm\n'), { 'yarn.lock': '' });
  const f = analyze({ root: dir, files: [wf] }).findings.find((x) => x.ruleId === 'CP010');
  assert.match(f.fix, /cache: yarn/);
});

test('installs without any cache get a suggestion', () => {
  const { dir, wf } = repo(job('      - run: |\n          pip install -r requirements.txt\n          go test ./...\n'), { 'requirements.txt': '' });
  const f = analyze({ root: dir, files: [wf] }).findings.filter((x) => x.ruleId === 'CP012');
  assert.equal(f.length, 2);
  assert.match(f[0].suggestion, /actions\/setup-python@v7/);
});

test('missing required inputs and YAML errors', () => {
  assert.ok(ids(job('      - uses: actions/cache@v6\n        with:\n          path: x\n')).includes('CP014'));
  assert.deepEqual(ids('jobs:\n  a: [\n'), ['CP000']);
});

function run(args, cwd = root) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd, env: { ...process.env, NO_COLOR: '1' } });
}

test('CLI: scan, optimize, formats and exit codes', () => {
  const scan = run(['scan', '--root', 'fixtures/repo', 'fixtures/repo/.github/workflows']);
  assert.equal(scan.status, 1);
  assert.match(scan.stdout, /CACHEPILOT REPORT/);

  const opt = run(['optimize', '--root', 'fixtures/repo', 'fixtures/repo/.github/workflows']);
  assert.match(opt.stdout, /restore-keys: \|/);
  assert.match(opt.stdout, /\$\{\{ runner\.os \}\}-npm-\$\{\{ hashFiles\('\*\*\/package-lock\.json'\) \}\}/);

  assert.equal(run(['--root', 'fixtures/good', 'fixtures/good/.github/workflows']).status, 0);
  // Default path is .github/workflows below the working directory.
  assert.equal(run([], path.join(root, 'fixtures', 'good')).status, 0);

  const json = JSON.parse(run(['--root', 'fixtures/repo', 'fixtures/repo/.github/workflows', '-f', 'json']).stdout);
  assert.ok(json.jobs.length === 2);
  const sarif = JSON.parse(run(['--root', 'fixtures/repo', 'fixtures/repo/.github/workflows', '-f', 'sarif']).stdout);
  assert.equal(sarif.runs[0].tool.driver.name, 'CachePilot');
  assert.match(run(['--root', 'fixtures/repo', 'fixtures/repo/.github/workflows', '-f', 'github']).stdout, /^::error file=/m);
  assert.equal(run(['--root', 'fixtures/repo', 'fixtures/repo/.github/workflows', '--fail-on', 'none']).status, 0);
  assert.equal(run(['nope/']).status, 2);
});
