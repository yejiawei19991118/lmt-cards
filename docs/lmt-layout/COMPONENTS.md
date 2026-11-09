# LMT 图文排版生成器 · 功能组件清单

> 版本：v1.40（2026-11-09）
> 入口：`docs/lmt-layout/index.html`（PWA 单文件应用）

---

## 一、模板系统（2 套内置 + 自定义）

| 模板 | 标识 | 用途 | 图片槽位 | 文案字段 |
|---|---|---|---|---|
| 橱窗 | `tpl-window` | 左右双图 + 文案 | 模特图×2（cover 方形）、截图×2（contain 竖长） | 顶部摘要、主标题、关键词、副标题 |
| 三图竖排 | `tpl-three` | 三张大图竖排 + 小标题 | 宽图×3（wide 12:5） | 顶部摘要、主标题、三图小标题×3 |
| 自定义模板 | `tpl-custom-*` | 用户保存的样式组合 | 继承基模板槽位 | 继承基模板字段 |

- 模板切换仅切换 `hidden` 属性，不清空已填内容；导出仅截取当前可见画布
- `TPL_FIELD_KEYS` / `TPL_IMG_KEYS` 表驱动隔离：两套模板各有独立文案与图片存储

---

## 二、图片处理管线

### 2.1 上传组件（每图一套）

| 元素 | 类型 | 说明 |
|---|---|---|
| `.upload-btn` label | 触发器 | 代理点击隐藏 input，显示「点击上传图片」/「已上传：文件名」 |
| `input[type=file]` | 文件选择 | `accept="image/*"`，隐藏；读取前校验类型（`image/` 前缀）与大小（≤30MB），超限直接拒绝并提示 |
| `.clear-btn` | 清除按钮 | 上传成功后显示，点击触发 `clearPhoto()` |
| `.preview-*` 容器 | 预览框 | 内含 `<canvas class="preview-photo">` |

### 2.2 裁切模式（`paintPhoto`）

| 模式 | 包围盒 | 位图尺寸（×4） | 圆角 | 说明 |
|---|---|---|---|---|
| `cover` | 方形 | 528×528 | 跟随 `--tpl-radius` | 等比放大铺满，居中裁剪 |
| `contain` | 竖长 132:176 | 528×704 | 跟随 `--tpl-radius` | 等比缩小完整放入，留白 `#fbfcfe` |
| `wide` | 12:5 | 1100×458 | 跟随 `--tpl-radius` | 等比放大铺满，居中裁剪 |

- 位图按 `EXPORT_SCALE = 4` 生成，html2canvas 复制时为降采样，保证清晰度
- 圆角读取 `readCurrentStyle().radius`（0–30px 可调）× 4 烘焙进位图，导出与预览始终一致，不依赖 CSS `border-radius`
- `computeDrawRect()` 纯函数计算等比绘制矩形，绝不拉伸变形

### 2.3 原图存档（`photoSource`）

- 存档格式：JPEG dataURL（长边 ≤1600px，质量 0.9）
- 存储位置：内存对象 `photoSource[key]`，草稿保存时写入 localStorage
- 设计原因：避免 PNG 位图过大撑爆 localStorage；避免「保存→载入→再保存」逐代降画质

### 2.4 并发保护

| 机制 | 作用 |
|---|---|
| `uploadToken` | 连续换图时丢弃早发起晚完成的解码结果，防串图 |
| `photoSeq[key]` | 清除/恢复时作废在途解码；手动换图同样自增，防草稿恢复的旧图覆盖新选图 |
| `loadDraftSeq` | 快速连选两份草稿时丢弃先到慢草稿的过期结果，防串内容 |

---

## 三、文案排版系统

### 3.1 字段组件

