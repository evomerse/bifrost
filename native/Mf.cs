// Minimal Media Foundation interop for the Microsoft H.264 encoder/decoder MFTs.
// C# 5 / .NET Framework 4.x, no external packages. Only the vtable slots that are actually
// called are given real signatures; the others are placeholders that keep the slot order.

using System;
using System.Runtime.InteropServices;

namespace Bifrost
{
    internal static class Mf
    {
        public const uint Version = 0x00020070;
        public const int NeedMoreInput = unchecked((int)0xC00D6D72);
        public const int StreamChange = unchecked((int)0xC00D6D61);
        public const int NoMoreTypes = unchecked((int)0xC00D36B9);
        public const uint MessageFlush = 0x00000000;
        public const uint MessageBeginStreaming = 0x10000000;
        public const uint MessageStartOfStream = 0x10000003;
        public const uint OutputProvidesSamples = 0x100;

        public static readonly Guid MajorType = new Guid("48eba18e-f8c9-4687-bf11-0a74c9f96a8f");
        public static readonly Guid Subtype = new Guid("f7e34c9a-42e8-4714-b74b-cb29d72c35e5");
        public static readonly Guid AvgBitrate = new Guid("20332624-fb0d-4d9e-bd0d-cbf6786c102e");
        public static readonly Guid InterlaceMode = new Guid("e2724bb8-e676-4806-b4b2-a8d6efb44ccd");
        public static readonly Guid FrameSize = new Guid("1652c33d-d6b2-4012-b834-72030849a37d");
        public static readonly Guid FrameRate = new Guid("c459a2e8-3d2c-4e44-b132-fee5156c7bb0");
        public static readonly Guid PixelAspect = new Guid("c6376a1e-8d0a-4027-be45-6d9a0ad39bb6");
        public static readonly Guid Mpeg2Profile = new Guid("ad76a80b-2d5c-4e0b-b375-64e520137036");
        public static readonly Guid LowLatency = new Guid("9c27891a-ed7a-40e1-88e8-b22727a024ee");

        public static readonly Guid VideoMajor = new Guid("73646976-0000-0010-8000-00aa00389b71");
        public static readonly Guid FormatH264 = new Guid("34363248-0000-0010-8000-00aa00389b71");
        public static readonly Guid FormatNv12 = new Guid("3231564e-0000-0010-8000-00aa00389b71");

        public static readonly Guid ClsidEncoder = new Guid("6ca50344-051a-4ded-9779-a43305165e35");
        public static readonly Guid ClsidDecoder = new Guid("62ce7e72-4c71-4d20-b15d-452831a87d9d");

        public static readonly Guid CodecRateControl = new Guid("1c0608e9-370c-4710-8a58-cb6181c42423");
        public static readonly Guid CodecMeanBitrate = new Guid("f7222374-2144-4815-b550-a37f8e12ee52");
        public static readonly Guid CodecGopSize = new Guid("95f31b26-95a4-41aa-9303-246a7fc6eef1");
        public static readonly Guid CodecForceKeyframe = new Guid("398c1b98-8353-475a-9ef2-8f265d260345");
        public static readonly Guid CodecBPictures = new Guid("8d390aac-dc5c-4200-b57f-814d04babab2");
        public static readonly Guid CodecLowLatency = new Guid("9c27891a-ed7a-40e1-88e8-b22727a024ee");

        [DllImport("mfplat.dll")] public static extern int MFStartup(uint version, uint flags);
        [DllImport("mfplat.dll")] public static extern int MFShutdown();
        [DllImport("mfplat.dll")] public static extern int MFCreateMediaType(out IMFAttributes type);
        [DllImport("mfplat.dll")] public static extern int MFCreateSample(out IMFSample sample);
        [DllImport("mfplat.dll")] public static extern int MFCreateMemoryBuffer(int maxLength, out IMFMediaBuffer buffer);
        [DllImport("ole32.dll")] public static extern int CoInitializeEx(IntPtr reserved, uint coInit);

        public static void Check(int hr, string what)
        {
            if (hr < 0) throw new COMException(what + " failed: 0x" + hr.ToString("X8"), hr);
        }

