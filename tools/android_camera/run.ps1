param(
    [string]$Serial = $env:GENIO_SERIAL,
    [ValidateSet('capture','controls')][string]$Suite = 'controls',
    [ValidatePattern('^[A-Za-z0-9_-]{1,64}$')][string]$RunId = ('camera-' + [guid]::NewGuid().ToString('N').Substring(0,12)),
    [ValidatePattern('^[0-9]+$')][string]$CameraId = '0',
    [string]$SdkRoot = $(if ($env:GENIO_ANDROID_SDK) {$env:GENIO_ANDROID_SDK} elseif ($env:ANDROID_HOME) {$env:ANDROID_HOME} else {"$env:LOCALAPPDATA\Android\Sdk"}),
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$adb = Join-Path $SdkRoot 'platform-tools\adb.exe'
$apk = Join-Path $projectRoot 'outputs\android-camera\build\genio-camera-probe.apk'
$output = Join-Path $projectRoot "outputs\camera-runs\$RunId"
if (Test-Path -LiteralPath $output) {throw "Run already exists: $RunId"}
New-Item -ItemType Directory -Path $output -Force | Out-Null
function Invoke-Adb([string[]]$Arguments) {
    $selector = @()
    if ($Serial) {$selector = @('-s',$Serial)}
    $value = & $adb @selector @Arguments
    if ($LASTEXITCODE -ne 0) {throw "ADB failed ($LASTEXITCODE): $($Arguments -join ' ')"}
    return $value
}
if (-not $SkipBuild) { & (Join-Path $PSScriptRoot 'build.ps1') -SdkRoot $SdkRoot }
if (-not $Serial) {$Serial = (Invoke-Adb -Arguments @('get-serialno') | Out-String).Trim()}
$buildInfo = Get-Content -LiteralPath (Join-Path (Split-Path $apk -Parent) 'build.json') -Raw | ConvertFrom-Json
$currentSourceHash = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'src\com\genio\cameraprobe\ProbeActivity.java') -Algorithm SHA256).Hash.ToLowerInvariant()
$currentManifestHash = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'AndroidManifest.xml') -Algorithm SHA256).Hash.ToLowerInvariant()
if ($currentSourceHash -ne $buildInfo.java_source_sha256 -or $currentManifestHash -ne $buildInfo.manifest_sha256) {throw 'Sources changed since the APK was built; rebuild first'}
$runApk = Join-Path $output 'genio-camera-probe.apk'
Copy-Item -LiteralPath $apk -Destination $runApk
$apkHash = (Get-FileHash -LiteralPath $runApk -Algorithm SHA256).Hash.ToLowerInvariant()
if ($apkHash -ne $buildInfo.apk_sha256) {throw 'APK hash differs from its build record'}
Invoke-Adb -Arguments @('install','-r','-t',$runApk) | Out-Null
Invoke-Adb -Arguments @('shell','pm','grant','com.genio.cameraprobe','android.permission.CAMERA') | Out-Null
Invoke-Adb -Arguments @('shell','am','force-stop','com.mediatek.camera') | Out-Null
Invoke-Adb -Arguments @('shell','am','force-stop','com.genio.cameraprobe') | Out-Null
Invoke-Adb -Arguments @('shell','input','keyevent','KEYCODE_WAKEUP') | Out-Null
Invoke-Adb -Arguments @('shell','wm','dismiss-keyguard') | Out-Null
Invoke-Adb -Arguments @('shell','am','start','-W','-n','com.genio.cameraprobe/.ProbeActivity','--es','run_id',$RunId,'--es','suite',$Suite,'--es','camera_id',$CameraId) | Out-Null
$remote = "/sdcard/Android/data/com.genio.cameraprobe/files/$RunId"
$timer = [System.Diagnostics.Stopwatch]::StartNew()
$lastProgress = ''
$complete = $false
while ($timer.Elapsed.TotalSeconds -lt 150) {
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $selector = @()
    if ($Serial) {$selector = @('-s',$Serial)}
    $text = & $adb @selector shell cat "$remote/report.json" 2>$null
    $readExitCode = $LASTEXITCODE
    $ErrorActionPreference = $savedPreference
    if ($readExitCode -eq 0) {
        try {$report = ($text -join "`n") | ConvertFrom-Json} catch {Start-Sleep -Milliseconds 500; continue}
        $progress = "$($report.status) $($report.current_case)"
        if ($progress -ne $lastProgress) {Write-Output $progress; $lastProgress=$progress}
        if ($report.status -ne 'RUNNING') {$complete=$true; break}
    }
    Start-Sleep -Milliseconds 500
}
if (-not $complete) {throw "Camera run timed out; board artifacts: $remote"}
Invoke-Adb -Arguments @('pull',"$remote/.",$output) | Out-Null
$provenance = [ordered]@{
    timestamp_utc=[DateTime]::UtcNow.ToString('o'); serial=$Serial; suite=$Suite; run_id=$RunId
    apk_sha256=$apkHash
    java_source_sha256=$buildInfo.java_source_sha256
    manifest_sha256=$buildInfo.manifest_sha256
    build=$buildInfo
    remote_directory=$remote
}
$provenance | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'provenance.json') -Encoding UTF8
foreach ($case in $report.cases) {
    foreach ($frame in $case.frames) {
        if ($frame.image_timestamp_ns -ne $frame.sensor_timestamp_ns) {throw 'Image/result timestamp mismatch'}
        if ($frame.nv21) {
            $rawFile = Join-Path $output $frame.nv21
            if ((Get-Item -LiteralPath $rawFile).Length -ne ($report.width * $report.height * 3 / 2)) {throw 'Incorrect downloaded NV21 size'}
        }
    }
}
Write-Output "REPORT=$(Join-Path $output 'report.json')"
if ($report.status -ne 'PASS') {throw "Camera run finished: $($report.status) $($report.error)"}