| 字段 | 输入控件 | 预览元素 | 样式特点 |
|---|---|---|---|
| 顶部摘要 | `input-summary` | `preview-summary` | 手写体，支持换行（`\n` 转 `<br>`） |
| 主标题 | `input-title` | `preview-title` | 手写体，大字号 |
| 关键词 | `input-keywords` | `preview-keywords` | 手写体，高亮标签样式 |
| 副标题 | `input-subtitle` | `preview-subtitle` | 手写体，中字号 |
| 三图小标题 | `input-cap-1/2/3` | `preview-cap-1/2/3` | 手写体，位于每图下方 |

### 3.2 安全区适配（`checkContentFit`）

- 实时检测内容是否超出安全区（275×667 虚拟手机屏）
- 超限时自动计算缩放比例 `--fit`，提示「已自动适配安全区：当前按 XX% 缩放」
- 使用 `requestAnimationFrame` 合并连续输入的重排，避免抖动
- `FIT_GRID` 二分查找最优缩放比例
- `fit-lock` 开关：勾选「自动适配字号」时启用缩放，取消则不缩放

### 3.3 手写字体

| 字体 | 来源 | 类型 |
|---|---|---|
| 站酷快乐体（默认） | Google Fonts | 手写体 |
| 小赖字体 | 中文网字计划（jsDelivr） | 手写楷 |
| 悠哉手写体 | 中文网字计划（jsDelivr） | 手写风 |
| 猫啃珠圆体 | 中文网字计划（jsDelivr） | 可爱标题 |
| 霞鹜文楷 | Google Fonts | 开源楷体 |
| 站酷小薇体 | Google Fonts | 文艺细楷 |
| 站酷庆科黄油体 | Google Fonts | 粗展板 |

- 加载状态跟踪：`fontReady` 标志位，未就绪时禁用导出按钮
- 支持多字体源 fallback（`fontCssSources` / `loadWebFont` / `applyHandwritingFont`）
- 超时兜底：单个字体源 6 秒超时，自动切到镜像源
- 加载失败仍允许导出（回退系统字体），但明示 error 状态

---

## 四、样式自定义系统

### 4.1 样式控制面板

| 控件 | 变量 | 说明 |
|---|---|---|
| `style-color-title` | `--tpl-title-color` | 标题颜色 |
| `style-size-title` | `--tpl-title-size` | 标题字号（16~40px） |
| `style-color-summary` | `--tpl-summary-color` | 文案颜色 |
| `style-size-summary` | `--tpl-summary-size` | 文案字号（9~22px） |
| `style-color-keywords` | `--tpl-copy-color` | 关键词颜色 |
| `style-size-keywords` | `--tpl-copy-size` | 关键词字号（9~22px） |
| `style-radius` | `--tpl-radius` | 图片圆角（0~30px） |
| `style-color-bg` | `--tpl-bg` | 画布底色（参与导出） |

### 4.2 样式操作

| 功能 | 函数 |
|---|---|
| 读取当前样式 | `readCurrentStyle()` |
| 从控件收集样式 | `collectStyleFromControls()` |
| 同步控件到样式 | `syncStyleControls()` |
| 应用样式变量 | `applyStyleVars()` / `applyCustomStyle()` |
| 重置自定义样式 | `resetCustomStyle()` |

### 4.3 自定义模板（我的模板）

| 功能 | 函数 |
|---|---|
| 保存模板 | `saveMyTemplate(name, base, style)` |
| 删除模板 | `deleteMyTemplate(id)` |
| 刷新模板选项 | `refreshMyTemplateOptions()` |
| 按 ID 查找 | `myTemplateById(id)` |
| 列出全部 | `listMyTemplates()` |
| 持久化 | `persistMyTemplates(items)` |

---

## 五、草稿系统

### 5.1 草稿操作

