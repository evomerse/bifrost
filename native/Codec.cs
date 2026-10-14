using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

namespace Bifrost
{
    /// <summary>Low-latency H.264 encoder (Microsoft MFT): NV12 in, Annex B byte stream out.</summary>
    internal sealed class H264Encoder : IDisposable
    {
        private readonly IMFTransform mft;
        private readonly ICodecAPI api;
        private readonly int width, height, fps;
        private readonly bool providesSamples;
        private readonly int outSize;
        private readonly long frameDuration;
        private long frameIndex;
        private bool disposed;

        public H264Encoder(int width, int height, int fps, int bitrate)
        {
            if ((width & 1) != 0 || (height & 1) != 0) throw new ArgumentException("width and height must be even");
            this.width = width;
            this.height = height;
            this.fps = fps;
            frameDuration = 10000000L / fps;

            Mf.CoInitializeEx(IntPtr.Zero, 0x0);
            Mf.Check(Mf.MFStartup(Mf.Version, 0), "MFStartup");

            Type t = Type.GetTypeFromCLSID(Mf.ClsidEncoder, true);
            mft = (IMFTransform)Activator.CreateInstance(t);
            api = (ICodecAPI)mft;

            // Rate control and latency settings must precede the media types.
            SetApi(Mf.CodecRateControl, (uint)0);            // CBR
            SetApi(Mf.CodecMeanBitrate, (uint)bitrate);
            SetApi(Mf.CodecGopSize, (uint)(fps * 20));       // a keyframe every 20 s, others on demand
            SetApi(Mf.CodecBPictures, (uint)0);
            SetApi(Mf.CodecLowLatency, true);

            IMFAttributes outType;
            Mf.Check(Mf.MFCreateMediaType(out outType), "MFCreateMediaType");
            Guid g;
            g = Mf.MajorType; Guid video = Mf.VideoMajor; outType.SetGUID(ref g, ref video);
            g = Mf.Subtype; Guid h264 = Mf.FormatH264; outType.SetGUID(ref g, ref h264);
            g = Mf.AvgBitrate; outType.SetUINT32(ref g, (uint)bitrate);
            g = Mf.InterlaceMode; outType.SetUINT32(ref g, 2); // progressive
            g = Mf.FrameSize; outType.SetUINT64(ref g, Mf.Pack(width, height));
            g = Mf.FrameRate; outType.SetUINT64(ref g, Mf.Pack(fps, 1));
            g = Mf.PixelAspect; outType.SetUINT64(ref g, Mf.Pack(1, 1));
            g = Mf.Mpeg2Profile; outType.SetUINT32(ref g, 77); // Main
            mft.SetOutputType(0, outType, 0);

            IMFAttributes inType;
            Mf.Check(Mf.MFCreateMediaType(out inType), "MFCreateMediaType");
            g = Mf.MajorType; inType.SetGUID(ref g, ref video);
            g = Mf.Subtype; Guid nv12 = Mf.FormatNv12; inType.SetGUID(ref g, ref nv12);
            g = Mf.InterlaceMode; inType.SetUINT32(ref g, 2);
            g = Mf.FrameSize; inType.SetUINT64(ref g, Mf.Pack(width, height));
            g = Mf.FrameRate; inType.SetUINT64(ref g, Mf.Pack(fps, 1));
            g = Mf.PixelAspect; inType.SetUINT64(ref g, Mf.Pack(1, 1));
            mft.SetInputType(0, inType, 0);

            MftOutputStreamInfo info;
            mft.GetOutputStreamInfo(0, out info);
            providesSamples = (info.Flags & Mf.OutputProvidesSamples) != 0;
            outSize = (int)Math.Max(info.Size, 1u << 20);

            mft.ProcessMessage(Mf.MessageBeginStreaming, IntPtr.Zero);
            mft.ProcessMessage(Mf.MessageStartOfStream, IntPtr.Zero);
        }

        private void SetApi(Guid key, object value)
        {
            object boxed = value;
            // Not every setting is supported by every build of the encoder: ignore refusals.
            api.SetValue(ref key, ref boxed);
        }

        public void ForceKeyframe()
        {
            SetApi(Mf.CodecForceKeyframe, (uint)1);
        }

        public void SetBitrate(int bitsPerSecond)
        {
            SetApi(Mf.CodecMeanBitrate, (uint)bitsPerSecond);
        }

