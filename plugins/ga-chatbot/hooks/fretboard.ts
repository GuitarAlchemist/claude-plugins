// The chord panes' pure work: fingerings, ASCII diagrams, the OPTIC-K ladder and the set theory under
// it, and reading what GA's tools answer. Everything that reaches the engine (`$`) is in register.tsx.

// Standard tuning, low E first, as MIDI notes: MIDI 48 is C3, as in the music-theory-ga course.
export const TUNING = [40, 45, 50, 55, 59, 64] as const
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

// A fingering in chart order: index 0 is the low E string, null a muted string.
export type Frets = (number | null)[]

const at = (xs: readonly number[], i: number): number => xs[i] ?? 0
const mod12 = (n: number) => ((n % 12) + 12) % 12

function fretsOf(parts: readonly string[]): Frets | undefined {
  if (parts.length !== 6) return undefined
  const frets = parts.map(p => (p === 'x' ? null : /^\d{1,2}$/.test(p) ? Number(p) : Number.NaN))
  if (frets.some(f => f !== null && (Number.isNaN(f) || f > 24))) return undefined
  return frets.every(f => f === null) ? undefined : frets
}

// GA writes string 1, the high E, first: "8-8-9-9-x-8" is low E 8, A muted, D 9, G 9, B 8, high E 8.
export function fromGaDiagram(diagram: string): Frets | undefined {
  return fretsOf(diagram.trim().toLowerCase().split('-'))?.reverse()
}

export function toGaDiagram(frets: Frets): string {
  return [...frets].reverse().map(f => (f === null ? 'x' : String(f))).join('-')
}

// What a reader types, in chart order (low E first) as chord charts print it: "x32010", or with spaces
// or dashes once a fret has two digits ("x 10 12 12 11 x").
export function parseFingering(text: string): Frets | undefined {
  const t = text.trim().toLowerCase()
  return fretsOf(/^[x0-9]{6}$/.test(t) ? t.split('') : t.split(/[\s-]+/).filter(Boolean))
}

export function chartText(frets: Frets): string {
  const wide = frets.some(f => f !== null && f > 9)
  return frets.map(f => (f === null ? 'x' : String(f))).join(wide ? ' ' : '')
}

export function midiOf(frets: Frets): number[] {
  return frets.flatMap((f, i) => (f === null ? [] : [at(TUNING, i) + f]))
}

// A MIDI note's name and octave, spelt over the chord's root when it is known (see `spelt`). The octave is the
// letter's: B#3 sounds as C4, Cb4 as B3.
export function noteName(midi: number, root?: number | Root): string {
  const name = spelt(mod12(midi), root)
  const shift = name.endsWith('#') ? 1 : name.length > 1 && name.endsWith('b') ? -1 : 0
  return `${name}${Math.floor((midi - shift) / 12) - 1}`
}

// Pitch classes as the course writes them: 10 and 11 are T and E.
export function pcText(pc: number): string {
  return pc === 10 ? 'T' : pc === 11 ? 'E' : String(pc)
}

// A chord chart in text: strings low E to high e from left to right, frets downwards, x muted, o open.
export function diagram(frets: Frets, title: string, root?: number | Root): string {
  const pressed = frets.filter((f): f is number => f !== null && f > 0)
  const highest = pressed.length ? Math.max(...pressed) : 1
  const start = highest <= 4 ? 1 : Math.min(...pressed)
  const rows = Math.max(4, highest - start + 1)
  const lines = [title, '      E A D G B e', `      ${frets.map(f => (f === null ? 'x' : f === 0 ? 'o' : ' ')).join(' ')}`]
  if (start === 1) lines.push('      ===========')
  for (let r = 0; r < rows; r++) {
    const fret = start + r
    const label = r === 0 && start > 1 ? `${fret}fr`.padStart(4) : '    '
    lines.push(`${label}  ${frets.map(f => (f === fret ? '●' : '|')).join(' ')}`)
  }
  lines.push(`      ${midiOf(frets).map(m => noteName(m, root)).join(' ')}`)
  return lines.join('\n')
}

// --- Set theory ----------------------------------------------------------------------------------

export function pcSet(pcs: readonly number[]): number[] {
  return [...new Set(pcs.map(mod12))].sort((a, b) => a - b)
}

