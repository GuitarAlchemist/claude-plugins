package main

import (
	"regexp"
	"strings"
	"unicode"
)

// maxSentence is the longest piece sent to the engine at once, in runes. A longer run of text
// with no sentence end is cut at the last comma, semicolon, colon or space before it.
const maxSentence = 300

// Splitter cuts text that may arrive in pieces (an LLM's token stream) into sentences, so the
// first one can be spoken before the rest has arrived. A sentence ends at a newline, or at
// . ! ? or … followed by a space; the end is only certain once the next character is seen.
type Splitter struct{ pending []rune }

// Feed adds a piece of text and returns the sentences it completed.
func (s *Splitter) Feed(chunk string) []string {
	s.pending = append(s.pending, []rune(chunk)...)
	var out []string
	for {
		cut := boundary(s.pending)
		if cut < 0 {
			return out
		}
		out = appendSentence(out, string(s.pending[:cut]))
		s.pending = s.pending[cut:]
	}
}

// Flush returns what is left as a last sentence.
func (s *Splitter) Flush() []string {
	out := appendSentence(nil, string(s.pending))
	s.pending = nil
	return out
}

// Sentences splits a whole text.
func Sentences(text string) []string {
	var s Splitter
	return append(s.Feed(text), s.Flush()...)
}

func boundary(r []rune) int {
	for i := 0; i < len(r); i++ {
		if r[i] == '\n' {
			return i + 1
		}
		if !strings.ContainsRune(".!?…", r[i]) {
			continue
		}
		j := i + 1
		for {
			for j < len(r) && strings.ContainsRune(".!?…\"')]»”’", r[j]) {
				j++
			}
			// French puts a space before a closing guillemet: « oui. »
			k := j
			for k < len(r) && strings.ContainsRune("   \t", r[k]) {
				k++
			}
			if k == len(r) {
				j = k // a guillemet may still follow
			} else if k > j && strings.ContainsRune("»”", r[k]) {
				j = k + 1
				continue
			}
			break
		}
		if j == len(r) {
			break // the next character decides
		}
		if !unicode.IsSpace(r[j]) {
			i = j - 1
			continue
		}
		if r[i] == '.' && notAnEnd(r[:i]) {
			i = j - 1
			continue
		}
		return j
	}
	if len(r) > maxSentence {
		for k := maxSentence; k > maxSentence/2; k-- {
			if strings.ContainsRune(",;: ", r[k]) {
				return k + 1
			}
		}
		return maxSentence
	}
	return -1
}

var abbreviations = map[string]bool{
	"M": true, "Mme": true, "Mlle": true, "MM": true, "Dr": true, "Pr": true, "St": true,
	"Mr": true, "Mrs": true, "Ms": true, "cf": true, "vs": true, "ex": true, "p": true,
	"e.g": true, "i.e": true, "n°": true,
}

// notAnEnd reports whether the word before a period makes it something other than a sentence
// end: an abbreviation, an initial, or a list number at the start of a line.
func notAnEnd(before []rune) bool {
	k := len(before)
	for k > 0 && !unicode.IsSpace(before[k-1]) {
		k--
	}
	word := string(before[k:])
	if abbreviations[word] {
		return true
	}
	rs := []rune(word)
	if len(rs) == 1 && unicode.IsUpper(rs[0]) {
		return true
	}
	return k == 0 && word != "" && strings.Trim(word, "0123456789") == ""
}

func appendSentence(out []string, s string) []string {
	s = clean(s)
	if strings.IndexFunc(s, func(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }) < 0 {
		return out
	}
	return append(out, s)
}

var (
	mdLink    = regexp.MustCompile(`\[([^\]]*)\]\([^)]*\)`)
	bareURL   = regexp.MustCompile(`https?://\S+`)
	lineMark  = regexp.MustCompile(`^\s*(#+|>+|[-*+])\s+`)
	emphasis  = strings.NewReplacer("**", "", "__", "", "~~", "", "`", "", "*", "")
	spaceRuns = regexp.MustCompile(`\s+`)
)

// clean removes what Markdown adds and a voice should not read: heading and list markers,
// emphasis, code ticks, link targets and bare URLs.
func clean(s string) string {
	s = lineMark.ReplaceAllString(s, "")
	s = mdLink.ReplaceAllString(s, "$1")
	s = bareURL.ReplaceAllString(s, "")
	s = emphasis.Replace(s)
	return strings.TrimSpace(spaceRuns.ReplaceAllString(s, " "))
}
