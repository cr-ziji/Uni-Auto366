/**
 * Regression tests of the `archiver` polyfill.
 *
 * The dynamic injection repacks the extracted page directory
 * (`modules/injection/archive.js: repackZip`) and hands the result back to the
 * client. `fflate.zipSync()` only understands plain objects: the polyfill used
 * to pass its internal `Map`, so `zipSync` silently produced an empty archive
 * (22 byte ZIP end-of-central-directory) and every injected package was
 * useless even though the injection reported success.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const archiver = require('../src/polyfills/node/archiver');
// eslint-disable-next-line import/first
import {unzipSync} from 'fflate';

// eslint-disable-next-line import/first
import * as fsPoly from '../src/polyfills/node/fs';

const dir = '/tmp/Auto366/documents/archiver-regression';

async function repack(outputPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = fsPoly.createWriteStream(outputPath);
    const archive = archiver('zip', {zlib: {level: 9}});
    output.on('close', () => resolve());
    output.on('finish', () => resolve());
    output.on('error', (error: any) => { archive.abort(); reject(error); });
    archive.on('error', (error: any) => { output.destroy(); reject(error); });
    archive.pipe(output);
    archive.directory(dir, false);
    archive.finalize().catch((error: any) => { output.destroy(); reject(error); });
  });
}

describe('archiver polyfill', () => {
  it('keeps every file of the archived directory', async () => {
    await fsPoly.promises.mkdir(`${dir}/nested`, {recursive: true});
    await fsPoly.promises.writeFile(`${dir}/index.html`, '<html>injected</html>', 'utf8');
    await fsPoly.promises.writeFile(`${dir}/nested/auto-pk.js`, 'console.log(1);', 'utf8');

    const outputPath = `${dir}/out.zip`;
    await repack(outputPath);

    const bytes = await fsPoly.promises.readFile(outputPath);
    const entries = Object.keys(unzipSync(new Uint8Array(bytes as any)));
    expect(entries.sort()).toEqual(['index.html', 'nested/auto-pk.js']);
    expect(new TextDecoder().decode(unzipSync(new Uint8Array(bytes as any))['index.html'])).toBe(
      '<html>injected</html>',
    );
  });
});
