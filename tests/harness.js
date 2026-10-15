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
  // 假桥的可调开关（用例里按需改写）：openOk 为 true 表示「原生侧真的把位置打开了」，
  // 用来覆盖「打开所在位置」的成功分支；默认 false，让外壳走到有界面反馈的兜底文案。
  var fakeSaver = { layout: { openOk: false, lastPath: '' }, cardgen: { openOk: false, lastPath: '' } };

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
  // 文件读取类用例（FileReader 读文件 / Image 解码）的等待上限。无头运行开了
  // --virtual-time-budget 快进定时器，虚拟时钟推进远快于真实时间，4000ms 的窗口在 CI 上
  // 折算成的真实时间很短，负载抖动时偶发「等待超时」误报（本机几乎不复现，故这类等待统一放宽）。
  var FILE_WAIT_MS = 15000;
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
        },
        // 安卓壳「打开所在位置」用到的两个原生能力（见 MainActivity）。
        // 默认都返回「拿不到」：外壳会因此走到「无法直接打开…」的兜底文案，
        // 该文案有可观察的界面反馈，正好用来断言按钮确实被接上了（而不是点了没反应）。
        // 用例可以改写 fakeSaver[key].openOk / .lastPath 来覆盖别的分支。
        lastSavedPath: function () { return fakeSaver[key].lastPath; },
        openLastSaved: function () { return fakeSaver[key].openOk; }
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
        await until(function () { return /^已上传：/.test(text(label)); }, FILE_WAIT_MS, jobs[i][0] + ' 上传反馈');
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
      await until(function () { return /失败|异常/.test(text(label)); }, FILE_WAIT_MS, '损坏文件反馈');
      assert(/读取失败|尺寸异常/.test(text(label)), '损坏文件应提示失败，实际：' + text(label));
    });

    test('layout/导出按钮：忙碌反馈 + 正常收尾', async function () {
      var btn = q(doc, '#export-btn');
      var msg = q(doc, '#export-msg');
      var beforeCall = saverCalls.layout.length;
      await until(function () { return !btn.disabled; }, 3000, '导出按钮可用');
      btn.click();
      assertEq(text(btn), '导出中…', '点击导出应立刻变为「导出中…」');
      assert(btn.disabled, '导出过程中按钮应禁用，避免重入');
      // 「导出收尾」不能只看按钮恢复：安卓外壳在 restore() 之后还要异步做 base64 编码 + 原生落盘，
      // 此时若就返回，仍在后台落盘的这次导出会串进下一条用例（把按钮留成禁用态）。
      // 故源码含原生桥时，必须等到桥被调用才算真的收尾。
      await until(function () {
        return text(btn) === '导出为图片' && !btn.disabled
            && (!hasSaverRef(L) || saverCalls.layout.length > beforeCall);
      }, 30000, '导出收尾');
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

      if (!hasSaverRef(L)) {
        // PWA 外壳：源码里根本没有 AndroidSaver（@shell:android-save / image-export 不在 PWA 里），
        // 导出走 <a download> 回退。先等导出收尾，再确认回退分支没有报错。
        await until(function () { return text(btn) === '导出为图片' && !btn.disabled; }, 30000, '导出收尾');
        assert(!/失败/.test(text(msg)), '回退分支也不应报错，实际：' + text(msg));
        skip('PWA 外壳没有 AndroidSaver 桥（@shell:android-save / image-export 在 PWA 里不存在），'
          + '导出走 <a download> + 手动保存回退；安卓壳对应路径由「安卓副本」那次运行覆盖');
      }

      // 安卓外壳：源码里有 AndroidSaver，导出就必须真的走到桥；没走到即「悄悄回退」，必须判失败。
      // 注意按钮恢复（restore）发生在异步 base64 编码之前，故不能只看按钮状态，
      // 必须等到桥被真正调用为止，否则会把「还在编码」误判成「没落盘」。
      await until(function () { return calls.length > before; }, FILE_WAIT_MS,
        '安卓壳导出必须调用原生桥（页面源码含 AndroidSaver，导出结束后却仍未落盘）');

      var call = calls[calls.length - 1];
      assertMatch(call.name, /^排版图_\d+\.png$/, '原生落盘文件名应带时间戳');
      assertEq(call.mime, 'image/png', '原生落盘 MIME 类型');
      assertMatch(call.base64, /^iVBORw0KGgo/, '原生落盘内容应是 PNG 的 base64（不能是空串或乱码）');
      assertMatch(text(msg), /^已保存到相册：/, '安卓壳应提示「已保存到相册」，实际：' + text(msg));

      // 落盘成功后安卓壳才挂出「打开所在位置」按钮（PWA 侧不伪造该能力，故不会出现）。
      // 假桥把「打开」与「最近路径」都返回「拿不到」，因此点击必须走到兜底文案 —— 有反馈即证明按钮真的接上了。
      var loc = await until(function () { return doc.querySelector('#open-location-btn'); },
        3000, '安卓壳落盘后应挂出「打开所在位置」按钮');
      assertEq(text(loc), '打开所在位置', '按钮文案');
      loc.click();
      assert(/无法直接打开/.test(text(msg)), '点击「打开所在位置」在拿不到原生能力时应给出兜底文案，实际：' + text(msg));

      // 兜底文案同样说明「最近一次导出确实落了盘」，按钮必须继续挂着；否则点一次就消失，用户想重试都没得点。
      var loc2 = await until(function () { return doc.querySelector('#open-location-btn'); },
        3000, '给出兜底文案后「打开所在位置」按钮仍应保留（否则点一次就消失，没法重试）');
      assertEq(text(loc2), '打开所在位置', '兜底后按钮文案');
      // 成功分支：原生侧真的打开了位置，外壳应立即把控制权交出去，不得再写任何兜底文案。
      // （Java 侧能否真的打开由 MainActivity 实现，浏览器里测不到，这里只锁页面这一层的契约。）
      fakeSaver.layout.openOk = true;
      var msgAfterFail = text(msg);
      loc2.click();
      assertEq(text(msg), msgAfterFail, '原生打开成功时不应改写导出提示（改写了说明仍走了兜底分支）');
      fakeSaver.layout.openOk = false;
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

    // ============================================================
    // 新增功能：草稿箱 / 批量出图（自研 ZIP） / 自定义模板 / 记忆 + 文案库
    // ============================================================
    test('layout/ZIP 打包：本地头 / 中央目录 / EOCD 签名与 CRC32 正确', async function () {
      var t = app();
      // CRC-32(IEEE) 标准检错向量："123456789" → 0xCBF43926
      var check = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]);
      assertEq(t.crc32(check), 0xCBF43926, 'CRC32 标准向量');

      var content = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      var name = 'a.png';
      var zip = t.zipStore([{ name: name, bytes: content }]);
      // 跨 realm：zipStore 在 iframe 内执行，返回的对象原型属于 iframe 的 Uint8Array
      assert(zip instanceof L.Uint8Array, 'zipStore 应返回 Uint8Array，实际 ' + (zip && zip.constructor && zip.constructor.name));
      function u16(b, i) { return b[i] | (b[i + 1] << 8); }
      function u32(b, i) { return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0; }
      var CRC = t.crc32(content);

      // 本地文件头：签名 / 版本 / 位标记 / 压缩方式 / CRC / 大小 / 文件名
      assertEq(u32(zip, 0), 0x04034b50, '应以本地文件头签名 0x04034b50 开头');
      assertEq(u16(zip, 6), 0x0800, '通用位标记应置 UTF-8 位（bit11）');
      assertEq(u16(zip, 8), 0, '压缩方式应为 store（0）');
      assertEq(u32(zip, 14), CRC, '本地头 CRC32 应等于内容的 CRC32');
      assertEq(u32(zip, 18), content.length, '压缩后大小应等于原始大小（store 不压缩）');
      assertEq(u32(zip, 22), content.length, '原始大小');
      assertEq(u16(zip, 26), name.length, '文件名长度应与 UTF-8 字节数一致');
      assertEq(Array.prototype.join.call(zip.subarray(30, 30 + name.length), ','), '97,46,112,110,103',
        '文件名应按 UTF-8 写入（a.png → 97,46,112,110,103）');

      // 中央目录：条目签名 / 压缩方式 / CRC / 指向的本地头偏移
      var centralStart = u32(zip, zip.length - 22 + 16);
      assertEq(u32(zip, centralStart), 0x02014b50, '中央目录起始处应是中央目录签名 0x02014b50');
      assertEq(u16(zip, centralStart + 10), 0, '中央目录压缩方式应为 store');
      assertEq(u32(zip, centralStart + 16), CRC, '中央目录 CRC32 应与内容一致');
      assertEq(u32(zip, centralStart + 42), 0, '中央目录记录的本地头偏移应为 0');
      assertEq(u16(zip, centralStart + 28), name.length, '中央目录里的文件名长度');

      // EOCD：签名 / 条目数 / 中央目录大小与偏移，并做一次总长自洽校验
      assertEq(u32(zip, zip.length - 22), 0x06054b50, '应以 EOCD 签名 0x06054b50 结尾');
      assertEq(u16(zip, zip.length - 22 + 10), 1, 'EOCD 应记录 1 个中央目录条目');
      var centralSize = u32(zip, zip.length - 22 + 12);
      assertEq(centralSize, 46 + name.length, '中央目录总长应为固定头(46) + 文件名');
      assertEq(zip.length, centralStart + centralSize + 22, '本地记录 + 中央目录 + EOCD 应恰好等于总长');

      // 两条目：条目数递增，中央目录偏移等于全部本地记录长度之和
      var zip2 = t.zipStore([{ name: '1.png', bytes: content }, { name: '2.png', bytes: content }]);
      assertEq(u16(zip2, zip2.length - 22 + 10), 2, '两条目应记录 2 个中央目录条目');
      assertEq(u32(zip2, zip2.length - 22 + 16), 2 * (30 + 5 + content.length),
        '中央目录偏移应等于全部本地记录长度之和');
    });

    test('layout/草稿箱：命名浮层有反馈 + 保存 / 载入 / 导出导入 / 删除', async function () {
      var t = app();
      t.listDrafts().slice().forEach(function (d) { t.deleteDraft(d.id); });
      assertEq(t.listDrafts().length, 0, '前置：草稿箱应为空');

      // 「保存草稿」必须先弹命名浮层（不能点了没反应）
      q(doc, '#draft-save-btn').click();
      var mask = await until(function () { return doc.querySelector('.lmt-modal-mask'); }, 3000, '保存草稿命名浮层');
      assertEq(text(mask.querySelector('h3')), '保存草稿', '浮层标题');
      var cancel = qa(mask, 'button').filter(function (b) { return text(b) === '取消'; })[0];
      assert(cancel, '命名浮层应有「取消」按钮');
      cancel.click();
      await until(function () { return !doc.querySelector('.lmt-modal-mask'); }, 3000, '命名浮层关闭');
      assertEq(t.listDrafts().length, 0, '取消命名不应产生草稿');

      // 保存：记录当前文案；改动后载入应逐字还原
      setValue(q(doc, '#input-title'), '草稿标题A', L);
      setValue(q(doc, '#input-subtitle'), '草稿副标题A', L);
      var saved = t.saveDraft('用例草稿A');
      assert(saved && saved.ok === true, '保存草稿应返回成功，实际 ' + JSON.stringify(saved));
      var list = t.listDrafts();
      assertEq(list.length, 1, '保存后应有 1 份草稿');
      assertEq(qa(doc, '#draft-select option').length, 2, '草稿下拉应多出 1 项（另有 1 个占位项）');

      setValue(q(doc, '#input-title'), '被改掉了', L);
      assertEq(t.loadDraft(list[0].id), true, '载入草稿应成功');
      assertEq(q(doc, '#input-title').value, '草稿标题A', '载入草稿应还原主标题');
      assertEq(text(q(doc, '#preview-title')), '草稿标题A', '载入草稿后预览应同步还原');

      // 导出 → 导入：往返不丢内容，且坏文件被拒
      assertEq(t.exportDrafts(), true, '导出草稿应返回成功');
      assertMatch(text(q(doc, '#draft-msg')), /已导出草稿文件/, '导出草稿应有反馈');
      var raw = JSON.stringify({ v: 1, items: t.listDrafts() });
      assertEq(t.deleteDraft(list[0].id), true, '删除草稿应成功');
      assertEq(t.listDrafts().length, 0, '删除后草稿箱应为空');
      assertEq(t.importDrafts('这不是 JSON'), false, '非法 JSON 应被拒绝');
      assertEq(t.importDrafts('{"v":1}'), false, '缺少 items 应被拒绝');
      assertEq(t.importDrafts(raw), true, '导入合法 JSON 应成功');
      var back = t.listDrafts();
      assertEq(back.length, 1, '导入后应恢复 1 份草稿');
      assertEq(back[0].fields.title, '草稿标题A', '导入应保留草稿里的文案');
      assertEq(t.loadDraft(back[0].id), true, '导入回来的草稿应可载入');
    });

    test('layout/我的模板：保存 / 列表 / 删除', async function () {
      var t = app();
      t.listMyTemplates().slice().forEach(function (x) { t.deleteMyTemplate(x.id); });
      assertEq(t.listMyTemplates().length, 0, '前置：应无自定义模板');

      var item = t.saveMyTemplate('用例模板', 'three', null);
      assert(item && item.id, '保存模板应返回带 id 的记录');
      assertEq(item.name, '用例模板', '模板名应被保留');
      assertEq(item.base, 'three', '模板基底应记录为 three');
      assertEq(t.listMyTemplates().length, 1, '应保存 1 个自定义模板');
      assertEq(qa(doc, '#template-select option[value="' + item.id + '"]').length, 1,
        '模板下拉里应出现该自定义模板');

      assertEq(t.deleteMyTemplate(item.id), true, '删除模板应成功');
      assertEq(t.listMyTemplates().length, 0, '删除后应无自定义模板');
      assert(!doc.querySelector('#template-select option[value="' + item.id + '"]'),
        '删除后下拉里不应再有该模板');
    });

    test('layout/偏好记忆：保存后可回灌 / 重置清空', async function () {
      var t = app();
      t.resetPrefs();
      assertEq(t.loadPrefs(), false, '重置后应无记忆可载入');

      // 注意：控制面板上挂着 change → savePrefs，派发事件会「顺手」把当前状态立刻写回记忆。
      // 因此这里改界面时一律只改 value、不派发事件，才能模拟出「下次打开、记忆还是旧的那份」。
      var sel = q(doc, '#template-select');
      var title = q(doc, '#input-title');
      sel.value = 'three';
      title.value = '记忆标题';
      t.savePrefs();

      sel.value = 'window';
      title.value = '';
      assertEq(t.loadPrefs(), true, '应能载入上次记忆');
      assertEq(sel.value, 'three', '应恢复上次使用的模板');
      assertEq(title.value, '记忆标题', '应恢复上次的文案');

      t.resetPrefs();
      assertEq(title.value, '', '重置后文案应清空');
      assertEq(sel.value, 'window', '重置后模板应回落内置橱窗模板');
      assertEq(t.loadPrefs(), false, '重置后不应再能载入记忆');
    });

    test('layout/文案库：保存 / 插入 / 删除', async function () {
      var t = app();
      t.listSnippets().slice().forEach(function (s) { t.deleteSnippet(s.id); });
      assertEq(t.listSnippets().length, 0, '前置：文案库应为空');

      assertEq(t.saveSnippet('summary', '   '), false, '空白内容不应存入文案库');
      assertEq(t.saveSnippet('summary', '库里存的顶部文案'), true, '保存片段应成功');
      var list = t.listSnippets();
      assertEq(list.length, 1, '应保存 1 条片段');
      assertEq(list[0].field, 'summary', '片段应记录目标字段');

      setValue(q(doc, '#input-summary'), '', L);
      assertEq(t.insertSnippet(list[0].id), true, '插入片段应成功');
      assertEq(q(doc, '#input-summary').value, '库里存的顶部文案', '插入后输入框应写入片段内容');
      assertEq(text(q(doc, '#preview-summary')), '库里存的顶部文案', '插入后预览应同步');
      assertEq(t.insertSnippet('不存在的片段'), false, '插入不存在的片段应返回失败');

      assertEq(t.deleteSnippet(list[0].id), true, '删除片段应成功');
      assertEq(t.listSnippets().length, 0, '删除后文案库应为空');
    });

    test('layout/批量出图：未勾选给提示，勾选后打包出图并恢复界面', async function () {
      var t = app();
      var btn = q(doc, '#batch-btn');
      var tip = q(doc, '#batch-tip');
      if (!t.listDrafts().length) { t.saveDraft('批量用例草稿'); }
      var cbs = qa(doc, '#batch-list input[type="checkbox"]');
      assert(cbs.length >= 1, '批量清单应列出至少 1 个任务（草稿或文案片段）');

      // 未勾选：必须有即时提示，且不能进入批量流程
      btn.click();
      assertEq(text(tip), '请先勾选要出图的任务', '未勾选点批量出图应给出提示');
      assert(!btn.disabled, '未勾选时不应进入批量流程（按钮不应被禁用）');

      var before = saverCalls.layout.length;
      cbs[0].checked = true;
      btn.click();
      assert(btn.disabled, '批量过程中按钮应禁用，避免重入');
      await until(function () {
        return /批量出图完成|批量出图失败|已取消/.test(text(tip));
      }, 90000, '批量出图收尾（当前：' + text(tip) + '）');
      assert(/批量出图完成/.test(text(tip)), '批量出图应成功，实际：' + text(tip));
      assert(!btn.disabled, '批量结束后按钮应恢复可用');
      if (hasSaverRef(L) && saverCalls.layout.length > before) {
        // 安卓壳会把打包好的 ZIP 交给原生桥；回解 base64 校验它确实是 ZIP（PK 开头）
        var zipCall = saverCalls.layout.slice(before).filter(function (c) {
          return c.mime === 'application/zip';
        })[0];
        if (zipCall) {
          assertMatch(zipCall.name, /^批量排版图_\d{8}_\d{4}\.zip$/, '批量 ZIP 文件名');
          assertEq(atob(zipCall.base64).charCodeAt(0), 0x50, '批量 ZIP 落盘内容应以 PK 开头');
        }
      }
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
      await until(function () { return /已导入|无新机器码|读取失败/.test(text(btn)); }, FILE_WAIT_MS, '导入反馈');
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
      await until(function () { return text(rbtn) !== '恢复备份'; }, FILE_WAIT_MS, '格式错误反馈');
      assertEq(text(rbtn), '文件格式不对', '非本工具备份应提示格式不对');
      closeLayers(doc);

      var backup = JSON.stringify({
        format: 'lmt-ledger-backup', version: 1, savedAt: '2026-10-14T00:00:00.000Z',
        ledger: 'WXYZ-0123-4567-89AB,王五', revoke: 'H7S0-6M3M-GMA1-Y7T2-VNRM'
      });
      attachFile(C, restoreInput, 'ok.json', 'application/json', new TextEncoder().encode(backup));
      await until(function () { return /已恢复|已合并/.test(text(rbtn)); }, FILE_WAIT_MS, '恢复反馈');
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

      if (!hasSaverRef(C)) {
        // PWA 外壳：源码里没有 AndroidSaver，导出台账走 <a download> 回退（等回退反馈出现再判定）。
        await until(function () { return /已导出|请手动复制/.test(text(b)); }, FILE_WAIT_MS, '导出台账回退反馈');
        closeLayers(doc);
        skip('PWA 外壳没有 AndroidSaver 桥（@shell:android-save / export 在 PWA 里不存在），'
          + '导出台账走 <a download> 回退；安卓壳对应路径由「安卓副本」那次运行覆盖');
      }

      // 安卓外壳：源码里有 AndroidSaver，导出台账就必须真的走到桥（没走到即悄悄回退，判失败）。
      await until(function () { return calls.length > before; }, FILE_WAIT_MS,
        '安卓壳导出台账必须调用原生桥（页面源码含 AndroidSaver，却未落盘）');

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

      if (!hasSaverRef(C)) {
        // PWA 外壳：@shell:template 只存在于安卓壳，PWA 侧必须是干净的回退（等回退反馈出现再判定）。
        await until(function () { return /已下载|请手动复制/.test(text(b)); }, FILE_WAIT_MS, '下载模板回退反馈');
        closeLayers(doc);
        skip('PWA 外壳没有模板原生落盘（@shell:template 只存在于安卓壳），模板走 <a download> 回退；'
          + '安卓壳对应路径由「安卓副本」那次运行覆盖');
      }

      // 安卓外壳：@shell:template 存在，下载模板就必须真的走到桥（没走到即悄悄回退，判失败）。
      await until(function () { return calls.length > before; }, FILE_WAIT_MS,
        '安卓壳下载模板必须调用原生桥（页面源码含 AndroidSaver，却未落盘）');

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
      // 吊销名单以本机为准，不与远端取并集：否则把某项从吊销框删掉再上传会被远端旧记录并回来，
      // 用户永远解除不了吊销（撤销只能靠重新生成整份清单）。
      assertEq(merged.revoked.length, 0, '合并吊销名单应只保留本机吊销框内容，不得把远端旧记录并回来');
      assertEq(merged.sig, t.manifestSignature(merged.updated, merged.cards, merged.revoked), '合并后必须重新签名');

      // 本机吊销框有内容时应原样保留（归一化去重 + 恢复分组写法）。
      var merged2 = t.mergeWithRemote(
        { updated: '2026-10-14', cards: [], revoked: ['h7s0 6m3m-gma1-y7t2-vnrm', 'H7S0-6M3M-GMA1-Y7T2-VNRM'] },
        { cards: [], revoked: ['STVW-XYZ0-1234-5678-89AB'] });
      assertEq(merged2.revoked.length, 1, '本机吊销项应归一化去重后保留');
      assertEq(merged2.revoked[0], 'H7S0-6M3M-GMA1-Y7T2-VNRM', '吊销项应恢复为分组写法');
      assertEq(raw.length, 24, '用例自检');
    });

    // ============================================================
    // 新增功能：交付二维码/交付图 / 有效期 / 快照 / 回执 / 差异 / 筛选批量 / 令牌
    // ============================================================
    test('cardgen/二维码：自检零失败 + 编码回读一致 + 承载地址格式', async function () {
      var t = g();
      assert(typeof t.qrSelfTest === 'function', '卡密生成器应导出二维码自检入口');
      var st = t.qrSelfTest();
      assertEq(st.fails.length, 0, '二维码自检不得有失败项：\n' + st.fails.join('\n'));

      ['A', 'HELLO WORLD', '卡密交付：中文内容也要能编码 ✓'].forEach(function (s) {
        var qr = t.qrEncode(s);
        assertEq(qr.modules.length, qr.size, '二维码矩阵应为 size×size');
        assertEq(qr.size, (qr.version * 4 + 17), '尺寸应为 4×版本 + 17');
        var back = t.qrDecode(qr);
        assertEq(back.text, s, '编码 → 回读应还原原文（样本：' + s + '）');
        assertEq(back.mask, qr.mask, '掩码回读应一致');
      });
      // 容量边界：v5 恰好放下 106 字节，107 字节进位到 v6，超出 v10-L 直接拒绝
      assertEq(t.qrPickVersion(106), 5, 'v5 容量边界');
      assertEq(t.qrPickVersion(107), 6, '107 字节应进位到 v6');
      assertEq(t.qrPickVersion(9999), 0, '超长内容应被拒绝');

      // 承载地址：卡密与机器码都必须归一化后再拼进 hash，避免同一份内容出现两种写法
      var url = t.activateUrl('abcd-efgh-jkmn-pqrs', 'ABCD-EFGH-JKMN-PQRS');
      assertEq(url, t.ACTIVATE_BASE + '#c=ABCDEFGHJKMNPQRS&m=ABCDEFGHJKMNPQRS', '激活地址应使用归一化值');
      assertMatch(t.ACTIVATE_BASE, /^https:\/\/yejiawei19991118\.github\.io\/lmt-cards\/activate\.html$/,
        '激活页地址应与仓库里的 docs/activate.html 对应');
    });

    test('cardgen/交付图：条数决定尺寸、二维码真的画在图上、文件名与按钮反馈', async function () {
      var t = g();
      assertEq(t.buildDeliverImage([]), null, '空列表不应出图');
      assertEq(t.buildDeliverImage(null), null, '无参数不应出图');

      var one = t.buildDeliverImage([{ mc: 'ABCD-EFGH-JKMN-PQRS', card: t.makeCard('ABCDEFGHJKMNPQRS'), note: '张三', exp: '' }]);
      assert(one, '单条应出图');
      assertEq(one.width, 720, '交付图宽度固定 720');
      var two = t.buildDeliverImage([
        { mc: 'ABCD-EFGH-JKMN-PQRS', card: 'XXXX-XXXX-XXXX-XXXX-XXXX', note: '张三', exp: '2027-01-01' },
        { mc: 'STVW-XYZ0-1234-5678', card: 'YYYY-YYYY-YYYY-YYYY-YYYY', note: '', exp: '' }
      ]);
      assertEq(two.width, 720, '两条交付图宽度仍是 720');
      assertEq(two.height - one.height, 236, '每多一条，交付图高度应增加一个信息块');
      // 左上角是二维码：必须真的画出深色模块，否则「出图成功」只是画了一张白板
      var px = one.getContext('2d').getImageData(40, 40, 184, 184).data;
      var dark = 0;
      for (var i = 0; i < px.length; i += 4) if (px[i] < 128) dark++;
      assert(dark > 50, '交付图应把二维码画进左上角（深色像素数 ' + dark + '）');
      assertMatch(t.deliverImageName(), /^lmt-deliver-\d{8}-\d{6}\.png$/, '交付图文件名应带时间戳');

      // 目标选择：没有勾选就按当前筛选结果出图
      g().setLedger('ABCD-EFGH-JKMN-PQRS,张三');
      t.setFilterText('');
      q(doc, '#gen-btn').click();
      assertEq(t.deliverImageTargets().length, 1, '未勾选时应按当前筛选结果出图');
      t.setFilterText('ETJX');
      assertEq(t.deliverImageTargets().length, 0, '筛选不命中时不应有出图目标');
      t.setFilterText('');
      t.render();

      // 按钮：点击后必须立刻给出可见反馈（安卓壳写相册 / PWA 走下载）
      var btn = q(doc, '#deliver-img-btn');
      btn.click();
      assertMatch(text(btn), /^(已保存到相册|已导出|已存前 20 条|已导出前 20 条)$/,
        '交付图按钮点击后应有反馈，实际：' + text(btn));
    });

    test('cardgen/有效期：解析规范化 / 加月夹紧月末 / 过期判定', async function () {
      var t = g();
      assertEq(t.parseExpiry('2026-3-7'), '2026-03-07', '应补零规范化');
      assertEq(t.parseExpiry('2026/03/07'), '2026-03-07', '斜杠写法应识别');
      assertEq(t.parseExpiry('20260307'), '2026-03-07', '紧凑写法应识别');
      assertEq(t.parseExpiry('2026-13-07'), '', '非法月份应返回空串');
      assertEq(t.parseExpiry('随便写点什么'), '', '无法识别应返回空串');
      assertEq(t.parseExpiry(''), '', '空值应返回空串');

      assertEq(t.addMonths('2026-01-31', 1), '2026-02-28', '1/31 加一月应夹紧到 2 月末（2026 非闰年）');
      assertEq(t.addMonths('2026-01-31', 12), '2027-01-31', '加 12 月应保持原日');
      assertEq(t.addMonths('2026-03-15', 1), '2026-04-15', '普通加月应保持日');

      assertEq(t.isExpired('2000-01-01'), true, '过去的日期应判为已过期');
      assertEq(t.isExpired('2099-01-01'), false, '未来的日期不应判为过期');
      assertEq(t.isExpired(''), false, '空有效期应视为长期有效');
      assertEq(t.isExpired(null), false, '未设置有效期应视为长期有效');
    });

    test('cardgen/台账快照：空台账跳过 / 保存后可一键恢复', async function () {
      var t = g();
      try { C.localStorage.removeItem(t.SNAPSHOT_KEY); } catch (e) { /* 清不掉就让后续断言自己暴露问题 */ }
      g().setLedger('');
      t.saveSnapshot();
      assertEq(t.loadSnapshots().items.length, 0, '空台账不应生成快照');

      g().setLedger('ABCD-EFGH-JKMN-PQRS,张三\nSTVW-XYZ0-1234-5678,李四');
      q(doc, '#gen-btn').click();
      t.saveSnapshot();
      var items = t.loadSnapshots().items;
      assertEq(items.length, 1, '应保存 1 份快照（同日重复保存只留最新一份）');
      assert(/ABCD-EFGH-JKMN-PQRS/.test(items[0].csv), '快照应保存台账内容');
      assertMatch(items[0].at, /^\d{4}-\d{2}-\d{2}T/, '快照应带 ISO 时间戳');

      g().setLedger('');
      var back = t.restoreLatestSnapshot();
      assert(back && back.added === 2, '从快照恢复应补回 2 个机器码，实际 ' + JSON.stringify(back));
      assert(/ABCD-EFGH-JKMN-PQRS/.test(q(doc, '#mc-list').value), '恢复后台账应包含快照里的机器码');
      assertEq(qa(doc, '#out .item').length, 2, '恢复后结果列表应重排为 2 条');
    });

    test('cardgen/上传回执与待重传：内容一致即不待传，台账变更后置为待传', async function () {
      var t = g();
      g().setLedger('ABCD-EFGH-JKMN-PQRS,张三');
      setValue(q(doc, '#revoke-list'), '', C, 'input');
      q(doc, '#gen-btn').click();

      t.setUploadReceipt({ at: '2026-10-14T00:00:00.000Z', json: JSON.stringify(t.buildManifestObj()) });
      assertEq(t.isPendingUpload(), false, '回执与当前清单一致时不应处于待重传');
      g().setLedger('ABCD-EFGH-JKMN-PQRS,张三\nSTVW-XYZ0-1234-5678,李四');
      assertEq(t.isPendingUpload(), true, '台账新增后应判定为待重传');
      t.setUploadReceipt(null);
      assertEq(t.isPendingUpload(), false, '没有回执时不应判定为待重传');
      assertEq(t.getUploadReceipt(), null, '清除回执后应读回空值');
    });

    test('cardgen/令牌：合法性与指纹脱敏', async function () {
      var t = g();
      assertEq(t.isTokenUsable('ghp_abcdefgh'), true, 'ghp_ 前缀且长度足够应判定合法');
      assertEq(t.isTokenUsable('github_pat_11ABCDEFG'), true, 'github_pat_ 前缀应判定合法');
      assertEq(t.isTokenUsable('随便一串字符'), false, '无合法前缀应判定不合法');
      assertEq(t.isTokenUsable('ghp_x'), false, '过短应判定不合法');
      assertEq(t.isTokenUsable(''), false, '空令牌应判定不合法');

      assertEq(t.tokenFingerprint('ghp_1234567890abcdef'), 'ghp_…cdef', '指纹只应暴露首 4 位与末 4 位');
      assertEq(t.tokenFingerprint(''), '', '空令牌指纹应为空串');
      assertEq(t.tokenFingerprint('abcd').indexOf('abcd'), -1, '短令牌也不应原样展示');
    });

    test('cardgen/清单差异报告：本地未上传 / 线上多出 / 吊销与白名单冲突', async function () {
      var t = g();
      g().setLedger('ABCD-EFGH-JKMN-PQRS,张三\nSTVW-XYZ0-1234-5678,李四');
      setValue(q(doc, '#revoke-list'), '', C, 'input');
      q(doc, '#gen-btn').click();
      var local = t.buildManifestObj();
      assertEq(local.cards.length, 2, '前置：本地清单应有 2 张卡密');

      // 线上只登记了第一张：第二张属于「本地有、线上无」
      var remote = { updated: '2026-10-14', sig: new Array(65).join('a'), cards: [local.cards[0]], revoked: [] };
      var rep = t.buildDiffReport(local, remote);
      assertEq(rep.notUploaded.length, 1, '应报告 1 条未上传');
      assertEq(rep.extraOnline.length, 0, '线上不应多出条目');
      assertEq(rep.consistent, false, '存在差异时 consistent 应为 false');
      assertEq(rep.remoteCards, 1, '应统计线上白名单条数');

      // 本机吊销了仍在线上白名单里的卡密：必须报告冲突
      setValue(q(doc, '#revoke-list'), local.cards[0], C, 'input');
      var rep2 = t.buildDiffReport(local, remote);
      assertEq(rep2.revokedButWhitelisted, 1, '已吊销但线上仍在白名单应计入冲突');

      // 完全一致：不做任何提示
      setValue(q(doc, '#revoke-list'), '', C, 'input');
      var rep3 = t.buildDiffReport(local, {
        updated: '2026-10-14', sig: new Array(65).join('a'), cards: local.cards.slice(), revoked: []
      });
      assertEq(rep3.consistent, true, '完全一致时 consistent 应为 true');
    });

    test('cardgen/筛选与批量：筛选命中、勾选收集、批量吊销', async function () {
      var t = g();
      g().setLedger('ABCD-EFGH-JKMN-PQRS,张三\nSTVW-XYZ0-1234-5678,李四');
      setValue(q(doc, '#revoke-list'), '', C, 'input');
      q(doc, '#gen-btn').click();
      var all = t.getPairs();
      assertEq(all.length, 2, '前置：应有 2 条结果');

      t.setFilterText('张三');
      assertEq(t.filterEntries(all).length, 1, '按备注筛选应命中 1 条');
      t.setFilterText('STVW');
      assertEq(t.filterEntries(all).length, 1, '按机器码筛选应命中 1 条');
      t.setFilterText('不存在的关键词');
      assertEq(t.filterEntries(all).length, 0, '筛选不到时应返回空');
      t.setFilterText('');
      assertEq(t.filterEntries(all).length, 2, '清空筛选应返回全部');

      var cbs = qa(doc, '#out input.lmt-check');
      assertEq(cbs.length, 2, '每条结果都应带勾选框（供批量操作）');
      cbs[0].checked = true;
      var checked = t.checkedCards();
      assertEq(checked.length, 1, 'checkedCards 应只返回被勾选的卡密');
      assertEq(t.revokeCards(checked), 1, '批量吊销应新增 1 条');
      assertEq(t.revokeCards(checked), 0, '重复吊销不应重复添加');
      assertEq(t.normalize(q(doc, '#revoke-list').value), t.normalize(checked[0]),
        '吊销框应写入被勾选的卡密（归一化后一致）');

      // 收尾：清掉吊销框与筛选，避免影响后续用例
      setValue(q(doc, '#revoke-list'), '', C, 'input');
      t.setFilterText('');
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
