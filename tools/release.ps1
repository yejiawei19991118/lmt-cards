# release.ps1 — 一键发版：升版本号 → 双份源码升版 → 构建 release APK → 生成更新清单 → 发 GitHub Release → 推送
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools/release.ps1 -Notes "本次更新：……"
#   powershell -ExecutionPolicy Bypass -File tools/release.ps1 -Version 1.2 -Notes "……"
#   powershell -ExecutionPolicy Bypass -File tools/release.ps1 -App lmt-layout -Notes "……"
#   powershell -ExecutionPolicy Bypass -File tools/release.ps1 -DryRun          # 只打印计划，不构建/不上传/不提交
#
# 说明：
#   · 版本号以仓库内 update.json 为准（App 端就是拿它与已装版本比较）：versionCode = 清单当前值 +1，
#     versionName 取 -Version（缺省则把清单当前版本名末位 +1）。
#     版本经 Gradle 属性注入构建；构建后把新版本回写 android/version.properties，使其与 update.json 始终一致。
#     否则本机直接 assembleRelease 会回退读到该文件里的旧版本号，产出的包 versionCode 低于设备上已装版本，
#     安装器直接拒绝（用户只看到「应用未安装」而不知原因）。
#   · 同一脚本在 GitHub Actions（tag apk-v* 触发，见 .github/workflows/release.yml）与本机均可运行：
#     本机工具链路径仅在存在时覆盖环境，构建命令按平台选 gradlew.bat / ./gradlew。
#   · APK 既是 GitHub Release 资产，也复制一份到 docs/apk/ 作为镜像源：主链（GitHub release）在国内网络
#     常不可达，App 会回退到 jsDelivr / GitHub Pages 上的这份镜像——故 APK 是有意进入 git 历史的。
#     同名文件每版原地覆盖，仓库只在首次入库时增长一次，不会逐版累积。
#   · 更新清单 lmt-cards/update.json 提交到仓库，并同步一份到 docs/update.json（GitHub Pages 承载）。
#     App 启动时并发读取 raw / Pages / jsDelivr 三个来源，取 versionCode 最大的一条，
#     避免任一来源的 CDN 缓存停留在旧版本时把新清单挡在后面。

param(
    [string]$Version = '',
    [string[]]$App = @('lmt-layout', 'lmt-cardgen'),
    [string]$Notes = '',
    [switch]$DryRun,
    # 与构建并入同一次 Gradle 调用跑单测：省掉一次 Gradle 冷启动（CI 上尤其明显）。
    [switch]$WithTests
)

$ErrorActionPreference = 'Stop'

# ===== 可配置常量 =====
# 更新包分发仓库（与 index.html 里的 MANIFEST_URL 保持同一仓库）。
$GitHubRepo = 'yejiawei19991118/lmt-cards'
# APK 镜像分发目录：放在仓库 docs/ 下，GitHub Pages 与 jsDelivr 读的是同一份文件。
$ApkMirrorDir = 'docs/apk'
# Pages 站点根地址（source = main 分支 /docs 目录）。
$PagesBase = 'https://yejiawei19991118.github.io/lmt-cards'
# 本机工具链位置（不在系统 PATH 中）；CI 上这些路径不存在，git/gh 已在 PATH 里、JAVA_HOME 由 setup-java 提供。
$JdkHome = 'C:\Users\Administrator\jdk\jdk-17.0.20.1+1'
$GitDir = 'C:\Users\Administrator\tools\git\cmd'
$GhDir = 'C:\Users\Administrator\tools\gh'
# cards.json 是卡密清单（新契约 ver=2，见 README.md 的「清单契约」）：由卡密生成器用「Ed25519 私钥」签发 sig2，
# 客户端只内置「公钥」LICENSE_PUBKEY 做验签——私钥不再下发到任何产物，发版脚本也不持有私钥，
# 因此这里无法（也无需）重算 sig2，只做结构性守卫：
#   · ver 必须为 2 —— 防 rebase 把旧契约清单无声合进来
#   · rev 必须等于规范化串的 sha256 前 16 hex —— 防 rebase 把清单内容改坏却不报冲突
#   · sig2 必须是合法形状（base32 字母表、103 字符）—— 防手工粘贴截断
# 真正的验签由客户端按内嵌公钥完成：签名对不上时客户端直接拒绝该清单。

$AllApps = @('lmt-layout', 'lmt-cardgen')
foreach ($a in $App) {
    if ($AllApps -notcontains $a) { throw "未知应用：$a（可选：$($AllApps -join ' / ')）" }
}

