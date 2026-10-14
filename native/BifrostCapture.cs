// Bifrost screen capture + encoder helper (C# 5 / .NET Framework 4.x, built with Windows' own
// csc.exe, /unsafe).
//
//   BifrostCapture.exe [--codec h264|jpeg] [--fps 30] [--bitrate 4000000] [--maxwidth 1920]
//                      [--quality 55] [--monitor 0] [--nodedupe]
//   BifrostCapture.exe --selftest
//
// stdout: a stream of records  [type u8][flags u8][width u16 BE][height u16 BE][length u32 BE][payload]
//   type 0  status   payload = ASCII "h264" | "jpeg" | "error: ..."   (always the first record)
//   type 1  jpeg     payload = JPEG image
//   type 2  h264     payload = Annex B access unit, flags bit 0 = keyframe (SPS/PPS included)
//   type 3  monitors payload = JSON {"current":0,"list":[{"x":0,"y":0,"w":1920,"h":1080,"p":1}]}
//                    sent before the first frame and again whenever the layout or the
//                    selection changes; "x","y" are virtual-desktop pixels, "p":1 = primary,
//                    index 0 is always the primary monitor
// stdin (one command per line): "K" force a keyframe, "B <bps>" set the bitrate,
//   "M <index>" capture another monitor (an unknown index falls back to the primary), EOF = quit.
//
// Like capture.ps1 it follows the input desktop (logon screen, UAC when running as SYSTEM),
// draws the mouse pointer, copes with resolution changes and captures one monitor
// (the primary one unless told otherwise).

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Bifrost
{
    internal static class Win
    {
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
        [StructLayout(LayoutKind.Sequential)]
        public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos; }

        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO info);
        [DllImport("user32.dll")] public static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int cx, int cy, int step, IntPtr bg, int flags);
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr desktop);
        [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll", SetLastError = true)]
        static extern bool GetUserObjectInformationW(IntPtr obj, int index, IntPtr info, int length, out int needed);

        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
        [StructLayout(LayoutKind.Sequential)]
        public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
        private delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data);
        [DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
        [DllImport("user32.dll")] private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

        /// <summary>One display, in virtual-desktop pixels.</summary>
        public struct MonitorRect
        {
            public int X, Y, W, H;
            public bool Primary;
            public bool SameAs(MonitorRect o) { return X == o.X && Y == o.Y && W == o.W && H == o.H && Primary == o.Primary; }
        }

        /// <summary>The attached displays, primary first, then left to right, top to bottom.</summary>
        public static List<MonitorRect> Monitors()
        {
            List<MonitorRect> list = new List<MonitorRect>();
            try
            {
                EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr m, IntPtr hdc, IntPtr r, IntPtr d)
                {
                    MONITORINFO mi = new MONITORINFO();
                    mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
                    if (GetMonitorInfo(m, ref mi))
                    {
                        MonitorRect mr = new MonitorRect();
                        mr.X = mi.rcMonitor.left; mr.Y = mi.rcMonitor.top;
                        mr.W = mi.rcMonitor.right - mi.rcMonitor.left;
                        mr.H = mi.rcMonitor.bottom - mi.rcMonitor.top;
                        mr.Primary = (mi.dwFlags & 1) != 0;
                        if (mr.W > 0 && mr.H > 0) list.Add(mr);
                    }
                    return true;
                }, IntPtr.Zero);
            }
            catch (Exception) { }
            if (list.Count == 0)
            {
                MonitorRect mr = new MonitorRect();
                mr.W = GetSystemMetrics(0); mr.H = GetSystemMetrics(1); mr.Primary = true;
                list.Add(mr);
            }
            list.Sort(delegate(MonitorRect a, MonitorRect b)
            {
                if (a.Primary != b.Primary) return a.Primary ? -1 : 1;
                if (a.X != b.X) return a.X.CompareTo(b.X);
                return a.Y.CompareTo(b.Y);
            });
            if (!list[0].Primary)
            {
                MonitorRect first = list[0];
                first.Primary = true; // no flag reported: treat the first one as the main display
                list[0] = first;
            }
            return list;
        }

        private static IntPtr attached = IntPtr.Zero;
        private static string current = "";

        private static string NameOf(IntPtr desktop)
        {
            int needed;
            GetUserObjectInformationW(desktop, 2, IntPtr.Zero, 0, out needed);
            if (needed <= 0) return "";
            IntPtr buf = Marshal.AllocHGlobal(needed);
            try
            {
                if (!GetUserObjectInformationW(desktop, 2, buf, needed, out needed)) return "";
                return Marshal.PtrToStringUni(buf);
            }
            finally { Marshal.FreeHGlobal(buf); }
        }

        /// <summary>Attaches the thread to the input desktop; true when the desktop changed.</summary>
        public static bool SyncDesktop()
        {
            IntPtr h = OpenInputDesktop(0, false, 0x10000000);
            if (h == IntPtr.Zero) h = OpenInputDesktop(0, false, 0x000001FF | 0x40000000);
            if (h == IntPtr.Zero) return false;
            string name = NameOf(h);
            if (name == current) { CloseDesktop(h); return false; }
            if (SetThreadDesktop(h))
            {
                IntPtr old = attached;
                attached = h;
                current = name;
                if (old != IntPtr.Zero) CloseDesktop(old);
                return true;
            }
            CloseDesktop(h);
            return false;
        }
    }

    /// <summary>Grabs one monitor, optionally downscaled to a maximum width.</summary>
    internal sealed class Grabber : IDisposable
    {
        private readonly int maxWidth;
        private bool gdiScaling;
        private int srcX, srcY, srcW, srcH;
        private Bitmap srcBmp, dstBmp;
        private Graphics srcG, dstG;
        private List<Win.MonitorRect> monitors = new List<Win.MonitorRect>();
        private int selected;
        private volatile int requested;
        private string pendingReport;
        private readonly System.Diagnostics.Stopwatch lastScan = new System.Diagnostics.Stopwatch();
        public int Width { get; private set; }
        public int Height { get; private set; }

        /// <summary>Incremented whenever another monitor (or size) is being captured.</summary>
        public int Generation { get; private set; }

        public int SourceWidth { get { return srcW; } }
        public int SourceHeight { get { return srcH; } }

        /// <summary>
        /// With gdiScaling the grabber downsizes through GDI+ (needed for JPEG, which encodes the
        /// bitmap itself). H.264 leaves the full-size bitmap and scales inside the pixel
        /// conversion, which is both faster and parallel.
        /// </summary>
        public Grabber(int maxWidth, bool gdiScaling, int monitor)
        {
            this.maxWidth = maxWidth;
            this.gdiScaling = gdiScaling;
            requested = monitor;
            Scan();
        }

        /// <summary>Asks for another monitor; applied on the next Grab (any thread).</summary>
        public void SelectMonitor(int index) { requested = index; }

        /// <summary>The monitors report to send, once per change (null when nothing changed).</summary>
        public string TakeReport()
        {
            string r = pendingReport;
            pendingReport = null;
            return r;
        }

        public void EnableGdiScaling() { gdiScaling = true; Rebuild(); }

        /// <summary>Re-reads the display layout and follows the selection; rebuilds on any change.</summary>
        private void Scan()
        {
            lastScan.Restart();
            List<Win.MonitorRect> now = Win.Monitors();
            int want = requested;
            if (want < 0 || want >= now.Count) want = 0;
            bool layout = now.Count != monitors.Count;
            for (int i = 0; !layout && i < now.Count; i++) layout = !now[i].SameAs(monitors[i]);
            if (!layout && want == selected && srcBmp != null) return;

            monitors = now;
            selected = want;
            Win.MonitorRect m = now[want];
            srcX = m.X; srcY = m.Y; srcW = m.W; srcH = m.H;
            Rebuild();
            Generation++;

            StringBuilder sb = new StringBuilder();
            sb.Append("{\"current\":").Append(selected).Append(",\"list\":[");
            for (int i = 0; i < now.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append("{\"x\":").Append(now[i].X).Append(",\"y\":").Append(now[i].Y)
                  .Append(",\"w\":").Append(now[i].W).Append(",\"h\":").Append(now[i].H)
                  .Append(",\"p\":").Append(now[i].Primary ? 1 : 0).Append('}');
            }
            sb.Append("]}");
            pendingReport = sb.ToString();
        }

        private static int Even(int v) { return v & ~1; }

        private void Release()
        {
            if (srcG != null) srcG.Dispose();
            if (srcBmp != null) srcBmp.Dispose();
            if (dstG != null) dstG.Dispose();
            if (dstBmp != null) dstBmp.Dispose();
            srcG = null; srcBmp = null; dstG = null; dstBmp = null;
        }

        private void Rebuild()
        {
            Release();
            Width = Even(srcW);
            Height = Even(srcH);
            if (srcW > maxWidth)
            {
                Width = Even(maxWidth);
                Height = Even((int)Math.Round((double)srcH * maxWidth / srcW));
            }
            if (Width < 2) Width = 2;
            if (Height < 2) Height = 2;
            srcBmp = new Bitmap(srcW, srcH, PixelFormat.Format32bppRgb);
            srcG = Graphics.FromImage(srcBmp);
            if (gdiScaling && (Width != srcW || Height != srcH))
            {
                dstBmp = new Bitmap(Width, Height, PixelFormat.Format32bppRgb);
                dstG = Graphics.FromImage(dstBmp);
                dstG.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Bilinear;
            }
        }

        /// <summary>The bitmap to encode after a successful Grab (scaled when needed).</summary>
        public Bitmap Current { get { return dstBmp != null ? dstBmp : srcBmp; } }

        public bool Grab()
        {
            Win.SyncDesktop();
            // A new selection is honoured at once; layout changes (resolution, plugged display)
            // are picked up by a cheap rescan once a second.
            if (requested != selected || lastScan.ElapsedMilliseconds >= 1000) Scan();
            try
            {
                srcG.CopyFromScreen(srcX, srcY, 0, 0, new Size(srcW, srcH));
            }
            catch (Exception)
            {
                return false; // desktop switch in progress
            }
            try
            {
                Win.CURSORINFO ci = new Win.CURSORINFO();
                ci.cbSize = Marshal.SizeOf(typeof(Win.CURSORINFO));
                if (Win.GetCursorInfo(ref ci) && (ci.flags & 1) != 0)
                {
                    IntPtr hdc = srcG.GetHdc();
                    try { Win.DrawIconEx(hdc, ci.ptScreenPos.x - srcX, ci.ptScreenPos.y - srcY, ci.hCursor, 0, 0, 0, IntPtr.Zero, 3); }
                    finally { srcG.ReleaseHdc(hdc); }
                }
            }
            catch (Exception) { }
            if (dstG != null) dstG.DrawImage(srcBmp, 0, 0, Width, Height);
            return true;
        }

        public void Dispose() { Release(); }
    }

    internal static class Program
    {
        private static Stream stdout;
        private static readonly object writeGate = new object();
        private static volatile bool forceKeyframe;
        private static bool noDedupe;
        private static bool trace;
        private static volatile int newBitrate;
        private static volatile Grabber activeGrabber;

        private static void WriteRecord(byte type, byte flags, int w, int h, byte[] payload)
        {
            byte[] head = new byte[10];
            head[0] = type;
            head[1] = flags;
            head[2] = (byte)(w >> 8); head[3] = (byte)w;
            head[4] = (byte)(h >> 8); head[5] = (byte)h;
            head[6] = (byte)(payload.Length >> 24); head[7] = (byte)(payload.Length >> 16);
            head[8] = (byte)(payload.Length >> 8); head[9] = (byte)payload.Length;
            lock (writeGate)
            {
                stdout.Write(head, 0, head.Length);
                stdout.Write(payload, 0, payload.Length);
                stdout.Flush();
            }
        }

        private static void WriteStatus(string text)
        {
            WriteRecord(0, 0, 0, 0, Encoding.ASCII.GetBytes(text));
        }

        private static string Arg(string[] args, string name, string fallback)
        {
            for (int i = 0; i + 1 < args.Length; i++) if (args[i] == name) return args[i + 1];
            return fallback;
        }

        private static void CommandLoop()
        {
            try
            {
                string line;
                while ((line = Console.In.ReadLine()) != null)
                {
                    line = line.Trim();
                    if (line == "K") forceKeyframe = true;
                    else if (line.StartsWith("B "))
                    {
                        int bps;
                        if (int.TryParse(line.Substring(2), NumberStyles.Integer, CultureInfo.InvariantCulture, out bps) && bps >= 200000 && bps <= 50000000)
                            newBitrate = bps;
                    }
                    else if (line.StartsWith("M "))
                    {
                        int index;
                        Grabber g = activeGrabber;
                        if (g != null && int.TryParse(line.Substring(2), NumberStyles.Integer, CultureInfo.InvariantCulture, out index) && index >= 0 && index < 64)
                            g.SelectMonitor(index);
                    }
                }
            }
            catch (Exception) { }
            Environment.Exit(0); // the agent closed our stdin: the session is over
        }

        private static unsafe bool SameAs(byte[] previous, IntPtr current, int count)
        {
            if (previous == null || previous.Length != count) return false;
            fixed (byte* p = previous)
            {
                long* a = (long*)p;
                long* b = (long*)current.ToPointer();
                int words = count / 8;
                for (int i = 0; i < words; i++) if (a[i] != b[i]) return false;
                for (int i = words * 8; i < count; i++) if (p[i] != ((byte*)b)[i]) return false;
            }
            return true;
        }

        private static long trGrab, trConv, trEnc;
        private static int trN;
        private static DateTime trLast = DateTime.UtcNow;

        private static void Trace(long grab, long conv, long enc)
        {
            double ms = 1000.0 / System.Diagnostics.Stopwatch.Frequency;
            trGrab += grab; trConv += conv; trEnc += enc; trN++;
            if ((DateTime.UtcNow - trLast).TotalSeconds >= 2 && trN > 0)
            {
                Console.Error.WriteLine("trace: frames=" + trN + " grab=" + (trGrab * ms / trN).ToString("F1") +
                    "ms convert=" + (trConv * ms / trN).ToString("F1") + "ms encode=" + (trEnc * ms / trN).ToString("F1") + "ms");
                trGrab = trConv = trEnc = 0; trN = 0; trLast = DateTime.UtcNow;
            }
        }

        private static int Main(string[] args)
        {
            if (args.Length > 0 && args[0] == "--selftest") return SelfTest.Run();

            Win.SetProcessDPIAware();
            stdout = Console.OpenStandardOutput();
            string codec = Arg(args, "--codec", "h264");
            int fps = int.Parse(Arg(args, "--fps", "30"), CultureInfo.InvariantCulture);
            int bitrate = int.Parse(Arg(args, "--bitrate", "4000000"), CultureInfo.InvariantCulture);
            int maxWidth = int.Parse(Arg(args, "--maxwidth", "1920"), CultureInfo.InvariantCulture);
            int quality = int.Parse(Arg(args, "--quality", "55"), CultureInfo.InvariantCulture);
            int monitor = int.Parse(Arg(args, "--monitor", "0"), CultureInfo.InvariantCulture);
            noDedupe = Array.IndexOf(args, "--nodedupe") >= 0; // benchmarking: always encode
            trace = Array.IndexOf(args, "--trace") >= 0;     // per-stage timings on stderr
            fps = Math.Max(1, Math.Min(60, fps));

            Thread commands = new Thread(CommandLoop);
            commands.IsBackground = true;
            commands.Start();

            try
            {
                Win.SyncDesktop();
                using (Grabber grabber = new Grabber(maxWidth, codec != "h264", monitor))
                {
                    activeGrabber = grabber;
                    H264Encoder encoder = null;
                    int encW = 0, encH = 0;
                    if (codec == "h264")
                    {
                        try
                        {
                            encoder = new H264Encoder(grabber.Width, grabber.Height, fps, bitrate);
                            encW = grabber.Width; encH = grabber.Height;
                        }
                        catch (Exception e)
                        {
                            Console.Error.WriteLine("H.264 encoder unavailable: " + e.Message);
                            encoder = null;
                            codec = "jpeg";
                            grabber.EnableGdiScaling();
                        }
                    }
                    WriteStatus(encoder != null ? "h264" : "jpeg");
                    RunLoop(grabber, encoder, encW, encH, fps, bitrate, quality);
                }
            }
            catch (IOException) { /* stdout closed */ }
            catch (Exception e)
            {
                try { WriteStatus("error: " + e.Message); } catch (Exception) { }
                Console.Error.WriteLine(e.ToString());
                return 2;
            }
            return 0;
        }

        private static void RunLoop(Grabber grabber, H264Encoder encoder, int encW, int encH, int fps, int bitrate, int quality)
        {
            ImageCodecInfo jpeg = null;
            foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpeg = c;
            EncoderParameters jpegParams = new EncoderParameters(1);
            jpegParams.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
            MemoryStream ms = new MemoryStream();

            byte[] nv12 = null;
            byte[] previous = null;
            byte[] parameterSets = new byte[0];
            int interval = 1000 / fps;
            System.Diagnostics.Stopwatch sw = new System.Diagnostics.Stopwatch();
            bool needKey = true;
            int idleFrames = 0;
            int generation = grabber.Generation;

            for (;;)
            {
                sw.Restart();
                if (!grabber.Grab()) { Thread.Sleep(100); continue; }
                long tGrab = sw.ElapsedTicks;

                // The viewer learns about the displays before the first frame, and again on change.
                string report = grabber.TakeReport();
                if (report != null) WriteRecord(3, 0, 0, 0, Encoding.UTF8.GetBytes(report));
                if (grabber.Generation != generation)
                {
                    // Another monitor: never mistake it for "the screen did not change".
                    generation = grabber.Generation;
                    previous = null;
                    needKey = true;
                }

                // Resolution change with H.264: start a new encoder (new SPS) and a keyframe.
                if (encoder != null && (grabber.Width != encW || grabber.Height != encH))
                {
                    encoder.Dispose();
                    encoder = new H264Encoder(grabber.Width, grabber.Height, fps, bitrate);
                    encW = grabber.Width; encH = grabber.Height;
                    previous = null;
                    nv12 = null;
                    needKey = true;
                }
                if (newBitrate != 0 && encoder != null)
                {
                    bitrate = newBitrate;
                    newBitrate = 0;
                    encoder.SetBitrate(bitrate);
                }
                if (forceKeyframe) { forceKeyframe = false; needKey = true; previous = null; }

                Bitmap bmp = grabber.Current;
                int w = grabber.Width, h = grabber.Height;
                BitmapData data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
                try
                {
                    int bytes = Math.Abs(data.Stride) * bmp.Height;
                    bool same = !noDedupe && SameAs(previous, data.Scan0, bytes);
                    // Send nothing while the screen is static, except a refresh once in a while
                    // so that a viewer that joined mid-stream always converges.
                    if (same && !needKey && ++idleFrames < fps * 5)
                    {
                        // fall through to pacing
                    }
                    else
                    {
                        idleFrames = 0;
                        if (previous == null || previous.Length != bytes) previous = new byte[bytes];
                        Marshal.Copy(data.Scan0, previous, 0, bytes);

                        if (encoder != null)
                        {
                            if (nv12 == null) nv12 = new byte[w * h * 3 / 2];
                            long t0 = sw.ElapsedTicks;
                            Convert709.BgraToNv12(data.Scan0, data.Stride, bmp.Width, bmp.Height, w, h, nv12);
                            long t1 = sw.ElapsedTicks;
                            if (needKey) encoder.ForceKeyframe();
                            List<byte[]> units = encoder.Encode(nv12);
                            long t2 = sw.ElapsedTicks;
                            if (trace) Trace(tGrab, t1 - t0, t2 - t1);
                            foreach (byte[] au in units)
                            {
                                List<int> types = Nal.Types(au);
                                bool key = types.Contains(5);
                                byte[] ps = Nal.ParameterSets(au);
                                if (ps.Length > 0) parameterSets = ps;
                                byte[] payload = au;
                                if (key && ps.Length == 0 && parameterSets.Length > 0)
                                {
                                    payload = new byte[parameterSets.Length + au.Length];
                                    Buffer.BlockCopy(parameterSets, 0, payload, 0, parameterSets.Length);
                                    Buffer.BlockCopy(au, 0, payload, parameterSets.Length, au.Length);
                                }
                                WriteRecord(2, (byte)(key ? 1 : 0), w, h, payload);
                                if (key) needKey = false;
                            }
                        }
                        else
                        {
                            ms.SetLength(0);
                            bmp.UnlockBits(data);
                            data = null;
                            bmp.Save(ms, jpeg, jpegParams);
                            WriteRecord(1, 1, w, h, ms.ToArray());
                            needKey = false;
                        }
                    }
                }
                finally
                {
                    if (data != null) bmp.UnlockBits(data);
                }

                int left = interval - (int)sw.ElapsedMilliseconds;
                if (left > 0) Thread.Sleep(left);
            }
        }
    }

    /// <summary>
    /// Encodes synthetic frames, decodes them with Windows' own H.264 decoder and compares.
    /// Proves the stream is conformant and that the pixel path (BT.709 NV12) is right.
    /// </summary>
    internal static class SelfTest
    {
        public static int Run()
        {
            const int W = 640, H = 480, FPS = 30, FRAMES = 45;
            try
            {
                if (!ScaledConversionIsSane()) return Fail("scaled conversion disagrees with the full-size conversion");
                H264Encoder enc = new H264Encoder(W, H, FPS, 2000000);
                H264Decoder dec = new H264Decoder(W, H);
                byte[] bgra = new byte[W * H * 4];
                byte[] nv12 = new byte[W * H * 3 / 2];
                List<byte[]> encoded = new List<byte[]>();
                List<byte[]> sources = new List<byte[]>();
                int keyframes = 0, withParams = 0;

                GCHandle pin = GCHandle.Alloc(bgra, GCHandleType.Pinned);
                try
                {
                    for (int f = 0; f < FRAMES; f++)
                    {
                        Paint(bgra, W, H, f);
                        Convert709.BgraToNv12(pin.AddrOfPinnedObject(), W * 4, W, H, W, H, nv12);
                        if (f == 30) enc.ForceKeyframe();
                        byte[] ySnapshot = new byte[W * H];
                        Buffer.BlockCopy(nv12, 0, ySnapshot, 0, ySnapshot.Length);
                        sources.Add(ySnapshot);
                        foreach (byte[] au in enc.Encode(nv12))
                        {
                            List<int> types = Nal.Types(au);
                            if (types.Contains(5)) { keyframes++; if (types.Contains(7) && types.Contains(8)) withParams++; }
                            encoded.Add(au);
                        }
                    }
                }
                finally { pin.Free(); }

                if (encoded.Count == 0) return Fail("encoder produced no output");
                if (keyframes < 2) return Fail("expected the first IDR and a forced one, got " + keyframes);
                if (withParams < 1) return Fail("no keyframe carried SPS+PPS");

                int decoded = 0;
                double worst = 0;
                List<byte[]> frames = new List<byte[]>();
                foreach (byte[] au in encoded) frames.AddRange(dec.Decode(au));
                frames.AddRange(dec.Drain());
                for (int i = 0; i < frames.Count && i < sources.Count; i++)
                {
                    decoded++;
                    double err = 0;
                    byte[] y = frames[i];
                    byte[] src = sources[i];
                    for (int p = 0; p < W * H; p += 7) err += Math.Abs(y[p] - src[p]);
                    err /= (W * H / 7);
                    if (err > worst) worst = err;
                }
                if (decoded < FRAMES / 2) return Fail("decoder produced only " + decoded + " frames");
                if (worst > 12.0) return Fail("decoded luma differs from source (mean abs error " + worst.ToString("F1") + ")");

                long total = 0;
                foreach (byte[] au in encoded) total += au.Length;
                Console.WriteLine("SELFTEST OK frames=" + decoded + " keyframes=" + keyframes +
                                  " bytes=" + total + " worstLumaError=" + worst.ToString("F2", CultureInfo.InvariantCulture));
                return 0;
            }
            catch (Exception e)
            {
                return Fail(e.ToString());
            }
        }

        /// <summary>The fused downscale must agree with the plain conversion of the same image.</summary>
        private static bool ScaledConversionIsSane()
        {
            const int SW = 1280, SH = 720, DW = 640, DH = 360;
            byte[] bgra = new byte[SW * SH * 4];
            for (int y = 0; y < SH; y++)
                for (int x = 0; x < SW; x++)
                {
                    int i = (y * SW + x) * 4;
                    bgra[i] = (byte)(x * 255 / SW);
                    bgra[i + 1] = (byte)(y * 255 / SH);
                    bgra[i + 2] = (byte)((x + y) * 255 / (SW + SH));
                    bgra[i + 3] = 255;
                }
            byte[] full = new byte[SW * SH * 3 / 2];
            byte[] small = new byte[DW * DH * 3 / 2];
            GCHandle pin = GCHandle.Alloc(bgra, GCHandleType.Pinned);
            try
            {
                Convert709.BgraToNv12(pin.AddrOfPinnedObject(), SW * 4, SW, SH, SW, SH, full);
                Convert709.BgraToNv12(pin.AddrOfPinnedObject(), SW * 4, SW, SH, DW, DH, small);
            }
            finally { pin.Free(); }

            double yErr = 0; int yN = 0;
            for (int y = 0; y < DH; y += 3)
                for (int x = 0; x < DW; x += 3)
                {
                    double mean = (full[2 * y * SW + 2 * x] + full[2 * y * SW + 2 * x + 1] +
                                   full[(2 * y + 1) * SW + 2 * x] + full[(2 * y + 1) * SW + 2 * x + 1]) / 4.0;
                    yErr += Math.Abs(small[y * DW + x] - mean);
                    yN++;
                }
            double cErr = 0; int cN = 0;
            for (int cy = 0; cy < DH / 2; cy += 3)
                for (int cx = 0; cx < DW / 2; cx += 3)
                {
                    int fu = SW * SH + (2 * cy) * SW + (2 * cx) * 2;
                    int su = DW * DH + cy * DW + cx * 2;
                    cErr += Math.Abs(small[su] - full[fu]) + Math.Abs(small[su + 1] - full[fu + 1]);
                    cN += 2;
                }
            return yErr / yN < 3.0 && cErr / cN < 4.0;
        }

        private static int Fail(string why)
        {
            Console.WriteLine("SELFTEST FAILED: " + why);
            return 1;
        }

        // Moving gradient + a bright square: gives the encoder real motion to compress.
        private static void Paint(byte[] bgra, int w, int h, int frame)
        {
            int sx = (frame * 9) % (w - 80), sy = (frame * 5) % (h - 80);
            for (int y = 0; y < h; y++)
            {
                for (int x = 0; x < w; x++)
                {
                    int i = (y * w + x) * 4;
                    bool square = x >= sx && x < sx + 80 && y >= sy && y < sy + 80;
                    bgra[i] = (byte)(square ? 40 : (x * 255 / w));
                    bgra[i + 1] = (byte)(square ? 220 : (y * 255 / h));
                    bgra[i + 2] = (byte)(square ? 240 : ((x + y + frame * 3) & 255));
                    bgra[i + 3] = 255;
                }
            }
        }
    }
}

