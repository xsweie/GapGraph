param([Parameter(Mandatory = $true)][ValidateSet('setup', 'start')][string]$Mode)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root '.data\windows'
$keyFile = Join-Path $stateDir 'deepseek.dpapi'
$inheritedKey = $env:DEEPSEEK_API_KEY
Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue

function Find-Node {
    $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) { return $null }
    $version = & $command.Source --version
    if ($LASTEXITCODE -eq 0 -and $version -match '^v(\d+\.\d+\.\d+)$' -and [version]$Matches[1] -ge $minimumNode) {
        return $command.Source
    }
    Write-Host "当前 Node.js 版本为 $version，需要 $minimumNode 或更高。"
    return $null
}

function Install-Node {
    Write-Host '正在尝试安装 Node.js LTS。若出现安装协议或管理员权限提示，请在窗口中确认。'
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    $choco = Get-Command choco.exe -ErrorAction SilentlyContinue
    $scoop = Get-Command scoop -ErrorAction SilentlyContinue
    if ($winget) {
        & $winget.Source install --id OpenJS.NodeJS.LTS --exact --source winget | Out-Host
    } elseif ($choco) {
        & $choco.Source upgrade nodejs-lts | Out-Host
    } elseif ($scoop) {
        & $scoop install nodejs-lts | Out-Host
    } else {
        Write-Host '未找到 WinGet、Chocolatey 或 Scoop。'
        return
    }
    if ($LASTEXITCODE -ne 0) { Write-Host "包管理器返回错误码 $LASTEXITCODE，请查看上方原因。" }

    # An installer can update the registry without changing this console's PATH.
    $env:Path = @([Environment]::GetEnvironmentVariable('Path', 'Machine'),
        [Environment]::GetEnvironmentVariable('Path', 'User'), $env:Path) -join ';'
}

function Find-Npm {
    $adjacent = Join-Path (Split-Path -Parent $node) 'npm.cmd'
    if (Test-Path -LiteralPath $adjacent -PathType Leaf) { return $adjacent }
    $command = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    throw '找不到 npm.cmd。请重新双击 setup.bat，或从 https://nodejs.org/en/download 安装包含 npm 的 Windows LTS 版本。'
}

function Reveal-Key([Security.SecureString]$Secure) {
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr).Trim() }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Find-Key {
    if (-not [string]::IsNullOrWhiteSpace($inheritedKey)) {
        return @{ Source = 'DEEPSEEK_API_KEY'; Value = $inheritedKey.Trim() }
    }
    & $node (Join-Path $PSScriptRoot 'deepseek-key.cjs')
    if ($LASTEXITCODE -eq 0) { return @{ Source = '~/.dsh/.credentials.yaml'; Value = $null } }
    if ($LASTEXITCODE -ne 3) { throw '无法检查现有 API 配置，请查看上方提示。' }

    if (Test-Path -LiteralPath $keyFile -PathType Leaf) {
        $clear = $null
        try {
            Add-Type -AssemblyName System.Security
            $encrypted = [Convert]::FromBase64String([IO.File]::ReadAllText($keyFile))
            $clear = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, 'CurrentUser')
            $value = [Text.Encoding]::UTF8.GetString($clear)
            if ($value) { return @{ Source = 'Windows DPAPI'; Value = $value } }
        } catch {
            Write-Host 'Windows 无法解密保存的 Key。请用当前 Windows 账户重新配置。'
        } finally {
            if ($clear) { [Array]::Clear($clear, 0, $clear.Length) }
        }
    }
    return $null
}

function Save-Key {
    Write-Host '请在 https://platform.deepseek.com/api_keys 创建 DeepSeek API Key。'
    Write-Host '粘贴 Key 后按 Enter。输入会被遮挡，保存后当前 Windows 账户可以自动读取。'
    if ([Console]::IsInputRedirected) { throw '请双击 setup.bat，在初始化窗口中输入 Key。' }
    $secure = Read-Host 'DeepSeek API Key' -AsSecureString
    $clear = $null
    try {
        $value = if ($secure) { Reveal-Key $secure }
        if ($value -notmatch '^sk-[A-Za-z0-9_-]{10,}$') {
            throw 'Key 为空或格式不正确。请再次运行 setup.bat，粘贴以 sk- 开头的完整 Key。'
        }
        Add-Type -AssemblyName System.Security
        $clear = [Text.Encoding]::UTF8.GetBytes($value)
        $encrypted = [Security.Cryptography.ProtectedData]::Protect($clear, $null, 'CurrentUser')
        [IO.File]::WriteAllText($keyFile, [Convert]::ToBase64String($encrypted))
    } finally {
        if ($clear) { [Array]::Clear($clear, 0, $clear.Length) }
        if ($secure) { $secure.Dispose() }
    }
}