# ===== 路径与运行环境 =====
# 脚本位于 <工作区>/lmt-cards/tools/ 下；工作区根目录需同时包含 android/ 与 lmt-cards/ 两个同级目录。
# 自脚本目录向上逐级查找，因此脚本放在仓库内或仓库外都能正确定位。
$root = $PSScriptRoot
while ($root) {
    if ((Test-Path (Join-Path $root 'android')) -and (Test-Path (Join-Path $root 'lmt-cards'))) { break }
    $parent = Split-Path -Parent $root
    if (-not $parent -or $parent -eq $root) { $root = $null; break }
    $root = $parent
}
if (-not $root) { throw "无法定位工作区根目录：自 '$PSScriptRoot' 向上未找到同时包含 android/ 与 lmt-cards/ 的目录。" }
$androidDir = Join-Path $root 'android'
$repoDir = Join-Path $root 'lmt-cards'
$verFile = Join-Path $androidDir 'version.properties'
$updateFile = Join-Path $repoDir 'update.json'

# 仅在本机路径存在时才覆盖环境：CI 上 git/gh 已在 PATH 中，JAVA_HOME 由 actions/setup-java 提供。
if (Test-Path $JdkHome) { $env:JAVA_HOME = $JdkHome }
foreach ($d in @($GhDir, $GitDir)) {
    if (Test-Path $d) { $env:Path = "$d;" + $env:Path }
}

function Write-Step([string]$msg) { Write-Host "`n=== $msg" -ForegroundColor Cyan }
function Write-Info([string]$msg) { Write-Host "    $msg" }

# git / gh / gradlew 这类原生命令会把正常信息写进 stderr，
# 在 $ErrorActionPreference='Stop' 下会被 PowerShell 5.1 误判为终止错误，故统一走这两个包装。
function Invoke-Native {
    param([scriptblock]$Command, [string]$ErrorMessage)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Command
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    if ($code -ne 0) { throw $ErrorMessage }
}

function Get-NativeOutput {
    param([scriptblock]$Command)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { return (& $Command) } finally { $ErrorActionPreference = $prev }
}

# 取 version.properties 中某个键的当前值
$verText = [System.IO.File]::ReadAllText($verFile)
function Get-Ver([string]$key) {
    $m = [regex]::Match($verText, "(?m)^$([regex]::Escape($key))=(.*)$")
    if ($m.Success) { return $m.Groups[1].Value.Trim() }
    return ''
}

