# Commands.ps1: what a sentence heard asks for, in French or in English whatever -Language is
# (people mix them), and what the listener says back. Pure: no audio, no file, no network.
# voice_listen.ps1 dot-sources it; Commands.Tests.ps1 tests it. -match ignores case, and the
# classes below take the accents whisper writes or drops.

# whisper often hears "Claude" as "Cloud" or "Clode" (French) or "Clawed" (English), and "Gaïa"
# as "Gaya" or "Guya".
$wake = '^\W*(claude|cloud|clode|clod|claud|klaud|klod|clawed)\b[\s,.:;!?-]*'
$gaia = '^\W*(ga[iïy]a|ga[iï]e|ka[iï]a|guy[ae])\b[\s,.:;!?-]*'
$aimedWord = '^\W*(top|tope|tops|toppe)\b[\s,.:;!?-]*'   # alone, "Top" means ambient talk
$hey = '^\W*(hey|hi|hello|ok|okay)\b[\s,.:;!?-]*'         # counts only before a name, or everyone
$everyone = '^\W*(everyone|everybody|all|folks|tout le monde)\b'
$pause = '^(pause|fais une pause|take a (break|pause)|pause listening)\W*$'
$halt = "^(stop( listening)?|quit listening|arr[eê]te[sz]?( d.[ée]couter| l.[ée]coute)?)\W*$"
# what whisper, trained on video subtitles, invents on noise or silence (nobody said it)
$hallucination = "^\W*(merci( beaucoup| à tous)?( d.avoir regard[ée].*)?|sous-titr.*|.*amara\.org.*|thank you( (so|very) much)?( for watching)?|thanks for watching.*|you|bye)\W*$"

# Who the next sentences are for, when this one says it: @{ target; rest }, else $null.
# "Top Claude", "Hey Claude": Claude, with what follows; "Top Gaïa", "Hey Gaia": the other agent;
# "Top", "Hey everyone": ambient. "Hey" or "OK" before anything else is an ordinary sentence.
function Get-Switch([string]$text) {
    $after = $null
    if ($text -match $aimedWord) { $after = $text -replace $aimedWord, '' }
    elseif ($text -match $hey) {
        $named = $text -replace $hey, ''
        if ($named -match $wake -or $named -match $gaia -or $named -match $everyone) { $after = $named }
    }
    if ($null -eq $after) { return $null }
    if ($after -match $wake) { return @{ target = 'claude'; rest = ($after -replace $wake, '') } }
    if ($after -match $gaia) { return @{ target = 'gaia'; rest = '' } }
    @{ target = 'ambient'; rest = '' }
}

# 'halt' or 'pause' for an order to Claude ("Claude, pause", "Hey Claude, stop listening"),
# whoever the user speaks to at the time; else $null.
function Get-Order([string]$text) {
    $aimed = Get-Switch $text
    $order = if ($text -match $wake) { $text -replace $wake, '' }
             elseif ($aimed -and $aimed.target -eq 'claude') { $aimed.rest }
             else { $null }
    if ($null -eq $order) { return $null }
    if ($order -match $halt) { 'halt' } elseif ($order -match $pause) { 'pause' } else { $null }
}

function Test-Hallucination([string]$text) { $text -match $hallucination }

# The model to load from the names found: never an English-only *.en.bin for another language;
# large-v3-turbo first, then, for English, an English-only one; then by name. $null for none.
function Select-Model([string[]]$names, [string]$language) {
    $en = $language -like 'en*'
    $usable = @($names | Where-Object { $en -or $_ -notlike '*.en.bin' })
    if (-not $usable.Count) { return $null }
    $usable | Sort-Object { $_ -notlike '*large-v3-turbo*' }, { -not ($en -and $_ -like '*.en.bin') }, { $_ } | Select-Object -First 1
}

# What the listener says aloud and shows in the wmux sidebar: French for fr, English otherwise.
function Get-Words([string]$language) {
    if ($language -like 'fr*') {
        @{ listening = "J'écoute."; yes = 'Oui ?'; pausing = 'Je fais une pause.'; stopped = "J'arrête d'écouter."
           loading = '⏳ écoute : chargement'; on = '🎙 écoute active'; paused = '⏸ écoute en pause' }
    } else {
        @{ listening = 'Listening.'; yes = 'Yes?'; pausing = 'Pausing.'; stopped = "I've stopped listening."
           loading = '⏳ listening: loading'; on = '🎙 listening'; paused = '⏸ listening paused' }
    }
}