function Assert-Running($Service, [string]$Name) {
    if ($Service.HasExited) {
        throw "$Name 已退出（退出码 $($Service.ExitCode)）。请查看上方的服务输出。"
    }
}

function Get-LocalPage([string]$Url) {
    return $http.GetStringAsync($Url).GetAwaiter().GetResult()
}

function Wait-Ready([string]$Name, [string]$File, [string]$HostPattern, $Service, $Proxy) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $lastIssue = '服务尚未报告监听地址'
    while ($timer.Elapsed.TotalSeconds -lt 30) {
        Assert-Running $Service $Name
        Assert-Running $Proxy 'AI 服务'
        if (Test-Path -LiteralPath $File -PathType Leaf) {
            try {
                $ready = Get-Content -LiteralPath $File -Raw | ConvertFrom-Json
                if ($ready.url -notmatch "^http://${HostPattern}:\d{1,5}$") { throw '服务返回了无效的本机地址' }
                $health = Get-LocalPage "$($ready.url)/health" | ConvertFrom-Json
                if (-not $health.ok -or $health.pid -ne $Proxy.Id) { throw '健康检查没有匹配本次启动的 AI 进程' }
                if ($Name -eq '网页服务' -and (Get-LocalPage "$($ready.url)/") -notmatch 'id="app"') {
                    throw '网页尚未返回 GapGraph 页面'
                }
                return $ready.url
            } catch {
                $lastIssue = $_.Exception.GetBaseException().Message
            }
        }
        Start-Sleep -Milliseconds 200
    }
    throw "$Name 在 30 秒内未就绪。$lastIssue。请查看上方的服务输出。"
}

