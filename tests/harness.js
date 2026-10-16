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
  // 在确认弹层里按文案找按钮：choices 模式下「取消」与选项同为按钮，只能靠文字区分。
  function dialogButton(doc, re) {
    var btns = qa(doc, '.lmt-modal-mask .lmt-btn-row button');
    for (var i = 0; i < btns.length; i++) if (re.test(text(btns[i]))) return btns[i];
    return null;
  }

  // 关掉所有自动弹层，避免影响后续用例。
  // 只处理「当前真的显示着」的弹层：像 #import-confirm 这类静态写在 HTML 里的模板弹层，
  // 平时就是 display:none，若这里顺手把它摘掉，后续用例再也找不到确认框（会被误判成「点了没反应」）。
  function closeLayers(doc) {
    qa(doc, '.manual-copy-mask, .img-preview-mask').forEach(function (mask) {
      if (!isRendered(mask)) return;
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
  // 新制式（ver 2）的跨应用契约：卡密与清单一律由「卡密生成器」（作者侧）用私钥签发，
  // 主程序只内置公钥验签。测试里用一把固定的测试私钥（RFC8032 标准测试向量 seed），
  // 走真实的「生成器签 → 客户端验」链路，而不是在测试里硬编码卡密或摘要。
  // ================================================================
  var TEST_PRIV = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
  // 第二把私钥（同为 RFC8032 标准测试向量 seed）：只用于「换钥匙签出来的清单必须被拒绝」的负向对照
  var TEST_PRIV2 = '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb';
  function blobUrl(win, obj) {
    return win.URL.createObjectURL(new win.Blob([JSON.stringify(obj)], { type: 'application/json' }));
  }
  // 用卡密生成器的私钥签发一份 ver 2 清单。
  //   cardsIn   [{card, mc, note, exp}]
  //   revokedIn [卡密]（分组写法或归一化写法均可，内部统一归一化）
  function signManifest(C, updated, cardsIn, revokedIn) {
    var gen = C.__cardGen;
    var cardsMap = {}, i;
    for (i = 0; i < cardsIn.length; i++) {
      var n = gen.normalize(cardsIn[i].card);
      cardsMap[n] = {
        card: n,
        mc: gen.normalize(cardsIn[i].mc),
        note: cardsIn[i].note || '',
        exp: cardsIn[i].exp || ''
      };
    }
    var revokedMap = {};
    for (i = 0; i < (revokedIn || []).length; i++) {
      var r = gen.normalize(revokedIn[i]);
      if (r) revokedMap[r] = true;
    }
    var rev = gen.sha256Hex(gen.manifestRevSource(gen.MANIFEST_VER, updated, cardsMap, revokedMap)).substr(0, 16);
    var canonical = gen.canonicalManifestString(gen.MANIFEST_VER, updated, rev, cardsMap, revokedMap);
    return {
      ver: gen.MANIFEST_VER,
      updated: updated,
      rev: rev,
      cards: cardsIn.map(function (x) { return { card: x.card, mc: x.mc, note: x.note || '', exp: x.exp || '' }; }),
      revoked: (revokedIn || []).slice(),
      sig2: gen.signCanonical(canonical)
    };
  }
  // 在 layout 应用里建立「已验签清单」：把测试私钥装进 cardgen、派生公钥装进 layout，
  // 再按本机机器码签发一张卡密并签出清单，通过 blob URL 拉取（等价于一次成功的联网同步，
  // 同时写入离线凭证缓存）。返回本机机器码 / 卡密 / 生成器实例，供后续断言复用。
  async function prepareLicense(L, C, opts) {
    opts = opts || {};
    var lic = L.__license, gen = C.__cardGen;
    gen.setPrivateKey(TEST_PRIV);
    var pub = gen.pubKeyBase32();
    assert(pub, '测试私钥应能派生出公钥');
    lic.setPubKey(pub);
    var mc = lic.machineCode();
    var card = gen.makeCard(mc); // 一卡一机：卡密与机器码的绑定写在已签名的清单条目里
    var updated = gen.localIso(new Date());
    var obj = signManifest(C, updated,
      [{ card: card, mc: mc, note: opts.note || '测试用户', exp: opts.exp || '' }],
      opts.revoked || []);
    var url = blobUrl(L, obj);
    lic.setManifestUrl(url);
    await lic.fetchManifest(url);
    L.URL.revokeObjectURL(url);
    return { lic: lic, gen: gen, mc: mc, card: card, updated: updated, pub: pub, manifest: obj };
  }

  // ================================================================
  // lmt-layout（图文排版生成器）
  // ================================================================
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
      // 新制式下主程序不再自己算卡密：机器码对应的卡密由「卡密生成器」按机器码生成，
      // 这里只做一次格式一致性自检（生成器产出的卡密必须能被主程序认作合法格式）。
      assertEq(L.__license.cardFormatOk(C.__cardGen.makeCard(mc.value)), true,
        '生成器按本机机器码生成的卡密应通过主程序的格式校验');
    });

    test('layout/授权门：错误卡密给出提示，正确卡密解锁主界面', async function () {
      var msg = q(doc, '#license-msg');
      var act = q(doc, '#license-activate');
      var input = q(doc, '#license-input');

      // 前置：装好测试公钥 + 按本机机器码签发的清单（等于「生成器签发、用户联网同步成功」这一步）
      var setup = await prepareLicense(L, C, { exp: '2099-12-31' });
      assert(setup.manifest.sig2, '前置：清单应带有 sig2 签名');

      input.value = 'XXXXXXXX-XXXX-XXXX-XXXX-XXXX';
      act.click();
      assertEq(text(msg), '正在校验…', '点击激活应立刻给出「正在校验…」反馈');
      await until(function () { return text(msg) && text(msg) !== '正在校验…'; }, 3000, '激活结果');
      assert(/不在有效清单|不正确|不匹配/.test(text(msg)), '错误卡密应提示不被接受，实际：' + text(msg));
      assert(L.document.body.classList.contains('locked'), '错误卡密不应解锁');

      input.value = setup.card;
      act.click();
      await until(function () { return L.__layoutTool; }, 3000, 'bootApp 启动');
      assert(!L.document.body.classList.contains('locked'), '正确卡密应解锁主界面');
      assertEq(L.getComputedStyle(q(doc, '#license-gate')).display, 'none', '解锁后授权门应隐藏');
      assertEq(L.__license.getPubKey(), setup.pub, '主程序内置公钥应等于生成器私钥派生的公钥');
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
      // 签名一律由卡密生成器（作者侧私钥）产出：两端规范化串与 Ed25519 算法必须逐字一致，主程序才可能验过
      var setup = await prepareLicense(L, C, { exp: '2099-12-31' });
      var card = setup.card, mc = setup.mc;

      // 1) 签名对不上的清单必须被整份拒绝。
      //    先清空当前清单：fetchManifest 失败时按设计「保留原清单」，不清空就无法观察「整份被拒」。
      lic.setManifestUrl('');
      await lic.fetchManifest('');
      assertEq(lic.getManifest(), null, '前置：应已清空为纯离线');

      var bad = signManifest(C, setup.updated, [{ card: card, mc: mc, note: '测试用户', exp: '2099-12-31' }], []);
      bad.sig2 = 'A'.repeat(bad.sig2.length); // 破坏签名（长度合法但内容不对）
      var badUrl = blobUrl(L, bad);
      lic.setManifestUrl(badUrl);
      await lic.fetchManifest(badUrl);
      L.URL.revokeObjectURL(badUrl);
      assertEq(lic.getManifest(), null, '签名错误的清单不得被采纳（不得回退成「无验签」直接放行）');

      // 2) 生成器签出的合法清单，且卡密在白名单：通过
      var goodUrl = blobUrl(L, setup.manifest);
      await lic.fetchManifest(goodUrl);
      L.URL.revokeObjectURL(goodUrl);
      var m = lic.getManifest();
      assert(m && m.verified === true, '生成器签出的清单应能通过主程序验签（两端算法必须完全一致）');
      assert(m.cards[lic.normalize(card)], '白名单应包含该卡密（按归一化卡密索引）');
      assertEq(m.cards[lic.normalize(card)].mc, lic.normalize(mc), '清单条目应带上机器码，用于一卡一机校验');
      var d = lic.onlineDecision(card);
      assertEq(d.ok, true, '白名单内且机器码匹配的卡密应通过在线判定');
      assertEq(d.decided, true, '应记录为已判定');

      // 3) 同一卡密进入吊销名单：拒绝（吊销优先于白名单）
      var revUrl = blobUrl(L, signManifest(C, setup.updated, [{ card: card, mc: mc, note: '测试用户', exp: '2099-12-31' }], [card]));
      lic.setManifestUrl(revUrl);
      await lic.fetchManifest(revUrl);
      L.URL.revokeObjectURL(revUrl);
      var d2 = lic.onlineDecision(card);
      assertEq(d2.ok, false, '已吊销的卡密应被拒绝');
      assert(/吊销/.test(d2.msg), '应提示已吊销，实际：' + d2.msg);

      // 收尾：恢复成「本机可激活」的合法清单，避免影响后续用例
      await prepareLicense(L, C, { exp: '2099-12-31' });
    });

    test('layout/在线清单：有效期真的生效（过期拒绝激活、离线也拦）', async function () {
      var lic = L.__license;
      var gen = C.__cardGen;
      // 用本机真实机器码对应的卡密：这样 activate() 才能同时通过白名单与一卡一机的本地校验
      var mc = lic.machineCode();
      gen.setPrivateKey(TEST_PRIV);
      lic.setPubKey(gen.pubKeyBase32());
      var card = gen.makeCard(mc);
      var updated = gen.localIso(new Date());

      // 1) 清单条目带名称 / 机器码 / 有效期；未过期 → 通过验签并通过判定
      var obj1 = signManifest(C, updated, [{ card: card, mc: mc, note: '张三', exp: '2099-12-31' }], []);
      var u1 = blobUrl(L, obj1);
      lic.setManifestUrl(u1);
      await lic.fetchManifest(u1);
      L.URL.revokeObjectURL(u1);
      var m1 = lic.getManifest();
      assert(m1 && m1.verified === true, '带名称/有效期的清单条目仍应能通过验签（有效期也参与签名，属规范化串的一部分）');
      assertEq(m1.cards[lic.normalize(card)].exp, '2099-12-31', '清单条目里的有效期应被主程序解析出来');
      assertEq(lic.onlineDecision(card).ok, true, '未过期的卡密应通过在线判定');

      // 2) 有效期已过 → 拒绝激活，且提示必须写明有效期
      var u2 = blobUrl(L, signManifest(C, updated, [{ card: card, mc: mc, note: '张三', exp: '2000-01-01' }], []));
      lic.setManifestUrl(u2);
      await lic.fetchManifest(u2);
      L.URL.revokeObjectURL(u2);
      var d2 = lic.onlineDecision(card);
      assertEq(d2.ok, false, '已过期的卡密应被拒绝');
      assert(/有效期/.test(d2.msg) && /2000-01-01/.test(d2.msg), '过期提示应写明有效期，实际：' + d2.msg);
      assertEq(lic.activate(card).ok, false, 'activate 也必须拒绝已过期的卡密');

      // 3) 有效期写进激活记录：清空当前清单（模拟断网）后仍保持激活
      var u3 = blobUrl(L, obj1);
      lic.setManifestUrl(u3);
      await lic.fetchManifest(u3);
      L.URL.revokeObjectURL(u3);
      var act = lic.activate(card);
      assertEq(act.ok, true, '未过期的卡密应能激活');
      assertEq(act.exp, '2099-12-31', '激活结果应回带有效期（界面据此提示到期时间）');
      assertEq(lic.isActivated(), true, '前置：激活记录应生效');
      // 模拟「断网后重启应用」：内存里的清单清空，只靠离线凭证（本地缓存清单）恢复
      assertEq(lic.credFresh(), true, '刚刚成功取得过清单，离线凭证应当是新鲜的');
      lic.setManifestUrl('');
      await lic.fetchManifest('');
      assertEq(lic.getManifest(), null, '前置：应回到纯离线（内存中的清单已清空）');
      lic.boot();
      assertEq(lic.getManifest() && lic.getManifest().verified, true, '离线重启应从离线凭证载入已验签清单');
      assertEq(lic.isActivated(), true, '离线且离线凭证未过期时仍应保持激活');

      // 4) 改成「已过期」的记录：离线也应立刻失效，不能靠断网绕过有效期
      var rec = JSON.parse(L.localStorage.getItem('lmt_license'));
      rec.exp = '2000-01-01';
      L.localStorage.setItem('lmt_license', JSON.stringify(rec));
      assertEq(lic.isActivated(), false, '记录里的有效期已过，离线也必须判定为未激活');

      // 收尾：恢复「本机已激活」的合法状态，后续用例依赖已启动的主程序
      var back = await prepareLicense(L, C, { exp: '2099-12-31' });
      assertEq(lic.activate(back.card).ok, true, '收尾：应能重新激活，恢复后续用例所需状态');
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
      // 「批量出图」以草稿为最小单元（常用文案库只用于给草稿套用指定字段），清单渲染在 #batch-tasks 里
      var cbs = await until(function () {
        var list = qa(doc, '#batch-tasks input[type="checkbox"]');
        return list.length ? list : null;
      }, 3000, '批量清单渲染（草稿是批量的最小单元）');

      // 未勾选：必须有即时提示，且不能进入批量流程
      btn.click();
      assertEq(text(tip), '请先勾选要出图的草稿', '未勾选点批量出图应给出提示');
      assert(!btn.disabled, '未勾选时不应进入批量流程（按钮不应被禁用）');

      var before = saverCalls.layout.length;
      cbs[0].checked = true;
      fire(cbs[0], 'change', L); // 触发 updateBatchCount：按钮文案应带上「将生成 N 张」
      assertMatch(text(btn), /将生成 1 张/, '勾选后按钮应实时显示预计生成张数');
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

    test('layout/导出固定 4× 高清 + 字号锁定（P-17 / P-33）', async function () {
      var t = app();
      // 画质档位组件已按需求移除：导出固定 4×（1500 × 2668），界面不再暴露尺寸选择
      assertEq(doc.querySelector('#export-size'), null, '「导出尺寸」选择框应已删除（导出固定 4×）');
      assertEq(qa(doc, '.panel-footer-row > select').length, 0, '底栏不应再有任何尺寸选择控件');
      assertEq(t.currentExportScale(), 4, '导出倍率应恒为 4（1500 × 2668）');

      // P-17：文案长到「原字号放不下、缩小才放得下」时必须明示当前缩放比例。
      // 该中间状态对应的文案长度取决于运行时排版，因此按长度递增去命中它
      // （先出现缩放提示，继续加长才会越到「缩到下限仍溢出、禁用导出」）。
      var tpl = q(doc, '#template-select');
      tpl.value = 'window';
      fire(tpl, 'change', L);
      var title = q(doc, '#input-title');
      var note = q(doc, '#fit-note');
      var btn = q(doc, '#export-btn');
      var hit = false;
      for (var n = 10; n <= 600 && !hit; n += 10) {
        setValue(title, new Array(n + 1).join('缩放测试'), L);
        await sleep(45);
        if (hasClass(note, 'show')) {
          hit = true;
          assertMatch(text(note), /^已自动适配安全区：当前按 \d+% 缩放。$/, '应明示当前缩放百分比，实际：' + text(note));
        } else if (btn.disabled) {
          break; // 已越到「缩到下限仍溢出」，说明中间态没被覆盖到
        }
      }
      assert(hit, '应存在「缩小字号后才放得下」的中间状态，此时必须提示缩放比例');

      // 自动适配字号：关闭后不再自动缩放（--fit 恒为 1），缩放提示也不再出现
      var lock = q(doc, '#fit-lock');
      lock.checked = false;
      fire(lock, 'change', L);
      await until(function () {
        return q(doc, '#export-target').style.getPropertyValue('--fit') === '1';
      }, 4000, '关闭自动适配后 --fit 应恒为 1（不再自动缩放）');
      assert(!hasClass(note, 'show'), '关闭自动适配时不应再提示自动缩放');

      lock.checked = true;
      fire(lock, 'change', L);
      setValue(title, '', L);
      await until(function () { return !hasClass(note, 'show'); }, 4000, '清空文案后缩放提示应消失');
    });

    test('layout/机器码：格式稳定，且由本机安装 ID 派生', async function () {
      var lic = L.__license;
      var mc = lic.machineCode();
      assertMatch(mc, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/, '机器码应为 4 组 16 位（XXXX-XXXX-XXXX-XXXX）');
      assertEq(lic.machineCode(), mc, '同一环境重复计算应稳定复现（不得随调用漂移）');

      // 桌面 / iOS/PWA 环境没有原生稳定标识，机器码由本地安装 ID 派生：
      // 换掉安装 ID，机器码必须跟着变（证明它确实参与派生，而不是被别的字段掩盖）。
      var KEY = 'lmt_install_id';
      var saved = L.localStorage.getItem(KEY);
      try {
        L.localStorage.setItem(KEY, 'harness-swapped-install-id');
        assert(lic.machineCode() !== mc, '更换本地安装 ID 后机器码必须变化');
      } finally {
        if (saved == null) L.localStorage.removeItem(KEY); else L.localStorage.setItem(KEY, saved);
      }
      assertEq(lic.machineCode(), mc, '恢复安装 ID 后机器码应回到原值');
    });

    test('layout/文案片段字段随模板过滤（P-36）', async function () {
      var t = app();
      var sel = q(doc, '#snippet-field-select');
      function opts() {
        return qa(sel, 'option').map(function (o) { return o.value; });
      }
      t.refreshSnippetFieldOptions('window');
      assertDeepEq(opts(), ['summary', 'title', 'keywords', 'subtitle'], '橱窗模板应只列出它用得到的字段');
      t.refreshSnippetFieldOptions('three');
      assertDeepEq(opts(), ['title', 'cap1', 'cap2', 'cap3'], '三图竖排应只列出它用得到的字段');

      // 与界面联动：切模板时字段下拉必须跟着刷新
      var tpl = q(doc, '#template-select');
      tpl.value = 'three';
      fire(tpl, 'change', L);
      assertDeepEq(opts(), ['title', 'cap1', 'cap2', 'cap3'], '切到三图竖排后字段下拉应被刷新');

      // 选中项在新模板里仍存在 → 保留；不存在 → 回落到第一个可用项
      sel.value = 'cap2';
      t.refreshSnippetFieldOptions('three');
      assertEq(sel.value, 'cap2', '仍存在的选中字段应被保留');
      sel.value = 'summary';
      t.refreshSnippetFieldOptions('three');
      assertEq(sel.value, 'title', '新模板里不存在的字段应回落到第一个可用项');

      tpl.value = 'window';
      fire(tpl, 'change', L);
      assertDeepEq(opts(), ['summary', 'title', 'keywords', 'subtitle'], '切回橱窗后字段下拉应恢复');
    });

    test('layout/删除片段：二次确认 + 可撤销（P-28）', async function () {
      var t = app();
      t.listSnippets().slice().forEach(function (s) { t.deleteSnippet(s.id); });
      assertEq(t.saveSnippet('summary', '待删除的片段'), true, '前置：应能存入一条片段');
      var item = t.listSnippets()[0];

      var sel = q(doc, '#snippet-select');
      sel.value = item.id;
      assertEq(sel.value, item.id, '前置：下拉框应能选中该片段');

      var del = q(doc, '#snippet-delete-btn');
      del.click();
      var mask = await until(function () { return doc.querySelector('.lmt-modal-mask'); },
        3000, '删除片段应弹出二次确认');
      assertEq(mask.getAttribute('role'), 'dialog', '确认弹层应声明 role=dialog');
      assertEq(mask.getAttribute('aria-modal'), 'true', '确认弹层应声明 aria-modal');
      assertMatch(text(mask), /确定删除片段/, '确认弹层应说明删除对象');

      // 取消：不得删除
      dialogButton(doc, /^取消$/).click();
      await until(function () { return !doc.querySelector('.lmt-modal-mask'); }, 3000, '取消后弹层应关闭');
      assertEq(t.listSnippets().length, 1, '取消后片段必须还在');

      // 确认：删除 + 底部弹出可撤销提示条
      sel.value = item.id;
      del.click();
      await until(function () { return doc.querySelector('.lmt-modal-mask'); }, 3000, '再次弹出确认');
      dialogButton(doc, /^删除$/).click();
      await until(function () { return !doc.querySelector('.lmt-modal-mask'); }, 3000, '确认后弹层应关闭');
      assertEq(t.listSnippets().length, 0, '确认后片段应被删除');
      assertEq(text(q(doc, '.lmt-undo-btn')), '撤销', '删除后应给出可撤销提示条');

      // 撤销：片段原样恢复，提示条消失
      q(doc, '.lmt-undo-btn').click();
      await until(function () { return t.listSnippets().length === 1; }, 3000, '撤销后片段应恢复');
      assertEq(t.listSnippets()[0].text, '待删除的片段', '撤销应恢复原片段内容');
      await until(function () { return !doc.querySelector('.lmt-undo-toast'); }, 3000, '撤销后提示条应消失');
      assertMatch(text(q(doc, '#tool-msg')), /已撤销删除/, '撤销应有反馈');
    });

    test('layout/分层重置：仅样式 / 草稿与偏好 / 全部（P-29）', async function () {
      var t = app();
      t.resetPrefs('all');
      t.listDrafts().slice().forEach(function (d) { t.deleteDraft(d.id); });
      t.listSnippets().slice().forEach(function (s) { t.deleteSnippet(s.id); });

      setValue(q(doc, '#input-title'), '受保护的标题', L);
      assert(t.saveDraft('分层重置草稿').ok, '前置：应存入 1 份草稿');
      assertEq(t.saveSnippet('summary', '受保护的片段'), true, '前置：应存入 1 条片段');
      q(doc, '#fit-lock').checked = false; // 关闭自动适配（= 原先的「锁定字号」）
      fire(q(doc, '#fit-lock'), 'change', L);

      var reset = q(doc, '#prefs-reset-btn');
      var msg = q(doc, '#tool-msg');

      // 取消：什么都不该发生
      reset.click();
      await until(function () { return doc.querySelector('.lmt-modal-mask'); }, 3000, '重置应弹出范围选择');
      // 几何回归（图一）：范围三选一的文案较长（仅重置样式 / 重置草稿与偏好），
      // 在 375 宽的手机壳里等分后必然换行，按钮高度必须随文字自适应——
      // 文字不得纵向或横向撑出按钮边框（溢出时 scrollHeight/scrollWidth 会大于可视区）。
      qa(doc, '.lmt-modal-card .lmt-btn-row > button').forEach(function (b) {
        assert(b.scrollHeight <= b.clientHeight + 1,
          '弹层按钮文字不得纵向撑出边框（' + text(b) + '）：scrollHeight=' + b.scrollHeight + ' clientHeight=' + b.clientHeight);
        assert(b.scrollWidth <= b.clientWidth + 1,
          '弹层按钮文字不得横向撑出边框（' + text(b) + '）：scrollWidth=' + b.scrollWidth + ' clientWidth=' + b.clientWidth);
      });
      dialogButton(doc, /^取消$/).click();
      await until(function () { return !doc.querySelector('.lmt-modal-mask'); }, 3000, '取消后应关闭弹层');
      assertEq(t.listDrafts().length, 1, '取消重置不应动草稿');

      // 1) 仅重置样式：样式（含自动适配字号）恢复默认（开启），草稿 / 片段 / 内容全部保留
      reset.click();
      await until(function () { return doc.querySelector('.lmt-modal-mask'); }, 3000, '重置应弹出范围选择');
      dialogButton(doc, /^仅重置样式$/).click();
      await until(function () { return /已重置样式/.test(text(msg)); }, 3000, '应有「已重置样式」反馈');
      assertEq(q(doc, '#fit-lock').checked, true, '仅重置样式应恢复默认（自动适配字号开启）');
      assertEq(t.listDrafts().length, 1, '仅重置样式不得动草稿');
      assertEq(t.listSnippets().length, 1, '仅重置样式不得动片段');
      assertEq(q(doc, '#input-title').value, '受保护的标题', '仅重置样式不得动当前内容');

      // 2) 重置草稿与偏好：清草稿 / 模板 / 片段 / 记忆，当前内容与图片保持
      reset.click();
      await until(function () { return doc.querySelector('.lmt-modal-mask'); }, 3000, '重置应弹出范围选择');
      dialogButton(doc, /^重置草稿与偏好$/).click();
      await until(function () { return /已重置草稿与偏好/.test(text(msg)); }, 3000, '应有反馈');
      assertEq(t.listDrafts().length, 0, '应清空草稿箱');
      assertEq(t.listSnippets().length, 0, '应清空文案片段');
      assertEq(q(doc, '#input-title').value, '受保护的标题', '重置草稿与偏好不得动当前内容');

      // 3) 重置全部：内容 / 模板 / 安全区一并回到默认（导出倍率恒为 4×，无档位可重置）
      setValue(q(doc, '#input-title'), '再来一次', L);
      reset.click();
      await until(function () { return doc.querySelector('.lmt-modal-mask'); }, 3000, '重置应弹出范围选择');
      dialogButton(doc, /^重置全部$/).click();
      await until(function () { return /已重置全部/.test(text(msg)); }, 3000, '应有反馈');
      assertEq(q(doc, '#input-title').value, '', '重置全部应清空当前内容');
      assertEq(q(doc, '#template-select').value, 'window', '重置全部应回落橱窗模板');
      assertEq(q(doc, '#toggle-safe').checked, true, '重置全部应恢复安全区辅助线勾选');
      assertEq(t.currentExportScale(), 4, '导出倍率恒为 4×（画质档位已移除，不受重置影响）');
    });

    test('layout/自动化承接：样式重置并入「重置偏好」、片段选中即写入指定字段（O-L10 / O-L11）', async function () {
      var t = app();
      // 两个手动入口已按 O-L10 / O-L11 删除，不得再出现在 DOM 里。
      assertEq(doc.querySelector('#style-reset-btn'), null,
        '「重置样式」按钮应已删除（改由「重置偏好」的「仅重置样式」承接）');
      assertEq(doc.querySelector('#snippet-insert-btn'), null,
        '「插入片段」按钮应已删除（改为「先选目标字段 → 再选片段」即自动写入）');

      t.listSnippets().slice().forEach(function (s) { t.deleteSnippet(s.id); });
      assertEq(t.saveSnippet('cap1', '片段内容甲'), true, '前置：应能存入一条片段');

      // 次序：先选目标字段（cap1 属三图竖排专属，先把模板切过去），再选片段 → 选中即写入。
      var tpl = q(doc, '#template-select');
      tpl.value = 'three';
      fire(tpl, 'change', L);
      var fieldSel = q(doc, '#snippet-field-select');
      fieldSel.value = 'cap1';
      setValue(q(doc, '#input-cap-1'), '', L);

      var sel = q(doc, '#snippet-select');
      sel.value = t.listSnippets()[0].id;
      fire(sel, 'change', L);
      assertEq(q(doc, '#input-cap-1').value, '片段内容甲',
        '选中片段后应自动写入 #snippet-field-select 指定的字段（不再需要手动点「插入」）');
      assertEq(text(q(doc, '#preview-cap-1')), '片段内容甲', '自动写入后预览应同步');
      assertMatch(text(q(doc, '#tool-msg')), /已写入/, '自动写入应有回执，实际：' + text(q(doc, '#tool-msg')));

      // 收尾：切回橱窗模板并清空该字段，避免影响后续用例
      tpl.value = 'window';
      fire(tpl, 'change', L);
      setValue(q(doc, '#input-cap-1'), '', L);
    });

    test('layout/外壳：安卓壳读原生设备 ID，PWA 侧刻意不含该引用', async function () {
      var src = String(L.document.documentElement.outerHTML);
      var hasBridge = src.indexOf('LmtDevice') >= 0;
      assertEq(hasBridge, hasSaverRef(L),
        '安卓壳专属引用的存在性应一致（LmtDevice 与 AndroidSaver 同属 @shell 分叉），实际 LmtDevice=' + hasBridge);
      if (hasBridge) {
        assert(/LmtDevice[\s\S]{0,200}androidId/.test(src), '安卓壳应通过原生桥的 androidId() 取稳定设备 ID');
        skip('安卓壳源码已接上 window.LmtDevice.androidId()（真机上取 ANDROID_ID，重装/清数据不变）；'
          + '但该桥只有真机 WebView 才注入，无头桌面 Chromium 里不存在，机器码回落本地安装 ID，'
          + '原生取值需在真机上人工验证');
      }
      skip('PWA/iOS 没有稳定的原生设备标识，机器码按设计由本地安装 ID 派生（见「机器码」用例）；'
        + '安卓壳的原生分支由「安卓副本」那次运行覆盖');
    });
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

    // 用例环境对齐：把「客户端内置公钥」对齐到测试私钥派生的公钥，等价于真实部署里
    // 「作者私钥 ↔ 客户端内置公钥一致」；与主程序侧 lic.setPubKey(pub) 的做法对称。
    // 不对齐的话，新增的「派生公钥必须与客户端内置公钥一致」自检门槛（CG-07-6）会让所有
    // manifestSelfCheck(...).ok === true 的用例全部失败；那条负向路径由专门用例临时改值后覆盖。
    g().setPrivateKey(TEST_PRIV);
    var alignedPub = g().pubKeyBase32();
    assert(alignedPub, '测试私钥应能派生出公钥');
    g().setExpectedPubkey(alignedPub);

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
      // 只认「当前真正可见」的那一层：#import-confirm 是静态写在 HTML 里的 .manual-copy-mask 模板
      // （平时 display:none），且它是文档里第一个匹配项，直接 querySelector 会命中它而误判成「未锁滚动」。
      var mask = qa(doc, '.manual-copy-mask').filter(isRendered)[0];
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
      // 「复制台账表」「导出含卡密台账」已按 §5.9 删除（与导出台账同数据），此处只验留下的出口
      var exp = q(doc, '#export-btn');
      exp.click();
      assertEq(text(exp), '台账为空', '空台账点「导出台账」应提示台账为空');
      var del = q(doc, '#deliver-btn');
      del.click();
      assertEq(text(del), '无结果', '空台账点「复制交付文案」应提示无结果');
      var imgBtn = q(doc, '#deliver-img-btn');
      imgBtn.click();
      assertEq(text(imgBtn), '无结果', '空台账点「导出交付图」应提示无结果，实际：' + text(imgBtn));
    });

    test('cardgen/导入台账文件：导入前必须二次确认（合并 / 覆盖）', async function () {
      g().setLedger('');
      var csv = '\uFEFF机器码,卡密,备注,有效期\r\nABCD-EFGH-JKMN-PQRS,XXXX-XXXX-XXXX-XXXX-XXXX,张三,2027-12-31\r\nSTVW-XYZ0-1234-5678,,李四,\r\n';
      var input = q(doc, '#import-file');
      attachFile(C, input, 'ledger.csv', 'text/csv', new TextEncoder().encode(csv));

      // 阶段 2 起导入不再直接写台账：先弹确认层（默认「合并」），避免误覆盖现有台账
      var mask = await until(function () {
        var el = doc.getElementById('import-confirm');
        return (el && el.style.display !== 'none') ? el : null;
      }, FILE_WAIT_MS, '导入确认弹层');
      assertEq(mask.getAttribute('role'), 'dialog', '导入确认层应声明 role=dialog');
      var desc = q(doc, '#import-confirm-desc');
      assert(/新增 2 条/.test(text(desc)), '确认层应说明新增条数，实际：' + text(desc));
      assert(q(doc, '#import-mode-merge').checked, '默认应选中「合并」（更安全，不误删现有台账）');

      q(doc, '#import-confirm-ok').click();
      var report = await until(function () {
        var r = doc.getElementById('import-report');
        return /导入完成/.test(text(r)) ? r : null;
      }, FILE_WAIT_MS, '导入报告');
      assert(/合并/.test(text(report)), '按默认的合并模式导入，实际：' + text(report));
      assert(/ABCD-EFGH-JKMN-PQRS/.test(q(doc, '#mc-list').value), '台账应写入机器码');
      assertEq(input.value, '', '导入后应清空 input，允许重复导入同一文件');
      assertEq(qa(doc, '#out .item').length, 2, '导入后应重排结果列表');
    });

    test('cardgen/导入台账文件（含卡密列的 CSV 也能识别，BOM 与卡密列均被丢弃）', async function () {
      g().setLedger('');
      // 导出的「含卡密台账」是四列 CSV：再导入时必须按机器码识别、自动丢弃卡密列
      var csv = '\uFEFF机器码,卡密,备注,有效期\r\nWXYZ-0123-4567-89AB,YYYY-YYYY-YYYY-YYYY-YYYY,王五,2027-12-31\r\n';
      var input = q(doc, '#import-file');
      attachFile(C, input, 'deliver.csv', 'text/csv', new TextEncoder().encode(csv));
      await until(function () {
        var el = doc.getElementById('import-confirm');
        return (el && el.style.display !== 'none') ? el : null;
      }, FILE_WAIT_MS, '导入确认弹层');
      q(doc, '#import-confirm-ok').click();
      await until(function () { return /导入完成/.test(text(doc.getElementById('import-report'))); }, FILE_WAIT_MS, '导入报告');
      var line = q(doc, '#mc-list').value;
      assert(/WXYZ-0123-4567-89AB/.test(line), '台账应写入机器码');
      assert(!/YYYY-YYYY/.test(line), '含卡密台账导入时卡密列应被丢弃（卡密由生成器按机器码重算）');
      assert(/王五/.test(line), '备注应保留');
      assert(/2027-12-31/.test(line), '有效期应保留');
    });

    test('cardgen/一机一卡：卡密绑定必须能重新读回，同一机器码不得重新发卡（FR-11）', async function () {
      var t = g();
      t.setLedger('ABCD-EFGH-JKMN-PQRS,张三');
      var c1 = t.makeCard('ABCDEFGHJKMNPQRS');
      assertMatch(c1, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/, '卡密应为 5 组 20 位 base32');

      // 落盘契约：{ 归一化机器码: 分组卡密 }；键是机器码、值是卡密，两者格式不同
      var raw = JSON.parse(C.localStorage.getItem(t.CARD_MAP_KEY));
      assertEq(t.normalize(raw.ABCDEFGHJKMNPQRS), t.normalize(c1), '绑定应按「机器码 → 卡密」落盘');

      // 回归守：旧实现把 16 位机器码当卡密校验（要求 20 位），导致落盘的绑定永远读不回来，
      // 换设备 / 重载后同一机器码会被当成新机器码重新发卡。这里清掉内存缓存强制从 localStorage 重读。
      t.resetCardMapCache();
      assertEq(t.loadCardMap().ABCDEFGHJKMNPQRS, c1,
        '落盘的绑定必须能重新读回（读不回来就会让同一机器码反复发卡，清单里出现「一码两卡」）');
      assertEq(t.makeCard('ABCDEFGHJKMNPQRS'), c1, '重载后同一机器码必须复用同一张卡密，不得重新生成');
      assertEq(t.makeCard('abcd efgh j/kmn-pqrs'), c1, '卡密复用应与机器码写法无关（先归一化）');

      // 生成侧避让：不同机器码不得拿到同一张卡密（一卡多用）
      var c2 = t.makeCard('STVWXYZ012345678');
      assert(t.normalize(c2) !== t.normalize(c1), '不同机器码必须拿到不同的卡密');
      assertEq(t.loadCardMap().STVWXYZ012345678, c2, '第二台机器的绑定同样应可读回');
    });

    test('cardgen/在线清单 JSON：ver 2 结构、sig2 自校验、复制', async function () {
      g().setPrivateKey(TEST_PRIV); // 新制式必须录入私钥才能签出 sig2
      g().setLedger('ABCD-EFGH-JKMN-PQRS,张三');
      setValue(q(doc, '#revoke-list'), 'H7S0-6M3M-GMA1-Y7T2-VNRM', C, 'input');
      var copyBtn = q(doc, '#copy-manifest');
      await clickCopyAndAssertFeedback(copyBtn, '复制清单 JSON');
      closeLayers(doc);

      var out = q(doc, '#manifest-out');
      var obj = JSON.parse(out.value);
      assertEq(obj.ver, 2, '清单应为契约 ver 2');
      assertMatch(obj.updated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/, 'updated 应为含时区的 ISO8601（P-32）');
      assertMatch(obj.rev, /^[0-9a-f]{16}$/, 'rev 应为 sha256 前 16 位 hex');
      assertEq(obj.cards.length, 1, '白名单应有 1 张卡密');
      assertEq(obj.cards[0].card, g().makeCard('ABCDEFGHJKMNPQRS'), '白名单应是台账对应的卡密');
      assertEq(obj.cards[0].mc, 'ABCD-EFGH-JKMN-PQRS', '白名单条目应带分组机器码，便于按机器码排查');
      assertEq(obj.cards[0].note, '张三', '白名单条目应带名称（备注），清单里能看到是谁');
      assertEq(obj.revoked.length, 1, '吊销名单应有 1 张卡密');
      assertEq(obj.revoked[0], 'H7S0-6M3M-GMA1-Y7T2-VNRM', '吊销名单应保留分组写法');
      // sig2 = base32(64 字节 ed25519 签名) → 103 个字符；且必须能被私钥派生的公钥验过
      assertMatch(obj.sig2, /^[0-9A-Z]{103}$/, 'sig2 应为 103 字符 base32（64 字节 Ed25519 签名）');
      var normCards = {}, revMap = {};
      obj.cards.forEach(function (c) {
        var n = g().normalize(c.card);
        normCards[n] = { card: n, mc: g().normalize(c.mc), note: c.note || '', exp: c.exp || '' };
      });
      obj.revoked.forEach(function (c) { var n = g().normalize(c); if (n) revMap[n] = true; });
      var canonical = g().canonicalManifestString(obj.ver, obj.updated, obj.rev, normCards, revMap);
      assertEq(g().verifyCanonical(canonical, obj.sig2), true, 'sig2 必须能被私钥派生的公钥验过（否则主程序无法验签）');
      // 发布前自检（#publish-check）必须通过，界面上的结论与清单一致
      var chk = g().manifestSelfCheck(obj);
      assertEq(chk.ok, true, '发布前自检应通过，实际：' + chk.msg);
      assertEq(text(q(doc, '#publish-check')), chk.msg, '界面自检文案应与自检结果一致');
      assert(hasClass(q(doc, '#publish-check'), 'is-ok'), '自检通过时结论样式应为 is-ok');
    });

    test('cardgen/令牌保存与清除，以及上传前置提示', async function () {
      g().setPrivateKey(TEST_PRIV); // 自检是发布的前置门槛，先让私钥可用，才能测到「缺令牌」这一步
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

      // v2 起「上传到 GitHub」按钮已删除，唯一手动发布入口是「一键发布」（#publish-btn）
      var up = q(doc, '#publish-btn');
      up.click();
      assertEq(text(up), '需先填令牌', '未保存令牌点发布应提示');
      assert(text(q(doc, '#upload-tip')).length > 0, '上传提示区应给出说明');
    });

    test('cardgen/清空台账', async function () {
      g().setLedger('ABCD-EFGH-JKMN-PQRS,张三');
      q(doc, '#gen-btn').click();
      assert(qa(doc, '#out .item').length === 1, '清空前应有 1 条结果');
      // 清空是整页唯一不可撤销的破坏性操作：必须先弹二次确认（B7），
      // 因此「点一下 #clear-btn 就清空」的旧契约已作废，这里改为实测「取消不清 / 确认才清」。
      function confirmBtn(mask, re) {
        var btns = qa(mask, 'button');
        for (var i = 0; i < btns.length; i++) if (re.test(text(btns[i]))) return btns[i];
        return null;
      }
      // HTML 里还静态写着一个 .manual-copy-mask（#import-confirm 模板，平时 display:none），
      // 它是文档里第一个匹配项，所以只能取「当前真正可见」的那层（自绘弹层追加在 body 末尾）。
      function visibleMask() {
        var all = qa(doc, '.manual-copy-mask').filter(isRendered);
        assert(all.length === 1, '应恰好有 1 个可见模态层，实际 ' + all.length);
        return all[0];
      }
      q(doc, '#clear-btn').click();
      var mask = visibleMask();
      assertEq(mask.getAttribute('role'), 'dialog', '清空确认弹层应声明 role=dialog');
      assertEq(mask.getAttribute('aria-modal'), 'true', '清空确认弹层应是模态');
      assert(hasClass(doc.body, 'modal-open'), '确认弹层打开时应锁定背景滚动');
      var okBtn = confirmBtn(mask, /^确认清空$/);
      var cancelBtn = confirmBtn(mask, /^取消$/);
      assert(okBtn, '清空确认弹层应有「确认清空」按钮');
      assert(cancelBtn, '清空确认弹层应有「取消」按钮');
      assert(hasClass(okBtn, 'btn-danger-solid'), '清空确认按钮应是危险实心样式（btn-danger-solid）');
      cancelBtn.click();
      assertEq(q(doc, '#mc-list').value, 'ABCD-EFGH-JKMN-PQRS,张三', '点「取消」不应清空台账');
      assert(!qa(doc, '.manual-copy-mask').some(isRendered), '取消后确认弹层应关闭');
      assert(!hasClass(doc.body, 'modal-open'), '关闭弹层后应解除背景滚动锁定');
      q(doc, '#clear-btn').click();
      confirmBtn(visibleMask(), /^确认清空$/).click();
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
      assert(/^\uFEFF机器码,备注,有效期/.test(csv), '原生落盘内容应是带 BOM 与三列表头的台账 CSV，实际开头：' + JSON.stringify(csv.slice(0, 20)));
      assert(/ABCD-EFGH-JKMN-PQRS/.test(csv), '原生落盘内容应包含台账里的机器码');
      assertEq(text(b), '已保存', '安卓壳应提示「已保存」，实际：' + text(b));
    });

    // v2 §5.9：`#template-btn`（下载模板）已删除——格式说明与示例行直接写在台账折叠块里，
    // 该入口找不到独有场景，故不保留任何用例（删除即不再有可测行为）。

    test('cardgen/线上清单自动同步：失败给原因 + 内置自动重试（「重新同步」已删除，CG-07-2）', async function () {
      g().setPrivateKey(TEST_PRIV);
      var tip = q(doc, '#online-tip');
      // 手动「重新同步」按钮已按 CG-07-2 删除：同步失败不再给手动入口，改由内置退避重试承接。
      assertEq(doc.querySelector('#refresh-btn'), null, '「重新同步」按钮应已删除（改由内置自动重试承接）');

      // 无头环境断网（--host-resolver-rules），同步必然失败。自动触发点（online / visibilitychange /
      // 登录成功）在无头 harness 里无法模拟，这里直接调用同一个入口函数，覆盖的仍是同一条链路。
      await g().syncOnlineManifest();
      // 断言「失败必须看得见」：状态条给出原因 + 重试进度（CG-07-2）
      assert(/无法同步线上清单/.test(text(tip)), '同步失败必须给出原因，实际：' + text(tip));
      assert(/本机数据不受影响/.test(text(tip)), '失败提示应说明本机数据不受影响，实际：' + text(tip));
      assert(/正在自动重试（第 1 次）/.test(text(tip)), '失败后应立刻给出自动重试进度，实际：' + text(tip));

      // 退避重试链自终止：3 次（3s / 9s / 27s）耗尽后收口为「稍后回到前台将自动再试」，
      // 而不是暴露一枚已经不存在的按钮。
      await until(function () { return /稍后回到前台将自动再试/.test(text(tip)); }, 40000,
        '自动重试耗尽后应给出「稍后回到前台将自动再试」（当前：' + text(tip) + '）');
      assert(/已自动重试 3 次仍未成功/.test(text(tip)), '耗尽后应说明已自动重试的次数，实际：' + text(tip));
      assert(!/正在自动重试/.test(text(tip)), '重试链耗尽后不应再显示「正在自动重试」');
      assertEq(doc.querySelector('#refresh-btn'), null, '重试链耗尽后仍不该出现任何手动重试入口');

      // 收尾：等最后一枚退避计时器（第 4 次试探）也跑完，避免它跑进后续用例里触发 render()。
      await sleep(30000);
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
      // 导出台账是「机器码,备注,有效期」三列：与导入无损回环（含卡密的四列导出已按 §5.9 删除）
      assert(/^机器码,备注,有效期/.test(t.buildLedgerCsv().replace(/^\uFEFF/, '')), '台账 CSV 应带三列表头');

      assertMatch(t.makeCard('abcd efgh j/kmn-pqrs-1234'), /^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/, '卡密应为 5 组 20 位');
      assertEq(t.makeCard('abcd efgh j/kmn-pqrs-1234'), t.makeCard('ABCDEFGHJKMNPQRS1234'), '卡密应与写法无关（先归一化）');

      // 签名链路（新制式）：私钥 → 规范化串 → sig2 → 验签。
      // 走的是与客户端同一条 ed25519Verify 路径，这里通过即代表客户端能验过。
      t.setPrivateKey(TEST_PRIV);
      assertEq(t.privateKeyOk(), true, '录入测试私钥后应可用');
      function cardsMapOf(card, mc) {
        var n = t.normalize(card), m = {};
        m[n] = { card: n, mc: t.normalize(mc), note: '张三', exp: '2027-12-31' };
        return m;
      }
      var cm1 = cardsMapOf('abcd-efgh-jkmn-pqrs-1234', 'ABCD-EFGH-JKMN-PQRS-1234');
      var cm2 = cardsMapOf('ABCDEFGHJKMNPQRS1234', 'ABCDEFGHJKMNPQRS1234');
      var U1 = '2026-10-14T10:00:00+08:00';
      assertEq(t.manifestRevSource(t.MANIFEST_VER, U1, cm1, {}),
        t.manifestRevSource(t.MANIFEST_VER, U1, cm2, {}), '规范化串应与分组写法无关');
      var rev1 = t.sha256Hex(t.manifestRevSource(t.MANIFEST_VER, U1, cm1, {})).substr(0, 16);
      assertMatch(rev1, /^[0-9a-f]{16}$/, 'rev 应为 16 位小写 hex');
      var canon = t.canonicalManifestString(t.MANIFEST_VER, U1, rev1, cm1, {});
      var sig = t.signCanonical(canon);
      assertMatch(sig, /^[0-9A-Z]{103}$/, 'sig2 应为 103 字符 base32（64 字节签名）');
      assertEq(t.verifyCanonical(canon, sig), true, '自己签的 sig2 应能验签通过');
      assertEq(t.verifyCanonical(canon, sig.charAt(0) === 'A' ? 'B' + sig.slice(1) : 'A' + sig.slice(1)), false, '签名被篡改应验签失败');
      assert(t.signCanonical(t.canonicalManifestString(t.MANIFEST_VER, '2026-10-15T10:00:00+08:00', rev1, cm1, {})) !== sig,
        'updated 变化应改变签名');

      assertDeepEq(t.parseManifestTarget(), { owner: 'yejiawei19991118', repo: 'lmt-cards', branch: 'main', path: 'cards.json' }, '应从 MANIFEST_URL 解析出上传目标');
      assertEq(t.base64ToUtf8(t.utf8ToBase64('中文\n换行')), '中文\n换行', 'Base64 往返应保持 UTF-8');
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
      assertEq(merged.ver, t.MANIFEST_VER, '合并后应为 ver 2 契约');
      // 合并结果必须重新签名，且签名能被公钥验过（重建规范化串再验，等价于客户端的验签路径）
      var mm = {}, rmm = {};
      merged.cards.forEach(function (c) { mm[t.normalize(c.card)] = { card: t.normalize(c.card), mc: t.normalize(c.mc), note: String(c.note || '').trim(), exp: String(c.exp || '').trim() }; });
      merged.revoked.forEach(function (r) { rmm[t.normalize(r)] = true; });
      assertMatch(merged.sig2, /^[0-9A-Z]{103}$/, '合并后应重新签出 sig2');
      assertEq(t.verifyCanonical(t.canonicalManifestString(t.MANIFEST_VER, merged.updated, merged.rev, mm, rmm), merged.sig2), true,
        '合并后的 sig2 应能验签通过');

      // 本机吊销框有内容时应原样保留（归一化去重 + 恢复分组写法）。
      var merged2 = t.mergeWithRemote(
        { updated: '2026-10-14', cards: [], revoked: ['h7s0 6m3m-gma1-y7t2-vnrm', 'H7S0-6M3M-GMA1-Y7T2-VNRM'] },
        { cards: [], revoked: ['STVW-XYZ0-1234-5678-89AB'] });
      assertEq(merged2.revoked.length, 1, '本机吊销项应归一化去重后保留');
      assertEq(merged2.revoked[0], 'H7S0-6M3M-GMA1-Y7T2-VNRM', '吊销项应恢复为分组写法');

      // FR-11：合并主键是归一化机器码，不是卡密。同一机器码在两端各有一张卡密时只保留一张，
      // 且按 §3.5 权威顺序保留「线上那张」（远端先入）——否则一机两卡会直接被发布前自检拦下。
      var merged3 = t.mergeWithRemote(
        {
          updated: '2026-10-14',
          cards: [{ card: 'AAAA-AAAA-AAAA-AAAA-AAAA', mc: 'ABCD-EFGH-JKMN-PQRS', note: '本机旧卡', exp: '' }],
          revoked: []
        },
        {
          updated: '2026-10-14',
          cards: [{ card: 'BBBB-BBBB-BBBB-BBBB-BBBB', mc: 'ABCD-EFGH-JKMN-PQRS', note: '线上卡', exp: '2027-01-01' }],
          revoked: []
        });
      assertEq(merged3.cards.length, 1, '同一机器码两端各一张卡密时只能留一张（一机一卡）');
      assertEq(merged3.cards[0].card, 'BBBB-BBBB-BBBB-BBBB-BBBB', '应保留线上那张（已发布的线上绑定优先于本机缓存）');
      // 没有基准（base）时逐字段取「非空优先」：备注本机非空 → 用本机的；有效期本机为空 → 用线上的。
      assertEq(merged3.cards[0].note, '本机旧卡', '无基准时备注取本机非空值');
      assertEq(merged3.cards[0].exp, '2027-01-01', '无基准时有效期本机为空，应沿用线上值');
      var dup3 = t.manifestUniqueness(merged3);
      assertEq(dup3.dupMc + dup3.dupCard, 0, '合并结果必须同时满足一机一卡与一卡一机（否则自检会拦下自己发的清单）');

      // 回归（作者改完有效期却发不出去）：带基准的三方合并必须以「本机相对基准的改动」为准。
      // base = 上次成功同步的线上清单（有效期 2027-01-01），本机把它改成 2028-12-31，
      // 线上仍是旧值 → 线上没动过、本机动过 → 采用本机的 2028-12-31。
      var baseExp = { byMc: { ABCDEFGHJKMNPQRS: 'BBBBBBBBBBBBBBBBBBBB' }, entries: { 'BBBBBBBBBBBBBBBBBBBB': { mc: 'ABCDEFGHJKMNPQRS', note: '线上卡', exp: '2027-01-01' } }, revoked: {} };
      var merged4 = t.mergeWithRemote(
        {
          updated: '2026-10-14',
          cards: [{ card: 'BBBB-BBBB-BBBB-BBBB-BBBB', mc: 'ABCD-EFGH-JKMN-PQRS', note: '线上卡', exp: '2028-12-31' }],
          revoked: []
        },
        {
          updated: '2026-10-15',
          cards: [{ card: 'BBBB-BBBB-BBBB-BBBB-BBBB', mc: 'ABCD-EFGH-JKMN-PQRS', note: '线上卡', exp: '2027-01-01' }],
          revoked: []
        },
        baseExp
      );
      assertEq(merged4.cards.length, 1, '三方合并后仍应只有一条');
      assertEq(merged4.cards[0].exp, '2028-12-31', '本机改过的有效期不得被线上旧值覆盖（1.卡密有效期更改后线上清单没更新）');
      assertEq(merged4.cards[0].note, '线上卡', '两端一致时备注原样保留');
      // 反向：线上动了、本机没动 → 采用线上的新值，本机不得把线上更新挡回去。
      var merged5 = t.mergeWithRemote(
        {
          updated: '2026-10-14',
          cards: [{ card: 'BBBB-BBBB-BBBB-BBBB-BBBB', mc: 'ABCD-EFGH-JKMN-PQRS', note: '线上卡', exp: '2027-01-01' }],
          revoked: []
        },
        {
          updated: '2026-10-15',
          cards: [{ card: 'BBBB-BBBB-BBBB-BBBB-BBBB', mc: 'ABCD-EFGH-JKMN-PQRS', note: '线上卡', exp: '2029-06-30' }],
          revoked: []
        },
        { byMc: { ABCDEFGHJKMNPQRS: 'BBBBBBBBBBBBBBBBBBBB' }, entries: { 'BBBBBBBBBBBBBBBBBBBB': { mc: 'ABCDEFGHJKMNPQRS', note: '线上卡', exp: '2027-01-01' } }, revoked: {} }
      );
      assertEq(merged5.cards[0].exp, '2029-06-30', '本机未改动时应接受线上的新有效期');
    });

    test('cardgen/发布前自检：重复机器码与重复卡密都必须被拦下（FR-08 / FR-11）', async function () {
      var t = g();
      t.setPrivateKey(TEST_PRIV);
      var base = {
        ver: t.MANIFEST_VER,
        updated: '2026-10-14T10:00:00+08:00',
        rev: '0123456789abcdef',
        cards: [
          { card: 'AAAA-AAAA-AAAA-AAAA-AAAA', mc: 'ABCD-EFGH-JKMN-PQRS', note: '张三', exp: '' },
          { card: 'BBBB-BBBB-BBBB-BBBB-BBBB', mc: 'STVW-XYZ0-1234-5678', note: '李四', exp: '' }
        ],
        revoked: [],
        sig2: new Array(104).join('A')
      };
      assertEq(t.manifestUniqueness(base).dupMc, 0, '无重复时 dupMc 应为 0');
      assertEq(t.manifestUniqueness(base).dupCard, 0, '无重复时 dupCard 应为 0');
      assertEq(t.manifestSelfCheck(base).ok, true, '结构完整且无重复时自检应通过');

      // 同一机器码两条卡密（一机两卡）；写法不同（含空格小写）也必须识别为同一台机器
      var dupMc = JSON.parse(JSON.stringify(base));
      dupMc.cards.push({ card: 'CCCC-CCCC-CCCC-CCCC-CCCC', mc: 'abcd efgh jkmn pqrs', note: '', exp: '' });
      assertEq(t.manifestUniqueness(dupMc).dupMc, 1, '同一机器码的重复条目应被计数（先归一化再比）');
      var r1 = t.manifestSelfCheck(dupMc);
      assertEq(r1.ok, false, '存在重复机器码时自检必须失败');
      assert(/违反一机一卡/.test(r1.msg), '自检结论应指明违反一机一卡，实际：' + r1.msg);

      // 同一卡密被两个机器码引用（一卡多用）
      var dupCard = JSON.parse(JSON.stringify(base));
      dupCard.cards.push({ card: 'AAAA-AAAA-AAAA-AAAA-AAAA', mc: 'WXYZ-0123-4567-89AB', note: '', exp: '' });
      assertEq(t.manifestUniqueness(dupCard).dupCard, 1, '同一张卡密被两个机器码引用应被计数');
      var r2 = t.manifestSelfCheck(dupCard);
      assertEq(r2.ok, false, '一卡多用时自检必须失败');
      assert(/违反一卡一机/.test(r2.msg), '自检结论应指明违反一卡一机，实际：' + r2.msg);
    });

    test('cardgen/发布前自检：派生公钥与客户端内置公钥不一致时必须拦下发布（CG-07-6）', async function () {
      var t = g();
      t.setPrivateKey(TEST_PRIV);
      var base = {
        ver: t.MANIFEST_VER,
        updated: '2026-10-14T10:00:00+08:00',
        rev: '0123456789abcdef',
        cards: [{ card: 'AAAA-AAAA-AAAA-AAAA-AAAA', mc: 'ABCD-EFGH-JKMN-PQRS', note: '张三', exp: '' }],
        revoked: [],
        sig2: new Array(104).join('A')
      };
      assertEq(t.manifestSelfCheck(base).ok, true, '前置：内置公钥对齐时自检应通过');

      try {
        // 模拟「换了签名私钥、却忘了把客户端内置公钥一起换」：派生公钥与内置公钥对不上。
        t.setExpectedPubkey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
        var r = t.manifestSelfCheck(base);
        assertEq(r.ok, false, '派生公钥与客户端内置公钥不一致时自检必须失败');
        assert(/公钥/.test(r.msg), '自检结论应指明公钥不一致，实际：' + r.msg);

        // 界面结论与自检同口径，且「一键发布」以它为门槛：不一致必须被拦下，不得推到线上。
        q(doc, '#publish-btn').click();
        assertEq(text(q(doc, '#publish-btn')), '自检未通过', '公钥不一致时「一键发布」必须被自检拦下');
        assert(hasClass(q(doc, '#publish-check'), 'is-bad'), '界面自检结论应为 is-bad');
        assertMatch(text(q(doc, '#publish-check')), /公钥/, '界面自检结论应指明公钥不一致，实际：' + text(q(doc, '#publish-check')));
      } finally {
        t.setExpectedPubkey(alignedPub); // 收尾：恢复对齐，避免污染后续用例
      }

      assertEq(t.manifestSelfCheck(base).ok, true, '恢复内置公钥对齐后自检应重新通过');
    });

    test('cardgen/线上清单同步：条目只进清单不进台账输入框 + 「线上」来源徽标 + 状态徽标（FR-03）', async function () {
      var t = g();
      t.setPrivateKey(TEST_PRIV);
      t.setFilterText('');
      t.setLedger('ABCD-EFGH-JKMN-PQRS,张三');
      q(doc, '#gen-btn').click();
      var onlineCard = t.makeCard('ABCDEFGHJKMNPQRS'); // 线上那张（本机第一次生成时也是它）

      // 模拟本机缓存漂移（换设备 / 本地绑定被改脏）：把本机绑定换成一个明显不同的卡密。
      // 同步必须用线上那张覆盖它，否则后续交付会发出另一张卡（FR-11 第 3 层）。
      C.localStorage.setItem(t.CARD_MAP_KEY, JSON.stringify({ ABCDEFGHJKMNPQRS: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ' }));
      t.resetCardMapCache();
      assert(t.normalize(t.makeCard('ABCDEFGHJKMNPQRS')) !== t.normalize(onlineCard),
        '前置：本机绑定此时确实与线上那张不同');

      // 线上清单：本机那台也在（=已上传），另有两台是本机没有的（应被并入台账）
      var data = signManifest(C, '2026-10-15T10:00:00+08:00', [
        { card: onlineCard, mc: 'ABCD-EFGH-JKMN-PQRS', note: '张三', exp: '' },
        { card: 'STVW-XYZ0-1234-5678-89AB', mc: 'STVW-XYZ0-1234-5678', note: '李四', exp: '2027-01-01' },
        { card: 'WXYZ-0123-4567-89AB-CDEF', mc: 'WXYZ-0123-4567-89AB', note: '王五', exp: '' }
      ], []);
      var remote = t.parseRemoteManifest(data);
      assert(remote, '合法清单应能被解析');
      assertEq(remote.verified, true, '用当前私钥签出的清单验签应通过');

      assertEq(t.applyRemote(remote, '主源'), true, 'applyRemote 应成功并返回 true');
      // 绑定回灌：线上那张必须覆盖本机脏缓存
      assertEq(t.loadCardMap().ABCDEFGHJKMNPQRS, onlineCard,
        '线上绑定应回灌进本机缓存，并覆盖本机旧值（权威顺序：线上 > 本机）');
      assertEq(t.makeCard('ABCDEFGHJKMNPQRS'), onlineCard, '同步后本机对同一机器码应复用线上那张卡密');

      var lines = q(doc, '#mc-list').value;
      // 诉求 2：线上清单的条目不再写进「机器码台账」输入框——输入框永远只保留作者自己录的内容。
      assertEq(lines, 'ABCD-EFGH-JKMN-PQRS,张三',
        '线上新增条目不得写进台账输入框（输入框只保留作者录入的内容）');

      // 但仍要看得见、管得着：有效条目 = 台账 ∪ 线上条目，线上那两条带 online 标记。
      var eff = t.effectiveEntries();
      assertEq(eff.length, 3, '有效条目应为「台账 1 条 + 线上 2 条」，实际：' + eff.length);
      var onlineKeys = eff.filter(function (e) { return e.online; }).map(function (e) { return e.key; }).sort();
      assertEq(onlineKeys.length, 2, '应恰好有 2 条标记为「线上」');
      assertEq(onlineKeys.join(','), 'STVWXYZ012345678,WXYZ0123456789AB', '标记为「线上」的应是台账里没有的那两条');
      var li = null;
      eff.forEach(function (e) { if (e.key === 'STVWXYZ012345678') li = e; });
      assert(li, '线上条目应出现在有效条目里');
      assertEq(li.note, '李四', '线上条目应带上线上备注');
      assertEq(li.exp, '2027-01-01', '线上条目应带上线上有效期');

      // 结果列表：每行一个来源徽标，其中两条为「线上」
      assertEq(qa(doc, '#out .lmt-online-badge').length, 2, '列表里应有 2 行带「线上」来源徽标');
      assertEq(qa(doc, '#out .lmt-online-badge')[0].textContent, '线上', '来源徽标文案应为「线上」');

      var tip = text(q(doc, '#online-tip'));
      assert(/线上新增 2 条/.test(tip), '状态条应报告线上新增条数，实际：' + tip);
      assert(!/已并入/.test(tip), '状态条不应再说「已并入」（线上条目不再写进台账输入框），实际：' + tip);
      assert(/已上传 3/.test(tip), '三条都在线上 → 状态条应显示已上传 3，实际：' + tip);

      // 几何回归（图二）：结论可能很长（更新时间 + 验签来源 + 上传统计 + 差异说明 + 本机同步时间），
      // 胶囊必须按可用宽度整段换行，文字不得横向/纵向撑出圆角边框，也不得越出状态条边界。
      var tipEl = q(doc, '#online-tip');
      assert(tipEl.scrollWidth <= tipEl.clientWidth + 1,
        '长结论胶囊文字不得横向撑出圆角边框：scrollWidth=' + tipEl.scrollWidth + ' clientWidth=' + tipEl.clientWidth);
      assert(tipEl.scrollHeight <= tipEl.clientHeight + 1,
        '长结论胶囊文字不得纵向撑出圆角边框：scrollHeight=' + tipEl.scrollHeight + ' clientHeight=' + tipEl.clientHeight);
      var bar = doc.querySelector('.sync-bar');
      var vb = tipEl.getBoundingClientRect(), bb = bar.getBoundingClientRect();
      assert(vb.left >= bb.left - 0.5 && vb.right <= bb.right + 0.5,
        '结论胶囊不得越出状态条左右边界：chip=[' + vb.left + ',' + vb.right + '] bar=[' + bb.left + ',' + bb.right + ']');

      // 关键：harness 里 cardgen 的 iframe 固定 1024 宽，胶囊文字在那么宽的容器里根本挤不出边框，
      // 上面那几条断言等于空跑（真机是 ~375 宽的手机，缺陷只在这种窄宽下出现）。
      // 因此这里把 iframe 临时压到手机宽度，复现真机条件后再量一次，量完还原。
      var frame = document.getElementById('frame-cardgen');
      var oldW = frame.style.width, oldH = frame.style.height;
      frame.style.width = '375px';
      frame.style.height = '667px';
      await sleep(80);
      try {
        var cs = C.getComputedStyle(tipEl);
        assert(cs.overflowX === 'visible' && cs.overflowY === 'visible',
          '胶囊不得靠 overflow 裁剪掩盖溢出（否则几何断言会假通过）：实际 overflow=' + cs.overflowX + '/' + cs.overflowY);
        assert(tipEl.scrollWidth <= tipEl.clientWidth + 1,
          '手机宽度（375）下长结论胶囊文字不得横向撑出边框：scrollWidth=' + tipEl.scrollWidth + ' clientWidth=' + tipEl.clientWidth);
        assert(tipEl.scrollHeight <= tipEl.clientHeight + 1,
          '手机宽度（375）下长结论胶囊文字不得纵向撑出边框：scrollHeight=' + tipEl.scrollHeight + ' clientHeight=' + tipEl.clientHeight);
        assert(tipEl.getBoundingClientRect().right <= bar.getBoundingClientRect().right + 0.5,
          '手机宽度下结论胶囊不得越出状态条右边界：chip.right=' + tipEl.getBoundingClientRect().right + ' bar.right=' + bar.getBoundingClientRect().right);
        // 真机症状是「整页出现横向滚动条」。这里直接盯住根因：手机宽度下文档不得横向溢出。
        var de = C.document.documentElement;
        assert(de.scrollWidth <= de.clientWidth + 1,
          '手机宽度下整页不得横向溢出（真机上会表现为底部横向滚动条）：scrollWidth=' + de.scrollWidth + ' clientWidth=' + de.clientWidth);
      } finally {
        frame.style.width = oldW;
        frame.style.height = oldH;
        await sleep(80);
      }

      var badges = qa(doc, '#out .status-badge');
      assertEq(badges.length, 3, '同步成功过之后每行都应带在线状态徽标');
      badges.forEach(function (b) {
        assert(hasClass(b, 'is-up'), '三条都已上传，徽标应全部是 is-up，实际：' + b.className);
        assertEq(text(b), '已上传', '徽标文案应为「已上传」');
      });

      // 「撤销」已按 §5.9 删除：线上条目不再改动台账，故不再有需要撤销的写入动作。
      assertEq(doc.querySelector('#undo-btn'), null, '「撤销」入口应已删除（线上条目不再写进台账，无可撤销的动作）');
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

    test('cardgen/交付图：一卡一图（720×360）、二维码真的画在图上、多张打包 ZIP', async function () {
      var t = g();
      assertEq(t.buildDeliverImage(null), null, '无参数不应出图');
      assertEq(t.buildDeliverImage({}), null, '缺卡密不应出图');

      var p1 = { mc: 'ABCD-EFGH-JKMN-PQRS', card: t.makeCard('ABCDEFGHJKMNPQRS'), note: '张三', exp: '' };
      var one = t.buildDeliverImage(p1);
      assert(one, '单条应出图');
      assertEq(one.width, 720, '交付图宽度固定 720');
      assertEq(one.height, 360, '单张交付图高度固定 360（一卡一图，尺寸不随条数变化）');

      var two = t.buildDeliverImage({ mc: 'STVW-XYZ0-1234-5678', card: 'YYYY-YYYY-YYYY-YYYY-YYYY', note: '李四', exp: '2027-01-01' });
      assertEq(two.width, 720, '第二条仍是同一尺寸 720');
      assertEq(two.height, 360, '第二条高度同样是 360，不再把多条挤进一张长图');

      // 左上角是二维码：必须真的画出深色模块，否则「出图成功」只是画了一张白板
      var px = one.getContext('2d').getImageData(40, 40, 184, 184).data;
      var dark = 0;
      for (var i = 0; i < px.length; i += 4) if (px[i] < 128) dark++;
      assert(dark > 50, '交付图应把二维码画进左上角（深色像素数 ' + dark + '）');

      assertMatch(t.deliverImageName(), /^lmt-deliver-\d{8}-\d{6}\.png$/, '单张交付图文件名应带时间戳');
      assertMatch(t.deliverImageName('zip'), /^lmt-deliver-\d{8}-\d{6}\.zip$/, '批量打包文件名应为 .zip');
      assertEq(t.deliverSingleName({ mc: 'ABCD-EFGH-JKMN-PQRS', note: '张三' }),
        'ABCD-EFGH-JKMN-PQRS-张三', '单张文件名应为「机器码-名称」，客户一眼能对上人');
      var used = {};
      assertEq(t.deliverSingleName({ mc: 'ABCD-EFGH-JKMN-PQRS', note: '张三' }, used),
        'ABCD-EFGH-JKMN-PQRS-张三', '首个重名不追加序号');
      assertEq(t.deliverSingleName({ mc: 'ABCD-EFGH-JKMN-PQRS', note: '张三' }, used),
        'ABCD-EFGH-JKMN-PQRS-张三(2)', '重名应自动加序号，避免 ZIP 内互相覆盖');

      // 多张 → 一个 ZIP（零第三方依赖的 store 模式打包）
      var zip = await t.buildDeliverZip([p1, { mc: 'STVW-XYZ0-1234-5678', card: 'YYYY-YYYY-YYYY-YYYY-YYYY', note: '李四', exp: '2027-01-01' }]);
      assert(zip && zip.count === 2, '两条应打包成含 2 个文件的 ZIP，实际 ' + JSON.stringify(zip && zip.count));
      assert(zip.bytes instanceof C.Uint8Array, 'ZIP 内容应为 Uint8Array');
      assertEq(zip.bytes[0] | (zip.bytes[1] << 8) | (zip.bytes[2] << 16) | (zip.bytes[3] << 24),
        0x04034b50, 'ZIP 应以本地文件头签名 0x04034b50 开头');
      // 文件名以 UTF-8 写进 ZIP（含中文名称，各平台解压都不乱码）
      var want = new C.TextEncoder().encode('ABCD-EFGH-JKMN-PQRS-张三.png');
      var hit = false;
      for (var j = 0; j + want.length <= zip.bytes.length && !hit; j++) {
        var same = true;
        for (var k = 0; k < want.length; k++) if (zip.bytes[j + k] !== want[k]) { same = false; break; }
        if (same) hit = true;
      }
      assert(hit, 'ZIP 内应包含「机器码-名称.png」文件名');

      // 目标选择：没有勾选就按当前筛选结果出图
      g().setLedger('ABCD-EFGH-JKMN-PQRS,张三');
      t.setFilterText('');
      q(doc, '#gen-btn').click();
      assertEq(t.deliverImageTargets().length, 1, '未勾选时应按当前筛选结果出图');
      t.setFilterText('ETJX');
      assertEq(t.deliverImageTargets().length, 0, '筛选不命中时不应有出图目标');
      t.setFilterText('');
      t.render();

      // 按钮：1 条直出 PNG；多条打包 ZIP。两条路径都必须立刻给出可见反馈。
      var btn = q(doc, '#deliver-img-btn');
      btn.click();
      assertMatch(text(btn), /^(已保存到相册|已导出)$/, '单条交付图点击后应有反馈，实际：' + text(btn));

      g().setLedger('ABCD-EFGH-JKMN-PQRS,张三\nSTVW-XYZ0-1234-5678,李四');
      q(doc, '#gen-btn').click();
      btn.click();
      assertMatch(text(btn), /^打包 \d+ 张…$/, '多条交付图应先提示打包进度，实际：' + text(btn));
      await until(function () { return /^(已存 \d+ 张 ZIP|已导出 \d+ 张 ZIP|出图失败)$/.test(text(btn)); }, FILE_WAIT_MS, '打包完成');
      assertMatch(text(btn), /^(已存 2 张 ZIP|已导出 2 张 ZIP)$/, '两条应打包成 ZIP 并给出反馈，实际：' + text(btn));
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

      // 台账第三列的有效期：必须真的写进清单条目（清单里能看到到期时间），并且可被筛选命中
      g().setLedger('ABCD-EFGH-JKMN-PQRS,张三,2027-12-31');
      setValue(q(doc, '#revoke-list'), '', C, 'input');
      q(doc, '#gen-btn').click();
      var obj = t.buildManifestObj();
      assertEq(obj.cards[0].exp, '2027-12-31', '台账第三列的有效期应写进清单条目，供主程序强制校验');
      assertEq(obj.cards[0].note, '张三', '清单条目应同时带上名称');
      t.setFilterText('2027-12-31');
      assertEq(t.filterEntries(t.getPairs()).length, 1, '筛选应能按有效期命中');
      t.setFilterText('张三');
      assertEq(t.filterEntries(t.getPairs()).length, 1, '筛选应能按名称命中');
      t.setFilterText('');
      t.render();
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

      // P-24：快照列表化 + 时间点选取。直接注入一份「昨天」的快照，再存今天这份，
      // 列表应两行、默认选中最新，点选旧时间点后「恢复」也必须以该时间点为准。
      var yCsv = '\uFEFF机器码,备注,有效期\r\nWXYZ-1234-5678-90AB,老王,';
      C.localStorage.setItem(t.SNAPSHOT_KEY, JSON.stringify({
        v: 1, items: [{ at: '2026-10-14T09:00:00.000Z', csv: yCsv }]
      }));
      g().setLedger('ABCD-EFGH-JKMN-PQRS,张三\nSTVW-XYZ0-1234-5678,李四');
      q(doc, '#gen-btn').click();
      t.saveSnapshot();
      var rows = qa(doc, '#snapshot-list .lmt-snapshot-item');
      assertEq(rows.length, 2, '两个时间点的快照应各占一行');
      assertMatch(text(rows[0]), /（1 条）/, '旧快照应显示自身条数');
      assertMatch(text(rows[1]), /（2 条）/, '新快照应显示自身条数');
      assert(hasClass(rows[1], 'is-selected'), '默认应选中最新一份');

      // 点选旧时间点：高亮转移，且 selectedSnapshot 返回该时间点的内容
      var radio0 = q(doc, '#snapshot-list .lmt-snapshot-item input[type="radio"]');
      radio0.checked = true;
      fire(radio0, 'change', C);
      assert(hasClass(qa(doc, '#snapshot-list .lmt-snapshot-item')[0], 'is-selected'), '点选后旧时间点应高亮');
      assert(/WXYZ-1234-5678-90AB/.test(t.selectedSnapshot().csv), 'selectedSnapshot 应返回被选中的时间点内容');

      // 恢复以「选中的时间点」为准：清空台账后应只补回旧快照里的那 1 条
      g().setLedger('');
      var back2 = t.restoreLatestSnapshot();
      assert(back2 && back2.added === 1, '恢复应以选中的时间点为准（1 条），实际 ' + JSON.stringify(back2));
      assert(/WXYZ-1234-5678-90AB/.test(q(doc, '#mc-list').value), '恢复后台账应来自被选中的旧快照');
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
      setValue(q(doc, '#revoke-list'), local.cards[0].card, C, 'input');
      var rep2 = t.buildDiffReport(local, remote);
      assertEq(rep2.revokedButWhitelisted, 1, '已吊销但线上仍在白名单应计入冲突');

      // 完全一致：不做任何提示
      setValue(q(doc, '#revoke-list'), '', C, 'input');
      var rep3 = t.buildDiffReport(local, {
        updated: '2026-10-14', sig: new Array(65).join('a'), cards: local.cards.slice(), revoked: []
      });
      assertEq(rep3.consistent, true, '完全一致时 consistent 应为 true');

      // 线上多出的条目必须能看出「是谁」：带名称与机器码，而不是只给一串卡密无从排查
      var rep4 = t.buildDiffReport(local, {
        updated: '2026-10-14', sig: new Array(65).join('a'),
        cards: local.cards.concat([{ card: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ', mc: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', note: '老王' }]),
        revoked: []
      });
      assertEq(rep4.extraOnline.length, 1, '线上多出的条目应被报告');
      assertEq(rep4.extraOnline[0].note, '老王', '线上多出条目应带名称，便于排查是哪位用户');
      assertMatch(rep4.extraOnline[0].mc, /^ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ$/, '线上多出条目应带分组机器码');
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

      // 统一作用域（名字要对得上行为）：批量动作一律「已勾选优先，否则当前筛选结果」。
      // 旧实现里「吊销目标卡密 / 复制目标话术」只看筛选、「续期」更是无条件作用整份台账，
      // 同一个界面状态下四个按钮各筛一套，正是「筛选名实不符」的根因。
      setValue(q(doc, '#revoke-list'), '', C, 'input');
      t.setFilterText('');
      t.render();
      assertEq(t.currentTargets().length, 2, '未勾选、无筛选时目标应为全部台账');
      t.setFilterText('张三');
      t.render();
      assertEq(t.currentTargets().length, 1, '未勾选时应按筛选结果取目标');

      // 勾第二行 + 筛选命中第一行：有勾选时忽略筛选，目标必须是勾选的那一条
      t.setFilterText('');
      t.render();
      var cbs2 = qa(doc, '#out input.lmt-check');
      cbs2[1].checked = true;
      t.setFilterText('张三'); // 只改筛选文本，不重排 DOM，勾选状态得以保留
      var targets = t.currentTargets();
      assertEq(targets.length, 1, '有勾选时目标数应等于勾选条数');
      assertEq(targets[0].note, '李四', '有勾选时应忽略筛选、以勾选行为准');

      // 「吊销目标卡密」必须与统一作用域一致（旧实现会误吊销筛选命中的第一行）
      q(doc, '#revoke-filtered-btn').click();
      assertEq(t.normalize(q(doc, '#revoke-list').value), t.normalize(cbs2[1].value),
        '「吊销目标卡密」应只作用于勾选的行');

      // 「复制交付文案」同一口径（v2 起它统一了旧「复制目标话术」的作用范围）：
      // 作用域内有目标就必须给复制反馈，而不是「无匹配」
      var dbtn = q(doc, '#deliver-btn');
      dbtn.click();
      assert(text(dbtn) !== '无匹配', '「复制交付文案」应作用于统一作用域，而不是报无匹配');
      await until(function () { return /^(请手动复制|已复制文案)$/.test(text(dbtn)); }, 2000, '复制交付文案反馈');
      closeLayers(doc);

      // 收尾：清掉吊销框与筛选，避免影响后续用例
      setValue(q(doc, '#revoke-list'), '', C, 'input');
      t.setFilterText('');
      t.render();
    });

    test('cardgen/密钥区：保存私钥 / 公钥指纹 / 自动公钥自检 / 记住与否', async function () {
      var t = g();
      var input = q(doc, '#secret-input');
      var fp = q(doc, '#secret-fingerprint');
      var tip = q(doc, '#secret-tip');
      var persist = q(doc, '#secret-persist');

      q(doc, '#secret-clear').click();
      assertEq(text(fp), '未录入', '未录入私钥时指纹应显示「未录入」');
      assertEq(t.privateKeyOk(), false, '清除后不应有可用私钥');

      // 非法私钥：明确拒绝，且不得产出公钥指纹
      input.value = '这不是私钥';
      q(doc, '#secret-save').click();
      assertMatch(text(tip), /私钥格式不正确/, '非法私钥应给出格式提示，实际：' + text(tip));
      assertEq(text(fp), '未录入', '非法私钥不应产出公钥指纹');

      // 合法私钥（hex 64 字符）：保存后展示由它派生的公钥指纹
      input.value = TEST_PRIV;
      q(doc, '#secret-save').click();
      assertEq(t.privateKeyOk(), true, '保存后私钥应可用');
      assertEq(text(fp), t.pubKeyBase32(), '指纹应是当前私钥派生的公钥');
      assertMatch(text(fp), /^[0-9A-Z]{52}$/, '公钥应为 52 字符 base32');

      // 与客户端内置公钥比对：旧实现靠手动点「与客户端公钥比对」才出结论，
      // 该按钮已按 CG-07-6 删除，改为保存私钥即自动自检（结论就地写在 #secret-tip）。
      assertEq(doc.querySelector('#secret-compare-btn'), null,
        '「与客户端公钥比对」按钮应已删除（改为保存私钥即自动自检）');
      // 用例环境已把页面内的内置公钥对齐到测试私钥，因此这里是「一致」的正向结论；
      // 内置公钥本身是生产常量，与测试私钥派生的公钥天然不同（对齐只发生在页面内）。
      assert(t.pubKeyBase32() !== t.EXPECTED_PUBKEY, '前置：测试私钥派生的公钥不应等于客户端内置的生产公钥');
      assertMatch(text(tip), /公钥自检：一致/, '保存私钥后应自动给出「一致」的公钥自检结论，实际：' + text(tip));

      // 负向：把内置公钥换成一把对不上的值 → 保存私钥即自动判「不一致」，并如实说明后果
      t.setExpectedPubkey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      input.value = TEST_PRIV;
      q(doc, '#secret-save').click();
      assertMatch(text(tip), /公钥自检：不一致/, '内置公钥对不上时应判「不一致」，实际：' + text(tip));
      assertMatch(text(tip), /无法被客户端验签/, '「不一致」结论应说明后果，实际：' + text(tip));

      // 恢复对齐：自检应回到「一致」
      t.setExpectedPubkey(alignedPub);
      input.value = TEST_PRIV;
      q(doc, '#secret-save').click();
      assertMatch(text(tip), /公钥自检：一致/, '恢复内置公钥后自检应回到「一致」，实际：' + text(tip));

      // 「记住私钥」：勾选才落 localStorage，取消勾选必须立刻抹掉
      input.value = TEST_PRIV;
      persist.checked = true;
      fire(persist, 'change', C);
      assertEq(C.localStorage.getItem('lmt_privkey_persist_v1'), '1', '勾选后应持久化「记住私钥」开关');
      assertEq(C.localStorage.getItem('lmt_privkey_v1'), TEST_PRIV, '勾选后私钥应写入 localStorage');
      assertMatch(text(tip), /已记住私钥/, '勾选应有反馈');
      persist.checked = false;
      fire(persist, 'change', C);
      assertEq(C.localStorage.getItem('lmt_privkey_persist_v1'), '0', '取消勾选应更新开关状态');
      assertEq(C.localStorage.getItem('lmt_privkey_v1'), null, '取消勾选后私钥不得再留在 localStorage');
      assertEq(t.privateKeyOk(), true, '取消勾选后私钥仍应在本次会话可用（仅不再持久化）');

      // 收尾：恢复测试私钥，供后续用例继续使用
      input.value = TEST_PRIV;
      q(doc, '#secret-save').click();
      assertEq(t.privateKeyOk(), true, '收尾：测试私钥应可用');
    });

    // v2 §5.9：`#export-deliver-btn`（导出含卡密台账）已删除——与「导出台账」同数据，
    // 含卡密的交付由「复制交付文案」与「导出交付图」承担，故不保留任何用例。

    test('cardgen/导出台账：三列 CSV 与导入无损回环', async function () {
      var t = g();
      g().setLedger('ABCD-EFGH-JKMN-PQRS,张三,2027-12-31');
      setValue(q(doc, '#revoke-list'), '', C, 'input');
      q(doc, '#gen-btn').click();
      var csv = t.buildLedgerCsv().replace(/^\uFEFF/, '');
      assertEq(csv.split('\r\n')[0], '机器码,备注,有效期', '台账导出表头应逐字一致');
      assertMatch(csv.split('\r\n')[1], /^ABCD-EFGH-JKMN-PQRS,张三,2027-12-31$/, '台账导出行应依次为 机器码,备注,有效期');
      assertEq(t.parseEntry(csv.split('\r\n')[1]).key, 'ABCDEFGHJKMNPQRS', '导出的台账必须能被导入侧原样读回（无损回环）');
    });
  }

  // ================================================================
  // 跨应用一致性 + 全局无异常
  // ================================================================
  function crossCases(L, C) {
    test('跨应用：生成器签、主程序验（一卡一机 / 换钥匙必须被拒）', async function () {
      assert(L.__license && C.__cardGen, '两个应用都应已初始化');
      var lic = L.__license, gen = C.__cardGen;
      assertEq(lic.normalize('ab-cd 12'), gen.normalize('ab-cd 12'), '两侧归一化规则必须一致');
      assertEq(lic.MANIFEST_VER, gen.MANIFEST_VER, '两侧清单版本号必须一致');

      // 生成器持私钥 → 派生公钥装进主程序（作者侧与用户侧的分工）
      gen.setPrivateKey(TEST_PRIV);
      var pub = gen.pubKeyBase32();
      assertMatch(pub, /^[0-9A-Z]{52}$/, '私钥应派生出 52 字符 base32 公钥');
      lic.setPubKey(pub);
      assertEq(lic.getPubKey(), pub, '主程序应接受这把公钥');

      // 一卡一机：本机卡密绑定本机机器码；另造一张别的机器的卡密用于反例
      var mc = lic.machineCode();
      var otherMc = 'ABCD-EFGH-JKMN-PQRS';
      assert(mc !== otherMc, '测试机器码应与本机机器码不同');
      var card = gen.makeCard(mc);
      var otherCard = gen.makeCard(otherMc);
      assertMatch(card, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/, '卡密应为 5 组 20 位');
      assert(card !== otherCard, '不同机器码应得到不同卡密');

      // 1) 正确私钥签出的清单：整体验签通过 + 本机卡密放行 + 他机卡密被「一卡一机」拦下
      var updated = gen.localIso(new Date());
      var obj = signManifest(C, updated, [
        { card: card, mc: mc, note: '本机', exp: '2099-12-31' },
        { card: otherCard, mc: otherMc, note: '他机', exp: '2099-12-31' }
      ], []);
      var url = blobUrl(L, obj);
      await lic.fetchManifest(url);
      L.URL.revokeObjectURL(url);
      var m = lic.getManifest();
      assert(m && m.verified === true, '主程序必须能验签生成器产出的清单');
      assertEq(m.rev, obj.rev, '主程序算出的 rev 应与生成器一致');
      var d1 = lic.onlineDecision(card);
      assertEq(d1.ok, true, '生成器按本机机器码签发的卡密必须能通过主程序的在线判定');
      assertEq(d1.exp, '2099-12-31', '有效期应随清单带出');
      var d2 = lic.onlineDecision(otherCard);
      assertEq(d2.ok, false, '他机卡密必须被拦下');
      assertMatch(d2.msg, /一卡一机/, '他机卡密应给出「一卡一机」提示');

      // 2) 换钥匙签出的清单必须被拒绝：主程序里装的是 TEST_PRIV 的公钥，
      //    这里用 TEST_PRIV2 签一份只含 extraCard 的清单；拉取后它不得被采纳，
      //    上一份有效清单也不能被顶掉（否则一次失败的拉取就等于把用户锁死）。
      var extraCard = gen.randomCard();
      gen.setPrivateKey(TEST_PRIV2);
      var objWrong = signManifest(C, gen.localIso(new Date()), [{ card: extraCard, mc: mc, note: '假', exp: '' }], []);
      gen.setPrivateKey(TEST_PRIV);
      var urlWrong = blobUrl(L, objWrong);
      await lic.fetchManifest(urlWrong);
      L.URL.revokeObjectURL(urlWrong);
      assertEq(lic.onlineDecision(extraCard).ok, false, '换私钥签出的清单不得被采纳（其卡密不得放行）');
      assertEq(lic.getManifest() && lic.getManifest().verified, true, '验签失败不得覆盖原有的有效清单');
      assertEq(lic.onlineDecision(card).ok, true, '一次失败的拉取不得让已生效的卡密失效');

      // 3) 吊销：把本机卡密加入 revoked 后重新签，必须被拒
      var objRev = signManifest(C, gen.localIso(new Date()), [], [card]);
      var urlRev = blobUrl(L, objRev);
      await lic.fetchManifest(urlRev);
      L.URL.revokeObjectURL(urlRev);
      assertMatch(lic.onlineDecision(card).msg, /已被吊销/, '已吊销卡密必须被拒绝');
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
      // 用例隔离：卡密生成器把「最近一次同步成功的线上清单」作为会话级状态保留
      // （线上条目 = 台账 ∪ 线上清单，见 effectiveEntries）。不逐条清空的话，
      // 上一条用例同步来的线上条目会以「线上条目」身份继续出现在下一条用例的有效条目里，
      // 让「本地清单应有 N 张卡密」这类断言凭空多出几条。
      if (C.__cardGen && C.__cardGen.resetLastRemote) C.__cardGen.resetLastRemote();
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
