# web-sync.ps1 — 双份源码一致性守卫 + 自动同步（PWA 与 Android 副本）
#
# 背景：每个应用都有两份源码，必须保持「共享核心」逐字一致，只有平台外壳允许不同：
#   · PWA 主文件   : lmt-cards/docs/<app>/index.html      （额外含 manifest/meta/图标 + 末尾 SW 注册脚本）
#   · Android 副本 : android/<app>/src/main/assets/index.html （额外含 nativeSave* 原生桥与对应的导出分支）
#
# 用法：
#   检查共享核心是否一致（不一致则打印差异并非零退出；本地与 CI 通用）：
#     powershell -ExecutionPolicy Bypass -File tools/web-sync.ps1 -Check
#   审计同步状态，不写任何文件：已同步 / 待同步都算通过，只有「安卓侧被人单方面改动」或 @shell 结构违规才非零退出：
#     powershell -ExecutionPolicy Bypass -File tools/web-sync.ps1 -Audit
#   把 PWA 的共享核心同步进安卓副本（按 @shell 块名原位替换后整份重写安卓侧的 index.html）：
#     powershell -ExecutionPolicy Bypass -File tools/web-sync.ps1 -Sync
#   依据 index.html 变化自动升级 sw.js 的 CACHE 版本并写入 @index-hash 标记：
#     powershell -ExecutionPolicy Bypass -File tools/web-sync.ps1 -Bump
#   只处理单个应用：追加 -App lmt-cardgen
#
# @shell 标记的约定（脚本据此判断谁能覆盖谁）：
#   · HTML 上下文：<!-- @shell:NAME -->  ...  <!-- @shell:end -->
#   · JS   上下文：// @shell:NAME       ...  // @shell:end
#   · PWA 侧出现的每个 @shell 块都是一处「平台外壳注入点」：
#       - 安卓侧有同名块 → 该块是安卓外壳，-Sync 时用安卓侧原文覆盖（PWA 侧的同名内容被丢弃）；
#       - 安卓侧无同名块 → 该块必须是 PWA 专属（名字以 pwa- 开头），-Sync 时整段丢弃；
#       - 安卓侧无同名块、名字又不是 pwa- 开头 → 同步后会凭空消失，属于结构违规，报错退出。
#   · 安卓侧出现的每个块都必须在 PWA 侧有同名声明（否则没有注入点能承接它），且不得以 pwa- 开头。
#   · 想给安卓外壳留注入点，就在 PWA 里写一对空标记（`// @shell:NAME` 紧跟 `// @shell:end`）。
#     空标记对只占位、不含共享核心内容，因此不影响 -Check。
#
# 「安卓侧被单方面改动」的判定：android/lmt-cards-sync.json 记录每次同步后安卓侧共享核心的指纹。
# -Sync 前先比对指纹，对不上说明安卓侧在最后一次同步之后被直接改过 → 报错退出，绝不静默覆盖。

param(
    [string]$App = '',
    [switch]$Check,
    [switch]$Audit,
    [switch]$Sync,
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
if (-not $Check -and -not $Audit -and -not $Sync -and -not $Bump) { $Check = $true }  # 缺省行为 = 检查

$syncMarkerFile = Join-Path $root 'android/lmt-cards-sync.json'

function Read-AllLines([string]$path) {
    return ([System.IO.File]::ReadAllText($path)) -split "\r?\n"
}

# 末尾那个空元素只是文件结尾的换行，单独记下、最后补回，避免被当成「多一个空行」
function Remove-TrailingEmpty([string[]]$lines) {
    if ($lines.Length -eq 0) { return @() }
    if ($lines[$lines.Length - 1] -ne '') { return $lines }
    if ($lines.Length -eq 1) { return @() }
    return $lines[0..($lines.Length - 2)]
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

function Get-Sha256Hex([string]$text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($text)) } finally { $sha.Dispose() }
    return (-join ($hash | ForEach-Object { $_.ToString('x2') }))
}

# 共享核心的指纹：以 LF 连接、逐行比较口径与 Get-SharedCore 完全一致
function Get-SharedCoreHash([string]$path) {
    return (Get-Sha256Hex ((Get-SharedCore $path) -join "`n"))
}

