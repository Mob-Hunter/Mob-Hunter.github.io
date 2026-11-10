//go:build windows

package main

import "testing"

func TestVBSServiceNames(t *testing.T) {
	for in, want := range map[string]string{"0": "None running", "": "None running", "1,2": "Credential Guard, Memory integrity (HVCI)"} {
		if got := vbsServices(in); got != want {
			t.Errorf("vbsServices(%q) = %q, want %q", in, got, want)
		}
	}
}
