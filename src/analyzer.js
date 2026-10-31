import fs from 'node:fs';
import path from 'node:path';
import { parseDocument, LineCounter, isMap, isScalar } from 'yaml';
import { ECOSYSTEMS, SETUP_CACHE, MIN_MAJOR, ecosystemForPath, recommendedKey } from './ecosystems.js';
import { listFiles, matchFiles } from './glob.js';

export const RULES = {
  CP000: { name: 'workflow-syntax', severity: 'error', description: 'The workflow file is not valid YAML.' },
  CP001: { name: 'volatile-cache-key', severity: 'error', description: 'The cache key changes on every run (github.sha, run_id, ...), so it never gets an exact hit.' },
  CP002: { name: 'static-cache-key', severity: 'warning', description: 'The cache key has no hashFiles() of a lockfile, so the cache is never invalidated when dependencies change.' },
  CP003: { name: 'hashfiles-no-match', severity: 'error', description: 'A hashFiles() pattern matches no files in the repository, so it evaluates to an empty string.' },
  CP004: { name: 'missing-restore-keys', severity: 'warning', description: 'No restore-keys: every lockfile change causes a full cache miss.' },
  CP005: { name: 'ineffective-restore-key', severity: 'warning', description: 'A restore key is identical to the key or not a prefix of it.' },
  CP006: { name: 'key-missing-os', severity: 'warning', description: 'The job runs on several operating systems but the key does not include runner.os.' },
  CP007: { name: 'caches-node-modules', severity: 'info', description: 'Caching node_modules ties the cache to one OS and Node.js version; cache the package manager store instead.' },
  CP008: { name: 'duplicate-cache', severity: 'warning', description: 'The same dependencies are cached twice in one job.' },
  CP009: { name: 'outdated-action', severity: 'warning', description: 'The action version is deprecated or no longer works.' },
  CP010: { name: 'setup-cache-lockfile-missing', severity: 'error', description: 'A setup-* action has caching enabled but the dependency file it needs does not exist.' },
  CP011: { name: 'cache-after-install', severity: 'warning', description: 'The cache is restored after dependencies were already installed.' },
  CP012: { name: 'no-dependency-cache', severity: 'info', description: 'The job installs dependencies without any cache.' },
  CP013: { name: 'hashfiles-outside-workspace', severity: 'error', description: 'hashFiles() only works for files inside GITHUB_WORKSPACE.' },
  CP014: { name: 'cache-missing-input', severity: 'error', description: 'actions/cache requires both "path" and "key".' },
};

const VOLATILE = /\bgithub\.(sha|run_id|run_number|run_attempt)\b|github\.event\.(head_commit\.id|pull_request\.head\.sha|after)\b/;

/** Expressions inside ${{ }} in a string. */
export function expressions(str) {
  return [...String(str ?? '').matchAll(/\$\{\{\s*([\s\S]*?)\s*\}\}/g)].map((m) => m[1]);
}

/** All argument lists of hashFiles(...) calls in a string. */
export function hashFilesCalls(str) {
  const calls = [];
  for (const m of String(str ?? '').matchAll(/hashFiles\s*\(([^)]*)\)/gi)) {
    calls.push([...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((a) => a[1].replace(/''/g, "'")));
  }
  return calls;
}

export function splitLines(value) {
  if (value === undefined || value === null) return [];
  return String(value)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
}

/** "actions/cache/restore@v4" -> { name: 'actions/cache/restore', ref: 'v4', major: 4 } */
export function parseUses(uses) {
  const m = String(uses).match(/^([^@\s]+)@(\S+)$/);
  if (!m) return { name: String(uses), ref: null, major: null };
  const major = m[2].match(/^v?(\d+)(\.|$)/);
  return { name: m[1].toLowerCase(), ref: m[2], major: major ? Number(major[1]) : null };
}

export function findWorkflowFiles(root, inputs = []) {
  const targets = inputs.length ? inputs : [path.join(root, '.github', 'workflows')];
  const files = [];
  for (const t of targets) {
    const abs = path.resolve(root, t);
    if (!fs.existsSync(abs)) throw new Error(`Path not found: ${t}`);
    if (fs.statSync(abs).isDirectory()) {
      for (const f of fs.readdirSync(abs).sort()) if (/\.ya?ml$/.test(f)) files.push(path.join(abs, f));
    } else files.push(abs);
  }
  return files;
}

/**
 * Analyze workflow files.
 * @param {{root: string, files: string[], repoFiles?: string[], ignore?: Set<string>}} options
 * @returns {{findings: object[], jobs: object[]}}
 */
