/**
 * 测试用的 ZIP 夹具构造器。
 *
 * 只做一件事：把若干文件打成标准 ZIP（deflate 压缩），给
 * `modules/injection/zip.js` 这类"读进来改一改再写出去"的代码当输入。
 * 之前用 fflate 造夹具，现在 fflate 已经从依赖里去掉，这几十行足够替代。
 *
 * 校验一律用真实的 `node-stream-zip`，所以这里只要保证结构合法即可。
 */
import {Buffer} from 'buffer';
import zlib from 'zlib';
import fs from 'fs';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

interface Entry {
  name: Buffer;
  crc: number;
  compressed: Buffer;
  size: number;
  offset: number;
}

/** 打包成 ZIP 并写到 `target`。 */
export function writeZipFile(target: string, files: Record<string, Buffer | string>): void {
  const entries: Entry[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const nameBuffer = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // flag: UTF-8 文件名
    local.writeUInt16LE(8, 8);           // method: deflate
    local.writeUInt16LE(0, 10);          // time
    local.writeUInt16LE(0x21, 12);       // date (1980-01-01)
    local.writeUInt32LE(zlib.crc32(data) >>> 0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);

    entries.push({name: nameBuffer, crc: zlib.crc32(data) >>> 0, compressed, size: data.length, offset});
    chunks.push(local, nameBuffer, compressed);
    offset += local.length + nameBuffer.length + compressed.length;
  }

  const centralChunks: Buffer[] = [];
  let centralSize = 0;
  for (const entry of entries) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.compressed.length, 20);
    central.writeUInt32LE(entry.size, 24);
    central.writeUInt16LE(entry.name.length, 28);
    central.writeUInt16LE(0, 30);        // extra
    central.writeUInt16LE(0, 32);        // comment
    central.writeUInt16LE(0, 34);        // disk
    central.writeUInt16LE(0, 36);        // internal attrs
    central.writeUInt32LE(0, 38);        // external attrs
    central.writeUInt32LE(entry.offset, 42);
    centralChunks.push(central, entry.name);
    centralSize += central.length + entry.name.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD_SIG, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(target, Buffer.concat([...chunks, ...centralChunks, end]));
}
