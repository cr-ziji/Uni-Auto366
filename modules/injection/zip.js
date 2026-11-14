const zlib = require('zlib');
const fs = require('fs-extra');
const crypto = require('crypto');

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/**
 * 移动端用不了"整包解压 → 改文件 → 整包重压缩"这条路：一个几十 MB 的课件包
 * 在 Hermes 上要 inflate 一遍、deflate 一遍（还要经过 base64 桥写 N 个文件），
 * 请求早超时了。
 *
 * 这里改成原地改写：只把 .html 条目解出来插入脚本，其余条目连同压缩后的字节
 * 原样拷贝，最后重算目录偏移。工作量从"整包重压缩"降成"只处理几个 HTML"。
 */

function unsupported(message) {
  const error = new Error(message);
  error.code = 'E_ZIP_UNSUPPORTED';
  return error;
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let index = 0; index < 256; index++) {
      let value = index;
      for (let bit = 0; bit < 8; bit++) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[index] = value;
    }
  }
  let crc = -1;
  for (let index = 0; index < buffer.length; index++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buffer[index]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function findEocd(buffer) {
  const lowest = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= lowest; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIG) return offset;
  }
  throw unsupported('找不到 ZIP 目录尾');
}

function readDirectory(buffer) {
  if (buffer.length < 22) throw unsupported('ZIP 文件过小');
  const eocd = findEocd(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw unsupported('暂不支持 ZIP64');
  }
  if (directoryOffset + directorySize > buffer.length) throw unsupported('ZIP 目录越界');

  const entries = [];
  let offset = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CD_SIG) {
      throw unsupported('ZIP 目录损坏');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    if (flags & 0x0001) throw unsupported('ZIP 已加密');
    if (flags & 0x0008 && compressedSize === 0 && uncompressedSize === 0) {
      throw unsupported('ZIP 条目缺少尺寸信息');
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw unsupported('暂不支持 ZIP64');
    }
    entries.push({
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      nameBytes: buffer.subarray(offset + 46, offset + 46 + nameLength),
      directoryStart: offset,
      directoryLength: 46 + nameLength + extraLength + commentLength,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function isHtmlName(nameBytes) {
  const length = nameBytes.length;
  const endsWith = text => {
    if (length < text.length) return false;
    for (let index = 0; index < text.length; index++) {
      let byte = nameBytes[length - text.length + index];
      if (byte >= 65 && byte <= 90) byte += 32;
      if (byte !== text.charCodeAt(index)) return false;
    }
    return true;
  };
  return endsWith('.html') || endsWith('.htm');
}

function isDirectoryName(nameBytes) {
  return nameBytes.length > 0 && nameBytes[nameBytes.length - 1] === 0x2f;
}

/** 在 HTML 里插入脚本引用（桌面端解压路径与移动端原地改写共用同一套规则）。 */
function applyInjectScript(content, scriptFileName) {
  if (scriptFileName === 'auto-listening.js') {
    // 听说页会在正文脚本里立刻加载 jquery.recordwave.js / exam-pc-v1.js。
    // 若仍用 createElement 异步追加，录音库可能先缓存真实 getUserMedia，
    // 后续再替换 navigator.mediaDevices 已经来不及。直接放到 body 起始处，
    // 利用普通 script 的解析阻塞语义保证假麦克风先完成接管。
    const directTag = `<script src="./${scriptFileName}"></script>`;
    if (content.includes(directTag)) return content;
    return content.replace(/<body(\s[^>]*)?>/i, bodyTag => bodyTag + directTag);
  }

  const injectCode = `var s = document.createElement('script');s.src='./${scriptFileName}';document.body.appendChild(s);`;
  if (content.includes('loadFile.load()')) {
    return content.replace(
      /\.then\s*\(\s*function\s*\(\s*\)\s*\{/g,
      '.then(function(){' + injectCode,
    );
  }
  return content.replace(/<\/body>/i, '<script>' + injectCode + '</script></body>');
}

function decompress(entry, data) {
  if (entry.method === 0) return data;
  if (entry.method === 8 || entry.method === 9) return zlib.inflateRawSync(data);
  throw unsupported(`不支持的压缩方式 ${entry.method}`);
}

function localHeader(buffer, entry) {
  const start = entry.localOffset;
  if (start + 30 > buffer.length || buffer.readUInt32LE(start) !== LOCAL_SIG) {
    throw unsupported('ZIP 条目头损坏');
  }
  const nameLength = buffer.readUInt16LE(start + 26);
  const extraLength = buffer.readUInt16LE(start + 28);
  const headerLength = 30 + nameLength + extraLength;
  const dataStart = start + headerLength;
  if (dataStart + entry.compressedSize > buffer.length) throw unsupported('ZIP 条目数据越界');
  return {header: Buffer.from(buffer.subarray(start, dataStart)), dataStart, dataEnd: dataStart + entry.compressedSize};
}

/**
 * 改写 ZIP：HTML 条目换成插入脚本后的内容（重新 deflate），其余条目原样拷贝。
 * 返回新包的 Buffer，不落盘，调用方决定写文件还是直接回响应。
 */
function rewriteZip(buffer, scripts = []) {
  const entries = readDirectory(buffer);
  const parts = [];
  const directories = [];
  let offset = 0;
  let htmlCount = 0;
  // 同一个目录下的脚本只加一份（多个 HTML 共享同一份脚本文件）。
  const addedScripts = new Set();

  for (const entry of entries) {
    const {header, dataStart, dataEnd} = localHeader(buffer, entry);
    const data = buffer.subarray(dataStart, dataEnd);
    const isHtml = isHtmlName(entry.nameBytes) && !isDirectoryName(entry.nameBytes);
    let outputHeader = header;
    let outputData = data;
    let method = entry.method;
    let crc = entry.crc;
    let compressedSize = entry.compressedSize;
    let uncompressedSize = entry.uncompressedSize;

    if (isHtml && scripts.length) {
      let html = decompress(entry, data).toString('utf8');
      for (const script of scripts) html = applyInjectScript(html, script.name);
      const encoded = Buffer.from(html, 'utf8');
      const deflated = zlib.deflateRawSync(encoded);
      method = 8;
      crc = crc32(encoded);
      compressedSize = deflated.length;
      uncompressedSize = encoded.length;
      outputData = deflated;
      htmlCount += 1;

      outputHeader = Buffer.from(header);
      outputHeader.writeUInt16LE(entry.flags & ~0x0008, 6);
      outputHeader.writeUInt16LE(method, 8);
      outputHeader.writeUInt32LE(crc, 14);
      outputHeader.writeUInt32LE(compressedSize, 18);
      outputHeader.writeUInt32LE(uncompressedSize, 22);
    } else {
      // 原样拷贝：把目录里的 crc/尺寸写回头部，去掉数据描述符标志，
      // 这样不必再去猜描述符有几位。
      outputHeader = Buffer.from(header);
      outputHeader.writeUInt16LE(entry.flags & ~0x0008, 6);
      outputHeader.writeUInt32LE(entry.crc, 14);
      outputHeader.writeUInt32LE(entry.compressedSize, 18);
      outputHeader.writeUInt32LE(entry.uncompressedSize, 22);
    }

    const newLocalOffset = offset;
    parts.push(outputHeader, outputData);
    offset += outputHeader.length + outputData.length;

    const directory = Buffer.from(buffer.subarray(entry.directoryStart, entry.directoryStart + entry.directoryLength));
    directory.writeUInt16LE(entry.flags & ~0x0008, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressedSize, 20);
    directory.writeUInt32LE(uncompressedSize, 24);
    directory.writeUInt32LE(newLocalOffset, 42);
    directories.push(directory);

    // 脚本文件和 HTML 放在同一个目录，页面里用 ./x.js 引用。
    if (isHtml && scripts.length) {
      const slash = entry.nameBytes.lastIndexOf(0x2f);
      const prefix = entry.nameBytes.subarray(0, slash + 1);
      for (const script of scripts) {
        const nameBytes = Buffer.concat([prefix, Buffer.from(script.name, 'utf8')]);
        const key = nameBytes.toString('latin1');
        if (addedScripts.has(key)) continue;
        addedScripts.add(key);

        const content = Buffer.from(script.content, 'utf8');
        const deflated = zlib.deflateRawSync(content);
        const scriptCrc = crc32(content);
        const header = Buffer.alloc(30 + nameBytes.length);
        header.writeUInt32LE(LOCAL_SIG, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(0x0800, 6);
        header.writeUInt16LE(8, 8);
        header.writeUInt32LE(scriptCrc, 14);
        header.writeUInt32LE(deflated.length, 18);
        header.writeUInt32LE(content.length, 22);
        header.writeUInt16LE(nameBytes.length, 26);
        nameBytes.copy(header, 30);

        const scriptOffset = offset;
        parts.push(header, deflated);
        offset += header.length + deflated.length;

        const directoryEntry = Buffer.alloc(46 + nameBytes.length);
        directoryEntry.writeUInt32LE(CD_SIG, 0);
        directoryEntry.writeUInt16LE(20, 4);
        directoryEntry.writeUInt16LE(20, 6);
        directoryEntry.writeUInt16LE(0x0800, 8);
        directoryEntry.writeUInt16LE(8, 10);
        directoryEntry.writeUInt32LE(scriptCrc, 16);
        directoryEntry.writeUInt32LE(deflated.length, 20);
        directoryEntry.writeUInt32LE(content.length, 24);
        directoryEntry.writeUInt16LE(nameBytes.length, 28);
        directoryEntry.writeUInt32LE(scriptOffset, 42);
        nameBytes.copy(directoryEntry, 46);
        directories.push(directoryEntry);
      }
    }
  }

  const directoryOffset = offset;
  const directoryBuffer = Buffer.concat(directories);
  const total = directories.length;
  if (total > 0xffff || directoryOffset > 0xffffffff) throw unsupported('打包结果过大');

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(total, 8);
  eocd.writeUInt16LE(total, 10);
  eocd.writeUInt32LE(directoryBuffer.length, 12);
  eocd.writeUInt32LE(directoryOffset, 16);

  return {buffer: Buffer.concat([...parts, directoryBuffer, eocd]), htmlCount};
}

module.exports = {
  applyInjectScript,
  /** 只读一次原包、只处理 HTML，返回改写后的字节，不落盘。 */
  async rewriteZipFile(sourcePath, scripts) {
    const source = await fs.readFile(sourcePath);
    const {buffer, htmlCount} = rewriteZip(source, scripts);
    return {
      buffer,
      htmlCount,
      size: buffer.length,
      md5: crypto.createHash('md5').update(buffer).digest('hex'),
    };
  },
  /** 原地注入并写盘（桌面端用；移动端直接留内存，省一次整包 base64 桥写）。 */
  async injectZipFile(sourcePath, outputPath, scripts) {
    const result = await module.exports.rewriteZipFile(sourcePath, scripts);
    await fs.promises.writeFile(outputPath, result.buffer);
    const {md5, size, htmlCount} = result;
    return {md5, size, htmlCount};
  },
  rewriteZip,
};
