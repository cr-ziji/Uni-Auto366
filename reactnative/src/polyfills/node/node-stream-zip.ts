/**
 * `node-stream-zip` polyfill for React Native, backed by `react-native-nitro-unzip`.
 *
 * 桌面源码用到两种形态：
 *
 *   - 经典版 `new StreamZip({file})`：发 `ready` 事件，`extract()` 走回调；
 *   - Promise 版 `new StreamZip.async({file})`：`entries()` 返回按名字索引的对象。
 *
 * 以前整包用 fflate 在 JS 里 inflate 到内存，几十 MB 的课件包要卡好几秒。现在
 * 解压交给原生（Android 是 `java.util.zip` + 64KB 缓冲），条目落到一个临时
 * 工作目录，读取变成普通文件 I/O。
 *
 * 条目名以**解压后的相对路径**为准（原 ZIP 里的前导 `/` 会被去掉）：调用方都是
 * 拿 `entry.name` 回查内容，两边一致即可，写盘前也少一层名字规整。
 */
import {EventEmitter} from 'events';
import {Readable} from 'stream';
import {Buffer} from 'buffer';
import {getUnzip} from 'react-native-nitro-unzip';
import {mkdir, readFile, writeFile, readdir, stat, rm, mkdtemp} from './fs';
import {dirname, join} from './path';
import {tmpdir} from './os';

export interface StreamZipOptions {
  /** Path of the archive on the device. */
  file?: string;
  /** Raw archive content (alternative to `file`). */
  buffer?: Buffer | Uint8Array;
  /** Ignored on mobile: entries always live in a temporary directory. */
  storeEntries?: boolean;
  /** Kept for API parity: names are sanitised when they are written out. */
  skipEntryNameValidation?: boolean;
}

export type StreamZipSource = string | Buffer | Uint8Array | StreamZipOptions;

/** A single archive entry, backed by the extracted file. */
export class ZipEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly size: number;
  readonly compressedSize: number;
  private readonly root: string;

  constructor(name: string, root: string, isDirectory: boolean, size: number) {
    this.name = name;
    this.root = root;
    this.isDirectory = isDirectory;
    this.size = size;
    this.compressedSize = size;
  }

  /** 内容在临时目录里，同步 API 读不到，调用方请用 `getData()`。 */
  getDataSync(): Buffer {
    throw new Error('node-stream-zip: 移动端的条目内容不是内存缓冲，请改用 getData()/entryData()');
  }

  /** The (uncompressed) content of the entry. */
  async getData(): Promise<Buffer> {
    if (this.isDirectory) {
      return Buffer.alloc(0);
    }
    return (await readFile(join(this.root, this.name))) as Buffer;
  }

  /** Alias of {@link getData} (promise based flavour). */
  getDataAsync(): Promise<Buffer> {
    return this.getData();
  }

  /** The compressed content is not kept separately on mobile. */
  getCompressedData(): Promise<Buffer> {
    return this.getData();
  }
}

/** Removes the leading separators and rejects path traversal attempts. */
export function sanitizeEntryName(name: string): string {
  const segments = String(name ?? '')
    .replace(/^[/\\]+/, '')
    .split(/[/\\]+/)
    .filter(segment => segment && segment !== '.');
  if (segments.some(segment => segment === '..')) {
    throw new Error(`Malicious entry: ${name}`);
  }
  return segments.join('/');
}

let factory: ReturnType<typeof getUnzip> | null = null;

/** `getUnzip()` 每次都要过一遍原生注册，这里只建一次。 */
function unzip(): ReturnType<typeof getUnzip> {
  if (!factory) {
    factory = getUnzip();
  }
  return factory;
}

/** 把各种入参统一成一个设备上的 ZIP 路径。 */
async function resolveArchivePath(source: StreamZipSource): Promise<{path: string; cleanup?: string}> {
  if (typeof source === 'string') {
    return {path: source};
  }
  const buffer = source instanceof Uint8Array
    ? Buffer.from(source as any)
    : (source as StreamZipOptions)?.buffer;
  if (buffer) {
    const directory = await mkdtemp(join(tmpdir(), 'e2rn-zip-src-'));
    const target = join(directory, 'archive.zip');
    await writeFile(target, Buffer.from(buffer as any));
    return {path: target, cleanup: directory};
  }
  const file = (source as StreamZipOptions)?.file;
  if (file) {
    return {path: file};
  }
  throw new Error('node-stream-zip: neither "file" nor "buffer" was provided');
}