export function analyze({ root, files, repoFiles, ignore = new Set() }) {
  repoFiles = repoFiles || listFiles(root);
  const lockfilesPresent = new Set();
  // Which JavaScript package manager the repository uses (to classify node_modules caches).
  const NODE_LOCKS = { yarn: 'yarn.lock', pnpm: 'pnpm-lock.yaml', bun: 'bun.lockb' };
  for (const [id, lock] of Object.entries(NODE_LOCKS)) if (repoFiles.some((f) => f === lock || f.endsWith('/' + lock))) lockfilesPresent.add(id);

  const findings = [];
  const jobsOut = [];
  const rel = (f) => path.relative(process.cwd(), f).split(path.sep).join('/') || f;

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const lineCounter = new LineCounter();
    const doc = parseDocument(text, { lineCounter, uniqueKeys: true });
    const lineOf = (at) => locate(doc, lineCounter, at);
    const add = (ruleId, at, message, extra = {}) => {
      if (ignore.has(ruleId)) return;
      findings.push({ ruleId, severity: extra.severity || RULES[ruleId].severity, message, fix: extra.fix, context: extra.context, file: rel(file), line: lineOf(at), suggestion: extra.suggestion });
    };
    if (doc.errors.length) {
      for (const e of doc.errors) findings.push({ ruleId: 'CP000', severity: 'error', message: e.message.split('\n')[0], file: rel(file), line: lineCounter.linePos(e.pos[0]).line });
      continue;
    }
    const wf = doc.toJS() || {};
    const jobs = wf.jobs && typeof wf.jobs === 'object' ? wf.jobs : {};

    for (const [jobId, job] of Object.entries(jobs)) {
      if (!job || !Array.isArray(job.steps)) continue;
      const ctx = `job "${jobId}"`;
      const multiOs = multiOsMatrix(job);
      const caches = [];
      const installs = [];
      let checkoutPath = false;

      job.steps.forEach((step, i) => {
        if (!step || typeof step !== 'object') return;
        const at = ['jobs', jobId, 'steps', i];
        const w = step.with || {};
        if (step.uses) {
          const u = parseUses(step.uses);
          const min = MIN_MAJOR[u.name];
          if (min && u.major !== null) {
            const fix = `${u.name}@v${min.latest}`;
            if (min.error && u.major < min.error) {
              add('CP009', [...at, 'uses'], `${step.uses} no longer works: GitHub shut down the legacy cache service it uses in 2025.`, { severity: 'error', context: ctx, fix });
            } else if (u.major < min.warn) {
              add('CP009', [...at, 'uses'], `${step.uses} runs on a deprecated Node.js runtime.`, { context: ctx, fix });
            } else if (u.major < min.latest) {
              add('CP009', [...at, 'uses'], `${step.uses} is not the latest major version (v${min.latest}).`, { severity: 'info', context: ctx, fix });
            }
          }
          if (u.name === 'actions/checkout' && w.path) checkoutPath = true;

          if (/^actions\/cache(\/restore|\/save)?$/.test(u.name)) {
            const kind = u.name === 'actions/cache' ? 'cache' : u.name.endsWith('restore') ? 'restore' : 'save';
            const paths = splitLines(w.path);
            if (!w.key || (kind !== 'restore' && paths.length === 0) || (kind === 'restore' && paths.length === 0)) {
              add('CP014', at, `${u.name} is missing required input${!w.key && !paths.length ? 's "path" and "key"' : !w.key ? ' "key"' : ' "path"'}.`, { context: ctx });
              return;
            }
            const eco = guessEcosystem(paths, String(w.key), lockfilesPresent);
            caches.push({ index: i, kind, eco, paths, key: String(w.key), restoreKeys: splitLines(w['restore-keys']), at, uses: step.uses, name: step.name });
          } else if (SETUP_CACHE[u.name] && w.cache) {
            const cfg = SETUP_CACHE[u.name][String(w.cache)];
            if (cfg) {
              caches.push({ index: i, kind: 'setup', eco: cfg.eco, at, uses: step.uses });
              const depPath = splitLines(w['cache-dependency-path']);
              const required = depPath.length ? depPath : cfg.files;
              if (!depPath.some((p) => p.includes('${{')) && matchFiles(required, repoFiles).length === 0) {
                const other = Object.entries(SETUP_CACHE[u.name]).find(([, c]) => c !== cfg && matchFiles(c.files, repoFiles).length);
                const nested = depPath.length ? [] : matchFiles(cfg.files.map((f) => (f.startsWith('**/') ? f : `**/${f}`)), repoFiles);
                add('CP010', [...at, 'with', 'cache'], `${u.name} has cache: ${w.cache} but ${required.join(', ')} ${required.length > 1 ? 'match' : 'matches'} no file ${depPath.length ? 'in the repository' : 'at the repository root'}; the step will fail.`, {
                  context: ctx,
                  fix: nested.length
                    ? `cache-dependency-path: ${nested.length === 1 ? nested[0] : cfg.files.map((f) => (f.startsWith('**/') ? f : `**/${f}`))[0]}`
                    : other
                      ? `this repository uses ${other[0]}: set cache: ${other[0]}`
                      : 'commit the lockfile, or set cache-dependency-path to its location',
                });
              }
            }
          } else if (u.name === 'actions/setup-go' && (u.major === null || u.major >= 4) && w.cache !== false && w.cache !== 'false') {
            caches.push({ index: i, kind: 'setup', eco: 'go', at, uses: step.uses });
            const dep = splitLines(w['cache-dependency-path']);
            if (!dep.length && !repoFiles.includes('go.sum') && !ignore.has('CP010')) {
              add('CP010', at, 'actions/setup-go caches by default but there is no go.sum in the repository root, so the cache is never restored.', { severity: 'warning', context: ctx, fix: 'set cache-dependency-path: <dir>/go.sum, or cache: false' });
            }
          } else if (u.name === 'swatinem/rust-cache') {
            caches.push({ index: i, kind: 'setup', eco: 'cargo', at, uses: step.uses });
          } else if (u.name === 'ruby/setup-ruby' && (w['bundler-cache'] === true || w['bundler-cache'] === 'true')) {
            caches.push({ index: i, kind: 'setup', eco: 'bundler', at, uses: step.uses });
          } else if (u.name === 'astral-sh/setup-uv' && (w['enable-cache'] === true || w['enable-cache'] === 'true')) {
            caches.push({ index: i, kind: 'setup', eco: 'uv', at, uses: step.uses });
          } else if (u.name === 'actions/setup-dotnet' && (w.cache === true || w.cache === 'true')) {
            caches.push({ index: i, kind: 'setup', eco: 'nuget', at, uses: step.uses });
          }
        }
        if (step.run) {
          for (const line of String(step.run).split(/\r?\n/)) {
            for (const [id, eco] of Object.entries(ECOSYSTEMS)) {
              if (eco.install.test(line) && !installs.some((x) => x.eco === id)) installs.push({ index: i, eco: id, at, line: line.trim() });
            }
          }
        }
      });

      // Per cache step checks -------------------------------------------
      for (const c of caches.filter((x) => x.kind !== 'setup')) {
        const keyAt = [...c.at, 'with', 'key'];
        const exprs = expressions(c.key).join(' ');
        const hashCalls = hashFilesCalls(c.key);
        const isDependencyCache = Boolean(c.eco);
        const rec = c.eco ? recommendedKey(c.eco) : null;
        const sug = c.eco ? suggestion(c, rec) : null;

        if (VOLATILE.test(exprs)) {
          const restore = c.kind === 'save' || c.restoreKeys.length > 0;
          add('CP001', keyAt, restore
            ? `Cache key uses ${exprs.match(VOLATILE)[0]}: every run saves a new cache entry, which evicts useful caches from the 10 GB repository limit.`
            : `Cache key uses ${exprs.match(VOLATILE)[0]}: the key is new on every run, so the cache is never restored.`, {
            severity: restore ? 'warning' : 'error',
            context: ctx,
            fix: rec ? `key: ${rec.key}` : 'key the cache on the files that determine its content, using hashFiles()',
            suggestion: sug,
          });
        } else if (hashCalls.length === 0 && isDependencyCache && !/steps\.|needs\.|inputs\./.test(exprs)) {
          add('CP002', keyAt, `Missing lockfile hash: key "${c.key}" never changes, so the cache keeps stale ${ECOSYSTEMS[c.eco].label} dependencies forever.`, { context: ctx, fix: `key: ${rec.key}`, suggestion: sug });
        }

        for (const args of hashCalls) {
          const concrete = args.filter((a) => !a.includes('${{'));
          for (const a of concrete) {
            const body = a.replace(/^!/, '');
            if (body.startsWith('/') || /^[A-Za-z]:[\\/]/.test(body) || body.split('/').includes('..')) {
              add('CP013', keyAt, `hashFiles('${a}') points outside the workspace and always returns an empty string.`, { context: ctx, fix: 'use a path relative to the repository root' });
            }
          }
          if (!checkoutPath && concrete.length && concrete.length === args.length && matchFiles(concrete, repoFiles).length === 0 && !concrete.some((a) => a.split('/').includes('..') || a.startsWith('/'))) {
            const hint = c.eco ? ECOSYSTEMS[c.eco].lock.filter((g) => matchFiles([g], repoFiles).length) : [];
            add('CP003', keyAt, `hashFiles(${args.map((a) => `'${a}'`).join(', ')}) matches no files, so it returns '' and the key never changes.`, { context: ctx, fix: hint.length ? `hashFiles(${hint.map((g) => `'${g}'`).join(', ')})` : 'point hashFiles at your lockfile, e.g. **/package-lock.json' });
          }
        }

        if (c.kind !== 'save' && hashCalls.length && c.restoreKeys.length === 0 && !VOLATILE.test(exprs)) {
          add('CP004', keyAt, 'No restore-keys configured: after any lockfile change the job starts from an empty cache.', { context: ctx, fix: `restore-keys: ${rec ? rec.restoreKey : prefixOf(c.key)}`, suggestion: sug });
        }
        c.restoreKeys.forEach((rk) => {
          if (rk === c.key) add('CP005', [...c.at, 'with', 'restore-keys'], `Restore key "${rk}" is identical to the key, so it can never produce a partial match.`, { context: ctx, fix: `restore-keys: ${prefixOf(c.key)}` });
          else if (!c.key.startsWith(rk) && !normalise(c.key).startsWith(normalise(rk))) add('CP005', [...c.at, 'with', 'restore-keys'], `Restore key "${rk}" is not a prefix of the key, so it may restore a cache built from different inputs.`, { context: ctx, severity: 'info', fix: `restore-keys: ${prefixOf(c.key)}` });
        });

        if (multiOs && !/runner\.os|matrix\.(os|platform|runner|runs-on|target)|runner\.arch/.test(exprs) && !/(linux|windows|macos|ubuntu)/i.test(c.key)) {
          add('CP006', keyAt, `Job runs on a ${multiOs} matrix but the key has no runner.os, so Linux, Windows and macOS overwrite each other's caches.`, { context: ctx, fix: `prefix the key with \${{ runner.os }}-` });
        }
        if (c.paths.some((p) => /(^|\/)node_modules\/?$/.test(p))) {
          add('CP007', [...c.at, 'with', 'path'], 'Caching node_modules breaks across Node.js versions and OSes and skips lifecycle scripts.', { context: ctx, fix: `cache ${ECOSYSTEMS[c.eco || 'npm'].cachePath} (or use actions/setup-node with cache: ${c.eco || 'npm'}) and keep running ${c.eco === 'npm' || !c.eco ? 'npm ci' : `${c.eco} install`}` });
        }
      }

      // Cross-step checks ------------------------------------------------
      const restoring = caches.filter((c) => c.kind !== 'save' && c.eco);
      const byEco = new Map();
      for (const c of restoring) {
        const prev = byEco.get(c.eco);
        if (prev) {
          const samePath = prev.kind !== 'setup' && c.kind !== 'setup' ? prev.paths.some((p) => c.paths.includes(p)) : true;
          if (samePath) add('CP008', c.at, `${ECOSYSTEMS[c.eco]?.label || c.eco} dependencies are already cached by step ${prev.index + 1} (${prev.uses}).`, { context: ctx, fix: 'remove one of the two caches' });
        } else byEco.set(c.eco, c);
      }
      for (const inst of installs) {
        const cache = restoring.find((c) => c.eco === inst.eco);
        for (const late of restoring.filter((c) => c.eco === inst.eco && c.kind !== 'setup' && c.index > inst.index)) {
          add('CP011', late.at, `Cache is restored at step ${late.index + 1}, after "${inst.line}" already ran at step ${inst.index + 1}.`, { context: ctx, fix: 'move the cache step before the install step' });
        }
        const anyUnknownCache = caches.some((c) => !c.eco && c.kind !== 'save');
        if (!cache && !anyUnknownCache) {
          add('CP012', inst.at, `"${inst.line}" downloads ${ECOSYSTEMS[inst.eco].label} dependencies on every run without a cache.`, { context: ctx, fix: setupHint(inst.eco), suggestion: jobSuggestion(inst.eco) });
        }
      }
      jobsOut.push({ file: rel(file), job: jobId, caches: caches.map(({ at, ...c }) => c), installs: installs.map(({ at, ...x }) => x) });
    }
  }
  return { findings, jobs: jobsOut };
}

