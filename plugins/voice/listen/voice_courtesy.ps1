# voice_courtesy.ps1: keep piper-voice from talking over another voice agent. Windows only.
#
#   powershell -NoProfile -WindowStyle Hidden -File voice_courtesy.ps1 [-Others ChatGPT,...]
#
# It reads output levels only, never the microphone. Run one per machine.
#
# Every 100 ms it reads the peak level of each app's audio session on the default output
# device. When one of $Others makes sound (by default the ChatGPT app, whose voice is Gaia):
#   - piper-voice is cut at once (POST /v1/stop, on 127.0.0.1);
#   - the file courtesy\other-speaking exists until the other app has been quiet for $HoldMs.
# The voice plugin sees courtesy\alive (refreshed every second) and leaves replies in
# courtesy\pending\ instead of speaking them. This script says them once the other agent is
# quiet. A reply it cut within its expected length is queued again, first.
# A guest voice that plays its own audio (the Observatory scene) touches courtesy\speaking\<who>
# at least every second while it speaks: replies wait for it too, and a file not touched for
# $GuestFreshMs (a crash) no longer holds them. A guest is never cut; it yields on its own.
# piper-voice's own sound never counts: the service never cuts itself. Its session is named
# -Brand ("IX voice" by default) for the volume mixer, each time a new piper-voice appears, with
# ix-voice.ico from the data folder when it is there.
# Logs onsets, ends and replies said (never their text) to logs\courtesy.log.
param(
    [string[]]$Others = @('ChatGPT'),
    [double]$Threshold = 0.02,
    [int]$HoldMs = 1200,
    [int]$GuestFreshMs = 3000,
    [string]$Brand = 'IX voice'
)
$ErrorActionPreference = 'Stop'
$home2 = if ($env:PIPER_VOICE_HOME) { $env:PIPER_VOICE_HOME } else { Join-Path $env:LOCALAPPDATA 'piper-voice' }
$dir = Join-Path $home2 'courtesy'
$pending = Join-Path $dir 'pending'
$flag = Join-Path $dir 'other-speaking'
$alive = Join-Path $dir 'alive'
$guests = Join-Path $dir 'speaking'
$log = Join-Path $home2 'logs\courtesy.log'
$url = if ($env:PIPER_VOICE_URL) { $env:PIPER_VOICE_URL } else { 'http://127.0.0.1:59126' }
if (([Uri]$url).Host -notin '127.0.0.1', 'localhost', '::1', '[::1]') { $url = 'http://127.0.0.1:59126' }   # loopback only
New-Item -ItemType Directory -Force $pending, $guests, (Split-Path $log) | Out-Null
Add-Type -Path (Join-Path $PSScriptRoot 'AudioPeek.cs')

function Note([string]$what) { Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format s), $what) -Encoding utf8 }

