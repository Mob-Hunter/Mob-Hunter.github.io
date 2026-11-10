//go:build !windows

package main

func runService(_ *Agent, foreground func(stop <-chan struct{})) error {
	return runForeground(foreground)
}
