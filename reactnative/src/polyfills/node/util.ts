/**
 * Node `util` polyfill for React Native.
 *
 * The npm `util` package (v0.12) misses a couple of APIs that the ported
 * desktop modules rely on, therefore this module is self contained:
 *
 *   - `formatWithOptions()` - printf style formatting with `inspect` options
 *   - `TextDecoder` / `TextEncoder` - WHATWG text codecs (UTF-8, UTF-16LE/BE)
 *
 * `util` is *not* imported from the `util` bare specifier on purpose: the
 * Metro resolver may map that specifier onto this very file, and a self
 * import would create a resolution cycle.
 */
import {Buffer} from 'buffer';

/** Symbol used to customise `util.inspect()` output. */
export const custom: unique symbol = Symbol.for('nodejs.util.inspect.custom') as any;

const MAX_ARRAY_LENGTH = 100;
const MAX_STRING_LENGTH = 10000;
const BREAK_LENGTH = 128;

export function isPrimitive(value: any): boolean {
  return (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    typeof value === 'symbol' ||
    typeof value === 'bigint'
  );
}

export function isArray(value: any): boolean {
  return Array.isArray(value);
}
export function isBoolean(value: any): boolean {
  return typeof value === 'boolean';
}
export function isBuffer(value: any): boolean {
  return Buffer.isBuffer(value);
}
export function isDate(value: any): boolean {
  return value instanceof Date;
}
export function isError(value: any): boolean {
  return value instanceof Error;
}
export function isFunction(value: any): boolean {
  return typeof value === 'function';
}
export function isNull(value: any): boolean {
  return value === null;
}
export function isNumber(value: any): boolean {
  return typeof value === 'number';
}
export function isObject(value: any): boolean {
  return value !== null && typeof value === 'object';
}
export function isRegExp(value: any): boolean {
  return value instanceof RegExp;
}
export function isString(value: any): boolean {
  return typeof value === 'string';
}
export function isSymbol(value: any): boolean {
  return typeof value === 'symbol';
}
export function isUndefined(value: any): boolean {
  return value === undefined;
}
export function isPrimitiveType(value: any): boolean {
  return isPrimitive(value);
}

/** Legacy `util.isNullOrUndefined()`. */
export function isNullOrUndefined(value: any): boolean {
  return value === null || value === undefined;
}

/**
 * `util.log()` - timestamped console output. Deprecated in Node but still
 * used by a few desktop-era packages.
 */
export function log(...args: any[]): void {
  console.log(`${new Date().toISOString().slice(0, 19).replace('T', ' ')} - ${(format as any)(...args)}`);
}

/** Legacy `util._extend()` - a shallow `Object.assign` for two objects. */
export function _extend(target: any, source: any): any {
  if (source) {
    for (const key of Object.keys(source)) {
      target[key] = source[key];
    }
  }
  return target;
}

/** Structural equality check (a pragmatic subset of `isDeepStrictEqual`). */
export function isDeepStrictEqual(a: any, b: any): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (a instanceof RegExp || b instanceof RegExp) {
    return String(a) === String(b);
  }
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) {
    return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) {
      return false;
    }
    for (const [key, value] of a) {
      if (!b.has(key) || !isDeepStrictEqual(value, b.get(key))) {
        return false;
      }
    }
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) {
      return false;
    }
    for (const value of a) {
      if (!b.has(value)) {
        return false;
      }
    }
    return true;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !isDeepStrictEqual(a[key], b[key])) {
      return false;
    }
  }
  return true;
}

function quoteString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, char => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
  return `'${escaped}'`;
}

export interface InspectOptions {
  depth?: number;
  showHidden?: boolean;
  showProxy?: boolean;
  compact?: boolean | number;
  breakLength?: number;
  maxArrayLength?: number;
  maxStringLength?: number;
  sorted?: boolean;
  getters?: boolean;
  numericSeparator?: boolean;
  /** Accepted for API compatibility - the RN console has no ANSI colours. */
  colors?: boolean;
}

/**
 * A pragmatic `util.inspect()` implementation.
 *
 * The output follows Node's general shape (`{ key: value }`, `[ 1, 2 ]`,
 * `<Buffer 01 02>`) but is not byte identical - the desktop modules only use
 * it for logging.
 */
