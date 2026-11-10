package main

import (
	"context"
	"math"
	"os"
	"os/exec"
	"strings"
	"time"
)

// run executes a fixed OS tool (never a command supplied by the server) with a timeout.
func run(timeout time.Duration, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func has(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func readTrim(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func gb(bytes float64) float64 { return math.Round(bytes/1e9*10) / 10 }

func boolp(b bool) *bool { return &b }
func intp(i int) *int    { return &i }

func healthOf(ratio float64) string {
	switch {
	case ratio <= 0:
		return "good"
	case ratio >= 0.8:
		return "good"
	case ratio >= 0.6:
		return "fair"
	default:
		return "poor"
	}
}

// cached keeps slow probes (pending OS updates) from running more than every few hours.
type cached struct {
	at  time.Time
	val *int
}

func (c *cached) get(every time.Duration, f func() *int) *int {
	if c.at.IsZero() || time.Since(c.at) > every {
		c.val, c.at = f(), time.Now()
	}
	return c.val
}

// singleLine keeps notification text safe for tools that take it as an argument.
func singleLine(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > max {
		s = s[:max]
	}
	return s
}
