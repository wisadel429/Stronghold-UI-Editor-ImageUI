# 打包脚本：把 UI 编辑器打成可分发 zip（不含体积很大的 webview2 运行时）
#
#   powershell -ExecutionPolicy Bypass -File package.ps1
#
# 产物：<仓库上级>\dist\Stronghold-UI-Editor-ImageUI-1.2.1-<日期>.zip
#
# 运行时从哪来（宿主启动时按顺序找）：
#   1) 工具目录\webview2\
#   2) 上次 / 附近检测到的游戏目录\webview2\
#   3) 系统 Evergreen WebView2（保证“选游戏目录”前置页能先打开）
# 所以包里不放运行时也能跑；想把运行时一起带走，把游戏目录的 webview2 文件夹放到工具目录即可。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$outDir = Join-Path (Split-Path -Parent $root) 'dist'
$version = '1.2.1'
$stamp = Get-Date -Format 'yyyyMMdd'
$name = "Stronghold-UI-Editor-ImageUI-$version"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$stage = Join-Path $outDir ('_stage\' + $name)
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
$inner = Join-Path $stage 'Stronghold-UI-Editor'
New-Item -ItemType Directory -Force -Path $inner | Out-Null

$skipDirs = @('webview2', 'profiles', 'node', 'dist', '.git')
Get-ChildItem -LiteralPath $root -Force | ForEach-Object {
  if ($_.PSIsContainer) {
    if ($skipDirs -contains $_.Name) { return }
    Copy-Item -LiteralPath $_.FullName -Destination $inner -Recurse -Force
  } else {
    Copy-Item -LiteralPath $_.FullName -Destination $inner -Force
  }
}
New-Item -ItemType Directory -Force -Path (Join-Path $inner 'profiles') | Out-Null
Set-Content -LiteralPath (Join-Path $inner 'profiles\README.txt') -Encoding UTF8 -Value @'
这里放布局存档（*.json）。工具会自动创建 auto-<游戏版本>.json；
整个 profiles 文件夹可以整体拷到新电脑 / 新版本继续用。
'@

$zip = Join-Path $outDir ($name + '-' + $stamp + '.zip')
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path $inner -DestinationPath $zip -CompressionLevel Optimal
$size = [math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 2)
Write-Host ("  [ok] {0}  ({1} MB)" -f (Split-Path -Leaf $zip), $size) -ForegroundColor Green
Remove-Item -LiteralPath $stage -Recurse -Force