# JSON 字符串转义（PowerShell 5.1 的 ConvertTo-Json 会把中文转成 \uXXXX，这里手写以保持清单可读）
function ConvertTo-JsonString([string]$s) {
    if ($null -eq $s) { return '""' }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($ch in $s.ToCharArray()) {
        switch ($ch) {
            '"' { [void]$sb.Append('\"') }
            '\' { [void]$sb.Append('\\') }
            "`n" { [void]$sb.Append('\n') }
            "`r" { [void]$sb.Append('\r') }
            "`t" { [void]$sb.Append('\t') }
            default {
                if ([int]$ch -lt 32) { [void]$sb.Append(('\u{0:x4}' -f [int]$ch)) }
                else { [void]$sb.Append($ch) }
            }
        }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

# 归一化：转大写并剔除 [^0-9A-Z]，与 index.html 的 normalize 完全一致
function Get-Normalized([string]$code) {
    return (([string]$code) -replace '[^0-9A-Za-z]', '').ToUpper()
}

# JSON 原文里某字段名对应的字符串字面量，按出现顺序返回。用途见 Resolve-JsonString。
function Get-JsonStringLiterals([string]$raw, [string]$field) {
    $rx = '"' + [regex]::Escape($field) + '"\s*:\s*"([^"]*)"'
    return @([regex]::Matches($raw, $rx) | ForEach-Object { $_.Groups[1].Value })
}

# 取参与签名的字符串值：pwsh 7 的 ConvertFrom-Json 会把「整体呈 ISO8601 形状」的字符串自动转成
# [DateTime]（PS 5.1 不会），插值后变成 10/15/2026 18:04:25 这类随时区/区域设置而变的本地化文本，
# 于是本机与 CI 对同一份 cards.json 重算出不同的 rev，CI 上直接报「内容指纹不符」卡住发版。
# 故解析结果一旦是 DateTime（说明原文是纯 ISO8601），就改回 JSON 原文里的字面量——这类字符串不含
# 需要反转义的字符，字面量即签名时用的原值。updated 与 cardgen 写出的 YYYY-MM-DD 都会命中。
function Resolve-JsonString($value, [string]$literal) {
    if ($value -is [datetime]) { return $literal }
    return [string]$value
}

# 重算 cards.json 的内容指纹 rev，口径与卡密生成器 / 客户端（lmt-layout 的 manifestRevSource）逐字一致：
#   revSource = ver "\n" updated "\n" cards 按 (mc,card) 升序逐行 "{card}|{mc}|{note}|{exp}" 用 "\n" 连接 "\n" revoked 升序 join(",")
#   rev       = sha256Hex(revSource) 的前 16 位 hex
# card / mc 归一化（转大写剔除 [^0-9A-Z]），note / exp 去首尾空白后原样参与。
function Get-CardsRev([string]$cardsJsonPath) {
    $raw = [System.IO.File]::ReadAllText($cardsJsonPath)
    $j = $raw | ConvertFrom-Json
    # updated / note / exp 这三个字符串不直接取 ConvertFrom-Json 的结果：pwsh 7 会把 ISO8601 形状的值
    # 转成 [DateTime]（PS 5.1 不会），插值后随区域设置与时区变形（如 10/15/2026 18:04:25），
    # 于是本机与 CI 对同一份 cards.json 算出不同的 rev。改从 JSON 原文按字面量取（见 Resolve-JsonString）。
    # 生成器用 JSON.stringify(obj, null, 2) 输出，cards 数组内每个元素的字段顺序与数组顺序都是固定的，
    # 因此按出现顺序取到的字面量与 cards 逐项对应。
    $updatedLits = @(Get-JsonStringLiterals $raw 'updated')
    $noteLits = @(Get-JsonStringLiterals $raw 'note')
    $expLits = @(Get-JsonStringLiterals $raw 'exp')
    $cardsArr = @($j.cards)
    $nul = [char]0
    $soh = [char]1
    # 排序键必须与 JS 的 mc + "\u0000" + card 一致，且比较必须走序号（Ordinal）而非区域性规则，否则与 JS 的 < 比较结果不同。
    # 键与行用 \u0001 拼在一起排序，排序后再截出行，避免用两个平行数组。
    $combined = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $cardsArr.Count; $i++) {
        $e = $cardsArr[$i]
        $mc = Get-Normalized $e.mc
        $card = Get-Normalized $e.card
        $noteLit = ''
        if ($i -lt $noteLits.Count) { $noteLit = $noteLits[$i] }
        $expLit = ''
        if ($i -lt $expLits.Count) { $expLit = $expLits[$i] }
        $note = (Resolve-JsonString $e.note $noteLit).Trim()
        $exp = (Resolve-JsonString $e.exp $expLit).Trim()
        $combined.Add("$mc$nul$card$soh$card|$mc|$note|$exp")
    }
    $arr = $combined.ToArray()
    [System.Array]::Sort($arr, [System.StringComparer]::Ordinal)
    $cards = (($arr | ForEach-Object { $_.Substring($_.IndexOf($soh) + 1) }) -join "`n")
    $revokedArr = @($j.revoked | ForEach-Object { Get-Normalized $_ } | Select-Object -Unique)
    if ($revokedArr.Count -gt 0) {
        $revokedArr = [string[]]$revokedArr
        [System.Array]::Sort($revokedArr, [System.StringComparer]::Ordinal)
    }
    $revoked = ($revokedArr -join ',')
    $updatedLit = ''
    if ($updatedLits.Count -gt 0) { $updatedLit = $updatedLits[0] }
    $updated = Resolve-JsonString $j.updated $updatedLit
    $revSource = "$([int]$j.ver)`n$updated`n$cards`n$revoked"
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($revSource))
    return (-join ($hash | ForEach-Object { $_.ToString('x2') })).Substring(0, 16)
}

# sig2 形状校验：base32 编码 64 字节签名 → 103 字符；字母表 0123456789ABCDEFGHJKMNPQRSTVWXYZ（不含 I/L/O/U）
function Test-Sig2Shape([string]$sig) {
    return ($sig -match '^[0-9A-HJKMNP-TV-Z]{103}$')
}

function Get-ApkPath([string]$app) {
    return (Join-Path $androidDir "$app\build\outputs\apk\release\$app-release.apk")
}

# ===== 1/7 计算目标版本号 =====
Write-Step "1/7 计算目标版本号"
# 版本以 update.json 为准：App 端就是拿清单里的 versionCode 与已装版本比较，故清单当前值 +1 必为单调递增。
$curVersionName = ''
$curCodes = @{}
if (Test-Path $updateFile) {
    try {
        $oldManifest = [System.IO.File]::ReadAllText($updateFile) | ConvertFrom-Json
        foreach ($a in $AllApps) {
            $entry = $oldManifest.apps.$a
            if ($null -ne $entry) { $curCodes[$a] = [int]$entry.versionCode }
        }
        $curVersionName = [string]$oldManifest.apps.($App[0]).versionName
    } catch {
        Write-Info "旧 update.json 解析失败，将回退到 android/version.properties"
    }
}
if (-not $Version) {
    if (-not $curVersionName) { $curVersionName = Get-Ver ($App[0] + '.versionName') }
    $parts = $curVersionName -split '\.'
    $last = [int]$parts[$parts.Length - 1]
    $parts[$parts.Length - 1] = [string]($last + 1)
    $Version = ($parts -join '.')
}
if (-not $Notes) { $Notes = "版本 $Version" }
$newCodes = @{}
foreach ($a in $App) {
    $baseCode = $curCodes[$a]
    if ($null -eq $baseCode) { $baseCode = [int](Get-Ver ($a + '.versionCode')) }
    $newCodes[$a] = [int]$baseCode + 1
    Write-Info "$a ：$curVersionName（code $baseCode） → $Version（code $($newCodes[$a])）"
}
# Gradle 的版本属性是全局的（-PlmtVersionCode 对所有模块生效），故各应用的新 versionCode 必须一致
$distinctCodes = @($newCodes.Values | Sort-Object -Unique)
if ($distinctCodes.Count -gt 1) {
    $detail = ($newCodes.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join '，'
    throw "本次发版各应用的 versionCode 不一致（$detail）：Gradle 版本属性为全局，请把两个应用一起发版。"
}
$newCode = [int]$distinctCodes[0]
$tag = "apk-v$Version"
Write-Info "Release tag：$tag"

# 回写 android/version.properties：与 update.json 保持单一事实来源（本机/离线 assembleRelease 会回退读它）。
# 两个应用共用同一份 versionCode/versionName（Gradle 版本属性是全局的），故统一写入。
if ($DryRun) {
    Write-Info "[DryRun] 跳过回写 $verFile"
} else {
    $verBuilder = New-Object System.Text.StringBuilder
    [void]$verBuilder.AppendLine('# 版本号集中配置：两个应用各自的 versionCode / versionName 只需在此维护。')
    [void]$verBuilder.AppendLine('# 与 lmt-cards/update.json 保持同步（两者是同一份事实）：发版脚本 tools/release.ps1 在构建时')
    [void]$verBuilder.AppendLine('# 以 update.json 的 versionCode +1 为准，并把新版本回写到这里，避免本机直接 assembleRelease')
    [void]$verBuilder.AppendLine('# 时回退读到旧版本号、产出的包 versionCode 低于设备上已装版本而装不上。')
    [void]$verBuilder.AppendLine('# CI 发版仍按 -PlmtVersionCode / -PlmtVersionName 注入（优先级高于本文件）。')
    foreach ($a in $AllApps) {
        [void]$verBuilder.AppendLine("$a.versionCode=$newCode")
        [void]$verBuilder.AppendLine("$a.versionName=$Version")
    }
    [System.IO.File]::WriteAllText($verFile, $verBuilder.ToString(), (New-Object System.Text.UTF8Encoding($false)))
    Write-Info "已回写 version.properties（两个应用 → $Version / code $newCode）"
}

# ===== 2/7 双份源码升版（sw.js 的 CACHE 版本 + @index-hash） =====
Write-Step "2/7 双份源码一致性 / SW 升版"
if ($DryRun) {
    Write-Info "[DryRun] 跳过 tools/web-sync.ps1 -Bump"
} else {
    $webSync = Join-Path $PSScriptRoot 'web-sync.ps1'
    # Windows 用自带的 powershell 5.1；CI（Linux）只有 pwsh，且不支持 -ExecutionPolicy
    if ($env:OS -eq 'Windows_NT') {
        $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $webSync, '-Bump')
        Invoke-Native { & powershell @psArgs } "web-sync.ps1 -Bump 执行失败"
    } else {
        $psArgs = @('-NoProfile', '-File', $webSync, '-Bump')
        Invoke-Native { & pwsh @psArgs } "web-sync.ps1 -Bump 执行失败"
    }
}

