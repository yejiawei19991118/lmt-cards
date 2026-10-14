# web-sync.ps1 — 双份源码一致性守卫（PWA 与 Android 副本）
#
# 背景：每个应用都有两份源码，必须保持「共享核心」逐字一致，只有平台外壳允许不同：
#   · PWA 主文件   : lmt-cards/docs/<app>/index.html      （额外含 manifest/meta/图标 + 末尾 SW 注册脚本）
#   · Android 副本 : android/<app>/src/main/assets/index.html （额外含 nativeSave* 原生桥与对应的导出分支）
#
# 用法：
#   检查共享核心是否一致（不一致则打印差异并非零退出；适合放进 CI）：
#     powershell -ExecutionPolicy Bypass -File tools/web-sync.ps1 -Check
#   依据 index.html 变化自动升级 sw.js 的 CACHE 版本并写入 @index-hash 标记：
#     powershell -ExecutionPolicy Bypass -File tools/web-sync.ps1 -Bump
#   只处理单个应用：追加 -App lmt-cardgen
#
# 平台外壳区域用成对标记包裹，脚本会整段剔除后再比较；标记对两侧对称或单侧存在均可：
#   HTML 上下文：<!-- @shell:NAME -->  ...  <!-- @shell:end -->
#   JS   上下文：// @shell:NAME       ...  // @shell:end

param(
    [string]$App = '',
    [switch]$Check,
    [switch]$Bump
)

$ErrorActionPreference = 'Stop'

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

$allApps = @('lmt-layout', 'lmt-cardgen')
$apps = if ($App) { @($App) } else { $allApps }
foreach ($a in $apps) {
    if ($allApps -notcontains $a) { throw "未知应用：$a（可选：$($allApps -join ' / ')）" }
}
if (-not $Check -and -not $Bump) { $Check = $true }  # 缺省行为 = 检查

function Read-AllLines([string]$path) {
    return ([System.IO.File]::ReadAllText($path)) -split "\r?\n"
}

# 标记行判定：`<!-- @shell:xxx -->` / `// @shell:xxx` / `/* @shell:xxx`
$reShellStart = '^(?:<!--|//|/\*)\s*@shell:([A-Za-z0-9_-]+)'
$reShellEnd = '^(?:<!--|//|/\*)\s*@shell:end\b'

# 去掉 @shell 区域（含边界行）后的共享核心：行尾空白裁掉、丢弃空行
function Get-SharedCore([string]$path) {
    $list = New-Object System.Collections.Generic.List[string]
    $inRegion = $false
    foreach ($raw in (Read-AllLines $path)) {
        $t = $raw.TrimEnd()
        $tt = $t.Trim()
        if (-not $inRegion) {
            $m = [regex]::Match($tt, $reShellStart)
            if ($m.Success -and $m.Groups[1].Value -ne 'end') { $inRegion = $true; continue }
        } else {
            if ([regex]::IsMatch($tt, $reShellEnd)) { $inRegion = $false }
            continue
        }
        if ($tt -eq '') { continue }
        $list.Add($t)
    }
    return $list
}

# 整份 index.html 的归一化文本（裁行尾空白、去空行、统一 LF）→ 用于计算内容指纹
function Get-NormalizedText([string]$path) {
    $kept = Read-AllLines $path | ForEach-Object { $_.TrimEnd() } | Where-Object { $_ -ne '' }
    return ($kept -join "`n")
}

function Get-IndexHash([string]$path) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes((Get-NormalizedText $path))
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = $sha.ComputeHash($bytes) } finally { $sha.Dispose() }
    $hex = -join ($hash | ForEach-Object { $_.ToString('x2') })
    return $hex.Substring(0, 8)
}

function Get-PwaFile([string]$app) { Join-Path $root "lmt-cards/docs/$app/index.html" }
function Get-AndroidFile([string]$app) { Join-Path $root "android/$app/src/main/assets/index.html" }
function Get-SwFile([string]$app) { Join-Path $root "lmt-cards/docs/$app/sw.js" }

