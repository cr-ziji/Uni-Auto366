/*
 * 移动端（React Native 宿主）布局交互。
 * --------------------------------------------------------
 * 桌面端把「监听日志」作为常驻的右侧面板，手机屏幕放不下左右两栏，因此
 * 移动端把它变成底部导航里的一个整屏面板：
 *
 *   - 底部导航由 `styles/mobile/app-mobile.css` 把 `.sidebar` 改造而来，
 *     `[data-mobile-view="logs"]` 这一项只在移动端显示；
 *   - 本模块只负责在 `<html>` 上切换 `data-e2rn-panel="logs"`，具体显示
 *     与隐藏全部由 CSS 完成（桌面端不会带 `data-e2rn-mobile`，因此这里的
 *     逻辑在桌面端直接返回，不会改变原有行为）；
 *   - 切换回其他视图时收起日志面板并关闭日志详情浮层。
 *
 * 注意：移动布局的开关是 asset server 注入的 `data-e2rn-mobile="1"`，
 * 不是 `data-auto366-platform`——后者由主进程的 get-platform 决定，可能
 * 因为旧版主进程缺失而拿不到。
 */

export default {
  initMobileLayout() {
    const root = document.documentElement;
    if (root.getAttribute('data-e2rn-mobile') !== '1') {
      return;
    }

    document.querySelectorAll('[data-mobile-view]').forEach(item => {
      item.addEventListener('click', () => {
        this.setMobilePanel(item.getAttribute('data-mobile-view'));
      });
    });

    // 点击任意常规导航项都先收起日志面板。navigation.js 的监听器先注册，
    // 因此这里执行时 switchView 已经完成。
    document.querySelectorAll('.sidebar__item[data-view]').forEach(item => {
      item.addEventListener('click', () => this.setMobilePanel(''));
    });

    // 其他代码路径（教程、简易模式按钮……）可能直接调用 switchView，
    // 包一层保证日志面板不会停留在已切换走的视图上。
    const state = this.state;
    if (state && typeof state.switchView === 'function' && !state.__e2rnMobilePatched) {
      const originalSwitchView = state.switchView.bind(state);
      state.switchView = (viewName, pushSimpleHistory = true) => {
        const result = originalSwitchView(viewName, pushSimpleHistory);
        this.setMobilePanel('');
        return result;
      };
      state.__e2rnMobilePatched = true;
    }

    this.setMobilePanel('');
  },

  /**
   * 在 `data-ui` 真正确定之后调用（见 app.js `initUIMode`）。
   *
   * 默认停在底部导航的第一项「监听日志」——打开应用最常看的是请求有没有
   * 进来，而不是一个空的答案页。必须等 `data-ui` 落定：`initEventListeners`
   * 早于 `initUIMode`，那时 `data-ui` 还是 HTML 里写死的 professional，
   * 直接判断会把简易模式也拖进整屏日志。
   */
  syncMobileDefaultPanel() {
    const root = document.documentElement;
    if (root.getAttribute('data-e2rn-mobile') !== '1') {
      return;
    }
    if (root.getAttribute('data-ui') === 'simple') {
      // 简易模式没有底部导航，日志是内容下方的常驻面板
      this.setMobilePanel('');
      return;
    }
    this.setMobilePanel('logs');
  },

  /** `panel === 'logs'` 时打开整屏日志面板，其余值收起。 */
  setMobilePanel(panel) {
    const root = document.documentElement;
    const logsItem = document.querySelector('[data-mobile-view="logs"]');

    if (panel === 'logs') {
      root.setAttribute('data-e2rn-panel', 'logs');
      document.querySelectorAll('.sidebar__item').forEach(item => item.classList.remove('is-active'));
      if (logsItem) logsItem.classList.add('is-active');
      return;
    }

    root.removeAttribute('data-e2rn-panel');
    if (logsItem) logsItem.classList.remove('is-active');

    if (window.app && window.app.logManager && window.app.logManager.hideRequestDetails) {
      window.app.logManager.hideRequestDetails();
    }

    const current = this.state && this.state.currentView;
    document.querySelectorAll('.sidebar__item[data-view]').forEach(item => {
      item.classList.toggle('is-active', item.getAttribute('data-view') === current);
    });
  },
};
