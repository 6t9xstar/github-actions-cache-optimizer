# CachePilot: GitHub Actions cache analyzer and optimizer

**Find `actions/cache` keys that never hit, `hashFiles()` patterns that match nothing, missing `restore-keys` and uncached dependency installs. CachePilot then prints the optimized cache configuration.**

[![CI](https://github.com/6t9xstar/github-actions-cache-optimizer/actions/workflows/ci.yml/badge.svg)](https://github.com/6t9xstar/github-actions-cache-optimizer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen)

A cache key with `${{ github.sha }}` never gets an exact hit. `hashFiles('package-lock.json')` returns an empty string when the lockfile lives in `web/`, so the key never changes. Without `restore-keys`, every dependency bump starts from zero. A matrix with Linux, Windows and macOS keeps overwriting the same cache.
These mistakes don't fail the build. They just make it slow, so nobody notices. **CachePilot** finds them statically and tells you exactly what to change.

```bash
npx github:6t9xstar/github-actions-cache-optimizer
```

## Example

```text
CACHEPILOT REPORT
1 workflows · 2 jobs · 4 cache steps

[ERROR]   job "test" actions/setup-node has cache: npm but package-lock.json, npm-shrinkwrap.json match
          no file at the repository root; the step will fail.
          CP010 .github/workflows/ci.yml:15  Fix: cache-dependency-path: web/package-lock.json
[ERROR]   job "test" Cache key uses github.sha: the key is new on every run, so the cache is never restored.
          CP001 .github/workflows/ci.yml:21  Fix: key: ${{ runner.os }}-npm-${{ hashFiles('**/package-lock.json') }}
[WARNING] job "test" Job runs on a multi-OS matrix but the key has no runner.os, so Linux, Windows and
          macOS overwrite each other's caches.
[ERROR]   job "test" hashFiles('package-lock.json') matches no files, so it returns '' and the key never changes.
          CP003 .github/workflows/ci.yml:25  Fix: hashFiles('**/package-lock.json')
[WARNING] job "test" No restore-keys configured: after any lockfile change the job starts from an empty cache.
[ERROR]   job "python" actions/cache@v2 no longer works: GitHub shut down the legacy cache service it uses in 2025.
[WARNING] job "python" Cache is restored at step 4, after "pip install -r requirements.txt" already ran at step 3.
[WARNING] job "python" Missing lockfile hash: key "pip-cache" never changes, so the cache keeps stale pip
          dependencies forever.

Run `cachepilot optimize` to see the recommended cache configuration.
Recommended: include runner OS and lockfile hash in every dependency cache key.
```

Abridged output for [`fixtures/repo/.github/workflows/ci.yml`](fixtures/repo/.github/workflows/ci.yml).

`cachepilot optimize` prints a drop-in replacement for each problem:

```yaml
- uses: actions/cache@v6
  with:
    path: ~/.npm
    key: ${{ runner.os }}-npm-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-npm-
```

## How it works

CachePilot parses every workflow, follows each job step by step, and resolves every `hashFiles()` pattern against the files in your repository using the same glob rules as `@actions/glob`. It knows the cache paths, lockfiles, install commands and built-in caching of **15 ecosystems**: npm, Yarn, pnpm, Bun, pip, Poetry, Pipenv, uv, Maven, Gradle, Go, Cargo, Bundler, Composer and NuGet.

It understands `actions/cache`, `actions/cache/restore`, `actions/cache/save`, and the built-in caches of `actions/setup-node`, `setup-python`, `setup-java`, `setup-go`, `setup-dotnet`, `ruby/setup-ruby`, `astral-sh/setup-uv` and `Swatinem/rust-cache`.

No GitHub token and no network access are needed.

## Install

**Requirements**

- Node.js 18.17 or newer
- git (to install straight from GitHub)
- Windows, macOS or Linux
- No GitHub token or network access needed.

```bash
npx github:6t9xstar/github-actions-cache-optimizer            # run once
npm install -g github:6t9xstar/github-actions-cache-optimizer # installs the cachepilot command
```

## Usage

```bash
cachepilot                                   # scan .github/workflows
cachepilot scan .github/workflows/ci.yml     # one workflow
cachepilot optimize                          # print optimized cache steps
cachepilot --format sarif -o cachepilot.sarif
cachepilot rules
```

| Option | Description |
| --- | --- |
| `--root <dir>` | Repository root used for `hashFiles()` checks (default `.`) |
| `-f, --format` | `text`, `json`, `sarif`, `markdown`, `github` |
| `-o, --output <file>` | Write the report to a file |
| `--fail-on <level>` | `error` (default), `warning`, `info`, `none` |
| `--ignore <ids>` | Skip rules, e.g. `--ignore CP007,CP012` |

## GitHub Action

```yaml
name: Workflow lint
on:
  pull_request:
    paths: ['.github/workflows/**']
jobs:
  cachepilot:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: 6t9xstar/github-actions-cache-optimizer@v1
        with:
          fail-on: warning
```

## Rules

| Rule | Severity | Description |
| --- | --- | --- |
| CP000 | error | Workflow is not valid YAML |
| CP001 | error / warning | Key uses `github.sha`, `run_id`, `run_number`, ... (never an exact hit; churns the 10 GB cache limit) |
| CP002 | warning | Dependency cache key without a lockfile `hashFiles()` (stale forever) |
| CP003 | error | `hashFiles()` pattern matches no file in the repository |
| CP004 | warning | No `restore-keys` |
| CP005 | warning / info | Restore key equal to the key, or not a prefix of it |
| CP006 | warning | Multi-OS matrix but no `runner.os` in the key |
| CP007 | info | Caching `node_modules` instead of the package-manager store |
| CP008 | warning | Same dependencies cached twice in one job |
| CP009 | error / warning / info | Outdated action: `actions/cache` v1–v2 no longer work; Node 16-era majors are deprecated |
| CP010 | error | `setup-*` cache enabled but the required lockfile is missing (with the right `cache-dependency-path`) |
| CP011 | warning | Cache restored after the install step |
| CP012 | info | Dependencies installed without any cache (with a ready-made snippet) |
| CP013 | error | `hashFiles()` with an absolute path or `..` |
| CP014 | error | `actions/cache` missing `path` or `key` |

## FAQ

### Why is my GitHub Actions cache not working?

The most common causes are a key that changes on every run (`github.sha`), a `hashFiles()` pattern that matches no file (it returns an empty string), a cache restored after `npm ci` already ran, or `actions/cache` v1/v2, which stopped working when GitHub retired the legacy cache service. CachePilot checks all of these.

### What is a good actions/cache key?

`${{ runner.os }}-<tool>-${{ hashFiles('<lockfile glob>') }}` with `restore-keys: ${{ runner.os }}-<tool>-`. It produces an exact hit when dependencies are unchanged and a partial hit after a lockfile change.

### Should I cache node_modules?

Usually not. `node_modules` depends on the OS and Node.js version and skips install scripts when restored. Cache `~/.npm` or use `actions/setup-node` with `cache: npm`, and keep running `npm ci`.

### Does CachePilot need my GitHub token?

No. It is a static analyzer and runs completely offline.

## More developer tools

- [WorkflowTriggerDoctor](https://github.com/6t9xstar/workflow-trigger-doctor): why a GitHub Actions workflow did not run
- [PackageProof](https://github.com/6t9xstar/packageproof): detect hallucinated and non-existent npm and PyPI packages
- [PaginationProbe](https://github.com/6t9xstar/pagination-probe): REST API pagination tester
- [GitHookDoctor](https://github.com/6t9xstar/git-hook-doctor): Git hooks, Husky, Lefthook and pre-commit troubleshooter
- [NpmTarballAudit](https://github.com/6t9xstar/npm-tarball-audit): npm package contents and secrets auditor
- [CachePilot](https://github.com/6t9xstar/github-actions-cache-optimizer): GitHub Actions cache analyzer and optimizer
- [ComposeDoctor](https://github.com/6t9xstar/docker-compose-doctor): Docker Compose validator and troubleshooter
- [DevContainer Doctor](https://github.com/6t9xstar/devcontainer-json-validator): devcontainer.json validator
- [OwnerScope](https://github.com/6t9xstar/codeowners-coverage-checker): CODEOWNERS validator and coverage checker
- [ScriptPort](https://github.com/6t9xstar/npm-scripts-cross-platform-checker): cross-platform npm scripts checker

## License

[MIT](LICENSE)
