param(
    [string]$Serial = $env:GENIO_SERIAL,
    [string]$SdkRoot = $(if ($env:GENIO_ANDROID_SDK) {$env:GENIO_ANDROID_SDK} elseif ($env:ANDROID_HOME) {$env:ANDROID_HOME} else {"$env:LOCALAPPDATA\Android\Sdk"}),
    [string]$NdkVersion = '27.0.12077973'
)
$ErrorActionPreference = 'Stop'
$adb = Join-Path $SdkRoot 'platform-tools\adb.exe'
$ndk = Join-Path $SdkRoot "ndk\$NdkVersion"
$clang = Join-Path $ndk 'toolchains\llvm\prebuilt\windows-x86_64\bin\clang.exe'
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$runId = [guid]::NewGuid().ToString('N').Substring(0, 12)
$outDir = Join-Path $projectRoot "outputs\android-probe\$runId"
$remoteDir = "/data/local/tmp/genio-probe-$runId"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

function Invoke-Adb {
    param([string[]]$Arguments)
    $selector = @()
    if ($Serial) {$selector = @('-s',$Serial)}
    $result = & $adb @selector @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "ADB failed ($LASTEXITCODE): $($Arguments -join ' ')"
    }
    return $result
}

foreach ($toolPath in @($adb, $clang)) {
    if (-not (Test-Path -LiteralPath $toolPath)) { throw "Missing tool: $toolPath" }
}
$state = (Invoke-Adb -Arguments @('get-state') | Out-String).Trim()
if ($state -ne 'device') { throw "Device is not ready: $state" }
if (-not $Serial) {$Serial = (Invoke-Adb -Arguments @('get-serialno') | Out-String).Trim()}
$abi = (Invoke-Adb -Arguments @('shell', 'getprop', 'ro.product.cpu.abi') | Out-String).Trim()
if ($abi -ne 'arm64-v8a') { throw "Expected arm64-v8a, received $abi" }
$android = (Invoke-Adb -Arguments @('shell', 'getprop', 'ro.build.version.release') | Out-String).Trim()
$api = (Invoke-Adb -Arguments @('shell', 'getprop', 'ro.build.version.sdk') | Out-String).Trim()
$apiNumber = 0
if (-not [int]::TryParse($api, [ref]$apiNumber) -or $apiNumber -lt 26) {
    throw "The native probe requires Android API 26 or later: $api"
}

$binary = Join-Path $outDir 'genio_probe'
& $clang '--target=aarch64-linux-android26' '-std=c99' '-O2' '-Wall' '-Wextra' '-Werror' '-fPIE' '-pie' (Join-Path $PSScriptRoot 'probe.c') '-o' $binary
if ($LASTEXITCODE -ne 0) { throw "Native compilation failed: $LASTEXITCODE" }
$inputFile = Join-Path $outDir 'input.raw'
$outputFile = Join-Path $outDir 'output.raw'
[System.IO.File]::WriteAllBytes($inputFile, [byte[]]@(0, 1, 32, 64, 127, 128, 200, 255))
$expected = [byte[]]@(0, 2, 64, 128, 254, 255, 255, 255)
Invoke-Adb -Arguments @('shell', 'mkdir', '-p', $remoteDir) | Out-Null
Invoke-Adb -Arguments @('push', $binary, "$remoteDir/genio_probe") | Out-Null
Invoke-Adb -Arguments @('push', $inputFile, "$remoteDir/input.raw") | Out-Null
$localHash = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
$remoteHashLine = (Invoke-Adb -Arguments @('shell', 'sha256sum', "$remoteDir/genio_probe") | Out-String).Trim()
$remoteHash = ($remoteHashLine -split '\s+')[0].ToLowerInvariant()
if ($localHash -ne $remoteHash) { throw 'Uploaded binary SHA256 does not match' }
Invoke-Adb -Arguments @('shell', 'chmod', '700', "$remoteDir/genio_probe") | Out-Null
$execution = (Invoke-Adb -Arguments @('shell', "$remoteDir/genio_probe", "$remoteDir/input.raw", "$remoteDir/output.raw") | Out-String).Trim()
$executionInfo = $execution | ConvertFrom-Json
if ($executionInfo.status -ne 'ok' -or $executionInfo.abi -ne $abi -or $executionInfo.pixels -ne 8) {
    throw "Unexpected native execution result: $execution"
}
Invoke-Adb -Arguments @('pull', "$remoteDir/output.raw", $outputFile) | Out-Null
$actual = [System.IO.File]::ReadAllBytes($outputFile)
if ($actual.Length -ne $expected.Length) { throw "Incorrect result length: $($actual.Length)" }
for ($i = 0; $i -lt $expected.Length; $i++) {
    if ($actual[$i] -ne $expected[$i]) { throw "Pixel $i mismatch: $($actual[$i]) != $($expected[$i])" }
}
$report = [ordered]@{
    status = 'PASS'
    scope = 'Native compilation, ADB push, binary integrity, ARM64 execution, ADB pull, exact result comparison'
    timestamp_utc = [DateTime]::UtcNow.ToString('o')
    serial = $Serial
    android_release = $android
    android_api = $api
    abi = $abi
    ndk_version = $NdkVersion
    binary_sha256 = $localHash
    remote_directory = $remoteDir
    execution = $executionInfo
    input = @(0, 1, 32, 64, 127, 128, 200, 255)
    expected = @($expected)
    actual = @($actual)
    limitations = 'Deployment probe only; does not validate IMG_ENHANCE quality, real-time performance, cameras, ISP access, or firmware flashing.'
}
$reportPath = Join-Path $outDir 'report.json'
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding UTF8
Write-Output "PASS: Android $android / API $api / $abi"
Write-Output 'PC compiled -> USB uploaded -> board executed -> USB downloaded -> 8/8 bytes matched'
Write-Output "REPORT=$reportPath"
Write-Output "REMOTE=$remoteDir"
