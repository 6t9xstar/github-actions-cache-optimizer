import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { analyze, findWorkflowFiles, RULES } from './analyzer.js';
import * as R from './reporters.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const TOOL = { name: 'CachePilot', version: pkg.version, uri: 'https://github.com/6t9xstar/github-actions-cache-optimizer' };

const HELP = `CachePilot ${pkg.version} - GitHub Actions cache analyzer and optimizer

Usage
  cachepilot scan [paths...]       Analyze workflows (default: .github/workflows)
  cachepilot optimize [paths...]   Print optimized cache configuration for each problem
  cachepilot rules                 List all rules

Options
      --root <dir>         Repository root used for hashFiles() checks (default: .)
  -f, --format <fmt>       text | json | sarif | markdown | github   (default: text)
  -o, --output <file>      Write the report to a file
      --fail-on <level>    error | warning | info | none             (default: error)
      --ignore <ids>       Comma-separated rule ids to skip, e.g. CP007,CP012
      --no-color           Disable colors
  -h, --help / -v, --version

Exit codes: 0 = ok, 1 = findings at or above --fail-on, 2 = usage error

Docs: ${TOOL.uri}`;

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        root: { type: 'string', default: '.' },
        format: { type: 'string', short: 'f', default: 'text' },
        output: { type: 'string', short: 'o' },
        'fail-on': { type: 'string', default: 'error' },
        ignore: { type: 'string', default: '' },
        'no-color': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (err) {
    return usage(err.message);
  }
  const { values: opts, positionals } = parsed;
  if (opts.version) return print(pkg.version), 0;
  if (opts.help) return print(HELP), 0;
  const command = ['scan', 'optimize', 'rules'].includes(positionals[0]) ? positionals.shift() : 'scan';
  if (!R.FORMATS.includes(opts.format)) return usage(`Unknown format "${opts.format}"`);
  if (!['error', 'warning', 'info', 'none'].includes(opts['fail-on'])) return usage(`Unknown --fail-on level "${opts['fail-on']}"`);
  const c = R.colors(R.shouldUseColor(opts['no-color'] ? false : undefined));

  if (command === 'rules') {
    for (const [id, r] of Object.entries(RULES)) print(`${c.bold(id)} ${r.name} ${c.gray(`(${r.severity})`)}\n    ${r.description}`);
    return 0;
  }

  const root = path.resolve(opts.root);
  let files;
  try {
    files = findWorkflowFiles(root, positionals.map((p) => path.resolve(p)));
  } catch (err) {
    return usage(err.message);
  }
  if (!files.length) return usage(`No workflow files found${positionals.length ? '' : ' in .github/workflows'}`);

  const ignore = new Set(opts.ignore.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
  const { findings, jobs } = analyze({ root, files, ignore });

  const out = command === 'optimize' && opts.format === 'text' ? renderOptimize(findings, jobs, c) : render(findings, jobs, opts.format, c);
  if (opts.output) fs.writeFileSync(opts.output, out + '\n');
  else print(out);
  return findings.some((f) => opts['fail-on'] !== 'none' && R.atLeast(f.severity, opts['fail-on'])) ? 1 : 0;
}

function render(findings, jobs, format, c) {
  switch (format) {
    case 'json':
      return R.renderJson(findings, { tool: TOOL, extra: { jobs } });
    case 'sarif':
      return R.renderSarif(findings, { tool: TOOL, rules: RULES });
    case 'markdown':
      return R.renderMarkdown(findings, { tool: TOOL, title: 'CachePilot Report' });
    case 'github':
      return R.renderGithub(findings) || '::notice title=CachePilot::No cache issues found';
  }
  const cacheCount = jobs.reduce((n, j) => n + j.caches.length, 0);
  const lines = [c.bold('CACHEPILOT REPORT'), c.gray(`${new Set(jobs.map((j) => j.file)).size} workflows · ${jobs.length} jobs · ${cacheCount} cache steps`), ''];
  for (const f of R.sortFindings(findings)) {
    lines.push(`${R.severityLabel(f.severity, c)} ${f.context ? c.bold(f.context) + ' ' : ''}${f.message}`);
    lines.push(c.gray(`          ${f.ruleId} ${f.file}:${f.line}`) + (f.fix ? `  ${c.cyan('Fix:')} ${f.fix}` : ''));
  }
  const s = R.countBySeverity(findings);
  lines.push('');
  if (!findings.length) lines.push(c.green('✔ No cache issues found.'));
  else {
    lines.push(`${findings.length} findings (${s.error} errors, ${s.warning} warnings, ${s.info} info).`);
    if (findings.some((f) => f.suggestion)) lines.push(c.cyan('Run `cachepilot optimize` to see the recommended cache configuration.'), c.gray('Recommended: include runner OS and lockfile hash in every dependency cache key.'));
  }
  return lines.join('\n');
}

function renderOptimize(findings, jobs, c) {
  const lines = [c.bold('CACHEPILOT OPTIMIZE'), ''];
  const withSuggestion = R.sortFindings(findings).filter((f) => f.suggestion);
  const seen = new Set();
  for (const f of withSuggestion) {
    const key = `${f.file}:${f.context}:${f.suggestion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reasons = findings.filter((g) => g.file === f.file && g.context === f.context && g.suggestion === f.suggestion).map((g) => g.ruleId);
    lines.push(`${c.bold(`${f.file}:${f.line}`)} ${f.context || ''} ${c.gray(`(${[...new Set(reasons)].join(', ')})`)}`);
    lines.push(c.green(f.suggestion.split('\n').map((l) => `    ${l}`).join('\n')), '');
  }
  const manual = findings.filter((f) => !f.suggestion && f.fix);
  if (manual.length) {
    lines.push(c.bold('Other changes'));
    for (const f of R.sortFindings(manual)) lines.push(`  ${f.file}:${f.line} ${f.context || ''} ${c.gray(f.ruleId)}\n    ${f.fix}`);
  }
  if (!withSuggestion.length && !manual.length) lines.push(c.green(`✔ ${jobs.length} jobs already use well-formed caches.`));
  return lines.join('\n');
}

function usage(message) {
  console.error(`cachepilot: ${message}\nRun "cachepilot --help" for usage.`);
  return 2;
}

function print(s) {
  process.stdout.write(s + '\n');
}
