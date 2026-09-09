// StreamGrab native-messaging host.
//
// Chrome launches this exe (registered by the desktop app) and talks to it over
// stdio using 4-byte length-prefixed JSON frames. We relay each frame to the
// running StreamGrab app over a local TCP socket (newline-delimited JSON, token
// authenticated), and relay the app's replies back. If the app is not running
// we start it and keep retrying until it comes up.
//
// No runtime dependencies beyond the .NET Framework that ships with Windows.
// Built by scripts/build-host.js with the csc.exe that ships with Windows.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

static class Host
{
    static readonly string Dir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "StreamGrab");
    static readonly string CfgPath = Path.Combine(Dir, "bridge.json");
    static readonly string LogPath = Path.Combine(Dir, "host.log");

    static Stream stdin, stdout;
    static readonly object outLock = new object();
    static readonly object pendLock = new object();
    static readonly Queue<string> pending = new Queue<string>();
    static NetworkStream sock; // non-null once the app has welcomed us

    // Second copy of the log next to the exe, in case %APPDATA% resolves
    // somewhere unexpected in the launching process's environment.
    static readonly string LocalLogPath = Path.Combine(
        Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName), "host-local.log");

    static void Log(string s)
    {
        var line = "[" + DateTime.UtcNow.ToString("o") + "] " + s + "\r\n";
        try
        {
            Directory.CreateDirectory(Dir);
            var fi = new FileInfo(LogPath);
            if (fi.Exists && fi.Length > 512 * 1024) fi.Delete();
            File.AppendAllText(LogPath, line);
        }
        catch (Exception e) { line += "    (primary log failed: " + e.Message + ")\r\n"; }
        try { File.AppendAllText(LocalLogPath, line); } catch { }
    }

    static int Main(string[] args)
    {
        stdin = Console.OpenStandardInput();
        stdout = Console.OpenStandardOutput();
        Log("--- host launched --- args=" + string.Join(" ", args));
        Log("env: user=" + Environment.UserName + " appdata=" + Dir + " cfgExists=" + File.Exists(CfgPath)
            + " USERPROFILE=" + Environment.GetEnvironmentVariable("USERPROFILE")
            + " APPDATA=" + Environment.GetEnvironmentVariable("APPDATA")
            + " cwd=" + Environment.CurrentDirectory);
        try
        {
            // Diagnostics: is this process seeing the same files everyone else does?
            var fi = new FileInfo(CfgPath);
            Log("diag: bridge.json size=" + (fi.Exists ? fi.Length : -1) + " mtimeUtc=" + (fi.Exists ? fi.LastWriteTimeUtc.ToString("o") : "n/a")
                + " | dir files=" + string.Join(",", Array.ConvertAll(Directory.GetFiles(Dir), Path.GetFileName)));
            var id = System.Security.Principal.WindowsIdentity.GetCurrent();
            var sids = new List<string>();
            foreach (var g in id.Groups) { var v = g.Value; if (v.StartsWith("S-1-16-") || v.StartsWith("S-1-15-")) sids.Add(v); }
            Log("diag: token=" + id.Name + " integrity/appcontainer sids=" + string.Join(",", sids.ToArray()));
            var mods = new List<string>();
            foreach (ProcessModule m in Process.GetCurrentProcess().Modules) { var n = m.ModuleName.ToLowerInvariant(); if (!n.EndsWith(".dll") || n.StartsWith("ms") || n.StartsWith("api-") || n.StartsWith("clr") || n.StartsWith("kernel") || n.StartsWith("nt") || n.StartsWith("user32") || n.StartsWith("advapi") || n.StartsWith("rpc") || n.StartsWith("sech") || n.StartsWith("bcrypt") || n.StartsWith("ucrt") || n.StartsWith("combase") || n.StartsWith("ole") || n.StartsWith("gdi") || n.StartsWith("win32u") || n.StartsWith("imm32") || n.StartsWith("shell") || n.StartsWith("shcore") || n.StartsWith("shlwapi") || n.StartsWith("sspicli") || n.StartsWith("cryptbase") || n.StartsWith("crypt") || n.StartsWith("version") || n.StartsWith("psapi") || n.StartsWith("mscor") || n.StartsWith("system") || n.StartsWith("ws2") || n.StartsWith("mswsock") || n.StartsWith("iphlp") || n.StartsWith("dnsapi") || n.StartsWith("nsi") || n.StartsWith("profapi") || n.StartsWith("powrprof") || n.StartsWith("umpdc") || n.StartsWith("kernelbase") || n.StartsWith("wldp") || n.StartsWith("amsi") || n.StartsWith("userenv") || n.StartsWith("cfgmgr") || n.StartsWith("windows.") || n.StartsWith("dwmapi") || n.StartsWith("uxtheme") || n.StartsWith("dbghelp") || n.StartsWith("fltlib") || n.StartsWith("rasadhlp") || n.StartsWith("fwpuclnt") || n.StartsWith("winnsi") || n.StartsWith("netapi") || n.StartsWith("wshbth") || n.StartsWith("napinsp") || n.StartsWith("pnrpnsp") || n.StartsWith("nlaapi") || n.StartsWith("winrnr") || n.StartsWith("wintypes") || n.StartsWith("textshaping") || n.StartsWith("gdiplus") || n.StartsWith("winhttp") || n.StartsWith("webio") || n.StartsWith("dpapi") || n.StartsWith("sxs") || n.StartsWith("propsys") || n.StartsWith("mpr") || n.StartsWith("apphelp") || n.StartsWith("vcruntime") || n.StartsWith("diagnostic")) continue; mods.Add(n); }
            Log("diag: non-system modules=" + (mods.Count == 0 ? "(none)" : string.Join(",", mods.ToArray())));
            using (var s = new System.Management.ManagementObjectSearcher("SELECT ParentProcessId FROM Win32_Process WHERE ProcessId=" + Process.GetCurrentProcess().Id))
            foreach (System.Management.ManagementObject o in s.Get())
            {
                var ppid = Convert.ToInt32(o["ParentProcessId"]);
                string pname = "?"; string pexe = "?";
                try { var pp = Process.GetProcessById(ppid); pname = pp.ProcessName; pexe = pp.MainModule.FileName; } catch { }
                Log("diag: parent pid=" + ppid + " " + pname + " " + pexe);
            }
        }
        catch (Exception e) { Log("diag failed: " + e.Message); }

        var t = new Thread(StdinLoop) { IsBackground = true };
        t.Start();

        NetworkStream ns = Connect();
        if (ns == null)
        {
            Log("could not reach the app -> exit");
            return 1;
        }

        lock (pendLock)
        {
            sock = ns;
            Log("welcome; flushing " + pending.Count + " queued");
            while (pending.Count > 0) WriteLine(ns, pending.Dequeue());
        }

        // app -> chrome
        try
        {
            var reader = new StreamReader(ns, new UTF8Encoding(false));
            string line;
            while ((line = reader.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                SendToChrome(line);
            }
        }
        catch (Exception e) { Log("socket read ended: " + e.Message); }
        Log("app socket closed -> exit");
        return 0;
    }

    // chrome -> app (queued until the socket is ready)
    static void StdinLoop()
    {
        var header = new byte[4];
        try
        {
            while (true)
            {
                if (!ReadExact(stdin, header, 4)) break;
                int len = BitConverter.ToInt32(header, 0);
                if (len < 0 || len > 64 * 1024 * 1024) break;
                var body = new byte[len];
                if (!ReadExact(stdin, body, len)) break;
                var json = Encoding.UTF8.GetString(body);
                lock (pendLock)
                {
                    if (sock != null) WriteLine(sock, json);
                    else pending.Enqueue(json);
                }
            }
        }
        catch (Exception e) { Log("stdin error: " + e.Message); }
        Log("stdin closed by Chrome -> exit");
        Environment.Exit(0);
    }

    static bool ReadExact(Stream s, byte[] buf, int n)
    {
        int off = 0;
        while (off < n)
        {
            int r = s.Read(buf, off, n - off);
            if (r <= 0) return false;
            off += r;
        }
        return true;
    }

    static void SendToChrome(string json)
    {
        var body = Encoding.UTF8.GetBytes(json);
        var header = BitConverter.GetBytes(body.Length); // little-endian, as Chrome expects on x86/x64
        lock (outLock)
        {
            stdout.Write(header, 0, 4);
            stdout.Write(body, 0, body.Length);
            stdout.Flush();
        }
    }

    static void WriteLine(NetworkStream ns, string json)
    {
        try
        {
            var b = Encoding.UTF8.GetBytes(json + "\n");
            ns.Write(b, 0, b.Length);
            ns.Flush();
        }
        catch (Exception e) { Log("socket write failed: " + e.Message); }
    }

    // ---- connecting / launching --------------------------------------------

    class Cfg
    {
        public int port;
        public string token;
        public string exe;
        public List<string> args = new List<string>();
        public int pid;
    }

    static Cfg ReadCfg()
    {
        try
        {
            var raw = File.ReadAllText(CfgPath);
            var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(raw);
            var c = new Cfg();
            object v;
            if (d.TryGetValue("port", out v)) c.port = Convert.ToInt32(v);
            if (d.TryGetValue("token", out v)) c.token = Convert.ToString(v);
            if (d.TryGetValue("exe", out v)) c.exe = Convert.ToString(v);
            if (d.TryGetValue("pid", out v)) c.pid = Convert.ToInt32(v);
            if (d.TryGetValue("args", out v) && v is ArrayList)
                foreach (var a in (ArrayList)v) c.args.Add(Convert.ToString(a));
            return c;
        }
        catch { return null; }
    }

    static NetworkStream Connect()
    {
        bool launched = false;
        var deadline = DateTime.UtcNow.AddSeconds(30);
        int attempt = 0;
        while (DateTime.UtcNow < deadline)
        {
            attempt++;
            var cfg = ReadCfg(); // re-read every time: the app writes a fresh token on each start
            if (attempt == 1) Log("cfg: " + (cfg == null ? "null" : "port=" + cfg.port + " token=" + (cfg.token ?? "").Substring(0, Math.Min(6, (cfg.token ?? "").Length)) + "... pid=" + cfg.pid));
            if (cfg != null && cfg.port > 0)
            {
                var ns = TryHandshake(cfg);
                if (ns != null) return ns;
            }
            if (!launched)
            {
                launched = true;
                if (AppAlreadyRunning(cfg))
                {
                    Log("app process exists but bridge not up yet; waiting");
                }
                else if (!LaunchApp(cfg))
                {
                    return null;
                }
                // Tell the extension to wait longer than its normal timeout.
                SendToChrome("{\"type\":\"status\",\"state\":\"launching\"}");
            }
            Thread.Sleep(attempt < 10 ? 300 : 700);
        }
        return null;
    }

    static NetworkStream TryHandshake(Cfg cfg)
    {
        TcpClient client = null;
        try
        {
            client = new TcpClient();
            var ar = client.BeginConnect("127.0.0.1", cfg.port, null, null);
            if (!ar.AsyncWaitHandle.WaitOne(1500) || !client.Connected) { client.Close(); return null; }
            client.EndConnect(ar);
            var ns = client.GetStream();
            ns.ReadTimeout = 4000;
            WriteLine(ns, "{\"type\":\"hello\",\"token\":\"" + cfg.token + "\"}");
            var sb = new StringBuilder();
            var one = new byte[1];
            while (true)
            {
                int r = ns.Read(one, 0, 1);
                if (r <= 0) { Log("app closed during handshake (stale token?)"); client.Close(); return null; }
                if (one[0] == (byte)'\n') break;
                sb.Append((char)one[0]);
            }
            if (sb.ToString().Contains("\"welcome\""))
            {
                ns.ReadTimeout = Timeout.Infinite;
                Log("connected to app on port " + cfg.port);
                return ns;
            }
            Log("unexpected handshake reply: " + sb);
            client.Close();
            return null;
        }
        catch (Exception e)
        {
            Log("connect attempt failed: " + e.Message);
            try { if (client != null) client.Close(); } catch { }
            return null;
        }
    }

    static bool AppAlreadyRunning(Cfg cfg)
    {
        if (cfg == null || cfg.pid <= 0) return false;
        try
        {
            var p = Process.GetProcessById(cfg.pid);
            var n = p.ProcessName.ToLowerInvariant();
            return n.Contains("streamgrab") || n.Contains("electron");
        }
        catch { return false; }
    }

    static bool LaunchApp(Cfg cfg)
    {
        string exe = cfg != null ? cfg.exe : null;
        var args = cfg != null ? cfg.args : new List<string>();
        if (string.IsNullOrEmpty(exe) || !File.Exists(exe))
        {
            // Packaged layout: <install>\resources\bin\streamgrab-host.exe -> <install>\StreamGrab.exe
            var here = Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName);
            var guess = Path.GetFullPath(Path.Combine(here, "..", "..", "StreamGrab.exe"));
            if (File.Exists(guess)) { exe = guess; args = new List<string> { "--hidden" }; }
            else
            {
                // Development checkout: <repo>/native-host/streamgrab-host.exe ->
                // <repo>/node_modules/electron/dist/electron.exe <repo> --hidden
                var repo = Path.GetFullPath(Path.Combine(here, ".."));
                var dev = Path.Combine(repo, "node_modules", "electron", "dist", "electron.exe");
                if (File.Exists(dev) && File.Exists(Path.Combine(repo, "package.json")))
                {
                    exe = dev;
                    args = new List<string> { repo, "--hidden" };
                    Log("bridge.json missing; using dev layout " + dev);
                }
            }
        }
        if (string.IsNullOrEmpty(exe) || !File.Exists(exe))
        {
            Log("no app executable known (bridge.json missing and not a packaged install)");
            return false;
        }
        try
        {
            var sb = new StringBuilder();
            foreach (var a in args) sb.Append('"').Append(a.Replace("\"", "\\\"")).Append("\" ");
            var psi = new ProcessStartInfo
            {
                FileName = exe,
                Arguments = sb.ToString().TrimEnd(),
                UseShellExecute = true, // do NOT hand Chrome's stdio pipes to the app
                WorkingDirectory = Path.GetDirectoryName(exe)
            };
            Process.Start(psi);
            Log("launched app: " + exe + " " + psi.Arguments);
            return true;
        }
        catch (Exception e)
        {
            Log("launch failed: " + e.Message);
            return false;
        }
    }
}