        public static ulong Pack(int hi, int lo)
        {
            return ((ulong)(uint)hi << 32) | (uint)lo;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct MftOutputDataBuffer
    {
        public uint StreamId;
        public IntPtr Sample;
        public uint Status;
        public IntPtr Events;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct MftOutputStreamInfo
    {
        public uint Flags;
        public uint Size;
        public uint Alignment;
    }

    [ComImport, Guid("2cd2d921-c447-44a7-a13c-4adabfc247e3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMFAttributes
    {
        void A01(); void A02(); void A03(); void A04();
        void A05(); // GetUINT32
        void A06(); // GetUINT64
        void A07();
        void GetGUID([In] ref Guid key, out Guid value);
        void A09(); void A10(); void A11(); void A12(); void A13(); void A14(); void A15();
        void A16(); void A17(); void A18();
        void SetUINT32([In] ref Guid key, uint value);
        void SetUINT64([In] ref Guid key, ulong value);
        void A21(); // SetDouble
        void SetGUID([In] ref Guid key, [In] ref Guid value);
        void A23(); void A24(); void A25(); void A26(); void A27(); void A28(); void A29(); void A30();
    }

    [ComImport, Guid("045FA593-8799-42b8-BC8D-8968C6453507"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMFMediaBuffer
    {
        void Lock(out IntPtr buffer, out int maxLength, out int currentLength);
        void Unlock();
        void GetCurrentLength(out int length);
        void SetCurrentLength(int length);
        void GetMaxLength(out int length);
    }

    [ComImport, Guid("c40a00f2-b93a-4d80-ae8c-5a1c634f58e4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMFSample
    {
        void A01(); void A02(); void A03(); void A04(); void A05(); void A06(); void A07(); void A08(); void A09(); void A10();
        void A11(); void A12(); void A13(); void A14(); void A15(); void A16(); void A17(); void A18(); void A19(); void A20();
        void A21(); void A22(); void A23(); void A24(); void A25(); void A26(); void A27(); void A28(); void A29(); void A30();
        void GetSampleFlags(out uint flags);
        void SetSampleFlags(uint flags);
        void GetSampleTime(out long time);
        void SetSampleTime(long time);
        void GetSampleDuration(out long duration);
        void SetSampleDuration(long duration);
        void GetBufferCount(out uint count);
        void GetBufferByIndex(uint index, out IMFMediaBuffer buffer);
        void ConvertToContiguousBuffer(out IMFMediaBuffer buffer);
        void AddBuffer(IMFMediaBuffer buffer);
        void RemoveBufferByIndex(uint index);
        void RemoveAllBuffers();
        void GetTotalLength(out uint length);
        void CopyToBuffer(IMFMediaBuffer buffer);
    }

    [ComImport, Guid("bf94c121-5b05-4e6f-8000-ba598961414d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMFTransform
    {
        void GetStreamLimits(out uint inMin, out uint inMax, out uint outMin, out uint outMax);
        void GetStreamCount(out uint inputs, out uint outputs);
        void GetStreamIDs(uint inSize, IntPtr inIds, uint outSize, IntPtr outIds);
        void GetInputStreamInfo(uint streamId, IntPtr info);
        void GetOutputStreamInfo(uint streamId, out MftOutputStreamInfo info);
        void GetAttributes(out IMFAttributes attributes);
        void GetInputStreamAttributes(uint streamId, out IMFAttributes attributes);
        void GetOutputStreamAttributes(uint streamId, out IMFAttributes attributes);
        void DeleteInputStream(uint streamId);
        void AddInputStreams(uint count, IntPtr ids);
        [PreserveSig] int GetInputAvailableType(uint streamId, uint index, out IMFAttributes type);
        [PreserveSig] int GetOutputAvailableType(uint streamId, uint index, out IMFAttributes type);
        void SetInputType(uint streamId, IMFAttributes type, uint flags);
        void SetOutputType(uint streamId, IMFAttributes type, uint flags);
        void GetInputCurrentType(uint streamId, out IMFAttributes type);
        void GetOutputCurrentType(uint streamId, out IMFAttributes type);
        void GetInputStatus(uint streamId, out uint flags);
        void GetOutputStatus(out uint flags);
        void SetOutputBounds(long lower, long upper);
        void ProcessEvent(uint streamId, IntPtr evt);
        void ProcessMessage(uint message, IntPtr param);
        [PreserveSig] int ProcessInput(uint streamId, IMFSample sample, uint flags);
        [PreserveSig] int ProcessOutput(uint flags, uint count, ref MftOutputDataBuffer buffer, out uint status);
    }

    [ComImport, Guid("901db4c7-31ce-41a2-85dc-8fa0bf41b8da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface ICodecAPI
    {
        void IsSupported([In] ref Guid api);
        void IsModifiable([In] ref Guid api);
        void GetParameterRange();
        void GetParameterValues();
        void GetDefaultValue();
        void GetValue();
        [PreserveSig] int SetValue([In] ref Guid api, [In, MarshalAs(UnmanagedType.Struct)] ref object value);
    }
}

