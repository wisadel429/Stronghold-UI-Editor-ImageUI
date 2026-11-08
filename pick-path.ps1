param(
  [string]$out = '',
  [string]$path = ''
)

# 选择游戏目录：弹出文件夹选择框，校验 public\index.html。
# -out <file>  把结果以 UTF-8 写到文件（给 Node 读，避开控制台编码问题）
# -path <dir>  跳过对话框，直接使用给定目录（自动化测试用）

Add-Type -AssemblyName System.Windows.Forms | Out-Null

function Test-GameDir([string]$dir) {
  if ([string]::IsNullOrWhiteSpace($dir)) { return $false }
  return (Test-Path -LiteralPath (Join-Path $dir 'public\index.html'))
}

$picked = ''

if (-not [string]::IsNullOrWhiteSpace($path)) {
  if (-not (Test-GameDir $path)) {
    if ($out) { [System.IO.File]::WriteAllText($out, '', (New-Object System.Text.UTF8Encoding($false))) }
    Write-Output "not a game folder: $path"
    exit 2
  }
  $picked = $path
} else {
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = 'Select the game folder (the one containing public and server)'
  $dialog.ShowNewFolderButton = $false

  while ($true) {
    if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
      if ($out) { [System.IO.File]::WriteAllText($out, '', (New-Object System.Text.UTF8Encoding($false))) }
      exit 1
    }
    if (Test-GameDir $dialog.SelectedPath) { $picked = $dialog.SelectedPath; break }
    [System.Windows.Forms.MessageBox]::Show(
      "This folder does not look like the game folder.`n`nPick the folder that contains public and server.",
      'Wrong folder',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
  }
}

if ($out) {
  [System.IO.File]::WriteAllText($out, $picked, (New-Object System.Text.UTF8Encoding($false)))
}
Write-Output $picked
exit 0
