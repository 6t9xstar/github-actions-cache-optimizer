// What CachePilot knows about each package manager: where it caches,
// which lockfile should drive the key, how installs look in `run:` steps and
// which setup action offers built-in caching.

export const ECOSYSTEMS = {
  npm: {
    label: 'npm',
    paths: [/^~\/\.npm\/?$/, /(^|\/)node_modules\/?$/, /\.npm\/_cacache/],
    lock: ["**/package-lock.json"],
    install: /(^|[\s;&|(])npm\s+(ci|install|i)(\s|$)/,
    cachePath: '~/.npm',
    setup: { uses: 'actions/setup-node@v7', with: { 'node-version': 'lts/*', cache: 'npm' } },
  },
  yarn: {
    label: 'Yarn',
    paths: [/\.yarn\/cache\/?$/, /\.cache\/yarn/, /Yarn\/Cache/i, /yarn-cache/],
    lock: ['**/yarn.lock'],
    install: /(^|[\s;&|(])yarn(\s+install)?(\s+--[\w-]+)*\s*($|&&|;|\|)/,
    cachePath: '.yarn/cache',
    setup: { uses: 'actions/setup-node@v7', with: { 'node-version': 'lts/*', cache: 'yarn' } },
  },
  pnpm: {
    label: 'pnpm',
    paths: [/pnpm-store/, /pnpm\/store/, /\.pnpm-store/],
    lock: ['**/pnpm-lock.yaml'],
    install: /(^|[\s;&|(])pnpm\s+(install|i)(\s|$)/,
    cachePath: '~/.local/share/pnpm/store',
    setup: { uses: 'actions/setup-node@v7', with: { 'node-version': 'lts/*', cache: 'pnpm' }, note: 'run pnpm/action-setup@v6 before actions/setup-node' },
  },
  bun: {
    label: 'Bun',
    paths: [/\.bun\/install\/cache/],
    lock: ['**/bun.lockb', '**/bun.lock'],
    install: /(^|[\s;&|(])bun\s+(install|i)(\s|$)/,
    cachePath: '~/.bun/install/cache',
  },
  pip: {
    label: 'pip',
    paths: [/\.cache\/pip/, /pip\/Cache/i, /Caches\/pip/],
    lock: ['**/requirements*.txt', '**/pyproject.toml'],
    install: /(^|[\s;&|(])(pip3?|python3? -m pip)\s+install(\s|$)/,
    cachePath: '~/.cache/pip',
    setup: { uses: 'actions/setup-python@v7', with: { 'python-version': '3.x', cache: 'pip' } },
  },
  poetry: {
    label: 'Poetry',
    paths: [/pypoetry/],
    lock: ['**/poetry.lock'],
    install: /(^|[\s;&|(])poetry\s+install(\s|$)/,
    cachePath: '~/.cache/pypoetry',
    setup: { uses: 'actions/setup-python@v7', with: { 'python-version': '3.x', cache: 'poetry' }, note: 'install Poetry (pipx install poetry) before actions/setup-python' },
  },
  pipenv: {
    label: 'Pipenv',
    paths: [/\.local\/share\/virtualenvs/],
    lock: ['**/Pipfile.lock'],
    install: /(^|[\s;&|(])pipenv\s+(install|sync)(\s|$)/,
    cachePath: '~/.local/share/virtualenvs',
    setup: { uses: 'actions/setup-python@v7', with: { 'python-version': '3.x', cache: 'pipenv' } },
  },
  uv: {
    label: 'uv',
    paths: [/\.cache\/uv/],
    lock: ['**/uv.lock'],
    install: /(^|[\s;&|(])uv\s+(sync|pip\s+install)(\s|$)/,
    cachePath: '~/.cache/uv',
    setup: { uses: 'astral-sh/setup-uv@v10', with: { 'enable-cache': true } },
  },
  maven: {
    label: 'Maven',
    paths: [/\.m2(\/repository)?\/?$/],
    lock: ['**/pom.xml'],
    install: /(^|[\s;&|(])(mvn|\.\/mvnw)(\s|$)/,
    cachePath: '~/.m2/repository',
    setup: { uses: 'actions/setup-java@v6', with: { distribution: 'temurin', 'java-version': '21', cache: 'maven' } },
  },
  gradle: {
    label: 'Gradle',
    paths: [/\.gradle\/(caches|wrapper)/],
    lock: ['**/*.gradle*', '**/gradle-wrapper.properties'],
    install: /(^|[\s;&|(])(gradle|\.\/gradlew)(\s|$)/,
    cachePath: '~/.gradle/caches\n~/.gradle/wrapper',
    setup: { uses: 'actions/setup-java@v6', with: { distribution: 'temurin', 'java-version': '21', cache: 'gradle' } },
  },
  go: {
    label: 'Go',
    paths: [/go\/pkg\/mod/, /\.cache\/go-build/, /go-build/],
    lock: ['**/go.sum'],
    install: /(^|[\s;&|(])go\s+(build|test|mod\s+download|install|vet|run)(\s|$)/,
    cachePath: '~/go/pkg/mod\n~/.cache/go-build',
    setup: { uses: 'actions/setup-go@v7', with: { 'go-version-file': 'go.mod' }, note: 'actions/setup-go caches automatically' },
  },
  cargo: {
    label: 'Cargo',
    paths: [/\.cargo\/(registry|git)/, /(^|\/)target\/?$/],
    lock: ['**/Cargo.lock'],
    install: /(^|[\s;&|(])cargo\s+(build|test|check|clippy|install|run|fetch)(\s|$)/,
    cachePath: '~/.cargo/registry\n~/.cargo/git\ntarget',
    setup: { uses: 'Swatinem/rust-cache@v2', with: {} },
  },
  bundler: {
    label: 'Bundler',
    paths: [/vendor\/bundle/],
    lock: ['**/Gemfile.lock'],
    install: /(^|[\s;&|(])bundle\s+install(\s|$)/,
    cachePath: 'vendor/bundle',
    setup: { uses: 'ruby/setup-ruby@v1', with: { 'bundler-cache': true } },
  },
  composer: {
    label: 'Composer',
    paths: [/composer\/cache/, /\.composer\/cache/, /(^|\/)vendor\/?$/],
    lock: ['**/composer.lock'],
    install: /(^|[\s;&|(])composer\s+(install|update)(\s|$)/,
    cachePath: '~/.cache/composer',
  },
  nuget: {
    label: 'NuGet',
    paths: [/\.nuget\/packages/],
    lock: ['**/packages.lock.json'],
    install: /(^|[\s;&|(])dotnet\s+(restore|build|test)(\s|$)/,
    cachePath: '~/.nuget/packages',
    setup: { uses: 'actions/setup-dotnet@v6', with: { 'dotnet-version': '8.0.x', cache: true }, note: 'requires packages.lock.json (RestorePackagesWithLockFile)' },
  },
};

// setup-* `cache:` values -> ecosystem + the files the action requires.
export const SETUP_CACHE = {
  'actions/setup-node': {
    npm: { eco: 'npm', files: ['package-lock.json', 'npm-shrinkwrap.json'] },
    yarn: { eco: 'yarn', files: ['yarn.lock'] },
    pnpm: { eco: 'pnpm', files: ['pnpm-lock.yaml'] },
  },
  'actions/setup-python': {
    pip: { eco: 'pip', files: ['**/requirements.txt', '**/pyproject.toml'] },
    pipenv: { eco: 'pipenv', files: ['**/Pipfile.lock'] },
    poetry: { eco: 'poetry', files: ['**/poetry.lock'] },
  },
  'actions/setup-java': {
    maven: { eco: 'maven', files: ['**/pom.xml'] },
    gradle: { eco: 'gradle', files: ['**/*.gradle*', '**/gradle-wrapper.properties', 'buildSrc/**/Versions.kt', 'buildSrc/**/Dependencies.kt', 'gradle/*.versions.toml', '**/versions.properties'] },
    sbt: { eco: 'sbt', files: ['**/*.sbt', '**/project/build.properties', '**/project/**.scala', '**/project/**.sbt'] },
  },
};

// Version policy per action (checked against releases in October 2026):
// below `error` the action no longer works, below `warn` it runs on a
// deprecated Node.js runtime (Node 16 or older), below `latest` a newer
// major exists.
export const MIN_MAJOR = {
  'actions/cache': { error: 3, warn: 4, latest: 6 },
  'actions/cache/restore': { error: 3, warn: 4, latest: 6 },
  'actions/cache/save': { error: 3, warn: 4, latest: 6 },
  'actions/checkout': { warn: 4, latest: 7 },
  'actions/setup-node': { warn: 4, latest: 7 },
  'actions/setup-python': { warn: 5, latest: 7 },
  'actions/setup-java': { warn: 4, latest: 6 },
  'actions/setup-go': { warn: 5, latest: 7 },
  'actions/setup-dotnet': { warn: 4, latest: 6 },
};

export function ecosystemForPath(p, lockfilesPresent) {
  if (/(^|\/)node_modules\/?$/.test(p)) {
    if (lockfilesPresent.has('pnpm')) return 'pnpm';
    if (lockfilesPresent.has('yarn')) return 'yarn';
    if (lockfilesPresent.has('bun')) return 'bun';
    return 'npm';
  }
  for (const [id, eco] of Object.entries(ECOSYSTEMS)) {
    if (eco.paths.some((re) => re.test(p))) return id;
  }
  return null;
}

export function recommendedKey(ecoId, lockGlobs) {
  const globs = (lockGlobs && lockGlobs.length ? lockGlobs : ECOSYSTEMS[ecoId]?.lock || []).map((g) => `'${g}'`).join(', ');
  return {
    key: `\${{ runner.os }}-${ecoId}-\${{ hashFiles(${globs}) }}`,
    restoreKey: `\${{ runner.os }}-${ecoId}-`,
  };
}
