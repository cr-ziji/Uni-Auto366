/**
 * Jest configuration for the E2RN host.
 *
 * The tests run the polyfills of `src/polyfills/node` against mocked native
 * modules, therefore the packages that ship untranspiled sources have to be
 * transformed by Babel as well.
 */
module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: ['<rootDir>/jest.setup.js'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transformIgnorePatterns: [
    'node_modules/(?!(?:@react-native|react-native|react-native-fs|react-native-webview|react-native-url-polyfill|@react-native-community)/)',
  ],
  moduleNameMapper: {
    // The ModuleMapper of `metro.config.js` is not active in Jest.
    '^electron$': '<rootDir>/src/shims/electron/index.ts',
    '^@e2rn/electron$': '<rootDir>/src/shims/electron/index.ts',
    '^node:fs$': '<rootDir>/src/polyfills/node/fs.ts',
    '^node:path$': 'path-browserify',
    '^node:os$': '<rootDir>/src/polyfills/node/os.ts',
    '^node:crypto$': '<rootDir>/src/polyfills/node/crypto.ts',
    '^node:http$': '<rootDir>/src/polyfills/node/http.ts',
    '^node:https$': '<rootDir>/src/polyfills/node/https.ts',
    '^node:zlib$': '<rootDir>/src/polyfills/node/zlib.ts',
    '^node:util$': '<rootDir>/src/polyfills/node/util.ts',
    '^node:url$': '<rootDir>/src/polyfills/node/url.ts',
    '^node:events$': 'events',
    '^node:buffer$': 'buffer',
    '^node:stream$': 'stream-browserify',
    // 原生模块在 Node 里没有实现：zlib 用 Node 自带 zlib 顶上（语义一致），
    // 打包/解压则换成会明确报错的替身，由需要的用例自行 jest.mock。
    '^react-native-nitro-zlib$': '<rootDir>/__mocks__/nitro-zlib.ts',
    '^react-native-nitro-unzip$': '<rootDir>/__mocks__/nitro-unzip.ts',
    // The original Electron sources live outside `rootDir`; Babel injects
    // `@babel/runtime` helpers there and Jest cannot resolve them from that
    // folder (Metro maps them explicitly, see metro.config.js).
    '^@babel/runtime/(.*)$': '<rootDir>/node_modules/@babel/runtime/$1',
  },
  testPathIgnorePatterns: ['/node_modules/', '/android/', '/ios/'],
};
