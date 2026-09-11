# build-windows.ps1 — Build ocedit.exe into the project root and drop a
# Desktop shortcut to it. Re-runnable: cleans up previous build artifacts.

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$SrcTs     = Join-Path $ScriptDir 'src\server.ts'
$OutExe    = Join-Path $ScriptDir 'ocedit.exe'

# 1. Find bun
$BunCmd = Get-Command bun.exe -ErrorAction SilentlyContinue
if (-not $BunCmd) {
    Write-Error "ERROR: bun not found on PATH. Install from https://bun.sh"
    exit 1
}
$Bun = $BunCmd.Source

# 2. Stage bun at an ASCII-only path. `bun build --compile` is bugged on
#    Windows when the user profile contains non-ASCII characters (it tries
#    to derive a temp path and fails); staging bun at C:\Temp\... sidesteps it.
$StageDir = 'C:\Temp\ocedit-stage'
if (-not (Test-Path $StageDir)) { New-Item -ItemType Directory -Path $StageDir -Force | Out-Null }
$AsciiBun = Join-Path $StageDir 'bun.exe'
Copy-Item -LiteralPath $Bun -Destination $AsciiBun -Force

# 3. Stop any running ocedit.exe (locked file would fail the rebuild)
Get-Process -Name ocedit -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 200

# 4. Compile
Write-Host "Building ocedit.exe..."
& $AsciiBun build $SrcTs --compile --target=bun-windows-x64 --outfile $OutExe
if ($LASTEXITCODE -ne 0) { Write-Error "bun build failed"; exit 1 }

# 5. Clean up legacy artifacts (the exe is now self-contained)
foreach ($legacy in @('dist', 'install.bat', 'install.ps1', 'uninstall.bat', 'uninstall.ps1')) {
    $p = Join-Path $ScriptDir $legacy
    if (Test-Path $p) {
        Remove-Item -LiteralPath $p -Recurse -Force
        Write-Host "Removed $p"
    }
}

# 6. Clean up old Desktop artifacts and rebuild shortcut
$desk = [Environment]::GetFolderPath('Desktop')
foreach ($f in @('ocedit.exe', 'index.html', 'app.js')) {
    $p = Join-Path $desk $f
    if (Test-Path $p) { Remove-Item -LiteralPath $p -Force }
}
$lnkPath = Join-Path $desk 'ocedit.lnk'
if (Test-Path $lnkPath) { Remove-Item -LiteralPath $lnkPath -Force }

# 7. Create Desktop shortcut
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = $OutExe
$lnk.WorkingDirectory = $ScriptDir
$lnk.WindowStyle = 1  # normal
$lnk.IconLocation = "$env:SystemRoot\system32\shell32.dll,3"
$lnk.Description = 'opencode session editor'
$lnk.Save()

Write-Host ""
Write-Host "Built:    $OutExe"
Write-Host "Shortcut: $lnkPath"
Write-Host ""
Write-Host "Double-click the desktop shortcut to launch."