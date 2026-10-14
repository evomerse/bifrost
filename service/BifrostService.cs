// Bifrost Windows service host (C# 5 / .NET Framework 4.x, built with the csc.exe that ships
// with Windows: no SDK needed).
//
// Why a service: a service runs as LocalSystem before anyone logs in and lives in session 0,
// which has no desktop. To capture the screen, including the logon screen and UAC prompts
// (secure desktop), the agent must run as SYSTEM *inside the interactive session*. This host
// therefore watches the active console session and keeps one agent process running in it
// with a SYSTEM token whose session id is switched to the console session. It restarts the
// agent on crash and moves it when the console session changes (logoff, fast user switching).
//
// The service itself holds no secrets and exposes no network port.
//
// Debug mode: BifrostService.exe --console   (runs the same supervisor in the foreground,
// launching the agent as the current user; used by the tests).

using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Threading;

namespace Bifrost
{
    internal sealed class Logger
    {
        private readonly string path;
        private readonly object gate = new object();

        public Logger(string path) { this.path = path; }

        public void Write(string message)
        {
            lock (gate)
            {
                try
                {
                    FileInfo fi = new FileInfo(path);
                    if (fi.Exists && fi.Length > 2 * 1024 * 1024)
                    {
                        string old = path + ".1";
                        if (File.Exists(old)) File.Delete(old);
                        File.Move(path, old);
                    }
                    File.AppendAllText(path, DateTime.Now.ToString("s") + " " + message + Environment.NewLine);
                }
                catch { /* logging must never take the service down */ }
            }
        }
    }

    internal static class Native
    {
        public const uint NoSession = 0xFFFFFFFF;
        public const uint WaitTimeout = 0x102;
        public const uint TokenAllAccess = 0xF01FF;
        public const int SecurityImpersonation = 2;
        public const int TokenPrimary = 1;
        public const int TokenSessionId = 12;
        public const uint CreateUnicodeEnvironment = 0x00000400;
        public const uint CreateNoWindow = 0x08000000;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2;
            public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_INFORMATION
        {
            public IntPtr hProcess, hThread;
            public int dwProcessId, dwThreadId;
        }

