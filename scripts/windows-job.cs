using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

// Each service is put in the job before its first instruction can create children.
// Closing the supervisor's last job handle also covers closing the console window.
public sealed class GapGraphJob : IDisposable
{
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
        public ushort ShowWindow, ReservedSize;
        public IntPtr ReservedBytes, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo
    {
        public IntPtr Process, Thread;
        public int Pid, Tid;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeFileHandle CreateJobObject(IntPtr attributes, IntPtr name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(SafeFileHandle job, int kind, ref ExtendedLimits limits, int length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
        ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")]
    private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int kind);
    private delegate bool ConsoleHandler(uint signal);
    [DllImport("kernel32.dll")]
    private static extern bool SetConsoleCtrlHandler(ConsoleHandler handler, bool add);

    private readonly SafeFileHandle job;
    private readonly ConsoleHandler consoleHandler;
    private readonly bool handlerInstalled;
    private volatile bool stopping;
    public bool IsStopping { get { return stopping; } }

    public GapGraphJob()
    {
        job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
        if (job.IsInvalid) throw new Win32Exception();

        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))))
        {
            var error = new Win32Exception();
            job.Dispose();
            throw error;
        }

        consoleHandler = OnConsoleSignal;
        handlerInstalled = SetConsoleCtrlHandler(consoleHandler, true);
    }

    private bool OnConsoleSignal(uint signal)
    {
        if (signal != 0 && signal != 1 && signal != 2) return false;
        stopping = true;
        job.Dispose();
        return signal != 2; // Let Windows close the console after killing the services.
    }

    public Process Start(string application, string arguments, string directory)
    {
        var startup = new StartupInfo {
            Size = Marshal.SizeOf(typeof(StartupInfo)),
            Flags = 0x100, // STARTF_USESTDHANDLES
            Input = GetStdHandle(-10), Output = GetStdHandle(-11), Error = GetStdHandle(-12)
        };
        var commandLine = new StringBuilder("\"" + application + "\" " + arguments);
        ProcessInfo info;
        const uint suspended = 0x0004, newGroup = 0x0200;
        if (!CreateProcess(application, commandLine, IntPtr.Zero, IntPtr.Zero, true, suspended | newGroup,
            IntPtr.Zero, directory, ref startup, out info)) throw new Win32Exception();

        Process process = null;
        try
        {
            if (!AssignProcessToJobObject(job, info.Process)) throw new Win32Exception();
            process = Process.GetProcessById(info.Pid);
            if (process.Handle == IntPtr.Zero) throw new InvalidOperationException("Unable to track the service process.");
            if (ResumeThread(info.Thread) == UInt32.MaxValue) throw new Win32Exception();
            return process;
        }
        catch
        {
            TerminateProcess(info.Process, 1);
            if (process != null) process.Dispose();
            throw;
        }
        finally
        {
            CloseHandle(info.Thread);
            CloseHandle(info.Process);
        }
    }

    public void Dispose()
    {
        if (handlerInstalled) SetConsoleCtrlHandler(consoleHandler, false);
        job.Dispose();
    }
}