export function inspect(value: any, options?: InspectOptions | number): string {
  const opts: InspectOptions =
    typeof options === 'number' ? {depth: options} : {...(options ?? {})};
  const depth = opts.depth ?? 2;
  const breakLength = opts.breakLength ?? BREAK_LENGTH;
  void breakLength;
  const compact = opts.compact ?? 3;
  const seen = new WeakSet<object>();

  const indentOf = (level: number): string => ' '.repeat(level * 2);

  function format(valueToFormat: any, level: number, compactMode: boolean): string {
    if (valueToFormat === null) {
      return 'null';
    }
    if (valueToFormat === undefined) {
      return 'undefined';
    }
    const type = typeof valueToFormat;
    if (type === 'string') {
      const text = valueToFormat as string;
      if (text.length > MAX_STRING_LENGTH) {
        return `${quoteString(text.slice(0, MAX_STRING_LENGTH))}... ${text.length - MAX_STRING_LENGTH} more characters`;
      }
      return quoteString(text);
    }
    if (type === 'number') {
      return Object.is(valueToFormat, -0) ? '-0' : String(valueToFormat);
    }
    if (type === 'boolean') {
      return String(valueToFormat);
    }
    if (type === 'bigint') {
      return `${valueToFormat}n`;
    }
    if (type === 'symbol') {
      return String(valueToFormat);
    }
    if (type === 'function') {
      const name = (valueToFormat as any).name;
      return name ? `[Function: ${name}]` : '[Function (anonymous)]';
    }

    if (valueToFormat instanceof Error) {
      const stack = valueToFormat.stack ?? `${valueToFormat.name}: ${valueToFormat.message}`;
      return stack;
    }
    if (Buffer.isBuffer(valueToFormat)) {
      const buffer = valueToFormat as Buffer;
      if (buffer.length === 0) {
        return '<Buffer 00 00 00 00 00 00 00 00 ... 0 more bytes>';
      }
      const head = Array.from(buffer.subarray(0, 50))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join(' ');
      const extra = buffer.length > 50 ? ` ... ${buffer.length - 50} more bytes` : '';
      return `<Buffer ${head}${extra}>`;
    }
    if (valueToFormat instanceof Date) {
      return valueToFormat.toISOString();
    }
    if (valueToFormat instanceof RegExp) {
      return String(valueToFormat);
    }

    if (typeof (valueToFormat as any)[custom] === 'function') {
      const customResult = (valueToFormat as any)[custom](depth, opts, format);
      if (typeof customResult === 'string') {
        return customResult;
      }
    }

    if (seen.has(valueToFormat)) {
      return '[Circular *1]';
    }
    seen.add(valueToFormat);

    try {
      if (Array.isArray(valueToFormat)) {
        const items = valueToFormat
          .slice(0, opts.maxArrayLength ?? MAX_ARRAY_LENGTH)
          .map(item => format(item, level + 1, compactMode));
        if (valueToFormat.length > (opts.maxArrayLength ?? MAX_ARRAY_LENGTH)) {
          items.push(`... ${valueToFormat.length - (opts.maxArrayLength ?? MAX_ARRAY_LENGTH)} more items`);
        }
        if (items.length === 0) {
          return '[]';
        }
        if (compactMode) {
          return `[ ${items.join(', ')} ]`;
        }
        const pad = indentOf(level + 1);
        return `[\n${items.map(item => `${pad}${item}`).join(',\n')}\n${indentOf(level)}]`;
      }

      if (valueToFormat instanceof Map) {
        const entries: string[] = [];
        for (const [key, entry] of valueToFormat) {
          entries.push(`${format(key, level + 1, compactMode)} => ${format(entry, level + 1, compactMode)}`);
        }
        if (entries.length === 0) {
          return 'Map(0) {}';
        }
        return `Map(${valueToFormat.size}) {${entries.join(', ')}}`;
      }

      if (valueToFormat instanceof Set) {
        const entries = Array.from(valueToFormat).map(item => format(item, level + 1, compactMode));
        if (entries.length === 0) {
          return 'Set(0) {}';
        }
        return `Set(${valueToFormat.size}) {${entries.join(', ')}}`;
      }

      if (valueToFormat instanceof Promise) {
        return 'Promise { <pending> }';
      }

      const keys = Object.keys(valueToFormat);
      if (opts.sorted) {
        keys.sort();
      }
      const entries = keys.map(key => {
        let entry: string;
        try {
          entry = format(valueToFormat[key], level + 1, compactMode);
        } catch {
          entry = '[Getter]';
        }
        const keyText = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : quoteString(key);
        return `${keyText}: ${entry}`;
      });
      const name = (valueToFormat as any).constructor?.name;
      const prefix = name && name !== 'Object' ? `${name} ` : '';
      if (entries.length === 0) {
        return `${prefix}{}`;
      }
      if (compactMode) {
        return `${prefix}{ ${entries.join(', ')} }`;
      }
      const pad = indentOf(level + 1);
      return `${prefix}{\n${entries.map(entry => `${pad}${entry}`).join(',\n')}\n${indentOf(level)}}`;
    } finally {
      seen.delete(valueToFormat);
    }
  }

  const compactMode = compact === true || compact === 3 || compact === 1;
  return format(value, 0, compactMode);
}