        /// <summary>Encodes one NV12 frame. Returns zero or more Annex B access units.</summary>
        public List<byte[]> Encode(byte[] nv12)
        {
            IMFMediaBuffer buffer;
            Mf.Check(Mf.MFCreateMemoryBuffer(nv12.Length, out buffer), "MFCreateMemoryBuffer");
            IntPtr p; int max, cur;
            buffer.Lock(out p, out max, out cur);
            Marshal.Copy(nv12, 0, p, nv12.Length);
            buffer.Unlock();
            buffer.SetCurrentLength(nv12.Length);

            IMFSample sample;
            Mf.Check(Mf.MFCreateSample(out sample), "MFCreateSample");
            sample.AddBuffer(buffer);
            sample.SetSampleTime(frameIndex * frameDuration);
            sample.SetSampleDuration(frameDuration);
            frameIndex++;

            int hr = mft.ProcessInput(0, sample, 0);
            Marshal.ReleaseComObject(sample);
            Marshal.ReleaseComObject(buffer);
            Mf.Check(hr, "ProcessInput");
            return Drain();
        }

        private List<byte[]> Drain()
        {
            List<byte[]> result = new List<byte[]>();
            for (;;)
            {
                MftOutputDataBuffer ob = new MftOutputDataBuffer();
                ob.StreamId = 0;
                IMFSample ours = null;
                if (!providesSamples)
                {
                    IMFMediaBuffer b;
                    Mf.Check(Mf.MFCreateMemoryBuffer(outSize, out b), "MFCreateMemoryBuffer");
                    Mf.Check(Mf.MFCreateSample(out ours), "MFCreateSample");
                    ours.AddBuffer(b);
                    Marshal.ReleaseComObject(b);
                    ob.Sample = Marshal.GetIUnknownForObject(ours);
                }
                uint status;
                int hr = mft.ProcessOutput(0, 1, ref ob, out status);
                if (hr == Mf.NeedMoreInput)
                {
                    if (ob.Sample != IntPtr.Zero) Marshal.Release(ob.Sample);
                    if (ours != null) Marshal.ReleaseComObject(ours);
                    break;
                }
                Mf.Check(hr, "ProcessOutput");
                if (ob.Events != IntPtr.Zero) Marshal.Release(ob.Events);

                IMFSample outSample = (IMFSample)Marshal.GetObjectForIUnknown(ob.Sample);
                result.Add(ReadSample(outSample));
                Marshal.ReleaseComObject(outSample);
                Marshal.Release(ob.Sample);
                if (ours != null) Marshal.ReleaseComObject(ours);
            }
            return result;
        }

        internal static byte[] ReadSample(IMFSample sample)
        {
            IMFMediaBuffer buf;
            sample.ConvertToContiguousBuffer(out buf);
            IntPtr p; int max, len;
            buf.Lock(out p, out max, out len);
            byte[] data = new byte[len];
            Marshal.Copy(p, data, 0, len);
            buf.Unlock();
            Marshal.ReleaseComObject(buf);
            return data;
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            try { Marshal.ReleaseComObject(mft); } catch { }
        }
    }

    /// <summary>H.264 decoder (Microsoft MFT). Used by the self-test to validate the encoder output.</summary>
    internal sealed class H264Decoder : IDisposable
    {
        private readonly IMFTransform mft;
        private bool providesSamples;
        private int outSize;
        private long time;

        public H264Decoder(int width, int height)
        {
            Mf.CoInitializeEx(IntPtr.Zero, 0x0);
            Mf.Check(Mf.MFStartup(Mf.Version, 0), "MFStartup");
            Type t = Type.GetTypeFromCLSID(Mf.ClsidDecoder, true);
            mft = (IMFTransform)Activator.CreateInstance(t);
            try
            {
                IMFAttributes attrs;
                mft.GetAttributes(out attrs);
                Guid ll = Mf.LowLatency;
                attrs.SetUINT32(ref ll, 1);
            }
            catch (Exception) { }

            IMFAttributes inType;
            Mf.Check(Mf.MFCreateMediaType(out inType), "MFCreateMediaType");
            Guid g;
            g = Mf.MajorType; Guid video = Mf.VideoMajor; inType.SetGUID(ref g, ref video);
            g = Mf.Subtype; Guid h264 = Mf.FormatH264; inType.SetGUID(ref g, ref h264);
            g = Mf.FrameSize; inType.SetUINT64(ref g, Mf.Pack(width, height));
            g = Mf.InterlaceMode; inType.SetUINT32(ref g, 2);
            mft.SetInputType(0, inType, 0);
            SelectNv12Output();
            mft.ProcessMessage(Mf.MessageBeginStreaming, IntPtr.Zero);
            mft.ProcessMessage(Mf.MessageStartOfStream, IntPtr.Zero);
        }

