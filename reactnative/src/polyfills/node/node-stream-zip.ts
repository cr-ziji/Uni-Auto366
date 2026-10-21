/**
 * `node-stream-zip` polyfill for React Native.
 *
 * The desktop sources use the package in two flavours:
 *
 *   - the classic one (`new StreamZip({file})`), which emits `ready` and uses
 *     callbacks for `extract()`;
 *   - the promise based one (`new StreamZip.async({file})`), whose `entries()`
 *     resolves with an object keyed by the entry name.
 *
 * The archive itself is parsed with `fflate`, which is already a dependency of
 * the project. Entry names are kept verbatim (the desktop code relies on
 * absolute entry names such as `/0/res/xxx.mp3`), but every name that is
 * written to the disk is sanitised.
 */
import {EventEmitter} from 'events';
import {Readable} from 'stream';
import {Buffer} from 'buffer';
import {unzipSync} from 'fflate';
import {mkdir, readFile, writeFile} from './fs';
import {dirname, join} from './path';

export interface StreamZipOptions {
  /** Path of the archive on the device. */
  file?: string;
  /** Raw archive content (alternative to `file`). */
  buffer?: Buffer | Uint8Array;
  /** Keep the entries in memory (always the case on mobile). */
  storeEntries?: boolean;
  /** Allow entry names that Node would reject (absolute paths, `..`). */
  skipEntryNameValidation?: boolean;
}

export type StreamZipSource = string | Buffer | Uint8Array | StreamZipOptions;

