# release.ps1 — 一键发版：升版本号 → 双份源码升版 → 构建 release APK → 生成更新清单 → 发 GitHub Release → 推送
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools/release.ps1 -Notes "本次更新：……"
#   powershell -ExecutionPolicy Bypass -File tools/release.ps1 -Version 1.2 -Notes "……"
#   powershell -ExecutionPolicy Bypass -File tools/release.ps1 -App lmt-layout -Notes "……"
#   powershell -ExecutionPolicy Bypass -File tools/release.ps1 -DryRun          # 只打印计划，不构建/不上传/不提交
#
# 说明：
#   · 版本号集中在 android/version.properties 维护；脚本把参与发版的应用 versionCode +1，
#     versionName 取 -Version（缺省则把当前版本号末位 +1）。
#   · APK 作为 GitHub Release 资产上传，不写入 git 历史，避免仓库膨胀。
#   · 更新清单 lmt-cards/update.json 提交到仓库，App 启动时通过 raw 主源 + jsDelivr 备源读取。

param(
    [string]$Version = '',
    [string[]]$App = @('lmt-layout', 'lmt-cardgen'),
    [string]$Notes = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# ===== 可配置常量 =====
# 更新包分发仓库（与 index.html 里的 MANIFEST_URL 保持同一仓库）。
$GitHubRepo = 'yejiawei19991118/lmt-cards'
# APK 镜像分发目录：放在仓库 docs/ 下，GitHub Pages 与 jsDelivr 读的是同一份文件。
$ApkMirrorDir = 'docs/apk'
# Pages 站点根地址（source = main 分支 /docs 目录）。
$PagesBase = 'https://yejiawei19991118.github.io/lmt-cards'
# 本机工具链位置（不在系统 PATH 中，脚本内自行拼接）。
$JdkHome = 'C:\Users\Administrator\jdk\jdk-17.0.20.1+1'
$GitDir = 'C:\Users\Administrator\tools\git\cmd'
$GhDir = 'C:\Users\Administrator\tools\gh'
# cards.json 的签名密钥（须与 index.html / 卡密生成器里的 LICENSE_SECRET 一致），仅用于发版后校验签名未被 rebase 破坏。
$LicenseSecret = 'aca0d140848ed9718184e7341d3c6ed7ff68283b50574258'

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

$env:JAVA_HOME = $JdkHome
$env:Path = "$GhDir;$GitDir;" + $env:Path

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

# 按 index.html / 卡密生成器里的同一算法重算 cards.json 的签名
function Get-CardsSignature([string]$cardsJsonPath) {
    $j = [System.IO.File]::ReadAllText($cardsJsonPath) | ConvertFrom-Json
    $cards = (($j.cards | ForEach-Object { Get-Normalized $_ }) -join ',')
    $revoked = (($j.revoked | ForEach-Object { Get-Normalized $_ }) -join ',')
    $payload = "$($j.updated)`n$cards`n$revoked"
    $hmac = New-Object System.Security.Cryptography.HMACSHA256
    $hmac.Key = [System.Text.Encoding]::UTF8.GetBytes($LicenseSecret)
    $hash = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($payload))
    return (-join ($hash | ForEach-Object { $_.ToString('x2') }))
}

function Get-ApkPath([string]$app) {
    return (Join-Path $androidDir "$app\build\outputs\apk\release\$app-release.apk")
}

# ===== 1. 计算目标版本号 =====
Write-Step "1/8 计算目标版本号"
$curName = Get-Ver ($App[0] + '.versionName')
if (-not $Version) {
    $parts = $curName -split '\.'
    $last = [int]$parts[$parts.Length - 1]
    $parts[$parts.Length - 1] = [string]($last + 1)
    $Version = ($parts -join '.')
}
if (-not $Notes) { $Notes = "版本 $Version" }
$newCodes = @{}
foreach ($a in $App) {
    $newCodes[$a] = [int](Get-Ver ($a + '.versionCode')) + 1
    Write-Info "$a ：$curName（code $(Get-Ver ($a + '.versionCode'))） → $Version（code $($newCodes[$a])）"
}
$tag = "apk-v$Version"
Write-Info "Release tag：$tag"

# ===== 2. 写回 version.properties =====
Write-Step "2/8 写入版本号"
if ($DryRun) {
    Write-Info "[DryRun] 跳过写回 $verFile"
} else {
    $newText = $verText
    foreach ($a in $App) {
        $newText = [regex]::Replace($newText, "(?m)^$([regex]::Escape($a))\.versionCode=.*$", "${a}.versionCode=$($newCodes[$a])")
        $newText = [regex]::Replace($newText, "(?m)^$([regex]::Escape($a))\.versionName=.*$", "${a}.versionName=$Version")
    }
    [System.IO.File]::WriteAllText($verFile, $newText, (New-Object System.Text.UTF8Encoding($false)))
    Write-Info "已更新 $verFile"
}

# ===== 3. 双份源码升版（sw.js 的 CACHE 版本 + @index-hash） =====
Write-Step "3/8 双份源码一致性 / SW 升版"
if ($DryRun) {
    Write-Info "[DryRun] 跳过 tools/web-sync.ps1 -Bump"
} else {
    $webSync = Join-Path $PSScriptRoot 'web-sync.ps1'
    Invoke-Native { & powershell -NoProfile -ExecutionPolicy Bypass -File $webSync -Bump } "web-sync.ps1 -Bump 执行失败"
}

