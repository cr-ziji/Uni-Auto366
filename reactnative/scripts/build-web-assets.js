#!/usr/bin/env node
/**
 * Bundles the Electron web assets into the React Native JS bundle.
 *
 * The desktop app loads `index.html`, `styles/`, `renderer/`, `rulesets/` and
 * `preload/` straight from the file system. React Native has no equivalent of
 * a browsable application directory, so the files are embedded into a single
 * manifest (`src/web-assets/assets.json`) that the local HTTP server reads
 * from memory at runtime.
 *
 * Text payloads are stored as UTF-8, binary payloads as base64, so that the
 * manifest can be consumed with a plain `JSON.parse`.
 *
 * Usage:
 *   node scripts/build-web-assets.js [--source <electron-root>] [--out <file>]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SOURCE = path.resolve(PROJECT_ROOT, '..');
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, 'src', 'web-assets', 'assets.json');

/** Files and directories that are copied verbatim (relative to the source root). */
const ENTRIES = [
  {from: 'index.html', to: 'index.html'},
  {from: 'icon.png', to: 'icon.png'},
  {from: 'icon_black.png', to: 'icon_black.png'},
  {from: 'styles', to: 'styles', dir: true},
  {from: 'renderer', to: 'renderer', dir: true},
  {from: 'rulesets', to: 'rulesets', dir: true},
  {from: 'preload', to: 'preload', dir: true},
  {from: 'resources', to: 'resources', dir: true},
  // The injection progress window is loaded with `BrowserWindow.loadFile()`
  // by `modules/injection/window`. The desktop build reads it straight from
  // the application directory; on mobile the file has to be in the manifest,
  // otherwise the local asset server answers 404 and the window stays blank.
  // `index.js` is deliberately not listed - it is main process code that
  // Metro bundles, not a page asset.
  {
    from: path.join('modules', 'injection', 'window', 'index.html'),
    to: path.join('modules', 'injection', 'window', 'index.html'),
  },
  {
    from: path.join('modules', 'injection', 'window', 'progress.js'),
    to: path.join('modules', 'injection', 'window', 'progress.js'),
  },
  {
    from: path.join('node_modules', 'bootstrap-icons', 'font', 'bootstrap-icons.css'),
    to: path.join('node_modules', 'bootstrap-icons', 'font', 'bootstrap-icons.css'),
  },
  {
    from: path.join('node_modules', 'bootstrap-icons', 'font', 'fonts', 'bootstrap-icons.woff2'),
    to: path.join('node_modules', 'bootstrap-icons', 'font', 'fonts', 'bootstrap-icons.woff2'),
  },
  {
    from: path.join('node_modules', 'bootstrap-icons', 'font', 'fonts', 'bootstrap-icons.woff'),
    to: path.join('node_modules', 'bootstrap-icons', 'font', 'fonts', 'bootstrap-icons.woff'),
  },
];

/**
 * Files inside a copied directory that must not ship to the mobile bundle.
 *
 * `.md` files are NOT excluded: `resources/agreements/privacy.md` and
 * `terms.md` are the actual agreement content the renderer displays.
 */
const EXCLUDED = [
  /\.ps1$/i,
  /\.DS_Store$/i,
];

const TEXT_EXTENSIONS = new Set([
  '.html', '.htm', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json',
  '.css', '.scss', '.svg', '.txt', '.md', '.xml', '.yml', '.yaml', '.map',
  '.webmanifest',
]);

/**
 * Fonts and archives are binary. They used to be listed as text, which
 * silently corrupted them (`bootstrap-icons.woff2` grew from 134012 to
 * 170707 bytes after a UTF-8 round-trip) and made every icon render as a
 * tofu box.
 *
 * `.zip` is listed explicitly because the rule sets ship their implants as
 * ZIP archives (`rulesets/auto-boat/auto-boat.zip`). Those bytes are handed
 * to `node-stream-zip` at runtime, so a UTF-8 round-trip would break every
 * `zip-implant` rule.
 */