/** A single archive entry. */
export class ZipEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly size: number;
  readonly compressedSize: number;
  private readonly data: Buffer;

  constructor(name: string, data: Uint8Array, isDirectory: boolean) {
    this.name = name;
    this.isDirectory = isDirectory;
    this.data = Buffer.from(data as any);
    this.size = this.data.length;
    this.compressedSize = this.data.length;
  }

  /** The (uncompressed) content of the entry. */
  getDataSync(): Buffer {
    return Buffer.from(this.data);
  }

  /** The (uncompressed) content of the entry. */
  getData(): Promise<Buffer> {
    return Promise.resolve(this.getDataSync());
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

function toEntryMap(source: StreamZipSource): Map<string, ZipEntry> {
  const files = unzipSync(source as any);
  const entries = new Map<string, ZipEntry>();
  for (const name of Object.keys(files)) {
    entries.set(name, new ZipEntry(name, files[name], name.endsWith('/')));
  }
  return entries;
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

async function readArchive(source: StreamZipSource): Promise<Buffer> {
  if (typeof source === 'string') {
    return (await readFile(source)) as Buffer;
  }
  if (source instanceof Uint8Array) {
    return Buffer.from(source as any);
  }
  if (source && typeof source === 'object') {
    const options = source as StreamZipOptions;
    if (options.buffer) {
      return Buffer.from(options.buffer as any);
    }
    if (options.file) {
      return (await readFile(options.file)) as Buffer;
    }
  }
  throw new Error('node-stream-zip: neither "file" nor "buffer" was provided');
}

/** The classic, event based flavour of the API. */
export class StreamZip extends EventEmitter {
  protected entriesMap: Map<string, ZipEntry> = new Map();
  protected isReady = false;
  protected readonly options: StreamZipOptions;
  protected readonly loading: Promise<void>;

  constructor(source: StreamZipSource) {
    super();
    this.options = typeof source === 'object' && !(source instanceof Uint8Array) ? (source as StreamZipOptions) : {};
    this.loading = readArchive(source)
      .then(buffer => {
        this.entriesMap = toEntryMap(buffer);
        this.isReady = true;
        this.emit('ready');
      })
      .catch(error => {
        this.emit('error', error);
      });
  }

  /** All entries of the archive. */
  entries(): ZipEntry[] {
    if (!this.isReady) {
      throw new Error('node-stream-zip: the archive is not ready yet');
    }
    return Array.from(this.entriesMap.values());
  }

  /** The content of a single entry. */
  entryData(entryName: string): Promise<Buffer> {
    const entry = this.entriesMap.get(entryName);
    if (!entry) {
      return Promise.reject(new Error(`node-stream-zip: entry not found: ${entryName}`));
    }
    return entry.getData();
  }

  /** A readable stream with the content of a single entry. */
  stream(entryName: string): Readable {
    const entry = this.entriesMap.get(entryName);
    if (!entry) {
      throw new Error(`node-stream-zip: entry not found: ${entryName}`);
    }
    const data = entry.getDataSync();
    return new Readable({
      read() {
        this.push(data);
        this.push(null);
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
    this.loading
      .then(() => {
        if (entryName === null || entryName === undefined) {
          return this.extractAll(targetPath);
        }
        const entry = this.entriesMap.get(entryName);
        if (!entry) {
          throw new Error(`node-stream-zip: entry not found: ${entryName}`);
        }
        if (entry.isDirectory) {
          return mkdir(targetPath, {recursive: true}).then(() => 0);
        }
        return mkdir(dirname(targetPath), {recursive: true})
          .then(() => writeFile(targetPath, entry.getDataSync()))
          .then(() => 1);
      })
      .then(count => done(null, count))
      .catch(error => done(error));
  }

  private async extractAll(targetDirectory: string): Promise<number> {
    let count = 0;
    for (const entry of this.entriesMap.values()) {
      const relative = sanitizeEntryName(entry.name);
      if (!relative) {
        continue;
      }
      const target = join(targetDirectory, relative);
      if (entry.isDirectory) {
        await mkdir(target, {recursive: true});
        continue;
      }
      await mkdir(dirname(target), {recursive: true});
      await writeFile(target, entry.getDataSync());
      count += 1;
    }
    return count;
  }

  /** Releases the resources of the archive. */
  close(): void {
    this.entriesMap = new Map();
    this.isReady = false;
  }
}

/** The promise based flavour (`new StreamZip.async(...)`). */
export class StreamZipAsync {
  private entriesMap: Map<string, ZipEntry> = new Map();
  private readonly loading: Promise<void>;
  private closed = false;

  constructor(source: StreamZipSource) {
    this.loading = readArchive(source).then(buffer => {
      this.entriesMap = toEntryMap(buffer);
    });
  }

  /** All entries of the archive, keyed by their name. */
  async entries(): Promise<{[name: string]: ZipEntry}> {
    await this.loading;
    const result: {[name: string]: ZipEntry} = {};
    for (const [name, entry] of this.entriesMap) {
      result[name] = entry;
    }
    return result;
  }

  /** The content of a single entry. */
  async entryData(entryName: string): Promise<Buffer> {
    await this.loading;
    const entry = this.entriesMap.get(entryName);
    if (!entry) {
      throw new Error(`node-stream-zip: entry not found: ${entryName}`);
    }
    return entry.getData();
  }

  /** A readable stream with the content of a single entry. */
  async stream(entryName: string): Promise<Readable> {
    await this.loading;
    const entry = this.entriesMap.get(entryName);
    if (!entry) {
      throw new Error(`node-stream-zip: entry not found: ${entryName}`);
    }
    const data = entry.getDataSync();
    return new Readable({
      read() {
        this.push(data);
        this.push(null);
      },
    });
  }

  /** Extracts one entry (or every entry when `entryName` is `null`). */
  async extract(entryName: string | null, targetPath: string): Promise<number> {
    await this.loading;
    if (entryName === null || entryName === undefined) {
      let count = 0;
      for (const entry of this.entriesMap.values()) {
        const relative = sanitizeEntryName(entry.name);
        if (!relative) {
          continue;
        }
        const target = join(targetPath, relative);
        if (entry.isDirectory) {
          await mkdir(target, {recursive: true});
          continue;
        }
        await mkdir(dirname(target), {recursive: true});
        await writeFile(target, entry.getDataSync());
        count += 1;
      }
      return count;
    }
    const entry = this.entriesMap.get(entryName);
    if (!entry) {
      throw new Error(`node-stream-zip: entry not found: ${entryName}`);
    }
    if (entry.isDirectory) {
      await mkdir(targetPath, {recursive: true});
      return 0;
    }
    await mkdir(dirname(targetPath), {recursive: true});
    await writeFile(targetPath, entry.getDataSync());
    return 1;
  }

  /** Releases the resources of the archive. */
  async close(): Promise<void> {
    this.closed = true;
    this.entriesMap = new Map();
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