$names = @{}
$self = 0
$speaking = $false
$lastLoud = [DateTime]::MinValue
$lastAlive = [DateTime]::MinValue
$lastSaid = $null
$lastVoice = ''
$lastSaidUntil = [DateTime]::MinValue
$piperFlag = Join-Path $dir 'piper-speaking'
$piperOn = $false
$lastPiper = [DateTime]::MinValue
$guestOn = $false
Remove-Item $flag, $piperFlag -ErrorAction SilentlyContinue
Note "start: watching $($Others -join ', ') above $Threshold, hold $HoldMs ms"
while ($true) {
    $now = Get-Date
    try {
        $loud = 0.0
        $piperPeak = 0.0
        foreach ($e in [AudioPeek.Peek]::Peaks().GetEnumerator()) {
            if (-not $names.ContainsKey($e.Key)) {
                $names[$e.Key] = (Get-Process -Id $e.Key -ErrorAction SilentlyContinue).ProcessName
            }
            if ($names[$e.Key] -eq 'piper-voice') {
                $piperPeak = [Math]::Max($piperPeak, $e.Value)
                if ($e.Key -ne $self) {
                    $self = $e.Key
                    $icon = Join-Path $home2 'ix-voice.ico'
                    $n = [AudioPeek.Peek]::Brand($self, $Brand, $(if (Test-Path $icon) { $icon } else { '' }))
                    Note "piper-voice is pid $self; sessions branded: $n"
                }
                continue
            }
            if ($Others -contains $names[$e.Key]) { $loud = [Math]::Max($loud, $e.Value) }
        }
        # courtesy\piper-speaking, for the voice-avatar plugin: Piper is playing (or was, 400 ms ago)
        if ($piperPeak -gt $Threshold) {
            $lastPiper = $now
            if (-not $piperOn) { $piperOn = $true; New-Item -ItemType File -Force $piperFlag | Out-Null }
        } elseif ($piperOn -and ($now - $lastPiper).TotalMilliseconds -gt 400) {
            $piperOn = $false; Remove-Item $piperFlag -ErrorAction SilentlyContinue
        }
        if ($loud -gt $Threshold) {
            $lastLoud = $now
            if (-not $speaking) {
                $speaking = $true
                New-Item -ItemType File -Force $flag | Out-Null
                $cut = (Invoke-RestMethod -Method Post "$url/v1/stop" -TimeoutSec 1).stopped
                Note ("other agent speaking (peak {0:0.000}); piper cut: {1}" -f $loud, $cut)
                if ($cut -gt 0 -and $lastSaid -and $now -lt $lastSaidUntil) {
                    Set-Content -Path (Join-Path $pending $(if ($lastVoice) { "0-again.$lastVoice.txt" } else { '0-again.txt' })) -Value $lastSaid -Encoding utf8 -NoNewline
                    Note 'the cut reply is queued again'
                }
                $lastSaid = $null
            }
        } elseif ($speaking -and ($now - $lastLoud).TotalMilliseconds -gt $HoldMs) {
            $speaking = $false
            Remove-Item $flag -ErrorAction SilentlyContinue
            Note 'other agent quiet'
        }
        $guest = @(Get-ChildItem $guests -File -ErrorAction SilentlyContinue |
            Where-Object { ($now - $_.LastWriteTime).TotalMilliseconds -lt $GuestFreshMs }).Count -gt 0
        if ($guest -ne $guestOn) {
            $guestOn = $guest
            Note $(if ($guest) { 'guest voice speaking' } else { 'guest voice quiet' })
        }
        if (-not $speaking -and -not $guest) {
            foreach ($f in Get-ChildItem $pending -Filter *.txt | Sort-Object Name) {
                $text = Get-Content -Raw -Encoding utf8 $f.FullName
                Remove-Item $f.FullName
                # the voice plugin names the reply <time>.<voice>.txt: said in that voice, or, when it
                # is not installed, in the service's default
                $voice = if ($f.BaseName -match '^[^.]+\.([A-Za-z0-9_-]+)$') { $Matches[1] } else { '' }
                foreach ($v in @($voice, '') | Select-Object -Unique) {
                    $body = $(if ($v) { @{ text = $text; voice = $v } } else { @{ text = $text } }) | ConvertTo-Json -Compress
                    try {
                        Invoke-RestMethod -Method Post "$url/v1/say" -ContentType 'application/json; charset=utf-8' `
                            -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 2 | Out-Null
                        break
                    } catch { if (-not $v) { throw } }
                }
                $lastVoice = $voice
                # French speech at about 12 characters a second, plus the queue ahead of it.
                $lastSaid = $text
                $lastSaidUntil = $now.AddSeconds(5 + $text.Length / 12)
                Note "said a pending reply ($($text.Length) chars)"
            }
        }
        if (($now - $lastAlive).TotalSeconds -ge 1) {
            Set-Content -Path $alive -Value $PID
            $lastAlive = $now
        }
    } catch {
        Note "error: $($_.Exception.Message)"
        [System.Threading.Thread]::Sleep(1000)
    }
    [System.Threading.Thread]::Sleep(100)
}
