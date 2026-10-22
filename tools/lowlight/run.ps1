param(
    [Parameter(Mandatory=$true)][string]$Node,
    [string]$Serial = $env:GENIO_SERIAL,
    [string]$SdkRoot = "$env:LOCALAPPDATA/Android/Sdk",
    [string]$JdkRoot = 'C:/Program Files/Android/Android Studio/jbr',
    [Parameter(Mandatory=$true)][string]$DevelopmentKeystore,
    [ValidatePattern('^[A-Za-z0-9_-]{1,64}$')][string]$JobId = ('lowlight-' + [guid]::NewGuid().ToString('N').Substring(0,12)),
    [string]$ScheduledAt,
    [string]$Roi = '.65,.5,.72,.58',
    [switch]$Preflight
)
$ErrorActionPreference='Stop'
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$logDirectory=Join-Path $projectRoot 'outputs/lowlight-launches'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$env:GENIO_SERIAL=$Serial
$env:GENIO_ANDROID_SDK=$SdkRoot
$env:GENIO_JDK=$JdkRoot
$env:GENIO_CAMERA_KEYSTORE=$DevelopmentKeystore
$arguments=@((Join-Path $PSScriptRoot 'run.mjs'),"--job-id=$JobId","--roi=$Roi")
if($ScheduledAt){$arguments+="--scheduled-at=$ScheduledAt"}
if($Preflight){$arguments+='--preflight'}
& $Node @arguments *> (Join-Path $logDirectory "$JobId.log")
exit $LASTEXITCODE