async function collectEntries(root: string, relative: string, out: Map<string, ZipEntry>): Promise<void> {
  const directory = relative ? join(root, relative) : root;
  const children = (await readdir(directory, {withFileTypes: true})) as any[];
  for (const child of children) {
    const name = relative ? `${relative}/${child.name}` : child.name;
    if (child.isDirectory?.()) {
      out.set(name, new ZipEntry(name, root, true, 0));
      await collectEntries(root, name, out);
      continue;
    }
    const info = await stat(join(root, name));
    out.set(name, new ZipEntry(name, root, false, Number((info as any).size) || 0));
  }
}

/** 解压到临时工作目录并建立条目索引（只会做一次）。 */
class Workspace {
  private entriesMap: Map<string, ZipEntry> | null = null;
  private loading: Promise<Map<string, ZipEntry>> | null = null;
  private directory: string | null = null;
  /** 入参是 buffer 时为它临时落盘的那个目录，`release()` 时删掉。 */
  private sourceCleanup: string | null = null;

  constructor(readonly archivePath: string, sourceCleanup?: string) {
    this.sourceCleanup = sourceCleanup ?? null;
  }

  load(): Promise<Map<string, ZipEntry>> {
    if (this.entriesMap) {
      return Promise.resolve(this.entriesMap);
    }
    if (!this.loading) {
      this.loading = this.extract().catch(error => {
        this.loading = null;
        throw error;
      });
    }
    return this.loading;
  }

  private async extract(): Promise<Map<string, ZipEntry>> {
    const directory = await mkdtemp(join(tmpdir(), 'e2rn-zip-'));
    this.directory = directory;
    const task = unzip().extract(this.archivePath, directory);
    const result = await task.await();
    if (!result || !result.success) {
      throw new Error('node-stream-zip: 解压失败');
    }
    const entries = new Map<string, ZipEntry>();
    await collectEntries(directory, '', entries);
    this.entriesMap = entries;
    return entries;
  }

  /** 已索引的条目（解压完成后才有内容）。 */
  snapshot(): Map<string, ZipEntry> {
    return this.entriesMap ?? new Map();
  }

  /** 把单个条目写到目标位置（内容取自工作目录）。 */
  async copyEntry(entry: ZipEntry, targetPath: string): Promise<void> {
    if (entry.isDirectory) {
      await mkdir(targetPath, {recursive: true});
      return;
    }
    await mkdir(dirname(targetPath), {recursive: true});
    await writeFile(targetPath, await entry.getData());
  }

  async release(): Promise<void> {
    this.entriesMap = null;
    this.loading = null;
    const directory = this.directory;
    this.directory = null;
    if (directory) {
      await rm(directory, {recursive: true, force: true}).catch(() => {});
    }
    // 入参是 buffer 时先把内容落到了一个临时文件，收尾一并清掉。
    if (this.sourceCleanup) {
      const temporary = this.sourceCleanup;
      this.sourceCleanup = null;
      await rm(temporary, {recursive: true, force: true}).catch(() => {});
    }
  }
}

/** The classic, event based flavour of the API. */
export class StreamZip extends EventEmitter {
  protected workspace: Workspace | null = null;
  protected isReady = false;
  private readonly ready: Promise<void>;

  constructor(source: StreamZipSource) {
    super();
    this.ready = this.prepare(source);
  }

  private async prepare(source: StreamZipSource): Promise<void> {
    try {
      const {path, cleanup} = await resolveArchivePath(source);
      const workspace = new Workspace(path, cleanup);
      this.workspace = workspace;
      await workspace.load();
      this.isReady = true;
      this.emit('ready');
    } catch (error) {
      this.emit('error', error);
    }
  }

  /** All entries of the archive. */
  entries(): ZipEntry[] {
    if (!this.isReady || !this.workspace) {
      throw new Error('node-stream-zip: the archive is not ready yet');
    }
    return Array.from(this.workspace.snapshot().values());
  }

  /** The content of a single entry. */
  async entryData(entryName: string): Promise<Buffer> {
    const entry = this.find(entryName);
    return entry.getData();
  }

  /** A readable stream with the content of a single entry. */
  stream(entryName: string): Readable {
    const entry = this.find(entryName);
    const data = entry.getData();
    return new Readable({
      read() {
        data.then(buffer => {
          this.push(buffer);
          this.push(null);
        }, error => this.destroy(error));
      },
    });
  }

