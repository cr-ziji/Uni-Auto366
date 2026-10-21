/**
 * HTTP/1.1 报文解析工具（React Native / Hermes 运行时）。
 *
 * React Native 没有内置 HTTP 解析器，移动端移植版需要自己实现：
 *  - 请求/响应首部解析（头部名统一小写，`set-cookie` 保留为数组，与 Node 一致）；
 *  - `Content-Length` / `Transfer-Encoding: chunked` / 连接关闭三种正文边界；
 *  - 首部与正文的序列化。
 *
 * 所有解析函数都是「增量」的：数据不足时返回 `head: null` / `complete: false`，
 * 调用方继续喂数据即可。因此 TCP 分片（chunk 边界把首部切成两半）不会破坏解析结果。
 */
import {Buffer} from 'buffer';

export type HeaderValue = string | string[];

/** 头部表：键为小写名称。 */
export type HttpHeaders = Record<string, HeaderValue>;

export interface ParsedRequestHead {
  method: string;
  url: string;
  httpVersion: string;
  headers: HttpHeaders;
}

export interface ParsedResponseHead {
  statusCode: number;
  statusMessage: string;
  httpVersion: string;
  headers: HttpHeaders;
}

/** 正文边界类型。 */
export type BodyFraming = 'none' | 'length' | 'chunked' | 'until-close';

export interface BodyPushResult {
  /** 本次解出的正文片段。 */
  chunks: Buffer[];
  /** 正文是否已经结束。 */
  complete: boolean;
  /** 正文结束后剩余的字节（用于 keep-alive 的下一个请求）。 */
  rest: Buffer;
}

/** 首部结束标记。 */
const HEAD_END = '\r\n\r\n';

const STATUS_MESSAGES: Record<number, string> = {
  100: 'Continue',
  101: 'Switching Protocols',
  102: 'Processing',
  103: 'Early Hints',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  207: 'Multi-Status',
  208: 'Already Reported',
  226: 'IM Used',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  305: 'Use Proxy',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  418: "I'm a Teapot",
  421: 'Misdirected Request',
  422: 'Unprocessable Entity',
  423: 'Locked',
  424: 'Failed Dependency',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
  506: 'Variant Also Negotiates',
  507: 'Insufficient Storage',
  508: 'Loop Detected',
  509: 'Bandwidth Limit Exceeded',
  510: 'Not Extended',
  511: 'Network Authentication Required',
};

/** 取头部的字符串形式（数组用逗号连接）。头部名大小写不敏感。 */
export function headerValue(headers: HttpHeaders, name: string): string {
  if (!headers) {
    return '';
  }
  let value = headers[name.toLowerCase()];
  if (value === undefined || value === null) {
    value = headers[name];
  }
  if (value === undefined || value === null) {
    return '';
  }
  return Array.isArray(value) ? value.join(', ') : String(value);
}

/** 常用状态码的默认描述。 */
export function defaultStatusMessage(statusCode: number): string {
  return STATUS_MESSAGES[statusCode] || 'Unknown';
}

/** 是否为中间响应（1xx）。中间响应后面还跟着真正的响应。 */
export function isInterimStatus(statusCode: number): boolean {
  return statusCode >= 100 && statusCode < 200 && statusCode !== 101;
}

/** 解析 `Name: value` 文本行；重复的头用逗号连接，`set-cookie` 保留为数组。 */
export function parseHeaderLines(lines: string[]): HttpHeaders {
  const headers: HttpHeaders = {};
  for (const line of lines) {
    if (!line) {
      continue;
    }
    const separator = line.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    const current = headers[name];
    if (current === undefined) {
      headers[name] = name === 'set-cookie' ? [value] : value;
    } else if (Array.isArray(current)) {
      current.push(value);
    } else {
      headers[name] = `${current}, ${value}`;
    }
  }
  return headers;
}

/** 首部是否已经收全（用于区分「数据还没到」与「报文非法」）。 */
export function hasCompleteHead(buffer: Buffer): boolean {
  return buffer.indexOf(HEAD_END) >= 0;
}

/**
 * 解析请求首部。数据不足时返回 `head: null`，调用方需要继续等待。
 */
