#!/usr/bin/env node
/**
 * Bundles the Electron web assets into the React Native JS bundle.
 *
 * The desktop app loads `index.html`, `styles/`, `renderer/`, `rulesets/` and
 * `preload/` straight from the file system. React Native has no equivalent of
 * a browsable application directory, so the files are embedded into the bundle
 * that the local HTTP server reads from memory at runtime.
 *
 * Two artifacts are produced:
 *
 *  - `index.json`   every path plus its size and whether it is binary. A few
 *                   kilobytes, so the start-up path can parse it eagerly.
 *  - `payload.json` one deflate+base64 blob holding all the file contents.
 *
 * The split matters: the payload used to be a single 2.4 MB JSON module, and
 * Hermes parsed/allocated all of it on the first `require` - during start-up,
 * before the first page request could be served. Now the payload is only
 * decoded on the first *content* request, and it is ~2x smaller on the wire
 * because it is deflated.
 *
 * Usage:
 *   node scripts/build-web-assets.js [--source <electron-root>] [--out-dir <dir>]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SOURCE = path.resolve(PROJECT_ROOT, '..');
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, 'src', 'web-assets');

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
  // The legacy `.woff` is a fallback for browsers older than 2016. The
  // WebView ships woff2 support, and the file is 235 KB of the payload.
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

/**
 * Directories whose content is only usable by the desktop runtime.
 *
 * `resources/` used to be copied wholesale, which pulled 107 MB into
 * `assets.json` (143 MB after base64/JSON escaping). The manifest is a plain
 * JS module, so the whole payload had to be parsed by Hermes on the first
 * `require` - that alone accounted for most of the startup delay, and none of
 * these files can even be executed on a phone:
 *
 *  - `resources/tts`         sherpa-onnx models (a 41 MB `model.onnx`) that
 *                            `modules/tts` loads through `child_process.fork()`.
 *  - `resources/tun`         `mihomo-windows-amd64-compatible.exe` + `wintun.dll`.
 *  - `resources/openspeedy`  Windows PE injector (`*.exe` / `*.dll`) + sources.
 *
 * The renderer only ever references the images in `resources/` (`qq.jpg`,
 * `*_prize.jpg`) and `resources/agreements/`, so nothing that is left out is
 * reachable from a page.
 */