# 共享核心逐行比对，产出可直接打印的差异行（哈希相同即完全相同，无需逐行比对）
function Get-SharedCoreDiffLines([string]$pwaPath, [string]$androidPath) {
    $a = Get-SharedCore $pwaPath
    $b = Get-SharedCore $androidPath
    $max = [Math]::Max($a.Count, $b.Count)
    for ($i = 0; $i -lt $max; $i++) {
        $x = if ($i -lt $a.Count) { $a[$i] } else { $null }
        $y = if ($i -lt $b.Count) { $b[$i] } else { $null }
        if ($x -ne $y) {
            $xs = if ($null -eq $x) { '<缺失>' } else { $x }
            $ys = if ($null -eq $y) { '<缺失>' } else { $y }
            Write-Output ("  第 {0} 行：`n      PWA     : {1}`n      Android : {2}" -f ($i + 1), $xs, $ys)
        }
    }
}

# 整份 index.html 的归一化文本（裁行尾空白、去空行、统一 LF）→ 用于计算内容指纹
function Get-NormalizedText([string]$path) {
    $kept = Read-AllLines $path | ForEach-Object { $_.TrimEnd() } | Where-Object { $_ -ne '' }
    return ($kept -join "`n")
}

function Get-IndexHash([string]$path) {
    return (Get-Sha256Hex (Get-NormalizedText $path)).Substring(0, 8)
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

        # 结构违规（单边新增/误名的 @shell 块）先报错：它不会反映在共享核心上，但会让后续同步丢内容
        try {
            Assert-ShellStructureForApp $app
        } catch {
            Write-Host $_.Exception.Message -ForegroundColor Red
            $bad++
            continue
        }

        $a = Get-SharedCore $pwa
        if ((Get-SharedCoreHash $pwa) -eq (Get-SharedCoreHash $and)) {
            Write-Host "[$app] 共享核心一致（$($a.Count) 行）" -ForegroundColor Green
        } else {
            $bad++
            $diffs = @(Get-SharedCoreDiffLines $pwa $and)
            Write-Host "[$app] 共享核心不一致：共 $($diffs.Count) 处差异" -ForegroundColor Red
            $diffs | ForEach-Object { Write-Host $_ }
        }
    }
    if ($bad -gt 0) { Write-Host "`n失败：$bad 个应用未通过（共享核心不一致，或 @shell 块结构违规）。" -ForegroundColor Red; exit 1 }
    Write-Host "`n通过：全部应用的共享核心一致。" -ForegroundColor Green
}

# ---------- 同步基线（android/lmt-cards-sync.json） ----------
function Read-SyncMarker {
    $map = @{}
    if (-not (Test-Path $syncMarkerFile)) { return $map }
    try {
        $j = [System.IO.File]::ReadAllText($syncMarkerFile) | ConvertFrom-Json
        foreach ($p in $j.apps.PSObject.Properties) {
            $map[$p.Name] = @{
                hash       = [string]$p.Value.sharedCoreSha256
                syncedFrom = [string]$p.Value.syncedFrom
            }
        }
    } catch {
        Write-Host "警告：$syncMarkerFile 解析失败，按「尚无基线」处理" -ForegroundColor Yellow
    }
    return $map
}

function Get-SyncMarkerText([hashtable]$entryMap) {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine('{')
    [void]$sb.AppendLine('  "note": "安卓侧共享核心的同步基线，由 lmt-cards/tools/web-sync.ps1 -Sync 维护：指纹对不上即视为安卓侧被单方面改动，同步会直接报错。",')
    [void]$sb.AppendLine('  "apps": {')
    $keys = @($entryMap.Keys | Sort-Object)
    for ($i = 0; $i -lt $keys.Count; $i++) {
        $k = $keys[$i]
        $e = $entryMap[$k]
        [void]$sb.AppendLine('    "' + $k + '": {')
        [void]$sb.AppendLine('      "sharedCoreSha256": "' + $e.hash + '",')
        [void]$sb.AppendLine('      "syncedFrom": "' + $e.syncedFrom + '"')
        $tail = if ($i -lt $keys.Count - 1) { '    },' } else { '    }' }
        [void]$sb.AppendLine($tail)
    }
    [void]$sb.AppendLine('  }')
    [void]$sb.AppendLine('}')
    return $sb.ToString()
}

# 本次同步来自哪个 lmt-cards 提交（仅作溯源信息，取不到就留空，不影响判定）
function Get-SyncedFromCommit {
    if ($env:GITHUB_SHA) { return ([string]$env:GITHUB_SHA).Trim() }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = (& git -C (Join-Path $root 'lmt-cards') rev-parse HEAD 2>$null)
    } catch {
        $out = $null
    } finally {
        $ErrorActionPreference = $prev
    }
    if ($out) { return ([string]$out).Trim() }
    return ''
}

