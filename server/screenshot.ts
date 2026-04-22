import { spawn, execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { platform } from 'os';

// PowerShell script: clear clipboard, trigger native region-snip UI, poll
// clipboard for an image, emit raw PNG bytes on stdout. The snip host is
// ScreenClippingHost.exe (Win11) or SnippingTool.exe (Win10 / fallback).
// We watch those processes so an Escape-cancel exits fast instead of waiting
// the full timeout. Exit 2 = timeout, 3 = canceled, 4 = launch failed.
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

try { [System.Windows.Forms.Clipboard]::Clear() } catch {}

$launched = $false
try { Start-Process "ms-screenclip:" -ErrorAction Stop; $launched = $true } catch {}
if (-not $launched) {
    try { Start-Process "explorer.exe" "ms-screenclip:" -ErrorAction Stop; $launched = $true } catch {}
}
if (-not $launched) {
    try { Start-Process "SnippingTool.exe" "/clip" -ErrorAction Stop; $launched = $true } catch {}
}
if (-not $launched) {
    [Console]::Error.Write("LAUNCH_FAILED")
    exit 4
}

$snipNames = @('ScreenClippingHost','SnippingTool')
$deadline = [DateTime]::UtcNow.AddSeconds(60)
$startupDeadline = [DateTime]::UtcNow.AddMilliseconds(1500)
$sawSnipProcess = $false
$image = $null

while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 120
    try {
        if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
            $image = [System.Windows.Forms.Clipboard]::GetImage()
            if ($null -ne $image) { break }
        }
    } catch {}

    $procAlive = $false
    foreach ($n in $snipNames) {
        if (Get-Process -Name $n -ErrorAction SilentlyContinue) { $procAlive = $true; break }
    }
    if ($procAlive) { $sawSnipProcess = $true }
    elseif ($sawSnipProcess) {
        # Snip UI appeared then closed without writing clipboard → canceled.
        # Give it 400ms in case clipboard write is still propagating.
        Start-Sleep -Milliseconds 400
        if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
            $image = [System.Windows.Forms.Clipboard]::GetImage()
            if ($null -ne $image) { break }
        }
        [Console]::Error.Write("CANCELED")
        exit 3
    }
    elseif ([DateTime]::UtcNow -gt $startupDeadline) {
        # Snip UI never appeared — launcher silently failed.
        [Console]::Error.Write("LAUNCH_FAILED")
        exit 4
    }
}

if ($null -eq $image) {
    [Console]::Error.Write("TIMEOUT")
    exit 2
}

$ms = New-Object System.IO.MemoryStream
try {
    $image.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    $stdout = [Console]::OpenStandardOutput()
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
} finally {
    $image.Dispose()
    $ms.Dispose()
    try { [System.Windows.Forms.Clipboard]::Clear() } catch {}
}
`;

let cachedIsWSL: boolean | null = null;

export function isWSL(): boolean {
  if (cachedIsWSL !== null) return cachedIsWSL;
  if (platform() !== 'linux') {
    cachedIsWSL = false;
    return false;
  }
  try {
    const v = readFileSync('/proc/version', 'utf-8').toLowerCase();
    cachedIsWSL = v.includes('microsoft') || v.includes('wsl');
  } catch {
    cachedIsWSL = false;
  }
  return cachedIsWSL;
}

export function canCaptureScreen(): boolean {
  return platform() === 'win32' || isWSL();
}

function resolvePowershell(): string {
  if (platform() === 'win32') return 'powershell.exe';
  // WSL: powershell.exe should be reachable via interop PATH. If it isn't, fall
  // back to the canonical mount path so the feature still works with
  // appendWindowsPath=false in /etc/wsl.conf.
  const mounted = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  if (existsSync(mounted)) return mounted;
  return 'powershell.exe';
}

export type ScreenshotErrorCode = 'TIMEOUT' | 'CANCELED' | 'LAUNCH_FAILED' | 'UNSUPPORTED' | 'FAILED';

export class ScreenshotError extends Error {
  constructor(message: string, public code: ScreenshotErrorCode) {
    super(message);
    this.name = 'ScreenshotError';
  }
}

// Launches the native Windows region-snip UI and resolves with PNG bytes.
// Rejects with ScreenshotError('TIMEOUT') if the user cancels or waits >60s.
export function captureRegionPng(): Promise<Buffer> {
  if (!canCaptureScreen()) {
    return Promise.reject(new ScreenshotError('Screen capture requires Windows or WSL', 'UNSUPPORTED'));
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
    const child = spawn(resolvePowershell(), [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Sta',
      '-EncodedCommand', encoded,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));

    child.on('error', (err) => {
      rejectPromise(new ScreenshotError(`Failed to spawn powershell: ${err.message}`, 'FAILED'));
    });

    child.on('close', (code) => {
      if (code === 2) {
        rejectPromise(new ScreenshotError('Capture timed out', 'TIMEOUT'));
        return;
      }
      if (code === 3) {
        rejectPromise(new ScreenshotError('Capture canceled', 'CANCELED'));
        return;
      }
      if (code === 4) {
        rejectPromise(new ScreenshotError('Could not launch Windows snip UI', 'LAUNCH_FAILED'));
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        rejectPromise(new ScreenshotError(`powershell exited ${code}: ${stderr.trim()}`, 'FAILED'));
        return;
      }
      const png = Buffer.concat(stdoutChunks);
      const isPng =
        png.length >= 8 &&
        png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47 &&
        png[4] === 0x0d && png[5] === 0x0a && png[6] === 0x1a && png[7] === 0x0a;
      if (!isPng) {
        rejectPromise(new ScreenshotError('captured payload was not a PNG', 'FAILED'));
        return;
      }
      resolvePromise(png);
    });
  });
}

// Convert a WSL path (/home/x/foo) to a Windows path (\\wsl.localhost\...\foo).
// Returns null on non-WSL or on conversion failure.
export function wslPathToWindows(linuxPath: string): string | null {
  if (!isWSL()) return null;
  try {
    const out = execFileSync('wslpath', ['-w', linuxPath], { encoding: 'utf-8', timeout: 2000 });
    return out.trim() || null;
  } catch {
    return null;
  }
}