// Rahn's rule: the smaller span from the first note to the last, then to the one before it, and so on.
function morePacked(a: readonly number[], b: readonly number[]): boolean {
  for (let k = a.length - 1; k >= 1; k--) {
    const da = mod12(at(a, k) - at(a, 0))
    const db = mod12(at(b, k) - at(b, 0))
    if (da !== db) return da < db
  }
  return false
}

export function normalForm(pcs: readonly number[]): number[] {
  const s = pcSet(pcs)
  let best = s
  for (let i = 1; i < s.length; i++) {
    const rotation = [...s.slice(i), ...s.slice(0, i)]
    if (morePacked(rotation, best)) best = rotation
  }
  return best
}

const fromZero = (xs: readonly number[]) => xs.map(p => mod12(p - at(xs, 0)))

// The transposition class's representative: the normal form moved to start on 0.
export function transpositionClass(pcs: readonly number[]): number[] {
  return fromZero(normalForm(pcs))
}

export function primeForm(pcs: readonly number[]): number[] {
  const up = transpositionClass(pcs)
  if (up.length === 0) return up
  const down = transpositionClass(up.map(p => mod12(-p)))
  return morePacked(down, up) ? down : up
}

export function intervalVector(pcs: readonly number[]): number[] {
  const s = pcSet(pcs)
  const v = [0, 0, 0, 0, 0, 0]
  for (let i = 0; i < s.length; i++) {
    for (let j = i + 1; j < s.length; j++) {
      const d = mod12(at(s, j) - at(s, i))
      const ic = Math.min(d, 12 - d)
      if (ic > 0) v[ic - 1] = at(v, ic - 1) + 1
    }
  }
  return v
}

export function complement(pcs: readonly number[]): number[] {
  const s = new Set(pcSet(pcs))
  return [...Array(12).keys()].filter(p => !s.has(p))
}

// Forte numbers pair complements: 4-20 and 8-20. A Z hexachord's complement is its Z partner, which
// the number alone does not give; a plain hexachord is its own complement.
export function complementForte(forte: string): string {
  const m = /^(\d{1,2})-(Z?)(\d{1,2})$/.exec(forte.trim())
  if (!m) return ''
  const n = Number(m[1])
  if (n === 6) return m[2] ? `the Z partner of ${forte}` : forte
  return `${12 - n}-${m[2] ?? ''}${m[3] ?? ''}`
}

// --- The OPTIC-K ladder --------------------------------------------------------------------------

// What GA's ga_chord_to_set says of a chord, '' where it said nothing.
export type SetInfo = { forte: string; icv: string; prime: string; modal: string }

export type Rung = { rung: string; object: string; forgets: string }

// One fingering climbed rung by rung, as music-theory-ga's appendix B climbs x32010, with K
// (complementarity) on top: GA names its embedding after all six.
export function ladder(frets: Frets, ga?: SetInfo, root?: number | Root): Rung[] {
  const notes = midiOf(frets)
  const played = notes.map(mod12)
  const sorted = [...played].sort((a, b) => a - b)
  const set = pcSet(played)
  const prime = primeForm(set)
  const outside = complement(set)
  // GA names the chord asked: its numbers go on these rungs only when its set is the voicing's (a shell that
  // leaves out the 5 is another set, Bb7(shell)'s (026) against Bb7's 4-27).
  const same = ga ? sameSet(set, ga) : false
  const forte = same && ga?.forte ? ` · Forte ${ga.forte}` : ''
  const shape = (xs: readonly number[]) => `(${xs.map(pcText).join('')})`
  return [
    { rung: 'a fingering', object: `${chartText(frets)}  (GA ${toGaDiagram(frets)})`, forgets: 'nothing: strings, frets, muted strings' },
    { rung: 'the pitches', object: notes.map(m => noteName(m, root)).join(' '), forgets: 'which string each note was played on' },
    { rung: '- O, octave', object: played.map(pcText).join(' '), forgets: 'the octave of each note' },
    { rung: '- P, permutation', object: sorted.map(pcText).join(' '), forgets: 'the order of the notes' },
    { rung: '- C, cardinality', object: set.map(pcText).join(' '), forgets: 'doubled notes' },
    { rung: '- T, transposition', object: transpositionClass(set).map(pcText).join(' '), forgets: 'which key it is in' },
    { rung: '- I, inversion', object: `${shape(prime)}${forte}`, forgets: 'which way up (major against minor)' },
    {
      rung: '- K, complement',
      object: outside.length ? `${shape(primeForm(outside))}${same && ga?.forte && complementForte(ga.forte) ? ` · Forte ${complementForte(ga.forte)}` : ''}` : '(none: all twelve)',
      forgets: 'which notes are in and which are out',
    },
  ]
}

