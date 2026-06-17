import { spawn, execFileSync } from 'child_process';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { platform, tmpdir } from 'os';
import { join } from 'path';

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
  return platform() === 'win32' || platform() === 'darwin' || isWSL();
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

function isPngBuffer(buf: Buffer): boolean {
  return (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  );
}

// macOS pasteboard change counter — increments on every write. We sample it
// around the capture to tell "user grabbed a region" from "user pressed ESC"
// without clearing or reading the user's existing clipboard contents.
function pasteboardChangeCount(): number {
  try {
    const out = execFileSync(
      'osascript',
      ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); $.NSPasteboard.generalPasteboard.changeCount'],
      { encoding: 'utf-8', timeout: 4000 },
    );
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : -1;
  } catch {
    return -1;
  }
}

// macOS region capture via the built-in `screencapture` tool.
//
// We capture to the *clipboard* (-c), NOT to a file. With file output, macOS
// shows the floating screenshot thumbnail after the selection and defers both
// writing the file and exiting the process until that thumbnail times out
// (~5-6s) — which made the capture→paste round-trip feel ~10s slow. Clipboard
// capture shows no thumbnail and the process exits the instant the selection is
// made, so the paste is effectively immediate (matching the WSL path). We then
// pull the PNG off the pasteboard via AppleScript, whose clipboard coercion
// converts the screenshot's native TIFF data to PNG for us.
//
// Cancel (ESC) is detected by the pasteboard changeCount not moving, so we
// never paste a stale image and never touch the user's clipboard on cancel.
const APPLESCRIPT_PNG_CLASS = `${String.fromCharCode(0x00ab)}class PNGf${String.fromCharCode(0x00bb)}`; // «class PNGf»

function captureRegionPngDarwin(): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const before = pasteboardChangeCount();
    const child = spawn('screencapture', ['-i', '-c', '-x'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (c) => stderrChunks.push(c));

    child.on('error', (err) => {
      rejectPromise(new ScreenshotError(`Failed to spawn screencapture: ${err.message}`, 'FAILED'));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
        rejectPromise(new ScreenshotError(`screencapture exited ${code}${stderr ? `: ${stderr}` : ''}`, 'FAILED'));
        return;
      }
      // Nothing written to the pasteboard → ESC-cancel, no region grabbed.
      const after = pasteboardChangeCount();
      if (before !== -1 && after !== -1 && after === before) {
        rejectPromise(new ScreenshotError('Capture canceled', 'CANCELED'));
        return;
      }

      const tmp = join(
        tmpdir(),
        `screenshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
      );
      const cleanup = () => { try { if (existsSync(tmp)) unlinkSync(tmp); } catch {} };
      try {
        execFileSync(
          'osascript',
          [
            '-e', `set f to (open for access POSIX file ${JSON.stringify(tmp)} with write permission)`,
            '-e', `write (the clipboard as ${APPLESCRIPT_PNG_CLASS}) to f`,
            '-e', 'close access f',
          ],
          { timeout: 8000, stdio: ['ignore', 'ignore', 'pipe'] },
        );
      } catch {
        cleanup();
        // changeCount moved but the clipboard had no coercible image — e.g. the
        // user copied non-image content mid-selection. Treat as a cancel rather
        // than pasting garbage.
        rejectPromise(new ScreenshotError('No image on clipboard after capture', 'CANCELED'));
        return;
      }

      let png: Buffer;
      try {
        png = readFileSync(tmp);
      } catch (err) {
        cleanup();
        rejectPromise(new ScreenshotError(`Failed to read screenshot: ${(err as Error).message}`, 'FAILED'));
        return;
      }
      cleanup();
      if (!isPngBuffer(png)) {
        rejectPromise(new ScreenshotError('captured payload was not a PNG', 'FAILED'));
        return;
      }
      resolvePromise(png);
    });
  });
}

// Launches the native region-snip UI for the host OS and resolves with PNG
// bytes. Rejects with ScreenshotError('CANCELED') on user cancel.
export function captureRegionPng(): Promise<Buffer> {
  if (!canCaptureScreen()) {
    return Promise.reject(new ScreenshotError('Screen capture not supported on this platform', 'UNSUPPORTED'));
  }
  if (platform() === 'darwin') return captureRegionPngDarwin();

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
      if (!isPngBuffer(png)) {
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