# ---------- -Check：比较共享核心 ----------
function Invoke-Check {
    $bad = 0
    foreach ($app in $apps) {
        $pwa = Get-PwaFile $app
        $and = Get-AndroidFile $app
        if (-not (Test-Path $pwa)) { Write-Host "[$app] 缺少 PWA 文件：$pwa" -ForegroundColor Red; $bad++; continue }
        if (-not (Test-Path $and)) { Write-Host "[$app] 缺少 Android 副本：$and" -ForegroundColor Red; $bad++; continue }

        $a = Get-SharedCore $pwa
        $b = Get-SharedCore $and
        $diffs = New-Object System.Collections.Generic.List[string]
        $max = [Math]::Max($a.Count, $b.Count)
        for ($i = 0; $i -lt $max; $i++) {
            $x = if ($i -lt $a.Count) { $a[$i] } else { $null }
            $y = if ($i -lt $b.Count) { $b[$i] } else { $null }
            if ($x -ne $y) {
                if ($diffs.Count -lt 40) {
                    $xs = if ($null -eq $x) { '<缺失>' } else { $x }
                    $ys = if ($null -eq $y) { '<缺失>' } else { $y }
                    $diffs.Add(("  第 {0} 行：`n      PWA     : {1}`n      Android : {2}" -f ($i + 1), $xs, $ys))
                }
            }
        }
        if ($diffs.Count -eq 0 -and $a.Count -eq $b.Count) {
            Write-Host "[$app] 共享核心一致（$($a.Count) 行）" -ForegroundColor Green
        } else {
            $bad++
            Write-Host "[$app] 共享核心不一致：共 $($diffs.Count) 处差异" -ForegroundColor Red
            $diffs | ForEach-Object { Write-Host $_ }
        }
    }
    if ($bad -gt 0) { Write-Host "`n失败：$bad 个应用的共享核心不一致。" -ForegroundColor Red; exit 1 }
    Write-Host "`n通过：全部应用的共享核心一致。" -ForegroundColor Green
}

# ---------- -Bump：按 index.html 指纹升级 SW 版本 ----------
function Invoke-Bump {
    foreach ($app in $apps) {
        $pwa = Get-PwaFile $app
        $sw = Get-SwFile $app
        if (-not (Test-Path $pwa)) { Write-Host "[$app] 缺少 index.html，跳过" -ForegroundColor Yellow; continue }
        if (-not (Test-Path $sw)) { Write-Host "[$app] 缺少 sw.js，跳过" -ForegroundColor Yellow; continue }

        $h = Get-IndexHash $pwa
        $text = [System.IO.File]::ReadAllText($sw)
        $mh = [regex]::Match($text, '@index-hash:\s*([0-9a-fA-F]{8})')
        if (-not $mh.Success) {
            Write-Host "[$app] sw.js 缺少 @index-hash 标记，未改动" -ForegroundColor Yellow
            continue
        }
        $oldHash = $mh.Groups[1].Value
        if ($oldHash -eq $h) { Write-Host "[$app] index.html 未变（hash $h），无需升版" -ForegroundColor Green; continue }

        $mc = [regex]::Match($text, "const\s+CACHE\s*=\s*'([A-Za-z0-9_-]+)-v(\d+)'")
        if (-not $mc.Success) { Write-Host "[$app] 无法解析 sw.js 的 CACHE 版本，未改动" -ForegroundColor Yellow; continue }
        $prefix = $mc.Groups[1].Value
        $oldVer = [int]$mc.Groups[2].Value
        $newVer = $oldVer + 1

        $text = $text -replace "(const\s+CACHE\s*=\s*'[A-Za-z0-9_-]+-)v\d+(')", "`${1}v$newVer`${2}"
        $text = $text -replace '(@index-hash:\s*)[0-9a-fA-F]{8}', "`${1}$h"
        [System.IO.File]::WriteAllText($sw, $text)
        Write-Host "[$app] CACHE $prefix-v$oldVer → $prefix-v$newVer；@index-hash $oldHash → $h" -ForegroundColor Cyan
    }
}

if ($Check) { Invoke-Check }
if ($Bump) { Invoke-Bump }