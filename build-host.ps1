# 编译内置浏览器宿主（不需要 Visual Studio / dotnet SDK，用 Windows 自带的 .NET Framework csc）。
# 产物：Stronghold-UI-Editor\StrongholdUIEditor.exe（以及运行所需的 3 个 WebView2 DLL）。

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = $here

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) {
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $csc)) {
  throw '找不到 .NET Framework 编译器 csc.exe（需要 Windows 自带的 .NET Framework 4.x）'
}

$lib = Join-Path $here 'host\lib'
$core = Join-Path $lib 'Microsoft.Web.WebView2.Core.dll'
$winforms = Join-Path $lib 'Microsoft.Web.WebView2.WinForms.dll'
$loader = Join-Path $lib 'WebView2Loader.dll'
foreach ($file in @($core, $winforms, $loader)) {
  if (-not (Test-Path -LiteralPath $file)) { throw "缺少 WebView2 SDK 文件：$file（从游戏目录拷到 host\lib）" }
}

$source = Join-Path $here 'host\EditorHost.cs'
$out = Join-Path $root 'StrongholdUIEditor.exe'
$icon = Join-Path $here 'host\web\app.ico'

$args = @(
  '/nologo',
  '/target:winexe',
  '/platform:x64',
  '/optimize+',
  '/utf8output',
  "/out:$out",
  "/win32icon:$icon",
  '/r:System.dll',
  '/r:System.Core.dll',
  '/r:System.Drawing.dll',
  '/r:System.Windows.Forms.dll',
  '/r:System.Web.Extensions.dll',
  "/r:$core",
  "/r:$winforms",
  $source
)

Write-Host '  csc ' -NoNewline
& $csc @args
if ($LASTEXITCODE -ne 0) { throw "编译失败（exit $LASTEXITCODE）" }

# 运行时要能找到这三个 DLL：放到 exe 同目录
foreach ($file in @($core, $winforms, $loader)) {
  Copy-Item -LiteralPath $file -Destination $root -Force
}

$config = @'
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <startup>
    <supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8" />
  </startup>
</configuration>
'@
[System.IO.File]::WriteAllText((Join-Path $root 'StrongholdUIEditor.exe.config'), $config, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host "  已生成：$out" -ForegroundColor Green
Get-Item -LiteralPath $out | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize
