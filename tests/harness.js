/* LMT PWA / 安卓外壳 交互回归测试（零依赖，浏览器内运行）
 * 入口：tests/harness.html    本地执行：tests/run.ps1    CI：web-check.yml + lmt-android 的 sync-check.yml
 *
 * 两端对称：同一套用例对「PWA 副本」与「安卓 assets 副本」各跑一遍（由 harness.html 的 ?layout=&cardgen= 切换）。
 * 两份的共享核心由 tools/web-sync.ps1 -Check 守卫逐字一致；@shell: 标记包住的两端外壳差异不在那层保障里，
 * 因此这里要分别实测：外壳专属路径要么执行到（注入假原生桥，见 installFakeSaver），要么显式标成跳过并写明原因。
 * 已知无法在 file:// 无头环境覆盖的外壳：PWA 的 Service Worker 注册（@shell:pwa-sw）——file:// 下不可用，
 * 它由 web-check.yml 的 sw-hash 作业 + web-sync.ps1 -Bump 的 @index-hash 机制守卫。
 *
 * 运行环境要求（两个开关缺一不可）：
 *   --allow-file-access-from-files   让父页可以访问 iframe 的内部状态（file:// 各页默认互相隔离）
 *   --host-resolver-rules="MAP * ~NOTFOUND"  断网，保证「离线回退」这类断言可复现
 *   --virtual-time-budget=<ms>       把定时器快进，保证 dump-dom 时用例已全部跑完
 *
 * 设计原则：
 *   · 不引入任何第三方测试框架；断言失败只记录，不中断后续用例。
 *   · 「点击无反应」的判定 = 点击后必须有可观察的状态变化；关键控件逐个断言。
 *   · 用例按顺序执行，后者可依赖前者建立的状态。
 */
