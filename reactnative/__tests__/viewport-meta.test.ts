/**
 * Tests of the virtual page width and of the viewport meta rewriting.
 *
 * The desktop renderer is 1400 px wide; the asset server rewrites its
 * `<meta name="viewport">` so that the WebView can fit that width onto the
 * screen - without a React Native `transform`, which used to make every
 * repaint flicker.
 */
import {buildAssetResponse, rewriteViewportMeta} from '../src/runtime/web/assetServer';
import {readVirtualWidth, withVirtualWidth} from '../src/runtime/web/virtualWidth';

describe('the virtual width query parameter', () => {
  it('adds the width to an asset URL', () => {
    expect(withVirtualWidth('http://127.0.0.1:8080/index.html', 1400)).toBe(
      'http://127.0.0.1:8080/index.html?e2rn_vw=1400',
    );
  });

  it('replaces an existing width', () => {
    expect(withVirtualWidth('http://127.0.0.1:8080/index.html?e2rn_vw=875', 1400)).toBe(
      'http://127.0.0.1:8080/index.html?e2rn_vw=1400',
    );
  });

  it('keeps the other query parameters', () => {
    expect(withVirtualWidth('http://127.0.0.1:8080/a.html?x=1&y=2', 1400)).toBe(
      'http://127.0.0.1:8080/a.html?x=1&y=2&e2rn_vw=1400',
    );
  });

  it('does not touch file or data URLs', () => {
    expect(withVirtualWidth('file:///app/index.html', 1400)).toBe('file:///app/index.html');
    expect(withVirtualWidth('data:text/html,hi', 1400)).toBe('data:text/html,hi');
  });

  it('reads the width back', () => {
    expect(readVirtualWidth('http://127.0.0.1:8080/index.html?e2rn_vw=1400')).toBe(1400);
    expect(readVirtualWidth('http://127.0.0.1:8080/index.html?x=1&e2rn_vw=875')).toBe(875);
    expect(readVirtualWidth('http://127.0.0.1:8080/index.html')).toBeNull();
    expect(readVirtualWidth('http://127.0.0.1:8080/index.html?e2rn_vw=nope')).toBeNull();
  });
});

describe('the viewport meta rewriting', () => {
  it('replaces the device-width viewport of the renderer', () => {
    const html = '<head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>';
    expect(rewriteViewportMeta(html, 1400)).toContain('content="width=1400, user-scalable=no"');
    expect(rewriteViewportMeta(html, 1400)).not.toContain('device-width');
  });

  it('keeps the rest of the document intact', () => {
    const html = '<head><title>Auto366</title></head><body><p>hi</p></body>';
    const result = rewriteViewportMeta(html, 875);
    expect(result).toContain('<title>Auto366</title>');
    expect(result).toContain('<p>hi</p>');
    expect(result).toContain('width=875');
  });

  it('is idempotent', () => {
    const once = rewriteViewportMeta('<head></head>', 1400);
    expect(rewriteViewportMeta(once, 1400)).toBe(once);
  });

  it('rewrites the HTML that is served to the WebView', () => {
    const response = buildAssetResponse('/index.html', false, 1400);
    expect(response.status).toBe(200);
    expect(response.contentType).toContain('text/html');
    expect(response.body?.toString('utf8')).toContain('width=1400');
  });

  it('serves the HTML unchanged when no width is requested', () => {
    const response = buildAssetResponse('/index.html', false);
    expect(response.body?.toString('utf8')).toContain('width=device-width');
  });

  it('does not touch non-HTML assets', () => {
    const response = buildAssetResponse('/styles/app.css', false, 1400);
    expect(response.contentType).toContain('text/css');
    expect(response.body?.toString('utf8')).not.toContain('e2rn_vw');
  });
});
