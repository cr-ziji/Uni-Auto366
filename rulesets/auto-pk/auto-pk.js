/*
 * 单词 PK 自动作答脚本（选择题模式）
 * ------------------------------------------------------------
 * 页面 DOM：
 *   题目：.u3-pk-core__cn
 *   选项：.u3-pk-core__word > .u3-pk-core__text
 *
 * 页面是 Vue 2，PKCore 组件的根节点 .u3-pk-core 上挂着 __vue__。
 * 组件里的 vm.word 就是当前题目的完整数据，直接包含正确答案：
 *
 *   vm.en2cn === false : 题目中文，选项英文，正确答案 = vm.word.en
 *   vm.en2cn === true  : 题目英文，选项中文，正确答案 = vm.word.cn
 *
 * 因此不再自己维护词库、不再做相似度评分，也不复制页面里的 D() 函数。
 * 直接从组件读取答案，再找到文字完全一致的选项点击。
 *
 * 控制台：
 *   页面右下角浮动面板，可鼠标拖拽，也可触控拖拽（Pointer/Touch 都支持）。
 *   面板可以：
 *     - 显示作答日志（作答结果、正误、异常）
 *     - 控制正确率（0~100%，未命中时随机点一个错误选项）
 *     - 控制间隔（题目出现后等待多久再作答）
 *     - 跳过动画（默认关闭）：缩短页面作答动画，并提前收掉 +1 飘字/错误提示，
 *       让下一题更快出现；不影响正常答题逻辑，关闭后立即恢复页面原有动画。
 *     - 提交时间（默认关闭）：把“提交用时”推给本地服务，由代理层在提交时改写
 *       submitJson.duration 与 wordInfos[].answerTime，改包逻辑见
 *       modules/proxy/time-modifier.js（applyPkTimeMod）。
 *     - 开始/停止、折叠、隐藏（隐藏后右下角保留一个小圆钮）
 *
 * 控制台 API：
 *   AutoPk.stop() / AutoPk.start()     停止 / 开始
 *   AutoPk.setAccuracy(80)             设置正确率百分比
 *   AutoPk.setIntervalMs(200)          设置作答间隔（毫秒）
 *   AutoPk.setSkipAnim(true)           开启 / 关闭“跳过动画”
 *   AutoPk.setSubmitTime(true, 180)    开启提交时间修改，并设成 180 秒
 *   AutoPk.setSubmitTime(false)        关闭提交时间修改
 *   AutoPk.show() / AutoPk.hide()      显示 / 隐藏控制台
 *   AutoPk.status()                    查看当前状态
 *   AutoPk.debug = false               关闭控制台日志输出（页面上的日志仍在）
 */