# 单个应用的同步状态：
#   in-sync     —— 两侧共享核心已一致
#   pwa-changed —— PWA 共享核心更新了，且安卓侧自上次同步后没被改过 → 可以安全同步
#   first-sync  —— 安卓侧没有同步基线（首次接入），允许覆盖但会打印警告
#   drift       —— 安卓侧共享核心与基线指纹不符：被单方面改过，拒绝覆盖
function Get-SyncStatus([string]$app, [hashtable]$marker) {
    $pwa = Get-PwaFile $app
    $and = Get-AndroidFile $app
    if (-not (Test-Path $pwa)) { throw "[$app] 缺少 PWA 文件：$pwa" }
    if (-not (Test-Path $and)) { throw "[$app] 缺少 Android 副本：$and" }

    Assert-ShellStructureForApp $app

    $pwaHash = Get-SharedCoreHash $pwa
    $andHash = Get-SharedCoreHash $and
    $baseHash = if ($marker.ContainsKey($app)) { [string]$marker[$app].hash } else { '' }

    if ($andHash -eq $pwaHash) { return 'in-sync' }
    if (-not $baseHash) { return 'first-sync' }
    if ($baseHash -eq $andHash) { return 'pwa-changed' }
    return 'drift'
}

function Write-DriftReport([string]$app) {
    Write-Host "[$app] 安卓侧被单方面改动：当前共享核心与 $syncMarkerFile 记录的基线指纹不符。" -ForegroundColor Red
    Write-Host "      直接同步会把这份改动覆盖掉，故拒绝执行。处理办法二选一：" -ForegroundColor Red
    Write-Host "        · 若这份改动确实要保留 → 把相同内容同步写进 lmt-cards/docs/$app/index.html 后重跑；" -ForegroundColor Red
    Write-Host "        · 若这份改动不该存在 → 在 android 仓库把它撤掉（git checkout -- <file>）后重跑。" -ForegroundColor Red
    if ((Test-Path (Get-PwaFile $app)) -and (Test-Path (Get-AndroidFile $app))) {
        Write-Host "[$app] 两侧共享核心的差异如下（PWA ↔ Android）：" -ForegroundColor Red
        @(Get-SharedCoreDiffLines (Get-PwaFile $app) (Get-AndroidFile $app)) | ForEach-Object { Write-Host $_ }
    }
}

# ---------- -Audit：只看状态，不写文件 ----------
function Invoke-Audit {
    $marker = Read-SyncMarker
    $drift = 0
    $struct = 0
    foreach ($app in $apps) {
        try {
            $status = Get-SyncStatus $app $marker
        } catch {
            Write-Host $_.Exception.Message -ForegroundColor Red
            $struct++
            continue
        }
        switch ($status) {
            'in-sync' {
                Write-Host "[$app] 已同步：两侧共享核心一致（指纹 $((Get-SharedCoreHash (Get-PwaFile $app)).Substring(0, 12))…）" -ForegroundColor Green
            }
            'pwa-changed' {
                Write-Host "[$app] 待同步：PWA 共享核心已更新，安卓侧自上次同步后未被改动（由 -Sync 自动搬运，属正常中间态）" -ForegroundColor Cyan
            }
            'first-sync' {
                Write-Host "[$app] 尚无同步基线：缺少 $syncMarkerFile，首次 -Sync 时会建立" -ForegroundColor Yellow
            }
            'drift' {
                $drift++
                Write-DriftReport $app
            }
        }
    }
    if ($drift -gt 0 -or $struct -gt 0) {
        if ($drift -gt 0) { Write-Host "`n失败：$drift 个应用的安卓侧被单方面改动。" -ForegroundColor Red }
        if ($struct -gt 0) { Write-Host "`n失败：$struct 个应用的 @shell 块结构违规。" -ForegroundColor Red }
        exit 1
    }
    Write-Host "`n通过：没有发现安卓侧被单方面改动。" -ForegroundColor Green
}

# ---------- -Sync：把 PWA 的共享核心搬进安卓副本 ----------

