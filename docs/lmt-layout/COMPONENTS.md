# LMT 图文排版生成器 · 功能组件清单

> 版本：v1.36（2026-11-09）
> 入口：`docs/lmt-layout/index.html`（PWA 单文件应用）

---

## 一、模板系统（2 套内置 + 自定义）

| 模板 | 标识 | 用途 | 图片槽位 | 文案字段 |
|---|---|---|---|---|
| 橱窗 | `tpl-window` | 左右双图 + 文案 | 模特图×2（cover 方形）、截图×2（contain 竖长） | 标题、副标题、正文、标签 |
| 三图竖排 | `tpl-three` | 三张大图竖排 + 小标题 | 宽图×3（wide 12:5） | 标题、副标题、正文、标签、三图各自小标题 |
| 自定义模板 | `tpl-custom-*` | 用户保存的样式组合 | 继承基模板槽位 | 继承基模板字段 |

模板切换仅切换 `hidden` 属性，不清空已填内容；导出仅截取当前可见画布。

---

## 二、图片处理管线

### 2.1 上传组件（每图一套）

| 元素 | 类型 | 说明 |
|---|---|---|
| `.upload-btn` label | 触发器 | 代理点击隐藏 input，显示「点击上传图片」/「已上传：文件名」 |
| `input[type=file]` | 文件选择 | `accept="image/*"`，隐藏 |
| `.clear-btn` | 清除按钮 | 上传成功后显示，点击触发 `clearPhoto()` |
| `.preview-*` 容器 | 预览框 | 内含 `<canvas class="preview-photo">` |

### 2.2 裁切模式（`paintPhoto`）

| 模式 | 包围盒 | 位图尺寸（×4） | 圆角 | 说明 |
|---|---|---|---|---|
| `cover` | 方形 | 528×528 | 10px | 等比放大铺满，居中裁剪 |
| `contain` | 竖长 132:176 | 528×704 | 10px | 等比缩小完整放入，留白 `#fbfcfe` |
| `wide` | 12:5 | 1100×458 | 10px | 等比放大铺满，居中裁剪（原 notch 已移除） |

- 位图按 `EXPORT_SCALE = 4` 生成，html2canvas 复制时为降采样，保证清晰度
- 圆角直接烘焙进位图，不依赖 CSS `border-radius`

### 2.3 原图存档（`photoSource`）

- 存档格式：JPEG dataURL（长边 ≤1600px，质量 0.9）
- 存储位置：内存对象 `photoSource[key]`，草稿保存时写入 localStorage
- 设计原因：避免 PNG 位图过大撑爆 localStorage；避免「保存→载入→再保存」逐代降画质

### 2.4 并发保护

| 机制 | 作用 |
|---|---|
| `uploadToken` | 连续换图时丢弃早发起晚完成的解码结果，防串图 |
| `photoSeq[key]` | 清除/恢复时作废在途解码，防异步竞争 |

---

## 三、文案排版系统

### 3.1 字段组件

| 字段 | 输入控件 | 预览元素 | 样式特点 |
|---|---|---|---|
| 摘要 | `input-summary` | `preview-summary` | 手写体，顶部区域 |
| 标题 | `input-title` | `preview-title` | 手写体，大字号 |
| 关键词 | `input-keywords` | `preview-keywords` | 手写体，高亮标签样式 |
| 副标题 | `input-subtitle` | `preview-subtitle` | 手写体，中字号 |
| 三图小标题 | `input-cap-1/2/3` | `preview-cap-1/2/3` | 手写体，位于每图下方 |

### 3.2 安全区适配（`checkContentFit`）

- 实时检测内容是否超出安全区（275×667 虚拟手机屏）
- 超限时自动计算缩放比例 `--fit`，提示「已自动适配安全区：当前按 XX% 缩放」
- 使用 `requestAnimationFrame` 合并连续输入的重排，避免抖动
- `FIT_GRID` 二分查找最优缩放比例

### 3.3 手写字体

- 字体文件：`handwriting.ttf`（base64 内嵌或异步加载）
- 加载状态跟踪：`fontReady` 标志位，未就绪时禁用导出按钮
- 支持多字体源 fallback（`fontCssSources` / `loadWebFont` / `applyHandwritingFont`）

---

## 四、样式自定义系统

### 4.1 样式控制面板

