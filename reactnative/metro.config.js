/**
 * E2RN Metro config for Auto366.
 *
 * Responsibilities (mirrors the reference E2RN host):
 *  1. Watch the ORIGINAL, UNMODIFIED Electron project (`..`) so `main.js` and
 *     `modules/**` can be bundled as-is (non-intrusive conversion).
 *  2. ModuleMapper: `electron` -> in-process shim, Node builtins -> polyfills
 *     (`src/polyfills/node/*`), desktop-only npm packages -> stubs or shims
 *     (`src/stubs/*`).
 *  3. Keep the heavy desktop `node_modules` out of the resolver.
 */
const path = require('node:path');
const fs = require('node:fs');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const r = p => path.resolve(__dirname, p);
const poly = p => r(`src/polyfills/node/${p}`);
const stub = p => r(`src/stubs/${p}`);

/**
 * Builtin / package name -> implementation.
 * A value containing a path separator is an absolute path to our own module,
 * otherwise it is an npm package that must live in the RN project's node_modules.
 */
const builtins = {
  // --- Node builtins -------------------------------------------------------
  path: 'path-browserify',
  os: poly('os.ts'),
  events: 'events',
  buffer: 'buffer',
  stream: 'stream-browserify',
  util: poly('util.ts'),
  url: poly('url.ts'),
  querystring: 'querystring-es3',
  assert: 'assert',
  string_decoder: 'string_decoder',
  timers: poly('timers.ts'),
  crypto: poly('crypto.ts'),
  fs: poly('fs.ts'),
  'fs/promises': poly('fs.ts'),
  'original-fs': poly('fs.ts'),
  http: poly('http.ts'),
  https: poly('https.ts'),
  net: poly('net.ts'),
  zlib: poly('zlib.ts'),
  child_process: poly('child_process.ts'),
  process: 'process',
  console: poly('console.ts'),
  // --- desktop-only npm packages ------------------------------------------
  'fs-extra': poly('fs-extra.ts'),
  uuid: poly('uuid.ts'),
  'node-stream-zip': poly('node-stream-zip.ts'),
  archiver: poly('archiver.ts'),
  'stream/promises': poly('stream-promises.ts'),
  'http-mitm-proxy': stub('http-mitm-proxy.ts'),
  'electron-updater': stub('electron-updater.ts'),
  'posthog-node': stub('posthog-node.ts'),
  '@supabase/supabase-js': stub('supabase.ts'),
  'sherpa-onnx-node': stub('sherpa-onnx.ts'),
};

const extraNodeModules = {
  // Point at the DIRECTORY so Metro resolves `index.ts` inside it, exactly
  // like the reference E2RN host does.
  electron: r('src/shims/electron'),
  '@e2rn/electron': r('src/shims/electron'),
  // The Babel preset injects helpers (`@babel/runtime/helpers/...`) into the
  // ORIGINAL sources. Those files live outside the React Native project, so
  // Metro cannot find the package in one of their parent `node_modules`
  // folders - it has to be mapped explicitly.
  '@babel/runtime': path.join(__dirname, 'node_modules', '@babel', 'runtime'),
  'regenerator-runtime': path.join(__dirname, 'node_modules', 'regenerator-runtime'),
};
for (const [name, impl] of Object.entries(builtins)) {
  const isPath = impl.includes('/') || impl.includes('\\');
  let target = impl;
  if (!isPath) {
    // `require.resolve` would hit Node's builtin for names like `assert`, so
    // point straight at the npm package directory of the RN host.
    const pkgDir = path.join(__dirname, 'node_modules', impl);
    if (fs.existsSync(pkgDir)) {
      target = pkgDir;
    }
  }
  extraNodeModules[name] = target;
  extraNodeModules[`node:${name}`] = target;
}

const electronRoot = r('..');
const escape = p => p.replace(/[\\/]/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const blockDir = rel => new RegExp('^' + escape(path.join(electronRoot, rel)) + '(?:/|$)');

const config = {
  // The original Electron project is bundled as-is.
  watchFolders: [electronRoot],
  transformer: {
    // Metro's RN preset defaults to `inlineRequires: true`, which defers a
    // `require()` to the first point of USE. The desktop modules rely on
    // module side effects happening at import time (e.g. `Object.assign` of
    // mixin methods, `require('./register').forModule(...)` registrations), so
    // faithful CommonJS evaluation order is required.
    getTransformOptions: async () => ({
      transform: {inlineRequires: false},
    }),
  },
  resolver: {
    // The desktop `node_modules` holds hundreds of desktop-only packages
    // (native addons, electron-builder, ...). Everything the app needs is
    // mapped explicitly above, so keep the resolver out of that tree.
    blockList: [
      blockDir('node_modules'),
      blockDir('.git'),
    ],
    extraNodeModules,
    sourceExts: ['ts', 'tsx', 'js', 'jsx', 'json', 'cjs', 'mjs'],
    resolveRequest: (context, moduleName, platform) => {
      // Strip Node's "node:" prefix ("node:path" -> "path").
      const request = moduleName.startsWith('node:') ? moduleName.slice(5) : moduleName;
      const mapped = builtins[request];
      if (mapped) {
        const target =
          mapped.includes('/') || mapped.includes('\\')
            ? mapped
            : path.join(__dirname, 'node_modules', mapped);
        try {
          return context.resolveRequest(context, target, platform);
        } catch {
          /* fall through to default resolution */
        }
      }
      return context.resolveRequest(context, request, platform);
    },
  },
};

module.exports = (async () => {
  const defaultConfig = await getDefaultConfig(__dirname);
  return mergeConfig(defaultConfig, config);
})();