# 把整份文件切成「字面行」段与「@shell 块」段（块保留边界标记行在内的原始行）
function Split-ShellSegments([string[]]$lines) {
    $segs = New-Object System.Collections.Generic.List[object]
    $buf = New-Object System.Collections.Generic.List[string]
    $i = 0
    while ($i -lt $lines.Length) {
        $m = [regex]::Match($lines[$i].Trim(), $reShellStart)
        if ($m.Success -and $m.Groups[1].Value -ne 'end') {
            if ($buf.Count -gt 0) { $segs.Add(@{ kind = 'literal'; lines = $buf.ToArray() }); $buf.Clear() }
            $name = $m.Groups[1].Value
            $blk = New-Object System.Collections.Generic.List[string]
            $blk.Add($lines[$i])
            $i++
            $closed = $false
            while ($i -lt $lines.Length) {
                $blk.Add($lines[$i])
                $isEnd = [regex]::IsMatch($lines[$i].Trim(), $reShellEnd)
                $i++
                if ($isEnd) { $closed = $true; break }
            }
            if (-not $closed) { throw "有 @shell:$name 起始标记，但没有对应的 @shell:end" }
            $segs.Add(@{ kind = 'block'; name = $name; lines = $blk.ToArray() })
        } else {
            $buf.Add($lines[$i])
            $i++
        }
    }
    if ($buf.Count -gt 0) { $segs.Add(@{ kind = 'literal'; lines = $buf.ToArray() }) }
    return $segs
}

function Get-BlockNames([string[]]$lines) {
    $names = New-Object System.Collections.Generic.List[string]
    foreach ($seg in @(Split-ShellSegments $lines)) {
        if ($seg.kind -eq 'block') { $names.Add([string]$seg.name) }
    }
    return $names
}

# 结构校验：任何一侧的 @shell 块都必须在另一侧有对应的承接方式，否则同步会静默丢内容
function Assert-ShellStructure([string]$app, [string[]]$pwaLines, [string[]]$andLines) {
    $pwaNames = @(Get-BlockNames $pwaLines)
    $andNames = @(Get-BlockNames $andLines)

    foreach ($n in $andNames) {
        if ($n.StartsWith('pwa-')) { throw "[$app] 安卓侧出现 PWA 专属块 @shell:$n：该块只能在 PWA 里存在，请改名。" }
        if ($pwaNames -notcontains $n) {
            throw "[$app] 安卓侧有 @shell:$n，但 PWA 侧没有同名块承接：请在 lmt-cards/docs/$app/index.html 的对应位置补一对空标记（// @shell:$n 紧跟 // @shell:end）。"
        }
    }
    foreach ($n in $pwaNames) {
        if ($n.StartsWith('pwa-')) {
            if ($andNames -contains $n) { throw "[$app] 安卓侧不该出现 PWA 专属块 @shell:$n。" }
            continue
        }
        if ($andNames -notcontains $n) {
            throw "[$app] PWA 侧的 @shell:$n 在安卓侧没有同名块：同步后这段会凭空消失。若它本就只属于 PWA，请改名为 pwa-$n；若是笔误，请与安卓侧对齐。"
        }
    }
}

# 读文件后做结构校验（-Check / -Audit / -Sync 三条路径都要过这一关：
# 若只在重写时才校验，安卓侧凭空多出一个块、共享核心却没变时会「已是最新」地溜过去）
function Assert-ShellStructureForApp([string]$app) {
    $pwa = Get-PwaFile $app
    $and = Get-AndroidFile $app
    if (-not (Test-Path $pwa)) { throw "[$app] 缺少 PWA 文件：$pwa" }
    if (-not (Test-Path $and)) { throw "[$app] 缺少 Android 副本：$and" }
    Assert-ShellStructure $app @(Read-AllLines $pwa) @(Read-AllLines $and)
}

# 按块名原位替换，生成安卓侧 index.html 的新内容（同时沿用原有换行风格与结尾换行）
function Get-SyncedAndroidText([string]$app) {
    $andRaw = [System.IO.File]::ReadAllText((Get-AndroidFile $app))
    $eol = if ($andRaw -match "`r`n") { "`r`n" } else { "`n" }

    $pwaLines = @(Remove-TrailingEmpty (Read-AllLines (Get-PwaFile $app)))
    $andLines = @(Remove-TrailingEmpty (Read-AllLines (Get-AndroidFile $app)))
    $trailing = $andRaw.EndsWith("`n")

    $andBlocks = @{}
    foreach ($seg in @(Split-ShellSegments $andLines)) {
        if ($seg.kind -eq 'block') { $andBlocks[[string]$seg.name] = @($seg.lines) }
    }

    $out = New-Object System.Collections.Generic.List[string]
    foreach ($seg in @(Split-ShellSegments $pwaLines)) {
        if ($seg.kind -eq 'literal') {
            foreach ($l in $seg.lines) { $out.Add([string]$l) }
            continue
        }
        $name = [string]$seg.name
        if ($name.StartsWith('pwa-')) { continue }          # PWA 专属外壳：安卓副本里不存在，整段丢弃
        foreach ($l in $andBlocks[$name]) { $out.Add([string]$l) }   # 安卓外壳：用安卓侧原文覆盖，含边界标记行
    }

    $text = ($out -join $eol)
    if ($trailing) { $text += $eol }
    return $text
}