| 控件 | 变量 | 说明 |
|---|---|---|
| `style-color-title` | `--style-color-title` | 标题颜色 |
| `style-size-title` | `--style-size-title` | 标题字号 |
| `style-color-summary` | `--style-color-summary` | 摘要颜色 |
| `style-size-summary` | `--style-size-summary` | 摘要字号 |
| `style-color-keywords` | `--style-color-keywords` | 关键词颜色 |
| `style-size-keywords` | `--style-size-keywords` | 关键词字号 |
| `style-radius` | `--tpl-radius` | 圆角大小 |
| `style-color-bg` | `--style-color-bg` | 背景色 |

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

---

## 五、草稿系统

### 5.1 草稿操作

| 功能 | 函数/组件 |
|---|---|
| 保存草稿 | `saveDraft(name)` |
| 载入草稿 | `loadDraft(id)` |
| 删除草稿 | `deleteDraft(id)` |
| 重命名草稿 | `draft-rename-btn` → `promptName()` |
| 导出草稿 | `exportDrafts()` → JSON 文件 |
| 导入草稿 | `importDrafts(json)` |
| 搜索草稿 | `draft-search` → `queryDrafts()` |
| 刷新列表 | `refreshDraftOptions()` |

### 5.2 草稿存储

| 层级 | 机制 |
|---|---|
| 元数据 | localStorage `DRAFT_KEY`（含字段、样式、时间戳、字节数估算） |
| 图片数据 | IndexedDB（`idbPutImages` / `idbGetImages` / `idbDeleteImages`） |
| 容量估算 | `approxDraftBytes(item)` |
| 图片计数 | `draftImageCount(d)` |
| 图片水合 | `hydrateDraftImages(d)` |

### 5.3 草稿数据结构

```js
{
  id: string,
  name: string,
  tpl: 'window' | 'three',
  fields: { summary, title, keywords, subtitle, cap1, cap2, cap3 },
  style: { colorTitle, sizeTitle, colorSummary, sizeSummary, colorKeywords, sizeKeywords, radius, colorBg },
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
| 刷新片段选项 | `refreshSnippetOptions()` |
| 按字段筛选 | `fieldTplsOf(field)` / `snippetBelongsTo(s, tpl)` |

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

### 7.2 批量执行

| 功能 | 函数 |
|---|---|
| 渲染单个任务 | `renderBatchTask(task, d)` |
| 设置进度 | `setBatchProgress(done, total)` |
| 完成处理 | `finishBatch(res)` |
| 执行批量 | `performBatch(tasks)` |
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
| 导出引擎 | html2canvas 截取 `#canvas-root` |
| 导出尺寸 | 375×667 × 4 = **1500×2668**（PNG） |
| 导出文件名 | `lmt-layout-{timestamp}.png` |
| 画布捕获 | `captureCanvas()` → `canvasToUrl()` → `canvasToPngBytes()` |
| 原生保存 | `tryNativeSave(dataUrl, fileName, mime)`（支持 Web Share API / 下载） |
| 字节保存 | `saveBytes(b, fileName, mime)` / `saveText(text, fileName, mime)` |
| 图片预览 | `showImagePreview(dataUrl, fileName, onClose)` |

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

---

## 十、PWA 与离线能力

| 组件 | 文件 | 说明 |
|---|---|---|
| Service Worker | `sw.js` | 缓存 HTML/JS/字体/图片，支持离线打开 |
| 缓存版本 | `@index-hash` | 与 `index.html` 内容哈希绑定，变更时自动更新缓存 |
| 安装引导 | `index.html` | iOS Safari「添加到主屏幕」提示 |
| 激活页 | `activate.html` | 卡密验证入口，验证通过后跳转主应用 |

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

### 11.2 加密原语（纯 JS 实现）

| 功能 | 函数 |
|---|---|
| SHA-256 | `sha256Bytes()` / `sha256Hex()` |
| SHA-512 | `sha512Bytes()` / `sha512Hex()` |
| HMAC-SHA256 | `hmacSha256Hex()` |
| Base32 | `base32Encode()` / `base32Decode()` / `base32EncodeFull()` |
| Ed25519 | `ed25519PublicKey()` / `ed25519Sign()` / `ed25519Verify()` |

### 11.3 清单管理

| 功能 | 函数 |
|---|---|
| 获取清单 | `getManifest()` / `fetchManifest(url)` |
| 在线决策 | `onlineDecision(card)` |
| 读取缓存 | `loadCachedManifest()` / `readCache()` |
| 写入缓存 | `writeCache(data)` |
| 清除缓存 | `clearCache()` |
| 凭证时效 | `credAgeMs()` / `credFresh()` |

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

---

## 十五、文件清单

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