// GA's prime form written as the ladder writes one ("0 1 5 8", T and E for 10 and 11); '' when it gave none.
function gaPrimeText(info: SetInfo): string {
  return info.prime
    .split(/[\s,()]+/)
    .filter(Boolean)
    .map(p => (/^\d+$/.test(p) ? pcText(Number(p)) : p.toUpperCase()))
    .join(' ')
}

// Whether GA's set is this one: the same prime form; else the same ICV and size, which name one set class
// unless the Forte number is a Z one (so a prime form GA wrote another way, or in Forte's packing rather than
// the Rahn packing `primeForm` uses, still matches). Neither: unknown, so not the same.
function sameSet(set: readonly number[], info: SetInfo): boolean {
  if (gaPrimeText(info) && gaPrimeText(info) === primeForm(set).map(pcText).join(' ')) return true
  const gaIcv = info.icv.replace(/\s+/g, ' ').trim()
  const size = Number(/^(\d+)-/.exec(info.forte)?.[1])
  return !!gaIcv && gaIcv === `<${intervalVector(set).join(' ')}>` && size === set.length && !/Z/.test(info.forte)
}

// GA's numbers beside the ones computed here, as the course's "check" column does.
export function gaCheck(frets: Frets, info: SetInfo): string {
  const set = pcSet(midiOf(frets))
  const prime = primeForm(set).map(pcText).join(' ')
  const icv = `<${intervalVector(set).join(' ')}>`
  const gaPrime = gaPrimeText(info)
  const gaIcv = info.icv.replace(/\s+/g, ' ').trim()
  const mark = (ga: string, here: string) => (ga === here ? 'ok' : `DIFF, computed here ${here}`)
  return [
    `GA: Forte ${info.forte || '?'}${info.forte && !sameSet(set, info) ? " (the chord's, not this voicing's)" : ''}`,
    `ICV ${gaIcv || '?'}${gaIcv ? ` (${mark(gaIcv, icv)})` : ''}`,
    `prime form ${gaPrime || '?'}${gaPrime ? ` (${mark(gaPrime, prime)})` : ''}`,
    ...(info.modal ? [`modal family ${info.modal}`] : []),
  ].join(' · ')
}

export function ladderText(rungs: readonly Rung[]): string {
  const w1 = Math.max(4, ...rungs.map(r => r.rung.length)) + 2
  const w2 = Math.max(6, ...rungs.map(r => r.object.length)) + 2
  const row = (a: string, b: string, c: string) => `${a.padEnd(w1)}${b.padEnd(w2)}${c}`.trimEnd()
  return [row('rung', 'the object', 'what it forgets'), ...rungs.map(r => row(r.rung, r.object, r.forgets))].join('\n')
}

// --- What GA's tools answer ----------------------------------------------------------------------

// `missing`: the notes of the chord GA read that the voicing does not hold, as pitch classes.
export type GaVoicing = { name: string; frets: Frets; score: number; missing: number[] }

export function missingFrom(wanted: readonly number[], frets: Frets): number[] {
  const held = pcSet(midiOf(frets))
  return pcSet(wanted).filter(pc => !held.includes(pc))
}

const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const
const DEGREES = ['root', 'b9', '9', 'b3', '3', '11', 'b5', '5', '#5', '6', 'b7', '7'] as const

// A chord's root as its symbol writes it, and the degrees its symbol alters (interval over the root to the
// degree's name): the root's letter and the degree's number give each note's letter.
export type Root = { pc: number; accidental: '' | '#' | 'b'; altered?: Readonly<Record<number, string>> }

export const asRoot = (note: Note): Root => ({ pc: note.pc, accidental: note.name.endsWith('#') ? '#' : note.name.length > 1 ? 'b' : '' })

const LETTER_ORDER = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const