# ===== 3/7 构建 release APK =====
Write-Step "3/7 构建 release APK"
$gradleTasks = @()
# 单测与构建并入同一次 Gradle 调用（-WithTests）：省掉一次 Gradle 冷启动，也避免 CI 里
# 「先 ./gradlew test 再 assembleRelease」那种重复的配置阶段开销。
if ($WithTests) { $gradleTasks += 'test' }
foreach ($a in $App) { $gradleTasks += ":$a`:assembleRelease" }
if ($DryRun) {
    Write-Info "[DryRun] 跳过 gradle $($gradleTasks -join ' ') -PlmtVersionCode=$newCode -PlmtVersionName=$Version"
} else {
    # 本机是 Windows 批处理；CI（Linux）用无扩展名的 gradlew，且需要可执行位
    if ($env:OS -eq 'Windows_NT') { $gradlew = Join-Path $androidDir 'gradlew.bat' } else { $gradlew = Join-Path $androidDir 'gradlew' }
    Push-Location $androidDir
    try {
        # 用数组展开传参：Gradle 需要每个任务各占一个参数；版本按本次发版经 -P 注入（优先级高于已回写的 version.properties）
        Invoke-Native { & $gradlew @gradleTasks --console=plain "-PlmtVersionCode=$newCode" "-PlmtVersionName=$Version" } "Gradle 构建失败"
    } finally {
        Pop-Location
    }
}

# ===== 4/7 计算 APK 摘要 =====
Write-Step "4/7 计算 APK SHA-256"
$entries = @{}
foreach ($a in $App) {
    $apk = Get-ApkPath $a
    if (Test-Path $apk) {
        $entries[$a] = @{
            sha256 = (Get-FileHash -Path $apk -Algorithm SHA256).Hash.ToLower()
            size   = (Get-Item $apk).Length
        }
        Write-Info "$a ：$($entries[$a].size) 字节  $($entries[$a].sha256)"
    } elseif ($DryRun) {
        $entries[$a] = @{ sha256 = '<构建后计算>'; size = 0 }
        Write-Info "$a ：[DryRun] APK 尚未构建"
    } else {
        throw "未找到构建产物：$apk"
    }
}

# ===== 5/7 生成 update.json 与 APK 镜像 =====
Write-Step "5/7 生成 update.json 与 APK 镜像"
$apps = [ordered]@{}
# 未被本次发版覆盖的应用，保留清单里的原有条目
if (Test-Path $updateFile) {
    try {
        $old = [System.IO.File]::ReadAllText($updateFile) | ConvertFrom-Json
        foreach ($p in $old.apps.PSObject.Properties) { $apps[$p.Name] = $p.Value }
    } catch {
        Write-Info "旧清单解析失败，将整体重建"
    }
}
foreach ($a in $App) {
    $apps[$a] = [ordered]@{
        versionCode = $newCodes[$a]
        versionName = $Version
        url         = "https://github.com/$GitHubRepo/releases/download/$tag/$a-release.apk"
        # 主链（GitHub release）在国内网络常不可达，App 会按顺序探测这些镜像并回退。
        # 镜像文件名固定、每版原地覆盖，CDN 缓存可能拿着旧字节；带 ?v=<versionCode> 后每次发版都是新 URL，
        # 从根上避免「新 versionCode 配旧字节」导致 App 侧 sha256 校验失败、报「下载失败」。
        mirrors     = @(
            "https://cdn.jsdelivr.net/gh/$GitHubRepo@main/$ApkMirrorDir/$a-release.apk?v=$($newCodes[$a])"
            "$PagesBase/apk/$a-release.apk?v=$($newCodes[$a])"
        )
        sha256      = $entries[$a].sha256
        size        = $entries[$a].size
        notes       = $Notes
    }
}

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('{')
[void]$sb.AppendLine('  "updated": ' + (ConvertTo-JsonString (Get-Date -Format 'yyyy-MM-dd')) + ',')
[void]$sb.AppendLine('  "apps": {')
$keys = @($apps.Keys)
for ($i = 0; $i -lt $keys.Count; $i++) {
    $k = $keys[$i]
    $e = $apps[$k]
    [void]$sb.AppendLine('    ' + (ConvertTo-JsonString $k) + ': {')
    [void]$sb.AppendLine('      "versionCode": ' + [string]$e.versionCode + ',')
    [void]$sb.AppendLine('      "versionName": ' + (ConvertTo-JsonString ([string]$e.versionName)) + ',')
    [void]$sb.AppendLine('      "url": ' + (ConvertTo-JsonString ([string]$e.url)) + ',')
    $mirrors = @($e.mirrors | Where-Object { $_ })
    if ($mirrors.Count -gt 0) {
        $quoted = ($mirrors | ForEach-Object { ConvertTo-JsonString ([string]$_) }) -join ', '
        [void]$sb.AppendLine('      "mirrors": [' + $quoted + '],')
    }
    [void]$sb.AppendLine('      "sha256": ' + (ConvertTo-JsonString ([string]$e.sha256)) + ',')
    [void]$sb.AppendLine('      "size": ' + [string]$e.size + ',')
    [void]$sb.AppendLine('      "notes": ' + (ConvertTo-JsonString ([string]$e.notes)))
    $tail = if ($i -lt $keys.Count - 1) { '    },' } else { '    }' }
    [void]$sb.AppendLine($tail)
}
[void]$sb.AppendLine('  }')
[void]$sb.AppendLine('}')
$updateText = $sb.ToString()

