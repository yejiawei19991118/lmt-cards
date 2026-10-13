# LMT 工具箱 · GitHub Pages 部署说明

本目录（`pwa/`）就是**静态站点根目录**，其内容可直接推送到 GitHub Pages 部署。

```
（站点根目录）
├─ .nojekyll            禁用 Jekyll，保证文件原样发布
├─ index.html           首页（两个应用的入口）
├─ README.md            本说明（可不上传）
├─ lmt-layout/          图文排版生成器（PWA）
│  ├─ index.html  html2canvas.min.js  manifest.json  sw.js
│  └─ icon-180.png  icon-192.png  icon-512.png
└─ lmt-cardgen/         卡密生成器（PWA）
   ├─ index.html  manifest.json  sw.js
   └─ icon-180.png  icon-192.png  icon-512.png
```

两个应用内部全部使用**相对路径**（`start_url: "./index.html"`、`scope: "./"`），因此部署在仓库子目录下也能正常工作。

## 一、部署（Deploy from a branch，最简单）

1. 新建（或复用一个）GitHub 仓库。
2. 把本目录的**全部内容**推到仓库 `main` 分支的根目录：

   ```bash
   cd pwa
   git init
   git add .
   git commit -m "deploy lmt toolbox"
   git branch -M main
   git remote add origin https://github.com/<用户名>/<仓库名>.git
   git push -u origin main
   ```

3. 仓库页面 → **Settings → Pages**：
   - **Source** 选 `Deploy from a branch`
   - **Branch** 选 `main`，目录选 `/ (root)` → **Save**
4. 约 1 分钟后访问（`<用户名>`、`<仓库名>` 换成你自己的）：
   - 首页：`https://<用户名>.github.io/<仓库名>/`
   - 图文排版：`https://<用户名>.github.io/<仓库名>/lmt-layout/`
   - 卡密生成器：`https://<用户名>.github.io/<仓库名>/lmt-cardgen/`

### 变体：放进已有仓库的 /docs 目录

若想并入现有仓库（例如 `lmt-cards`）：把本目录内容放到该仓库的 `docs/` 下，再到 **Settings → Pages** 把目录选为 **`/docs`**。访问地址同上，仅仓库名不同。这样不会影响仓库根目录里已有的 `cards.json`。

## 二、在 iPhone / iPad 上安装

必须使用 **Safari**（Chrome 等无法「添加到主屏幕」）：

1. Safari 打开 `https://<用户名>.github.io/<仓库名>/lmt-layout/`
2. 点底部「分享」→ 向下找到「**添加到主屏幕**」→ 命名 → 添加
3. 桌面即出现图标，点开为全屏独立应用；断网也能打开（应用外壳已离线缓存）
4. 卡密生成器同理：打开 `/lmt-cardgen/` 后添加到主屏幕

> 注意：直接用 `file://` 打开网页不会启用离线缓存，也不支持「添加到主屏幕」，**必须经 http/https 访问**。

## 三、更新与维护

- 修改任一应用文件后，请同步修改对应 `sw.js` 里的 `CACHE` 版本号（如 `lmt-layout-v1` → `lmt-layout-v2`），否则手机端可能仍读旧缓存。
- 卡密生成器的在线清单地址（`MANIFEST_URL` 主源 + jsDelivr 备用源）位于 `lmt-cardgen/index.html` 内，与 Android 版保持一致，无需改动。
