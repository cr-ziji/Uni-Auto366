import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

/**
 * `scripts/build-web-assets.js` embeds the Electron web assets into the RN
 * bundle as two files:
 *
 *  - `index.json`   path -> `[size, binary]`, parsed on every start-up.
 *  - `payload.json` one deflate+base64 blob, decoded on the first request.
 *
 * `resources/` used to be copied wholesale, which pulled in the sherpa-onnx
 * models (61 MB), mihomo + wintun (46 MB) and the Windows injector - 107 MB of
 * bytes that can never execute on a phone, and a manifest of 143 MB that
 * Hermes had to parse before the splash screen went away. These tests pin both
 * the exclusion list and a coarse size budget so that a future `ENTRIES`
 * change cannot silently undo it.
 */
// `__dirname` is a Jest haste path (`/app/reactnative/__tests__`), not the real
// location on disk; the working directory is the package root.
const assetDir = path.resolve(process.cwd(), 'src', 'web-assets');
const indexPath = path.join(assetDir, 'index.json');
const payloadPath = path.join(assetDir, 'payload.json');

/** The assets are a build artifact (`npm run assets`); skip when absent. */
const describeIfBuilt =
  fs.existsSync(indexPath) && fs.existsSync(payloadPath) ? describe : describe.skip;

interface AssetIndex {
  generatedAt: string;
  files: Record<string, [number, 0 | 1]>;
}

describeIfBuilt('the bundled web assets', () => {
  let index: AssetIndex;
  let names: string[];

  beforeAll(() => {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as AssetIndex;
    names = Object.keys(index.files);
  });

  it('leaves the desktop-only resources out of the bundle', () => {
    const leaked = names.filter(name => /^resources\/(tts|tun|openspeedy)\//.test(name));
    // These directories hold a 41 MB `model.onnx`, `mihomo.exe` + `wintun.dll`
    // and Windows PE injectors - none of them is reachable from a page, and
    // the first one alone used to blow the manifest up to 143 MB.
    expect(leaked).toEqual([]);
  });

  it('keeps the start-up index in the kilobyte range', () => {
    const bytes = fs.statSync(indexPath).size;
    // The index is what Hermes parses during start-up. It only holds paths,
    // sizes and a flag, so it must stay tiny - a few hundred entries are ~4 KB.
    expect(bytes).toBeLessThan(256 * 1024);
  });

  it('keeps the deferred payload under the old single-manifest size', () => {
    const bytes = fs.statSync(payloadPath).size;
    // Current size is ~1.2 MB. Anything above this budget means a large
    // directory slipped back into `ENTRIES`.
    expect(bytes).toBeLessThan(8 * 1024 * 1024);
  });

  it('decodes to a payload that carries every file the index lists', () => {
    const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8')) as {data: string};
    const inflated = zlib.inflateRawSync(Buffer.from(payload.data, 'base64'));
    const files = JSON.parse(inflated.toString('utf8')) as Record<string, string>;
    // A mismatch means `index.json` and `payload.json` were generated at
    // different times, and the server would 404 on a file it claims to have.
    expect(Object.keys(files).sort()).toEqual(names.slice().sort());
  });

  it('still carries every page the renderer needs', () => {
    for (const required of [
      'index.html',
      'renderer/app.js',
      'renderer/pages/extensions/index.js',
      'renderer/pages/answers/index.js',
      'styles/app.css',
      // Referenced from `index.html` as `resources/*.jpg`.
      'resources/qq.jpg',
      'resources/agreements/privacy.md',
      // Loaded by `modules/injection/window` through `BrowserWindow.loadFile`.
      'modules/injection/window/index.html',
    ]) {
      expect(names).toContain(required);
    }
  });

  it('flags binary payloads as base64', () => {
    // A UTF-8 round-trip corrupts fonts and ZIP implants.
    expect(index.files['node_modules/bootstrap-icons/font/fonts/bootstrap-icons.woff2'][1]).toBe(1);
    expect(index.files['index.html'][1]).toBe(0);
  });
});