$lock = $job = $proxy = $web = $http = $null
$exitCode = 1
try {
    if ($env:OS -ne 'Windows_NT') { throw '请在 Windows 上双击运行。' }
    Set-Location -LiteralPath $root
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    if ($Mode -eq 'setup') { Write-Host '[1/5] 检查 Node.js' }
    else { Write-Host '[1/4] 检查运行环境' }

    $manifest = Get-Content -LiteralPath 'package.json' -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.engines.node -notmatch '^>=(\d+\.\d+\.\d+)$') { throw 'package.json 缺少有效的 Node.js 最低版本。' }
    $minimumNode = [version]$Matches[1]
    $node = Find-Node
    if (-not $node -and $Mode -eq 'setup') {
        Install-Node
        $node = Find-Node
    }
    if (-not $node) {
        throw "需要 Node.js $minimumNode 或更高。请双击 setup.bat，或从 https://nodejs.org/en/download 下载 Windows LTS 安装包，安装后重新打开 setup.bat。"
    }
    $env:Path = (Split-Path -Parent $node) + ';' + $env:Path

    if ($Mode -eq 'setup') { Write-Host '[2/5] 检查 npm' }
    $npm = Find-Npm
    if ($Mode -eq 'setup') {
        & $npm --version
        if ($LASTEXITCODE -ne 0) { throw 'npm.cmd 无法运行，请重新安装包含 npm 的 Node.js LTS。' }
    }

    foreach ($required in @('package-lock.json', 'vite.web.config.ts', 'scripts\ai-proxy.cjs',
        'scripts\question-qc.cjs', 'scripts\deepseek-key.cjs', 'scripts\windows-deps.cjs', 'scripts\windows-job.cs',
        'src\renderer\index.html')) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "项目缺少 $required，请重新获取完整项目。" }
    }
    [void][IO.Directory]::CreateDirectory($stateDir)
    try { $lock = [IO.File]::Open((Join-Path $stateDir 'launcher.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch [IO.IOException] { throw '该项目的初始化或启动窗口已经在运行。请先结束已有窗口。' }

    $deps = Join-Path $PSScriptRoot 'windows-deps.cjs'
    if ($Mode -eq 'setup') {
        Write-Host '[3/5] 检查项目依赖'
        & $node $deps prepare
        if ($LASTEXITCODE -eq 3) {
            Write-Host '正在按 package-lock.json 安装网页依赖，请保持联网。'
            & $npm ci --ignore-scripts --include=dev --include=optional --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw "npm ci 安装失败（退出码 $LASTEXITCODE）。请查看上方原因，再运行 setup.bat。" }
            & $node $deps record
            if ($LASTEXITCODE -ne 0) { throw '安装后依赖检查失败，请查看上方原因。' }
        } elseif ($LASTEXITCODE -eq 0) {
            Write-Host '依赖已就绪，跳过安装。'
        } else { throw '项目依赖清单检查失败，请查看上方原因。' }

        Write-Host '[4/5] 检查 API 配置'
        $key = Find-Key
        if (-not $key) {
            Save-Key
            $key = Find-Key
            if (-not $key) { throw '无法读取已保存的 Key，请重新运行 setup.bat 或使用已有的 API Key 配置方式。' }
        }
        Write-Host "已配置 DeepSeek API Key（$($key.Source)）。"
        Write-Host '[5/5] 初始化完成，可以双击 start.bat。'
    } else {
        & $node $deps check
        if ($LASTEXITCODE -ne 0) { throw '请先双击 setup.bat 完成初始化。' }
        $key = Find-Key
        if (-not $key) { throw '未配置 DeepSeek API Key。请双击 setup.bat，按提示从 DeepSeek 平台创建并保存 Key。' }

        Add-Type -Path (Join-Path $PSScriptRoot 'windows-job.cs')
        Add-Type -AssemblyName System.Net.Http
        $handler = New-Object Net.Http.HttpClientHandler
        $handler.UseProxy = $false
        $handler.AllowAutoRedirect = $false
        $http = New-Object Net.Http.HttpClient($handler)
        $http.Timeout = [TimeSpan]::FromMilliseconds(1000)

        $job = New-Object GapGraphJob
        $env:GAPGRAPH_RUN_DIR = Join-Path $stateDir 'run'
        [void][IO.Directory]::CreateDirectory($env:GAPGRAPH_RUN_DIR)
        $aiReady = Join-Path $env:GAPGRAPH_RUN_DIR 'ai.json'
        $webReady = Join-Path $env:GAPGRAPH_RUN_DIR 'web.json'
        Remove-Item -LiteralPath $aiReady, $webReady -ErrorAction SilentlyContinue

        Write-Host '[2/4] 启动 AI 服务'
        try {
            if ($key.Value) { $env:DEEPSEEK_API_KEY = $key.Value }
            $proxy = $job.Start($node, 'scripts\ai-proxy.cjs', $root)
        } finally {
            Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
            $key = $inheritedKey = $null
        }
        $env:GAPGRAPH_AI_ORIGIN = Wait-Ready 'AI 服务' $aiReady '127\.0\.0\.1' $proxy $proxy
        Write-Host "AI 服务已就绪 $env:GAPGRAPH_AI_ORIGIN"

        Write-Host '[3/4] 启动网页服务'
        $web = $job.Start($env:ComSpec, ('/d /s /v:off /c ""{0}" run dev:web"' -f $npm), $root)
        $url = Wait-Ready '网页服务' $webReady 'localhost' $web $proxy

        Write-Host "[4/4] 打开浏览器 $url"
        try { Start-Process -FilePath $url }
        catch { Write-Host "无法自动打开默认浏览器，请手动访问 $url。" }
        Write-Host '服务正在运行。按 Ctrl+C 或关闭此窗口即可停止。'
        $exitCode = 0
        while (-not $job.IsStopping) {
            Assert-Running $proxy 'AI 服务'
            Assert-Running $web '网页服务'
            Start-Sleep -Milliseconds 300
        }
    }
    $exitCode = 0
} catch {
    if ($job -and $job.IsStopping) {
        $exitCode = 0
    } else {
        Write-Host "[错误] $($_.Exception.Message)" -ForegroundColor Red
        $exitCode = 1
    }
} finally {
    if ($job) { $job.Dispose() }
    if ($web) { $web.Dispose() }
    if ($proxy) { $proxy.Dispose() }
    if ($http) { $http.Dispose() }
    if ($lock) { $lock.Dispose() }
}
exit $exitCode
