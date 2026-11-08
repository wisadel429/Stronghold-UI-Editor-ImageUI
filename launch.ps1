# Requires -Version 5.1
# 独立版 UI 编辑器的启动器：选目录 → 找 Node（优先游戏自带的）→ 运行 app.mjs。
# 用 PowerShell 处理路径，避免 cmd 在中文路径 / 编码 / for /f 上的坑。

param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Passthrough = @()
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# 优先用内置浏览器宿主（StrongholdUIEditor.exe）；加 --external 才走旧的系统浏览器模式。
$hostExe = Join-Path $here 'StrongholdUIEditor.exe'
if ((Test-Path -LiteralPath $hostExe) -and -not ($Passthrough -contains '--external')) {
  $hostArgs = @()
  foreach ($item in $Passthrough) {
    if ($item -eq '--external') { continue }
    if ($item -match '\s') { $hostArgs += '"' + $item + '"' } else { $hostArgs += $item }
  }
  Start-Process -FilePath $hostExe -ArgumentList ($hostArgs -join ' ')
  exit 0
}

function Write-Step([string]$text) { Write-Host "  $text" }
function Write-Ok([string]$text) { Write-Host "  [ok] $text" }
function Write-Warn2([string]$text) { Write-Host "  [!] $text" -ForegroundColor Yellow }

Write-Host ''
Write-Host '  =========================================='
Write-Host '    Stronghold UI Layout Editor'
Write-Host '  =========================================='
Write-Host ''

# ---- 1. 游戏目录：命令行 --game 优先，否则弹选择框 ----
$game = $null
for ($i = 0; $i -lt $Passthrough.Count; $i++) {
  if ($Passthrough[$i] -eq '--game' -and ($i + 1) -lt $Passthrough.Count) { $game = $Passthrough[$i + 1]; break }
}
# 也接受把游戏文件夹直接拖到 Start.bat 上（第一个不是 -- 的参数）
if (-not $game) {
  foreach ($item in $Passthrough) {
    if ($item -and -not $item.StartsWith('--') -and (Test-Path -LiteralPath $item -PathType Container)) { $game = $item; break }
  }
}

if (-not $game) {
  Write-Step 'A folder picker will open.'
  Write-Step 'Choose the game folder (the one that contains public and server).'
  Write-Host ''
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("sp-ui-editor-pick-" + [guid]::NewGuid().ToString('N') + '.txt')
  & (Join-Path $here 'pick-path.ps1') -out $tmp | Out-Null
  if (Test-Path -LiteralPath $tmp) {
    $game = (Get-Content -LiteralPath $tmp -Raw -Encoding UTF8)
    if ($game) { $game = $game.Trim() }
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

if (-not $game) {
  Write-Warn2 'No game folder selected.'
  Read-Host 'Press Enter to close'
  exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path $game 'public\index.html'))) {
  Write-Warn2 "Not a game folder (no public\index.html): $game"
  Read-Host 'Press Enter to close'
  exit 1
}
Write-Ok "Game folder: $game"

# ---- 2. 找 Node：游戏自带 > 工具自带 > PATH > 常见安装位置 ----
$candidates = @(
  (Join-Path $game 'node\node.exe'),
  (Join-Path $here 'node\node.exe'),
  (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
)
$node = $null
foreach ($candidate in $candidates) {
  if ($candidate -and (Test-Path -LiteralPath $candidate)) { $node = $candidate; break }
}
if (-not $node) {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { $node = $cmd.Source }
}
if (-not $node) {
  Write-Warn2 'Node.js not found.'
  Write-Step 'This game package normally has node\node.exe next to server\.'
  Write-Step 'Or install Node.js 22+ from https://nodejs.org/ and run this again.'
  Read-Host 'Press Enter to close'
  exit 1
}
Write-Ok "Node: $node"

# ---- 3. 运行编辑器 ----
$appArgs = @((Join-Path $here 'app.mjs'), '--game', $game) + $Passthrough
& $node @appArgs
$code = $LASTEXITCODE

Write-Host ''
if ($code -ne 0) { Write-Warn2 "Exit code: $code" }
Read-Host 'Press Enter to close'
exit $code
