import { expect, test } from 'claude-code/testing'

import {
  bassOf,
  chartText,
  chordSymbols,
  complementForte,
  diagram,
  fromGaDiagram,
  gaCheck,
  intervalVector,
  lacks,
  ladder,
  ladderText,
  midiOf,
  omittableFifth,
  noteName,
  parseFingering,
  parseSearch,
  parseSetInfo,
  primeForm,
  rootOf,
  rootSpelling,
  setChordOf,
  spelt,
  toGaDiagram,
  transpositionClass,
} from './fretboard'
import { E_MINOR_SEVENTHS, II_V_I_IN_BB, NOTES_OF_CMAJ7 } from './chat-samples'
import { AM7, SEARCH, SET } from './ga-samples'

// The pure half of the chord panes.

test('GA writes string 1 first, charts write the low E first', () => {
  const frets = fromGaDiagram('8-8-9-9-x-8')
  expect(frets).toEqual([8, null, 9, 9, 8, 8])
  expect(toGaDiagram(frets ?? [])).toBe('8-8-9-9-x-8')
  // GA's own MIDI notes for that diagram, high to low: 72 67 64 59 48.
  expect(midiOf(frets ?? []).reverse()).toEqual([72, 67, 64, 59, 48])
  expect(parseFingering('x32010')).toEqual([null, 3, 2, 0, 1, 0])
  expect(parseFingering('x 10 12 12 11 x')).toEqual([null, 10, 12, 12, 11, null])
  expect(parseFingering('x-3-2-0-1-0')).toEqual([null, 3, 2, 0, 1, 0])
  expect(parseFingering('Cmaj7')).toBeUndefined()
  expect(parseFingering('xxxxxx')).toBeUndefined()
  expect(chartText([null, 10, 12, 12, 11, null])).toBe('x 10 12 12 11 x')
})

test('the open C chart, strings left to right and frets downwards', () => {
  expect(diagram([null, 3, 2, 0, 1, 0], 'C').split('\n')).toEqual([
    'C',
    '      E A D G B e',
    '      x     o   o',
    '      ===========',
    '      | | | | ● |',
    '      | | ● | | |',
    '      | ● | | | |',
    '      | | | | | |',
    '      C3 E3 G3 C4 E4',
  ])
})

test('a chart up the neck starts at its lowest fret and says which', () => {
  const lines = diagram([8, null, 9, 9, 8, 8], 'Cmaj7').split('\n')
  expect(lines[2]).toBe('        x        ')
  expect(lines[3]).toBe(' 8fr  ● | | | ● ●')
  expect(lines[4]).toBe('      | | ● ● | |')
  expect(lines.length).toBe(8) // title, strings, marks, four frets, notes
  expect(lines[7]).toBe('      C3 B3 E4 G4 C5')
})

test('x32010 climbs the ladder exactly as music-theory-ga\'s appendix B does', () => {
  const rungs = ladder([null, 3, 2, 0, 1, 0])
  expect(rungs.map(r => [r.rung, r.object])).toEqual([
    ['a fingering', 'x32010  (GA 0-1-0-2-3-x)'],
    ['the pitches', 'C3 E3 G3 C4 E4'],
    ['- O, octave', '0 4 7 0 4'],
    ['- P, permutation', '0 0 4 4 7'],
    ['- C, cardinality', '0 4 7'],
    ['- T, transposition', '0 4 7'],
    ['- I, inversion', '(037)'],
    ['- K, complement', '(01235679T)'], // Forte 9-11, the complement of 3-11
  ])
  expect(ladderText(rungs).split('\n')[0]).toBe(`${'rung'.padEnd(20)}${'the object'.padEnd(26)}what it forgets`)
})

