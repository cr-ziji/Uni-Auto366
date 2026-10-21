/**
 * E2RN Babel plugin: virtual `__dirname` / `__filename`.
 *
 * Metro has no CommonJS scope, so `__dirname` is undefined inside the bundled
 * Electron main process. The Auto366 main process uses `__dirname` in a handful
 * of places (`modules/register.js`, `modules/config/index.js`,
 * `modules/window/index.js`, `modules/injection/window/index.js`, ...) to build
 * absolute paths.
 *
 * We rewrite them to a VIRTUAL path rooted at `/app` (the read-only bundle root
 * that also backs the web-asset virtual file system). That keeps the original
 * source untouched while giving the runtime a stable, platform independent path
 * space:
 *
 *   <electronProject>/modules/register.js  ->  __dirname === '/app/modules'
 *
 * The virtual root is also what `modules/register.js#trustedSender` compares
 * against, so the desktop "only our own pages may call IPC" check keeps
 * working: the shimmed `ipcMain` reports `event.senderFrame.url` as
 * `file:///app/index.html`.
 */
const nodePath = require('node:path');

/** Where the original Electron project lives (one level above the RN host). */
const ELECTRON_ROOT = nodePath.resolve(__dirname, '..');
/** Virtual root that the bundled assets are mounted under. */
const VIRTUAL_ROOT = '/app';

module.exports = function e2rnDirnamePlugin({types: t}) {
  return {
    name: 'e2rn-dirname',
    visitor: {
      /**
       * Babel hands the visitor a `NodePath` - the identifier itself lives on
       * `path.node`.
       */
      Identifier(path, state) {
        const node = path.node;
        if (!node || (node.name !== '__dirname' && node.name !== '__filename')) {
          return;
        }
        // Only rewrite *references* - a property key or a declaration with the
        // same name must stay untouched.
        if (typeof path.isReferencedIdentifier === 'function' && !path.isReferencedIdentifier()) {
          return;
        }
        const filename = (state.file && state.file.opts && state.file.opts.filename) || state.filename;
        if (!filename) {
          return;
        }
        const relative = nodePath.relative(ELECTRON_ROOT, filename);
        // Only rewrite files that belong to the original Electron project.
        if (!relative || relative.startsWith('..') || nodePath.isAbsolute(relative)) {
          return;
        }
        const normalized = relative.split(nodePath.sep).join('/');
        const virtual = nodePath.posix.join(VIRTUAL_ROOT, normalized);
        const replacement = node.name === '__dirname' ? nodePath.posix.dirname(virtual) : virtual;
        path.replaceWith(t.stringLiteral(replacement));
      },
    },
  };
};
