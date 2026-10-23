// Listen: runs whisper-stream and hands its finished transcriptions to voice_listen.ps1.
// Used by voice_listen.ps1 (Add-Type -Path); Windows only. Lines arrive on the process's own threads, so they
// go through a queue the script empties in its loop.
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace VoiceListen {
  public class Utterance {
    public string Text;
    public double StartMs;    // where its new speech began, in the stream's own time
    public double EndMs;      // where its new speech ended, in the stream's own time
    public DateTime Heard;    // when its transcription was printed
  }

  public class Stream {
    public readonly ConcurrentQueue<Utterance> Said = new ConcurrentQueue<Utterance>();
    public readonly ConcurrentQueue<string> Log = new ConcurrentQueue<string>();
    public Process Proc;
    public DateTime AudioStart = DateTime.MinValue;   // when whisper-stream began to capture
    readonly StringBuilder current = new StringBuilder();
    bool inside;
    double windowMs, startMs, endMs;
    double heardUntil = -1;   // where the last segment handed over ended, in the stream's time

    public Stream(string exe, string args) {
      var si = new ProcessStartInfo(exe, args) {
        UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardOutput = true, RedirectStandardError = true,
        StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
      };
      Proc = new Process { StartInfo = si, EnableRaisingEvents = true };
      Proc.OutputDataReceived += (o, e) => { if (e.Data != null) Line(e.Data); };
      // whisper's own log: only the lines about the microphone are kept.
      Proc.ErrorDataReceived += (o, e) => {
        if (e.Data != null && Regex.IsMatch(e.Data, "capture device|SDL|audio_async")) Log.Enqueue(e.Data.Trim());
      };
      Proc.Start();
      Jailed = Jail(Proc);
      Proc.BeginOutputReadLine();
      Proc.BeginErrorReadLine();
    }

    // whisper-stream holds the microphone: it goes into a job that kills it once the job's last
    // handle closes, so it ends with this process however this process ends (a kill included).
    public bool Jailed;
    static IntPtr job = IntPtr.Zero;

    static bool Jail(Process p) {
      try {
        if (job == IntPtr.Zero) {
          var j = CreateJobObject(IntPtr.Zero, null);
          if (j == IntPtr.Zero) return false;
          var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
          info.Basic.LimitFlags = 0x2000;   // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
          if (!SetInformationJobObject(j, 9, ref info, (uint)Marshal.SizeOf(info))) return false;
          job = j;
        }
        return AssignProcessToJobObject(job, p.Handle);
      } catch (Exception) { return false; }
    }

    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
      public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong R, W, O, RB, WB, OB; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic; public IO_COUNTERS Io;
      public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    static readonly Regex Segment = new Regex(
      @"^\s*\[(\d+):(\d+):(\d+(?:\.\d+)?)\s*-->\s*(\d+):(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$");

    static double Ms(Match m, int at) {
      return (int.Parse(m.Groups[at].Value) * 3600 + int.Parse(m.Groups[at + 1].Value) * 60
              + double.Parse(m.Groups[at + 2].Value, System.Globalization.CultureInfo.InvariantCulture)) * 1000;
    }

    // In VAD mode whisper-stream prints "[Start speaking]" once it captures, then each utterance
    // between "### Transcription N START | t0 = .. ms | t1 = .. ms" and "### Transcription N END",
    // with "[t0 --> t1]" before each segment, relative to t0. Each one transcribes the last
    // --length ms of audio, so it repeats what the previous ones already said: a segment whose
    // middle lies before the end of what was handed over is dropped.
    void Line(string l) {
      if (l.Contains("[Start speaking]")) { AudioStart = DateTime.Now; return; }
      if (l.StartsWith("### Transcription") && l.Contains("START")) {
        inside = true; current.Clear();
        var m0 = Regex.Match(l, @"t0\s*=\s*(\d+)");
        windowMs = m0.Success ? double.Parse(m0.Groups[1].Value) : -1;
        startMs = endMs = -1;
        return;
      }
      if (l.StartsWith("### Transcription") && l.Contains("END")) {
        inside = false;
        var text = Regex.Replace(current.ToString(), @"\s+", " ").Trim();
        if (text.Length > 0) Said.Enqueue(new Utterance { Text = text, StartMs = startMs, EndMs = endMs, Heard = DateTime.Now });
        if (endMs > heardUntil) heardUntil = endMs;
        return;
      }
      if (!inside) return;
      var s = Segment.Match(l);
      if (!s.Success || windowMs < 0) { current.Append(' ').Append(l); return; }
      double from = windowMs + Ms(s, 1), to = windowMs + Ms(s, 4);
      if ((from + to) / 2 <= heardUntil) return;   // already handed over
      if (startMs < 0) startMs = from;
      endMs = to;
      current.Append(' ').Append(s.Groups[7].Value);
    }

    public void Stop() {
      try { if (!Proc.HasExited) Proc.Kill(); } catch (InvalidOperationException) { }
    }
  }
}
