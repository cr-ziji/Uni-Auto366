/**
 * E2RN Babel config for Auto366.
 *
 * The ModuleMapper stage lives here (with a matching `metro.config.js`):
 *  - `electron` / `@e2rn/electron` -> the in-process Electron runtime shim
 *  - desktop-only npm packages    -> explicit stubs / shims
 *  - `__dirname` / `__filename`   -> virtual paths under `/app`
 *
 * Pure-JS builtins are mapped in `metro.config.js` (`extraNodeModules`) instead
 * of here: aliasing them in Babel risks self-referential resolution when the
 * polyfill packages import the very same specifier.
 */
const path = require('node:path');

const r = p => path.resolve(__dirname, p);

module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // Virtual `__dirname` / `__filename` for the bundled Electron main process.
    ['./babel-plugin-e2rn-dirname.js'],
    ['@babel/plugin-transform-export-namespace-from'],
    [
      'module-resolver',
      {
        root: ['.'],
        extensions: ['.js', '.jsx', '.ts', '.tsx', '.json'],
        alias: {
          electron: r('src/shims/electron/index.ts'),
          '@e2rn/electron': r('src/shims/electron/index.ts'),
        },
      },
    ],
  ],
};
