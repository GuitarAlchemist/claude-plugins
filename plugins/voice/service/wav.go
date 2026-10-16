package main

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// parseWAV returns the samples and sample rate of a 16-bit mono PCM WAV file, the only kind
// Piper writes.
func parseWAV(b []byte) ([]byte, int, error) {
	if len(b) < 12 || string(b[0:4]) != "RIFF" || string(b[8:12]) != "WAVE" {
		return nil, 0, errors.New("not a WAV file")
	}
	rate, haveFmt := 0, false
	for p := 12; p+8 <= len(b); {
		id := string(b[p : p+4])
		size := int(binary.LittleEndian.Uint32(b[p+4 : p+8]))
		body := p + 8
		if size > len(b)-body {
			if id != "data" {
				return nil, 0, fmt.Errorf("WAV chunk %q is cut short", id)
			}
			size = len(b) - body
		}
		switch id {
		case "fmt ":
			if size < 16 {
				return nil, 0, errors.New("WAV fmt chunk is too short")
			}
			format := binary.LittleEndian.Uint16(b[body:])
			channels := binary.LittleEndian.Uint16(b[body+2:])
			rate = int(binary.LittleEndian.Uint32(b[body+4:]))
			bits := binary.LittleEndian.Uint16(b[body+14:])
			if format != 1 || channels != 1 || bits != 16 {
				return nil, 0, fmt.Errorf("want 16-bit mono PCM, got format %d with %d channels of %d bits", format, channels, bits)
			}
			haveFmt = true
		case "data":
			if !haveFmt {
				return nil, 0, errors.New("WAV data comes before its format")
			}
			return b[body : body+size], rate, nil
		}
		p = body + size + size%2
	}
	return nil, 0, errors.New("WAV file has no data")
}

// wavHeader is the 44-byte header of a 16-bit mono PCM WAV file holding dataLen bytes.
func wavHeader(rate, dataLen int) []byte {
	h := make([]byte, 44)
	copy(h[0:], "RIFF")
	binary.LittleEndian.PutUint32(h[4:], uint32(36+dataLen))
	copy(h[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(h[16:], 16)
	binary.LittleEndian.PutUint16(h[20:], 1)
	binary.LittleEndian.PutUint16(h[22:], 1)
	binary.LittleEndian.PutUint32(h[24:], uint32(rate))
	binary.LittleEndian.PutUint32(h[28:], uint32(rate*2))
	binary.LittleEndian.PutUint16(h[32:], 2)
	binary.LittleEndian.PutUint16(h[34:], 16)
	copy(h[36:], "data")
	binary.LittleEndian.PutUint32(h[40:], uint32(dataLen))
	return h
}

// audioMs is how long pcm lasts at rate.
func audioMs(pcm []byte, rate int) int64 {
	if rate <= 0 {
		return 0
	}
	return int64(len(pcm)/2) * 1000 / int64(rate)
}