/** Node's `util.format()` (printf style). */
export function format(f: any, ...args: any[]): string {
  if (typeof f !== 'string') {
    const items = [f, ...args];
    return items.map(item => (isPrimitive(item) ? String(item) : inspect(item))).join(' ');
  }

  // `args` already excludes the format string, so the first placeholder
  // consumes `args[0]` (Node slices the format string off before counting).
  let index = 0;
  let str = String(f).replace(/%[sdifjoO%]/g, token => {
    if (token === '%%') {
      return '%';
    }
    if (index >= args.length) {
      return token;
    }
    const arg = args[index];
    index += 1;
    switch (token) {
      case '%s':
        if (typeof arg === 'bigint') {
          return `${arg}n`;
        }
        if (typeof arg === 'symbol') {
          return arg.toString();
        }
        return typeof arg === 'object' && arg !== null ? inspect(arg, {depth: 0, compact: true}) : String(arg);
      case '%d':
        return String(Number(arg));
      case '%i':
        return String(parseInt(arg, 10));
      case '%f':
        return String(Number(arg));
      case '%j':
        try {
          return JSON.stringify(arg) ?? 'undefined';
        } catch {
          return '[Circular]';
        }
      case '%o':
      case '%O':
        return inspect(arg, {depth: 4, showHidden: token === '%o'});
      default:
        return token;
    }
  });

  for (const arg of args.slice(index)) {
    const primitive =
      arg === null ||
      arg === undefined ||
      typeof arg === 'string' ||
      typeof arg === 'number' ||
      typeof arg === 'bigint' ||
      typeof arg === 'boolean' ||
      typeof arg === 'symbol';
    str += primitive ? ` ${String(arg)}` : ` ${inspect(arg)}`;
  }
  return str;
}

/** `util.format()` with explicit `util.inspect()` options. */
export function formatWithOptions(options: InspectOptions | undefined, f: any, ...args: any[]): string {
  if (typeof f !== 'string') {
    const items = [f, ...args];
    return items.map(item => (isPrimitive(item) ? String(item) : inspect(item, options))).join(' ');
  }
  // See `format()`: `args` excludes the format string, so start at 0.
  let index = 0;
  let str = String(f).replace(/%[sdifjoO%]/g, token => {
    if (token === '%%') {
      return '%';
    }
    if (index >= args.length) {
      return token;
    }
    const arg = args[index];
    index += 1;
    switch (token) {
      case '%s':
        if (typeof arg === 'bigint') {
          return `${arg}n`;
        }
        if (typeof arg === 'symbol') {
          return arg.toString();
        }
        return typeof arg === 'object' && arg !== null ? inspect(arg, options) : String(arg);
      case '%d':
        return String(Number(arg));
      case '%i':
        return String(parseInt(arg, 10));
      case '%f':
        return String(Number(arg));
      case '%j':
        try {
          return JSON.stringify(arg) ?? 'undefined';
        } catch {
          return '[Circular]';
        }
      case '%o':
      case '%O':
        return inspect(arg, {...options, depth: options?.depth ?? 4, showHidden: token === '%o'});
      default:
        return token;
    }
  });
  for (const arg of args.slice(index)) {
    str += ` ${isPrimitive(arg) ? String(arg) : inspect(arg, options)}`;
  }
  return str;
}

/** Promisifies a node style callback function. */
export function promisify<T = any>(fn: (...args: any[]) => any): (...args: any[]) => Promise<T> {
  return function promisified(this: any, ...args: any[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      fn.call(this, ...args, (error: any, ...values: any[]) => {
        if (error) {
          reject(error);
        } else {
          resolve(values.length > 1 ? values : values[0]);
        }
      });
    });
  };
}

/** Converts an async function into a node style callback function. */
export function callbackify(fn: (...args: any[]) => Promise<any>): (...args: any[]) => void {
  return function callbackified(this: any, ...args: any[]): void {
    const callback = args.pop();
    Promise.resolve(fn.apply(this, args)).then(
      value => callback(null, value),
      error => callback(error ?? new Error('Promise rejected')),
    );
  };
}