const DESKTOP_ONLY_DIRECTORIES = [
  'resources/tts/',
  'resources/tun/',
  'resources/openspeedy/',
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
  const options = {source: DEFAULT_SOURCE, outDir: DEFAULT_OUTPUT_DIR};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source' || arg === '-s') {
      options.source = path.resolve(argv[++i] || '');
    } else if (arg === '--out-dir' || arg === '-o') {
      options.outDir = path.resolve(argv[++i] || '');
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/build-web-assets.js [--source <electron-root>] [--out-dir <dir>]\n',
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
  if (EXCLUDED.some(pattern => pattern.test(relativePath))) {
    return true;
  }
  const lower = relativePath.toLowerCase();
  return DESKTOP_ONLY_DIRECTORIES.some(directory => lower.startsWith(directory));
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

/**
 * Resolves a verbatim entry against the desktop project, then against this
 * repository.
 *
 * The desktop tree is not necessarily installed (`node_modules` missing) while
 * the mobile build still needs `bootstrap-icons` for the icon font: without it
 * every `<i class="bi ...">` in the renderer renders an empty box. The mobile
 * repository declares the same package for that reason, so a missing desktop
 * copy falls back to `reactnative/node_modules`.
 */
function resolveEntry(entry, source) {
  const absolute = path.join(source, entry.from);
  if (fs.existsSync(absolute) || entry.dir) {
    return absolute;
  }
  const local = path.join(PROJECT_ROOT, entry.from);
  return fs.existsSync(local) ? local : absolute;
}

function collect(source) {
  const files = new Map();
  for (const entry of ENTRIES) {
    const absolute = resolveEntry(entry, source);
    if (!fs.existsSync(absolute)) {
      process.stdout.write(`[web-assets] skipped (missing): ${entry.from}\n`);
      continue;
    }
    if (entry.dir) {
      const collected = [];
      // Walk relative to the *source root* rather than the entry directory.
      // Otherwise `resources/tts/model.onnx` is seen as `tts/model.onnx` and
      // the desktop-only directory rules can never match it.
      walk(absolute, source, collected);
      const prefix = entry.to.split(path.sep).join('/');
      for (const file of collected) {
        // Keep the tree layout: `resources/agreements/version.json` must not
        // collapse to `version.json`, otherwise the ported code cannot resolve
        // `<app>/resources/...` or `<app>/rulesets/...` at runtime.
        const key =
          entry.from === entry.to
            ? file.relative
            : `${prefix}/${path
                .relative(absolute, file.absolute)
                .split(path.sep)
                .join('/')}`;
        files.set(key, file.absolute);
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
  const index = {generatedAt: new Date().toISOString(), files: {}};
  const payload = {};
  let rawBytes = 0;
  let binaryFiles = 0;

  for (const name of [...files.keys()].sort()) {
    const absolute = files.get(name);
    const buffer = fs.readFileSync(absolute);
    rawBytes += buffer.length;
    const binary = !(isTextFile(name) && isLosslessUtf8(buffer));
    // `[size, binary]` keeps the index tiny: it is parsed on every start-up.
    index.files[name] = [buffer.length, binary ? 1 : 0];
    if (binary) {
      binaryFiles += 1;
      payload[name] = buffer.toString('base64');
    } else {
      payload[name] = buffer.toString('utf8');
    }
  }

  fs.mkdirSync(options.outDir, {recursive: true});
  const indexPath = path.join(options.outDir, 'index.json');
  const payloadPath = path.join(options.outDir, 'payload.json');
  fs.writeFileSync(indexPath, JSON.stringify(index), 'utf8');

  // 文件内容压缩成一个字符串：Hermes 解析 1.4 MB 的字面量比解析 2.4 MB 的
  // 对象字面量便宜得多（后者要为每个字符串建对象属性），deflate 之后体积
  // 也小一半。
  const serialized = JSON.stringify(payload);
  const deflated = zlib.deflateRawSync(Buffer.from(serialized, 'utf8'), {level: 9});
  fs.writeFileSync(
    payloadPath,
    JSON.stringify({data: deflated.toString('base64')}),
    'utf8',
  );

  // Sibling declarations keep TypeScript from inferring a type for the payload.
  fs.writeFileSync(
    path.join(options.outDir, 'index.json.d.ts'),
    [
      '/**',
      ' * Generated by scripts/build-web-assets.js - do not edit by hand.',
      ' */',
      'declare const index: {',
      '  generatedAt: string;',
      '  files: Record<string, [number, 0 | 1]>;',
      '};',
      'export default index;',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(options.outDir, 'payload.json.d.ts'),
    [
      '/**',
      ' * Generated by scripts/build-web-assets.js - do not edit by hand.',
      ' */',
      'declare const payload: {data: string};',
      'export default payload;',
      '',
    ].join('\n'),
    'utf8',
  );

  const manifestBytes = fs.statSync(indexPath).size;
  const payloadBytes = fs.statSync(payloadPath).size;
  process.stdout.write(
    `[web-assets] ${files.size} files (${binaryFiles} binary), ${formatBytes(rawBytes)} raw -> ` +
      `${formatBytes(manifestBytes)} index + ${formatBytes(payloadBytes)} payload\n`,
  );
  process.stdout.write(`[web-assets] written to ${options.outDir}\n`);

  const skipped = desktopOnlyBytes(options.source);
  if (skipped > 0) {
    process.stdout.write(
      `[web-assets] kept out of the bundle: ${formatBytes(skipped)} ` +
        `(${DESKTOP_ONLY_DIRECTORIES.map(d => d.replace(/\/$/, '')).join(', ')})\n`,
    );
  }

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

/** Sums the size of the desktop-only directories, for the summary line. */
function desktopOnlyBytes(source) {
  let total = 0;
  for (const directory of DESKTOP_ONLY_DIRECTORIES) {
    const absolute = path.join(source, directory);
    if (!fs.existsSync(absolute)) {
      continue;
    }
    const stack = [absolute];
    while (stack.length > 0) {
      const current = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(current, {withFileTypes: true});
      } catch {
        continue;
      }
      for (const entry of entries) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(entryPath);
        } else if (entry.isFile()) {
          try {
            total += fs.statSync(entryPath).size;
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  return total;
}

try {
  build();
} catch (error) {
  process.stderr.write(`[web-assets] failed: ${error && error.message ? error.message : error}\n`);
  process.exit(1);
}
