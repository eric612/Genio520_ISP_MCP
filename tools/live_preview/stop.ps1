$ErrorActionPreference='Stop'
$root=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$session=Join-Path $root 'outputs\live-preview\session.json'
if(-not(Test-Path -LiteralPath $session)){Write-Output 'No recorded preview';exit 0}
$record=Get-Content -LiteralPath $session -Raw | ConvertFrom-Json
$process=Get-Process -Id $record.pid -ErrorAction SilentlyContinue
if($process){
    if($process.Path -ne $record.executable -or $process.StartTime.ToUniversalTime().ToString('o') -ne $record.started_utc){throw 'PID identity changed; refusing to stop a different process'}
    Stop-Process -Id $record.pid -Force
}
$record.status='STOPPED'
$record | ConvertTo-Json | Set-Content -LiteralPath $session -Encoding UTF8
Write-Output 'Recorded preview stopped; camera release follows scrcpy disconnect'
