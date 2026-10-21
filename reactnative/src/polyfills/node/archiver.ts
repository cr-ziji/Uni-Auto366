/**
 * `archiver` polyfill for React Native.
 *
 * Only the ZIP format is supported, which is the one the desktop sources
 * use (`archiver('zip', {zlib: {level: 9}})`). The archive is assembled in
 * memory and handed over to the destination stream when `finalize()` is
 * called, which mirrors the behaviour of the original package closely enough
 * for the ported modules:
 *
 *   - `archive.pipe(output)` selects the destination,
 *   - `archive.directory(dir, dest)` adds a directory tree,
 *   - `archive.append(buffer, {name})` adds a single file,
 *   - `await archive.finalize()` writes the archive and resolves,
 *   - `archive.abort()` cancels the archive.
 */
import {EventEmitter} from 'events';
import {Buffer} from 'buffer';
import {zipSync} from 'fflate';
import {readdir, readFile} from './fs';
import {join} from './path';

export interface ArchiverOptions {
  zlib?: {level?: number};
  store?: boolean;
}

export interface AppendOptions {
  name?: string;
}

function toBytes(source: any): Uint8Array {
  if (typeof source === 'string') {
    return Buffer.from(source, 'utf8') as any;
  }
  if (source instanceof Uint8Array) {
    return source;
  }
  if (source && typeof source === 'object' && source.data) {
    return toBytes(source.data);
  }
  throw new Error('archiver: unsupported source');
}

/** A ZIP archive that is written to a destination stream. */
export class Archiver extends EventEmitter {
  readonly format: string;
  readonly options: ArchiverOptions;
  private readonly files = new Map<string, Uint8Array>();
  private readonly directories: {path: string; destination?: string | false}[] = [];
  private destination: any = null;
  private finalized = false;
  private aborted = false;

  constructor(format: string = 'zip', options: ArchiverOptions = {}) {
    super();
    this.format = format;
    this.options = options ?? {};
  }

  /** The stream the archive is written to. */
  pipe(destination: any): any {
    this.destination = destination;
    return destination;
  }

  /** Adds a directory (recursively) to the archive. */
  directory(directoryPath: string, destination?: string | false): this {
    this.directories.push({path: directoryPath, destination});
    return this;
  }

  /** Adds a single file to the archive. */
  append(source: any, options?: AppendOptions): this {
    const name = options?.name;
    if (!name) {
      throw new Error('archiver: append() requires a "name" option');
    }
    this.files.set(name, toBytes(source));
    return this;
  }

  /** Writes the archive to the destination and resolves when it is done. */
  async finalize(): Promise<void> {
    if (this.finalized) {
      return;
    }
    if (this.aborted) {
      throw new Error('archiver: the archive was aborted');
    }
    for (const entry of this.directories) {
      await this.collectDirectory(entry.path, entry.destination);
    }
    const level = this.options?.zlib?.level;
    const data = zipSync(this.files as any, level === undefined ? undefined : ({level} as any));
    this.finalized = true;
    const destination = this.destination;
    if (!destination) {
      this.emit('end');
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: any) => {
        destination.removeListener?.('error', onError);
        reject(error);
      };
      destination.once?.('error', onError);
      try {
        destination.write(Buffer.from(data as any));
        destination.end(() => {
          destination.removeListener?.('error', onError);
          resolve();
        });
      } catch (error) {
        destination.removeListener?.('error', onError);
        reject(error);
      }
    });
    this.emit('end');
  }

  /** Cancels the archive. */
  abort(): this {
    this.aborted = true;
    this.files.clear();
    this.directories.length = 0;
    this.emit('aborted');
    return this;
  }

  private async collectDirectory(directoryPath: string, destination?: string | false): Promise<void> {
    let entries: any[];
    try {
      entries = (await readdir(directoryPath, {withFileTypes: true})) as any;
    } catch {
      return;
    }
    for (const entry of entries) {
      const name: string = entry.name;
      const fullPath = join(directoryPath, name);
      const relative = destination ? `${destination.replace(/\/$/, '')}/${name}` : name;
      if (entry.isDirectory?.()) {
        await this.collectDirectory(fullPath, relative);
        continue;
      }
      if (entry.isSymbolicLink?.()) {
        continue;
      }
      try {
        const content = await readFile(fullPath);
        this.files.set(relative, Buffer.from(content as any) as any);
      } catch (error) {
        this.emit('error', error);
      }
    }
  }
}

/** Creates a new archive (`archiver('zip', options)`). */
export function create(format: string = 'zip', options?: ArchiverOptions): Archiver {
  return new Archiver(format, options);
}

const archiver = create;

// The desktop code does `const archiver = require('archiver')` and calls the
// result directly, therefore the module itself has to be the factory function.
// The assignment happens last, so it replaces the object that the ES module
// transform created.
module.exports = archiver;
module.exports.default = archiver;
module.exports.create = create;
module.exports.Archiver = Archiver;