        [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
        [DllImport("kernel32.dll")] public static extern bool ProcessIdToSessionId(uint pid, out uint sessionId);
        [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool DuplicateTokenEx(IntPtr existing, uint access, IntPtr attrs, int impersonationLevel, int tokenType, out IntPtr newToken);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool SetTokenInformation(IntPtr token, int infoClass, ref uint info, uint length);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool CreateProcessAsUser(IntPtr token, string application, string commandLine,
            IntPtr processAttrs, IntPtr threadAttrs, bool inheritHandles, uint flags, IntPtr environment,
            string currentDirectory, ref STARTUPINFO startup, out PROCESS_INFORMATION info);

        [DllImport("userenv.dll", SetLastError = true)]
        public static extern bool CreateEnvironmentBlock(out IntPtr environment, IntPtr token, bool inherit);

        [DllImport("userenv.dll", SetLastError = true)]
        public static extern bool DestroyEnvironmentBlock(IntPtr environment);
    }

    internal sealed class Child
    {
        public IntPtr Handle;
        public int Pid;
        public uint SessionId;
        public DateTime Started;
    }

    /// <summary>Keeps exactly one agent running in the active console session.</summary>
    internal sealed class Supervisor
    {
        private readonly string baseDir;
        private readonly string dataDir;
        private readonly bool consoleMode;
        private readonly Logger log;
        private readonly ManualResetEvent stop = new ManualResetEvent(false);
        private readonly AutoResetEvent wake = new AutoResetEvent(false);
        private Thread thread;
        private Child child;
        private DateTime nextStart = DateTime.MinValue;
        private int backoffSeconds = 2;

        public Supervisor(string baseDir, bool consoleMode, Logger log)
        {
            this.baseDir = baseDir;
            this.consoleMode = consoleMode;
            this.log = log;
            string env = Environment.GetEnvironmentVariable("BIFROST_DATA_DIR");
            this.dataDir = !string.IsNullOrEmpty(env)
                ? env
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Bifrost");
        }

        public string DataDir { get { return dataDir; } }

        public void Start()
        {
            Directory.CreateDirectory(dataDir);
            KillStaleAgent();
            thread = new Thread(Run);
            thread.IsBackground = true;
            thread.Name = "bifrost-supervisor";
            thread.Start();
        }

        public void Wake() { wake.Set(); }

        public void Stop()
        {
            stop.Set();
            if (thread != null) thread.Join(8000);
            StopChild("service stopping");
        }

        private void Run()
        {
            WaitHandle[] handles = new WaitHandle[] { stop, wake };
            while (!stop.WaitOne(0))
            {
                try { Tick(); }
                catch (Exception e) { log.Write("supervisor error: " + e.Message); }
                WaitHandle.WaitAny(handles, 2000);
            }
        }

        private uint TargetSession()
        {
            if (consoleMode)
            {
                uint own;
                Native.ProcessIdToSessionId((uint)Process.GetCurrentProcess().Id, out own);
                return own;
            }
            return Native.WTSGetActiveConsoleSessionId();
        }

        private void Tick()
        {
            uint target = TargetSession();
            if (target == Native.NoSession)
            {
                if (child != null) StopChild("no active console session");
                return;
            }

            if (child != null)
            {
                bool alive = Native.WaitForSingleObject(child.Handle, 0) == Native.WaitTimeout;
                if (!alive)
                {
                    double lived = (DateTime.UtcNow - child.Started).TotalSeconds;
                    log.Write("agent exited (pid " + child.Pid + ", ran " + (int)lived + " s)");
                    Native.CloseHandle(child.Handle);
                    child = null;
                    backoffSeconds = lived > 30 ? 2 : Math.Min(backoffSeconds * 2, 60);
                    nextStart = DateTime.UtcNow.AddSeconds(backoffSeconds);
                    TryDelete(PidFile());
                }
                else if (child.SessionId != target)
                {
                    StopChild("console session changed to " + target);
                }
            }

            if (child == null && DateTime.UtcNow >= nextStart)
            {
                Launch(target);
            }
        }

        private string NodePath()
        {
            string bundled = Path.Combine(baseDir, "runtime", "node.exe");
            if (File.Exists(bundled)) return bundled;
            string env = consoleMode ? Environment.GetEnvironmentVariable("BIFROST_NODE") : null;
            if (!string.IsNullOrEmpty(env) && File.Exists(env)) return env;
            throw new FileNotFoundException("node runtime not found: " + bundled);
        }

        private void Launch(uint sessionId)
        {
            string node = NodePath();
            string script = Path.Combine(baseDir, "agent", "agent.js");
            if (!File.Exists(script)) throw new FileNotFoundException("agent not found: " + script);
            // Paths are passed explicitly: the agent must not depend on the environment block,
            // which for a SYSTEM token is the machine's, not this process's.
            string commandLine = "\"" + node + "\" \"" + script + "\" run --service"
                + " --config \"" + Path.Combine(dataDir, "agent.json") + "\""
                + " --log \"" + Path.Combine(dataDir, "agent.log") + "\"";

            // BIFROST_TEST_TOKEN only has an effect in console (debug) mode: it exercises the
            // token-duplication launch path with the caller's own token, so it can be tested
            // without being SYSTEM.
            bool tokenPath = !consoleMode || Environment.GetEnvironmentVariable("BIFROST_TEST_TOKEN") == "1";
            Child launched = tokenPath ? LaunchInSession(commandLine, sessionId) : LaunchPlain(commandLine);
            launched.SessionId = sessionId;
            launched.Started = DateTime.UtcNow;
            child = launched;
            try { File.WriteAllText(PidFile(), launched.Pid.ToString()); } catch { }
            log.Write("agent started (pid " + launched.Pid + ", session " + sessionId + ")");
        }

        private Child LaunchPlain(string commandLine)
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            string[] parts = commandLine.Split(new string[] { "\" \"" }, 2, StringSplitOptions.None);
            psi.FileName = parts[0].Trim('"');
            psi.Arguments = "\"" + parts[1];
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WorkingDirectory = baseDir;
            Process p = Process.Start(psi);
            Child c = new Child();
            c.Pid = p.Id;
            c.Handle = new SafeHandleHolder(p).Duplicate();
            return c;
        }

        /// <summary>Runs the command as SYSTEM inside the given session, on the interactive desktop.</summary>
        private Child LaunchInSession(string commandLine, uint sessionId)
        {
            IntPtr processToken = IntPtr.Zero, primary = IntPtr.Zero, env = IntPtr.Zero;
            try
            {
                if (!Native.OpenProcessToken(Native.GetCurrentProcess(), Native.TokenAllAccess, out processToken))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcessToken");
                if (!Native.DuplicateTokenEx(processToken, Native.TokenAllAccess, IntPtr.Zero,
                        Native.SecurityImpersonation, Native.TokenPrimary, out primary))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "DuplicateTokenEx");

                // Only needed (and only permitted, it requires SeTcbPrivilege) when moving the
                // token to another session: a service in session 0 targeting the console.
                uint ownSession;
                Native.ProcessIdToSessionId((uint)Process.GetCurrentProcess().Id, out ownSession);
                if (ownSession != sessionId)
                {
                    uint sid = sessionId;
                    if (!Native.SetTokenInformation(primary, Native.TokenSessionId, ref sid, sizeof(uint)))
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "SetTokenInformation(TokenSessionId)");
                }

                if (!Native.CreateEnvironmentBlock(out env, primary, false)) env = IntPtr.Zero;

                Native.STARTUPINFO si = new Native.STARTUPINFO();
                si.cb = Marshal.SizeOf(typeof(Native.STARTUPINFO));
                si.lpDesktop = "winsta0\\default";

                Native.PROCESS_INFORMATION pi;
                uint flags = Native.CreateNoWindow | (env != IntPtr.Zero ? Native.CreateUnicodeEnvironment : 0);
                if (!Native.CreateProcessAsUser(primary, null, commandLine, IntPtr.Zero, IntPtr.Zero, false,
                        flags, env, baseDir, ref si, out pi))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessAsUser");

                Native.CloseHandle(pi.hThread);
                Child c = new Child();
                c.Handle = pi.hProcess;
                c.Pid = pi.dwProcessId;
                return c;
            }
            finally
            {
                if (env != IntPtr.Zero) Native.DestroyEnvironmentBlock(env);
                if (primary != IntPtr.Zero) Native.CloseHandle(primary);
                if (processToken != IntPtr.Zero) Native.CloseHandle(processToken);
            }
        }

