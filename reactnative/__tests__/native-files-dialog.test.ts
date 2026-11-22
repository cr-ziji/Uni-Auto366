/**
 * The `dialog` shim on top of the native `Auto366Files` module.
 *
 * Both native implementations (Android `Auto366FilesModule`, iOS
 * `Auto366Files.swift`) follow one contract, and this suite pins it down:
 *
 *  - `pickSaveTarget()` only reserves a destination; the bytes reach the user
 *    picked location through `writeToUri()` once `fs` has persisted the file;
 *  - `pickFiles()` returns sandbox paths, and the shim loads them into the
 *    in-memory mirror so the ported `readFileSync` call sites keep working;
 *  - without the native module everything degrades to "cancelled" instead of
 *    throwing.
 */
import {NativeModules} from 'react-native';
import {Buffer} from 'buffer';

import * as fs from '../src/polyfills/node/fs';
import * as nativeFiles from '../src/runtime/native/files';
import {dialog} from '../src/shims/electron/dialog';

// The RNFS mock exposes the fake device file system through `__mockFiles`.
const RNFS = require('react-native-fs');

const TARGET_URI = 'file:///tmp/Exports/rules.json';

interface WrittenTarget {
  uri: string;
  data: Buffer;
}

interface Harness {
  module: Record<string, jest.Mock>;
  writes: WrittenTarget[];
}

/** Installs a fake `Auto366Files` module that records `writeToUri` calls. */
function installModule(overrides: Record<string, jest.Mock> = {}): Harness {
  const writes: WrittenTarget[] = [];
  const module: Record<string, jest.Mock> = {
    pickFiles: jest.fn(async () => []),
    pickSaveTarget: jest.fn(async (name: string) => ({
      uri: `file:///tmp/Exports/${name}`,
      name,
    })),
    writeToUri: jest.fn(async (uri: string, base64: string) => {
      writes.push({uri, data: Buffer.from(base64, 'base64')});
      return true;
    }),
    saveToDownloads: jest.fn(async () => '/tmp/Auto366/documents/Downloads/Auto366/x.zip'),
    openFile: jest.fn(async () => true),
    shareFile: jest.fn(async () => true),
    readFileBase64Sync: jest.fn(() => ''),
    ...overrides,
  };
  (NativeModules as unknown as Record<string, unknown>).Auto366Files = module;
  return {module, writes};
}

afterEach(() => {
  delete (NativeModules as unknown as Record<string, unknown>).Auto366Files;
});

describe('dialog.showSaveDialog()', () => {
  it('relays the bytes written into the sandbox to the picked target', async () => {
    const {module, writes} = installModule();

    const result = await dialog.showSaveDialog({defaultPath: 'rules.json'});
    expect(result.canceled).toBe(false);
    expect(module.pickSaveTarget).toHaveBeenCalledWith('rules.json', '*/*');
    // The save dialog hands out a sandbox path, not the user picked location.
    expect(result.filePath).toContain('/exports/rules.json');

    await fs.writeFile(result.filePath as string, '{"rules":[]}', 'utf-8');

    expect(writes.map(entry => entry.uri)).toEqual([TARGET_URI]);
    expect(writes[0].data.toString('utf8')).toBe('{"rules":[]}');
    // The sandbox copy stays behind, `shell.openPath()` can still open it.
    expect(RNFS.__mockFiles.get(result.filePath as string)?.toString('utf8')).toBe(
      '{"rules":[]}',
    );
  });

  it('copies an existing file into the target through fs.copyFile()', async () => {
    const {module, writes} = installModule();
    const capture = '/tmp/Auto366/caches/capture.bin';
    RNFS.__mockFiles.set(capture, Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const result = await dialog.showSaveDialog({
      defaultPath: 'traffic.zip',
      filters: [{name: 'Zip Files', extensions: ['zip']}],
    });
    await fs.copyFile(capture, result.filePath as string);

    expect(module.pickSaveTarget).toHaveBeenCalledWith('traffic.zip', 'application/zip');
    expect(writes).toHaveLength(1);
    expect(writes[0].uri).toBe('file:///tmp/Exports/traffic.zip');
    expect(writes[0].data).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });

  it('reports cancelled when the user dismisses the picker', async () => {
    installModule({pickSaveTarget: jest.fn(async () => null)});

    const result = await dialog.showSaveDialog({defaultPath: 'rules.json'});

    expect(result).toEqual({canceled: true, filePath: undefined, filePaths: []});
  });
});

describe('dialog.showOpenDialog()', () => {
  it('mirrors the picked file so readFileSync() sees its content', async () => {
    const picked = '/tmp/Auto366/caches/imports/rules.json';
    RNFS.__mockFiles.set(picked, Buffer.from('{"a":1}', 'utf8'));
    installModule({
      pickFiles: jest.fn(async () => [{path: picked, name: 'rules.json', size: 7}]),
    });

    const result = await dialog.showOpenDialog({properties: ['openFile']});

    expect(result.canceled).toBe(false);
    expect(result.filePaths).toEqual([picked]);
    expect(fs.readFileSync(picked, 'utf-8')).toBe('{"a":1}');
  });

  it('reports cancelled when nothing was picked', async () => {
    installModule();

    const result = await dialog.showOpenDialog({properties: ['openFile']});

    expect(result).toEqual({canceled: true, filePaths: []});
  });

  it('refuses to pick a directory on mobile', async () => {
    const {module} = installModule();

    const result = await dialog.showOpenDialog({properties: ['openDirectory']});

    expect(result).toEqual({canceled: true, filePaths: []});
    expect(module.pickFiles).not.toHaveBeenCalled();
  });
});

describe('native file helpers', () => {
  it('degrades to "not available" without the native module', async () => {
    expect(nativeFiles.isFilePickerAvailable()).toBe(false);
    expect(await nativeFiles.pickFiles()).toEqual([]);
    expect(await nativeFiles.pickSaveTarget('rules.json')).toBeNull();
    expect(await nativeFiles.openFile('/tmp/x.zip')).toBe(false);
    expect(nativeFiles.readFileSyncBlocking('/tmp/x.zip')).toBeNull();
    expect(() => nativeFiles.isSyncReadAvailable()).not.toThrow();

    const result = await dialog.showSaveDialog({defaultPath: 'rules.json'});
    expect(result.canceled).toBe(true);
  });

  it('reads a file through the blocking bridge', () => {
    // 空路径是 `isSyncReadAvailable()` 的探测器：真实实现同步返回空串。
    installModule({
      readFileBase64Sync: jest.fn((path: string) =>
        path ? Buffer.from('hello').toString('base64') : '',
      ),
    });

    expect(nativeFiles.isSyncReadAvailable()).toBe(true);
    expect(nativeFiles.readFileSyncBlocking('/tmp/x.txt')?.toString('utf8')).toBe('hello');
  });

  it('treats a bridge that lost the synchronous contract as unavailable', () => {
    // 例如旧构建把同步方法退化成了 Promise：探测拿不到字符串。
    installModule({
      readFileBase64Sync: jest.fn(() => Promise.resolve('') as unknown as string),
    });

    expect(nativeFiles.isSyncReadAvailable()).toBe(false);
  });

  it('treats an empty blocking read as "cannot read"', () => {
    installModule({readFileBase64Sync: jest.fn(() => '')});

    expect(nativeFiles.readFileSyncBlocking('/tmp/missing.txt')).toBeNull();
  });
});