const BINARY_EXTENSIONS = new Set(['.woff', '.woff2', '.ttf', '.otf', '.eot', '.zip', '.gz']);

function parseArgs(argv) {
  const options = {source: DEFAULT_SOURCE, out: DEFAULT_OUTPUT};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source' || arg === '-s') {
      options.source = path.resolve(argv[++i] || '');
    } else if (arg === '--out' || arg === '-o') {
      options.out = path.resolve(argv[++i] || '');
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/build-web-assets.js [--source <electron-root>] [--out <file>]\n',
      );
      process.exit(0);
    }
  }
  return options;
}

function isTextFile(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(extension)) {
    return false;
  }
  return TEXT_EXTENSIONS.has(extension);
}

/**
 * `true` when the bytes survive a UTF-8 round-trip unchanged.
 *
 * The manifest stores text as UTF-8, which is only lossless for valid UTF-8.
 * Anything else (an unknown binary extension, a mislabelled file) would be
 * silently mangled, therefore the round-trip is verified for every file.
 */
function isLosslessUtf8(buffer) {
  const text = buffer.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buffer);
}

function isExcluded(relativePath) {
  return EXCLUDED.some(pattern => pattern.test(relativePath));
}

function walk(directory, baseDirectory, files) {
  const entries = fs.readdirSync(directory, {withFileTypes: true});
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(baseDirectory, absolute).split(path.sep).join('/');
    if (isExcluded(relative)) {
      continue;
    }
    if (entry.isDirectory()) {
      walk(absolute, baseDirectory, files);
    } else if (entry.isFile()) {
      files.push({absolute, relative});
    }
  }
}

function collect(source) {
  const files = new Map();
  for (const entry of ENTRIES) {
    const absolute = path.join(source, entry.from);
    if (!fs.existsSync(absolute)) {
      process.stdout.write(`[web-assets] skipped (missing): ${entry.from}\n`);
      continue;
    }
    if (entry.dir) {
      const collected = [];
      walk(absolute, absolute, collected);
      const prefix = entry.to.split(path.sep).join('/');
      for (const file of collected) {
        // Keep the tree layout: `resources/agreements/version.json` must not
        // collapse to `version.json`, otherwise the ported code cannot resolve
        // `<app>/resources/...` or `<app>/rulesets/...` at runtime.
        files.set(`${prefix}/${file.relative}`, file.absolute);
      }
      continue;
    }
    files.set(entry.to.split(path.sep).join('/'), absolute);
  }
  return files;
}

/** Rule fields that may point at a file shipped next to the rule set. */
const RULE_ASSET_FIELDS = ['zipImplant', 'injectScript', 'newContentFile'];

/**
 * The values of a rule that have to be packaged together with its rule set.
 *
 * Remote URLs are downloaded at runtime and absolute paths were picked by the
 * user on the desktop, so neither of them belongs to the bundle. Everything
 * else is resolved relative to the rule set directory
 * (`rulesets/<name>/<reference>`).
 */
function ruleAssetReferences(rule) {
  const values = [];
  for (const field of RULE_ASSET_FIELDS) {
    if (typeof rule[field] === 'string' && rule[field]) {
      values.push(rule[field]);
    }
  }
  if (Array.isArray(rule.injectScripts)) {
    for (const value of rule.injectScripts) {
      if (typeof value === 'string' && value) {
        values.push(value);
      }
    }
  }
  return values.filter(value => !/^https?:/i.test(value) && !path.isAbsolute(value));
}

/**
 * Verifies that every file a rule set references is part of the bundle.
 *
 * The desktop build reads `rulesets/<name>/<file>` straight from the
 * application directory, so a missing file only shows up as a rule that
 * silently never fires. On mobile that directory is the asset manifest: a
 * file that was not packaged can never be read, therefore the gap is
 * reported here instead of at runtime.
 */
