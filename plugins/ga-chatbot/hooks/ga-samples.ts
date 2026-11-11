// GA's real answers for Cmaj7 on 2026-10-04, from ga_search_voicings and ga_chord_to_set: the tests'
// stand-ins for the GA MCP server.

export const SEARCH = JSON.stringify({
  query: 'Cmaj7',
  interpreted: { chord: 'Cmaj7', rootPitchClass: 0, pitchClasses: [0, 4, 7, 11], mode: null, tags: null, instrument: 'guitar', samplingFired: false },
  resultCount: 3,
  results: [
    { score: 0.5333, diagram: '8-8-9-9-x-8', chordName: 'Cmaj7', instrument: 'guitar', midiNotes: [72, 67, 64, 59, 48], pitchClasses: [0, 4, 7, 11] },
    { score: 0.5333, diagram: '8-8-x-9-7-7', chordName: 'Cmaj7/B', instrument: 'guitar', midiNotes: [72, 67, 59, 52, 47], pitchClasses: [0, 4, 7, 11] },
    { score: 0.5333, diagram: '8-8-5-9-7-x', chordName: 'Cmaj7/E', instrument: 'guitar', midiNotes: [72, 67, 60, 59, 52], pitchClasses: [0, 4, 7, 11] },
  ],
})

export const SET = [
  'Chord: Cmaj7',
  'Pitch set:  {C, E, G, B} (4 tones)',
  '  ICV:        <1 0 1 2 2 0>',
  '  Forte:      4-20',
  '  Prime form: 0 1 5 8',
  '  Modal fam.: 4-note / 4 modes (mode 4)',
  'OPTIC-K layer: STRUCTURE (dims 6–29, w=0.45) — ICV drives structural similarity',
].join('\n')

// GA's real answer for Am7 the same day, first three of six results: it reads Am7 as 0 4 7 9, then returns
// A minor triads (0 4 9) with no G, all scored alike.
export const AM7 = JSON.stringify({
  query: 'Am7',
  interpreted: { chord: 'Am7', rootPitchClass: 9, pitchClasses: [0, 4, 7, 9], mode: null, tags: null, instrument: 'guitar', samplingFired: false },
  resultCount: 6,
  results: [
    { score: 0.5066, diagram: '5-5-5-7-x-5', chordName: 'Am', instrument: 'guitar', midiNotes: [69, 64, 60, 57, 45], pitchClasses: [0, 4, 9] },
    { score: 0.5066, diagram: '5-5-5-x-7-5', chordName: 'Am', instrument: 'guitar', midiNotes: [69, 64, 60, 52, 45], pitchClasses: [0, 4, 9] },
    { score: 0.5066, diagram: '5-5-5-7-7-5', chordName: 'Am', instrument: 'guitar', midiNotes: [69, 64, 60, 57, 52, 45], pitchClasses: [0, 4, 9] },
  ],
})

// GA's real answer for Bb7/D the same day, all six results (the MCP server's build, a62dfbfb). Its
// `interpreted` block names no bass; results 4-6 are named "Bb7(shell)/D" and have D lowest, results 1-3
// have Bb lowest, and all six lack the 5 (F).
export const BB7_OVER_D = "{\"query\":\"Bb7/D\",\"interpreted\":{\"chord\":\"Bb7/D\",\"rootPitchClass\":10,\"pitchClasses\":[2,5,8,10],\"mode\":null,\"tags\":null,\"instrument\":\"guitar\",\"samplingFired\":false},\"resultCount\":6,\"results\":[{\"score\":0.483,\"diagram\":\"6-9-7-6-x-6\",\"chordName\":\"Bb7(shell)\",\"instrument\":\"guitar\",\"midiNotes\":[70,68,62,56,46],\"pitchClasses\":[2,8,10]},{\"score\":0.483,\"diagram\":\"6-x-7-6-x-6\",\"chordName\":\"Bb7(shell)\",\"instrument\":\"guitar\",\"midiNotes\":[70,62,56,46],\"pitchClasses\":[2,8,10]},{\"score\":0.483,\"diagram\":\"6-9-7-8-x-6\",\"chordName\":\"Bb7(shell)\",\"instrument\":\"guitar\",\"midiNotes\":[70,68,62,58,46],\"pitchClasses\":[2,8,10]},{\"score\":0.483,\"diagram\":\"6-9-x-x-5-x\",\"chordName\":\"Bb7(shell)/D\",\"instrument\":\"guitar\",\"midiNotes\":[70,68,50],\"pitchClasses\":[2,8,10]},{\"score\":0.483,\"diagram\":\"6-9-7-x-5-x\",\"chordName\":\"Bb7(shell)/D\",\"instrument\":\"guitar\",\"midiNotes\":[70,68,62,50],\"pitchClasses\":[2,8,10]},{\"score\":0.483,\"diagram\":\"6-x-x-6-5-x\",\"chordName\":\"Bb7(shell)/D\",\"instrument\":\"guitar\",\"midiNotes\":[70,56,50],\"pitchClasses\":[2,8,10]}]}"