/** Classic Node inheritance helper. */
export function inherits(constructor: any, superConstructor: any): void {
  if (!constructor || !superConstructor) {
    return;
  }
  Object.setPrototypeOf(constructor.prototype, superConstructor.prototype);
  Object.setPrototypeOf(constructor, superConstructor);
}

/** Wraps a function and prints a deprecation warning once. */
export function deprecate<T extends (...args: any[]) => any>(fn: T, message: string): T {
  let warned = false;
  const wrapped = function (this: any, ...args: any[]): any {
    if (!warned) {
      warned = true;
      console.warn(`[e2rn] DeprecationWarning: ${message}`);
    }
    return fn.apply(this, args);
  };
  return wrapped as unknown as T;
}

/** Minimal `util.debug()` implementation. */
export function debug(section: string): (...args: any[]) => void {
  return (...args: any[]) => {
    console.log(`[${section}]`, ...args);
  };
}

/**
 * `util.debuglog(section)` - returns a logger that only writes when the
 * section is enabled through `NODE_DEBUG`. Packages such as
 * `readable-stream` call it at import time, so it must exist.
 */
export function debuglog(section: string): (...args: any[]) => void {
  const enabled = String((globalThis as any).process?.env?.NODE_DEBUG || '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .some(name => section.toLowerCase().startsWith(name.toLowerCase()));
  const logger = (...args: any[]) => {
    if (enabled) {
      console.error(`${section.toUpperCase()} ${Date.now()}: ${(format as any)(...args)}`);
    }
  };
  return logger as any;
}

/** Type introspection helpers (subset). */
export const types: Record<string, any> = new Proxy(
  {
    isDate: isDate,
    isRegExp: isRegExp,
    isMap: (value: any) => value instanceof Map,
    isSet: (value: any) => value instanceof Set,
    isPromise: (value: any) => value instanceof Promise,
    isProxy: (_value: any) => false,
    isTypedArray: (value: any) => ArrayBuffer.isView(value) && !(value instanceof DataView),
    isArrayBuffer: (value: any) => value instanceof ArrayBuffer,
    isNativeError: isError,
    isBoxedPrimitive: (value: any) => value instanceof Number || value instanceof String || value instanceof Boolean,
  } as Record<string, any>,
  {
    // `util.types` is a Proxy on Node too: `isUint8Array`, `isBigInt64Array`,
    // ... are resolved lazily. Packages (`readable-stream`, ...) probe for
    // members we do not list explicitly.
    get(target, property) {
      if (property in target) {
        return target[property as string];
      }
      if (typeof property === 'string' && property.startsWith('is') && property.length > 2) {
        const constructor = (globalThis as any)[property.slice(2)];
        if (typeof constructor === 'function') {
          return (value: any) => value instanceof constructor;
        }
      }
      return undefined;
    },
  },
);

export const inspectCustom: symbol = custom;

/* -------------------------------------------------------------------------- */
/* Text codecs                                                                */
/* -------------------------------------------------------------------------- */

export interface TextDecoderOptions {
  fatal?: boolean;
  ignoreBOM?: boolean;
}

function decodeUtf8(bytes: Uint8Array, fatal: boolean): string {
  let result = '';
  let index = 0;

  const invalid = (): never => {
    if (fatal) {
      throw new TypeError('The encoded data was not valid for encoding utf-8');
    }
    result += '\uFFFD';
    return undefined as never;
  };

  while (index < bytes.length) {
    const byte = bytes[index];
    if (byte < 0x80) {
      result += String.fromCharCode(byte);
      index += 1;
      continue;
    }
    if (byte >= 0xc2 && byte <= 0xdf) {
      const next = bytes[index + 1];
      if (next === undefined || (next & 0xc0) !== 0x80) {
        invalid();
      }
      result += String.fromCharCode(((byte & 0x1f) << 6) | (next & 0x3f));
      index += 2;
      continue;
    }
    if (byte >= 0xe0 && byte <= 0xef) {
      const next = bytes[index + 1];
      const third = bytes[index + 2];
      if (next === undefined || third === undefined || (next & 0xc0) !== 0x80 || (third & 0xc0) !== 0x80) {
        invalid();
      }
      if (byte === 0xe0 && next < 0xa0) {
        invalid();
      }
      if (byte === 0xed && next >= 0xa0) {
        invalid();
      }
      result += String.fromCharCode(((byte & 0x0f) << 12) | ((next & 0x3f) << 6) | (third & 0x3f));
      index += 3;
      continue;
    }
    if (byte >= 0xf0 && byte <= 0xf4) {
      const next = bytes[index + 1];
      const third = bytes[index + 2];
      const fourth = bytes[index + 3];
      if (
        next === undefined ||
        third === undefined ||
        fourth === undefined ||
        (next & 0xc0) !== 0x80 ||
        (third & 0xc0) !== 0x80 ||
        (fourth & 0xc0) !== 0x80
      ) {
        invalid();
      }
      if (byte === 0xf0 && next < 0x90) {
        invalid();
      }
      if (byte === 0xf4 && next >= 0x90) {
        invalid();
      }
      const codePoint = ((byte & 0x07) << 18) | ((next & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f);
      result += String.fromCodePoint(codePoint);
      index += 4;
      continue;
    }
    invalid();
  }
  return result;
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean, fatal: boolean): string {
  let result = '';
  let index = 0;
  while (index + 1 < bytes.length) {
    const unit = littleEndian ? bytes[index] | (bytes[index + 1] << 8) : (bytes[index] << 8) | bytes[index + 1];
    index += 2;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 < bytes.length) {
        const low = littleEndian ? bytes[index] | (bytes[index + 1] << 8) : (bytes[index] << 8) | bytes[index + 1];
        if (low >= 0xdc00 && low <= 0xdfff) {
          index += 2;
          result += String.fromCharCode(unit, low);
          continue;
        }
      }
      if (fatal) {
        throw new TypeError('The encoded data was not valid for encoding utf-16');
      }
      result += '\uFFFD';
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      if (fatal) {
        throw new TypeError('The encoded data was not valid for encoding utf-16');
      }
      result += '\uFFFD';
      continue;
    }
    result += String.fromCharCode(unit);
  }
  if (index < bytes.length) {
    if (fatal) {
      throw new TypeError('The encoded data was not valid for encoding utf-16');
    }
    result += '\uFFFD';
  }
  return result;
}

