# voice_listen.ps1: hands-free dictation for one Claude Code session, transcribed on this machine.
# Windows only (Core Audio, UI Automation, whisper.cpp's Windows build).
#
#   voice_listen.ps1 [-AutoSend] [-Language fr|en] [-Voice <piper voice>] [-Whisper <whisper-stream.exe>] [-Model <ggml-*.bin>]
#   voice_listen.ps1 -Stop                       # stop; the mic is released at once
#
# The voice plugin's /listen command starts it and reads its standard output: one JSON line per
# sentence for Claude, {"said": "...", "send": true|false}, which the plugin submits as a prompt
# (send) or puts in the prompt box for the user to send. A line {"error": "<code>", "where": "..."}
# says why it could not start (no-whisper, no-model, already). It never starts by itself.
#
# whisper-stream (whisper.cpp, local) hears the microphone and finds the utterances. Who they are
# for is the user's to say, and it holds until the user says otherwise. The spoken commands are
# understood in French and in English whatever -Language is, since people mix them:
#   "Top Claude", "Hey Claude"        everything after is for Claude; Piper answers "Oui ?"/"Yes?"
#   "Top Gaïa", "Hey Gaia"            everything after is for the other voice agent (-CallApp): dropped here
#   "Top", "Hey everyone"             an ambient conversation: dropped here
# A name in a sentence does not change who it is for; a start is for Claude (-StartTarget).
# "Claude, pause" (or "Claude, take a break") pauses: the mic is released until the pause file
# says otherwise (/listen resume, the avatar's button: no voice can resume, the mic is closed).
# "Claude, arrête d'écouter", "Claude, stop listening" (or "Claude, stop") stops listening.
# What Piper says back and what the wmux sidebar shows follow -Language: French for fr, English
# otherwise; -Voice is the Piper voice it asks for (empty: the service's default).
#
# Rules:
#   - audio never leaves the machine and is never written to disk; only the text of an
#     utterance addressed to Claude leaves this script, on its standard output, as a typed
#     prompt would;
#   - whisper-stream must open no socket: it is checked every 10 s and stopped if it does;
#   - whisper-stream runs in a job object that kills it when this script ends, however it ends,
#     so the mic is never left open behind it;
#   - listening runs only while this script runs; the plugin shows it above the prompt (and in
#     the wmux sidebar when wmux is there);
#   - the other voice agent's app (-CallApp, by default the ChatGPT app): while its call has the
#     microphone open (checked every second), what the user says is for it until "Top Claude" or
#     "Top"; when it closes, the target goes back to what it was. A call state that cannot be read
#     counts as open. What is said while the call's microphone is open also reaches the call, and
#     leaves the machine with it: that is the call's doing, not this script's. -CallApp none turns
#     this off;
#   - an utterance heard while Piper (or the other agent) played for a third of it or more is
#     dropped as their voice, so speaking over Piper does not count: wait for it to finish;
#   - with -Scene, the window in the foreground (checked every second) says where Claude answers:
#     a Godot window titled -SceneWindow writes "observatory" to the focus file, so the voice
#     plugin hands Claude's replies to that 3D scene; the terminal writes "claude";
#   - whisper cuts a sentence at each pause: its pieces wait and go as one prompt once the user
#     is done (the last piece came -JoinMs ago and no voice was heard after it);
#   - the same utterance twice within 10 s is sent once.
# The log (listen.log) records events, lengths, latency and memory, never what was said.
param(
    [int]$Threads = 0,
    [int]$JoinMs = 1500,
    [switch]$AutoSend,
    [switch]$Stop,
    [string]$Language = 'fr',
    [string]$Voice = '',
    [string]$Whisper = $env:VOICE_LISTEN_WHISPER,
    [string]$Model = $env:VOICE_LISTEN_MODEL,
    [string]$CallApp = 'ChatGPT',
    [switch]$Scene,
    [string]$SceneWindow = 'Observatory*',
    [ValidateSet('ambient', 'claude', 'gaia')][string]$StartTarget = 'claude'
)
$ErrorActionPreference = 'Stop'
if ($CallApp -eq 'none') { $CallApp = '' }   # the plugin passes 'none' rather than an empty argument
$root = if ($env:VOICE_LISTEN_HOME) { $env:VOICE_LISTEN_HOME } else { Join-Path $env:LOCALAPPDATA 'voice-listen' }
$stopFile = Join-Path $root 'stop'
if ($Stop) { New-Item -ItemType File -Force $stopFile | Out-Null; return }
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
function Emit($fields) { [Console]::Out.WriteLine(($fields | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
New-Item -ItemType Directory -Force $root | Out-Null
. (Join-Path $PSScriptRoot 'Commands.ps1')   # the spoken commands, the model choice, the words
$words = Get-Words $Language

# For the avatar: state is "loading", "on" or "paused", rewritten every second; level is the
# microphone's peak, rewritten every 200 ms while listening; last is what became of the last
# utterance ("sent", "typed": waits for Enter, "ignored": not for Claude, "piper": Piper's voice,
# "dropped": the other agent's voice, "held": the plugin could not put it in the prompt box);
# target is who the user speaks to ("claude", "gaia" or "ambient").
$stateFile = Join-Path $root 'state'
$levelFile = Join-Path $root 'level'
$lastFile = Join-Path $root 'last'
$targetFile = Join-Path $root 'target'
$callFile = Join-Path $root 'call'     # the call's microphone: "none", "muted" or "live", every second
$typedFile = Join-Path $root 'typed'   # rewritten just before a sentence goes out: Piper is not cut for it
$pauseFile = Join-Path $root 'pause'   # "paused" holds the mic released; anything else resumes
$focusFile = Join-Path $root 'focus'   # "observatory" (Claude answers in the 3D scene) or "claude", every second
$log = Join-Path $root 'listen.log'

# whisper-stream and its model: given, else found on PATH or under the data folder. Nothing is
# downloaded here; the plugin's README says how to put them there.
if (-not $Whisper) {
    $onPath = Get-Command whisper-stream.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    $Whisper = if ($onPath) { $onPath.Source } else {
        (Get-ChildItem $root -Recurse -Filter whisper-stream.exe -ErrorAction SilentlyContinue | Select-Object -First 1).FullName }
}
if (-not $Model) {
    $models = Join-Path $root 'models'
    $name = Select-Model @(Get-ChildItem $models -Filter 'ggml-*.bin' -ErrorAction SilentlyContinue | ForEach-Object Name) $Language
    $Model = if ($name) { Join-Path $models $name } else { $null }
}
if (-not $Whisper -or -not (Test-Path -LiteralPath $Whisper)) { Emit @{ error = 'no-whisper'; where = $root }; exit 1 }
if (-not $Model -or -not (Test-Path -LiteralPath $Model)) { Emit @{ error = 'no-model'; where = (Join-Path $root 'models') }; exit 1 }
if ($Threads -le 0) { $Threads = [Math]::Max(2, [Math]::Min(12, [Environment]::ProcessorCount)) }

# One listener at a time: two would send each utterance twice, and the first to stop would
# remove the files the other still writes.
$pidFile = Join-Path $root 'listen.pid'
$other = 0; try { $other = [int][IO.File]::ReadAllText($pidFile).Trim() } catch { }
if ($other -and $other -ne $PID) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $other" -ErrorAction SilentlyContinue
    if ($p -and $p.CommandLine -match 'voice_listen\.ps1') { Emit @{ error = 'already'; where = "$other" }; exit 1 }
}
Remove-Item $stopFile, $pauseFile -ErrorAction SilentlyContinue
Set-Content $pidFile $PID

$url = if ($env:PIPER_VOICE_URL) { $env:PIPER_VOICE_URL } else { 'http://127.0.0.1:59126' }
if (([Uri]$url).Host -notin '127.0.0.1', 'localhost', '::1', '[::1]') { $url = 'http://127.0.0.1:59126' }   # loopback only
Add-Type -Path (Join-Path $PSScriptRoot 'Listen.cs')
Add-Type -Path (Join-Path $PSScriptRoot 'AudioPeek.cs')
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [Windows.Automation.AutomationElement]
Add-Type -Namespace VoiceListen -Name Focus -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, System.Text.StringBuilder text, int count);
'@

$wmux = [bool](Get-Command wmux -ErrorAction SilentlyContinue)

function Note([string]$what) { Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format s), $what) -Encoding utf8 }
function SayIn([string]$text, [string]$voice) {
    $body = if ($voice) { @{ text = $text; voice = $voice } } else { @{ text = $text } }
    Invoke-RestMethod -Method Post "$url/v1/say" -ContentType 'application/json; charset=utf-8' `
        -Body ([Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Compress))) -TimeoutSec 2 | Out-Null
}
# In -Voice, else (a voice that is not installed) in the service's default rather than not at all.
function Say([string]$text) {
    try { SayIn $text $Voice } catch {
        try { if ($Voice) { SayIn $text '' } else { throw } } catch { Note "voice: $($_.Exception.Message)" }
    }
}
function Status([string]$text) { if ($wmux) { wmux set-status listen $text 2>&1 | Out-Null } }
# The avatar's files are only a display: a write that fails (the mod is reading) waits for the next.
function Put([string]$file, [string]$text) { try { [IO.File]::WriteAllText($file, $text) } catch { } }

# The other agent's call in its app: 'none', 'muted' (its microphone is off), or 'live'.
# Whatever cannot be read for sure counts as 'live', so the mic stays with the call.
function OtherCall {
    if (-not $CallApp) { return 'none' }
    $w = Get-Process $CallApp -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $w) { return 'none' }
    try {
        $buttons = $A::FromHandle($w.MainWindowHandle).FindAll([Windows.Automation.TreeScope]::Descendants,
            (New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, [Windows.Automation.ControlType]::Button)))
    } catch { return 'live' }
    if ($buttons.Count -lt 20) { return 'live' }   # the app's tree is not built: unknown
    $call = $false; $muted = $null
    foreach ($b in $buttons) {
        $n = $b.Current.Name
        # the sidebar item, or the call's own controls (the sidebar can be hidden)
        if ($n -like '*Call in progress*' -or $n -in 'Hang up', 'Mute microphone' -or $n -like 'Unmute*') { $call = $true }
        if ($n -like 'Unmute*') { $muted = $true }
        elseif ($n -eq 'Mute microphone') {
            try { $muted = $b.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern).Current.ToggleState -eq 'On' } catch { }
        }
    }
    if (-not $call) { 'none' } elseif ($muted -eq $true) { 'muted' } else { 'live' }
}

# The window in the foreground, with -Scene only: 'observatory' (the 3D scene's Godot window),
# 'claude' (a terminal), or 'other', which changes nothing.
function Focus {
    if (-not $Scene) { return 'claude' }
    $window = [VoiceListen.Focus]::GetForegroundWindow()
    $title = New-Object Text.StringBuilder 256
    [VoiceListen.Focus]::GetWindowText($window, $title, 256) | Out-Null
    $owner = [uint32]0; [VoiceListen.Focus]::GetWindowThreadProcessId($window, [ref]$owner) | Out-Null
    $name = (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName
    if ($name -like 'godot*' -and $title.ToString() -like $SceneWindow) { 'observatory' }
    elseif ($name -in 'wmux', 'WindowsTerminal', 'conhost', 'Code', 'claude') { 'claude' }
    else { 'other' }
}

# How long the ticks of $list (one per pass of the loop, when the source was loud) cover between
# $from and $to: each tick stands for the time since the one before, up to 500 ms, since a pass
# lasts 200 ms plus its work (a call check).
function Covered($list, [DateTime]$from, [DateTime]$to) {
    $ms = 0.0; $prev = $null
    foreach ($t in $list) {
        if ($t -ge $from -and $t -le $to) { $ms += $(if ($prev) { [Math]::Min(($t - $prev).TotalMilliseconds, 500) } else { 200 }) }
        $prev = $t
    }
    $ms
}

# Whether the held pieces of a sentence can go: the last came $JoinMs ago and no voice was heard
# after its end, or that voice is 8 s old and was never transcribed (a noise); 30 s at most.
function ReadyToSend([DateTime]$now, [DateTime]$heard, [DateTime]$end, [DateTime]$voice, [DateTime]$first) {
    if (($now - $first).TotalSeconds -ge 30) { return $true }
    if (($now - $heard).TotalMilliseconds -lt $JoinMs) { return $false }
    $more = $voice -gt $end.AddMilliseconds(500)
    (-not $more) -or ($now - $voice).TotalSeconds -ge 8
}

# Hands the held sentence to the plugin, on standard output: 'sent', or 'gone' (the session).
function Flush {
    $text = $script:buffer; $script:buffer = ''
    Put $typedFile 'typed'
    try { Emit @{ said = $text; send = [bool]$AutoSend } }
    catch { Note 'the session is gone: stopped'; New-Item -ItemType File -Force $stopFile | Out-Null; return 'gone' }
    $script:sent++; Put $lastFile $(if ($AutoSend) { 'sent' } else { 'typed' })
    Note "handed over an utterance ($($text.Length) chars in $($script:pieces) piece(s), $(if ($AutoSend) { 'sent' } else { 'waiting for Enter' }); $($script:bufferFacts))"
    'sent'
}

$stream = $null
$state = ''
$sent = 0; $dropped = 0; $restarts = 0
$lastText = ''; $lastAt = [DateTime]::MinValue
# the pieces of the sentence being said, held until it ends
$buffer = ''; $pieces = 0; $bufferFacts = ''
$bufferHeard = [DateTime]::MinValue; $bufferEnd = [DateTime]::MinValue; $bufferFirst = [DateTime]::MinValue
$lastVoice = [DateTime]::MinValue   # the last time the mic heard a voice (peak 0.05, -26 dB)
$lastCall = [DateTime]::MinValue; $lastNet = [DateTime]::MinValue
$piper = $null; $lastPiper = [DateTime]::MinValue
$piperLoud = New-Object System.Collections.Generic.List[DateTime]   # 200 ms ticks when Piper played
$gaiaLoud = New-Object System.Collections.Generic.List[DateTime]    # ticks when the other agent's app played
$chat = @(); $scenes = @()
$target = $StartTarget; Put $targetFile $target   # until the user says "Top …"
$lastCallState = 'none'; $beforeCall = $null   # the target the call's open mic replaced, if it did
$lastFocus = 'claude'   # where Claude answers: the terminal, or the 3D scene while it has the focus
Note "start: $Threads threads, language $Language, $(if ($AutoSend) { 'auto-send' } else { 'preview, the user sends' })$(if ($CallApp) { ", call app $CallApp" })$(if ($Scene) { ', 3D scene' })"
OtherCall | Out-Null   # Chromium builds its accessibility tree on the first request
try {
    while (-not (Test-Path $stopFile)) {
        $now = Get-Date
        if (($now - $lastPiper).TotalSeconds -ge 10) {
            $lastPiper = $now; $piper = (Get-Process piper-voice -ErrorAction SilentlyContinue | Select-Object -First 1).Id
            $chat = if ($CallApp) { @(Get-Process $CallApp -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id }) } else { @() }
            # the 3D scene speaks with its own Piper client, from its Godot process: Claude's voice too
            $scenes = if ($Scene) { @(Get-Process godot* -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like $SceneWindow } | ForEach-Object { [uint32]$_.Id }) } else { @() }
        }
        if ($piper -or $chat -or $scenes) {
            # Piper's and the other agent's own sound, as it plays now: not voice_courtesy.ps1's
            # flag, which holds 1.2 s after the agent stops and would swallow a short "Top Claude"
            $peaks = [AudioPeek.Peek]::Peaks(); $peak = 0.0
            if ($piper -and $peaks.TryGetValue([uint32]$piper, [ref]$peak) -and $peak -gt 0.02) { $piperLoud.Add($now) }
            foreach ($s in $scenes) { if ($peaks.TryGetValue($s, [ref]$peak) -and $peak -gt 0.02) { $piperLoud.Add($now); break } }
            foreach ($c in $chat) { if ($peaks.TryGetValue($c, [ref]$peak) -and $peak -gt 0.02) { $gaiaLoud.Add($now); break } }
            $old = $now.AddSeconds(-60)
            $piperLoud.RemoveAll([Predicate[DateTime]] { param($t) $t -lt $old }) | Out-Null
            $gaiaLoud.RemoveAll([Predicate[DateTime]] { param($t) $t -lt $old }) | Out-Null
        }
        if (($now - $lastCall).TotalSeconds -ge 1) {
            $lastCall = $now
            if ($state) { Put $stateFile $state }
            $held = $false
            try { $held = [IO.File]::ReadAllText($pauseFile) -eq 'paused' } catch { }
            $call = if ($held) { 'paused' } else { OtherCall }
            # the call's mic opening makes what follows for the other agent; closing gives back the target it replaced
            if ($call -eq 'live' -and $lastCallState -ne 'live') {
                if ($buffer -and (Flush) -eq 'gone') { break }   # said before, for Claude
                $beforeCall = $target; $target = 'gaia'; Put $targetFile $target
                Note "the other agent's call opened its microphone: now for it (was $beforeCall)"
            } elseif ($call -ne 'live' -and $call -ne 'paused' -and $lastCallState -eq 'live') {
                if ($null -ne $beforeCall -and $target -eq 'gaia') { $target = $beforeCall; Put $targetFile $target }
                Note "the call's microphone closed ($call): now for $target"; $beforeCall = $null
            }
            if ($call -ne 'paused') { $lastCallState = $call }
            Put $callFile $lastCallState
            # the 3D scene in the foreground: Claude answers there, through its robot
            $seen = Focus
            if ($seen -ne 'other' -and $seen -ne $lastFocus) { Note "Claude answers in $(if ($seen -eq 'observatory') { 'the 3D scene' } else { 'the terminal' })" }
            if ($seen -ne 'other') { $lastFocus = $seen }
            Put $focusFile $lastFocus
            if ($held) {
                if ($buffer -and (Flush) -eq 'gone') { break }
                if ($stream) { $stream.Stop(); $stream = $null }
                if ($state -ne 'paused') { $state = 'paused'; Status $words.paused; Note 'paused by the user' }
            } elseif (-not $stream) {
                $stream = New-Object VoiceListen.Stream($Whisper, "-m `"$Model`" -l $Language -t $Threads --step 0 --length 15000 -vth 0.6 -mt 160")
                $lastNet = [DateTime]::MinValue
                $state = 'loading'; Status $words.loading
                Note "loading (whisper-stream pid $($stream.Proc.Id), in a job: $($stream.Jailed); call: $call)"
            }
        }
        # "J'écoute" only once whisper really captures, not while its model loads
        if ($stream -and $state -eq 'loading' -and $stream.AudioStart -ne [DateTime]::MinValue) {
            $state = 'on'; Status $words.on; Put $stateFile $state
            Note "listening, $([int]($stream.AudioStart - $stream.Proc.StartTime).TotalMilliseconds) ms after the start"; Say $words.listening
        }
        if ($stream -and $state -eq 'on') {
            $mic = [AudioPeek.Peek]::MicPeak(); Put $levelFile ('{0:0.000}' -f $mic)
            if ($mic -ge 0.05) { $lastVoice = $now }
        }
        if ($stream) {
            $line = $null
            while ($stream.Log.TryDequeue([ref]$line)) { Note "whisper: $line" }
            if ($stream.Proc.HasExited) {
                Note "whisper-stream exited ($($stream.Proc.ExitCode))"; $stream = $null
                if (++$restarts -gt 3) { Note 'gave up after 3 restarts'; break }
                continue
            }
            if (($now - $lastNet).TotalSeconds -ge 10) {
                $lastNet = $now
                $sockets = @(Get-NetTCPConnection -OwningProcess $stream.Proc.Id -ErrorAction SilentlyContinue) +
                           @(Get-NetUDPEndpoint -OwningProcess $stream.Proc.Id -ErrorAction SilentlyContinue)
                if ($sockets.Count) { Note "NETWORK: whisper-stream opened $($sockets.Count) socket(s); stopped"; break }
            }
            $u = $null
            while ($stream.Said.TryDequeue([ref]$u)) {
                $stream.Proc.Refresh()
                $lag = if ($u.EndMs -ge 0 -and $stream.AudioStart -ne [DateTime]::MinValue) {
                    [int](($u.Heard - $stream.AudioStart).TotalMilliseconds - $u.EndMs) } else { -1 }
                $facts = "latency $lag ms, memory $([int]($stream.Proc.WorkingSet64 / 1MB)) MB"
                # heard over Piper or the other agent for a third of it or more: their voice, unless it is a command
                $over = $null
                if ($u.StartMs -ge 0 -and $u.EndMs -gt $u.StartMs -and $stream.AudioStart -ne [DateTime]::MinValue) {
                    $from = $stream.AudioStart.AddMilliseconds($u.StartMs); $to = $stream.AudioStart.AddMilliseconds($u.EndMs)
                    $third = ($u.EndMs - $u.StartMs) / 3
                    if ((Covered $piperLoud $from $to) -ge $third) { $over = 'piper' }
                    elseif ((Covered $gaiaLoud $from $to) -ge $third) { $over = 'dropped' }
                }
                $text = $u.Text
                # "Claude, pause" and "Claude, stop listening" work whoever the user speaks to (Commands.ps1)
                $order = Get-Order $text
                if ($order -and $buffer) { if ((Flush) -eq 'gone') { break } }
                if ($order -eq 'halt') { Note 'stop asked by voice'; New-Item -ItemType File -Force $stopFile | Out-Null; break }
                if ($order -eq 'pause') { Note 'pause asked by voice'; Put $pauseFile 'paused'; Say $words.pausing; break }
                $aimed = Get-Switch $text
                if ($aimed) {
                    if ($buffer -and (Flush) -eq 'gone') { break }   # what came before "Top" was for Claude
                    $was = $target; $target = $aimed.target; $rest = $aimed.rest
                    Put $targetFile $target; Note "now for $target (was $was)$(if ($over) { ', heard over a voice' })"
                    if ($target -eq 'claude') { Say $words.yes }
                    if (-not $rest.Trim() -or $over) { continue }
                } elseif ($over -eq 'piper') { $dropped++; Put $lastFile 'piper'; Note "dropped an utterance heard while Piper played ($facts)"; continue }
                elseif ($over) { $dropped++; Put $lastFile 'dropped'; Note "dropped an utterance heard while the other agent spoke ($facts)"; continue }
                elseif ($target -ne 'claude') { $dropped++; Put $lastFile 'ignored'; Note "dropped an utterance for $target ($facts)"; continue }
                else { $rest = $text }
                $rest = $rest -replace '^[\s!/#]+', ''
                # whisper writes the sounds it cannot read as "[Musique]" or "(rires)": never a prompt
                if ($rest -match '^\s*[\[(][^\])]*[\])]\W*$') { $dropped++; Put $lastFile 'ignored'; Note 'dropped a non-speech mark'; continue }
                # what whisper, trained on video subtitles, invents on noise or silence (the user never said it)
                if (Test-Hallucination $rest) {
                    $dropped++; Put $lastFile 'ignored'; Note 'dropped a known whisper hallucination'; continue }
                # "..." or a lone mark: whisper heard a breath or a noise, not words
                if ($rest -notmatch '\p{L}') { $dropped++; Put $lastFile 'ignored'; Note 'dropped an utterance with no words'; continue }
                if ($rest -eq $lastText -and ($u.Heard - $lastAt).TotalSeconds -lt 10) { Note 'dropped a duplicate'; continue }
                $lastText = $rest; $lastAt = $u.Heard
                # held until the sentence ends: a pause cut it, the next piece may follow
                if (-not $buffer) { $bufferFirst = $now; $pieces = 0 }
                $buffer = "$buffer $rest".Trim(); $pieces++; $bufferHeard = $now; $bufferFacts = $facts
                $bufferEnd = if ($u.EndMs -ge 0 -and $stream.AudioStart -ne [DateTime]::MinValue) { $stream.AudioStart.AddMilliseconds($u.EndMs) } else { $now }
            }
        }
        if ($buffer -and (ReadyToSend $now $bufferHeard $bufferEnd $lastVoice $bufferFirst)) {
            if ((Flush) -eq 'gone') { break }
        }
        [System.Threading.Thread]::Sleep(200)
    }
} catch {
    Note "error: $($_.Exception.Message)"
} finally {
    if ($stream) { $stream.Stop() }
    if ($buffer) { Note "dropped $pieces held piece(s) at the stop" }
    Status ''
    Note "stopped: $sent handed over, $dropped dropped"
    Say $words.stopped
    # who the user spoke to ends with the listener: a later start is -StartTarget (claude) again
    Remove-Item $stopFile, $stateFile, $levelFile, $lastFile, $targetFile, $callFile, $typedFile, $pauseFile, $focusFile, $pidFile -ErrorAction SilentlyContinue
}