  /**
   * Extracts one entry (or every entry when `entryName` is `null`).
   *
   * The callback receives the number of extracted entries.
   */
  extract(
    entryName: string | null,
    targetPath: string,
    callback?: (error: any, count?: number) => void,
  ): void {
    const done = (error: any, count?: number) => {
      if (callback) {
        callback(error, count);
      }
    };
    this.ready
      .then(async () => {
        const workspace = this.workspace;
        if (!workspace) {
          throw new Error('node-stream-zip: the archive is not ready yet');
        }
        if (entryName === null || entryName === undefined) {
          return this.extractAll(targetPath);
        }
        const entry = this.find(entryName);
        await workspace.copyEntry(entry, targetPath);
        return entry.isDirectory ? 0 : 1;
      })
      .then(count => done(null, count))
      .catch(error => done(error));
  }

  private async extractAll(targetDirectory: string): Promise<number> {
    const workspace = this.workspace;
    if (!workspace) {
      throw new Error('node-stream-zip: the archive is not ready yet');
    }
    let count = 0;
    for (const entry of workspace.snapshot().values()) {
      const relative = sanitizeEntryName(entry.name);
      if (!relative) {
        continue;
      }
      await workspace.copyEntry(entry, join(targetDirectory, relative));
      if (!entry.isDirectory) {
        count += 1;
      }
    }
    return count;
  }

  private find(entryName: string): ZipEntry {
    const map = this.workspace?.snapshot();
    const entry = map?.get(entryName) ?? map?.get(sanitizeEntryName(entryName));
    if (!entry) {
      throw new Error(`node-stream-zip: entry not found: ${entryName}`);
    }
    return entry;
  }

  /** Releases the resources of the archive. */
  close(): void {
    this.isReady = false;
    const workspace = this.workspace;
    if (workspace) {
      workspace.release().catch(() => {});
    }
  }
}

/** The promise based flavour (`new StreamZip.async(...)`). */
export class StreamZipAsync {
  private workspace: Workspace | null = null;
  private readonly loading: Promise<Workspace>;

  constructor(source: StreamZipSource) {
    this.loading = resolveArchivePath(source).then(({path, cleanup}) => {
      const workspace = new Workspace(path, cleanup);
      this.workspace = workspace;
      return workspace.load().then(() => workspace);
    });
  }

  /** All entries of the archive, keyed by their name. */
  async entries(): Promise<{[name: string]: ZipEntry}> {
    const workspace = await this.loading;
    const map = await workspace.load();
    const result: {[name: string]: ZipEntry} = {};
    for (const [name, entry] of map) {
      result[name] = entry;
    }
    return result;
  }

  /** The content of a single entry. */
  async entryData(entryName: string): Promise<Buffer> {
    const entry = await this.find(entryName);
    return entry.getData();
  }

  /** A readable stream with the content of a single entry. */
  async stream(entryName: string): Promise<Readable> {
    const entry = await this.find(entryName);
    const data = entry.getData();
    return new Readable({
      read() {
        data.then(buffer => {
          this.push(buffer);
          this.push(null);
        }, error => this.destroy(error));
      },
    });
  }

  /** Extracts one entry (or every entry when `entryName` is `null`). */
  async extract(entryName: string | null, targetPath: string): Promise<number> {
    const workspace = await this.loading;
    if (entryName === null || entryName === undefined) {
      let count = 0;
      for (const entry of (await workspace.load()).values()) {
        const relative = sanitizeEntryName(entry.name);
        if (!relative) {
          continue;
        }
        await workspace.copyEntry(entry, join(targetPath, relative));
        if (!entry.isDirectory) {
          count += 1;
        }
      }
      return count;
    }
    const entry = await this.find(entryName);
    await workspace.copyEntry(entry, targetPath);
    return entry.isDirectory ? 0 : 1;
  }

  private async find(entryName: string): Promise<ZipEntry> {
    const workspace = await this.loading;
    const map = await workspace.load();
    const entry = map.get(entryName) ?? map.get(sanitizeEntryName(entryName));
    if (!entry) {
      throw new Error(`node-stream-zip: entry not found: ${entryName}`);
    }
    return entry;
  }

  /** Releases the resources of the archive. */
  async close(): Promise<void> {
    const workspace = this.workspace;
    this.workspace = null;
    if (workspace) {
      await workspace.release();
    }
  }
}

/* The desktop code uses `new StreamZip.async({...})`. */
(StreamZip as any).async = StreamZipAsync;

// The desktop code does `const StreamZip = require('node-stream-zip')` and
// constructs it, therefore the module itself has to be the class. The
// assignment happens last, so it replaces the object that the ES module
// transform created.
module.exports = StreamZip;
module.exports.default = StreamZip;
module.exports.StreamZip = StreamZip;
module.exports.StreamZipAsync = StreamZipAsync;
module.exports.ZipEntry = ZipEntry;
