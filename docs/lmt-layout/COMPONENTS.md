# LMT 图文排版生成器 · 功能组件清单

> 版本：v1.36（2026-11-09）
> 入口：`docs/lmt-layout/index.html`（PWA 单文件应用）

---

## 一、模板系统（2 套）

| 模板 | 标识 | 用途 | 图片槽位 | 文案字段 |
|---|---|---|---|---|
| 橱窗 | `tpl-window` | 左右双图 + 文案 | 模特图×2（cover 方形）、截图×2（contain 竖长） | 标题、副标题、正文、标签 |
| 三图竖排 | `tpl-three` | 三张大图竖排 + 小标题 | 宽图×3（wide 12:5） | 标题、副标题、正文、标签、三图各自小标题 |

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

| 字段 | 输入控件 | 样式特点 |
|---|---|---|
| 标题 | `input[type=text]` | 手写体，大字号 |
| 副标题 | `input[type=text]` | 手写体，中字号 |
| 正文 | `textarea` | 手写体，自动适配高度 |
| 标签 | `input[type=text]` | 手写体，小字号，支持多标签 |
| 三图小标题 | `input[type=text]` ×3 | 手写体，位于每图下方 |

### 3.2 安全区适配（`checkContentFit`）

- 实时检测内容是否超出安全区（275×667 虚拟手机屏）
- 超限时自动计算缩放比例 `--fit`，提示「已自动适配安全区：当前按 XX% 缩放」
- 使用 `requestAnimationFrame` 合并连续输入的重排，避免抖动

### 3.3 手写字体

- 字体文件：`handwriting.ttf`（base64 内嵌或异步加载）
- 加载状态跟踪：`fontReady` 标志位，未就绪时禁用导出按钮

---

## 四、草稿系统

| 功能 | 实现 |
|---|---|
| 自动保存 | 输入/图片变更后防抖写入 localStorage |
| 手动保存 | 「保存草稿」按钮，生成草稿记录 |
| 草稿列表 | 展示历史草稿（时间戳 + 预览图） |
| 载入草稿 | 恢复文案 + 图片（从 `photoSource` dataURL 解码重绘） |
| 删除草稿 | 单条删除或清空 |
| 容量管理 | 超限时提示清理，避免 localStorage 溢出 |

草稿数据结构：
```js
{
  tpl: 'window' | 'three',
  fields: { title, subtitle, body, tag, wide1Title, wide2Title, wide3Title },
  photos: { left?, right?, shotLeft?, shotRight?, wide1?, wide2?, wide3? },
  updatedAt: timestamp
}
```

---

## 五、导出系统

| 组件 | 说明 |
|---|---|
| 导出按钮 | 内容适配安全区且字体就绪后可用 |
| 导出引擎 | html2canvas 截取 `#canvas-root` |
| 导出尺寸 | 375×667 × 4 = **1500×2668**（PNG） |
| 导出文件名 | `lmt-layout-{timestamp}.png` |
| 批量出图 | 支持按草稿列表批量生成（复用 `paintPhoto` 管线） |

---

## 六、PWA 与离线能力

| 组件 | 文件 | 说明 |
|---|---|---|
| Service Worker | `sw.js` | 缓存 HTML/JS/字体/图片，支持离线打开 |
| 缓存版本 | `@index-hash` | 与 `index.html` 内容哈希绑定，变更时自动更新缓存 |
| 安装引导 | `index.html` | iOS Safari「添加到主屏幕」提示 |
| 激活页 | `activate.html` | 卡密验证入口，验证通过后跳转主应用 |

---

## 七、授权验证（与 lmt-cards 共享）

| 组件 | 说明 |
|---|---|
| 卡密输入 | 激活页输入卡密 + 机器码 |
| 签名验证 | Ed25519 验签 `cards.json` 清单 |
| 离线凭证 | 验签通过后缓存凭证（TTL 14 天），支持离线使用 |
| 白名单 | 当前 6 张有效卡密，绑定机器码，部分有到期日 |

---

## 八、共享核心模块（`shared/`）

| 模块 | 用途 |
|---|---|
| `Updater.java` | APK 更新检查、下载、安装（并发线路探测 + 超时中断） |
| `ApkFileProvider.java` | APK 文件共享（Android 7+ FileProvider） |
| `web-sync.ps1` | PWA 源码 ↔ Android assets 双向同步 |

---

## 九、CI/CD 流水线（GitHub Actions）

| 工作流 | 触发条件 | 功能 |
|---|---|---|
| `auto-release.yml` | push 到 main | 同步 assets → 升 SW 版本 → 无头测试 → 构建 APK → 发 Release → 推送更新 |
| `web-check.yml` | 定时 / 手动 | sw-hash 校验 / web-tests / cross-repo-sync / android-unit-tests |
| `release.yml` | 手动 | 独立发版（不经过 auto-release 全流程） |

---

## 十、文件清单

```
docs/lmt-layout/
├── index.html          # 主应用（~295KB 单文件）
├── sw.js               # Service Worker
├── handwriting.ttf     # 手写字体（或内嵌）
└── html2canvas.min.js  # 导出引擎
```

---

*本文档由 Trae AI 生成，随代码变更同步更新。*