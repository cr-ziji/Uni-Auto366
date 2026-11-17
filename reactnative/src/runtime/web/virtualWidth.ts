/**
 * The virtual page width of a window, and the mobile layout switch.
 *
 * The desktop renderer is designed for a fixed width (1400 px in the
 * "professional" mode, 875 px in the "simple" mode). Instead of scaling the
 * WebView with a React Native `transform` - which keeps the *unscaled* layer
 * in memory and makes every repaint flicker - the width is declared to the
 * page through its viewport meta tag. The asset server reads the width from
 * this query parameter and rewrites `<meta name="viewport">` before the HTML
 * is handed to the WebView.
 *
 * A phone must not scale the desktop page at all: the renderer ships a real
 * responsive layout (`styles/mobile/app-mobile.css`) that is enabled by the
 * `e2rn_mobile` query parameter. The asset server then keeps
 * `width=device-width` and adds `data-e2rn-mobile="1"` to the document, which
 * scopes every mobile rule. The desktop build never sends the parameter, so
 * its markup and CSS stay untouched.
 *
 * The module is intentionally free of any dependency (no `react-native`, no
 * `buffer`) so that it can be unit tested and imported from anywhere.
 */

/** Query parameter that carries the virtual page width to the asset server. */
export const VIRTUAL_WIDTH_PARAM = 'e2rn_vw';

/** Query parameter that switches the page to the responsive mobile layout. */
export const MOBILE_PARAM = 'e2rn_mobile';

interface AssetUrlParts {
  path: string;
  params: string[];
  hash: string;
}

/**
 * Splits a URL (absolute or the relative request target of the asset server)
 * into path, query parameters and hash.
 */
function splitAssetUrl(url: string): AssetUrlParts | null {
  if (!url) {
    return null;
  }
  const hashIndex = url.indexOf('#');
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = withoutHash.indexOf('?');
  const path = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const query = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : '';
  const params = query.split('&').filter(Boolean);
  return {path, params, hash};
}

/** Joins the parts of an asset URL back together. */
function joinAssetUrl(parts: AssetUrlParts): string {
  const query = parts.params.join('&');
  return `${parts.path}${query ? `?${query}` : ''}${parts.hash}`;
}

/** Reads a query parameter of a URL, or `null` when it is absent. */
function readAssetParam(url: string, name: string): string | null {
  const parts = splitAssetUrl(url);
  if (!parts) {
    return null;
  }
  for (const part of parts.params) {
    const separator = part.indexOf('=');
    const key = separator >= 0 ? part.slice(0, separator) : part;
    if (key !== name) {
      continue;
    }
    return separator >= 0 ? decodeURIComponent(part.slice(separator + 1)) : '';
  }
  return null;
}

/**
 * Replaces (or removes, when `value` is null) a query parameter of an
 * `http(s)` URL. Other schemes are returned unchanged - the `file://` URL
 * that the renderer sees (`event.senderFrame.url`) must stay exactly as the
 * desktop application expects it.
 */
function withAssetParam(url: string, name: string, value: string | null): string {
  if (!url || !/^https?:/i.test(url)) {
    return url;
  }
  const parts = splitAssetUrl(url);
  if (!parts) {
    return url;
  }
  parts.params = parts.params.filter(part => {
    const separator = part.indexOf('=');
    const key = separator >= 0 ? part.slice(0, separator) : part;
    return key !== name;
  });
  if (value !== null) {
    parts.params.push(`${name}=${encodeURIComponent(value)}`);
  }
  return joinAssetUrl(parts);
}

/** Adds (or replaces) the virtual width query parameter of an asset URL. */
export function withVirtualWidth(url: string, virtualWidth: number): string {
  const width = Math.max(Math.round(virtualWidth || 0), 0);
  if (!width) {
    return url;
  }
  return withAssetParam(url, VIRTUAL_WIDTH_PARAM, String(width));
}

/** Reads the virtual width of a URL (`?e2rn_vw=1400`). */
export function readVirtualWidth(url: string): number | null {
  const raw = readAssetParam(String(url ?? ''), VIRTUAL_WIDTH_PARAM);
  if (raw === null) {
    return null;
  }
  const width = Number.parseInt(raw, 10);
  return Number.isFinite(width) && width > 0 ? width : null;
}

/**
 * Adds (or removes) the mobile layout switch of an asset URL.
 *
 * `false` strips the parameter again - a stale `e2rn_mobile=1` must not
 * survive a switch back to the scaled desktop layout.
 */
export function withMobileLayout(url: string, mobile: boolean): string {
  return withAssetParam(url, MOBILE_PARAM, mobile ? '1' : null);
}

/** `true` when the URL asks for the responsive mobile layout. */
export function isMobileLayout(url: string): boolean {
  const raw = readAssetParam(String(url ?? ''), MOBILE_PARAM);
  return raw === '1' || raw === 'true';
}

export default {
  VIRTUAL_WIDTH_PARAM,
  MOBILE_PARAM,
  withVirtualWidth,
  readVirtualWidth,
  withMobileLayout,
  isMobileLayout,
};
