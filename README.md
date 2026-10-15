# lmt-cards

LMT 工具箱的**分发与授权仓库**：承载两个纯前端应用（PWA）、安卓副本的更新清单与安装包镜像，以及卡密清单。

```
lmt-cards/
├─ cards.json           卡密清单（由「卡密生成器」用私钥签发，见下「清单契约」）
├─ update.json          APK 更新清单（发版脚本生成；docs/update.json 为 GitHub Pages 副本）
├─ docs/                静态站点根目录（PWA 源码 + APK 镜像 + update.json）
│  ├─ lmt-layout/       图文排版生成器（用户侧出图工具）
│  ├─ lmt-cardgen/      卡密生成器（作者侧运营工具）
│  └─ apk/              APK 镜像（jsDelivr / GitHub Pages 备源）
├─ tests/               桌面无头浏览器交互测试（harness.html + harness.js + run.ps1）
└─ tools/               release.ps1（一键发版）/ web-sync.ps1（双份源码守卫）
```

## 一、密钥分工：生成器持私钥签发，客户端只嵌公钥验签

- **私钥只存在于作者侧**：在「卡密生成器」页面录入，默认仅存 `sessionStorage`（关闭标签即失效），需要持久化时须显式勾选。私钥**绝不进入仓库**、也不会下发到任何产物。
- **客户端只内置公钥**（`lmt-layout` / `lmt-cardgen` 里的 `LICENSE_PUBKEY`，当前值 `M67HT17D19HYQS5CHWKRN05GVEFSTVVV01ADAXP579C66A09RFN0`）。客户端只用它**验签**，不持有任何可签发凭证的密钥。
- 签名算法为 **Ed25519**（纯 JS 实现，零第三方依赖），签名值经 base32 编码后写入清单的 `sig2`。
- 因此：**改清单必须有私钥**。任何人手改 `cards.json`（哪怕只改一个有效期）都会导致客户端验签失败并直接拒绝该清单。

> 与旧方案的差别：过去是对称密钥（`LICENSE_SECRET`）同时内置在生成器与客户端里、客户端本地重算卡密做判定；现在客户端**没有任何密钥**，卡密是否有效完全取决于「清单是否被公钥验签通过 + 条目是否匹配本机」。

## 二、清单契约（`cards.json`，`ver = 2`）

```json
{
  "ver": 2,
  "updated": "2026-10-15T12:34:56+08:00",
  "rev": "<sha256 前 16 位 hex>",
  "cards": [
    { "card": "XXXX-XXXX-XXXX-XXXX-XXXX", "mc": "YYYY-YYYY-YYYY-YYYY", "note": "备注", "exp": "2026-12-31" }
  ],
  "revoked": ["ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ"],
  "sig2": "<Ed25519 签名，base32>"
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `ver` | 契约版本，客户端只认 `2`（`MANIFEST_VER`），两侧必须一致 |
| `updated` | 清单更新时间，ISO 8601 **含时区**（如 `2026-10-15T12:34:56+08:00`）。客户端不解析它，只作为签名文本的一部分 |
| `rev` | 内容指纹，见下。用于「内容是否变化、是否需要重传」的探测 |
| `cards[]` | 白名单条目。`card` 为卡密，`mc` 为该卡绑定的机器码（一卡一机），`note` 备注、`exp` 到期日（`YYYY-MM-DD`，空表示不过期） |
| `revoked[]` | 吊销的卡密列表 |
| `sig2` | 对规范化串的 Ed25519 签名（base32，64 字节 → 103 字符）。字母表 `0123456789ABCDEFGHJKMNPQRSTVWXYZ`（不含 `I/L/O/U`） |

### 规范化口径

- `card` / `mc` → 转大写并剔除 `[^0-9A-Z]`（即去掉分组横线）
- `note` / `exp` → 去掉首尾空白后原样保留
- `revoked` → 归一化后去重、升序
- `cards` 排序键 → `mc + "\u0000" + card`，序号（ordinal）升序

### 规范化串与签名

```
revSource = ver "\n" updated "\n"
            cards 按 (mc,card) 升序，每项 "{card}|{mc}|{note}|{exp}" 用 "\n" 连接
            "\n" revoked 升序 join(",")

rev       = sha256Hex(revSource) 的前 16 位 hex

canonical = ver "\n" updated "\n" rev "\n"
            （同样的 cards 行）"\n" revoked 升序 join(",")

sig2      = base32( ed25519Sign(私钥, utf8Bytes(canonical)) )
```

`canonical` 把 `rev` 也绑进签名，因此 `updated`、`cards`（含 `mc`/`note`/`exp`）、`revoked` **任一处被改动都会导致验签失败** —— 篡改有效期同样会被拒。

> 这段口径在**生成器与客户端两侧逐字一致**（`lmt-cardgen` / `lmt-layout` 的 `manifestRevSource` / `canonicalManifestString`），改动务必两侧同步，否则两边算出的 `rev` / `sig2` 对不上。

### 解析优先级

1. `revoked` 命中 → **直接拒绝**（吊销优先）
2. 未命中 `revoked` 时，再看 `cards[]` 中该卡密的 `exp`：未过期放行，过期拒绝
3. 生成器产出清单时，会先剔除与 `revoked` 冲突的条目，避免同一张卡同时出现在两处

### 离线凭证

首次在线激活时，客户端把**验签通过的清单 + 拉取时间戳**存入本地（`lmt_manifest_cache`）。断网时按缓存清单判定，但距最后一次成功联网不得超过 `CRED_TTL_DAYS`（默认 14 天）；超期需重新联网刷新。

## 三、发版与源码一致性

- **发版**：`powershell -ExecutionPolicy Bypass -File tools/release.ps1 -Notes "本次更新：……"`。脚本会升版本号、构建 release APK、生成 `update.json`、发 GitHub Release 并 purge 校验各来源（raw / GitHub Pages / jsDelivr）。
- **`cards.json` 的发版守卫**：发版脚本不持有私钥，无法重算 `sig2`，只做结构性校验（`ver == 2`、`rev` 与规范化串一致、`sig2` 形状合法），用于发现 rebase 把清单无声改坏的情况。真正的验签由客户端完成。**改动 `cards.json` 必须用卡密生成器（导入私钥后「生成清单」）重新签发**，否则客户端会拒绝。
- **双份源码守卫**：PWA 源码（`docs/<app>/index.html`）为权威，安卓副本（`android/<app>/src/main/assets/index.html`）由 `tools/web-sync.ps1 -Sync` 同步产生，**不手工改两侧**。`-Check` 校验共享核心一致，`-Audit` 检查漂移与 `@shell` 块结构，`-Bump` 依据 `index.html` 指纹自动升 `sw.js` 的缓存版本并写入 `@index-hash`。

## 四、测试

桌面无头浏览器交互测试，同一套用例对 PWA 副本与安卓 assets 副本各跑一遍：

```powershell
# PWA 副本
powershell -NoProfile -ExecutionPolicy Bypass -File tests/run.ps1 -TimeoutMs 300000

# 安卓 assets 副本
powershell -NoProfile -ExecutionPolicy Bypass -File tests/run.ps1 `
  -LayoutTarget ../../android/lmt-layout/src/main/assets/index.html `
  -CardgenTarget ../../android/lmt-cardgen/src/main/assets/index.html -TimeoutMs 300000
```

标题应为 `LMTTEST pass N/M`，要求失败数为 0；跳过项（安卓壳专属路径等）须逐条有原因。

## 五、部署到 GitHub Pages

见 [docs/README.md](docs/README.md)。
