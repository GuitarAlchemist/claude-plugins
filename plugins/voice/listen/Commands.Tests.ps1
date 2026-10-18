# Commands.Tests.ps1: the spoken commands, the model choice and the words, in French and English.
#   pwsh -NoProfile -File Commands.Tests.ps1     (exits 1 when a check fails)
# It only dot-sources Commands.ps1: no microphone, no whisper, no piper-voice.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Commands.ps1')
$failed = 0; $passed = 0
function Check([string]$name, $got, $want) {
    if ("$got" -ceq "$want") { $script:passed++ } else { $script:failed++; Write-Output "FAIL $name : got '$got', want '$want'" }
}
function Target([string]$text) { $s = Get-Switch $text; if ($s) { "$($s.target)|$($s.rest)" } else { 'none' } }

# Who the next sentences are for, French
Check 'Top Claude' (Target 'Top Claude.') 'claude|'
Check 'Top, Claude, lance les tests' (Target 'Top, Claude, lance les tests') 'claude|lance les tests'
Check 'Top Gaïa' (Target 'Top Gaïa.') 'gaia|'
Check 'Top Gaya (misheard)' (Target 'top gaya') 'gaia|'
Check 'Top alone' (Target 'Top.') 'ambient|'
Check 'a name inside a sentence' (Target 'Je parlais de Claude hier.') 'none'
# ... and English
Check 'Hey Claude' (Target 'Hey Claude!') 'claude|'
Check 'hey clawed, run the tests' (Target 'hey clawed, run the tests') 'claude|run the tests'
Check 'OK Claude' (Target 'OK, Claude.') 'claude|'
Check 'Hey Gaia' (Target 'Hey Gaia.') 'gaia|'
Check 'Hey everyone' (Target 'Hey everyone!') 'ambient|'
Check 'OK before a sentence' (Target 'OK, now run the tests.') 'none'
Check 'Hey alone' (Target 'Hey.') 'none'
Check 'mixed: Top then English' (Target 'Top Claude, open the file') 'claude|open the file'
Check 'case and accents' (Target 'TOP GAIA') 'gaia|'

# Orders to Claude, whoever the user speaks to
Check 'Claude, pause' (Get-Order 'Claude, pause.') 'pause'
Check 'Claude, fais une pause' (Get-Order 'Claude, fais une pause') 'pause'
Check "Claude, arrête d'écouter" (Get-Order "Claude, arrête d'écouter.") 'halt'
Check "Claude arrete d'ecouter (no accents)" (Get-Order "claude arrete d'ecouter") 'halt'
Check 'Top Claude, stop' (Get-Order 'Top Claude, stop.') 'halt'
Check 'Claude, stop listening' (Get-Order 'Claude, stop listening.') 'halt'
Check 'Hey Claude, stop listening' (Get-Order 'Hey Claude, stop listening!') 'halt'
Check 'Claude, take a break' (Get-Order 'Claude, take a break.') 'pause'
Check 'Hey Claude, pause' (Get-Order 'hey claude pause') 'pause'
Check 'Claude, stop the build (not an order)' (Get-Order 'Claude, stop the build.') ''
Check 'pause alone (not for Claude)' (Get-Order 'Pause.') ''

# What whisper invents on silence
Check 'Merci.' (Test-Hallucination 'Merci.') 'True'
Check 'Sous-titrage' (Test-Hallucination 'Sous-titrage ST 501') 'True'
Check 'Thank you.' (Test-Hallucination 'Thank you.') 'True'
Check 'Thanks for watching!' (Test-Hallucination 'Thanks for watching!') 'True'
Check 'you' (Test-Hallucination ' you') 'True'
Check 'a real sentence' (Test-Hallucination 'Thank you, now open the README.') 'False'

# The model
$found = 'ggml-base.en.bin', 'ggml-base.bin', 'ggml-large-v3-turbo-q5_0.bin', 'ggml-small.en.bin'
Check 'fr: large-v3-turbo first' (Select-Model $found 'fr') 'ggml-large-v3-turbo-q5_0.bin'
Check 'en: large-v3-turbo first' (Select-Model $found 'en') 'ggml-large-v3-turbo-q5_0.bin'
Check 'en: an English-only model next' (Select-Model ('ggml-base.bin', 'ggml-small.en.bin') 'en') 'ggml-small.en.bin'
Check 'fr: never an English-only model' (Select-Model ('ggml-base.en.bin', 'ggml-small.bin') 'fr') 'ggml-small.bin'
Check 'fr: none but English-only ones' ([string](Select-Model ('ggml-base.en.bin') 'fr')) ''

# What Piper says back and the wmux status
$fr = Get-Words 'fr'; $en = Get-Words 'en'
Check 'fr yes' $fr.yes 'Oui ?'
Check 'fr listening' $fr.listening "J'écoute."
Check 'en yes' $en.yes 'Yes?'
Check 'en listening' $en.listening 'Listening.'
Check 'fr listening, ambient start' $fr.listeningTop "J'écoute. Dis « Top Claude » pour me parler."
Check 'en listening, ambient start' $en.listeningTop 'Listening. Say "Hey Claude" to talk to me.'
Check 'en pausing' $en.pausing 'Pausing.'
Check 'en stopped' $en.stopped "I've stopped listening."
Check 'en status' $en.on '🎙 listening'
Check 'other languages read English' (Get-Words 'de').yes 'Yes?'

Write-Output "$passed passed, $failed failed"
if ($failed) { exit 1 }