| 功能 | 函数/组件 |
|---|---|
| 保存草稿 | `saveDraft(name)` |
| 载入草稿 | `loadDraft(id)` → 返回 `{ ok, imgsMissing }`；`loadDraftSeq` 令牌丢弃过期载入 |
| 删除草稿 | `deleteDraft(id)` |
| 重命名草稿 | `draft-rename-btn` → `promptName()` |
| 导出草稿 | `exportDrafts()` → JSON 文件 |
| 导入草稿 | `importDrafts(json)`；最终持久化失败时回删已搬进 IndexedDB 的图片，不留孤儿记录 |
| 搜索草稿 | `draft-search` → `queryDrafts()`（150ms 防抖，避免每击键全量解析草稿表） |
| 刷新列表 | `refreshDraftOptions()` |
| 格式化时间 | `fmtDraftTime(ts)` |
| 格式化字节 | `fmtDraftBytes(b)` |

### 5.2 草稿存储

| 层级 | 机制 |
|---|---|
| 元数据 | localStorage `lmt_drafts_v1`（含字段、样式、时间戳、字节数估算） |
| 图片数据 | IndexedDB（`idbPutImages` / `idbGetImages` / `idbDeleteImages`） |
| 容量估算 | `approxDraftBytes(item)` |
| 图片计数 | `draftImageCount(d)` |
| 图片水合 | `hydrateDraftImages(d)` |
| 打开数据库 | `openImageDb()`（失败不缓存结果，下次调用自动重试） |
| 持久化单项 | `persistDraftItem(item)` |

### 5.3 草稿数据结构

```js
{
  id: string,
  name: string,
  tpl: 'window' | 'three',  // 底层槽名（非「我的模板」预设 id，避免预设删除后载入错位）
  fields: { summary, title, keywords, subtitle, cap1, cap2, cap3 },
  style: { titleColor, titleSize, summaryColor, summarySize, copyColor, copySize, radius, bg },
  imgs: { left?, right?, shotLeft?, shotRight?, wide1?, wide2?, wide3? }, // 存 IndexedDB
  bytes: number,
  updatedAt: timestamp
}
```

---

## 六、片段（Snippet）系统

| 功能 | 函数 |
|---|---|
| 保存片段 | `saveSnippet(field, text)` |
| 删除片段 | `deleteSnippet(id)` |
| 插入片段 | `insertSnippet(id, fieldOverride)` |
| 刷新片段选项 | `refreshSnippetOptions()` / `refreshSnippetFieldOptions(tplName)` |
| 按字段筛选 | `fieldTplsOf(field)` / `snippetBelongsTo(s, tpl)` |
| 列出全部 | `listSnippets()` |
| 持久化 | `persistSnippets(items)` |

片段绑定字段（`FIELD_INPUTS` / `FIELD_LABELS`），支持跨模板复用。

---

## 七、批量出图系统

### 7.1 批量任务构建

| 功能 | 函数 |
|---|---|
| 构建任务列表 | `buildBatchTasks()` |
| 刷新任务列表 UI | `refreshBatchList()` |
| 更新选中计数 | `updateBatchCount()` |
| 全选/全不选 | `toggleBatchSelectAll()` |
| 模板标签 | `tplLabelOf(v)` |

### 7.2 批量执行

| 功能 | 函数 |
|---|---|
| 渲染单个任务 | `renderBatchTask(task, d)` |
| 设置进度 | `setBatchProgress(done, total)` |
| 完成处理 | `finishBatch(res)` |
| 执行批量 | `performBatch(tasks)`（收尾按两套模板全量图片键还原，混模板出图不丢图） |
| 取消批量 | `batchCancelBtn` → `batchCancel = true` |
| 重试失败 | `batchRetryBtn` |

### 7.3 批量输出

- 生成 ZIP 包：`zipStore(files)` / `zipBlob(files)`
- CRC32 校验：`crc32(bytes)`（预计算表 `CRC32_TABLE`）
- 进度条：`batch-progress` / `batch-progress-bar`
- 锁定草稿操作：`setDraftLocked(locked)`（批量期间禁用草稿增删改）

---

## 八、导出系统

