package main

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const (
	logMaxBytes = 1 << 20 // rotate at 1 MiB
	logKeep     = 3       // agent.log + agent.log.1 … agent.log.3
)

func logDir(dataDir string) string  { return filepath.Join(dataDir, "logs") }
func logPath(dataDir string) string { return filepath.Join(logDir(dataDir), "agent.log") }

// rotatingFile is an append-only log file that rolls over at logMaxBytes and keeps logKeep old files.
type rotatingFile struct {
	mu   sync.Mutex
	path string
	f    *os.File
	size int64
}

func openRotating(path string) (*rotatingFile, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	st, _ := f.Stat()
	return &rotatingFile{path: path, f: f, size: st.Size()}, nil
}

func (r *rotatingFile) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.size+int64(len(p)) > logMaxBytes {
		r.rotate()
	}
	n, err := r.f.Write(p)
	r.size += int64(n)
	return n, err
}

func (r *rotatingFile) rotate() {
	_ = r.f.Close()
	for i := logKeep - 1; i >= 1; i-- {
		_ = os.Rename(fmt.Sprintf("%s.%d", r.path, i), fmt.Sprintf("%s.%d", r.path, i+1))
	}
	_ = os.Rename(r.path, r.path+".1")
	f, err := os.OpenFile(r.path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err == nil {
		r.f, r.size = f, 0
	}
}

func (r *rotatingFile) Close() error { return r.f.Close() }

// newLogger writes to the rotating log file, to stderr when someone is watching, and to any extra
// sink (the Windows Event Log when running as a service).
func newLogger(dataDir string, console bool, extra io.Writer) (*log.Logger, io.Closer) {
	var ws []io.Writer
	var closer io.Closer = io.NopCloser(nil)
	if rf, err := openRotating(logPath(dataDir)); err == nil {
		ws = append(ws, rf)
		closer = rf
	}
	if console {
		ws = append(ws, os.Stderr)
	}
	if extra != nil {
		ws = append(ws, extra)
	}
	if len(ws) == 0 {
		ws = append(ws, io.Discard)
	}
	return log.New(io.MultiWriter(ws...), "", log.LstdFlags|log.LUTC), closer
}

// tailLog returns the last n lines of the current log file.
func tailLog(dataDir string, n int) ([]string, error) {
	f, err := os.Open(logPath(dataDir))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var lines []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		lines = append(lines, sc.Text())
		if len(lines) > n {
			lines = lines[1:]
		}
	}
	return lines, sc.Err()
}

// levelOf classifies a log line for sinks with severities (Event Log).
func levelOf(line string) string {
	l := strings.ToLower(line)
	switch {
	case strings.Contains(l, "failed") || strings.Contains(l, "error") || strings.Contains(l, "revoked"):
		return "warning"
	default:
		return "info"
	}
}