function Invoke-Sync {
    $marker = Read-SyncMarker
    $entries = @{}
    foreach ($k in $marker.Keys) {
        $entries[$k] = @{ hash = [string]$marker[$k].hash; syncedFrom = [string]$marker[$k].syncedFrom }
    }

    $fromCommit = Get-SyncedFromCommit
    $drift = 0
    $struct = 0
    foreach ($app in $apps) {
        $pwa = Get-PwaFile $app
        $and = Get-AndroidFile $app
        try {
            $status = Get-SyncStatus $app $marker
        } catch {
            Write-Host $_.Exception.Message -ForegroundColor Red
            $struct++
            continue
        }

        switch ($status) {
            'drift' {
                $drift++
                Write-DriftReport $app
                continue
            }
            'in-sync' {
                Write-Host "[$app] 已是最新，无需改动" -ForegroundColor Green
            }
            'first-sync' {
                Write-Host "[$app] 没有同步基线，按首次接入处理：将用 PWA 的共享核心覆盖安卓副本" -ForegroundColor Yellow
            }
            'pwa-changed' {
                Write-Host "[$app] PWA 共享核心已更新，开始同步" -ForegroundColor Cyan
            }
        }

        if ($status -ne 'in-sync') {
            $text = Get-SyncedAndroidText $app
            $old = [System.IO.File]::ReadAllText($and)
            if ($text -eq $old) {
                Write-Host "[$app] 安卓副本内容逐字节未变（本次 PWA 改动只涉及 PWA 专属外壳）" -ForegroundColor Green
            } else {
                [System.IO.File]::WriteAllText($and, $text, (New-Object System.Text.UTF8Encoding($false)))
                Write-Host "[$app] 已重写 $and" -ForegroundColor Cyan
            }
            # 自检：写完后两侧共享核心必须一致
            if ((Get-SharedCoreHash $pwa) -ne (Get-SharedCoreHash $and)) {
                throw "[$app] 同步后两侧共享核心仍不一致，同步逻辑有缺陷，请检查 @shell 块声明。"
            }
        }

        # 基线记录的是「此刻安卓侧共享核心」的指纹；来源提交取本次同步的提交，没有更早记录时就补上当前提交
        $syncedFrom = if ($status -eq 'in-sync' -and $entries[$app].syncedFrom) { $entries[$app].syncedFrom } else { $fromCommit }
        $entries[$app] = @{ hash = (Get-SharedCoreHash $pwa); syncedFrom = $syncedFrom }
    }

    if ($drift -gt 0 -or $struct -gt 0) {
        if ($drift -gt 0) { Write-Host "`n失败：$drift 个应用的安卓侧被单方面改动，已拒绝覆盖。" -ForegroundColor Red }
        if ($struct -gt 0) { Write-Host "`n失败：$struct 个应用的 @shell 块结构违规，已拒绝覆盖。" -ForegroundColor Red }
        exit 1
    }

    $newMarkerText = Get-SyncMarkerText $entries
    $oldMarkerText = if (Test-Path $syncMarkerFile) { [System.IO.File]::ReadAllText($syncMarkerFile) } else { '' }
    if ($newMarkerText -eq $oldMarkerText) {
        Write-Host "`n同步基线未变（$syncMarkerFile）" -ForegroundColor Green
    } else {
        [System.IO.File]::WriteAllText($syncMarkerFile, $newMarkerText, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "`n已更新同步基线：$syncMarkerFile" -ForegroundColor Cyan
    }
    Write-Host "同步完成。" -ForegroundColor Green
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
if ($Audit) { Invoke-Audit }
if ($Sync) { Invoke-Sync }
if ($Bump) { Invoke-Bump }