| 组件 | 说明 |
|---|---|
| 导出按钮 | `export-btn`，内容适配安全区且字体就绪后可用 |
| 导出引擎 | html2canvas 截取 `#export-target` |
| 导出尺寸 | 375×667 × 4 = **1500×2668**（PNG） |
| 导出文件名 | `lmt-layout-{timestamp}.png` |
| 画布捕获 | `captureCanvas()` → `canvasToUrl()` → `canvasToPngBytes()` |
| 原生保存 | `tryNativeSave(dataUrl, fileName, mime)`（支持 Web Share API / 下载） |
| 字节保存 | `saveBytes(b, fileName, mime)` / `saveText(text, fileName, mime)` |
| 图片预览 | `showImagePreview(dataUrl, fileName, onClose)` |
| 导出消息 | `setExportMsg(t)` |

---

## 九、偏好设置系统

| 偏好项 | 控件 | 说明 |
|---|---|---|
| 自动记忆 | `pref-auto-remember` | 自动保存草稿 |
| 自动同步 | `pref-auto-sync` | 在线时自动同步卡密清单 |
| 撤销秒数 | `pref-undo-seconds` | 撤销操作有效期 |

| 功能 | 函数 |
|---|---|
| 保存偏好 | `savePrefs()` |
| 防抖保存 | `scheduleSavePrefs()` |
| 加载偏好 | `loadPrefs()` |
| 重置偏好 | `resetPrefs(scope)` |
| 自动同步开关 | `prefAutoSyncOn()` |

---

## 十、PWA 与离线能力

| 组件 | 文件 | 说明 |
|---|---|---|
| Service Worker | `sw.js` | 缓存 HTML/JS/字体/图片，支持离线打开 |
| 缓存版本 | `@index-hash` | 与 `index.html` 内容哈希绑定，变更时自动更新缓存 |
| 安装引导 | `index.html` | iOS Safari「添加到主屏幕」提示 |
| 激活页 | `activate.html` | 卡密验证入口，验证通过后跳转主应用 |

### SW 更新机制

- `updateViaCache: 'none'`：SW 脚本不走 HTTP 缓存
- 每次页面回到前台主动 `update()`：iOS 主屏 App 切回时发现新版本
- `controllerchange` 时自动刷新：新 SW 接管后刷新页面（仅未编辑时）
- `edited` 标志位：仅 `input`/`change`（真实内容变化）置位阻止自动刷新，纯点击不阻止，防止丢内容

---

## 十一、授权验证系统

### 11.1 卡密验证

| 组件 | 说明 |
|---|---|
| 卡密输入 | `license-input` + `license-activate` |
| 机器码 | `license-mc`（自动生成，可复制） |
| 签名验证 | Ed25519 验签 `cards.json` 清单 |
| 离线凭证 | 验签通过后缓存凭证（TTL 14 天），支持离线使用 |
| 白名单 | 当前 6 张有效卡密，绑定机器码，部分有到期日 |
| 激活状态 | `isActivated()` / `activate(card)` / `deactivate()` |
| 状态读写 | `readStat()` / `writeStat(o)` / `clearStat()` |

### 11.2 加密原语（纯 JS 实现）

| 功能 | 函数 |
|---|---|
| SHA-256 | `sha256Bytes()` / `sha256Hex()` |
| SHA-512 | `sha512Bytes()` / `sha512Hex()` |
| HMAC-SHA256 | `hmacSha256Hex()` |
| Base32 | `base32Encode()` / `base32Decode()` / `base32EncodeFull()` |
| Ed25519 | `ed25519PublicKey()` / `ed25519Sign()` / `ed25519Verify()` |
| 公钥管理 | `setPubKey(b32)` / `currentPubKey()` / `verifySigCached()` |
| 64 位运算 | `lmtAnd64()` / `lmtXor64()` / `lmtNot64()` / `lmtAdd64()` / `lmtShr64()` / `lmtRotr64()` |
| 大数运算 | `edMod()` / `edPowMod()` / `edInvMod()` / `edLEToBig()` / `edBigToLE()` |
| 椭圆曲线 | `edRecoverX()` / `edDecodePoint()` / `edCompressPoint()` / `edAdd()` / `edDouble()` / `edScalarMult()` |

