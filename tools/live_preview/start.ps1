param(
    [string]$Serial = $env:GENIO_SERIAL,
    [string]$Scrcpy = $(Join-Path $env:LOCALAPPDATA 'GenioDevMCP\scrcpy\v5.0.1\scrcpy-win64-v5.0.1\scrcpy.exe'),
    [string]$Size = '1920x1080',
    [int]$Fps = 30
)
$ErrorActionPreference='Stop'
$root=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$directory=Join-Path $root 'outputs\live-preview'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$session=Join-Path $directory 'session.json'
if(Test-Path -LiteralPath $session){
    $old=Get-Content -LiteralPath $session -Raw | ConvertFrom-Json
    $running=Get-Process -Id $old.pid -ErrorAction SilentlyContinue
    if($running -and $running.Path -eq $old.executable -and $running.StartTime.ToUniversalTime().ToString('o') -eq $old.started_utc){throw 'This preview is already running; use stop.ps1 first'}
}
if(-not(Test-Path -LiteralPath $Scrcpy -PathType Leaf)){throw 'Install official scrcpy or supply -Scrcpy with its local executable path'}
if($Size -notmatch '^\d+x\d+$' -or $Fps -lt 1 -or $Fps -gt 30){throw 'Invalid camera size or fps'}
$savedAdb=$env:ADB
try{
    $env:ADB=Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
    if(-not $Serial){$Serial=(& $env:ADB get-serialno | Out-String).Trim();if($LASTEXITCODE -ne 0 -or $Serial -eq 'unknown'){throw 'Select one connected ADB target with -Serial'}}
    # Hide only the console; scrcpy's camera window is intentionally visible for focusing.
    $process=Start-Process -FilePath $Scrcpy -ArgumentList @("--serial=$Serial",'--video-source=camera','--camera-id=0',"--camera-size=$Size","--camera-fps=$Fps",'--no-audio','--window-title=Genio-Camera-Focus') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $directory 'stdout.log') -RedirectStandardError (Join-Path $directory 'stderr.log')
    [ordered]@{pid=$process.Id;executable=$process.Path;started_utc=$process.StartTime.ToUniversalTime().ToString('o');serial=$Serial;size=$Size;fps=$Fps;transport='ADB Camera2 scrcpy';audio=$false;status='START_REQUESTED'} | ConvertTo-Json | Set-Content -LiteralPath $session -Encoding UTF8
    "PREVIEW_PID=$($process.Id)"
}finally{$env:ADB=$savedAdb}
