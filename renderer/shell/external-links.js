/*
 * 外部链接统一交给系统默认浏览器打开。
 * --------------------------------------------------------
 * index.html 里的「项目地址 / 隐私协议」等外链是 <a target="_blank">，
 * 桌面端 Electron 会为它们新开一个应用内窗口，移动端 WebView 要么白屏、
 * 要么没反应。这里在捕获阶段拦截跨源 http(s) 链接，转交 electronAPI.openUrl：
 *
 *   - 桌面端 openUrl -> shell.openExternal（系统默认浏览器）
 *   - 移动端 openUrl -> RN shell.openExternal -> Linking（系统浏览器/应用）
 *
 * 应用自身的页面在桌面端以 file:// 加载、移动端由本地资源服务器
 * (http://127.0.0.1) 提供，它们的同源链接不会被拦截，仍走应用内跳转。
 * 没有 openUrl API 时（例如在普通浏览器里直接打开页面调试）不做任何拦截，
 * 保留 <a> 的默认行为，避免点不动。
 */

function isCrossOrigin(href, baseUrl) {
  try {
    const link = new URL(href, baseUrl);
    const current = new URL(baseUrl);
    return link.origin !== current.origin;
  } catch (error) {
    return false;
  }
}

export function initExternalLinks() {
  if (typeof document === 'undefined') return;

  document.addEventListener(
    'click',
    (event) => {
      // 只处理主键点击；带修饰键（新窗口/新标签）或已被其他脚本阻止的交给默认行为。
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target;
      const anchor = target && target.closest ? target.closest('a[href]') : null;
      if (!anchor) return;

      const href = anchor.getAttribute('href') || '';
      if (!/^https?:\/\//i.test(href)) return;
      if (!isCrossOrigin(href, window.location.href)) return;

      // 没有桥接能力时不拦截，保持浏览器里的可调试性。
      if (!window.electronAPI || typeof window.electronAPI.openUrl !== 'function') return;

      event.preventDefault();
      window.electronAPI.openUrl(href);
    },
    true,
  );
}

export default initExternalLinks;