export function parseRequestHead(buffer: Buffer): {head: ParsedRequestHead | null; rest: Buffer} {
  const index = buffer.indexOf(HEAD_END);
  if (index < 0) {
    return {head: null, rest: buffer};
  }
  const lines = buffer.slice(0, index).toString('latin1').split('\r\n');
  const requestLine = lines.shift() ?? '';
  const parts = requestLine.split(' ');
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    // 首部不完整或非法，等待更多数据（最多再等一个分隔符）
    return {head: null, rest: buffer};
  }
  const head: ParsedRequestHead = {
    method: parts[0].toUpperCase(),
    url: parts[1],
    httpVersion: parts[2] || 'HTTP/1.0',
    headers: parseHeaderLines(lines),
  };
  return {head, rest: buffer.slice(index + 4)};
}

/**
 * 解析响应首部。数据不足时返回 `head: null`。
 */
export function parseResponseHead(buffer: Buffer): {head: ParsedResponseHead | null; rest: Buffer} {
  const index = buffer.indexOf(HEAD_END);
  if (index < 0) {
    return {head: null, rest: buffer};
  }
  const lines = buffer.slice(0, index).toString('latin1').split('\r\n');
  const statusLine = lines.shift() ?? '';
  const parts = statusLine.split(' ');
  const statusCode = Number(parts[1] ?? 0);
  if (!Number.isFinite(statusCode) || statusCode <= 0) {
    return {head: null, rest: buffer};
  }
  const head: ParsedResponseHead = {
    statusCode,
    statusMessage: parts.slice(2).join(' '),
    httpVersion: parts[0] || 'HTTP/1.1',
    headers: parseHeaderLines(lines),
  };
  return {head, rest: buffer.slice(index + 4)};
}

/** 请求正文的边界：请求没有长度信息时视为空正文。 */
export function resolveRequestFraming(headers: HttpHeaders): BodyFraming {
  const encoding = headerValue(headers, 'transfer-encoding').toLowerCase();
  if (encoding.includes('chunked')) {
    return 'chunked';
  }
  const length = Number(headerValue(headers, 'content-length'));
  if (Number.isFinite(length) && length > 0) {
    return 'length';
  }
  return 'none';
}

/**
 * 响应正文的边界。没有长度信息时按“连接关闭”处理（HTTP/1.0 常见）。
 */
export function resolveResponseFraming(
  headers: HttpHeaders,
  statusCode: number,
  method?: string,
): BodyFraming {
  if (method && method.toUpperCase() === 'HEAD') {
    return 'none';
  }
  if (statusCode === 204 || statusCode === 304) {
    return 'none';
  }
  const encoding = headerValue(headers, 'transfer-encoding').toLowerCase();
  if (encoding.includes('chunked')) {
    return 'chunked';
  }
  const lengthText = headerValue(headers, 'content-length');
  const length = Number(lengthText);
  if (lengthText !== '' && Number.isFinite(length) && length >= 0) {
    return 'length';
  }
  return 'until-close';
}

/** 增量 chunked 解码器。 */
export class ChunkedDecoder {
  private pending: Buffer = Buffer.alloc(0);
  private state: 'size' | 'data' | 'data-crlf' | 'trailer' | 'done' = 'size';
  private remaining = 0;

  /** 喂入数据，返回解出的正文片段、是否结束以及剩余字节。 */
  push(input: Buffer): BodyPushResult {
    this.pending = this.pending.length ? Buffer.concat([this.pending, input]) : input;
    const chunks: Buffer[] = [];
    for (;;) {
      if (this.state === 'size') {
        const index = this.pending.indexOf('\r\n');
        if (index < 0) {
          break;
        }
        const line = this.pending.slice(0, index).toString('latin1').split(';')[0].trim();
        const size = parseInt(line, 16);
        if (!Number.isFinite(size) || size < 0) {
          this.state = 'done';
          break;
        }
        this.pending = this.pending.slice(index + 2);
        this.remaining = size;
        this.state = size === 0 ? 'trailer' : 'data';
        continue;
      }
      if (this.state === 'data') {
        if (this.pending.length < this.remaining) {
          break;
        }
        chunks.push(this.pending.slice(0, this.remaining));
        this.pending = this.pending.slice(this.remaining);
        this.remaining = 0;
        this.state = 'data-crlf';
        continue;
      }
      if (this.state === 'data-crlf') {
        if (this.pending.length < 2) {
          break;
        }
        this.pending = this.pending.slice(2);
        this.state = 'size';
        continue;
      }
      if (this.state === 'trailer') {
        const index = this.pending.indexOf('\r\n');
        if (index < 0) {
          break;
        }
        const line = this.pending.slice(0, index).toString('latin1');
        this.pending = this.pending.slice(index + 2);
        if (line === '') {
          this.state = 'done';
        }
        continue;
      }
      break;
    }
    const complete = this.state === 'done';
    const rest = complete ? this.pending : Buffer.alloc(0);
    if (complete) {
      this.pending = Buffer.alloc(0);
    }
    return {chunks, complete, rest};
  }
}