test('set theory agrees with GA and with the course on the chords it checked', () => {
  expect(primeForm([0, 4, 7])).toEqual([0, 3, 7]) // C
  expect(primeForm([9, 0, 4])).toEqual([0, 3, 7]) // A minor: I joins it to C
  expect(transpositionClass([9, 0, 4])).toEqual([0, 3, 7])
  expect(transpositionClass([7, 11, 2])).toEqual([0, 4, 7]) // G
  expect(primeForm([0, 4, 7, 11])).toEqual([0, 1, 5, 8]) // Cmaj7, GA: 0 1 5 8
  expect(primeForm([7, 11, 2, 5])).toEqual([0, 2, 5, 8]) // G7
  expect(primeForm([0, 3, 6, 10])).toEqual([0, 2, 5, 8]) // Cm7b5, the same set class
  expect(primeForm([0, 3, 6, 9])).toEqual([0, 3, 6, 9])
  expect(intervalVector([0, 4, 7, 11])).toEqual([1, 0, 1, 2, 2, 0]) // GA: <1 0 1 2 2 0>
  expect(intervalVector([0, 4, 7])).toEqual([0, 0, 1, 1, 1, 0]) // the course: <0 0 1 1 1 0>
  expect(complementForte('4-20')).toBe('8-20')
  expect(complementForte('3-11')).toBe('9-11')
  expect(complementForte('4-Z15')).toBe('8-Z15')
  expect(complementForte('6-35')).toBe('6-35')
  expect(complementForte('6-Z29')).toBe('the Z partner of 6-Z29')
})

test('GA\'s answers are read, and its numbers checked against the ones computed here', () => {
  const found = parseSearch(SEARCH)
  expect(found.chord).toBe('Cmaj7')
  expect(found.voicings.map(v => [v.name, chartText(v.frets)])).toEqual([
    ['Cmaj7', '8x9988'],
    ['Cmaj7/B', '779x88'],
    ['Cmaj7/E', 'x79588'],
  ])
  expect(parseSearch('{"error":"query is required"}').error).toBe('query is required')
  expect(parseSearch('not json').error).toContain('not JSON')

  const info = parseSetInfo(SET)
  expect(info).toEqual({ forte: '4-20', icv: '<1 0 1 2 2 0>', prime: '0 1 5 8', modal: '4-note / 4 modes (mode 4)' })
  expect(gaCheck([8, null, 9, 9, 8, 8], info)).toBe('GA: Forte 4-20 · ICV <1 0 1 2 2 0> (ok) · prime form 0 1 5 8 (ok) · modal family 4-note / 4 modes (mode 4)')
  expect(gaCheck([null, 3, 2, 0, 1, 0], info)).toContain('prime form 0 1 5 8 (DIFF, computed here 0 3 7)')
  const climbed = ladder([8, null, 9, 9, 8, 8], { ...info })
  expect(climbed[6]?.object).toBe('(0158) · Forte 4-20')
  expect(climbed[7]?.object).toBe('(01245789) · Forte 8-20')
})

test('the chord symbols an answer names, and not the capital letters of its prose', () => {
  const prose = 'A ii-V-I in C: Dm7, G7 and Cmaj7. Try `C` or F#m7b5 over Bb7/D. I like Am.'
  expect(chordSymbols(prose, 8)).toEqual(['Dm7', 'G7', 'Cmaj7', 'C', 'F#m7b5', 'Bb7/D', 'Am']) // in reading order
  expect(chordSymbols(prose).length).toBe(6) // one button each, six at most
  expect(chordSymbols('A chord. I think so. Every Day.')).toEqual([])
  expect(noteName(60)).toBe('C4')
})

test('each voicing GA returns is checked against the notes of the chord GA read', () => {
  const cmaj7 = parseSearch(SEARCH)
  expect(cmaj7.wanted).toEqual([0, 4, 7, 11])
  expect(cmaj7.voicings.map(v => v.missing)).toEqual([[], [], []])

  const am7 = parseSearch(AM7)
  expect(am7.chord).toBe('Am7')
  expect(am7.wanted).toEqual([0, 4, 7, 9])
  expect(am7.voicings.map(v => v.missing)).toEqual([[7], [7], [7]])
  expect(am7.root).toBe(9)
  expect(lacks([])).toBe('')

  // Without pitch classes nothing can be checked, and nothing is claimed.
  const bare = parseSearch(JSON.stringify({ ...JSON.parse(AM7), interpreted: { chord: 'Am7' } }))
  expect(bare.wanted).toEqual([])
  expect(bare.root).toBeUndefined()
  expect(bare.voicings.map(v => v.missing)).toEqual([[], [], []])
  expect(setChordOf(SET)).toBe('Cmaj7')
})

test('a missing note is named by its degree over the root, spelt as the degree implies', () => {
  expect(lacks([7], 9)).toBe('lacks the b7 (G)') // Am7 without G
  expect(lacks([10], 0)).toBe('lacks the b7 (Bb)') // C7, not "A#"
  expect(lacks([8], 10)).toBe('lacks the b7 (Ab)') // Bb7, not "G#"
  expect(lacks([3], 0)).toBe('lacks the b3 (Eb)') // Cm, not "D#"
  expect(lacks([8], 4)).toBe('lacks the 3 (G#)') // E
  expect(lacks([5, 2], 10)).toBe('lacks the 5 (F) and the 3 (D)') // Bb
  expect(lacks([7, 11])).toBe('lacks G and B') // no root known: plain names
})

test('the chords a real answer names, however it spells them: ♯ ♭ Δ, a spaced quality, a bold triad', () => {
  // Both answers came from the chatbot on 2026-10-04; their bold symbols are the chords they are about.
  expect(chordSymbols(E_MINOR_SEVENTHS, 8)).toEqual(['Em7', 'F#m7b5', 'Am7', 'Bdim7', 'Cmaj7'])
  expect(chordSymbols(II_V_I_IN_BB, 8)).toEqual(['Dm7', 'G7', 'Cm7', 'F7', 'Bb'])
  expect(chordSymbols('Try Bø7 to E7, or B°7, and the ii° stays a numeral.', 8)).toEqual(['Bm7b5', 'E7', 'Bdim7'])
  expect(chordSymbols('A major key, a dim light, A 7-string guitar.', 8)).toEqual([])
  expect(chordSymbols('Play C m7, then F\u00A0m6 and G\u2009maj7.', 8)).toEqual(['Cm7', 'Fm6', 'Gmaj7'])
})

test('an altered dominant still names its chord; a note or a word in bold prose names none', () => {
  // challenge of 2026-10-04, 0.2.4: spelling ♯ and ♭ out had cost these their buttons, which 0.2.3 gave.
  expect(chordSymbols('G7♯9, C7♭9, E7♯5, A7♭13 and C9♯11', 8)).toEqual(['G7', 'C7', 'E7', 'A7', 'C9'])
  expect(chordSymbols('What scale fits over **G7alt**?', 8)).toEqual(['G7'])
  expect(chordSymbols('CΔ9 and CΔ, then CΔ7', 8)).toEqual(['Cmaj9', 'Cmaj7'])
  // Bold spans pair up whatever their length, so a long label does not shift the pairs after it.
  expect(chordSymbols('**A bold label longer than twelve characters** | **B♭** |', 8)).toEqual(['Bb'])
  // A bare note name in bold is a chord only as a whole table cell, as the ii-V-I answer's **B♭**.
  expect(chordSymbols('In the **A** section the third is **E**.', 8)).toEqual([])
  expect(chordSymbols('| I | **B♭** | x13331 |', 8)).toEqual(['Bb'])
})

test('a slash chord asks for the bass its symbol spells; "6/9" names none', () => {
  expect(bassOf('Bb7/D')).toEqual({ pc: 2, name: 'D' })
  expect(bassOf('Bb7 / d')).toEqual({ pc: 2, name: 'D' })
  expect(bassOf('C#m7/G#')).toEqual({ pc: 8, name: 'G#' })
  expect(bassOf('Gb/B♭')).toEqual({ pc: 10, name: 'Bb' })
  expect(bassOf('C6/9')).toBeUndefined()
  expect(bassOf('Cmaj7')).toBeUndefined()
  expect(rootOf('Bb7/D')).toEqual({ pc: 10, name: 'Bb' })
})

test('a quality spelt out in words names its chord ("C major 7"), and a key does not ("In C major")', () => {
  // GA's chordinfo skill, 2026-10-04: "C major 7 chord contains C, E, G, and B." gave no button before 0.2.9.
  expect(chordSymbols(NOTES_OF_CMAJ7.naturalLanguageAnswer)).toEqual(['Cmaj7'])
  // The minor and sixth forms follow the same words; not yet seen in a captured answer.
  expect(chordSymbols('A minor 7, then F major 6 (F A C D), D minor 9 chord and G Major 7.')).toEqual(['Am7', 'F6', 'Dm9', 'Gmaj7'])
  // A number that counts something is not a quality.
  expect(chordSymbols('Play it in A minor 7 times, a D major 6 bars long, over an A major 7-note scale; C minor 7 flat 5 is spelt out.')).toEqual([])
  expect(chordSymbols('In C major the basic ii-V-I is Dm7, G7, C; in B♭ major it starts on Cm7.')).toEqual(['Dm7', 'G7', 'Cm7'])
})

test('a minor-major seventh, written with Δ or as GA names it (Cm(maj7)), names CmMaj7, which GA reads 0 3 7 11', () => {
  // GA's ga_search_voicings, 2026-10-04: "CmMaj7" read as pitch classes 0 3 7 11, voicings named "Cm(maj7)".
  expect(chordSymbols('CmΔ7, Cm(maj7) and DmΔ are minor-major sevenths; AΔ is A major seventh.')).toEqual(['CmMaj7', 'DmMaj7', 'Amaj7'])
  expect(chordSymbols('Also written Cm(Maj7), Cm(M7), Ebm(ma7) or F♯m(Δ7).')).toEqual(['CmMaj7', 'EbmMaj7', 'F#mMaj7'])
  // Only an m right after a root: a diminished chord keeps its own button, as before 0.2.10.
  expect(chordSymbols('Cdim(maj7) and Bdim(Δ7)')).toEqual(['Cdim', 'Bdim'])
  // A minor-major ninth is no symbol GA was seen to read: no button rather than a wrong Cm.
  expect(chordSymbols('CmΔ9 and Cm(maj9)')).toEqual([])
})

test('only a four-note chord\'s perfect 5th may be left out: a triad\'s, an altered one and a larger chord\'s stay', () => {
  expect(omittableFifth([7, 11, 2, 5], 7)).toBe(2) // G7: D
  expect(omittableFifth([0, 4, 7, 9], 0)).toBe(7) // C6
  expect(omittableFifth([0, 5, 7, 10], 0)).toBe(7) // C7sus4
  expect(omittableFifth([0, 2, 4, 7], 0)).toBe(7) // Cadd9
  expect(omittableFifth([0, 4, 7], 0)).toBeUndefined() // C: a triad keeps its 5th
  // GA reads a slash chord without a foreign bass (C/D: 0 4 7, Am/G: 0 4 9, build a62dfbfb, 2026-10-04): still a triad.
  expect(omittableFifth([0, 4, 9], 9)).toBeUndefined()
  expect(omittableFifth([0, 4, 6, 10], 0)).toBeUndefined() // C7b5: no perfect 5th to leave out
  expect(omittableFifth([0, 4, 8, 10], 0)).toBeUndefined() // C7#5
  expect(omittableFifth([0, 3, 6, 10], 0)).toBeUndefined() // Cm7b5
  expect(omittableFifth([0, 2, 4, 5, 7, 9, 10], 0)).toBeUndefined() // C13: seven notes, all asked
  expect(omittableFifth([7, 11, 2, 5])).toBeUndefined() // no root known
})

test('a note is spelt from the root as its symbol writes it: sharps over C#, flats over Bb, Bb as F\'s 11', () => {
  const cSharp = { pc: 1, accidental: '#' } as const
  const bFlat = { pc: 10, accidental: 'b' } as const
  expect(lacks([8], cSharp)).toBe('lacks the 5 (G#)') // C#m7 without its 5: not "Ab"
  expect(spelt(4, cSharp)).toBe('E') // its b3
  expect(spelt(6, { pc: 8, accidental: '#' })).toBe('F#') // G#7's b7, not "Gb"
  expect(spelt(8, bFlat)).toBe('Ab') // Bb7's b7
  expect(spelt(2, bFlat)).toBe('D') // its 3
  expect(spelt(6, bFlat)).toBe('F#') // Bb+'s #5
  expect(spelt(10, { pc: 5, accidental: '' })).toBe('Bb') // F's 11, not "A#"
  expect(spelt(6, { pc: 2, accidental: '' })).toBe('F#') // D's 3
  expect(spelt(3, { pc: 0, accidental: '' })).toBe('Eb') // C's b3
  // A root known by its pitch class only keeps the old rule, and no root keeps the plain names.
  expect(lacks([8], 1)).toBe('lacks the 5 (Ab)')
  expect(noteName(46)).toBe('A#2')
  expect(noteName(46, bFlat)).toBe('Bb2')
  // GA's first Bb7/D voicing, 2026-10-04: its chart's note line.
  expect(diagram(fromGaDiagram('6-9-7-6-x-6') ?? [], 'Bb7(shell)', bFlat).split('\n').at(-1)).toBe('      Bb2 Ab3 D4 Ab4 Bb4')
  expect(ladder(fromGaDiagram('6-9-7-6-x-6') ?? [], undefined, bFlat)[1]?.object).toBe('Bb2 Ab3 D4 Ab4 Bb4')
})

test('a degree its symbol alters is spelt as the symbol names it, and each note takes its degree\'s letter', () => {
  const r = (symbol: string) => rootSpelling(symbol)
  expect(r('Bb7/D')).toEqual({ pc: 10, accidental: 'b', altered: {} })
  expect(spelt(3, r('C7#9'))).toBe('D#') // not the b3's Eb
  expect(lacks([3], r('C7#9'))).toBe('lacks the #9 (D#)')
  expect(spelt(6, r('Cmaj7#11'))).toBe('F#') // not the b5's Gb
  expect(spelt(8, r('C7b13'))).toBe('Ab') // not the #5's G#
  expect(spelt(1, r('Edim7'))).toBe('Db') // its bb7
  expect(spelt(9, r('Cdim7'))).toBe('A') // Bbb, which this speller writes A
  expect(spelt(11, r('Fm7b5'))).toBe('Cb')
  expect(spelt(0, r('E+'))).toBe('B#')
  expect(spelt(5, r('C#7'))).toBe('E#')
  expect(spelt(10, r('Fsus4'))).toBe('Bb')
  // The octave is the letter's: B#3 sounds as C4, Cb4 as B3.
  expect(noteName(60, r('C#7'))).toBe('B#3')
  expect(noteName(59, r('Db7'))).toBe('Cb4')
  expect(noteName(61, r('C#m7'))).toBe('C#4')
})

test('the ladder names GA\'s Forte numbers only on the set they are of: a Bb7 shell\'s (026) is not 4-27', () => {
  // GA's ga_chord_to_set for Bb7, verbatim (2026-10-05): ICV <0 1 2 1 1 1>, Forte 4-27, prime form 0 2 5 8.
  const ga = { forte: '4-27', icv: '<0 1 2 1 1 1>', prime: '0 2 5 8', modal: '4-note / 8 modes (mode 0)' }
  const rung = (frets: (number | null)[] | undefined, name: string) => ladder(frets ?? [], ga).find(r => r.rung === name)?.object
  const shell = fromGaDiagram('6-9-7-6-x-6')
  expect(rung(shell, '- I, inversion')).toBe('(026)')
  expect(rung(shell, '- K, complement')).toBe('(01234678T)')
  // A full Bb7 (x13131: Bb F Ab D F) is the set GA named: its numbers stay.
  expect(rung(parseFingering('x13131'), '- I, inversion')).toBe('(0258) · Forte 4-27')
  expect(rung(parseFingering('x13131'), '- K, complement')).toMatch(/ · Forte 8-27$/)
  const I = (frets: (number | null)[] | undefined, info: typeof ga) => ladder(frets ?? [], info).find(r => r.rung === '- I, inversion')?.object
  // A prime form written another way (or in Forte's packing, not the Rahn packing used here): the same ICV and size
  // name the same set class, unless its Forte number is a Z one.
  expect(I(parseFingering('x13131'), { ...ga, prime: '(0258)' })).toBe('(0258) · Forte 4-27')
  expect(I(parseFingering('x13131'), { ...ga, prime: '' })).toBe('(0258) · Forte 4-27')
  expect(I(shell, { ...ga, prime: '' })).toBe('(026)')
  // With neither a prime form nor an ICV, a size alone names no set: no number.
  expect(I(parseFingering('x13131'), { ...ga, prime: '', icv: '' })).toBe('(0258)')
  // C C# D# G (4-Z29) shares its ICV with 4-Z15: GA's 4-Z15 is not its number.
  expect(I(parseFingering('8 4 1 0 x x'), { forte: '4-Z15', icv: '<1 1 1 1 1 1>', prime: '0 1 4 6', modal: '' })).toBe('(0137)')
  // The GA line says whose number it prints when the set differs.
  expect(gaCheck(shell ?? [], ga)).toMatch(/^GA: Forte 4-27 \(the chord's, not this voicing's\) · /)
  expect(gaCheck(parseFingering('x13131') ?? [], ga)).toMatch(/^GA: Forte 4-27 · ICV <0 1 2 1 1 1> \(ok\)/)
})