        private void StopChild(string reason)
        {
            Child c = child;
            if (c == null) return;
            child = null;
            log.Write("stopping agent pid " + c.Pid + ": " + reason);
            KillTree(c.Pid);
            Native.CloseHandle(c.Handle);
            TryDelete(PidFile());
            nextStart = DateTime.UtcNow.AddSeconds(1);
        }

        /// <summary>After a crash of this host, an agent from the previous run may still exist.</summary>
        private void KillStaleAgent()
        {
            try
            {
                string file = PidFile();
                if (!File.Exists(file)) return;
                int pid = int.Parse(File.ReadAllText(file).Trim());
                Process p = Process.GetProcessById(pid);
                if (string.Equals(p.ProcessName, "node", StringComparison.OrdinalIgnoreCase))
                {
                    log.Write("killing stale agent pid " + pid);
                    KillTree(pid);
                }
            }
            catch { /* no such process */ }
            TryDelete(PidFile());
        }

        private static void KillTree(int pid)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("taskkill.exe", "/PID " + pid + " /T /F");
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                Process k = Process.Start(psi);
                k.WaitForExit(5000);
            }
            catch { }
        }

        private string PidFile() { return Path.Combine(dataDir, "agent.pid"); }

        private static void TryDelete(string path)
        {
            try { File.Delete(path); } catch { }
        }
    }

    /// <summary>Gives the supervisor an independent handle on a Process it started.</summary>
    internal sealed class SafeHandleHolder
    {
        private readonly Process process;
        public SafeHandleHolder(Process process) { this.process = process; }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess,
            out IntPtr target, uint access, bool inherit, uint options);

        public IntPtr Duplicate()
        {
            IntPtr copy;
            IntPtr self = Native.GetCurrentProcess();
            if (!DuplicateHandle(self, process.Handle, self, out copy, 0, false, 2 /* DUPLICATE_SAME_ACCESS */))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "DuplicateHandle");
            return copy;
        }
    }

    public sealed class BifrostService : ServiceBase
    {
        public const string Name = "BifrostAgent";
        private Supervisor supervisor;

        public BifrostService()
        {
            ServiceName = Name;
            CanStop = true;
            CanHandleSessionChangeEvent = true;
            AutoLog = true;
        }

        protected override void OnStart(string[] args)
        {
            string dir = AppDomain.CurrentDomain.BaseDirectory;
            Logger log = new Logger(Path.Combine(DataDirOrDefault(), "service.log"));
            supervisor = new Supervisor(dir, false, log);
            supervisor.Start();
            log.Write("service started");
        }

        protected override void OnStop()
        {
            if (supervisor != null) supervisor.Stop();
        }

        protected override void OnSessionChange(SessionChangeDescription change)
        {
            if (supervisor != null) supervisor.Wake();
        }

        private static string DataDirOrDefault()
        {
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Bifrost");
            Directory.CreateDirectory(dir);
            return dir;
        }

        public static int Main(string[] args)
        {
            if (args.Length > 0 && args[0] == "--console")
            {
                string dir = AppDomain.CurrentDomain.BaseDirectory;
                string env = Environment.GetEnvironmentVariable("BIFROST_DATA_DIR");
                string data = !string.IsNullOrEmpty(env) ? env : DataDirOrDefault();
                Directory.CreateDirectory(data);
                Logger log = new Logger(Path.Combine(data, "service.log"));
                Supervisor supervisor = new Supervisor(dir, true, log);
                supervisor.Start();
                Console.WriteLine("Bifrost supervisor running in console mode. Ctrl+C to stop.");
                ManualResetEvent done = new ManualResetEvent(false);
                Console.CancelKeyPress += delegate(object s, ConsoleCancelEventArgs e) { e.Cancel = true; done.Set(); };
                done.WaitOne();
                supervisor.Stop();
                return 0;
            }
            ServiceBase.Run(new BifrostService());
            return 0;
        }
    }
}