if ($DryRun) {
    Write-Info "[DryRun] 将写入 $updateFile ："
    Write-Host $updateText
} else {
    [System.IO.File]::WriteAllText($updateFile, $updateText, (New-Object System.Text.UTF8Encoding($false)))
    $null = [System.IO.File]::ReadAllText($updateFile) | ConvertFrom-Json  # 合法性自检
    Write-Info "已写入并校验 $updateFile"

    # Pages（docs/）同步一份：GitHub Pages 的缓存远短于 raw 的边缘缓存与 jsDelivr 的 12 小时缓存，
    # App 把它列为最可靠的清单来源之一，发版后能第一时间读到新版本。
    $pagesUpdateFile = Join-Path $repoDir 'docs\update.json'
    [System.IO.File]::WriteAllText($pagesUpdateFile, $updateText, (New-Object System.Text.UTF8Encoding($false)))
    Write-Info "已同步写入 docs/update.json（供 GitHub Pages 承载）"

    # 把本次构建的安装包放进 docs/apk/：主链被墙时 App 会回退到这份镜像（同名文件直接覆盖，仓库不会持续膨胀）
    $mirrorRoot = Join-Path $repoDir $ApkMirrorDir
    if (-not (Test-Path $mirrorRoot)) { $null = New-Item -ItemType Directory -Force -Path $mirrorRoot }
    foreach ($a in $App) {
        $dst = Join-Path $mirrorRoot "$a-release.apk"
        Copy-Item -Path (Get-ApkPath $a) -Destination $dst -Force
        Write-Info "镜像已更新：$ApkMirrorDir/$a-release.apk（$((Get-Item $dst).Length) 字节）"
    }

    # ===== 产物一致性断言（发版产物 = 清单登记值） =====
    # 刻意做成「把刚写下的文件读回来再独立重算」，而不是复用上面的 $entries / $updateText：
    # 复用内存变量只能证明「脚本自己算的和自己写的一致」，写盘出错、镜像没跟着更新、两份清单不同步都漏检。
    # App 端下载后会拿清单里的 sha256 校验整包，登记值与真实字节一旦不符，用户侧只看到「下载校验失败」而无从排查。
    $writtenUpdate = [System.IO.File]::ReadAllText($updateFile) | ConvertFrom-Json
    if ([System.IO.File]::ReadAllText($pagesUpdateFile) -ne $updateText) {
        throw "docs/update.json 与 update.json 内容不一致：Pages 承载的那份不是本次发版写入的内容。"
    }
    foreach ($a in $App) {
        $built = Get-ApkPath $a
        if (-not (Test-Path $built)) { throw "未找到构建产物：$built" }
        $builtSize = (Get-Item $built).Length
        $builtSha = (Get-FileHash -Path $built -Algorithm SHA256).Hash.ToLower()
        $entry = $writtenUpdate.apps.$a
        if ([string]$entry.sha256 -ne $builtSha) {
            throw "update.json 登记的 sha256 与构建产物不符：$a 登记 $($entry.sha256)，实际 $builtSha。"
        }
        if ([int]$entry.size -ne $builtSize) {
            throw "update.json 登记的 size 与构建产物不符：$a 登记 $($entry.size)，实际 $builtSize。"
        }
        if ([string]$entry.versionCode -ne [string]$newCodes[$a] -or [string]$entry.versionName -ne $Version) {
            throw "update.json 的版本号与本次发版不符：$a 登记 $($entry.versionName)/$($entry.versionCode)，本次 $Version/$($newCodes[$a])。"
        }
        if ([string]$entry.url -notlike "*/$tag/$a-release.apk") {
            throw "update.json 的下载地址与本次 tag（$tag）不符：$a → $($entry.url)"
        }
        $mirror = Join-Path $mirrorRoot "$a-release.apk"
        if (-not (Test-Path $mirror)) { throw "缺少 APK 镜像：$mirror" }
        $mirrorSize = (Get-Item $mirror).Length
        $mirrorSha = (Get-FileHash -Path $mirror -Algorithm SHA256).Hash.ToLower()
        # 镜像必须与 Release 资产是同一份字节：主链被墙时 App 会回退到镜像，两者不一致会出现「同一个版本、两种结果」。
        if ($mirrorSha -ne $builtSha -or $mirrorSize -ne $builtSize) {
            throw "APK 镜像与构建产物不是同一份字节：$a（镜像 $mirrorSize/$mirrorSha，产物 $builtSize/$builtSha）"
        }
        Write-Info "产物断言通过：$a  $builtSize 字节  $builtSha"
    }
    # version.properties 必须与清单同版本：否则本机/离线 assembleRelease 会产出 versionCode 低于设备已装版本的包，
    # 安装器直接拒绝，用户只看到「应用未安装」而不知道原因。
    $verTextAfter = [System.IO.File]::ReadAllText($verFile)
    foreach ($a in $AllApps) {
        $mCode = [regex]::Match($verTextAfter, "(?m)^$([regex]::Escape($a))\.versionCode=(.*)$")
        $mName = [regex]::Match($verTextAfter, "(?m)^$([regex]::Escape($a))\.versionName=(.*)$")
        if (-not $mCode.Success -or $mCode.Groups[1].Value.Trim() -ne [string]$newCode -or
            -not $mName.Success -or $mName.Groups[1].Value.Trim() -ne $Version) {
            throw "version.properties 与本次发版不一致：$a 应为 $Version/code $newCode，实际 $($mName.Groups[1].Value.Trim())/$($mCode.Groups[1].Value.Trim())"
        }
    }
    Write-Info "产物断言全部通过（update.json / docs/update.json / APK 镜像 / version.properties 四方一致）"
}