function guessEcosystem(paths, key, lockfilesPresent) {
  for (const p of paths) {
    const eco = ecosystemForPath(p, lockfilesPresent);
    if (eco) return eco;
  }
  for (const [id, eco] of Object.entries(ECOSYSTEMS)) {
    const files = eco.lock.map((g) => g.replace('**/', ''));
    if (hashFilesCalls(key).flat().some((a) => files.some((f) => a.endsWith(f)))) return id;
  }
  return null;
}

function multiOsMatrix(job) {
  const runsOn = JSON.stringify(job['runs-on'] ?? '');
  const ref = runsOn.match(/matrix\.([\w-]+)/);
  if (!ref) return null;
  const matrix = job.strategy?.matrix;
  if (!matrix || typeof matrix !== 'object') return 'matrix';
  const values = new Set();
  if (Array.isArray(matrix[ref[1]])) matrix[ref[1]].forEach((v) => values.add(JSON.stringify(v)));
  if (Array.isArray(matrix.include)) matrix.include.forEach((inc) => inc && inc[ref[1]] !== undefined && values.add(JSON.stringify(inc[ref[1]])));
  if (typeof matrix === 'string' || values.size === 0) return 'dynamic';
  if (values.size < 2) return null;
  const osNames = [...values].map((v) => (/(windows|win)/i.test(v) ? 'windows' : /(mac|osx)/i.test(v) ? 'macos' : 'linux'));
  return new Set(osNames).size > 1 ? 'multi-OS' : null;
}

