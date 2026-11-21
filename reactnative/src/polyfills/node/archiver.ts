/**
 * `archiver` polyfill for React Native, backed by `react-native-nitro-unzip`.
 *
 * 桌面源码只用到 ZIP，且只有一个形状（`modules/injection/archive.js`）：
 *
 *     const output = fs.createWriteStream(zipPath);
 *     const archive = archiver('zip', {zlib: {level: 9}});
 *     archive.pipe(output);
 *     archive.directory(sourceDir, false);
 *     await archive.finalize();
 *
 * 以前这条路径是把整个目录读进内存、用 fflate 在 JS 里 deflate，几十 MB 的
 * 注入包要好几秒。现在直接把目录交给原生打包（Android 用 `java.util.zip`），
 * 打包结果由原生直接写进目标文件，JS 侧一个字节都不碰。
 *
 * 因此要求 `pipe()` 的目标带 `path`（`fs.createWriteStream` 的实现已经暴露）。
 * 其它组合（`append()`、带前缀的 `directory()`）没有调用方，直接报错而不是
 * 悄悄走一条又慢又占内存的老路。
 */
import {EventEmitter} from 'events';
import {Buffer} from 'buffer';
import {getUnzip} from 'react-native-nitro-unzip';
import {forgetFile} from './fs';

export interface ArchiverOptions {
  zlib?: {level?: number};
  store?: boolean;
}

export interface AppendOptions {
  name?: string;
}

let factory: ReturnType<typeof getUnzip> | null = null;

function unzip(): ReturnType<typeof getUnzip> {
  if (!factory) {
    factory = getUnzip();
  }
  return factory;
}

/** A ZIP archive that is written straight to a destination file. */
export class Archiver extends EventEmitter {
  readonly format: string;
  readonly options: ArchiverOptions;
  private readonly directories: {path: string; destination?: string | false}[] = [];
  private destination: any = null;
  private finalized = false;
  private aborted = false;

  constructor(format: string = 'zip', options: ArchiverOptions = {}) {
    super();
    this.format = format;
    this.options = options ?? {};
  }

  /** The stream the archive is written to. Its `path` is the output file. */
  pipe(destination: any): any {
    this.destination = destination;
    return destination;
  }

  /** Adds a directory (recursively) to the archive. */
  directory(directoryPath: string, destination?: string | false): this {
    this.directories.push({path: directoryPath, destination});
    return this;
  }

  /** 移动端按目录整体打包，不支持按名字塞单个 buffer。 */
  append(_source: any, _options?: AppendOptions): this {
    throw new Error('archiver: 移动端只支持 directory(dir, false)，append() 无原生实现');
  }

  /** Writes the archive to the destination and resolves when it is done. */
  async finalize(): Promise<void> {
    if (this.finalized) {
      return;
    }
    if (this.aborted) {
      throw new Error('archiver: the archive was aborted');
    }
    if (this.directories.length !== 1 || this.directories[0].destination !== false) {
      throw new Error('archiver: 移动端只支持单个 directory(dir, false)');
    }
    const destinationPath = this.destination?.path;
    if (!destinationPath) {
      throw new Error('archiver: pipe() 的目标必须带 path（用 fs.createWriteStream）');
    }

    this.finalized = true;
    const sourcePath = this.directories[0].path;

    // 目标路径可能还留着旧的镜像缓存，清掉，让后面的 stat/read 落到真实文件上。
    forgetFile(destinationPath);

    // 原生直接把 zip 写到目标路径。
    const task = unzip().zip(sourcePath, destinationPath);
    const result = await task.await();
    if (!result || !result.success) {
      throw new Error('archiver: 打包失败');
    }
    // 原生是绕开 `fs` 写的盘，再清一次缓存让调用方立刻能读到。
    forgetFile(destinationPath);

    // 文件已经就位，这时才结束目标流：它一个字节都没收到，`fs` 不会写出空文件
    // 把打包结果盖掉。顺序反过来会让 close 先于产物出现，监听 close 的调用方
    // 会拿到一个还不存在的包。
    await this.closeDestination();

    this.emit('end');
  }

  /** Cancels the archive. */
  abort(): this {
    this.aborted = true;
    this.directories.length = 0;
    this.emit('aborted');
    return this;
  }

  private closeDestination(): Promise<void> {
    const destination = this.destination;
    if (!destination || typeof destination.end !== 'function') {
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      const finish = () => resolve();
      destination.once?.('close', finish);
      destination.once?.('finish', finish);
      destination.once?.('error', finish);
      try {
        destination.end(() => resolve());
      } catch {
        resolve();
      }
    });
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