        private void SelectNv12Output()
        {
            for (uint i = 0; ; i++)
            {
                IMFAttributes type;
                int hr = mft.GetOutputAvailableType(0, i, out type);
                if (hr < 0) throw new InvalidOperationException("decoder offers no NV12 output");
                Guid key = Mf.Subtype;
                Guid subtype;
                type.GetGUID(ref key, out subtype);
                if (subtype != Mf.FormatNv12) continue;
                mft.SetOutputType(0, type, 0);
                MftOutputStreamInfo info;
                mft.GetOutputStreamInfo(0, out info);
                providesSamples = (info.Flags & Mf.OutputProvidesSamples) != 0;
                outSize = (int)Math.Max(info.Size, 1u << 20);
                return;
            }
        }

        /// <summary>Feeds one access unit; returns decoded NV12 frames.</summary>
        public List<byte[]> Decode(byte[] annexB)
        {
            IMFMediaBuffer buffer;
            Mf.Check(Mf.MFCreateMemoryBuffer(annexB.Length, out buffer), "MFCreateMemoryBuffer");
            IntPtr p; int max, cur;
            buffer.Lock(out p, out max, out cur);
            Marshal.Copy(annexB, 0, p, annexB.Length);
            buffer.Unlock();
            buffer.SetCurrentLength(annexB.Length);
            IMFSample sample;
            Mf.Check(Mf.MFCreateSample(out sample), "MFCreateSample");
            sample.AddBuffer(buffer);
            sample.SetSampleTime(time);
            sample.SetSampleDuration(333333);
            time += 333333;
            int hr = mft.ProcessInput(0, sample, 0);
            Marshal.ReleaseComObject(sample);
            Marshal.ReleaseComObject(buffer);
            Mf.Check(hr, "decoder ProcessInput");
            return Collect();
        }

        /// <summary>Signals end of stream and returns the frames still queued in the decoder.</summary>
        public List<byte[]> Drain()
        {
            mft.ProcessMessage(1 /* MFT_MESSAGE_COMMAND_DRAIN */, IntPtr.Zero);
            return Collect();
        }

        private List<byte[]> Collect()
        {
            int hr;
            List<byte[]> frames = new List<byte[]>();
            for (;;)
            {
                MftOutputDataBuffer ob = new MftOutputDataBuffer();
                IMFSample ours = null;
                if (!providesSamples)
                {
                    IMFMediaBuffer b;
                    Mf.Check(Mf.MFCreateMemoryBuffer(outSize, out b), "MFCreateMemoryBuffer");
                    Mf.Check(Mf.MFCreateSample(out ours), "MFCreateSample");
                    ours.AddBuffer(b);
                    Marshal.ReleaseComObject(b);
                    ob.Sample = Marshal.GetIUnknownForObject(ours);
                }
                uint status;
                hr = mft.ProcessOutput(0, 1, ref ob, out status);
                if (hr == Mf.StreamChange)
                {
                    if (ob.Sample != IntPtr.Zero) Marshal.Release(ob.Sample);
                    if (ours != null) Marshal.ReleaseComObject(ours);
                    SelectNv12Output();
                    continue;
                }
                if (hr == Mf.NeedMoreInput)
                {
                    if (ob.Sample != IntPtr.Zero) Marshal.Release(ob.Sample);
                    if (ours != null) Marshal.ReleaseComObject(ours);
                    break;
                }
                Mf.Check(hr, "decoder ProcessOutput");
                if (ob.Events != IntPtr.Zero) Marshal.Release(ob.Events);
                IMFSample outSample = (IMFSample)Marshal.GetObjectForIUnknown(ob.Sample);
                frames.Add(H264Encoder.ReadSample(outSample));
                Marshal.ReleaseComObject(outSample);
                Marshal.Release(ob.Sample);
                if (ours != null) Marshal.ReleaseComObject(ours);
            }
            return frames;
        }

        public void Dispose()
        {
            try { Marshal.ReleaseComObject(mft); } catch { }
        }
    }

