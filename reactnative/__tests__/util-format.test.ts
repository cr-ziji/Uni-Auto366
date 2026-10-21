import {format, formatWithOptions} from '../src/polyfills/node/util';

/**
 * `util.format()` compatibility - the desktop logging module formats every
 * record through `formatWithOptions()`, so an off-by-one in the argument
 * index silently swallows the first value of each log line.
 */
describe('util.format', () => {
  it('appends trailing arguments when the format string has no placeholder', () => {
    expect(format('导入规则集 auto-boat 失败:', 'boom')).toBe('导入规则集 auto-boat 失败: boom');
    expect(format('a', 1, 2)).toBe('a 1 2');
  });

  it('consumes placeholders from the first argument', () => {
    expect(format('%s-%s', 'a', 'b')).toBe('a-b');
    expect(format('%d items', 3)).toBe('3 items');
    expect(format('%s', 'only')).toBe('only');
    expect(format('100%%', 'x')).toBe('100% x');
  });

  it('keeps unused placeholders when arguments run out', () => {
    expect(format('%s %s', 'a')).toBe('a %s');
  });

  it('inspects objects and errors', () => {
    expect(format('%j', {a: 1})).toBe('{"a":1}');
    expect(format('err:', new Error('boom'))).toContain('boom');
  });
});

describe('util.formatWithOptions', () => {
  it('behaves like format() and honours inspect options', () => {
    expect(formatWithOptions({colors: false, depth: 4}, 'x:', {a: 1})).toBe('x: { a: 1 }');
    expect(formatWithOptions({colors: false}, 'n=%d', 42)).toBe('n=42');
  });

  it('formats the shapes the desktop logger passes', () => {
    const circular: any = {a: 1};
    circular.self = circular;
    expect(formatWithOptions({colors: false}, 'value', undefined)).toBe('value undefined');
    expect(formatWithOptions({colors: false}, 'array', [1, 2])).toBe('array [ 1, 2 ]');
    expect(typeof formatWithOptions({colors: false}, 'circular', circular)).toBe('string');
  });
});