function prefixOf(key) {
  const i = key.lastIndexOf('${{ hashFiles');
  if (i > 0) return key.slice(0, i);
  const j = key.lastIndexOf('-');
  return j > 0 ? key.slice(0, j + 1) : key;
}

function normalise(s) {
  return s.replace(/\$\{\{\s*/g, '${{ ').replace(/\s*\}\}/g, ' }}');
}

function setupHint(eco) {
  const e = ECOSYSTEMS[eco];
  if (e.setup) return `${e.setup.uses} ${Object.entries(e.setup.with).map(([k, v]) => `${k}: ${v}`).join(', ')}${e.setup.note ? ` (${e.setup.note})` : ''}`;
  return `actions/cache@v6 with path ${e.cachePath.replace(/\n/g, ', ')} and key ${recommendedKey(eco).key}`;
}

function suggestion(c, rec) {
  const e = ECOSYSTEMS[c.eco];
  const paths = c.paths.some((p) => /(^|\/)node_modules\/?$/.test(p)) ? e.cachePath.split('\n') : c.paths;
  return [
    `- uses: actions/cache@v6`,
    `  with:`,
    `    path: ${paths.length > 1 ? '|\n' + paths.map((p) => `      ${p}`).join('\n') : paths[0]}`,
    `    key: ${rec.key}`,
    `    restore-keys: |`,
    `      ${rec.restoreKey}`,
  ].join('\n');
}

