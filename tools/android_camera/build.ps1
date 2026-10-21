param(
    [string]$SdkRoot = $(if ($env:GENIO_ANDROID_SDK) {$env:GENIO_ANDROID_SDK} elseif ($env:ANDROID_HOME) {$env:ANDROID_HOME} else {"$env:LOCALAPPDATA\Android\Sdk"}),
    [string]$JdkRoot = $(if ($env:GENIO_JDK) {$env:GENIO_JDK} elseif ($env:JAVA_HOME) {$env:JAVA_HOME} else {'C:\Program Files\Android\Android Studio\jbr'}),
    [string]$DevelopmentKeystore = $env:GENIO_CAMERA_KEYSTORE
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$build = Join-Path $projectRoot 'outputs\android-camera\build'
$classes = Join-Path $build 'classes'
$dex = Join-Path $build 'dex'
New-Item -ItemType Directory -Path $classes,$dex -Force | Out-Null
$androidJar = Join-Path $SdkRoot 'platforms\android-35\android.jar'
$tools = Join-Path $SdkRoot 'build-tools\35.0.0'
$rawApk = Join-Path $build 'raw.apk'
$alignedApk = Join-Path $build 'aligned.apk'
$apk = Join-Path $build 'genio-camera-probe.apk'
$keystore = if ($DevelopmentKeystore) {$DevelopmentKeystore} else {Join-Path $build 'development.keystore'}
if ($DevelopmentKeystore -and -not (Test-Path -LiteralPath $DevelopmentKeystore -PathType Leaf)) {throw 'GENIO_CAMERA_KEYSTORE must name an existing local development keystore'}
function Check-NativeExit([string]$Stage) { if ($LASTEXITCODE -ne 0) {throw "$Stage failed ($LASTEXITCODE)"} }
foreach ($p in @($androidJar,(Join-Path $JdkRoot 'bin\javac.exe'),(Join-Path $tools 'aapt2.exe'))) {
    if (-not (Test-Path -LiteralPath $p)) {throw "Missing build tool: $p"}
}
& (Join-Path $JdkRoot 'bin\javac.exe') --release 8 -classpath $androidJar -d $classes (Join-Path $PSScriptRoot 'src\com\genio\cameraprobe\ProbeActivity.java')
Check-NativeExit 'javac'
$classFiles = @(Get-ChildItem -LiteralPath $classes -Recurse -Filter '*.class' | ForEach-Object {$_.FullName})
$oldJavaHome = $env:JAVA_HOME
try {
    $env:JAVA_HOME = $JdkRoot
    & (Join-Path $tools 'd8.bat') --lib $androidJar --min-api 26 --output $dex @classFiles
    Check-NativeExit 'd8'
    & (Join-Path $tools 'aapt2.exe') link -I $androidJar --manifest (Join-Path $PSScriptRoot 'AndroidManifest.xml') -o $rawApk
    Check-NativeExit 'aapt2'
    & (Join-Path $JdkRoot 'bin\jar.exe') uf $rawApk -C $dex classes.dex
    Check-NativeExit 'jar'
    & (Join-Path $tools 'zipalign.exe') -f 4 $rawApk $alignedApk
    Check-NativeExit 'zipalign'
    if (-not (Test-Path -LiteralPath $keystore)) {
        & (Join-Path $JdkRoot 'bin\keytool.exe') -genkeypair -keystore $keystore -alias genio-development -storepass android -keypass android -dname 'CN=Genio Camera Probe Development' -keyalg RSA -keysize 2048 -validity 3650
        Check-NativeExit 'development key generation'
    }
    & (Join-Path $tools 'apksigner.bat') sign --ks $keystore --ks-pass pass:android --key-pass pass:android --out $apk $alignedApk
    Check-NativeExit 'apksigner'
    & (Join-Path $tools 'apksigner.bat') verify $apk
    Check-NativeExit 'APK signature verification'
} finally { $env:JAVA_HOME = $oldJavaHome }
$buildRecord = [ordered]@{
    timestamp_utc=[DateTime]::UtcNow.ToString('o')
    apk_sha256=(Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
    java_source_sha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'src\com\genio\cameraprobe\ProbeActivity.java') -Algorithm SHA256).Hash.ToLowerInvariant()
    manifest_sha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'AndroidManifest.xml') -Algorithm SHA256).Hash.ToLowerInvariant()
    compile_sdk=35; build_tools='35.0.0'; min_sdk=26
}
$buildRecord | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $build 'build.json') -Encoding UTF8
Write-Output "APK=$apk"