(function () {
  'use strict';

  var CASES = [];
  var results = [];
  var pageErrors = [];
  // 两个应用各自收到的「假原生落盘桥」调用，由 installFakeSaver 填充（见下）
  var saverCalls = { layout: [], cardgen: [] };

  // ---------- 断言 / 等待 ----------
  function fail(msg) { throw new Error(msg); }
  function assert(cond, msg) { if (!cond) fail(msg || '断言失败'); }
  function assertEq(actual, expected, msg) {
    if (actual !== expected) {
      fail((msg || '值不相等') + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
    }
  }
  function assertMatch(value, re, msg) {
    if (!re.test(String(value))) fail((msg || '格式不符') + '：' + JSON.stringify(String(value)) + ' 不匹配 ' + re);
  }
  function assertDeepEq(actual, expected, msg) {
    var a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) fail((msg || '结构不相等') + '：期望 ' + b + '，实际 ' + a);
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  async function until(fn, timeoutMs, label) {
    var deadline = Date.now() + (timeoutMs || 3000);
    for (;;) {
      var v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      if (Date.now() > deadline) fail('等待超时' + (label ? '：' + label : ''));
      await sleep(20);
    }
  }
  function test(name, fn) { CASES.push({ name: name, fn: fn }); }

  // 跳过：专供两端外壳差异明确的用例。不计入失败，但报告里必须写明原因，
  // 免得「本端没有这条路径、所以没跑」被误读成「本端也验过了」。
  function skip(reason) { var e = new Error(reason); e.__skip = true; throw e; }

  // ---------- DOM 小工具 ----------
  function q(doc, sel) { var el = doc.querySelector(sel); assert(el, '找不到元素：' + sel); return el; }
  function qa(doc, sel) { return Array.prototype.slice.call(doc.querySelectorAll(sel)); }
  function fire(el, type, win, init) {
    var ev = new (win || window).Event(type, { bubbles: true });
    if (init) for (var k in init) ev[k] = init[k];
    el.dispatchEvent(ev);
  }
  function setValue(el, v, win, evName) { el.value = v; fire(el, evName || 'input', win); }
  function text(el) { return el ? String(el.textContent) : ''; }
  function hasClass(el, c) { return !!el && el.classList.contains(c); }

  // 关掉所有自动弹层，避免影响后续用例
  function closeLayers(doc) {
    qa(doc, '.manual-copy-mask, .img-preview-mask').forEach(function (mask) {
      if (typeof mask.__dispose === 'function') { mask.__dispose(); return; }
      var btns = qa(mask, 'button');
      for (var i = 0; i < btns.length; i++) {
        if (text(btns[i]) === '关闭') { btns[i].click(); return; }
      }
      if (mask.parentNode) mask.parentNode.removeChild(mask);
    });
  }

  // 元素是否真正参与渲染（父级 display:none 时返回 false；适用于「隐藏容器里的预览块」）
  function isRendered(el) { return !!el && el.getClientRects().length > 0; }

  // 点一次「复制类按钮」并断言必定有可见反馈（不依赖剪贴板是否真的可用）：
  //   1) 点击瞬间文案必须立刻变化 —— 证明点击处理器真的执行到了，杜绝「点击无反应」
  //   2) 随后收敛到终态（已复制 / 请手动复制）—— 无头环境下 execCommand 与 clipboard.writeText
  //      都可能失败，这条断言把「失败也要有兜底反馈」一并覆盖
  async function clickCopyAndAssertFeedback(btn, label) {
    var name = label || '复制按钮';
    var before = text(btn);
    btn.click();
    assert(text(btn) !== before || text(btn) === '复制中…',
      name + ' 点击后应立刻有文案反馈，实际仍是 ' + JSON.stringify(text(btn)));
    await until(function () {
      var t = text(btn);
      return t === '请手动复制' || /^已复制/.test(t);
    }, 2000, name + ' 的复制结果反馈（当前停留在 ' + JSON.stringify(text(btn)) + '）');
  }

  // ---------- 构造文件（用于 file input 的 change 事件） ----------
  function pngBytes(win, w, h) {
    var cv = win.document.createElement('canvas');
    cv.width = w; cv.height = h;
    var cx = cv.getContext('2d');
    cx.fillStyle = '#cc3344';
    cx.fillRect(0, 0, w, h);
    cx.fillStyle = '#ffffff';
    cx.fillRect(0, 0, Math.max(1, (w / 2) | 0), Math.max(1, (h / 2) | 0));
    return b64ToBytes(cv.toDataURL('image/png').split(',')[1]);
  }
  function b64ToBytes(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function attachFile(win, input, fileName, mimeType, bytes) {
    var file = new win.File([bytes], fileName, { type: mimeType });
    var dt = new win.DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    fire(input, 'change', win);
  }

  // ---------- 前置：载入 iframe 并旁听未捕获异常 ----------
  // lmt-layout 用 requestAnimationFrame 合并同一帧内的多次重排（scheduleFit）。
  // 无头浏览器里，完全移出视口的 iframe 的 rAF 会被节流甚至根本不触发，
  // 于是「文案超长 → 禁用导出」这类真实的响应式行为会在 CI（新版 Chrome / Linux）上假失败。
  // 这里只把调度方式换成等价的 16ms 定时回调：应用自身的合并与判定逻辑照旧原样执行。
  function shimFrameAnimation(f) {
    var win;
    try { win = f.contentWindow; } catch (e) { return; }
    if (!win) return;
    try {
      win.requestAnimationFrame = function (cb) {
        return win.setTimeout(function () { cb(Date.now()); }, 16);
      };
      win.cancelAnimationFrame = function (id) { win.clearTimeout(id); };
    } catch (e) { /* 跨源受限时保持浏览器原行为 */ }
  }
  function frameReady(id) {
    return new Promise(function (resolve) {
      var f = document.getElementById(id);
      f.addEventListener('load', function () { shimFrameAnimation(f); resolve(f); });
      if (f.contentDocument && f.contentDocument.readyState === 'complete') {
        setTimeout(function () { shimFrameAnimation(f); resolve(f); }, 0);
      }
    });
  }
  // ---------- 安卓外壳的原生落盘桥 ----------
  // 安卓外壳通过 window.AndroidSaver.save(name, mime, base64) 把导出结果写进系统「下载」目录（见 MainActivity），
  // 这段代码被 @shell:android-save / image-export / template 三段包住，是安卓壳独有的。
  // 桌面无头环境没有这个桥，那几段就会静默走回 <a download> 回退分支——两端「碰巧都通过」，
  // 真实的安卓落盘路径其实一次都没被执行过。这里注入一个只记录调用的假桥，让安卓壳的分支真的跑起来。
  // PWA 外壳的源码里根本没有 AndroidSaver 这个引用（该调用只存在于 @shell 段内），注入后不会有任何调用；
  // 用例据此把「本端没有这条外壳路径」显式标成跳过，而不是让它假通过。
  function installFakeSaver(f, key) {
    var win;
    try { win = f.contentWindow; } catch (e) { return; }
    if (!win) return;
    try {
      win.AndroidSaver = {
        save: function (name, mime, base64) {
          saverCalls[key].push({ name: String(name), mime: String(mime), base64: String(base64) });
          return true; // 与原生实现一致：成功返回 true，失败返回 false
        }
      };
    } catch (e) { /* 跨源受限时保持浏览器原行为 */ }
  }
  // 页面源码里是否引用原生桥：用来区分「安卓外壳确实有这条路径」与「PWA 外壳天生没有」
  function hasSaverRef(win) {
    try { return String(win.document.documentElement.outerHTML).indexOf('AndroidSaver') >= 0; }
    catch (e) { return false; }
  }

  function watchErrors(win, tag) {
    win.addEventListener('error', function (e) {
      pageErrors.push(tag + ' error: ' + ((e && e.message) || 'unknown'));
    });
    win.addEventListener('unhandledrejection', function (e) {
      var r = e && e.reason;
      pageErrors.push(tag + ' unhandledrejection: ' + ((r && r.message) || r));
    });
  }

  // ================================================================
  // lmt-layout（图文排版生成器）
  // ================================================================
  // C = 卡密生成器的 window：在线清单那条用例要用它签出清单喂给主程序，
  // 以此证明「生成器签的清单主程序认」这条跨应用契约（而不必在测试里硬编码密钥）。
  function layoutCases(L, C) {
    var doc = L.document;
    function app() {
      assert(L.__layoutTool, '前置未满足：主程序未启动（未激活或 bootApp 未执行）');
      return L.__layoutTool;
    }

    test('layout/授权门：机器码展示与「复制」有反馈', async function () {
      var mc = q(doc, '#license-mc');
      assertMatch(mc.value, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/, '机器码格式');
      mc.click();
      assertEq(mc.selectionStart, 0, '点击机器码应全选');
      assertEq(mc.selectionEnd, mc.value.length, '点击机器码应全选到末尾');
      var btn = q(doc, '#license-copy');
      await clickCopyAndAssertFeedback(btn, '授权门复制按钮');
      closeLayers(doc);
      // 依赖脚本内部把机器码与卡密算法绑定的能力做一次一致性自检
      assertEq(L.__license.verifyCard(L.__license.makeCard(mc.value)), true, '本机机器码对应的卡密应能通过本地校验');
    });

    test('layout/授权门：错误卡密给出提示，正确卡密解锁主界面', async function () {
      var msg = q(doc, '#license-msg');
      var act = q(doc, '#license-activate');
      var input = q(doc, '#license-input');

      input.value = 'XXXXXXXX-XXXX-XXXX-XXXX-XXXX';
      act.click();
      assertEq(text(msg), '正在校验…', '点击激活应立刻给出「正在校验…」反馈');
      await until(function () { return text(msg) && text(msg) !== '正在校验…'; }, 3000, '激活结果');
      assert(/不正确|不匹配/.test(text(msg)), '错误卡密应提示不正确，实际：' + text(msg));
      assert(L.document.body.classList.contains('locked'), '错误卡密不应解锁');

      input.value = L.__license.makeCard(L.__license.machineCode());
      act.click();
      await until(function () { return L.__layoutTool; }, 3000, 'bootApp 启动');
      assert(!L.document.body.classList.contains('locked'), '正确卡密应解锁主界面');
      assertEq(L.getComputedStyle(q(doc, '#license-gate')).display, 'none', '解锁后授权门应隐藏');
    });

    test('layout/文案输入实时同步且转义 HTML', async function () {
      setValue(q(doc, '#input-summary'), '<b>x</b>\n第二行', L);
      assertEq(q(doc, '#preview-summary').innerHTML, '&lt;b&gt;x&lt;/b&gt;<br>第二行', '顶部文案应转义并保留换行');
      setValue(q(doc, '#input-title'), '春季外套', L);
      assertEq(text(q(doc, '#preview-title')), '春季外套', '主标题应实时同步');
      setValue(q(doc, '#input-keywords'), '关键词A', L);
      assertEq(text(q(doc, '#preview-keywords')), '关键词A', '关键词应实时同步');
      setValue(q(doc, '#input-subtitle'), '我的尺码', L);
      assertEq(text(q(doc, '#preview-subtitle')), '我的尺码', '副标题应实时同步');
      [[1, '小标题一'], [2, '小标题二'], [3, '小标题三']].forEach(function (p) {
        setValue(q(doc, '#input-cap-' + p[0]), p[1], L);
        assertEq(text(q(doc, '#preview-cap-' + p[0])), p[1], '小标题' + p[0] + ' 应实时同步');
      });
    });

    test('layout/模板切换：只显示当前模板的控件与预览', async function () {
      var sel = q(doc, '#template-select');
      var target = q(doc, '#export-target');
      sel.value = 'three';
      fire(sel, 'change', L);
      assertEq(target.dataset.activeTpl, 'three', '导出区应记录当前模板');
      // applyTemplate 的契约：所有带 data-tpl 的元素里，只有属于当前模板的那批不被 hidden。
      // 预览块（#preview-img-left 等）是这些容器的子节点、自身没有 data-tpl，
      // 所以必须断言容器的 hidden + 子节点的实际渲染状态，而不是子节点自己的 hidden 属性。
      function assertOnlyTpl(active, step) {
        var groups = qa(doc, '[data-tpl]');
        assert(groups.length > 0, step + '：页面应存在 data-tpl 分组');
        groups.forEach(function (el) {
          assertEq(el.hidden, el.dataset.tpl !== active,
            step + '：' + (el.id || el.className) + ' 的隐藏状态与当前模板不符');
        });
      }
      assertOnlyTpl('three', '模板二');
      assert(!q(doc, '.three-list[data-tpl="three"]').hidden, '模板二：三图预览容器应显示');
      assert(q(doc, '.image-row[data-tpl="window"]').hidden, '模板二：模板一的图片预览容器应隐藏');
      assert(isRendered(q(doc, '#preview-wide-1')), '模板二：三图预览块应真正参与渲染');
      assert(!isRendered(q(doc, '#preview-img-left')), '模板二：模板一的预览块不应参与渲染');

      sel.value = 'window';
      fire(sel, 'change', L);
      assertEq(target.dataset.activeTpl, 'window', '切回后导出区应记录模板一');
      assertOnlyTpl('window', '模板一');
      assert(!q(doc, '.image-row[data-tpl="window"]').hidden, '切回模板一：图片预览容器应显示');
      assert(q(doc, '.three-list[data-tpl="three"]').hidden, '切回模板一：三图预览容器应隐藏');
      assert(isRendered(q(doc, '#preview-img-left')), '切回模板一：图片预览块应真正参与渲染');
      assert(!isRendered(q(doc, '#preview-wide-1')), '切回模板一：三图预览块不应参与渲染');
    });

    test('layout/安全区辅助线开关', async function () {
      var toggle = q(doc, '#toggle-safe');
      var zone = q(doc, '#safe-zone');
      toggle.checked = false;
      fire(toggle, 'change', L);
      assert(!hasClass(zone, 'active'), '取消勾选应隐藏安全区辅助线');
      toggle.checked = true;
      fire(toggle, 'change', L);
      assert(hasClass(zone, 'active'), '勾选应显示安全区辅助线');
    });

    test('layout/图片上传：三种框型均成功并给出反馈', async function () {
      var jobs = [
        ['#upload-left', '#preview-img-left', 'cover', 528, 528],
        ['#upload-screenshot-left', '#preview-screenshot-left', 'contain', 528, 704],
        ['#upload-wide-1', '#preview-wide-1', 'notch', 1100, 458]
      ];
      for (var i = 0; i < jobs.length; i++) {
        var input = q(doc, jobs[i][0]);
        var label = q(doc, 'label[for="' + jobs[i][0].slice(1) + '"]');
        attachFile(L, input, 'pic' + i + '.png', 'image/png', pngBytes(L, 120, 90));
        await until(function () { return /^已上传：/.test(text(label)); }, 4000, jobs[i][0] + ' 上传反馈');
        var box = q(doc, jobs[i][1]);
        var cv = box.querySelector('canvas.preview-photo');
        assert(cv, jobs[i][0] + ' 应把照片绘制进预览框');
        assertEq(cv.width, jobs[i][3], jobs[i][0] + ' 位图宽度');
        assertEq(cv.height, jobs[i][4], jobs[i][0] + ' 位图高度');
      }
    });

    test('layout/图片上传失败时给出反馈（不能静默无反应）', async function () {
      var input = q(doc, '#upload-right');
      var label = q(doc, 'label[for="upload-right"]');
      attachFile(L, input, 'broken.png', 'image/png', new Uint8Array([1, 2, 3, 4, 5]));
      await until(function () { return /失败|异常/.test(text(label)); }, 4000, '损坏文件反馈');
      assert(/读取失败|尺寸异常/.test(text(label)), '损坏文件应提示失败，实际：' + text(label));
    });

    test('layout/导出按钮：忙碌反馈 + 正常收尾', async function () {
      var btn = q(doc, '#export-btn');
      var msg = q(doc, '#export-msg');
      await until(function () { return !btn.disabled; }, 3000, '导出按钮可用');
      btn.click();
      assertEq(text(btn), '导出中…', '点击导出应立刻变为「导出中…」');
      assert(btn.disabled, '导出过程中按钮应禁用，避免重入');
      await until(function () { return text(btn) === '导出为图片' && !btn.disabled; }, 30000, '导出收尾');
      // 两端的成功反馈本就不同（PWA 走 <a download> 后不留提示；安卓走原生落盘会写「已保存到相册：…」），
      // 这层差异由下一条「外壳」用例负责断言，这里只保证「没有报错」。
      assert(!/失败/.test(text(msg)), '导出不应报错，实际：' + text(msg));
      assert(hasClass(q(doc, '#safe-zone'), 'active'), '导出结束后安全区辅助线应恢复到勾选状态');
    });

    test('layout/外壳：导出落盘 —— 安卓走原生桥，PWA 走文档化回退', async function () {
      var btn = q(doc, '#export-btn');
      var msg = q(doc, '#export-msg');
      var calls = saverCalls.layout;
      var before = calls.length;
      await until(function () { return !btn.disabled; }, 3000, '导出按钮可用');
      btn.click();
      await until(function () { return text(btn) === '导出为图片' && !btn.disabled; }, 30000, '导出收尾');

      if (calls.length === before) {
        // 没有调用原生桥：只允许出现在「PWA 外壳」这一侧，且必须能证明源码里确实没有这条路径，
        // 而不是安卓壳没能走到桥就悄悄回退（那种情况必须判失败）。
        assert(!hasSaverRef(L),
          '没有调用原生桥，页面源码里也不应出现 AndroidSaver：两端外壳差异必须由 @shell 标记明确表达');
        assert(!/失败/.test(text(msg)), '回退分支也不应报错，实际：' + text(msg));
        skip('PWA 外壳没有 AndroidSaver 桥（@shell:android-save / image-export 在 PWA 里不存在），'
          + '导出走 <a download> + 手动保存回退；安卓壳对应路径由「安卓副本」那次运行覆盖');
      }

      var call = calls[calls.length - 1];
      assertMatch(call.name, /^排版图_\d+\.png$/, '原生落盘文件名应带时间戳');
      assertEq(call.mime, 'image/png', '原生落盘 MIME 类型');
      assertMatch(call.base64, /^iVBORw0KGgo/, '原生落盘内容应是 PNG 的 base64（不能是空串或乱码）');
      assertMatch(text(msg), /^已保存到相册：/, '安卓壳应提示「已保存到相册」，实际：' + text(msg));
    });

    test('layout/文案超长时禁用导出并提示，清空后恢复', async function () {
      var btn = q(doc, '#export-btn');
      var warn = q(doc, '#overflow-warn');
      setValue(q(doc, '#input-summary'), new Array(220).join('超长文案测试一二三四五'), L);
      await until(function () { return btn.disabled; }, 4000, '超长内容应禁用导出');
      assert(hasClass(warn, 'show'), '超长内容应显示溢出提示');
      setValue(q(doc, '#input-summary'), '短文案', L);
      await until(function () { return !btn.disabled; }, 4000, '清空后应恢复可导出');
      assert(!hasClass(warn, 'show'), '恢复后应隐藏溢出提示');
    });

    test('layout/手写字体切换即时生效并给出加载状态', async function () {
      var sel = q(doc, '#font-select');
      var status = q(doc, '#font-status');
      fire(sel, 'change', L);
      assertEq(L.document.documentElement.style.getPropertyValue('--handwriting-font'), sel.value, '应写入手写字体变量');
      assert(hasClass(q(doc, '#canvas-wrapper'), 'web-font'), '应挂上 web-font 类');
      assertEq(text(status), '正在加载在线字体…', '应立刻显示加载状态');
      await until(function () { return text(status) !== '正在加载在线字体…'; }, 30000, '字体加载收敛');
      assert(/已加载|加载失败/.test(text(status)), '字体状态应收敛为终态，实际：' + text(status));
    });

    test('layout/纯函数：escapeHtml / computeDrawRect / isMobileUA', async function () {
      var t = app();
      assertEq(t.escapeHtml('a<b>&"\''), 'a&lt;b&gt;&amp;"\'', 'escapeHtml 应只转义 & < >');
      var img = { w: 400, h: 200 };
      [['cover', 528, 528], ['contain', 528, 704], ['notch', 1100, 458]].forEach(function (c) {
        var r = t.computeDrawRect(img.w, img.h, c[1], c[2], c[0]);
        assertEq(r.dw / r.dh, img.w / img.h, c[0] + ' 模式不得变形（宽高比必须保持）');
        if (c[0] === 'contain') {
          assert(r.dw <= c[1] + 1e-6 && r.dh <= c[2] + 1e-6, 'contain 必须完整放入框内');
        } else {
          assert(r.dw >= c[1] - 1e-6 && r.dh >= c[2] - 1e-6, c[0] + ' 必须铺满框');
        }
      });
      assertEq(t.isMobileUA('Mozilla/5.0 (Linux; Android 13; V2456A)'), true, '安卓 UA 应识别为移动端');
      assertEq(t.isMobileUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)'), true, 'iOS UA 应识别为移动端');
      assertEq(t.isMobileUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), false, '桌面 UA 不应识别为移动端');
    });

    test('layout/在线清单：篡改被拒、白名单通过、吊销拒绝', async function () {
      var lic = L.__license;
      var gen = C.__cardGen; // 签名一律由卡密生成器产出：两端算法必须逐字一致，主程序才可能认
      var card = lic.makeCard('ABCD-EFGH-JKMN-PQRS');
      var cardNorm = lic.normalize(card); // 清单里存的是去分隔符的卡密，签名载荷也用它
      var updated = '2026-10-14';
      // 前置步骤为了让「离线激活」路径生效而清空过 MANIFEST_URL；这里先放一个占位地址，
      // onlineDecision 才会去查 manifest，而不是直接返回「未启用在线清单」。
      lic.setManifestUrl('https://example.invalid/cards.json');

      // 1) 签名对不上的清单必须被整份拒绝
      var badUrl = blobUrl(L, { updated: updated, cards: [cardNorm], revoked: [], sig: 'deadbeef' });
      await lic.fetchManifest(badUrl);
      L.URL.revokeObjectURL(badUrl);
      assertEq(lic.getManifest(), null, '签名错误的清单不得被采纳');
      assert(/签名/.test(lic.onlineDecision(card).msg), '应提示签名校验失败，实际：' + lic.onlineDecision(card).msg);

      // 2) 生成器签出的合法清单，且卡密在白名单：通过
      var goodUrl = blobUrl(L, {
        updated: updated, cards: [cardNorm], revoked: [],
        sig: gen.manifestSignature(updated, [cardNorm], [])
      });
      await lic.fetchManifest(goodUrl);
      L.URL.revokeObjectURL(goodUrl);
      var m = lic.getManifest();
      assert(m && m.verified === true, '生成器签出的清单应能通过主程序验签（两端算法必须一致）');
      assertEq(m.cards[cardNorm], true, '白名单应包含该卡密');
      var d = lic.onlineDecision(card);
      assertEq(d.ok, true, '白名单内的卡密应通过在线判定');
      assertEq(d.decided, true, '应记录为已联网判定');

      // 3) 同一卡密进入吊销名单：拒绝
      var revUrl = blobUrl(L, {
        updated: updated, cards: [], revoked: [cardNorm],
        sig: gen.manifestSignature(updated, [], [cardNorm])
      });
      await lic.fetchManifest(revUrl);
      L.URL.revokeObjectURL(revUrl);
      var d2 = lic.onlineDecision(card);
      assertEq(d2.ok, false, '已吊销的卡密应被拒绝');
      assert(/吊销/.test(d2.msg), '应提示已吊销，实际：' + d2.msg);

      // 收尾：把清单与地址恢复成「纯离线」，避免这份吊销清单影响后续用例
      lic.setManifestUrl('');
      await lic.fetchManifest('');
      assertEq(lic.getManifest(), null, '收尾后应清空清单，回到纯离线校验');
    });

    function blobUrl(win, obj) {
      return win.URL.createObjectURL(new win.Blob([JSON.stringify(obj)], { type: 'application/json' }));
    }
  }

  // ================================================================
  // lmt-cardgen（卡密生成器）
  // ================================================================
  function cardgenCases(C) {
    var doc = C.document;
    function g() {
      assert(C.__cardGen, 'cardgen 脚本未初始化');
      return C.__cardGen;
    }

    test('cardgen/登录门：默认遮挡且错误提示可见', async function () {
      var gate = q(doc, '#auth-gate');
      assertEq(gate.style.display, 'flex', '未登录时应显示登录层');
      assertEq(g().isLoggedIn(), false, '初始不应处于登录态');
      var err = q(doc, '#auth-err');
      assertEq(text(err), '', '初始错误提示应为空');

      q(doc, '#auth-user').value = '';
      q(doc, '#auth-pass').value = '';
      q(doc, '#auth-btn').click();
      assertEq(text(err), '账号或密码错误', '登录按钮必须给出错误提示（不能点了没反应）');

      q(doc, '#auth-user').value = '944807230';
      q(doc, '#auth-pass').value = '错误密码';
      var ev = new C.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
      q(doc, '#auth-pass').dispatchEvent(ev);
      assertEq(text(err), '账号或密码错误', '回车也应触发登录校验');
      assertEq(gate.style.display, 'flex', '密码错误不应放行');
    });

    test('cardgen/生成卡密：条数、卡密值、忽略非法行', async function () {
      g().setLedger('ABCD-EFGH-JKMN-PQRS,张三\nSTVW-XYZ0-1234-5678\n随便一行不是机器码\nABCD-EFGH-JKMN-PQRS');
      q(doc, '#gen-btn').click();
      var items = qa(doc, '#out .item');
      assertEq(items.length, 2, '应只生成 2 条（非法行与重复行被忽略）');
      assertMatch(text(q(doc, '#out-title')), /2 条/, '结果标题应显示条数');
      assertEq(text(items[0].querySelector('.card-code')), g().makeCard('ABCDEFGHJKMNPQRS'), '第一条卡密值应正确');
      assertEq(text(items[1].querySelector('.card-code')), g().makeCard('STVWXYZ012345678'), '第二条卡密值应正确');
      assertEq(text(items[0].querySelector('.note')), '张三', '应保留备注');
      assert(text(items[0].querySelector('button')) === '复制卡密', '每条结果应有复制按钮');
    });

    test('cardgen/复制按钮：点击必有反馈（含手动复制兜底）', async function () {
      var btn = qa(doc, '#out .item button')[0];
      await clickCopyAndAssertFeedback(btn, '结果列表的复制卡密');
      var mask = doc.querySelector('.manual-copy-mask');
      if (mask) {
        assertEq(mask.getAttribute('role'), 'dialog', '手动复制兜底层应声明 role=dialog');
        assertEq(mask.getAttribute('aria-modal'), 'true', '手动复制兜底层应声明 aria-modal');
        assert(hasClass(doc.body, 'modal-open'), '弹层打开时应锁定背景滚动');
        closeLayers(doc);
        assert(!hasClass(doc.body, 'modal-open'), '弹层关闭后应恢复背景滚动');
      }
    });

    test('cardgen/空台账：各按钮均给出明确反馈', async function () {
      g().setLedger('');
      q(doc, '#gen-btn').click();
      assert(doc.querySelector('#out .empty'), '空台账应显示「暂无结果」占位');
      var copyAll = q(doc, '#copy-all');
      copyAll.click();
      assertEq(text(copyAll), '无结果', '空台账点「复制全部」应提示无结果');
      var exp = q(doc, '#export-btn');
      exp.click();
      assertEq(text(exp), '台账为空', '空台账点「导出台账」应提示台账为空');
      var del = q(doc, '#deliver-btn');
      del.click();
      assertEq(text(del), '无结果', '空台账点「复制交付文案」应提示无结果');
    });

    test('cardgen/导入台账文件（含卡密列与 BOM）', async function () {
      var csv = '\uFEFF机器码,卡密,备注\r\nABCD-EFGH-JKMN-PQRS,XXXX-XXXX-XXXX-XXXX-XXXX,张三\r\nSTVW-XYZ0-1234-5678,,李四\r\n';
      var input = q(doc, '#import-file');
      attachFile(C, input, 'ledger.csv', 'text/csv', new TextEncoder().encode(csv));
      var btn = q(doc, '#import-btn');
      await until(function () { return /已导入|无新机器码|读取失败/.test(text(btn)); }, 4000, '导入反馈');
      assertEq(text(btn), '已导入 +2', '应反馈导入条数');
      assert(/ABCD-EFGH-JKMN-PQRS/.test(q(doc, '#mc-list').value), '台账应写入机器码');
      assertEq(input.value, '', '导入后应清空 input，允许重复导入同一文件');
      assertEq(qa(doc, '#out .item').length, 2, '导入后应重排结果列表');
    });

    test('cardgen/台账备份导出与恢复（含格式校验）', async function () {
      var btn = q(doc, '#backup-btn');
      btn.click();
      await until(function () { return /已导出|请手动复制|已保存/.test(text(btn)); }, 4000, '备份反馈');
      assert(/已导出|请手动复制|已保存/.test(text(btn)), '备份应给出反馈，实际：' + text(btn));
      closeLayers(doc);

      var restoreInput = q(doc, '#restore-file');
      var rbtn = q(doc, '#restore-btn');
      attachFile(C, restoreInput, 'bad.json', 'application/json', new TextEncoder().encode('这不是备份'));
      await until(function () { return text(rbtn) !== '恢复备份'; }, 4000, '格式错误反馈');
      assertEq(text(rbtn), '文件格式不对', '非本工具备份应提示格式不对');
      closeLayers(doc);

      var backup = JSON.stringify({
        format: 'lmt-ledger-backup', version: 1, savedAt: '2026-10-14T00:00:00.000Z',
        ledger: 'WXYZ-0123-4567-89AB,王五', revoke: 'H7S0-6M3M-GMA1-Y7T2-VNRM'
      });
      attachFile(C, restoreInput, 'ok.json', 'application/json', new TextEncoder().encode(backup));
      await until(function () { return /已恢复|已合并/.test(text(rbtn)); }, 4000, '恢复反馈');
      assert(/已恢复|已合并/.test(text(rbtn)), '恢复应给出反馈，实际：' + text(rbtn));
      assert(/WXYZ-0123-4567-89AB/.test(q(doc, '#mc-list').value), '恢复后台账应包含备份里的机器码');
      assert(/H7S0-6M3M-GMA1-Y7T2-VNRM/.test(q(doc, '#revoke-list').value), '恢复后吊销名单应取并集');
      assertEq(restoreInput.value, '', '恢复后应清空 input');
    });

    test('cardgen/在线清单 JSON：生成、签名自校验、复制', async function () {
      g().setLedger('ABCD-EFGH-JKMN-PQRS,张三');
      setValue(q(doc, '#revoke-list'), 'H7S0-6M3M-GMA1-Y7T2-VNRM', C, 'input');
      var copyBtn = q(doc, '#copy-manifest');
      await clickCopyAndAssertFeedback(copyBtn, '复制清单 JSON');
      closeLayers(doc);

      var out = q(doc, '#manifest-out');
      var obj = JSON.parse(out.value);
      assertMatch(obj.updated, /^\d{4}-\d{2}-\d{2}$/, 'updated 应为本地日期');
      assertEq(obj.cards.length, 1, '白名单应有 1 张卡密');
      assertEq(obj.cards[0], g().makeCard('ABCDEFGHJKMNPQRS'), '白名单应是台账对应的卡密');
      assertEq(obj.revoked.length, 1, '吊销名单应有 1 张卡密');
      assertEq(obj.revoked[0], 'H7S0-6M3M-GMA1-Y7T2-VNRM', '吊销名单应保留分组写法');
      assertEq(obj.sig, g().manifestSignature(obj.updated, obj.cards, obj.revoked), 'sig 必须与算法一致（主程序据此验签）');
      assertMatch(obj.sig, /^[0-9a-f]{64}$/, 'sig 应为 64 位小写 hex');
    });

    test('cardgen/令牌保存与清除，以及上传前置提示', async function () {
      var saveBtn = q(doc, '#gh-token-save');
      var clearBtn = q(doc, '#gh-token-clear');
      var input = q(doc, '#gh-token');

      input.value = '';
      saveBtn.click();
      assertEq(text(saveBtn), '令牌为空', '空令牌点保存应提示');

      input.value = 'ghp_测试令牌';
      saveBtn.click();
      assertEq(text(saveBtn), '已保存', '保存令牌应有反馈');
      assertEq(g().getToken(), 'ghp_测试令牌', '令牌应写入本地存储');
      assertEq(input.value, '', '保存后应清空输入框，避免令牌停留在 DOM');
      assert(/已保存/.test(input.placeholder), '占位文案应变为「已保存」提示');

      clearBtn.click();
      assertEq(text(clearBtn), '已清除', '清除令牌应有反馈');
      assertEq(g().getToken(), '', '令牌应被清除');
      assertEq(input.placeholder, '粘贴令牌后点「保存令牌」', '占位文案应还原');

      var up = q(doc, '#upload-btn');
      up.click();
      assertEq(text(up), '需先填令牌', '未保存令牌点上传应提示');
      assert(text(q(doc, '#upload-tip')).length > 0, '上传提示区应给出说明');
    });

    test('cardgen/清空台账', async function () {
      g().setLedger('ABCD-EFGH-JKMN-PQRS,张三');
      q(doc, '#gen-btn').click();
      assert(qa(doc, '#out .item').length === 1, '清空前应有 1 条结果');
      q(doc, '#clear-btn').click();
      assertEq(q(doc, '#mc-list').value, '', '清空后台账应为空');
      assert(doc.querySelector('#out .empty'), '清空后应显示占位');
    });

    test('cardgen/外壳：导出台账 —— 安卓走原生桥，PWA 走文档化回退', async function () {
      g().setLedger('ABCD-EFGH-JKMN-PQRS,张三');
      q(doc, '#gen-btn').click();
      var b = q(doc, '#export-btn');
      var calls = saverCalls.cardgen;
      var before = calls.length;
      b.click();

      if (calls.length === before) {
        assert(!hasSaverRef(C),
          '没有调用原生桥，页面源码里也不应出现 AndroidSaver：两端外壳差异必须由 @shell 标记明确表达');
        assert(/已导出|请手动复制/.test(text(b)), '回退分支应给出下载/手动保存反馈，实际：' + text(b));
        closeLayers(doc);
        skip('PWA 外壳没有 AndroidSaver 桥（@shell:android-save / export 在 PWA 里不存在），'
          + '导出台账走 <a download> 回退；安卓壳对应路径由「安卓副本」那次运行覆盖');
      }

      var call = calls[calls.length - 1];
      assertMatch(call.name, /^卡密台账_\d{8}\.csv$/, '原生落盘文件名');
      assertEq(call.mime, 'text/csv', '原生落盘 MIME 类型');
      // 用应用自己的 base64ToUtf8 解回来，顺带证明桥这头的编码契约（UTF-8）没被写错
      var csv = g().base64ToUtf8(call.base64);
      assert(/^\uFEFF机器码,卡密,备注/.test(csv), '原生落盘内容应是带 BOM 与表头的台账 CSV，实际开头：' + JSON.stringify(csv.slice(0, 20)));
      assert(/ABCD-EFGH-JKMN-PQRS/.test(csv), '原生落盘内容应包含台账里的机器码');
      assertEq(text(b), '已保存', '安卓壳应提示「已保存」，实际：' + text(b));
    });

    test('cardgen/外壳：下载模板 —— 安卓走原生桥，PWA 走文档化回退', async function () {
      var b = q(doc, '#template-btn');
      var calls = saverCalls.cardgen;
      var before = calls.length;
      b.click();

      if (calls.length === before) {
        assert(!hasSaverRef(C),
          '没有调用原生桥，页面源码里也不应出现 AndroidSaver：@shell:template 只在安卓壳里，PWA 侧必须是干净的回退');
        assert(/已下载|请手动复制/.test(text(b)), '回退分支应给出下载/手动保存反馈，实际：' + text(b));
        closeLayers(doc);
        skip('PWA 外壳没有模板原生落盘（@shell:template 只存在于安卓壳），模板走 <a download> 回退；'
          + '安卓壳对应路径由「安卓副本」那次运行覆盖');
      }

      var call = calls[calls.length - 1];
      assertEq(call.name, '卡密导入模板.csv', '原生落盘文件名');
      assertEq(call.mime, 'text/csv', '原生落盘 MIME 类型');
      assert(/^\uFEFF机器码,卡密,备注/.test(g().base64ToUtf8(call.base64)), '原生落盘内容应是带 BOM 与表头的模板 CSV');
      assertEq(text(b), '已保存', '安卓壳应提示「已保存」，实际：' + text(b));
    });

    test('cardgen/对照线上清单：点击即反馈并收敛到终态', async function () {
      var btn = q(doc, '#online-check-btn');
      var tip = q(doc, '#online-tip');
      btn.click();
      assertEq(text(btn), '查询中…', '点击对照应立刻变为「查询中…」');
      await until(function () { return text(tip) && !/^正在拉取/.test(text(tip)); }, 30000, '在线对照收敛');
      assert(/无法连接|线上清单更新于/.test(text(tip)), '提示应收敛为终态，实际：' + text(tip));
    });

    test('cardgen/自动上传开关', async function () {
      var cb = q(doc, '#auto-upload');
      var tip = q(doc, '#upload-tip');
      cb.checked = true;
      fire(cb, 'change', C);
      assertEq(text(tip), '已开启自动上传，但还没有保存令牌。', '开启自动上传应提示缺少令牌');
      assertEq(C.localStorage.getItem('lmt_gh_auto_v1'), '1', '开关状态应持久化');
      cb.checked = false;
      fire(cb, 'change', C);
      assertEq(text(tip), '已关闭自动上传。', '关闭自动上传应有提示');
    });

    test('cardgen/台账输入防抖自动保存并更新统计', async function () {
      var list = q(doc, '#mc-list');
      list.value = 'ABCD-EFGH-JKMN-PQRS,张三';
      fire(list, 'input', C);
      await until(function () { return /ABCD/.test(String(C.localStorage.getItem('lmt_ledger_v1') || '')); }, 6000, '台账落盘');
      assertEq(C.localStorage.getItem('lmt_ledger_v1'), 'ABCD-EFGH-JKMN-PQRS,张三', '台账应原样落盘');
      var tip = q(doc, '#ledger-tip');
      await until(function () { return /1 位用户/.test(text(tip)); }, 6000, '台账统计');
      assertMatch(text(tip), /1 位用户/, '统计应显示去重后的用户数');
    });

    test('cardgen/纯函数：解析/去重/合并/CSV 往返/Base64', async function () {
      var t = g();
      assertEq(t.normalize('ab-cd 12'), 'ABCD12', 'normalize 应转大写去分隔符');
      assertEq(t.normalize(null), '', 'normalize(null) 应为空串');
      assertEq(t.splitRows('"a\nb",c').length, 1, '引号内的换行不应拆行');
      assertEq(t.splitRows('a\nb').length, 2, '普通换行应拆行');

      assertDeepEq(t.parseEntry('ABCD-EFGH-JKMN-PQRS,张三'),
        { key: 'ABCDEFGHJKMNPQRS', mc: 'ABCD-EFGH-JKMN-PQRS', note: '张三' }, '解析「机器码,备注」');
      assertDeepEq(t.parseEntry('ABCD-EFGH-JKMN-PQRS,XXXX-XXXX-XXXX-XXXX-XXXX,张三'),
        { key: 'ABCDEFGHJKMNPQRS', mc: 'ABCD-EFGH-JKMN-PQRS', note: '张三' }, '带卡密列的 CSV 行应自动丢弃卡密');
      assertDeepEq(t.parseEntry('ABCD-EFGH-JKMN-PQRS 张三'),
        { key: 'ABCDEFGHJKMNPQRS', mc: 'ABCD-EFGH-JKMN-PQRS', note: '张三' }, '空格分隔的备注应识别');
      assertEq(t.parseEntry('随便一行'), null, '非法机器码应返回 null');
      assertEq(t.parseEntry(''), null, '空行应返回 null');

      assertEq(t.uniqueEntries('ABCD-EFGH-JKMN-PQRS\nABCD-EFGH-JKMN-PQRS,张三').length, 1, '重复机器码应去重');
      assertEq(t.uniqueEntries('ABCD-EFGH-JKMN-PQRS\nABCD-EFGH-JKMN-PQRS,张三')[0].note, '张三', '去重时应补全备注');
      assertEq(t.mergeCodes('ABCD-EFGH-JKMN-PQRS\n', 'STVW-XYZ0-1234-5678\nABCD-EFGH-JKMN-PQRS').split('\n').length, 2, '合并应按机器码去重');

      // csvCell 没有对外暴露，改由导出侧真正用到的 entryLine 走一遍：
      // 它内部就是 csvCell 转义，覆盖点等价，且顺带验证往返不损坏备注。
      var e = { mc: 'ABCD-EFGH-JKMN-PQRS', note: '张三，李四' };
      assertEq(t.entryLine(e), 'ABCD-EFGH-JKMN-PQRS,"张三，李四"', '含全角逗号的备注应加引号');
      assertEq(t.parseEntry(t.entryLine(e)).note, '张三，李四', 'CSV 往返不得损坏备注');
      // 含引号的备注：写出时必须加引号并把内部引号翻倍，读回时仍要还原成原样。
      // （解析侧只把「字段开头」的引号当引用符号，所以字段中间的引号不会吞掉后面的内容）
      var q1 = { mc: 'ABCD-EFGH-JKMN-PQRS', note: '5\'6"' };
      assertEq(t.entryLine(q1), 'ABCD-EFGH-JKMN-PQRS,"5\'6"""', '含引号的备注应加引号并把内部引号翻倍');
      assertEq(t.parseEntry(t.entryLine(q1)).note, '5\'6"', '含引号的备注往返后应原样保留');
      assertEq(t.parseEntry('ABCD-EFGH-JKMN-PQRS,5\'6"').note, '5\'6"', '字段中间的引号应按普通字符保留');

      assertEq(t.extractMc('ABCD-EFGH-JKMN-PQRS').join(','), 'ABCD-EFGH-JKMN-PQRS', 'extractMc 应返回分组写法');
      assert(/^\uFEFF机器码,卡密,备注/.test(t.buildTemplateCsv()), '模板 CSV 应带 BOM 与表头');
      assert(/^机器码,卡密,备注/.test(t.buildLedgerCsv().replace(/^\uFEFF/, '')), '台账 CSV 应带表头');

      var raw = 'ABCD-EFGH-JKMN-PQRS-1234';
      assertMatch(t.makeCard('abcd efgh j/kmn-pqrs-1234'), /^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/, '卡密应为 5 组 20 位');
      assertEq(t.makeCard('abcd efgh j/kmn-pqrs-1234'), t.makeCard('ABCDEFGHJKMNPQRS1234'), '卡密应与写法无关（先归一化）');
      assertEq(t.manifestSignature('2026-10-14', ['abcd-efgh-jkmn-pqrs-1234'], []),
        t.manifestSignature('2026-10-14', ['ABCDEFGHJKMNPQRS1234'], []), '签名应与分组写法无关');
      assertMatch(t.manifestSignature('2026-10-14', [], []), /^[0-9a-f]{64}$/, '签名应为 64 位小写 hex');
      assert(t.manifestSignature('2026-10-14', ['A'], []) !== t.manifestSignature('2026-10-15', ['A'], []), 'updated 变化应改变签名');

      assertDeepEq(t.parseManifestTarget(), { owner: 'yejiawei19991118', repo: 'lmt-cards', branch: 'main', path: 'cards.json' }, '应从 MANIFEST_URL 解析出上传目标');
      assertEq(t.base64ToUtf8(t.utf8ToBase64('中文\n换行')), '中文\n换行', 'Base64 往返应保持 UTF-8');
      assertEq(t.applyLedgerBackup('不是 JSON'), null, '非 JSON 应返回 null');
      assertEq(t.applyLedgerBackup('{"format":"other"}'), null, '其它格式应返回 null');
      assertMatch(t.hashAuth('944807230', 'x'), /^[0-9a-f]{64}$/, '登录哈希应为 64 位 hex');
      assert(t.hashAuth('a', 'b') !== t.hashAuth('a', 'c'), '不同密码应得到不同哈希');
      assertEq(t.isLoggedIn(), false, '未登录时 isLoggedIn 应为 false');

      var merged = t.mergeWithRemote(
        { updated: '2026-10-14', cards: ['ABCD-EFGH-JKMN-PQRS-1234'], revoked: [] },
        { cards: ['ABCD-EFGH-JKMN-PQRS-1234', 'STVW-XYZ0-1234-5678-89AB'], revoked: ['H7S0-6M3M-GMA1-Y7T2-VNRM'] });
      assertEq(merged.cards.length, 2, '合并白名单应取并集并去重');
      assertEq(merged.revoked.length, 1, '合并吊销名单应取并集');
      assertEq(merged.sig, t.manifestSignature(merged.updated, merged.cards, merged.revoked), '合并后必须重新签名');
      assertEq(raw.length, 24, '用例自检');
    });
  }

  // ================================================================
  // 跨应用一致性 + 全局无异常
  // ================================================================
  function crossCases(L, C) {
    test('跨应用：卡密算法与清单签名必须逐字一致', async function () {
      assert(L.__license && C.__cardGen, '两个应用都应已初始化');
      var mc = 'ABCD-EFGH-JKMN-PQRS';
      var a = C.__cardGen.makeCard(mc);
      var b = L.__license.makeCard(mc);
      assertEq(a, b, '生成器与主程序的卡密算法必须一致（否则生成的卡密无法激活）');
      assertEq(L.__license.normalize('ab-cd 12'), C.__cardGen.normalize('ab-cd 12'), '两侧归一化规则必须一致');
      assertMatch(a, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/, '卡密应为 5 组 20 位');

      // 生成器产出的清单必须能被主程序验签并通过在线判定
      var updated = '2026-10-14';
      var cards = [a];
      var sig = C.__cardGen.manifestSignature(updated, cards, []);
      var url = L.URL.createObjectURL(new L.Blob(
        [JSON.stringify({ updated: updated, cards: cards, revoked: [], sig: sig })],
        { type: 'application/json' }));
      await L.__license.fetchManifest(url);
      L.URL.revokeObjectURL(url);
      var m = L.__license.getManifest();
      assert(m && m.verified === true, '主程序必须能验签生成器产出的清单');
      assertEq(L.__license.onlineDecision(a).ok, true, '生成器产出的卡密必须能通过主程序的在线判定');
    });

    test('全局：两个应用均无未捕获异常', async function () {
      assertEq(pageErrors.length, 0, '不应出现未捕获异常：\n' + pageErrors.join('\n'));
    });
  }

  // ================================================================
  // 运行器
  // ================================================================
  async function run() {
    var lf = await frameReady('frame-layout');
    var cf = await frameReady('frame-cardgen');
    var L = lf.contentWindow, C = cf.contentWindow;
    // 两端对称：同一个「假原生落盘桥」注入两个 iframe。只有安卓外壳的代码会去读它，
    // 于是安卓壳独有的落盘分支在执行层面真的被跑到，PWA 侧则被显式标注为跳过。
    installFakeSaver(lf, 'layout');
    installFakeSaver(cf, 'cardgen');
    watchErrors(L, 'layout');
    watchErrors(C, 'cardgen');

    await until(function () { return L.__license && C.__cardGen; }, 8000, '应用脚本初始化');

    // 前置：把主程序的在线清单关掉（纯本地校验），让测试不依赖网络
    L.__license.setManifestUrl('');
    await L.__license.fetchManifest('');
    L.__license.deactivate();

    layoutCases(L, C);
    cardgenCases(C);
    crossCases(L, C);

    for (var i = 0; i < CASES.length; i++) {
      var c = CASES[i];
      try {
        await c.fn();
        results.push({ name: c.name, ok: true });
      } catch (e) {
        var why = (e && e.message) || String(e);
        if (e && e.__skip) results.push({ name: c.name, ok: true, skipped: true, note: why });
        else results.push({ name: c.name, ok: false, error: why });
      }
    }
  }

  function render() {
    var failed = results.filter(function (r) { return !r.ok; });
    var skipped = results.filter(function (r) { return r.skipped; });
    var entry = window.__entry || {};
    var lines = [];
    // 报告头写明本次实际跑的是哪一份副本：同一套用例会分别对 PWA 与安卓 assets 各跑一遍
    if (entry.layout) lines.push('入口 layout ：' + entry.layout);
    if (entry.cardgen) lines.push('入口 cardgen：' + entry.cardgen);
    lines.push('');
    results.forEach(function (r) {
      lines.push((r.skipped ? '[SKIP] ' : (r.ok ? '[PASS] ' : '[FAIL] ')) + r.name);
      if (r.skipped) lines.push('       → 跳过原因：' + r.note);
      if (!r.ok) lines.push('       → ' + String(r.error).split('\n').join('\n       '));
    });
    lines.push('');
    lines.push('合计 ' + results.length + ' 项，通过 ' + (results.length - failed.length - skipped.length)
      + ' 项，跳过 ' + skipped.length + ' 项，失败 ' + failed.length + ' 项。');
    document.getElementById('report').textContent = lines.join('\n');
    document.title = 'LMTTEST ' + (failed.length ? 'fail' : 'pass') + ' ' + (results.length - failed.length) + '/' + results.length
      + (skipped.length ? '（跳过 ' + skipped.length + '）' : '');
    teardown();
  }

  // 拆掉两个 iframe：应用内部存在常驻的 requestAnimationFrame / 定时器，
  // 只要它们还活着，无头浏览器的虚拟时钟就不会走完预算，--dump-dom 便迟迟不返回。
  // 报告已写在父页 DOM 上，拆帧不影响抓取结果。
  function teardown() {
    var frames = document.getElementById('frames');
    if (!frames) return;
    qa(frames, 'iframe').forEach(function (f) {
      try { f.src = 'about:blank'; } catch (e) { /* 忽略 */ }
      if (f.parentNode) f.parentNode.removeChild(f);
    });
    if (frames.parentNode) frames.parentNode.removeChild(frames);
  }

  window.addEventListener('load', function () {
    run().then(render, function (e) {
      document.getElementById('report').textContent = '测试运行器异常：' + ((e && e.stack) || e);
      document.title = 'LMTTEST error';
    });
  });
})();
