# 确保 ds-teams 服务在跑；没跑就用 WMI 脱离宿主作业对象启动（Start-Process 起的子进程会随宿主命令结束被杀）
$ErrorActionPreference = "Stop"
$port = 8792
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  Write-Output ("ok pid=" + $conn[0].OwningProcess)
  exit 0
}

$node = (Get-Command node).Source
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = '"' + $node + '" server.mjs'
  CurrentDirectory = $root
}
if ($r.ReturnValue -ne 0) {
  Write-Output ("failed return=" + $r.ReturnValue)
  exit 1
}

Start-Sleep -Seconds 2
$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  Write-Output ("started pid=" + $conn[0].OwningProcess)
  exit 0
}
Write-Output "started but not listening yet"
exit 1