### 11.3 清单管理

| 功能 | 函数 |
|---|---|
| 清单 URL | `MANIFEST_URL`（主源）+ `MANIFEST_MIRRORS`（备用镜像） |
| 备用镜像 | 仅 1 条：`cdn.jsdelivr.net/gh/.../lmt-cards/cards.json`（不带 ref）。`@main` 写法已删除：分支引用约 12 小时缓存、发版 purge 偶尔静默失效，长期停在旧版本 |
| 清单时间显示 | `fmtManifestTime(s)`：`2026-10-31T13:54:00+08:00` → `2026-10-31 13:54`，按字符串取年月日时分，不做时区换算 |
| 获取清单 | `getManifest()` / `fetchManifest(url)` / `fetchOneManifest(u, token)` |
| 清单解析 | `parseManifest(data)` |
| 在线决策 | `onlineDecision(card)` |
| 读取缓存 | `loadCachedManifest()` / `readCache()` |
| 写入缓存 | `writeCache(data)` |
| 清除缓存 | `clearCache()` |
| 凭证时效 | `credAgeMs()` / `credFresh()` |
| 清单规范化 | `manifestCardsLines()` / `manifestRevokedStr()` / `canonicalManifestString()` |
| 卡密格式 | `cardFormatOk(card)` / `normalize(code)` |
| 过期判断 | `isExpired(exp)` |
| 同步清单 | `syncManifestOnline()` |

---

## 十二、UI 交互组件

### 12.1 对话框

| 组件 | 函数 |
|---|---|
| 命名对话框 | `promptName(title, defaultValue)` |
| 确认对话框 | `confirmDialog(opts)` |
| 撤销提示 | `showUndoToast(message, onUndo, ttlMs)` |
| 轻提示 | `showToast(message, ttlMs)` |
| 手动复制弹窗 | `showManualCopy(text, title)` |

- 弹层按钮统一等宽布局，「取消」固定在左、操作按钮在右（含危险操作），与手机系统弹窗习惯一致

### 12.2 工具函数

| 功能 | 函数 |
|---|---|
| HTML 转义 | `escapeHtml(str)` |
| 复制文本 | `copyText(text, onDone)` / `syncCopy(text)` |
| 按钮闪动反馈 | `flashButton(btn, text, restoreText)` |
| 复制带反馈 | `copyWithFeedback(text, btn, okText)` |
| 锁定滚动 | `lockScroll()` / `unlockScroll()` |
| ESC 键监听 | `onEsc(handler)` |
| iOS 检测 | `isIOSLike()` |
| 移动端检测 | `isMobileUA(ua)` / `isTouchPrimary()` |
| 触发下载 | `triggerDownload(href, fileName)` |
| 时间戳命名 | `tsName()` / `defaultName(prefix)` |
| 文件名净化 | `sanitizeName(name, max)` |
| Base64 | `bytesToBase64(bytes)` |
| UTF-8 | `utf8ToBytes(str)` / `utf8Bytes(str)` |
| DataURL 转字节 | `dataUrlToBytes(dataUrl)` |
| JSON 读写 | `readJSON(key, fallback)` / `writeJSON(key, obj)` |
| 随机 ID | `randomId()` |
| 安装 ID | `installId()` |
| 机器码 | `machineCode()` |
| 格式化时间 | `fmtDraftTime(ts)` |
| 格式化字节 | `fmtDraftBytes(b)` |

### 12.3 模板清理