    internal static class Convert709
    {
        /// <summary>
        /// BGRA (32 bpp, stride bytes per row) to NV12, BT.709 limited range. Rows are processed
        /// in parallel; chroma is the average of each 2x2 block.
        /// </summary>
        public static void BgraToNv12(IntPtr source, int stride, int srcW, int srcH, int dstW, int dstH, byte[] nv12)
        {
            if (srcW == dstW && srcH == dstH) Fast(source, stride, dstW, dstH, nv12);
            else Scaled(source, stride, srcW, srcH, dstW, dstH, nv12);
        }

        private static void Axis(int srcLen, int dstLen, int[] index, int[] frac)
        {
            for (int i = 0; i < dstLen; i++)
            {
                double s = (i + 0.5) * srcLen / dstLen - 0.5;
                if (s < 0) s = 0;
                int k = (int)s;
                if (k > srcLen - 2) k = Math.Max(0, srcLen - 2);
                int f = (int)((s - k) * 256);
                index[i] = k;
                frac[i] = f > 256 ? 256 : f;
            }
        }

        private static unsafe void Sample(byte* src, int stride, int xi, int fx, int yi, int fy, out int r, out int g, out int b)
        {
            byte* p0 = src + (long)yi * stride + xi * 4;
            byte* p1 = p0 + stride;
            int wx0 = 256 - fx, wy0 = 256 - fy;
            b = ((p0[0] * wx0 + p0[4] * fx) * wy0 + (p1[0] * wx0 + p1[4] * fx) * fy) >> 16;
            g = ((p0[1] * wx0 + p0[5] * fx) * wy0 + (p1[1] * wx0 + p1[5] * fx) * fy) >> 16;
            r = ((p0[2] * wx0 + p0[6] * fx) * wy0 + (p1[2] * wx0 + p1[6] * fx) * fy) >> 16;
        }

        /// <summary>Bilinear downscale fused with the BGRA to NV12 conversion (rows in parallel).</summary>
        private static unsafe void Scaled(IntPtr source, int stride, int srcW, int srcH, int dstW, int dstH, byte[] nv12)
        {
            int[] xi = new int[dstW], xf = new int[dstW], yi = new int[dstH], yf = new int[dstH];
            Axis(srcW, dstW, xi, xf);
            Axis(srcH, dstH, yi, yf);
            long src = source.ToInt64();
            fixed (byte* dstFixed = nv12)
            {
                long dst = (long)dstFixed;
                int ySize = dstW * dstH;
                Parallel.For(0, dstH / 2, delegate(int pair)
                {
                    byte* s = (byte*)src;
                    byte* y0 = (byte*)dst + (long)(pair * 2) * dstW;
                    byte* y1 = y0 + dstW;
                    byte* uv = (byte*)dst + ySize + (long)pair * dstW;
                    int ra = pair * 2, rb = pair * 2 + 1;
                    for (int x = 0; x < dstW; x += 2)
                    {
                        int r00, g00, b00, r01, g01, b01, r10, g10, b10, r11, g11, b11;
                        Sample(s, stride, xi[x], xf[x], yi[ra], yf[ra], out r00, out g00, out b00);
                        Sample(s, stride, xi[x + 1], xf[x + 1], yi[ra], yf[ra], out r01, out g01, out b01);
                        Sample(s, stride, xi[x], xf[x], yi[rb], yf[rb], out r10, out g10, out b10);
                        Sample(s, stride, xi[x + 1], xf[x + 1], yi[rb], yf[rb], out r11, out g11, out b11);
                        y0[x] = (byte)(16 + ((47 * r00 + 157 * g00 + 16 * b00 + 128) >> 8));
                        y0[x + 1] = (byte)(16 + ((47 * r01 + 157 * g01 + 16 * b01 + 128) >> 8));
                        y1[x] = (byte)(16 + ((47 * r10 + 157 * g10 + 16 * b10 + 128) >> 8));
                        y1[x + 1] = (byte)(16 + ((47 * r11 + 157 * g11 + 16 * b11 + 128) >> 8));
                        int r = (r00 + r01 + r10 + r11 + 2) >> 2;
                        int g = (g00 + g01 + g10 + g11 + 2) >> 2;
                        int b = (b00 + b01 + b10 + b11 + 2) >> 2;
                        int u = 128 + ((-26 * r - 87 * g + 112 * b + 128) >> 8);
                        int v = 128 + ((112 * r - 102 * g - 10 * b + 128) >> 8);
                        uv[x] = (byte)(u < 0 ? 0 : (u > 255 ? 255 : u));
                        uv[x + 1] = (byte)(v < 0 ? 0 : (v > 255 ? 255 : v));
                    }
                });
            }
        }