function verifyRulesetAssets(source, files) {
  const rulesetsRoot = path.join(source, 'rulesets');
  if (!fs.existsSync(rulesetsRoot)) {
    return {expected: 0, missing: []};
  }

  const missing = [];
  let expected = 0;

  const entries = fs.readdirSync(rulesetsRoot, {withFileTypes: true});
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const rulesPath = path.join(rulesetsRoot, entry.name, `${entry.name}.json`);
    if (!fs.existsSync(rulesPath)) {
      continue;
    }

    let rules;
    try {
      rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    } catch (error) {
      missing.push({ruleset: entry.name, rule: '', reference: `${entry.name}.json`, reason: 'invalid JSON'});
      continue;
    }

    for (const rule of Array.isArray(rules) ? rules : [rules]) {
      if (!rule || typeof rule !== 'object') {
        continue;
      }
      for (const reference of ruleAssetReferences(rule)) {
        expected += 1;
        const bundledName = path.posix.normalize(
          `rulesets/${entry.name}/${reference.split('\\').join('/')}`,
        );
        if (!files.has(bundledName)) {
          missing.push({ruleset: entry.name, rule: rule.name || '', reference});
        }
      }
    }
  }

  return {expected, missing};
}

function build() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(options.source)) {
    throw new Error(`Electron source directory not found: ${options.source}`);
  }

  const files = collect(options.source);
  const rulesetAssets = verifyRulesetAssets(options.source, files);
  const manifest = {generatedAt: new Date().toISOString(), files: {}};
  let rawBytes = 0;
  let binaryFiles = 0;

  for (const name of [...files.keys()].sort()) {
    const absolute = files.get(name);
    const buffer = fs.readFileSync(absolute);
    rawBytes += buffer.length;
    if (isTextFile(name) && isLosslessUtf8(buffer)) {
      manifest.files[name] = {encoding: 'utf8', data: buffer.toString('utf8')};
    } else {
      binaryFiles += 1;
      manifest.files[name] = {encoding: 'base64', data: buffer.toString('base64')};
    }
  }

  fs.mkdirSync(path.dirname(options.out), {recursive: true});
  fs.writeFileSync(options.out, JSON.stringify(manifest), 'utf8');

  // A sibling declaration keeps TypeScript from parsing the multi-megabyte
  // manifest (it would otherwise infer a type for every inlined string).
  const declaration = path.join(
    path.dirname(options.out),
    `${path.basename(options.out)}.d.ts`,
  );
  fs.writeFileSync(
    declaration,
    [
      '/**',
      ' * Generated by scripts/build-web-assets.js - do not edit by hand.',
      ' * The declaration keeps `tsc` from inferring types for the inlined payload.',
      ' */',
      'declare const manifest: {',
      '  generatedAt: string;',
      '  files: Record<string, {encoding: "utf8" | "base64"; data: string}>;',
      '};',
      'export default manifest;',
      '',
    ].join('\n'),
    'utf8',
  );

  const manifestBytes = fs.statSync(options.out).size;
  process.stdout.write(
    `[web-assets] ${files.size} files (${binaryFiles} binary), ${formatBytes(rawBytes)} raw -> ${formatBytes(manifestBytes)} manifest\n`,
  );
  process.stdout.write(`[web-assets] written to ${options.out}\n`);

  if (rulesetAssets.expected > 0) {
    const packaged = rulesetAssets.expected - rulesetAssets.missing.length;
    process.stdout.write(
      `[web-assets] rule set assets: ${packaged}/${rulesetAssets.expected} packaged\n`,
    );
  }
  for (const entry of rulesetAssets.missing) {
    const target = entry.rule ? ` (rule "${entry.rule}")` : '';
    process.stdout.write(
      `[web-assets] warning: rule set "${entry.ruleset}" references a file that is not packaged: ` +
        `${entry.reference}${target}\n`,
    );
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

try {
  build();
} catch (error) {
  process.stderr.write(`[web-assets] failed: ${error && error.message ? error.message : error}\n`);
  process.exit(1);
}
