import fs from 'node:fs';
import path from 'node:path';

// Glob matching compatible with the subset of @actions/glob that hashFiles()
// uses: *, ?, **, [abc], {a,b}, leading ! for exclusion, dotfiles included,
// and a pattern that matches a directory includes every file below it.

export function expandBraces(pattern) {
  const m = pattern.match(/\{([^{}]*)\}/);
  if (!m) return [pattern];
  return m[1].split(',').flatMap((alt) => expandBraces(pattern.slice(0, m.index) + alt + pattern.slice(m.index + m[0].length)));
}

export function globToRegExp(pattern) {
  let p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '^';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        const atStart = i === 0 || p[i - 1] === '/';
        if (atStart && p[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const end = p.indexOf(']', i + 1);
      if (end === -1) {
        re += '\\[';
      } else {
        let cls = p.slice(i + 1, end);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        re += `[${cls.replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else {
      re += c.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  return new RegExp(re.replace(/\/$/, '') + '$');
}

/** Match a list of hashFiles-style patterns (in order, ! excludes) against files. */
export function matchFiles(patterns, files) {
  const compiled = patterns
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const negate = p.startsWith('!');
      const body = negate ? p.slice(1) : p;
      return { negate, regexes: expandBraces(body).map(globToRegExp) };
    });
  return files.filter((file) => {
    let included = false;
    for (const { negate, regexes } of compiled) {
      if (regexes.some((re) => matchesPathOrAncestor(re, file))) included = !negate;
    }
    return included;
  });
}

function matchesPathOrAncestor(re, file) {
  if (re.test(file)) return true;
  let dir = file;
  for (let i = dir.lastIndexOf('/'); i > 0; i = dir.lastIndexOf('/')) {
    dir = dir.slice(0, i);
    if (re.test(dir)) return true;
  }
  return false;
}

const SKIP = new Set(['.git', 'node_modules']);

/** List repository files (posix paths, relative to root). */
export function listFiles(root, limit = 200000) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (SKIP.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out.push(r);
    }
  };
  walk(root, '');
  return out;
}
