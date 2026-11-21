'use strict';

// Launch in the job atomically, so neither a fast fork nor a launcher failure can leave an unowned shell.
module.exports = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$token = $env:AI_FREE_JOB_TOKEN
$application = $env:AI_FREE_JOB_APPLICATION
$line = $env:AI_FREE_JOB_COMMAND_LINE
foreach ($key in @('AI_FREE_JOB_TOKEN', 'AI_FREE_JOB_APPLICATION', 'AI_FREE_JOB_COMMAND_LINE')) {
  [Environment]::SetEnvironmentVariable($key, $null)
}
try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public static class AiFreeCommandJob {
  const uint KillOnJobClose = 0x2000;
  const uint JobListAttribute = 0x2000D;
  const uint ExtendedStartupInfo = 0x80000;
  const uint CreateNoWindow = 0x08000000;

  [StructLayout(LayoutKind.Sequential)] struct JobLimits {
    public long PerProcessTime, PerJobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct JobAccounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupInfo {
    public int Size;
    public IntPtr Reserved, Desktop, Title;
    public uint X, Y, Width, Height, CharsX, CharsY, Fill, Flags;
    public ushort Show, ReservedLength;
    public IntPtr ReservedBytes, StdIn, StdOut, StdErr;
    public IntPtr Attributes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint ProcessId, ThreadId;
  }
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
    public int Size;
    public IntPtr Descriptor;
    public int Inherit;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref JobLimits value, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out JobAccounting value, int size, IntPtr written);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttrs, IntPtr threadAttrs, bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfo startup, out ProcessInfo process);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string file, uint access, uint share, ref SecurityAttributes attrs, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static void Check(bool ok) {
    if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error());
  }

  static IntPtr StartInJob(IntPtr job, string application, string line) {
    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
    IntPtr list = Marshal.AllocHGlobal(size);
    IntPtr jobValue = IntPtr.Zero;
    IntPtr devNull = new IntPtr(-1);
    bool initialized = false;
    try {
      Check(InitializeProcThreadAttributeList(list, 1, 0, ref size));
      initialized = true;
      jobValue = Marshal.AllocHGlobal(IntPtr.Size);
      Marshal.WriteIntPtr(jobValue, job);
      Check(UpdateProcThreadAttribute(list, 0, new UIntPtr(JobListAttribute), jobValue, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
      var security = new SecurityAttributes { Size = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = 1 };
      devNull = CreateFile("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero);
      Check(devNull != new IntPtr(-1));
      var startup = new StartupInfo {
        Size = Marshal.SizeOf(typeof(StartupInfo)), Attributes = list, Flags = 0x100,
        StdIn = devNull, StdOut = GetStdHandle(-11), StdErr = GetStdHandle(-12)
      };
      ProcessInfo child;
      Check(CreateProcess(application, new StringBuilder(line), IntPtr.Zero, IntPtr.Zero, true,
        ExtendedStartupInfo | CreateNoWindow, IntPtr.Zero, null, ref startup, out child));
      CloseHandle(child.Thread);
      return child.Process;
    } finally {
      if (devNull != new IntPtr(-1)) CloseHandle(devNull);
      if (initialized) DeleteProcThreadAttributeList(list);
      Marshal.FreeHGlobal(jobValue);
      Marshal.FreeHGlobal(list);
    }
  }

  static uint ActiveProcesses(IntPtr job) {
    JobAccounting accounting;
    Check(QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf(typeof(JobAccounting)), IntPtr.Zero));
    return accounting.ActiveProcesses;
  }

  static string WaitForJob(IntPtr job, IntPtr child, Task cancel) {
    while (ActiveProcesses(job) != 0) {
      if (cancel.IsCompleted) {
        Check(TerminateJobObject(job, 1));
        var clock = Stopwatch.StartNew();
        while (ActiveProcesses(job) != 0) {
          if (clock.ElapsedMilliseconds >= 4000) return "unconfirmed:";
          Thread.Sleep(20);
        }
        return "cancelled:";
      }
      Thread.Sleep(20);
    }
    uint code;
    Check(GetExitCodeProcess(child, out code));
    return "exit:" + code;
  }

  public static string Run(string application, string line, string token) {
    IntPtr job = IntPtr.Zero;
    IntPtr child = IntPtr.Zero;
    try {
      var cancel = Task.Factory.StartNew(() => Console.OpenStandardInput().ReadByte(), TaskCreationOptions.LongRunning);
      job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
      Check(job != IntPtr.Zero);
      var limits = new JobLimits { Flags = KillOnJobClose };
      Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(JobLimits))));
      if (cancel.IsCompleted) return "cancelled:";
      Console.Error.Write("\u001e" + token + ":ready:\u001f");
      child = StartInJob(job, application, line);
      return WaitForJob(job, child, cancel);
    } catch (Exception error) {
      Console.Error.WriteLine(error.Message);
      return child == IntPtr.Zero ? "launch_failed:" : "unconfirmed:";
    } finally {
      if (job != IntPtr.Zero) CloseHandle(job);
      if (child != IntPtr.Zero) CloseHandle(child);
    }
  }
}
'@
  [Environment]::SetEnvironmentVariable('APPDATA', $null)
  [Environment]::SetEnvironmentVariable('PSModulePath', $null)
  $env:USERPROFILE = $env:AI_WORKSPACE
  $verdict = [AiFreeCommandJob]::Run($application, $line, $token)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  $verdict = 'launch_failed:'
}
[Console]::Error.Write(([char]30).ToString() + $token + ':' + $verdict + [char]31)
`;