/** WHATWG compatible text decoder (UTF-8, UTF-16LE, UTF-16BE, Latin-1). */
export class TextDecoder {
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;

  constructor(encoding: string = 'utf-8', options: TextDecoderOptions = {}) {
    const normalized = String(encoding).toLowerCase().replace(/[_\s]/g, '-');
    this.encoding = normalized;
    this.fatal = options.fatal === true;
    this.ignoreBOM = options.ignoreBOM === true;
  }

  decode(input?: ArrayBuffer | ArrayBufferView | string): string {
    if (input === undefined) {
      return '';
    }
    let bytes: Uint8Array;
    if (typeof input === 'string') {
      bytes = new Uint8Array(Buffer.from(input, 'utf8'));
    } else if (ArrayBuffer.isView(input)) {
      bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    } else {
      bytes = new Uint8Array(input);
    }

    let text: string;
    switch (this.encoding) {
      case 'utf-8':
      case 'utf8':
        text = decodeUtf8(bytes, this.fatal);
        break;
      case 'utf-16le':
      case 'utf-16':
        text = decodeUtf16(bytes, true, this.fatal);
        break;
      case 'utf-16be':
        text = decodeUtf16(bytes, false, this.fatal);
        break;
      case 'latin1':
      case 'binary':
      case 'iso-8859-1':
        text = Array.from(bytes).map(byte => String.fromCharCode(byte)).join('');
        break;
      default:
        throw new RangeError(`The encoding label provided ('${this.encoding}') is invalid`);
    }

    if (!this.ignoreBOM && text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }
    return text;
  }
}

/** WHATWG compatible text encoder (UTF-8 only). */
export class TextEncoder {
  readonly encoding: string = 'utf-8';

  encode(input: string = ''): Uint8Array {
    return new Uint8Array(Buffer.from(String(input), 'utf8'));
  }
}

const util = {
  format,
  formatWithOptions,
  inspect,
  promisify,
  callbackify,
  inherits,
  deprecate,
  debug,
  debuglog,
  log,
  _extend,
  isArray,
  isBoolean,
  isBuffer,
  isDate,
  isError,
  isFunction,
  isNull,
  isNullOrUndefined,
  isNumber,
  isObject,
  isPrimitive,
  isRegExp,
  isString,
  isSymbol,
  isUndefined,
  isDeepStrictEqual,
  types,
  TextDecoder,
  TextEncoder,
  custom,
};

export default util;