        private static unsafe void Fast(IntPtr source, int stride, int w, int h, byte[] nv12)
        {
            long src = source.ToInt64();
            fixed (byte* dstFixed = nv12)
            {
                long dst = (long)dstFixed;
                int ySize = w * h;
                Parallel.For(0, h / 2, delegate(int pair)
                {
                    byte* s0 = (byte*)src + (long)(pair * 2) * stride;
                    byte* s1 = s0 + stride;
                    byte* y0 = (byte*)dst + (long)(pair * 2) * w;
                    byte* y1 = y0 + w;
                    byte* uv = (byte*)dst + ySize + (long)pair * w;
                    for (int x = 0; x < w; x += 2)
                    {
                        int i = x * 4;
                        int b00 = s0[i], g00 = s0[i + 1], r00 = s0[i + 2];
                        int b01 = s0[i + 4], g01 = s0[i + 5], r01 = s0[i + 6];
                        int b10 = s1[i], g10 = s1[i + 1], r10 = s1[i + 2];
                        int b11 = s1[i + 4], g11 = s1[i + 5], r11 = s1[i + 6];
                        y0[x] = (byte)(16 + ((47 * r00 + 157 * g00 + 16 * b00 + 128) >> 8));
                        y0[x + 1] = (byte)(16 + ((47 * r01 + 157 * g01 + 16 * b01 + 128) >> 8));
                        y1[x] = (byte)(16 + ((47 * r10 + 157 * g10 + 16 * b10 + 128) >> 8));
                        y1[x + 1] = (byte)(16 + ((47 * r11 + 157 * g11 + 16 * b11 + 128) >> 8));
                        int r = (r00 + r01 + r10 + r11 + 2) >> 2;
                        int g = (g00 + g01 + g10 + g11 + 2) >> 2;
                        int b = (b00 + b01 + b10 + b11 + 2) >> 2;
                        int u = 128 + ((-26 * r - 87 * g + 112 * b + 128) >> 8);
                        int v = 128 + ((112 * r - 102 * g - 10 * b + 128) >> 8);
                        uv[x] = (byte)(u < 0 ? 0 : (u > 255 ? 255 : u));
                        uv[x + 1] = (byte)(v < 0 ? 0 : (v > 255 ? 255 : v));
                    }
                });
            }
        }
    }

    internal static class Nal
    {
        private struct Unit { public int Offset; public int Length; }

        /// <summary>Splits an Annex B buffer into NAL units (start codes and trailing zeros removed).</summary>
        private static List<Unit> Split(byte[] d)
        {
            List<int> starts = new List<int>();   // index of the first byte after a start code
            for (int i = 0; i + 2 < d.Length; i++)
            {
                if (d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 1) { starts.Add(i + 3); i += 2; }
            }
            List<Unit> units = new List<Unit>();
            for (int k = 0; k < starts.Count; k++)
            {
                int begin = starts[k];
                int end = k + 1 < starts.Count ? starts[k + 1] - 3 : d.Length;
                while (end > begin && d[end - 1] == 0) end--;   // zero_byte of a 4-byte start code
                if (end > begin) { Unit u; u.Offset = begin; u.Length = end - begin; units.Add(u); }
            }
            return units;
        }

        /// <summary>NAL unit types present in an Annex B buffer (5 = IDR, 7 = SPS, 8 = PPS).</summary>
        public static List<int> Types(byte[] data)
        {
            List<int> types = new List<int>();
            foreach (Unit u in Split(data)) types.Add(data[u.Offset] & 0x1f);
            return types;
        }

        /// <summary>The SPS and PPS units of the buffer, each with a 4-byte start code.</summary>
        public static byte[] ParameterSets(byte[] data)
        {
            List<byte> output = new List<byte>();
            foreach (Unit u in Split(data))
            {
                int type = data[u.Offset] & 0x1f;
                if (type != 7 && type != 8) continue;
                output.Add(0); output.Add(0); output.Add(0); output.Add(1);
                for (int j = 0; j < u.Length; j++) output.Add(data[u.Offset + j]);
            }
            return output.ToArray();
        }
    }
}

