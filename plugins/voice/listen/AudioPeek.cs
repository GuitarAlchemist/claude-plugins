// AudioPeek: per-app audio sessions on the default output device, through Windows Core Audio.
// Used by voice_courtesy.ps1 and voice_listen.ps1 (Add-Type -Path); Windows only.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace AudioPeek {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { int NotImpl1(); [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev); }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { [PreserveSig] int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }

  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 { int NotImpl1(); int NotImpl2(); [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e); }

  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator { [PreserveSig] int GetCount(out int n); [PreserveSig] int GetSession(int i, out IAudioSessionControl2 s); }

  // IAudioSessionControl (methods 0-8) followed by IAudioSessionControl2 (9-11 used here).
  [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int st);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid ctx);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid ctx);
    int a5(); int a6(); int a7(); int a8(); int a9(); int a10();
    [PreserveSig] int GetProcessId(out uint pid);
  }

  [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioMeterInformation { [PreserveSig] int GetPeakValue(out float peak); }

  public static class Peek {
    static List<IAudioSessionControl2> Sessions() {
      var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDevice dev; Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));
      Guid iid = typeof(IAudioSessionManager2).GUID; object o;
      Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
      IAudioSessionEnumerator se; Marshal.ThrowExceptionForHR(((IAudioSessionManager2)o).GetSessionEnumerator(out se));
      int n; se.GetCount(out n);
      var all = new List<IAudioSessionControl2>();
      for (int i = 0; i < n; i++) { IAudioSessionControl2 s; se.GetSession(i, out s); all.Add(s); }
      return all;
    }

    // The highest current peak (0..1) of each process with an audio session.
    public static Dictionary<uint, float> Peaks() {
      var r = new Dictionary<uint, float>();
      foreach (var s in Sessions()) {
        uint pid; s.GetProcessId(out pid);
        float p; ((IAudioMeterInformation)s).GetPeakValue(out p);
        float old; r[pid] = r.TryGetValue(pid, out old) ? Math.Max(old, p) : p;
      }
      return r;
    }

    static IAudioMeterInformation mic;
    static int micCalls;

    // The peak (0..1) of the default microphone, or -1 when there is none. Windows meters a
    // capture device only while some program records from it.
    public static float MicPeak() {
      try {
        if (mic == null || ++micCalls % 50 == 0) {   // follow a change of default device
          var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
          IMMDevice dev;
          if (en.GetDefaultAudioEndpoint(1, 0, out dev) != 0) { mic = null; return -1; }
          Guid iid = typeof(IAudioMeterInformation).GUID; object o;
          if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) { mic = null; return -1; }
          mic = (IAudioMeterInformation)o;
        }
        float p; mic.GetPeakValue(out p);
        return p;
      } catch (COMException) { mic = null; return -1; }
    }

    // Names a process's sessions and sets their icon, as the volume mixer shows them.
    // Returns how many sessions now carry that name and icon.
    public static int Brand(uint pid, string name, string icon) {
      int done = 0;
      foreach (var s in Sessions()) {
        uint p; s.GetProcessId(out p);
        if (p != pid) continue;
        Guid g = Guid.Empty;
        s.SetDisplayName(name, ref g);
        s.SetIconPath(icon, ref g);
        string got, gotIcon; s.GetDisplayName(out got); s.GetIconPath(out gotIcon);
        if (got == name && gotIcon == icon) done++;
      }
      return done;
    }
  }
}