(function () {
    'use strict';

    var VERSION = '4.2.0';
    var TICK_MS = 100;
    var TICK_FAST_MS = 40;
    var LOG_LIMIT = 300;
    var INT32_MAX = 2147483647;
    var TIME_ENABLED_KEY = 'a366_pk_time_enabled';
    var TIME_SECONDS_KEY = 'a366_pk_time_seconds';
    // 兼容旧版控制台的存储键，老用户升级后不用重新设置
    var LEGACY_TIME_ENABLED_KEY = 'pkTimeModEnabled';
    var LEGACY_TIME_SECONDS_KEY = 'pkTimeModSeconds';

    if (window.AutoPk && window.AutoPk.version) {
        return;
    }

    // ---------- 小工具 ----------

    function readNumber(key, fallback, min, max) {
        try {
            var raw = window.localStorage.getItem(key);
            if (raw === null || raw === '') return fallback;
            var value = Number(raw);
            if (!isFinite(value)) return fallback;
            return Math.min(max, Math.max(min, value));
        } catch (e) {
            return fallback;
        }
    }

    function saveNumber(key, value) {
        try {
            window.localStorage.setItem(key, String(value));
        } catch (e) {
            /* 隐私模式或存储被禁用时忽略 */
        }
    }

    function readFlag(key, fallback) {
        try {
            var raw = window.localStorage.getItem(key);
            if (raw === null || raw === '') return fallback;
            return raw === '1' || raw === 'true';
        } catch (e) {
            return fallback;
        }
    }

    function saveFlag(key, value) {
        try {
            window.localStorage.setItem(key, value ? '1' : '0');
        } catch (e) {
            /* 忽略 */
        }
    }

    function readSubmitSeconds() {
        var value = readNumber(TIME_SECONDS_KEY, null, 0, INT32_MAX);
        if (value === null) value = readNumber(LEGACY_TIME_SECONDS_KEY, null, 0, INT32_MAX);
        return value === null ? null : Math.round(value);
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // ---------- 状态 ----------

    var state = {
        running: false,
        timer: null,
        lastKey: '',
        pendingKey: '',
        pendingAt: 0,
        answered: 0,
        correct: 0,
        wrong: 0,
        failed: 0,
        accuracy: readNumber('a366_pk_accuracy', 100, 0, 100),
        interval: readNumber('a366_pk_interval', 150, 0, 60000),
        skipAnim: readFlag('a366_pk_skip_anim', false),
        // 提交时间：页面里的 fetch/XHR 拦不到 Electron 客户端发出的提交请求，
        // 这里只保存状态并推给本地服务，真正改包在代理层完成。
        submitTimeEnabled: readFlag(TIME_ENABLED_KEY, readFlag(LEGACY_TIME_ENABLED_KEY, false)),
        submitTimeSeconds: readSubmitSeconds(),
        submitTimeSync: '',
        // 本次作答后用于“跳过动画”的跟进：等答对/答错动画结束，提前收尾
        awaitKey: '',
        awaitAt: 0,
        speedAt: 0,
        warnedVm: false,
        warnedKey: '',
        warnedEmpty: false,
        // 页面用 clickFlag / curIndex 表示“已作答/动画中”，字段语义随版本变化，
        // 这里只把它当作延迟提示：同一题最多等 2.5 秒，避免误判导致永远不答题。
        blockedKey: '',
        blockedAt: 0,
        debug: true
    };

    var ui = {
        panel: null,
        launcher: null,
        log: null,
        toggle: null,
        accuracy: null,
        accuracyVal: null,
        interval: null,
        skip: null,
        timeCheck: null,
        timeMin: null,
        timeSec: null,
        stats: {}
    };

    function now() {
        return Date.now();
    }

    // ---------- 跳过动画 ----------

    // 页面的作答流程靠 animationend / transitionend 推进，不能直接禁用动画，
    // 否则事件不触发、下一题永远不出来。这里只把时长压短：
    //   单词缩放 300ms -> 30ms，对勾/叉 500ms -> 120ms，+1 飘字与错误提示 300ms -> 30ms。
    // 对勾/叉必须比单词缩放慢，保证 animationScaleEnd 先于 animationPopEnd，
    // 与页面原始时序一致，避免重复触发 after-right。
    var SKIP_CSS = [
        '.u3-pk-core__word.is-animation-scale{',
        '-webkit-animation-duration:.03s!important;animation-duration:.03s!important;}',
        '.u3-pk-core__icon.icon-enter-active,.u3-pk-core__icon.icon-leave-active{',
        '-webkit-transition-duration:.12s!important;transition-duration:.12s!important;}',
        '.u3-pk-core__toast.toast-enter-active,.u3-pk-core__toast.toast-leave-active,',
        '.u3-page-pking__plus.plus-enter-active,.u3-page-pking__plus.plus-leave-active{',
        '-webkit-transition-duration:.03s!important;transition-duration:.03s!important;}'
    ].join('\n');

    function applySkipStyle(on) {
        var id = 'a366-pk-skip-style';
        var existing = document.getElementById(id);
        if (!on) {
            if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
            return;
        }
        if (existing) return;

        var style = document.createElement('style');
        style.id = id;
        style.textContent = SKIP_CSS;
        (document.head || document.documentElement).appendChild(style);
    }

    function restartTimer() {
        if (state.timer) {
            clearInterval(state.timer);
            state.timer = null;
        }
        if (state.running) {
            state.timer = setInterval(tick, state.skipAnim ? TICK_FAST_MS : TICK_MS);
        }
    }

    // 页面的 +1 飘字/next() 由页面组件（PKCore 的父级）控制；
    // 不同入口中间可能多包一层，向上找几层即可。
    function findPageVm(vm) {
        var node = vm;
        for (var i = 0; i < 6 && node; i++) {
            node = node.$parent;
            if (!node) return null;
            if (node.isPlus !== undefined && typeof node.next === 'function') return node;
        }
        return null;
    }

    // 开启“跳过动画”后，答对时不用等 +1 飘字的 400ms 计时器，
    // 答错时也不用等错误提示的 2 秒：等页面把 +1 / 提示真正显示出来一帧，
    // 再帮它收掉，页面就会立刻走 leave -> afterLeaveHandle -> next()。
    //
    // 必须等“出现过至少一帧”再动手：值刚变成 true 的同一帧就改回 false，
    // Vue 根本不会渲染过渡，enter/leave 钩子都不触发，题目会卡住。
    // 页面 transition 的 enter 钩子（afterEnterHandle / enter）在下一帧就会跑，
    // 这里留 100ms 余量（掉帧时也不会抢在加分之前收掉 +1）。
    var SPEEDUP_SETTLE_MS = 100;

    function speedUpAnimation(vm) {
        if (!state.skipAnim || !state.awaitKey) return;
        if (now() - state.awaitAt > 15000) {
            state.awaitKey = '';
            state.speedAt = 0;
            return;
        }

        var target = '';
        var page = null;

        if (vm.isWrong) {
            if (!vm.showToastWrong) {
                state.speedAt = 0;
                return;
            }
            target = 'toast';
        } else {
            if (vm.curIndex !== -1 || vm.isAnimationScale || vm.isAnimationPop) {
                state.speedAt = 0;
                return;
            }
            page = findPageVm(vm);
            if (!page || !page.isPlus) {
                state.speedAt = 0;
                return;
            }
            target = 'plus';
        }

        if (!state.speedAt) {
            state.speedAt = now();
            return;
        }
        if (now() - state.speedAt < SPEEDUP_SETTLE_MS) return;

        state.awaitKey = '';
        state.speedAt = 0;

        if (target === 'toast') {
            try { vm.showToastWrong = false; } catch (e) { /* 忽略 */ }
        } else {
            // 页面在 +1 的 enter 钩子里挂了一个 400ms 计时器，提前收掉它，
            // 免得它在新题上把 isPlus 关掉、抢跑一次 next()
            if (page.timer) {
                try { clearTimeout(page.timer); } catch (e) { /* 忽略 */ }
                page.timer = null;
            }
            try { page.isPlus = false; } catch (e) { /* 忽略 */ }
        }
    }

    // ---------- 日志 ----------

    function addLog(message, type) {
        if (!ui.log) return;

        var time = '';
        try {
            time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        } catch (e) {
            time = new Date().toLocaleTimeString();
        }

        var stick = ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight < 24;
        var row = document.createElement('div');
        row.className = 'a366-log-' + (type || 'info');
        row.innerHTML = '<span class="a366-ts">[' + time + ']</span>' + escapeHtml(message);
        ui.log.appendChild(row);

        while (ui.log.childNodes.length > LOG_LIMIT) {
            ui.log.removeChild(ui.log.firstChild);
        }
        if (stick) ui.log.scrollTop = ui.log.scrollHeight;
    }

    function log(message) {
        if (state.debug && window.console && console.log) {
            console.log('%c[AutoPk] ' + message, 'color:#00a86b;font-weight:bold');
        }
        addLog(message, 'info');
    }

    function warn(message) {
        if (window.console && console.warn) {
            console.warn('[AutoPk] ' + message);
        }
        addLog(message, 'warn');
    }

    // ---------- 页面数据读取（与原逻辑一致） ----------

    // 去掉页面渲染时附加的 style 和 HTML 标签，仅用于读取显示文字
    function removeHtmlStyles(text) {
        return String(text || '')
            .replace(/style="[^"]*"/g, '')
            .replace(/<[^>]*>/g, '');
    }

    function textOf(value) {
        if (value === null || value === undefined) return '';
        var text = String(value);
        if (text.indexOf('<') !== -1 || text.indexOf('&') !== -1) {
            var holder = document.createElement('div');
            holder.innerHTML = text;
            text = holder.textContent || holder.innerText || '';
        }
        return text
            .replace(/\u00a0/g, ' ')
            .replace(/[\s\u3000]+/g, ' ')
            .trim();
    }

    function sameText(a, b) {
        return textOf(removeHtmlStyles(a)) === textOf(removeHtmlStyles(b));
    }

    function isVisible(element) {
        if (!element) return false;
        var style = window.getComputedStyle ? getComputedStyle(element) : null;
        if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
        var rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function findRoot() {
        var roots = document.querySelectorAll('.u3-pk-core');
        for (var i = 0; i < roots.length; i++) {
            if (isVisible(roots[i])) return roots[i];
        }
        return null;
    }

    function findVm(root) {
        var element = root;
        while (element) {
            if (element.__vue__ && element.__vue__.word) {
                return element.__vue__;
            }
            element = element.parentElement;
        }
        return null;
    }

    // 组件里的 D() 只做一件事：把同一个答案字段（word.cn）变成选项上显示的文本
    // （去括号 -> 取第一个义项 -> 去掉 phr./phrase）。
    // 这里复刻它只是为了知道“这个答案会被渲染成什么样”，不会去和选项列表做任何比对。
    function displayedMeaning(value) {
        if (value === null || value === undefined) return '';
        var text = String(value);
        if (!text) return '';

        var noParen = text.replace(/[(（][^)）]*[)）]/g, '');
        var first = (noParen.split(/[;；,，]/)[0] || '').trim();
        var chosen = /[\u4e00-\u9fff]/.test(first) ? first : text.trim();

        return chosen
            .replace(/phr\./g, '')
            .replace(/phrase/g, '')
            .replace(/Phrase/g, '')
            .trim();
    }

    // 直接从组件当前单词对象里取正确答案候选。
    // 正常情况下就是 word.en / word.cn；额外字段只是同一对象里的备用答案文本，
    // 不是词库，也不是相似度匹配。
    function getAnswerCandidates(vm) {
        var word = vm && vm.word ? vm.word : {};
        var fields = vm.en2cn
            ? [word.cn, word.paraphrase, word.meaning, word.definition]
            : [word.en, word.entry, word.word];

        var out = [];
        var seen = {};

        function add(value) {
            var text = textOf(value);
            if (!text || seen[text]) return;
            seen[text] = true;
            out.push(text);
        }

        for (var i = 0; i < fields.length; i++) {
            add(fields[i]);
            // 页面把 word.cn 渲染成 D(word.cn)，所以原值和渲染值都要能命中
            if (vm.en2cn) add(displayedMeaning(textOf(fields[i])));
        }
        return out;
    }

    function questionKey(vm, root, candidates) {
        var question = '';
        var node = root.querySelector('.u3-pk-core__cn');
        if (node) question = textOf(node.innerHTML);
        var update = vm && vm.updateLocation !== undefined ? String(vm.updateLocation) : '';
        return update + '|' + question + '|' + candidates.join('\u0001');
    }

    function questionLabel(vm, root) {
        var node = root.querySelector('.u3-pk-core__cn');
        var text = node ? textOf(node.innerHTML) : '';
        if (text) return text;
        var word = vm && vm.word ? vm.word : {};
        return textOf(vm && vm.en2cn ? word.en : word.cn) || '当前题目';
    }

    function matchesAny(text, candidates) {
        for (var i = 0; i < candidates.length; i++) {
            if (sameText(text, candidates[i])) return true;
        }
        return false;
    }

    function clickAnswer(root, answer) {
        var words = root.querySelectorAll('.u3-pk-core__word');
        for (var i = 0; i < words.length; i++) {
            if (sameText(words[i].textContent, answer)) {
                words[i].click();
                return true;
            }
        }

        // 有些题型选项文字在子节点里，再按 .u3-pk-core__text 精确找一次
        var texts = root.querySelectorAll('.u3-pk-core__text');
        for (var j = 0; j < texts.length; j++) {
            if (sameText(texts[j].textContent, answer)) {
                var target = texts[j].parentNode || texts[j];
                target.click();
                return true;
            }
        }
        return false;
    }

    // 故意答错时，随机挑一个文字不等于答案的可见选项
    function clickWrong(root, candidates) {
        var pool = [];
        var words = root.querySelectorAll('.u3-pk-core__word');
        var i;

        for (i = 0; i < words.length; i++) {
            if (isVisible(words[i]) && !matchesAny(words[i].textContent, candidates)) {
                pool.push(words[i]);
            }
        }
        if (!pool.length) {
            var texts = root.querySelectorAll('.u3-pk-core__text');
            for (i = 0; i < texts.length; i++) {
                if (isVisible(texts[i]) && !matchesAny(texts[i].textContent, candidates)) {
                    pool.push(texts[i].parentNode || texts[i]);
                }
            }
        }
        if (!pool.length) return null;

        var target = pool[Math.floor(Math.random() * pool.length)];
        var label = textOf(target.textContent);
        target.click();
        return label;
    }

    // ---------- 主循环 ----------

    function tick() {
        if (!state.running) return;

        var root = findRoot();
        if (!root) return;

        var vm = findVm(root);
        if (!vm) {
            if (!state.warnedVm) {
                state.warnedVm = true;
                warn('未找到 PKCore 的 Vue 组件实例，暂时无法读取标准答案');
            }
            return;
        }
        state.warnedVm = false;

        // 跳过动画：跟进上一题的收尾（放在题目判定之前，动画期间也要跑）
        speedUpAnimation(vm);

        // 已经点过、正在播动画、题目禁用时都不要重复点击
        if (vm.disabled) return;

        var candidates = getAnswerCandidates(vm);
        if (!candidates.length) {
            if (!state.warnedEmpty) {
                state.warnedEmpty = true;
                state.failed++;
                warn('组件 word 里没有当前模式的答案字段，已跳过');
            }
            return;
        }
        state.warnedEmpty = false;

        var key = questionKey(vm, root, candidates);
        if (key === state.lastKey) return;

        // clickFlag / curIndex 只是“可能已作答”的提示，等 2.5 秒还没有变化就照常作答
        var blocked = !!vm.clickFlag || (typeof vm.curIndex === 'number' && vm.curIndex >= 0);
        if (blocked) {
            if (state.blockedKey !== key) {
                state.blockedKey = key;
                state.blockedAt = now();
            }
            if (now() - state.blockedAt < 2500) return;
        } else {
            state.blockedKey = '';
        }

        // 新题出现后先等“间隔”这么久，再动手
        if (state.pendingKey !== key) {
            state.pendingKey = key;
            state.pendingAt = now();
        }
        if (now() - state.pendingAt < state.interval) return;

        state.pendingKey = '';
        state.lastKey = key;

        var question = questionLabel(vm, root);
        var wantCorrect = Math.random() * 100 < state.accuracy;

        if (!wantCorrect) {
            var wrongText = clickWrong(root, candidates);
            if (wrongText !== null) {
                state.answered++;
                state.wrong++;
                state.warnedKey = '';
                state.awaitKey = key;
                state.awaitAt = now();
                addLog('作答 ✗ ' + question + ' → ' + wrongText, 'warn');
                updateStats();
                return;
            }
            // 找不到别的选项时退回正确答案，避免卡住
        }

        for (var i = 0; i < candidates.length; i++) {
            if (clickAnswer(root, candidates[i])) {
                state.answered++;
                state.correct++;
                state.warnedKey = '';
                state.awaitKey = key;
                state.awaitAt = now();
                addLog('作答 ✓ ' + question + ' → ' + candidates[i], 'success');
                updateStats();
                return;
            }
        }

        state.failed++;
        state.lastKey = '';
        // 同一题找不到选项时只提示一次，避免每 100ms 刷屏
        if (state.warnedKey !== key) {
            state.warnedKey = key;
            warn('组件答案“' + candidates.join(' / ') + '”在选项中没有找到完全一致的文字');
        }
    }

    function start() {
        if (state.running) return;
        state.running = true;
        state.lastKey = '';
        state.pendingKey = '';
        state.pendingAt = 0;
        state.warnedKey = '';
        state.warnedEmpty = false;
        state.blockedKey = '';
        state.awaitKey = '';
        state.speedAt = 0;
        restartTimer();
        log('自动作答已启动（正确率 ' + state.accuracy + '%，间隔 ' + state.interval + 'ms' +
            (state.skipAnim ? '，已跳过动画' : '') + '）');
        syncUI();
    }

    function stop() {
        if (!state.running) return;
        state.running = false;
        state.awaitKey = '';
        state.speedAt = 0;
        restartTimer();
        log('自动作答已停止，累计作答 ' + state.answered + ' 题');
        syncUI();
    }

    function updateStats() {
        if (!ui.stats.answered) return;
        ui.stats.answered.textContent = String(state.answered);
        ui.stats.correct.textContent = String(state.correct);
        ui.stats.wrong.textContent = String(state.wrong);
        ui.stats.rate.textContent = state.answered
            ? Math.round(state.correct / state.answered * 100) + '%'
            : '-';
    }

    function syncUI() {
        if (!ui.panel) return;
        if (state.running) ui.panel.classList.add('a366-running');
        else ui.panel.classList.remove('a366-running');
        if (ui.toggle) {
            ui.toggle.textContent = state.running ? '停止' : '开始';
            if (state.running) ui.toggle.classList.add('a366-stop');
            else ui.toggle.classList.remove('a366-stop');
        }
    }

    function applyAccuracy(value) {
        var v = Number(value);
        if (!isFinite(v)) return;
        v = Math.max(0, Math.min(100, Math.round(v)));
        state.accuracy = v;
        saveNumber('a366_pk_accuracy', v);
        if (ui.accuracy) ui.accuracy.value = String(v);
        if (ui.accuracyVal) ui.accuracyVal.textContent = v + '%';
    }

    function applyInterval(value) {
        var v = Number(value);
        if (!isFinite(v)) return;
        v = Math.max(0, Math.min(60000, Math.round(v)));
        state.interval = v;
        saveNumber('a366_pk_interval', v);
        if (ui.interval) ui.interval.value = String(v);
    }

    function applySkip(value) {
        var on = !!value;
        state.skipAnim = on;
        saveFlag('a366_pk_skip_anim', on);
        applySkipStyle(on);
        if (!on) {
            state.awaitKey = '';
            state.speedAt = 0;
        }
        if (ui.skip) ui.skip.checked = on;
        restartTimer();
    }

    // ---------- 提交时间（代理层改包） ----------
    //
    // 提交请求由 Electron 客户端发出，不经过页面里的 fetch/XHR，页面层 hook 拦不到。
    // 因此这里只把「启用 / 秒数」推给本地服务（/pk-time），由代理层在转发时改写
    // submitJson.duration（毫秒）和 wordInfos[].answerTime，见 modules/proxy/time-modifier.js。

    function bucketBase() {
        var cfg = window.__A366__ || {};
        if (cfg.bucket) return String(cfg.bucket);
        if (cfg.bucketPort) return 'http://127.0.0.1:' + cfg.bucketPort;
        return 'http://127.0.0.1:5290';
    }

    function formatSeconds(total) {
        var mins = Math.floor(total / 60);
        var secs = total % 60;
        if (mins > 0) return mins + '分' + secs + '秒';
        return secs + '秒';
    }

    function describeSubmitTime() {
        if (!state.submitTimeEnabled) return '已关闭';
        if (state.submitTimeSeconds === null) return '已启用，未填时长（提交不会被修改）';
        return '已启用，提交用时 ' + formatSeconds(state.submitTimeSeconds);
    }

    function pushSubmitTime() {
        var payload = {
            enabled: state.submitTimeEnabled === true,
            seconds: state.submitTimeSeconds === null ? null : state.submitTimeSeconds
        };
        // 日志文案按“推送这一刻”的状态生成，避免异步返回时读到更新后的值
        var label = describeSubmitTime();

        state.submitTimeSync = 'pending';
        try {
            // 必须用 text/plain：本地服务没有处理 OPTIONS 预检，
            // application/json 会被浏览器的 CORS 预检拦掉。
            // 请求体仍是 JSON，服务端照样 JSON.parse（modules/proxy/http.js）。
            fetch(bucketBase() + '/pk-time', {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
                body: JSON.stringify(payload),
                cache: 'no-cache'
            }).then(function (res) {
                return res.json();
            }).then(function (res) {
                if (res && res.success) {
                    state.submitTimeSync = 'ok';
                    log('提交时间已同步到代理层（' + label + '）');
                } else {
                    state.submitTimeSync = 'fail';
                    warn('提交时间同步失败：代理层返回异常');
                }
            }).catch(function (e) {
                state.submitTimeSync = 'fail';
                warn('提交时间同步失败：' + (e && e.message ? e.message : e) + '（确认主程序仍在运行）');
            });
        } catch (e) {
            state.submitTimeSync = 'fail';
            warn('提交时间同步异常：' + (e && e.message ? e.message : e));
        }
    }

    function fillTimeInputs() {
        if (!ui.timeMin || !ui.timeSec) return;
        if (state.submitTimeSeconds === null) {
            ui.timeMin.value = '';
            ui.timeSec.value = '';
            return;
        }
        ui.timeMin.value = String(Math.floor(state.submitTimeSeconds / 60));
        ui.timeSec.value = String(state.submitTimeSeconds % 60);
    }

    function applySubmitTime(enabled, seconds, silent) {
        var on = !!enabled;
        var total = null;
        if (seconds !== null && seconds !== undefined && seconds !== '') {
            total = Math.round(Number(seconds));
            if (!isFinite(total)) total = null;
            else total = Math.max(0, Math.min(INT32_MAX, total));
        }

        state.submitTimeEnabled = on;
        state.submitTimeSeconds = total;
        saveFlag(TIME_ENABLED_KEY, on);
        try {
            if (total === null) window.localStorage.removeItem(TIME_SECONDS_KEY);
            else window.localStorage.setItem(TIME_SECONDS_KEY, String(total));
        } catch (e) {
            /* 忽略 */
        }

        if (ui.timeCheck) ui.timeCheck.checked = on;
        fillTimeInputs();
        if (!silent) pushSubmitTime();
    }

    function commitTimeInputs() {
        if (!ui.timeMin || !ui.timeSec) return;
        var minRaw = String(ui.timeMin.value || '').trim();
        var secRaw = String(ui.timeSec.value || '').trim();

        if (minRaw === '' && secRaw === '') {
            applySubmitTime(state.submitTimeEnabled, null);
            log('提交时间已清空（提交不会被修改）');
            return;
        }

        var mins = parseInt(minRaw, 10);
        var secs = parseInt(secRaw, 10);
        if (!isFinite(mins)) mins = 0;
        if (!isFinite(secs)) secs = 0;

        var total = mins * 60 + secs;
        if (total < 0) total = 0;
        if (total > INT32_MAX) total = INT32_MAX;
        applySubmitTime(state.submitTimeEnabled, total);
        log('提交时间已设为 ' + formatSeconds(total) + '（duration=' + total * 1000 + 'ms）');
    }

    // ---------- 控制台 UI ----------

    var PANEL_CSS = [
        '#a366-pk-panel{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:300px;max-width:calc(100vw - 24px);',
        'background:#fff;color:#212529;border:1px solid #dee2e6;border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.22);',
        'font:12px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;',
        'overflow:hidden;user-select:none;-webkit-user-select:none;}',
        '#a366-pk-panel.a366-dragging{box-shadow:0 16px 44px rgba(0,0,0,.34);}',
        '#a366-pk-panel *{box-sizing:border-box;}',
        '#a366-pk-panel .a366-hd{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#f8f9fa;',
        'border-bottom:1px solid #dee2e6;cursor:move;touch-action:none;-ms-touch-action:none;}',
        '#a366-pk-panel .a366-dot{flex:none;width:8px;height:8px;border-radius:50%;background:#adb5bd;}',
        '#a366-pk-panel.a366-running .a366-dot{background:#28a745;box-shadow:0 0 0 3px rgba(40,167,69,.16);}',
        '#a366-pk-panel .a366-title{flex:1;min-width:0;font-weight:600;color:#007bff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '#a366-pk-panel .a366-ib{flex:none;width:22px;height:22px;padding:0;line-height:18px;border:1px solid #dee2e6;',
        'border-radius:4px;background:#fff;color:#6c757d;font-size:12px;cursor:pointer;}',
        '#a366-pk-panel .a366-ib:hover{color:#212529;}',
        '#a366-pk-panel .a366-bd{display:flex;flex-direction:column;gap:8px;padding:10px;}',
        '#a366-pk-panel.a366-collapsed .a366-bd{display:none;}',
        '#a366-pk-panel .a366-stats{display:flex;align-items:center;justify-content:space-between;gap:6px;',
        'padding:6px 8px;background:#f8f9fa;border:1px solid #e9ecef;border-radius:6px;overflow:hidden;}',
        '#a366-pk-panel .a366-stats span{color:#6c757d;white-space:nowrap;}',
        '#a366-pk-panel .a366-stats b{color:#212529;font-weight:600;}',
        '#a366-pk-panel .a366-stats b.ok{color:#28a745;}',
        '#a366-pk-panel .a366-stats b.bad{color:#dc3545;}',
        '#a366-pk-panel .a366-row{display:flex;align-items:center;gap:6px;}',
        '#a366-pk-panel .a366-label{flex:none;color:#6c757d;}',
        '#a366-pk-panel .a366-range{flex:1;min-width:40px;margin:0;accent-color:#007bff;}',
        '#a366-pk-panel .a366-val{flex:none;width:44px;text-align:right;color:#007bff;font-weight:600;}',
        '#a366-pk-panel .a366-num{width:64px;padding:3px 4px;border:1px solid #dee2e6;border-radius:4px;',
        'font-size:12px;text-align:center;color:#212529;background:#fff;outline:none;}',
        '#a366-pk-panel .a366-num.a366-time{width:42px;}',
        '#a366-pk-panel .a366-unit{flex:none;color:#adb5bd;}',
        '#a366-pk-panel .a366-check{display:flex;align-items:center;gap:4px;flex:1;color:#495057;cursor:pointer;}',
        '#a366-pk-panel .a366-check input{margin:0;accent-color:#007bff;cursor:pointer;}',
        '#a366-pk-panel .a366-btn{flex:none;padding:4px 8px;border:1px solid #dee2e6;border-radius:4px;',
        'background:#fff;color:#495057;font-size:12px;cursor:pointer;}',
        '#a366-pk-panel .a366-btn:hover{border-color:#adb5bd;}',
        '#a366-pk-panel .a366-btn.a366-primary{flex:1;background:#007bff;border-color:#007bff;color:#fff;}',
        '#a366-pk-panel .a366-btn.a366-primary.a366-stop{background:#dc3545;border-color:#dc3545;}',
        '#a366-pk-panel .a366-log{height:112px;overflow-y:auto;padding:4px 6px;border:1px solid #e9ecef;border-radius:6px;',
        'background:#fff;font:11px/1.5 Consolas,"Courier New",monospace;word-break:break-all;',
        'user-select:text;-webkit-user-select:text;}',
        '#a366-pk-panel .a366-log>div{padding:1px 0;border-bottom:1px dashed #f1f3f5;}',
        '#a366-pk-panel .a366-log .a366-ts{color:#adb5bd;margin-right:4px;}',
        '#a366-pk-panel .a366-log .a366-log-info{color:#6c757d;}',
        '#a366-pk-panel .a366-log .a366-log-success{color:#28a745;}',
        '#a366-pk-panel .a366-log .a366-log-warn{color:#e67e22;}',
        '#a366-pk-panel .a366-log .a366-log-error{color:#dc3545;}',
        '#a366-pk-launcher{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:44px;height:44px;',
        'border-radius:50%;background:#007bff;color:#fff;display:flex;align-items:center;justify-content:center;',
        'font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;',
        'cursor:pointer;user-select:none;box-shadow:0 4px 16px rgba(0,123,255,.45);}'
    ].join('\n');

    var PANEL_HTML = [
        '<div class="a366-hd" id="a366-pk-hd">',
        '<span class="a366-dot"></span>',
        '<span class="a366-title">单词PK自动作答</span>',
        '<button type="button" class="a366-ib" data-a366="collapse" title="折叠/展开">—</button>',
        '<button type="button" class="a366-ib" data-a366="hide" title="隐藏控制台">✕</button>',
        '</div>',
        '<div class="a366-bd">',
        '<div class="a366-stats">',
        '<span>已答 <b data-stat="answered">0</b></span>',
        '<span>正确 <b class="ok" data-stat="correct">0</b></span>',
        '<span>错误 <b class="bad" data-stat="wrong">0</b></span>',
        '<span>正确率 <b data-stat="rate">-</b></span>',
        '</div>',
        '<div class="a366-row">',
        '<span class="a366-label">正确率</span>',
        '<input class="a366-range" type="range" min="0" max="100" step="5" data-ctl="accuracy">',
        '<span class="a366-val" data-val="accuracy">100%</span>',
        '</div>',
        '<div class="a366-row">',
        '<span class="a366-label">间隔</span>',
        '<input class="a366-num" type="number" min="0" max="60000" step="50" data-ctl="interval">',
        '<span class="a366-unit">ms</span>',
        '<button type="button" class="a366-btn" data-preset="0">0</button>',
        '<button type="button" class="a366-btn" data-preset="150">150</button>',
        '<button type="button" class="a366-btn" data-preset="500">500</button>',
        '</div>',
        '<div class="a366-row">',
        '<label class="a366-check"><input type="checkbox" data-ctl="skip"> 跳过动画</label>',
        '<span class="a366-unit">加快作答</span>',
        '</div>',
        '<div class="a366-row">',
        '<label class="a366-check"><input type="checkbox" data-ctl="time"> 提交时间</label>',
        '<input class="a366-num a366-time" type="number" min="0" step="1" data-ctl="time-min">',
        '<span class="a366-unit">分</span>',
        '<input class="a366-num a366-time" type="number" min="0" max="59" step="1" data-ctl="time-sec">',
        '<span class="a366-unit">秒</span>',
        '</div>',
        '<div class="a366-row">',
        '<button type="button" class="a366-btn a366-primary" data-a366="toggle">停止</button>',
        '<button type="button" class="a366-btn" data-a366="clear">清空日志</button>',
        '</div>',
        '<div class="a366-log" data-log></div>',
        '</div>'
    ].join('');

    // 鼠标 + 触控都能拖动；优先 Pointer Events，不支持时退回 mouse/touch。
    function makeDraggable(panel, handle) {
        if (!panel || !handle) return;

        var drag = null;

        function pointOf(e) {
            if (e.touches && e.touches.length) return e.touches[0];
            if (e.changedTouches && e.changedTouches.length) return e.changedTouches[0];
            return e;
        }

        function onDown(e) {
            if (e.button !== undefined && e.button !== 0) return;
            var target = e.target || {};
            var tag = String(target.tagName || '').toLowerCase();
            if (tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'a') return;

            var p = pointOf(e);
            var rect = panel.getBoundingClientRect();
            drag = { x: p.clientX, y: p.clientY, left: rect.left, top: rect.top };

            panel.style.left = rect.left + 'px';
            panel.style.top = rect.top + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            panel.classList.add('a366-dragging');

            if (e.pointerId !== undefined && handle.setPointerCapture) {
                try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            }
            e.preventDefault();
            e.stopPropagation();
        }

        function onMove(e) {
            if (!drag) return;
            var p = pointOf(e);
            var width = panel.offsetWidth || 300;
            var left = drag.left + p.clientX - drag.x;
            var top = drag.top + p.clientY - drag.y;

            left = Math.max(4, Math.min(window.innerWidth - width - 4, left));
            top = Math.max(4, Math.min(window.innerHeight - 44, top));

            panel.style.left = left + 'px';
            panel.style.top = top + 'px';
            e.preventDefault();
        }

        function onUp() {
            if (!drag) return;
            drag = null;
            panel.classList.remove('a366-dragging');
        }

        function bind(el, type, fn, opts) {
            try { el.addEventListener(type, fn, opts); }
            catch (e) { el.addEventListener(type, fn, false); }
        }

        if (window.PointerEvent) {
            bind(handle, 'pointerdown', onDown, false);
            bind(document, 'pointermove', onMove, { passive: false });
            bind(document, 'pointerup', onUp, false);
            bind(document, 'pointercancel', onUp, false);
        } else {
            bind(handle, 'mousedown', onDown, false);
            bind(document, 'mousemove', onMove, false);
            bind(document, 'mouseup', onUp, false);
            bind(handle, 'touchstart', onDown, { passive: false });
            bind(document, 'touchmove', onMove, { passive: false });
            bind(document, 'touchend', onUp, false);
            bind(document, 'touchcancel', onUp, false);
        }
    }

    function showLauncher() {
        if (!ui.launcher) {
            var launcher = document.createElement('div');
            launcher.id = 'a366-pk-launcher';
            launcher.textContent = 'PK';
            launcher.title = '打开自动作答控制台';
            launcher.addEventListener('click', function () {
                launcher.style.display = 'none';
                if (ui.panel) ui.panel.style.display = '';
            });
            document.body.appendChild(launcher);
            ui.launcher = launcher;
        }
        ui.launcher.style.display = 'flex';
    }

    function createUI() {
        if (document.getElementById('a366-pk-panel')) return;

        var style = document.createElement('style');
        style.id = 'a366-pk-style';
        style.textContent = PANEL_CSS;
        (document.head || document.documentElement).appendChild(style);

        var panel = document.createElement('div');
        panel.id = 'a366-pk-panel';
        panel.innerHTML = PANEL_HTML;
        document.body.appendChild(panel);
        ui.panel = panel;

        ui.log = panel.querySelector('[data-log]');
        ui.toggle = panel.querySelector('[data-a366="toggle"]');
        ui.accuracy = panel.querySelector('[data-ctl="accuracy"]');
        ui.accuracyVal = panel.querySelector('[data-val="accuracy"]');
        ui.interval = panel.querySelector('[data-ctl="interval"]');
        ui.skip = panel.querySelector('[data-ctl="skip"]');
        ui.timeCheck = panel.querySelector('[data-ctl="time"]');
        ui.timeMin = panel.querySelector('[data-ctl="time-min"]');
        ui.timeSec = panel.querySelector('[data-ctl="time-sec"]');
        ui.stats.answered = panel.querySelector('[data-stat="answered"]');
        ui.stats.correct = panel.querySelector('[data-stat="correct"]');
        ui.stats.wrong = panel.querySelector('[data-stat="wrong"]');
        ui.stats.rate = panel.querySelector('[data-stat="rate"]');

        applyAccuracy(state.accuracy);
        applyInterval(state.interval);
        applySkip(state.skipAnim);
        applySubmitTime(state.submitTimeEnabled, state.submitTimeSeconds, true);

        panel.querySelector('[data-a366="collapse"]').addEventListener('click', function () {
            panel.classList.toggle('a366-collapsed');
        });

        panel.querySelector('[data-a366="hide"]').addEventListener('click', function () {
            panel.style.display = 'none';
            showLauncher();
        });

        ui.toggle.addEventListener('click', function () {
            if (state.running) stop();
            else start();
        });

        panel.querySelector('[data-a366="clear"]').addEventListener('click', function () {
            if (ui.log) ui.log.innerHTML = '';
        });

        ui.accuracy.addEventListener('input', function () {
            applyAccuracy(this.value);
        });
        ui.accuracy.addEventListener('change', function () {
            addLog('正确率已设为 ' + state.accuracy + '%', 'info');
        });

        ui.interval.addEventListener('change', function () {
            applyInterval(this.value);
            addLog('作答间隔已设为 ' + state.interval + 'ms', 'info');
        });

        ui.skip.addEventListener('change', function () {
            applySkip(this.checked);
            addLog('跳过动画已' + (state.skipAnim ? '开启' : '关闭'), 'info');
        });

        ui.timeCheck.addEventListener('change', function () {
            applySubmitTime(this.checked, state.submitTimeSeconds);
            if (state.submitTimeEnabled && state.submitTimeSeconds === null) {
                warn('提交时间已启用，但时长未填，提交不会被修改');
            } else {
                log('提交时间已' + (state.submitTimeEnabled ? '启用' : '关闭'));
            }
        });

        ui.timeMin.addEventListener('change', commitTimeInputs);
        ui.timeSec.addEventListener('change', commitTimeInputs);

        var presets = panel.querySelectorAll('[data-preset]');
        for (var i = 0; i < presets.length; i++) {
            presets[i].addEventListener('click', function () {
                applyInterval(this.getAttribute('data-preset'));
                addLog('作答间隔已设为 ' + state.interval + 'ms', 'info');
            });
        }

        makeDraggable(panel, panel.querySelector('#a366-pk-hd'));
    }

    // ---------- 启动 ----------

    function boot() {
        createUI();
        updateStats();
        syncUI();
        addLog('控制台已就绪（正确率 ' + state.accuracy + '%，间隔 ' + state.interval + 'ms，跳过动画 ' +
            (state.skipAnim ? '开' : '关') + '），点击“开始”启动', 'info');
        // 代理层的提交时间状态只存在内存里，页面刷新后要重新推一次
        pushSubmitTime();
    }

    window.AutoPk = {
        version: VERSION,
        start: start,
        stop: stop,
        show: function () {
            if (ui.panel) ui.panel.style.display = '';
            if (ui.launcher) ui.launcher.style.display = 'none';
        },
        hide: function () {
            if (ui.panel) ui.panel.style.display = 'none';
            showLauncher();
        },
        setAccuracy: function (value) {
            applyAccuracy(value);
        },
        setIntervalMs: function (value) {
            applyInterval(value);
        },
        setSkipAnim: function (value) {
            applySkip(value);
        },
        setSubmitTime: function (enabled, seconds) {
            applySubmitTime(enabled, seconds);
        },
        status: function () {
            return {
                running: state.running,
                answered: state.answered,
                correct: state.correct,
                wrong: state.wrong,
                failed: state.failed,
                accuracy: state.accuracy,
                interval: state.interval,
                skipAnim: state.skipAnim,
                submitTime: {
                    enabled: state.submitTimeEnabled,
                    seconds: state.submitTimeSeconds,
                    sync: state.submitTimeSync
                },
                lastKey: state.lastKey
            };
        },
        get debug() {
            return state.debug;
        },
        set debug(value) {
            state.debug = !!value;
        }
    };

    if (document.body) boot();
    else document.addEventListener('DOMContentLoaded', boot);
})();