/**
 * 按边界读取正文。
 *
 * `finish()` 用于连接关闭时收尾：如果边界没有被满足（例如 `Content-Length`
 * 声明了 100 字节但只收到 40 字节），`complete` 会是 `false`，调用方应当
 * 按“连接中断”处理（Node 会触发 `aborted`）。
 */
export class BodyReader {
  private readonly framing: BodyFraming;
  private readonly expected: number;
  private readonly decoder: ChunkedDecoder | null;
  private pending: Buffer = Buffer.alloc(0);
  private received = 0;
  private done = false;

  constructor(framing: BodyFraming, headers: HttpHeaders) {
    this.framing = framing;
    const length = Number(headerValue(headers, 'content-length'));
    this.expected = framing === 'length' && Number.isFinite(length) && length > 0 ? length : 0;
    this.decoder = framing === 'chunked' ? new ChunkedDecoder() : null;
  }

  /** 喂入数据，返回解出的正文片段、是否结束以及剩余字节。 */
  push(input: Buffer): BodyPushResult {
    if (this.done) {
      return {chunks: [], complete: true, rest: input};
    }
    if (this.framing === 'none') {
      this.done = true;
      return {chunks: [], complete: true, rest: input};
    }
    if (this.framing === 'length') {
      this.pending = this.pending.length ? Buffer.concat([this.pending, input]) : input;
      if (this.pending.length >= this.expected) {
        const body = this.pending.slice(0, this.expected);
        const rest = this.pending.slice(this.expected);
        this.pending = Buffer.alloc(0);
        this.received += body.length;
        this.done = true;
        return {chunks: body.length ? [body] : [], complete: true, rest};
      }
      this.received += input.length;
      return {chunks: [], complete: false, rest: Buffer.alloc(0)};
    }
    if (this.framing === 'chunked') {
      const result = this.decoder!.push(input);
      if (result.complete) {
        this.done = true;
      }
      return result;
    }
    // until-close：连接关闭前一直算正文
    this.received += input.length;
    return {chunks: input.length ? [input] : [], complete: false, rest: Buffer.alloc(0)};
  }

  /** 连接关闭时收尾。 */
  finish(): BodyPushResult {
    if (this.done) {
      return {chunks: [], complete: true, rest: Buffer.alloc(0)};
    }
    if (this.framing === 'until-close') {
      this.done = true;
      return {chunks: [], complete: true, rest: Buffer.alloc(0)};
    }
    return {chunks: [], complete: false, rest: Buffer.alloc(0)};
  }
}

function serializeHeaders(headers: HttpHeaders): string {
  const lines: string[] = [];
  for (const name of Object.keys(headers || {})) {
    const value = headers[name];
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        lines.push(`${name}: ${item}`);
      }
    } else {
      lines.push(`${name}: ${value}`);
    }
  }
  return lines.join('\r\n');
}

/** 拼装请求首部。 */
export function buildRequestHead(
  method: string,
  target: string,
  headers: HttpHeaders,
  httpVersion = 'HTTP/1.1',
): string {
  return `${method} ${target} ${httpVersion}\r\n${serializeHeaders(headers)}\r\n\r\n`;
}

/** 拼装响应首部。 */
export function buildResponseHead(
  statusCode: number,
  statusMessage: string,
  headers: HttpHeaders,
  httpVersion = 'HTTP/1.1',
): string {
  const message = statusMessage || defaultStatusMessage(statusCode);
  return `${httpVersion} ${statusCode} ${message}\r\n${serializeHeaders(headers)}\r\n\r\n`;
}

/** 把 `Buffer` / 字符串统一成 `Buffer`。 */
export function toBuffer(chunk: any, encoding: string = 'utf8'): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk === undefined || chunk === null) {
    return Buffer.alloc(0);
  }
  if (typeof chunk === 'string') {
    return Buffer.from(chunk, encoding as any);
  }
  if (chunk instanceof Uint8Array || Array.isArray(chunk)) {
    return Buffer.from(chunk as any);
  }
  return Buffer.from(String(chunk), encoding as any);
}
