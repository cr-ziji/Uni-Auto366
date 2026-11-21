/**
 * `hydrateFileSystem()` used to copy the whole writable sandbox into memory.
 *
 * That mirror is what made start-up slow: every byte crosses the bridge twice
 * (device -> base64 string -> Buffer), and a phone that had downloaded a
 * resource pack or extracted an answer package spent ~15 s reproducing tens of
 * megabytes the boot never reads.
 *
 * The mirror is now bounded, and files outside the budget are read on demand
 * through the native blocking call - exactly like `fs.readFileSync` on the
 * desktop. These tests pin both halves of that contract.
 */

const documents = '/tmp/Auto366/documents';
const root = `${documents}/.Auto366`;
const SMALL = `${root}/config/settings.json`;
const BIG = `${root}/answers/pkg/audio.bin`;
const RESOURCE = `${root}/resources/tts/model.bin`;

const mockDeviceFiles = new Map<string, Buffer>([
  [SMALL, Buffer.from('{"theme":"dark"}', 'utf8')],
  // 1 MB: above MIRROR_CONTENT_LIMIT (256 KB).
  [BIG, Buffer.alloc(1024 * 1024, 7)],
  // Small enough on its own, but `resources/` is never mirrored.
  [RESOURCE, Buffer.from('model-bytes', 'utf8')],
]);
const mockDeviceDirectories = new Set<string>([
  documents,
  root,
  `${root}/config`,
  `${root}/answers`,
  `${root}/answers/pkg`,
  `${root}/resources`,
  `${root}/resources/tts`,
]);

jest.mock('react-native-fs', () => {
  const ok = (value: any) => Promise.resolve(value);
  const childrenOf = (target: string) => {
    const names = new Set<string>();
    for (const path of [...mockDeviceFiles.keys(), ...mockDeviceDirectories]) {
      if (!path.startsWith(`${target}/`)) {
        continue;
      }
      const rest = path.slice(target.length + 1);
      if (!rest || rest.includes('/')) {
        continue;
      }
      names.add(rest);
    }
    return [...names].map(name => {
      const path = `${target}/${name}`;
      return {
        name,
        path,
        size: mockDeviceFiles.get(path)?.length ?? 0,
        isFile: () => mockDeviceFiles.has(path),
        isDirectory: () => mockDeviceDirectories.has(path),
      };
    });
  };
  return {
    __esModule: true,
    default: {
      DocumentDirectoryPath: documents,
      CachesDirectoryPath: '/tmp/Auto366/caches',
      TemporaryDirectoryPath: '/tmp/Auto366/temporary',
      exists: jest.fn((target: string) =>
        ok(mockDeviceFiles.has(target) || mockDeviceDirectories.has(target)),
      ),
      readDir: jest.fn((target: string) => ok(childrenOf(target))),
      readFile: jest.fn((target: string, encoding?: string) => {
        const content = mockDeviceFiles.get(target);
        if (!content) {
          return Promise.reject(new Error(`ENOENT '${target}'`));
        }
        return ok(encoding ? content.toString(encoding as any) : content);
      }),
      writeFile: jest.fn(() => ok(undefined)),
      appendFile: jest.fn(() => ok(undefined)),
      mkdir: jest.fn(() => ok(undefined)),
      stat: jest.fn((target: string) =>
        ok({
          path: target,
          size: mockDeviceFiles.get(target)?.length ?? 0,
          isFile: () => mockDeviceFiles.has(target),
          isDirectory: () => mockDeviceDirectories.has(target),
          mtime: new Date(0),
        }),
      ),
      unlink: jest.fn(() => ok(undefined)),
      copyFile: jest.fn(() => ok(undefined)),
      moveFile: jest.fn(() => ok(undefined)),
      existsSync: jest.fn(
        (target: string) => mockDeviceFiles.has(target) || mockDeviceDirectories.has(target),
      ),
    },
  };
});

const mockReadFileSyncBlocking = jest.fn((target: string) => mockDeviceFiles.get(target) ?? null);

jest.mock('../src/runtime/native/files', () => ({
  __esModule: true,
  flushPendingSave: jest.fn(async () => false),
  readFileSyncBlocking: (target: string) => mockReadFileSyncBlocking(target),
  isSyncReadAvailable: () => true,
  isFilePickerAvailable: () => false,
  pickFiles: jest.fn(async () => []),
  pickSaveTarget: jest.fn(async () => null),
  registerSaveTarget: jest.fn(),
  getSaveTarget: jest.fn(() => undefined),
  openFile: jest.fn(async () => false),
  shareFile: jest.fn(async () => false),
  saveToDownloads: jest.fn(async () => ''),
}));

// Imported after the mocks so that the polyfill picks them up.
// eslint-disable-next-line import/first
import {hydrateFileSystem, readFileSync, statSync} from '../src/polyfills/node/fs';

describe('the start-up file mirror', () => {
  beforeAll(async () => {
    await hydrateFileSystem();
  });

  it('reads a small file on demand and caches it afterwards', () => {
    // 启动时只建索引、不搬正文：第一次同步读走原生阻塞调用。
    expect(readFileSync(SMALL, 'utf8')).toBe('{"theme":"dark"}');
    expect(mockReadFileSyncBlocking).toHaveBeenCalledWith(SMALL);

    // 读完进了镜像缓存，第二次不该再打一次 JSI 调用。
    mockReadFileSyncBlocking.mockClear();
    expect(readFileSync(SMALL, 'utf8')).toBe('{"theme":"dark"}');
    expect(mockReadFileSyncBlocking).not.toHaveBeenCalledWith(SMALL);
  });

  it('keeps a large file on the device but still lists it', () => {
    expect(statSync(BIG).size).toBe(1024 * 1024);
  });

  it('reads a deferred file through the native blocking call', () => {
    const bytes = readFileSync(BIG) as Buffer;
    expect(bytes.length).toBe(1024 * 1024);
    expect(mockReadFileSyncBlocking).toHaveBeenCalledWith(BIG);
  });

  it('never mirrors the resources subtree', () => {
    // `resources/` holds downloaded packs (TTS model, TUN bundle); the file is
    // small, so only the directory policy keeps it out of the mirror.
    expect(readFileSync(RESOURCE, 'utf8')).toBe('model-bytes');
    expect(mockReadFileSyncBlocking).toHaveBeenCalledWith(RESOURCE);
  });
});
