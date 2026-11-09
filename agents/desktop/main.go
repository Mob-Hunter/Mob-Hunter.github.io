// Mob Hunter desktop agent for Windows, Linux and macOS.
//
// It speaks the same signed device protocol as the Android agent: an Ed25519 device key
// certified by the server's CA, every request signed, every command verified against the
// pinned server key with a 10-minute expiry. Its command set is closed — message, lock,
// reboot, policy sync and release — so there is no shell, file access or screen capture.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
)

// Version is set at build time (-ldflags "-X main.Version=…").
var Version = "1.0.0"

const usage = `Mob Hunter desktop agent %s

Usage:
  mob-hunter-agent enrol '<mobhunter://enrol?… link>' [--accept-notice] [--no-service]
  mob-hunter-agent acknowledge     read the employee notice and confirm it
  mob-hunter-agent status          show enrolment and the last check-in
  mob-hunter-agent posture         print exactly what this computer reports
  mob-hunter-agent sync            check in and run pending commands now
  mob-hunter-agent run             run in the foreground (what the service does)
  mob-hunter-agent uninstall       remove the service and this computer's credentials
  mob-hunter-agent version

Get the enrolment link in the console: Add devices → Computer. Run as root (Linux, macOS)
or from an elevated PowerShell (Windows) to install the background service.
`

func main() {
	logger := log.New(os.Stderr, "mob-hunter-agent: ", log.LstdFlags)
	if len(os.Args) < 2 {
		fmt.Printf(usage, Version)
		os.Exit(2)
	}
	dir := os.Getenv("MOB_HUNTER_DIR")
	if dir == "" {
		dir = defaultDir()
	}
	cfg, err := loadConfig(dir)
	if err != nil {
		logger.Fatalf("reading %s: %v", configPath(dir), err)
	}
	a := &Agent{Dir: dir, Cfg: cfg, Sys: newSystem(), Log: logger}
	if cfg != nil {
		if a.API, err = newClient(cfg); err != nil {
			logger.Fatal(err)
		}
	}
	switch os.Args[1] {
	case "version", "--version", "-v":
		fmt.Println(Version)
	case "enrol", "enroll":
		fs := flag.NewFlagSet("enrol", flag.ExitOnError)
		acceptNotice := fs.Bool("accept-notice", false, "the employee has been given the device notice (unattended installs)")
		noService := fs.Bool("no-service", false, "do not install the background service")
		args := reorder(os.Args[2:])
		_ = fs.Parse(args)
		if fs.NArg() != 1 {
			logger.Fatal("give the enrolment link from the console, in quotes")
		}
		link, err := parseEnrolLink(fs.Arg(0))
		if err != nil {
			logger.Fatal(err)
		}
		if err := a.Enrol(link, func(title string, collected, notCollected []string) bool {
			return confirmNotice(title, collected, notCollected, *acceptNotice)
		}); err != nil {
			logger.Fatal(err)
		}
		fmt.Printf("Enrolled as %s. The computer now appears in the console.\n", a.Cfg.DeviceID)
		if *noService {
			fmt.Println("Service not installed (--no-service): run `mob-hunter-agent run` to keep it managed.")
			return
		}
		if !a.Sys.Privileged() {
			fmt.Println("Not running as administrator/root: the background service was not installed. Re-run `enrol` elevated, or keep `mob-hunter-agent run` running.")
			return
		}
		exe, _ := os.Executable()
		if err := a.Sys.InstallService(exe); err != nil {
			logger.Fatalf("installing the service: %v", err)
		}
		fmt.Println("Background service installed: it checks in every 15 minutes and picks up commands within a minute.")
	case "posture":
		// Transparency: prints exactly what this computer reports to the console.
		b, _ := json.MarshalIndent(map[string]any{"hardware": a.Sys.Hardware(), "telemetry": a.Sys.Telemetry()}, "", "  ")
		fmt.Println(string(b))
	case "status":
		if cfg == nil {
			fmt.Println("Not enrolled.")
			os.Exit(1)
		}
		fmt.Printf("Enrolled as %s with %s (policy v%d, notice %s acknowledged: %v, service mode: %v)\n", cfg.DeviceID, cfg.Server, cfg.PolicyVersion, cfg.NoticeVersion, cfg.AcknowledgedAt > 0, cfg.Privileged)
	case "sync":
		mustEnrolled(a, logger)
		if err := a.Checkin(); err != nil {
			logger.Fatal(err)
		}
		out, err := a.Poll()
		if err != nil {
			logger.Fatal(err)
		}
		for _, o := range out {
			fmt.Printf("%s %s → %s\n", o.ID, o.Type, o.Result)
		}
		fmt.Println("Synced.")
	case "run":
		mustEnrolled(a, logger)
		stop := make(chan struct{})
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
		go func() { <-sig; close(stop) }()
		logger.Printf("agent %s running for %s", Version, a.Cfg.DeviceID)
		a.Run(stop)
	case "acknowledge":
		mustEnrolled(a, logger)
		n := a.Cfg.Notice
		if a.Cfg.AcknowledgedAt == 0 && confirmNotice(n.Title, n.Collected, n.NotCollected, false) {
			a.Cfg.AcknowledgedAt = a.now().UnixMilli()
			if err := a.Checkin(); err != nil {
				logger.Fatal(err)
			}
		}
		fmt.Println("Notice acknowledged.")
	case "uninstall":
		a.Release()
		fmt.Println("Removed. Also delete the device in the console (or it will show as not checking in).")
	default:
		fmt.Printf(usage, Version)
		os.Exit(2)
	}
}

func mustEnrolled(a *Agent, l *log.Logger) {
	if a.Cfg == nil || a.Cfg.DeviceID == "" {
		l.Fatal(errors.New("not enrolled: run `mob-hunter-agent enrol '<link>'` first"))
	}
}

// reorder lets flags follow the link (Go's flag package stops at the first positional argument).
func reorder(args []string) []string {
	var flags, pos []string
	for _, a := range args {
		if strings.HasPrefix(a, "--") {
			flags = append(flags, a)
		} else {
			pos = append(pos, a)
		}
	}
	return append(flags, pos...)
}

// confirmNotice shows the employee notice; the device only becomes active once it is acknowledged.
func confirmNotice(title string, collected, notCollected []string, preAccepted bool) bool {
	fmt.Printf("\n== %s ==\nYour organisation will collect:\n", title)
	for _, c := range collected {
		fmt.Printf("  • %s\n", c)
	}
	fmt.Println("It will never collect:")
	for _, c := range notCollected {
		fmt.Printf("  • %s\n", c)
	}
	if preAccepted {
		fmt.Println("Notice accepted on the employee's behalf (--accept-notice): make sure they have read it.")
		return true
	}
	fmt.Print("\nType \"I understand\" to continue: ")
	line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	if strings.EqualFold(strings.TrimSpace(line), "I understand") {
		return true
	}
	fmt.Println("Not acknowledged: the computer stays inactive until you run `mob-hunter-agent acknowledge`.")
	return false
}
