package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestSentences(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"Bonjour. Comment ça va ? Très bien !", []string{"Bonjour.", "Comment ça va ?", "Très bien !"}},
		{"M. Dupont arrive. Il est là.", []string{"M. Dupont arrive.", "Il est là."}},
		{"J. R. R. Tolkien wrote it. Then e.g. this.", []string{"J. R. R. Tolkien wrote it.", "Then e.g. this."}},
		{"Pi vaut 3.14 environ. Voilà.", []string{"Pi vaut 3.14 environ.", "Voilà."}},
		{"Il a dit « oui. » Puis non.", []string{"Il a dit « oui. »", "Puis non."}},
		{"Quoi ?! Vraiment... Oui.", []string{"Quoi ?!", "Vraiment...", "Oui."}},
		{"## Titre\n- **un** point\n1. premier\n`code` et [lien](https://x.org) https://y.org", []string{"Titre", "un point", "1. premier", "code et lien"}},
		{"   \n\n***\n", nil},
	}
	for _, c := range cases {
		if got := Sentences(c.in); !reflect.DeepEqual(got, c.want) {
			t.Errorf("Sentences(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestSplitterWaitsForTheNextCharacter(t *testing.T) {
	var s Splitter
	if got := s.Feed("Il coûte 3."); got != nil {
		t.Fatalf("a period at the end of a piece is not yet an end: %q", got)
	}
	if got := s.Feed("50 euros. Et"); !reflect.DeepEqual(got, []string{"Il coûte 3.50 euros."}) {
		t.Fatalf("got %q", got)
	}
	if got := s.Feed(" voilà"); got != nil {
		t.Fatalf("got %q", got)
	}
	if got := s.Flush(); !reflect.DeepEqual(got, []string{"Et voilà"}) {
		t.Fatalf("flush got %q", got)
	}
}

func TestSplitterStreamsTokenByToken(t *testing.T) {
	var s Splitter
	var got []string
	for _, tok := range strings.SplitAfter("Un. Deux trois. Quatre", " ") {
		got = append(got, s.Feed(tok)...)
	}
	got = append(got, s.Flush()...)
	if want := []string{"Un.", "Deux trois.", "Quatre"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestLongRunsAreCut(t *testing.T) {
	long := strings.Repeat("mot, ", 200)
	got := Sentences(long)
	if len(got) < 3 {
		t.Fatalf("a %d-rune run gave %d pieces", len([]rune(long)), len(got))
	}
	for _, s := range got {
		if n := len([]rune(s)); n > maxSentence {
			t.Errorf("piece of %d runes exceeds %d", n, maxSentence)
		}
	}
}
