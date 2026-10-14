# run.ps1 — 零依赖无头 Chromium 测试运行器（本地与 CI 通用）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tests/run.ps1
#   powershell -ExecutionPolicy Bypass -File tests/run.ps1 -Chrome "C:\path\to\msedge.exe" -TimeoutMs 60000
#
# 原理：用 --dump-dom 抓取 tests/harness.html 跑完全部用例后的最终 DOM，
#       从 <title> 读 pass/fail 与计数，从 <pre id="report"> 打印逐条明细。
# 关键开关（缺一不可）：
#   --allow-file-access-from-files   让父页能访问 file:// 下 iframe 里的内容
#   --host-resolver-rules=MAP * ~NOTFOUND  强制断网，使「离线回退」类断言可复现
#   --virtual-time-budget=<ms>       快进定时器，保证 dump-dom 时用例已全部跑完
#
# 已实证：缺 --user-data-dir 时 Edge 会复用既有实例导致不返回 DOM，故必须给独立目录。

param(
    [string]$Chrome = '',
    [int]$TimeoutMs = 60000,
    [switch]$KeepProfile,
    [switch]$ShowBrowserStderr
)

$ErrorActionPreference = 'Stop'

# 脚本位于 <仓库根>/tests/ 下
$root = Split-Path -Parent $PSScriptRoot
$harness = Join-Path (Join-Path $root 'tests') 'harness.html'
if (-not (Test-Path $harness)) { throw "找不到测试入口：$harness" }

function Resolve-Chrome([string]$explicit) {
    if ($explicit) {
        if (-not (Test-Path $explicit)) { throw "指定的浏览器不存在：$explicit" }
        return (Resolve-Path $explicit).Path
    }
    if ($env:CHROME_PATH -and (Test-Path $env:CHROME_PATH)) { return (Resolve-Path $env:CHROME_PATH).Path }

    $candidates = @(
        "$env:LOCALAPPDATA\Microsoft\Edge\Bin\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium'
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return (Resolve-Path $c).Path }
    }
    # 本机 Edge 常装在版本号子目录里：Bin/<version>/msedge.exe
    $edgeBin = "$env:LOCALAPPDATA\Microsoft\Edge\Bin"
    if (Test-Path $edgeBin) {
        $hit = Get-ChildItem -Path $edgeBin -Recurse -Filter 'msedge.exe' -ErrorAction SilentlyContinue |
               Sort-Object FullName -Descending | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    foreach ($name in @('msedge', 'chrome', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser')) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
    }
    throw '未找到 Chromium 系浏览器。请用 -Chrome 指定路径，或设置环境变量 CHROME_PATH。'
}

$chromeExe = Resolve-Chrome $Chrome
$profile = Join-Path ([System.IO.Path]::GetTempPath()) ('lmt-webtest-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $profile -Force | Out-Null

# 统一拼成 file:/// 三斜杠形态：Windows 的 C:/... 与 Linux 的 /home/... 都适用
$url = 'file:///' + ($harness -replace '\\', '/' -replace '^/', '')

# 注意：Arguments 是交给 Windows 解析的原始字符串，含空格的值必须自带引号，
# 否则 `MAP * ~NOTFOUND` 会被拆成多个位置参数，Chrome 报 "Multiple targets are not supported in headless mode."
$argList = @(
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-dev-shm-usage', # 容器（CI）里 /dev/shm 常偏小，禁用可避免渲染进程崩溃
    '--allow-file-access-from-files',
    '--host-resolver-rules="MAP * ~NOTFOUND"',
    "--virtual-time-budget=$TimeoutMs",
    ('--user-data-dir="' + $profile + '"'),
    '--dump-dom',
    ('"' + $url + '"')
)

Write-Host "浏览器：$chromeExe"
Write-Host "入口  ：$url"
Write-Host ""

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $chromeExe
$psi.Arguments = ($argList -join ' ')
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8

$proc = [System.Diagnostics.Process]::Start($psi)
# stderr 必须异步读：只读 stdout 时 stderr 缓冲写满会死锁
$errTask = $proc.StandardError.ReadToEndAsync()

# 边读边判：--dump-dom 的整份 DOM 会在虚拟时钟走完后一次写出，
# 而 Chrome/Edge 之后可能因子进程里仍挂着的动画帧迟迟不退出（实测能拖到两分钟）。
# 因此这里一读到 </html> 就收工，不再等它自行退出：既省掉几十秒空等，
# 也不会像固定 sleep 那样在慢机器上把还没跑完的结果截断。
$stream = $proc.StandardOutput.BaseStream
$buffer = New-Object System.IO.MemoryStream
$readBuf = New-Object byte[] 16384
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$maxMs = $TimeoutMs + 60000
$gotDom = $false
$pending = $null # 同一时刻只保留一个待读任务：重叠发起会互相抢数据，反而永远凑不齐
while (-not $gotDom) {
    if ($sw.Elapsed.TotalMilliseconds -ge $maxMs) { break }
    if ($null -eq $pending) { $pending = $stream.ReadAsync($readBuf, 0, $readBuf.Length) }
    if (-not $pending.Wait(250)) { continue }
    $n = 0
    try { $n = $pending.Result } catch { break }
    $pending = $null
    if ($n -le 0) { break } # EOF：进程已自行结束
    $buffer.Write($readBuf, 0, $n)
    $so_far = [System.Text.Encoding]::UTF8.GetString($buffer.ToArray())
    if ($so_far -match '</html>') { $gotDom = $true }
}
$selfExited = $proc.HasExited
if (-not $selfExited) {
    try { $proc.Kill() } catch { }
    $proc.WaitForExit(10000) | Out-Null
}
$stdout = [System.Text.Encoding]::UTF8.GetString($buffer.ToArray())
$stderr = $errTask.Result
if ($gotDom -and -not $selfExited) { Write-Host '提示：已抓到完整 DOM，浏览器退出较慢，直接结束了进程。' -ForegroundColor DarkGray }

if (-not $KeepProfile) {
    for ($i = 0; $i -lt 3; $i++) {
        try { Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction Stop; break }
        catch { Start-Sleep -Milliseconds 500 }
    }
}

$mTitle = [regex]::Match($stdout, '(?is)<title>([^<]*)</title>')
$title = if ($mTitle.Success) { $mTitle.Groups[1].Value.Trim() } else { '' }

$mReport = [regex]::Match($stdout, '(?is)<pre id="report">(.*?)</pre>')
$report = if ($mReport.Success) { $mReport.Groups[1].Value } else { '' }
$report = $report -replace '&lt;', '<' -replace '&gt;', '>' -replace '&quot;', '"' -replace '&#39;', "'" -replace '&amp;', '&'

Write-Host '---------------- 用例明细 ----------------'
Write-Host $report
Write-Host '------------------------------------------'
Write-Host ''

if ($ShowBrowserStderr -and $stderr) { Write-Host $stderr }

if ($title -match '^LMTTEST\s+pass\b') {
    Write-Host "结果：通过（$title）" -ForegroundColor Green
    exit 0
}
if ($title -match '^LMTTEST\s+fail\b') {
    Write-Host "结果：失败（$title）" -ForegroundColor Red
    exit 1
}

# 页面压根没跑起来（标题仍是初始值 / 无 DOM 输出）
Write-Host "结果：测试未产生结果（title='$title'，stdout 长度=$($stdout.Length)，exitCode=$($proc.ExitCode)）" -ForegroundColor Red
if ($stderr) { Write-Host $stderr }
exit 2
