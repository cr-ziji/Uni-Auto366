/**
 * The virtual page width of a window.
 *
 * The desktop renderer is designed for a fixed width (1400 px in the
 * "professional" mode, 875 px in the "simple" mode). Instead of scaling the
 * WebView with a React Native `transform` - which keeps the *unscaled* layer
 * in memory and makes every repaint flicker - the width is declared to the
 * page through its viewport meta tag. The asset server reads the width from
 * this query parameter and rewrites `<meta name="viewport">` before the HTML
 * is handed to the WebView.
 *
 * The module is intentionally free of any dependency (no `react-native`, no
 * `buffer`) so that it can be unit tested and imported from anywhere.
 */

/** Query parameter that carries the virtual page width to the asset server. */
export const VIRTUAL_WIDTH_PARAM = 'e2rn_vw';

/**
 * Adds (or replaces) the virtual width query parameter of an asset URL.
 *
 * Only `http(s)` URLs are touched - the `file://` URL that the renderer sees
 * (`event.senderFrame.url`) must stay exactly as the desktop application
 * expects it.
 */
export function withVirtualWidth(url: string, virtualWidth: number): string {
  if (!url || !/^https?:/i.test(url)) {
    return url;
  }
  const width = Math.max(Math.round(virtualWidth || 0), 0);
  if (!width) {
    return url;
  }
  const hashIndex = url.indexOf('#');
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = withoutHash.indexOf('?');
  const path = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const query = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : '';
  const params = query
    .split('&')
    .filter(part => part && !part.startsWith(`${VIRTUAL_WIDTH_PARAM}=`));
  params.push(`${VIRTUAL_WIDTH_PARAM}=${width}`);
  return `${path}?${params.join('&')}`;
}

/** Reads the virtual width of an asset URL (`?e2rn_vw=1400`). */
export function readVirtualWidth(url: string): number | null {
  const value = String(url ?? '');
  const queryIndex = value.indexOf('?');
  if (queryIndex < 0) {
    return null;
  }
  const query = value.slice(queryIndex + 1).split('#')[0];
  for (const part of query.split('&')) {
    const separator = part.indexOf('=');
    const key = separator >= 0 ? part.slice(0, separator) : part;
    if (key !== VIRTUAL_WIDTH_PARAM) {
      continue;
    }
    const raw = separator >= 0 ? part.slice(separator + 1) : '';
    const width = Number.parseInt(decodeURIComponent(raw), 10);
    return Number.isFinite(width) && width > 0 ? width : null;
  }
  return null;
}

export default {VIRTUAL_WIDTH_PARAM, withVirtualWidth, readVirtualWidth};