# ===== 6/7 发布 GitHub Release =====
Write-Step "6/7 发布 GitHub Release（$tag）"
if ($DryRun) {
    Write-Info "[DryRun] 跳过 gh release create / upload"
} else {
    $assets = @()
    foreach ($a in $App) { $assets += (Get-ApkPath $a) }

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & gh release view $tag --repo $GitHubRepo *> $null
        $releaseExists = ($LASTEXITCODE -eq 0)
    } finally {
        $ErrorActionPreference = $prevEap
    }

    if ($releaseExists) {
        Write-Info "Release 已存在，改用 --clobber 覆盖上传"
        Invoke-Native { & gh release upload $tag --repo $GitHubRepo --clobber @assets } "gh release upload 失败"
    } else {
        Invoke-Native { & gh release create $tag --repo $GitHubRepo --title "APK v$Version" --notes $Notes @assets } "gh release create 失败"
    }
    Write-Info "https://github.com/$GitHubRepo/releases/tag/$tag"
}

# ===== 7/7 提交并推送 =====
Write-Step "7/7 提交并推送"
if ($DryRun) {
    Write-Info "[DryRun] 跳过 git add/commit/pull/push"
    Write-Host "`nDryRun 完成：未改动任何文件、未构建、未上传、未提交。" -ForegroundColor Yellow
    return
}

Push-Location $repoDir
try {
    # CI 的 checkout 不带提交身份，缺失时补上；本机已有全局配置则保持原样
    if (-not (Get-NativeOutput { & git config user.email })) {
        Invoke-Native { & git config user.email 'lmt-release-bot@users.noreply.github.com' } "git config user.email 失败"
    }
    if (-not (Get-NativeOutput { & git config user.name })) {
        Invoke-Native { & git config user.name 'lmt-release-bot' } "git config user.name 失败"
    }
    Invoke-Native { & git add update.json } "git add 失败"
    # 若 web-sync 顺手升了 SW 版本号，一并提交
    $docsDirty = Get-NativeOutput { & git status --porcelain -- docs }
    if ($docsDirty) { Invoke-Native { & git add docs } "git add docs 失败" }

    $staged = Get-NativeOutput { & git diff --cached --name-only }
    if (-not $staged) {
        Write-Info "没有需要提交的改动"
    } else {
        if ($staged -match 'cards\.json') { throw "本次提交不应包含 cards.json（更新清单只动 update.json）" }
        Invoke-Native { & git commit -m "chore(release): APK v$Version（update.json + SW 版本号）" } "git commit 失败"
    }

    # 先 rebase 再推送；rebase 可能把远端 cards.json 改动与本地改动无声合并成「内容变了但没重签」的坏清单，故推送前必须核对。
    Invoke-Native { & git pull --rebase --autostash } "git pull --rebase 失败，请手动处理后重试"

    $cardsPath = Join-Path $repoDir 'cards.json'
    $cardsObj = [System.IO.File]::ReadAllText($cardsPath) | ConvertFrom-Json
    if ([int]$cardsObj.ver -ne 2) {
        throw "cards.json 不是 ver=2 的新契约清单（实际 ver=$($cardsObj.ver)）：rebase 可能把旧契约清单合了进来，请用卡密生成器导入私钥后重新「生成清单」。"
    }
    $calcRev = Get-CardsRev $cardsPath
    if ($calcRev -ne [string]$cardsObj.rev) {
        throw "cards.json 内容指纹不符：文件 rev=$($cardsObj.rev)，重算=$calcRev。rebase 可能引入了未经重签的改动，请用卡密生成器重新生成清单后重试。"
    }
    if (-not (Test-Sig2Shape ([string]$cardsObj.sig2))) {
        throw "cards.json 的 sig2 形状非法（应为 103 字符 base32）：rebase 可能截断了签名，请用卡密生成器重新生成清单后重试。"
    }
    Write-Info "cards.json 结构校验通过（ver=2，rev=$calcRev，sig2 形状合法）"

    Invoke-Native { & git push origin main } "git push 失败"
    Write-Info "已推送"
} finally {
    Pop-Location
}