// GA's real answer for C13 the same day, all six results (build a62dfbfb): it reads seven notes, more than
// six strings hold, and returns Fsus4 shapes (C E F Bb) that lack the 9, the 5 and the 13.
export const C13 = "{\"query\":\"C13\",\"interpreted\":{\"chord\":\"C13\",\"rootPitchClass\":0,\"pitchClasses\":[0,2,4,5,7,9,10],\"mode\":null,\"tags\":null,\"instrument\":\"guitar\",\"samplingFired\":false},\"resultCount\":6,\"results\":[{\"score\":0.4465,\"diagram\":\"8-6-9-8-x-6\",\"chordName\":\"Fsus4/Bb\",\"instrument\":\"guitar\",\"midiNotes\":[72,65,64,58,46],\"pitchClasses\":[0,4,5,10]},{\"score\":0.4465,\"diagram\":\"8-6-x-8-7-6\",\"chordName\":\"Fsus4/Bb\",\"instrument\":\"guitar\",\"midiNotes\":[72,65,58,52,46],\"pitchClasses\":[0,4,5,10]},{\"score\":0.4465,\"diagram\":\"8-6-5-8-7-x\",\"chordName\":\"Fsus4/E\",\"instrument\":\"guitar\",\"midiNotes\":[72,65,60,58,52],\"pitchClasses\":[0,4,5,10]},{\"score\":0.4465,\"diagram\":\"8-6-9-8-7-6\",\"chordName\":\"Fsus4/Bb\",\"instrument\":\"guitar\",\"midiNotes\":[72,65,64,58,52,46],\"pitchClasses\":[0,4,5,10]},{\"score\":0.4465,\"diagram\":\"8-5-5-8-8-x\",\"chordName\":\"Fsus4\",\"instrument\":\"guitar\",\"midiNotes\":[72,64,60,58,53],\"pitchClasses\":[0,4,5,10]},{\"score\":0.4465,\"diagram\":\"8-x-9-8-8-8\",\"chordName\":\"Fsus4/C\",\"instrument\":\"guitar\",\"midiNotes\":[72,64,58,53,48],\"pitchClasses\":[0,4,5,10]}]}"

// GA's real answer for G7 the same day, all six results (build a62dfbfb): shells that GA names "G7(shell)",
// each holding G B F without the 5 (D).
export const G7_SHELLS = "{\"query\":\"G7\",\"interpreted\":{\"chord\":\"G7\",\"rootPitchClass\":7,\"pitchClasses\":[2,5,7,11],\"mode\":null,\"tags\":null,\"instrument\":\"guitar\",\"samplingFired\":false},\"resultCount\":6,\"results\":[{\"score\":0.483,\"diagram\":\"x-x-x-5-8-7\",\"chordName\":\"G7(shell)/B\",\"instrument\":\"guitar\",\"midiNotes\":[55,53,47],\"pitchClasses\":[5,7,11]},{\"score\":0.483,\"diagram\":\"x-8-x-5-8-7\",\"chordName\":\"G7(shell)/B\",\"instrument\":\"guitar\",\"midiNotes\":[67,55,53,47],\"pitchClasses\":[5,7,11]},{\"score\":0.483,\"diagram\":\"x-8-10-9-8-x\",\"chordName\":\"G7(shell)/F\",\"instrument\":\"guitar\",\"midiNotes\":[67,65,59,53],\"pitchClasses\":[5,7,11]},{\"score\":0.483,\"diagram\":\"x-8-12-9-8-x\",\"chordName\":\"G7(shell)/F\",\"instrument\":\"guitar\",\"midiNotes\":[67,67,59,53],\"pitchClasses\":[5,7,11]},{\"score\":0.483,\"diagram\":\"x-8-10-9-10-x\",\"chordName\":\"G7(shell)\",\"instrument\":\"guitar\",\"midiNotes\":[67,65,59,55],\"pitchClasses\":[5,7,11]},{\"score\":0.483,\"diagram\":\"3-6-4-3-x-3\",\"chordName\":\"G7(shell)\",\"instrument\":\"guitar\",\"midiNotes\":[67,65,59,53,43],\"pitchClasses\":[5,7,11]}]}"