// The degrees a quality names that the plain table reads otherwise: C7#9's D# (not a b3), C7#11's F# (not a
// b5), C7b13's Ab (not a #5), Edim7's bb7 Db (not a 6).
function alteredOf(quality: string): Record<number, string> {
  const altered: Record<number, string> = {}
  if (/[#♯+]9/.test(quality)) altered[3] = '#9'
  if (/[#♯+]11/.test(quality)) altered[6] = '#11'
  if (/[b♭-]13/.test(quality)) altered[8] = 'b13'
  if (/dim7|°7/.test(quality)) altered[9] = 'bb7'
  return altered
}

// The root a chord symbol writes, with the degrees its quality alters; the slash bass is not part of it.
export function rootSpelling(symbol: string): Root | undefined {
  const note = rootOf(symbol)
  if (!note) return undefined
  const quality = symbol.replace(/^\s*[A-G][#b♯♭]?/, '').replace(/\/\s*[A-Ga-g][#b♯♭]?\s*$/, '')
  return { ...asRoot(note), altered: alteredOf(quality) }
}

const degreeOf = (pc: number, root: number | Root) => {
  const interval = mod12(pc - (typeof root === 'number' ? root : root.pc))
  return (typeof root === 'number' ? undefined : root.altered?.[interval]) ?? DEGREES[interval] ?? ''
}

// The scale step a degree's number names: the 9 is the 2nd letter up, the 11 the 4th, the 13 the 6th.
const stepOf = (degree: string) => ((Number(degree.replace(/\D/g, '')) || 1) - 1) % 7

// A note spelt as its degree over the root implies. With the root as written, the degree's number gives the
// letter (Bb7's b7 is Ab, C#7's 3 E#, Fm7b5's b5 Cb, C7#9's #9 D#); a note that letter would need a double
// accidental for takes the table instead (Cdim7's bb7 reads A, D#'s 3 G). A root known by its pitch class only:
// b degrees, and every degree over Db Eb Ab Bb, take flats. Without a root, its plain name.
export function spelt(pc: number, root?: number | Root): string {
  if (root === undefined) return NAMES[mod12(pc)] ?? ''
  const degree = degreeOf(pc, root)
  if (typeof root === 'number') {
    const flat = degree.startsWith('b') || (!degree.startsWith('#') && [1, 3, 8, 10].includes(mod12(root)))
    return (flat ? FLATS : NAMES)[mod12(pc)] ?? ''
  }
  const natural = mod12(root.pc - (root.accidental === '#' ? 1 : root.accidental === 'b' ? -1 : 0))
  const from = LETTER_ORDER.findIndex(l => LETTERS[l] === natural)
  const letter = LETTER_ORDER[(from + stepOf(degree)) % 7] ?? 'C'
  const off = mod12(pc - (LETTERS[letter] ?? 0))
  if (off === 0) return letter
  if (off === 1) return `${letter}#`
  if (off === 11) return `${letter}b`
  const flat = root.accidental === 'b' || (root.accidental === '' && degree.startsWith('b'))
  return (flat ? FLATS : NAMES)[mod12(pc)] ?? ''
}

// Missing notes named by their degree over the root, and spelt as it implies. Without a root, plain names.
export function lacks(missing: readonly number[], root?: number | Root): string {
  if (!missing.length) return ''
  const named = missing.map(pc => (root === undefined ? spelt(pc) : `the ${degreeOf(pc, root)} (${spelt(pc, root)})`))
  return `lacks ${named.join(' and ')}`
}

const LETTERS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

export type Note = { pc: number; name: string }

// A note as a symbol writes it, ♯ and ♭ as # and b: its pitch class and its name.
function noteOf(letter: string, accidental: string): Note {
  const L = letter.toUpperCase()
  const acc = accidental === '♯' ? '#' : accidental === '♭' ? 'b' : accidental
  return { pc: mod12((LETTERS[L] ?? 0) + (acc === '#' ? 1 : acc === 'b' ? -1 : 0)), name: `${L}${acc}` }
}

// The bass a slash chord asks for, as its symbol spells it: "Bb7/D" and "Bb7 / d" ask for D. GA's
// `interpreted` block names no bass (ga_search_voicings, 2026-10-04); "C6/9" has none.
export function bassOf(symbol: string): Note | undefined {
  const m = /\/\s*([A-Ga-g])([#b♯♭]?)\s*$/.exec(symbol)
  return m ? noteOf(m[1] ?? '', m[2] ?? '') : undefined
}

// The root a chord symbol starts with: "Bb7/D" starts on Bb.
export function rootOf(symbol: string): Note | undefined {
  const m = /^\s*([A-G])([#b♯♭]?)/.exec(symbol)
  return m ? noteOf(m[1] ?? '', m[2] ?? '') : undefined
}

// The perfect 5th of a four-note chord (a seventh, a sixth, a sus or add chord): a voicing may leave it out and
// still hold the chord, as GA's own "G7(shell)" voicings do. A triad's 5th, an altered one (b5, #5, a different
// pitch class) and the notes of larger chords stay required. GA reads a slash chord without a foreign bass (C/D as
// 0 4 7, Am/G as 0 4 9, measured on 2026-10-04), so a triad over another bass stays a triad here.
export function omittableFifth(wanted: readonly number[], root?: number): number | undefined {
  if (root === undefined || wanted.length !== 4) return undefined
  const fifth = mod12(root + 7)
  return wanted.includes(fifth) ? fifth : undefined
}

// The pitch class of a fingering's lowest note.
export function lowestOf(frets: Frets): number | undefined {
  const notes = midiOf(frets)
  return notes.length ? mod12(Math.min(...notes)) : undefined
}

// ga_search_voicings answers JSON: { interpreted: { chord, pitchClasses }, results: [{ diagram, chordName, score }] }.
// Its results need not hold every note it read (Am7 gave A minor triads, 2026-10-04): each one says what it lacks.
export function parseSearch(text: string): { chord: string; wanted: number[]; root: number | undefined; voicings: GaVoicing[]; error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { chord: '', wanted: [], root: undefined, voicings: [], error: `GA answered something that is not JSON: ${text.slice(0, 120)}` }
  }
  const o = (raw ?? {}) as { error?: unknown; interpreted?: { chord?: unknown; pitchClasses?: unknown; rootPitchClass?: unknown }; results?: unknown }
  if (typeof o.error === 'string') return { chord: '', wanted: [], root: undefined, voicings: [], error: o.error }
  const chord = typeof o.interpreted?.chord === 'string' ? o.interpreted.chord : ''
  const pcs = o.interpreted?.pitchClasses
  const wanted = Array.isArray(pcs) ? pcSet(pcs.filter((x): x is number => typeof x === 'number')) : []
  const root = typeof o.interpreted?.rootPitchClass === 'number' && wanted.length ? mod12(o.interpreted.rootPitchClass) : undefined
  const voicings: GaVoicing[] = []
  for (const r of Array.isArray(o.results) ? o.results : []) {
    const x = (r ?? {}) as { diagram?: unknown; chordName?: unknown; score?: unknown }
    const frets = typeof x.diagram === 'string' ? fromGaDiagram(x.diagram) : undefined
    if (!frets) continue
    voicings.push({ name: typeof x.chordName === 'string' ? x.chordName : chord, frets, score: typeof x.score === 'number' ? x.score : 0, missing: missingFrom(wanted, frets) })
  }
  return { chord, wanted, root, voicings, error: voicings.length ? '' : 'GA found no voicing for that.' }
}

// The chord a ga_chord_to_set answer is about: its "Chord: Cmaj7" line.
export function setChordOf(text: string): string {
  return /^\s*Chord:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? ''
}

// ga_chord_to_set answers lines such as "  Forte:      4-20".
export function parseSetInfo(text: string): SetInfo {
  const field = (label: string) => new RegExp(`^\\s*${label}:\\s*(.+)$`, 'm').exec(text)?.[1]?.trim() ?? ''
  return { forte: field('Forte'), icv: field('ICV'), prime: field('Prime form'), modal: field('Modal fam\\.') }
}

// The chord symbols an answer names, for one button each, in reading order: a root with a quality (Cmaj7,
// F#m7b5, Am, Bb7/D), or any symbol written in backticks (`C`) or bold (**Bb7**). A bare note name in bold is
// a chord only as a whole table cell (| **Bb** |): the chatbot also bolds notes and section letters in prose
// ("the third is **E**"). An altered dominant (G7#9, C7b9, G7alt) names its plain chord, G7 or C7.
const ROOT = '[A-G](?:#|b)?'
const QUALITY = 'maj13|maj11|maj9|maj7|mMaj7|maj|m7b5|m11|m9|m7|m6|m|dim7|dim|aug|sus2|sus4|add9|13|11|9|7|6'
const ALTERED = '(?:[#b](?:5|9|11|13)|alt)*'
const SYMBOL = new RegExp(`(?<![A-Za-z0-9#])(${ROOT}(?:${QUALITY})(?:\\/${ROOT})?)(?=${ALTERED}(?![A-Za-z0-9#]))`, 'g')
const WHOLE = new RegExp(`^${ROOT}(?:${QUALITY})?(?:\\/${ROOT})?$`)
const BARE = new RegExp(`^${ROOT}$`)
// A quality set apart from its root by one space, often a narrow no-break one (C\u202Fm7, as the chatbot wrote
// it); only the m-qualities, so "A 7-string" stays prose.
const SPACED = new RegExp(`(?<![A-Za-z0-9#])(${ROOT})[ \u00A0\u2009\u202F](m(?:aj)?(?:13|11|9|7|6)?(?:b5)?)(?![A-Za-z0-9#])`, 'g')
// A quality in words with its number, as GA's chordinfo skill wrote it ("C major 7 chord contains C, E, G, and
// B."): "major" or "minor" alone stays a key ("In C major"), and the number must end the phrase or be followed
// by "chord", so that a count stays prose ("in A minor 7 times", "an A major 7-note scale").
const WORDED = new RegExp(
  `(?<![A-Za-z0-9#])(${ROOT})[ \u00A0\u2009\u202F]([Mm]ajor|[Mm]inor)[ \u00A0\u2009\u202F]?(13|11|9|7|6)(?=[ \u00A0\u2009\u202F]*(?:$|[\n.,;:!?()\\]|*\`=]|chords?\\b))`,
  'g',
)
const worded = (_: string, root: string, kind: string, n: string) =>
  `${root}${kind.toLowerCase() === 'minor' ? `m${n}` : n === '6' ? '6' : `maj${n}`}`

// The minor-major seventh, as CmΔ7 or as GA names its voicings, Cm(maj7) (also Maj7, ma7, M7): GA reads CmMaj7
// as 0 3 7 11. The m must follow a root, so Cdim(maj7) stays Cdim. A ninth or more gives CmMaj9, which matches
// no quality: no button rather than a wrong Cm.
const MINOR_MAJOR = new RegExp(`(?<![A-Za-z0-9#])(${ROOT})m(?:Δ(7|9|11|13)?|\\((?:[Mm]aj|[Mm]a|M|Δ)(7|9|11|13)?\\))`, 'g')

// The chatbot spells chords typographically (F♯m7♭5, CΔ7, CmΔ7, B♭, Bø7, B°7): the plain spelling GA parses.
export function plainChords(text: string): string {
  return text
    .replace(/♯/g, '#')
    .replace(/♭/g, 'b')
    .replace(MINOR_MAJOR, (_: string, root: string, a?: string, b?: string) => `${root}mMaj${a ?? b ?? '7'}`)
    .replace(/Δ(13|11|9)/g, 'maj$1')
    .replace(/Δ7?/g, 'maj7')
    .replace(/ø7?/g, 'm7b5')
    .replace(/°7/g, 'dim7')
    .replace(/°/g, 'dim')
    .replace(WORDED, worded)
    .replace(SPACED, '$1$2')
}

export function chordSymbols(text: string, max = 6): string[] {
  const plain = plainChords(text)
  const found: { at: number; symbol: string }[] = []
  // Spans of any length, so that a long bold label pairs with its own closing marks.
  for (const m of plain.matchAll(/`([^`\n]+?)`|\*\*([^*\n]+?)\*\*/g)) {
    const inner = (m[1] ?? m[2] ?? '').trim()
    const at = m.index ?? 0
    const cell = /\|\s*$/.test(plain.slice(0, at)) && /^\s*\|/.test(plain.slice(at + m[0].length))
    if (WHOLE.test(inner) && (m[1] !== undefined || cell || !BARE.test(inner))) found.push({ at, symbol: inner })
  }
  for (const m of plain.matchAll(SYMBOL)) found.push({ at: m.index ?? 0, symbol: m[1] ?? '' })
  found.sort((a, b) => a.at - b.at)
  return [...new Set(found.map(f => f.symbol).filter(Boolean))].slice(0, max)
}
