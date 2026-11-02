// The Windows desktop helper (agent workspace design, Components 2; W6): one powershell.exe per
// desktop, compiling a small C# class with Add-Type and speaking JSON lines on stdin and stdout
// (src/core/workspace/protocol.ts). It creates the desktop, launches processes there
// (STARTUPINFO.lpDesktop), lists and photographs that desktop's windows (EnumDesktopWindows,
// PrintWindow with PW_RENDERFULLCONTENT), posts key messages, and closes it. The window calls run on
// a fresh thread attached to the desktop (SetThreadDesktop), one per request: PowerShell's own thread
// is STA and already owns windows, so SetThreadDesktop on it fails with ERROR_BUSY (170).
//
// String.raw on purpose: the script's `[\r\n]+` and C#'s `\"` must reach the file as typed, never as
// bytes (Global Constraint 9). ASCII only: Windows PowerShell 5.1 reads a BOM-less .ps1 in the
// system code page. Nothing here may contain a dollar sign followed by a brace (template syntax).
//
// The two spike traps (docs/agent-workspace-isolation.md): a $null passed for a [string] P/Invoke
// argument arrives as "", so every optional string crosses as [NullString]::Value; and an Add-Type
// that fails is reported on stdout as {"fatal":...} before ready, so the Host can say why.
export const DESK_PS1 = String.raw`$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Say($obj) {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $obj -Compress -Depth 6))
  [Console]::Out.Flush()
}

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class AsteraWindow {
  public IntPtr Hwnd; public string Title; public string ClassName; public int Pid;
  public int Width; public int Height; public bool Visible;
}

public class AsteraShot { public string Data; public int Width; public int Height; public string Title; }

public class AsteraLaunch { public int Pid; public long StartedAt; public bool Job; public string JobError; }

public class AsteraJob { public int Pid; public long StartedAt; public IntPtr Handle; }

public static class AsteraDesk {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
    public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct USEROBJECTFLAGS { public int fInherit; public int fReserved; public int dwFlags; }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr sa);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr h);
  [DllImport("user32.dll")] static extern bool EnumDesktopWindows(IntPtr desk, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool GetUserObjectInformation(IntPtr obj, int index, ref USEROBJECTFLAGS info, int length, ref int needed);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr sa, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);

  const uint GENERIC_ALL = 0x10000000;
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  const uint CREATE_NO_WINDOW = 0x08000000;
  const int JobObjectExtendedLimitInformation = 9;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const int UOI_FLAGS = 1;
  const int WSF_VISIBLE = 1;
  const uint PW_RENDERFULLCONTENT = 2;
  const uint WM_KEYDOWN = 0x0100;
  const uint WM_KEYUP = 0x0101;
  const uint WM_CHAR = 0x0102;
  static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
  // One job per launch that got one, kept until kill ends it. Whatever is left is ended when this
  // process exits and its handles close (KILL_ON_JOB_CLOSE).
  static readonly List<AsteraJob> Jobs = new List<AsteraJob>();

  public static bool Interactive() {
    IntPtr ws = GetProcessWindowStation();
    if (ws == IntPtr.Zero) return false;
    USEROBJECTFLAGS f = new USEROBJECTFLAGS();
    int needed = 0;
    if (!GetUserObjectInformation(ws, UOI_FLAGS, ref f, Marshal.SizeOf(f), ref needed)) return false;
    return (f.dwFlags & WSF_VISIBLE) != 0;
  }

  // The kernel creation time of a live pid in epoch ms, the same clock Launch reports; -1 when no
  // process has that pid (or it cannot be opened), which the kill op reads as already gone.
  public static long StartedAtOf(int pid) {
    IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (h == IntPtr.Zero) return -1;
    try {
      long created, exited, kernel, user;
      if (!GetProcessTimes(h, out created, out exited, out kernel, out user)) return -1;
      return (long)(DateTime.FromFileTimeUtc(created) - Epoch).TotalMilliseconds;
    } finally { CloseHandle(h); }
  }

  public static long StartedAtMs(int pid) {
    return (long)(Process.GetProcessById(pid).StartTime.ToUniversalTime() - Epoch).TotalMilliseconds;
  }

  // Runs f on a new thread attached to desk. A new thread owns no windows and no hooks, which
  // SetThreadDesktop requires; the caller's exception, if any, is rethrown here.
  static T OnDesk<T>(IntPtr desk, Func<T> f) {
    T result = default(T);
    Exception failure = null;
    Thread t = new Thread(delegate () {
      try {
        if (!SetThreadDesktop(desk)) throw new Exception("SetThreadDesktop failed: " + Marshal.GetLastWin32Error());
        result = f();
      } catch (Exception e) { failure = e; }
    });
    t.Start();
    t.Join();
    if (failure != null) throw failure;
    return result;
  }

  public static IntPtr Create(string name) {
    IntPtr h = CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
    if (h == IntPtr.Zero) throw new Exception("CreateDesktop failed: " + Marshal.GetLastWin32Error());
    try { OnDesk(h, delegate () { return true; }); } catch { CloseDesktop(h); throw; }
    return h;
  }

  // A job of its own for a launched process, one that ends every process in it when its last handle
  // closes; this helper holds the only one. Zero breakaway flags: a child leaves a job chain only up to
  // the first job that does not allow breakaway, and this one does not
  // (learn.microsoft.com/windows/win32/procthread/nested-jobs).
  static IntPtr JobFor(IntPtr process) {
    IntPtr job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
    if (job == IntPtr.Zero) throw new Exception("CreateJobObject failed: " + Marshal.GetLastWin32Error());
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    string failed = null;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(info)))
      failed = "SetInformationJobObject failed: " + Marshal.GetLastWin32Error();
    else if (!AssignProcessToJobObject(job, process))
      failed = "AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error();
    if (failed == null) return job;
    CloseHandle(job);
    throw new Exception(failed);
  }

  // Started suspended and put in a job of its own before its first instruction, so nothing it starts,
  // a detached child included, can be outside the job. libuv's detached spawn on Windows asks for no
  // CREATE_BREAKAWAY_FROM_JOB, and its own job for the children it does not detach sets
  // JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK |
  // JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  // (github.com/libuv/libuv/blob/v1.x/src/win/process.c): a process started in that job leaves it,
  // silently or when it asks to, but a breakaway of either kind stops at the first job up the chain
  // that does not allow one, and this one does not (learn.microsoft.com/windows/win32/procthread/nested-jobs;
  // learn.microsoft.com/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject). Ending
  // the job ends the whole tree, and KILL_ON_JOB_CLOSE ends it too when this helper exits (a close,
  // the Host's death, a helper crash): what the manager already does when its helper dies and what the
  // next Host's leftover sweep would do, only complete and at once. A job that cannot be made does not
  // stop the launch; the reply says why, and kill then falls back to taskkill /T.
  public static AsteraLaunch Launch(string commandLine, string cwd, string envBlock, string desktop) {
    // A null lpDesktop means the caller's own desktop, which is the person's screen. Never.
    if (string.IsNullOrEmpty(desktop)) throw new Exception("no desktop to launch on");
    STARTUPINFO si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(si);
    si.lpDesktop = desktop;
    PROCESS_INFORMATION pi;
    IntPtr env = Marshal.StringToHGlobalUni(envBlock);
    try {
      StringBuilder cmd = new StringBuilder(commandLine);
      if (!CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, false, CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW | CREATE_SUSPENDED, env, cwd, ref si, out pi))
        throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(env); }
    IntPtr job = IntPtr.Zero;
    bool resumed = false;
    AsteraLaunch r = null;
    try {
      r = new AsteraLaunch();
      r.Pid = pi.dwProcessId;
      try { job = JobFor(pi.hProcess); } catch (Exception e) { r.JobError = e.Message; }
      if (ResumeThread(pi.hThread) == uint.MaxValue)
        throw new Exception("ResumeThread failed: " + Marshal.GetLastWin32Error() + "; the process was ended before it ran");
      resumed = true;
      long created, exited, kernel, user;
      if (GetProcessTimes(pi.hProcess, out created, out exited, out kernel, out user))
        r.StartedAt = (long)(DateTime.FromFileTimeUtc(created) - Epoch).TotalMilliseconds;
      if (job != IntPtr.Zero) {
        AsteraJob j = new AsteraJob();
        j.Pid = r.Pid; j.StartedAt = r.StartedAt; j.Handle = job;
        Jobs.Add(j);
        r.Job = true;
      }
    } finally {
      // Never a suspended process left behind: one whose thread did not resume is ended here.
      if (!resumed) {
        TerminateProcess(pi.hProcess, 1);
        if (job != IntPtr.Zero) CloseHandle(job);
      }
      CloseHandle(pi.hThread);
      CloseHandle(pi.hProcess);
    }
    return r;
  }

  // Ends the job of the launch with this pid and start time (nearest within the tolerance), and closes its handle; false when this
  // helper holds none for it. A job holds only what that launch started, so unlike a pid it is never
  // someone else's: it is ended even when the launched process itself has already exited. Should
  // TerminateJobObject fail, closing the last handle still ends every process in it (KILL_ON_JOB_CLOSE).
  public static bool EndJob(int pid, long startedAt, long tolerance) {
    // The record whose start time matches exactly, else the nearest one within the tolerance.
    int best = -1;
    long bestGap = long.MaxValue;
    for (int i = 0; i < Jobs.Count; i++) {
      AsteraJob j = Jobs[i];
      long gap = Math.Abs(j.StartedAt - startedAt);
      if (j.Pid != pid || gap > tolerance || gap >= bestGap) continue;
      best = i;
      bestGap = gap;
    }
    if (best < 0) return false;
    AsteraJob found = Jobs[best];
    Jobs.RemoveAt(best);
    TerminateJobObject(found.Handle, 1);
    CloseHandle(found.Handle);
    return true;
  }

  public static List<AsteraWindow> Windows(IntPtr desk) {
    return OnDesk(desk, delegate () { return ListWindows(desk); });
  }

  static List<AsteraWindow> ListWindows(IntPtr desk) {
    List<AsteraWindow> list = new List<AsteraWindow>();
    EnumDesktopWindows(desk, delegate (IntPtr h, IntPtr l) {
      StringBuilder t = new StringBuilder(512); GetWindowText(h, t, t.Capacity);
      StringBuilder c = new StringBuilder(256); GetClassName(h, c, c.Capacity);
      uint pid; GetWindowThreadProcessId(h, out pid);
      RECT r; GetWindowRect(h, out r);
      AsteraWindow w = new AsteraWindow();
      w.Hwnd = h; w.Title = t.ToString(); w.ClassName = c.ToString(); w.Pid = (int)pid;
      w.Width = r.Right - r.Left; w.Height = r.Bottom - r.Top; w.Visible = IsWindowVisible(h);
      list.Add(w);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  static AsteraWindow Find(IntPtr desk, string title) {
    AsteraWindow best = null;
    foreach (AsteraWindow w in ListWindows(desk)) {
      if (!w.Visible || w.Width <= 0 || w.Height <= 0 || w.Title.Length == 0) continue;
      if (title != null && w.Title.IndexOf(title, StringComparison.OrdinalIgnoreCase) < 0) continue;
      if (best == null || (long)w.Width * w.Height > (long)best.Width * best.Height) best = w;
    }
    if (best == null)
      throw new Exception(title == null ? "no window with a title is showing on this desktop" : "no window titled \"" + title + "\" is showing on this desktop");
    return best;
  }

  public static AsteraShot Shot(IntPtr desk, string title, string format, int maxWidth) {
    return OnDesk(desk, delegate () { return ShotOn(desk, title, format, maxWidth); });
  }

  static AsteraShot ShotOn(IntPtr desk, string title, string format, int maxWidth) {
    AsteraWindow w = Find(desk, title);
    using (Bitmap bmp = new Bitmap(w.Width, w.Height, PixelFormat.Format32bppArgb)) {
      using (Graphics g = Graphics.FromImage(bmp)) {
        IntPtr hdc = g.GetHdc();
        bool ok;
        try { ok = PrintWindow(w.Hwnd, hdc, PW_RENDERFULLCONTENT); } finally { g.ReleaseHdc(hdc); }
        if (!ok) throw new Exception("PrintWindow failed for \"" + w.Title + "\"");
      }
      Bitmap output = bmp;
      bool scaled = false;
      if (maxWidth > 0 && bmp.Width > maxWidth) {
        int h = Math.Max(1, (int)((long)bmp.Height * maxWidth / bmp.Width));
        output = new Bitmap(maxWidth, h);
        scaled = true;
        using (Graphics g2 = Graphics.FromImage(output)) {
          g2.InterpolationMode = InterpolationMode.HighQualityBilinear;
          g2.DrawImage(bmp, 0, 0, maxWidth, h);
        }
      }
      try {
        using (MemoryStream ms = new MemoryStream()) {
          output.Save(ms, format == "jpeg" ? ImageFormat.Jpeg : ImageFormat.Png);
          AsteraShot s = new AsteraShot();
          s.Data = Convert.ToBase64String(ms.ToArray()); s.Width = output.Width; s.Height = output.Height; s.Title = w.Title;
          return s;
        }
      } finally { if (scaled) output.Dispose(); }
    }
  }

  static IntPtr RenderTarget(IntPtr top) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(top, delegate (IntPtr h, IntPtr l) {
      StringBuilder c = new StringBuilder(256); GetClassName(h, c, c.Capacity);
      if (c.ToString() == "Chrome_RenderWidgetHostHWND") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found == IntPtr.Zero ? top : found;
  }

  static int Vk(string key) {
    switch (key) {
      case "Enter": return 0x0D; case "Escape": return 0x1B; case "Tab": return 0x09;
      case "Backspace": return 0x08; case "Delete": return 0x2E; case "Space": return 0x20;
      case "ArrowUp": return 0x26; case "ArrowDown": return 0x28; case "ArrowLeft": return 0x25; case "ArrowRight": return 0x27;
      case "Home": return 0x24; case "End": return 0x23; case "PageUp": return 0x21; case "PageDown": return 0x22;
    }
    throw new Exception("unknown key " + key);
  }

  public static void Keys(IntPtr desk, string title, string text, string key) {
    OnDesk(desk, delegate () { KeysOn(desk, title, text, key); return true; });
  }

  static void KeysOn(IntPtr desk, string title, string text, string key) {
    IntPtr target = RenderTarget(Find(desk, title).Hwnd);
    if (key != null) {
      int vk = Vk(key);
      long scan = MapVirtualKey((uint)vk, 0);
      long down = 1L | (scan << 16);
      long up = down | 0xC0000000L;
      PostMessage(target, WM_KEYDOWN, new IntPtr(vk), new IntPtr(down));
      if (vk == 0x0D || vk == 0x20 || vk == 0x09) PostMessage(target, WM_CHAR, new IntPtr(vk), new IntPtr(down));
      PostMessage(target, WM_KEYUP, new IntPtr(vk), new IntPtr(up));
    }
    if (text != null) foreach (char ch in text) PostMessage(target, WM_CHAR, new IntPtr(ch), new IntPtr(1));
  }
}
'@

try {
  Add-Type -TypeDefinition $source -ReferencedAssemblies System.Drawing
} catch {
  Say @{ fatal = ('Add-Type failed: ' + ($_.Exception.Message -replace '[\r\n]+', ' ')) }
  exit 1
}

$me = [System.Diagnostics.Process]::GetCurrentProcess()
Say @{ ready = $true; interactive = [AsteraDesk]::Interactive(); pid = $me.Id; startedAt = [AsteraDesk]::StartedAtMs($me.Id) }

$desk = [IntPtr]::Zero
$deskName = [NullString]::Value

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  try { $req = ConvertFrom-Json -InputObject $line } catch { continue }
  $id = [int]$req.id
  try {
    $value = $null
    switch ([string]$req.op) {
      'create' {
        $desk = [AsteraDesk]::Create([string]$req.name)
        $deskName = [string]$req.name
        $value = @{ name = $deskName }
      }
      'launch' {
        if ($desk -eq [IntPtr]::Zero) { throw 'no desktop to launch on: create was not called' }
        $cwd = [NullString]::Value
        if ($req.cwd) { $cwd = [string]$req.cwd }
        $pairs = @($req.env.PSObject.Properties | Sort-Object Name | ForEach-Object { $_.Name + '=' + [string]$_.Value })
        $block = [string]::Join([string][char]0, [string[]]$pairs) + [char]0 + [char]0
        $r = [AsteraDesk]::Launch([string]$req.commandLine, $cwd, $block, $deskName)
        $value = @{ pid = $r.Pid; startedAt = $r.StartedAt; job = $r.Job }
        if (-not $r.Job) { $value.jobError = $r.JobError }
      }
      'kill' {
        # The launch's job first: it ends everything the launch started, wherever its parent went,
        # and holds nothing else (Launch, EndJob). Within the lifecycle tolerance
        # (START_TIME_TOLERANCE_MS, lifecycle.ts), as below.
        $tolerance = 2000
        if ([AsteraDesk]::EndJob([int]$req.pid, [int64]$req.startedAt, $tolerance)) {
          $value = @{ killed = $true }
          break
        }
        # No job for it (its launch could not make one): only the process launched, by pid. Windows
        # hands pids out again, so a pid whose creation time is further than the tolerance from the
        # launch's is someone else's and is left alone. The reply says why nothing was killed.
        $live = [AsteraDesk]::StartedAtOf([int]$req.pid)
        if ($live -lt 0) {
          $value = @{ killed = $false; reason = ('pid ' + [int]$req.pid + ' is not running') }
          break
        }
        if ([Math]::Abs($live - [int64]$req.startedAt) -gt $tolerance) {
          $value = @{ killed = $false; reason = ('start time mismatch: pid ' + [int]$req.pid + ' started at ' + $live + ', not ' + [int64]$req.startedAt) }
          break
        }
        # Through cmd so taskkill's stderr (a process already gone) never becomes a PowerShell error
        # under $ErrorActionPreference = 'Stop'.
        & cmd.exe /c ('taskkill /T /F /PID ' + [int]$req.pid + ' >nul 2>&1')
        $value = @{ killed = $true }
      }
      'windows' {
        $value = @([AsteraDesk]::Windows($desk) | ForEach-Object {
          @{ hwnd = [int64]$_.Hwnd; title = $_.Title; className = $_.ClassName; pid = $_.Pid; width = $_.Width; height = $_.Height; visible = $_.Visible }
        })
      }
      'shot' {
        $title = [NullString]::Value
        if ($req.title) { $title = [string]$req.title }
        $max = 0
        if ($req.maxWidth) { $max = [int]$req.maxWidth }
        $s = [AsteraDesk]::Shot($desk, $title, [string]$req.format, $max)
        $value = @{ data = $s.Data; width = $s.Width; height = $s.Height; title = $s.Title }
      }
      'keys' {
        $text = [NullString]::Value
        if ($req.text) { $text = [string]$req.text }
        $key = [NullString]::Value
        if ($req.key) { $key = [string]$req.key }
        [AsteraDesk]::Keys($desk, [string]$req.title, $text, $key)
        $value = @{ sent = $true }
      }
      'close' {
        if ($desk -ne [IntPtr]::Zero) { [void][AsteraDesk]::CloseDesktop($desk); $desk = [IntPtr]::Zero }
        Say @{ id = $id; ok = $true; value = @{ closed = $true } }
        exit 0
      }
      default { throw ('unknown op ' + [string]$req.op) }
    }
    Say @{ id = $id; ok = $true; value = $value }
  } catch {
    # A C# throw arrives wrapped in a MethodInvocationException ("Exception calling ..." in the
    # system language); the helper's own words are the innermost message.
    $err = $_.Exception
    while ($err.InnerException) { $err = $err.InnerException }
    Say @{ id = $id; ok = $false; error = ($err.Message -replace '[\r\n]+', ' ') }
  }
}

if ($desk -ne [IntPtr]::Zero) { [void][AsteraDesk]::CloseDesktop($desk) }
`
