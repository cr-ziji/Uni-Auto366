/**
 * `archiver` polyfill 的接线测试。
 *
 * 移动端不再在 JS 里打包：`finalize()` 把目录交给 `react-native-nitro-unzip`
 * 直接写目标文件。这里盯住三件容易回归的事：
 *
 *   1. 传给原生的参数是（源目录，目标 zip 路径）；
 *   2. 打包结果不会被目标流的"空 flush"覆盖成 0 字节 —— 之前 fflate 版本就
 *      栽在这类"看起来成功、产物是空的"问题上，repackZip 靠 22 字节判空兜底；
 *   3. 不支持的形状（append / 带前缀的 directory）明确报错，而不是悄悄退回
 *      内存打包。
 */
const mockZip = jest.fn();

jest.mock('react-native-nitro-unzip', () => ({
  getUnzip: () => ({
    zip: mockZip,
    extract: jest.fn(),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const archiver = require('../src/polyfills/node/archiver');
// eslint-disable-next-line import/first
import * as fsPoly from '../src/polyfills/node/fs';

const dir = '/tmp/Auto366/documents/archiver-native';
const outputPath = `${dir}/out.zip`;

/** 原生模块会直接写目标文件，这里用一个固定内容模拟它的产物。 */
const NATIVE_ARTIFACT = 'PK\u0003\u0004native-pack-result';

/** 原生返回的是可 await 的任务对象，形状要和真模块一致。 */
function task(result: {success: boolean}, write?: () => Promise<void>) {
  return {
    taskId: 'test-task',
    onProgress() {},
    cancel() {},
    await: async () => {
      if (write) {
        await write();
      }
      return result;
    },
  };
}

beforeEach(async () => {
  mockZip.mockReset();
  await fsPoly.promises.mkdir(dir, {recursive: true});
  await fsPoly.promises.writeFile(`${dir}/index.html`, '<html>injected</html>', 'utf8');
  mockZip.mockImplementation((_source: string, destination: string) =>
    task({success: true}, () => fsPoly.promises.writeFile(destination, NATIVE_ARTIFACT, 'utf8')),
  );
});

function repack(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
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

describe('archiver polyfill（原生打包）', () => {
  it('把目录和目标路径交给原生，并保留原生写出的内容', async () => {
    await repack();

    expect(mockZip).toHaveBeenCalledTimes(1);
    expect(mockZip).toHaveBeenCalledWith(dir, outputPath);

    // 目标流一个字节都没收到，不能把原生写好的包覆盖成空文件
    const written = await fsPoly.promises.readFile(outputPath, 'utf8');
    expect(written).toBe(NATIVE_ARTIFACT);
  });

  it('原生报告失败时 finalize 抛错', async () => {
    mockZip.mockImplementation(() => task({success: false}));
    await expect(repack()).rejects.toThrow(/打包失败/);
  });

  it('不支持的形状明确报错', async () => {
    const archive = archiver('zip');
    expect(() => archive.append('x', {name: 'a.txt'})).toThrow(/append/);

    const prefixed = archiver('zip');
    prefixed.directory(dir, 'sub');
    await expect(prefixed.finalize()).rejects.toThrow(/directory\(dir, false\)/);
  });
});