export function jobSuggestion(eco) {
  const e = ECOSYSTEMS[eco];
  if (e.setup) {
    const lines = [`- uses: ${e.setup.uses}`];
    const entries = Object.entries(e.setup.with);
    if (entries.length) lines.push('  with:', ...entries.map(([k, v]) => `    ${k}: ${typeof v === 'string' && /[*:]/.test(v) ? `'${v}'` : v}`));
    if (e.setup.note) lines.unshift(`# ${e.setup.note}`);
    return lines.join('\n');
  }
  const rec = recommendedKey(eco);
  const paths = e.cachePath.split('\n');
  return [`- uses: actions/cache@v6`, `  with:`, `    path: ${paths.length > 1 ? '|\n' + paths.map((p) => `      ${p}`).join('\n') : paths[0]}`, `    key: ${rec.key}`, `    restore-keys: |`, `      ${rec.restoreKey}`].join('\n');
}

function locate(doc, lineCounter, at) {
  for (let len = at.length; len >= 0; len--) {
    const sub = at.slice(0, len);
    const node = len === 0 ? doc.contents : doc.getIn(sub, true);
    if (node && node.range) {
      let offset = node.range[0];
      const parent = len === 0 ? null : len === 1 ? doc.contents : doc.getIn(sub.slice(0, -1), true);
      if (parent && isMap(parent)) {
        const pair = parent.items.find((p) => (isScalar(p.key) ? p.key.value : p.key) === sub[len - 1]);
        if (pair?.key?.range) offset = pair.key.range[0];
      }
      return lineCounter.linePos(offset).line;
    }
  }
  return 1;
}
