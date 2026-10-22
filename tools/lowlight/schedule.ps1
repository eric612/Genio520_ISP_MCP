param(
    [Parameter(Mandatory=$true)][DateTimeOffset]$At,
    [Parameter(Mandatory=$true)][string]$Node,
    [Parameter(Mandatory=$true)][string]$Serial,
    [string]$Roi = '.65,.5,.72,.58',
    [string]$SdkRoot = "$env:LOCALAPPDATA/Android/Sdk",
    [string]$JdkRoot = 'C:/Program Files/Android/Android Studio/jbr',
    [Parameter(Mandatory=$true)][string]$DevelopmentKeystore
)
$ErrorActionPreference='Stop'
if($At -le [DateTimeOffset]::Now){throw 'Schedule must be in the future'}
$roiParts=$Roi.Split(',')
if($roiParts.Count -ne 4){throw 'ROI must have four normalized coordinates'}
$roiValues=@($roiParts | ForEach-Object {
    $coordinate=0.0
    if(-not [double]::TryParse($_,[Globalization.NumberStyles]::Float,[Globalization.CultureInfo]::InvariantCulture,[ref]$coordinate) -or [double]::IsNaN($coordinate) -or $coordinate -lt 0 -or $coordinate -gt 1){throw 'Invalid normalized ROI coordinate'}
    $coordinate
})
if($roiValues[0] -ge $roiValues[2] -or $roiValues[1] -ge $roiValues[3]){throw 'ROI must have positive width and height'}
foreach($file in @($Node,$DevelopmentKeystore,(Join-Path $SdkRoot 'platform-tools/adb.exe'))){
    if(-not(Test-Path -LiteralPath $file -PathType Leaf)){throw "Missing local prerequisite: $file"}
}
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$jobId='lowlight-'+$At.ToString('yyyyMMdd-HHmm')
$taskName='Genio-'+$jobId
if(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue){throw "Task already exists: $taskName"}
# Task Scheduler receives one Windows argument string; prohibit quotes/newlines in values before quoting.
function Quote-TaskArgument([string]$value){
    if($value.Contains('"') -or $value.Contains("`r") -or $value.Contains("`n") -or $value.EndsWith('\')){throw 'Unsafe scheduled argument'}
    return '"'+$value+'"'
}
$parts=@('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'run.ps1'),
    '-Node',$Node,'-Serial',$Serial,'-SdkRoot',$SdkRoot,'-JdkRoot',$JdkRoot,'-DevelopmentKeystore',$DevelopmentKeystore,
    '-JobId',$jobId,'-ScheduledAt',$At.ToString('o'),'-Roi',$Roi)
$argumentString=($parts | ForEach-Object {Quote-TaskArgument $_}) -join ' '
$action=New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument $argumentString -WorkingDirectory $projectRoot
$trigger=New-ScheduledTaskTrigger -Once -At $At.LocalDateTime
$principal=New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -WakeToRun -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
$task=Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'One-shot Genio static lowlight NR diagnostic; no capture if board absent or more than 15 minutes late.'
$out=Join-Path $projectRoot 'outputs/lowlight-schedules'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$record=[ordered]@{task_name=$taskName;job_id=$jobId;scheduled_at=$At.ToString('o');scheduled_utc=$At.UtcDateTime.ToString('o');roi=$roiValues;
    state=[string]$task.State;scope='Static lowlight only; motion test deferred';requires='Windows user logged in, PC available, Genio powered on and connected to P0 USB data';
    result=(Join-Path $projectRoot "outputs/lowlight-jobs/$jobId/job.json")}
$record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out "$jobId.json") -Encoding UTF8
$record | ConvertTo-Json
