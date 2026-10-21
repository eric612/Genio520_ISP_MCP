# Android USB native deployment probe

Run on the Windows PC while the board is normally booted and connected through USB 3.2 P0. USB 2.0 on the PC is sufficient. No firmware flashing is performed.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\android_probe\verify.ps1
```

The script uses the existing Android SDK platform-tools and NDK, compiles a standalone ARM64 C executable targeting API 26+, uploads the executable and an eight-byte input fixture, verifies the executable SHA256, executes it on Android, downloads the output, and checks every byte against an independently specified expected result.

The execution-policy option applies only to this PowerShell process; it does not change the machine's policy.

The operation is a small saturating multiply-by-two probe, not the IMG_ENHANCE WDR algorithm. A successful probe proves the native USB deployment path; it does not demonstrate image quality, camera/ISP availability, algorithm performance, or firmware download mode.

Each run preserves its sources' build products, fixture, downloaded result and report under `outputs/android-probe/<run-id>`, and its board files under `/data/local/tmp/genio-probe-<run-id>`. The command leaves previous runs intact.

Optional parameters: `-Serial`, `-SdkRoot`, `-NdkVersion`. The default uses the single attached ADB device (or GENIO_SERIAL), the normal Windows SDK location, and NDK 27.0.12077973.