# ===== 4. 构建 release APK =====
Write-Step "4/8 构建 release APK"
$gradleTasks = @()
foreach ($a in $App) { $gradleTasks += ":$a`:assembleRelease" }
if ($DryRun) {
    Write-Info "[DryRun] 跳过 gradlew.bat $($gradleTasks -join ' ')"
} else {
    Push-Location $androidDir
    try {
        # 用数组展开传参：Gradle 需要每个任务各占一个参数
        Invoke-Native { & .\gradlew.bat @gradleTasks --console=plain } "Gradle 构建失败"
    } finally {
        Pop-Location
    }
}

# ===== 5. 计算 APK 摘要 =====
Write-Step "5/8 计算 APK SHA-256"
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

# ===== 6. 生成 update.json 与 APK 镜像 =====
Write-Step "6/8 生成 update.json 与 APK 镜像"
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
        # 主链（GitHub release）在国内网络常不可达，App 会按顺序探测这些镜像并回退
        mirrors     = @(
            "https://cdn.jsdelivr.net/gh/$GitHubRepo@main/$ApkMirrorDir/$a-release.apk"
            "$PagesBase/apk/$a-release.apk"
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

    # 把本次构建的安装包放进 docs/apk/：主链被墙时 App 会回退到这份镜像（同名文件直接覆盖，仓库不会持续膨胀）
    $mirrorRoot = Join-Path $repoDir $ApkMirrorDir
    if (-not (Test-Path $mirrorRoot)) { $null = New-Item -ItemType Directory -Force -Path $mirrorRoot }
    foreach ($a in $App) {
        $dst = Join-Path $mirrorRoot "$a-release.apk"
        Copy-Item -Path (Get-ApkPath $a) -Destination $dst -Force
        Write-Info "镜像已更新：$ApkMirrorDir/$a-release.apk（$((Get-Item $dst).Length) 字节）"
    }
}

# ===== 7. 发布 GitHub Release =====
Write-Step "7/8 发布 GitHub Release（$tag）"
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

# ===== 8. 提交并推送 =====
Write-Step "8/8 提交并推送"
if ($DryRun) {
    Write-Info "[DryRun] 跳过 git add/commit/pull/push"
    Write-Host "`nDryRun 完成：未改动任何文件、未构建、未上传、未提交。" -ForegroundColor Yellow
    return
}

Push-Location $repoDir
try {
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

    # 先 rebase 再推送；rebase 可能把远端 cards.json 改动与本地的签名改动无声合并，故推送前必须重算签名
    Invoke-Native { & git pull --rebase --autostash } "git pull --rebase 失败，请手动处理后重试"

    $cardsPath = Join-Path $repoDir 'cards.json'
    $calc = Get-CardsSignature $cardsPath
    $fileSig = ([System.IO.File]::ReadAllText($cardsPath) | ConvertFrom-Json).sig
    if ($calc -ne $fileSig) {
        throw "cards.json 签名校验失败：文件 sig=$fileSig，重算=$calc。rebase 可能引入了未经重签的改动，请用卡密生成器重新生成清单后重试。"
    }
    Write-Info "cards.json 签名校验通过（$fileSig）"

    Invoke-Native { & git push origin main } "git push 失败"
    Write-Info "已推送"
} finally {
    Pop-Location
}

# ===== 刷新 jsDelivr 缓存 =====
Write-Step "刷新 jsDelivr 缓存"
# jsDelivr 对 @main 这类分支引用有约 12 小时缓存；不主动清理，备源会长时间停在旧清单/旧安装包上，
# 表现为「弹窗提示有新版本，却下载不到新包」。必须在 push 之后刷新——purge 会让 jsDelivr 重新回源。
# cards.json 是卡密清单的 jsDelivr 备源，改动后同样是同款 12 小时缓存问题，一并刷新。
$purgeTargets = @(
    "https://purge.jsdelivr.net/gh/$GitHubRepo@main/update.json"
    "https://purge.jsdelivr.net/gh/$GitHubRepo@main/cards.json"
)
foreach ($a in $App) {
    $purgeTargets += "https://purge.jsdelivr.net/gh/$GitHubRepo@main/$ApkMirrorDir/$a-release.apk"
}
foreach ($u in $purgeTargets) {
    try {
        $r = Invoke-RestMethod -Uri $u -TimeoutSec 30
        Write-Info "已刷新（$($r.status)）：$u"
    } catch {
        Write-Info "刷新失败（不影响发版，缓存会在 12 小时内自行过期）：$u"
    }
}

Write-Host "`n发版完成：APK v$Version" -ForegroundColor Green
Write-Info "Release：https://github.com/$GitHubRepo/releases/tag/$tag"
Write-Info "清单（主源）：https://raw.githubusercontent.com/$GitHubRepo/refs/heads/main/update.json"
Write-Info "清单（备源）：https://cdn.jsdelivr.net/gh/$GitHubRepo@main/update.json"