| 功能 | 函数 |
|---|---|
| 清空当前模板 | `clearCurrentTemplate()` |
| 刷新清空按钮状态 | `refreshTplClearBtn()` |
| 字段快照 | `snapshotFieldsTo(tpl)` |
| 字段恢复 | `loadFieldsFrom(tpl)` / `restoreFieldStore(s)` |
| 清空字段存储 | `clearFieldStore()` |
| 同步字段预览 | `syncFieldPreview()` |
| 捕获字段 | `captureFields()` |
| 捕获图片 | `captureImgs()` / `captureImgsAll()` / `captureImgsOf(keys)` |
| 应用快照 | `applySnapshot(snap)` |

---

## 十三、共享核心模块（`shared/`）

| 模块 | 用途 |
|---|---|
| `Updater.java` | APK 更新检查、下载、安装（并发线路探测 + 超时中断） |
| `ApkFileProvider.java` | APK 文件共享（Android 7+ FileProvider） |
| `web-sync.ps1` | PWA 源码 ↔ Android assets 双向同步 |

---

## 十四、CI/CD 流水线（GitHub Actions）

| 工作流 | 触发条件 | 功能 |
|---|---|---|
| `auto-release.yml` | push 到 main | 同步 assets → 升 SW 版本 → 无头测试 → 构建 APK → 发 Release → 推送更新 |
| `web-check.yml` | 定时 / 手动 | sw-hash 校验 / web-tests / cross-repo-sync / android-unit-tests |
| `release.yml` | 手动 | 独立发版（不经过 auto-release 全流程） |

- 更新文案（APK 更新弹窗的 notes）取触发提交的完整提交信息（`git log -1 --pretty=%B`，含正文多行），
  提交信息写什么用户就看到什么；不再使用「自动发版：共享核心随 xxx 更新」占位文案
- 中文文案必须经文件传递：workflow 用 bash 重定向写 `release-notes.txt`（字节级、不转码），
  `release.ps1 -NotesFile` 用 `[IO.File]::ReadAllText(path, UTF8)` 显式解码。
  早期用 `-Notes "$NOTES"` 走命令行参数，UTF-8 字节被按非 UTF-8 解码，v1.39 清单 notes 因此整段乱码

---

## 十五、测试钩子（`window.__layoutTool`）

暴露给 `tests/harness.html` 的 iframe 直接复用，包含：

- 纯函数：`escapeHtml` / `computeDrawRect` / `isMobileUA` / `isTouchPrimary` / `crc32` / `paintPhoto`
- 批量出图：`zipStore` / `zipBlob` / `captureFields` / `captureImgs` / `captureCanvas`
- 图片管理：`restorePhoto` / `clearPhoto`
- 草稿箱：`saveDraft` / `loadDraft` / `listDrafts` / `deleteDraft` / `exportDrafts` / `importDrafts`
- IndexedDB：`hydrateDraftImages` / `draftImageCount`
- 样式：`applyCustomStyle` / `resetCustomStyle`
- 模板：`saveMyTemplate` / `listMyTemplates` / `deleteMyTemplate`
- 偏好：`savePrefs` / `loadPrefs` / `resetPrefs`
- 片段：`saveSnippet` / `listSnippets` / `insertSnippet` / `deleteSnippet`
- 对话框：`confirmDialog` / `showUndoToast`
- 批量：`updateBatchCount` / `refreshSnippetFieldOptions` / `currentExportScale`
- 模板隔离：`currentSlotName` / `TPL_FIELD_KEYS` / `TPL_IMG_KEYS` / `clearCurrentTemplate` / `applyTemplate`
- 存储键：`SNIPPET_KEY`

---

## 十六、文件清单

```
docs/lmt-layout/
├── index.html          # 主应用（~295KB 单文件，含全部逻辑）
├── sw.js               # Service Worker
├── COMPONENTS.md       # 本文档
├── handwriting.ttf     # 手写字体（或内嵌）
└── html2canvas.min.js  # 导出引擎
```

---

*本文档由 Trae AI 生成，随代码变更同步更新。*