# ===== 刷新 jsDelivr 缓存并校验各来源清单新鲜度 =====
Write-Step "刷新 jsDelivr 并校验各来源清单"
# jsDelivr 对 @main 这类分支引用有约 12 小时缓存；不主动清理，备源会长时间停在旧清单/旧安装包上，
# 表现为「弹窗提示有新版本，却下载不到新包」。必须在 push 之后刷新——purge 会让 jsDelivr 重新回源。
# cards.json 是卡密清单的 jsDelivr 备源，改动后同样是同款 12 小时缓存问题，一并刷新。
# 只 purge 不校验会出现「以为刷新了、源上其实还是旧清单」：raw 的边缘缓存与 jsDelivr 的回源时机都可能错位，
# 之前就出现过 purge 反而把旧内容固化进 12 小时缓存的情况。故这里逐轮重试，直到各来源都能读到本次的 versionCode。
$purgeTargets = @(
    "https://purge.jsdelivr.net/gh/$GitHubRepo@main/update.json"
    "https://purge.jsdelivr.net/gh/$GitHubRepo@main/cards.json"
)
foreach ($a in $App) {
    $purgeTargets += "https://purge.jsdelivr.net/gh/$GitHubRepo@main/$ApkMirrorDir/$a-release.apk"
}
$manifestSources = @(
    "https://raw.githubusercontent.com/$GitHubRepo/refs/heads/main/update.json"
    "$PagesBase/update.json"
    "https://cdn.jsdelivr.net/gh/$GitHubRepo@main/update.json"
)

# PowerShell 5.1 默认可能不带 TLS 1.2，直接访问 https 会失败
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Get-ManifestVersionCode([string]$url) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $r = Invoke-WebRequest -Uri $url -TimeoutSec 20 -UseBasicParsing
        return [regex]::Match($r.Content, '"versionCode"\s*:\s*(\d+)').Groups[1].Value
    } catch {
        return ''
    } finally {
        $ErrorActionPreference = $prev
    }
}

$maxAttempts = 3
$missing = @()
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    foreach ($u in $purgeTargets) {
        try {
            $r = Invoke-RestMethod -Uri $u -TimeoutSec 30
            Write-Info "已刷新（$($r.status)）：$u"
        } catch {
            Write-Info "刷新失败（不影响发版，缓存会在 12 小时内自行过期）：$u"
        }
    }
    Start-Sleep -Seconds 20
    $missing = @($manifestSources | Where-Object { (Get-ManifestVersionCode $_) -ne [string]$newCode })
    if ($missing.Count -eq 0) {
        Write-Info "各来源清单均已生效（v$Version / code$newCode）"
        break
    }
    Write-Info "第 $attempt/$maxAttempts 轮仍有来源未生效：$($missing -join '，')"
    if ($attempt -lt $maxAttempts) { Start-Sleep -Seconds 45 }
}
if ($missing.Count -gt 0) {
    Write-Info "警告：以下来源在 $maxAttempts 轮后仍未读到 code$newCode，用户可能短时间内提示不到本版本：$($missing -join '，')"
}

Write-Host "`n发版完成：APK v$Version" -ForegroundColor Green
Write-Info "Release：https://github.com/$GitHubRepo/releases/tag/$tag"
Write-Info "清单（主源）：https://raw.githubusercontent.com/$GitHubRepo/refs/heads/main/update.json"
Write-Info "清单（备源）：https://cdn.jsdelivr.net/gh/$GitHubRepo@main/update.json"