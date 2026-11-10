package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/url"
	"strings"
	"time"
)

// Hardware identifies the computer.
type Hardware struct {
	Serial string `json:"serial"`
	Model  string `json:"model"`
	OS     string `json:"os"`
}

// Posture is the security configuration the agent reads from the OS (never content or activity).
type Posture struct {
	Compromised    *bool  `json:"compromised,omitempty"`
	ScreenLock     *bool  `json:"screenLock,omitempty"`
	Encrypted      *bool  `json:"encrypted,omitempty"`
	Firewall       *bool  `json:"firewall,omitempty"`
	Antivirus      *bool  `json:"antivirus,omitempty"`
	SecureBoot     *bool  `json:"secureBoot,omitempty"`
	PendingUpdates *int   `json:"pendingUpdates,omitempty"`
	AgentVersion   string `json:"agentVersion,omitempty"`
}

// Telemetry matches the server's Telemetry shape.
type Telemetry struct {
	BatteryLevel   int     `json:"batteryLevel"`
	BatteryHealth  string  `json:"batteryHealth"`
	BatteryTempC   float64 `json:"batteryTempC"`
	StorageFreeGb  float64 `json:"storageFreeGb"`
	StorageTotalGb float64 `json:"storageTotalGb"`
	Integrity      string  `json:"integrity"`
	PatchLevel     string  `json:"patchLevel"`
	NoBattery      bool    `json:"noBattery,omitempty"`
	Security       Posture `json:"security"`
}

// System is everything OS-specific. Each OS has its own implementation; tests use a fake.
type System interface {
	Platform() string // windows | linux | macos
	Privileged() bool
	Hardware() Hardware
	Telemetry() Telemetry
	Notify(title, text string) error
	Lock() error
	Reboot(message string) error
	InstallService(exe string) error
	RemoveService() error
}

// Agent ties the protocol to the OS.
type Agent struct {
	Dir string
	Cfg *Config
	Sys System
	API *Client
	Now func() time.Time
	Log *log.Logger
}

// EnrolLink is what the console's QR / link carries: mobhunter://enrol?server=…&token=…&pin=…
type EnrolLink struct{ Server, Token, Pin string }

func parseEnrolLink(raw string) (EnrolLink, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "mobhunter" || u.Host != "enrol" {
		return EnrolLink{}, errors.New("not a Mob Hunter enrolment link (mobhunter://enrol?…) — copy it from Add devices → Computer")
	}
	q := u.Query()
	l := EnrolLink{Server: q.Get("server"), Token: q.Get("token"), Pin: strings.ToLower(q.Get("pin"))}
	if l.Server == "" || l.Token == "" || len(l.Pin) != 64 {
		return EnrolLink{}, errors.New("the enrolment link is incomplete")
	}
	if err := checkServerURL(l.Server); err != nil {
		return EnrolLink{}, err
	}
	return l, nil
}

type enrolResponse struct {
	DeviceID        string `json:"deviceId"`
	CertJSON        string `json:"certJson"`
	CertSig         string `json:"certSig"`
	ServerPublicKey string `json:"serverPublicKey"`
	Policy          struct {
		Version int `json:"version"`
	} `json:"policy"`
	Notice struct {
		Version      string   `json:"version"`
		Title        string   `json:"title"`
		Collected    []string `json:"collected"`
		NotCollected []string `json:"notCollected"`
	} `json:"notice"`
}

// Enrol creates the device key, registers with the one-time token and pins the server key.
// accept is asked to confirm the employee notice; it must return true for the device to become active.
func (a *Agent) Enrol(link EnrolLink, accept func(title string, collected, notCollected []string) bool) error {
	if a.Cfg != nil && a.Cfg.DeviceID != "" {
		return fmt.Errorf("this computer is already enrolled as %s (run `uninstall` first)", a.Cfg.DeviceID)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	cfg := &Config{Server: link.Server, Pin: link.Pin, PrivateKey: hex.EncodeToString(priv), Privileged: a.Sys.Privileged()}
	api, err := newClient(cfg)
	if err != nil {
		return err
	}
	mode := "standard"
	if cfg.Privileged {
		mode = "device_owner" // runs as a system service: full set of computer commands, including reboot
	}
	body, _ := json.Marshal(map[string]any{
		"token": link.Token, "devicePublicKey": hex.EncodeToString(pub), "keyAlg": "Ed25519",
		"platform": a.Sys.Platform(), "hardware": a.Sys.Hardware(), "mode": mode,
	})
	raw, err := api.do("POST", "/v1/enroll", body, false)
	if err != nil {
		return fmt.Errorf("enrolment refused: %w", err)
	}
	var res enrolResponse
	if err := json.Unmarshal(raw, &res); err != nil {
		return err
	}
	// Certificate pinning: the server's command key must match the fingerprint in the link.
	if pinOf(res.ServerPublicKey) != link.Pin {
		return errors.New("server key does not match the pinned fingerprint — refusing to enrol")
	}
	cfg.DeviceID, cfg.CertJSON, cfg.CertSig, cfg.ServerPublicKey = res.DeviceID, res.CertJSON, res.CertSig, res.ServerPublicKey
	cfg.NoticeVersion, cfg.PolicyVersion = res.Notice.Version, res.Policy.Version
	cfg.Notice = Notice{Title: res.Notice.Title, Collected: res.Notice.Collected, NotCollected: res.Notice.NotCollected}
	if accept(res.Notice.Title, res.Notice.Collected, res.Notice.NotCollected) {
		cfg.AcknowledgedAt = a.now().UnixMilli()
	}
	a.Cfg, a.API = cfg, api
	if err := saveConfig(a.Dir, cfg); err != nil {
		return err
	}
	_ = a.Sys.Notify("This computer is managed by your organisation", "Your IT team can see its security settings and health, lock it and send messages. They cannot see your files, screen, messages or browsing.")
	return a.Checkin()
}

func (a *Agent) now() time.Time {
	if a.Now != nil {
		return a.Now()
	}
	return time.Now()
}

func (a *Agent) logf(f string, v ...any) {
	if a.Log != nil {
		a.Log.Printf(f, v...)
	}
}

// Checkin reports hardware and telemetry (and the notice acknowledgement once).
func (a *Agent) Checkin() error {
	hw := a.Sys.Hardware()
	t := a.Sys.Telemetry()
	t.Security.AgentVersion = Version
	body := map[string]any{"telemetry": t, "serial": hw.Serial, "model": hw.Model, "os": hw.OS}
	if a.Cfg.AcknowledgedAt > 0 && !a.Cfg.AckSent {
		body["policyAck"] = map[string]any{"version": a.Cfg.NoticeVersion, "at": a.Cfg.AcknowledgedAt}
	}
	var res struct {
		State         string `json:"state"`
		PolicyVersion int    `json:"policyVersion"`
	}
	if err := a.API.call("POST", "/v1/checkin", body, &res); err != nil {
		return err
	}
	if _, ok := body["policyAck"]; ok {
		a.Cfg.AckSent = true
	}
	a.Cfg.PolicyVersion = res.PolicyVersion
	a.logf("checked in: state %s, policy v%d", res.State, res.PolicyVersion)
	return saveConfig(a.Dir, a.Cfg)
}

// Outcome of one command, for logs and tests.
type Outcome struct{ ID, Type, Result string }

// Poll pulls pending commands, verifies each one and runs it. It stops after a RELEASE.
func (a *Agent) Poll() ([]Outcome, error) {
	var envs []Envelope
	if err := a.API.call("GET", "/v1/commands/pending", nil, &envs); err != nil {
		return nil, err
	}
	var out []Outcome
	for _, env := range envs {
		cmd, reason := verify(env, a.Cfg.ServerPublicKey, a.Cfg.DeviceID, a.now(), a.Cfg.seen)
		if reason != "" {
			id := idOf(env)
			// A replay of something already run is skipped silently; anything else is reported.
			if reason != "replayed" && id != "" {
				_ = a.result(id, "rejected", "Agent rejected command: "+reason)
			}
			a.logf("rejected command %s: %s", id, reason)
			out = append(out, Outcome{id, "", "rejected:" + reason})
			continue
		}
		a.Cfg.remember("id:"+cmd.ID, "n:"+cmd.Nonce)
		_ = saveConfig(a.Dir, a.Cfg)
		res := a.execute(cmd)
		out = append(out, Outcome{cmd.ID, cmd.Type, res})
		if cmd.Type == "RELEASE" && res == "succeeded" {
			break
		}
	}
	return out, nil
}

func (a *Agent) result(id, status, detail string) error {
	if len(detail) > 200 {
		detail = detail[:200]
	}
	return a.API.call("POST", "/v1/commands/"+id+"/result", map[string]any{"status": status, "detail": detail}, nil)
}

func str(p map[string]any, k, def string) string {
	if v, ok := p[k].(string); ok && strings.TrimSpace(v) != "" {
		return v
	}
	return def
}

// execute runs one verified command. The set is closed: there is no shell, file access or screen capture.
func (a *Agent) execute(c *Command) string {
	report := func(err error, ok string) string {
		if err != nil {
			_ = a.result(c.ID, "failed", err.Error())
			return "failed"
		}
		_ = a.result(c.ID, "succeeded", ok)
		return "succeeded"
	}
	switch c.Type {
	case "MESSAGE":
		return report(a.Sys.Notify(str(c.Params, "title", "Message from your IT team"), str(c.Params, "text", "")), "Message shown")
	case "LOCK":
		_ = a.Sys.Notify("Your IT team locked this computer", "Sign in again to continue.")
		return report(a.Sys.Lock(), "Computer locked")
	case "SYNC_POLICY":
		var p struct {
			Policy struct {
				Version int `json:"version"`
			} `json:"policy"`
		}
		if err := a.API.call("GET", "/v1/policy", nil, &p); err != nil {
			return report(err, "")
		}
		a.Cfg.PolicyVersion = p.Policy.Version
		_ = saveConfig(a.Dir, a.Cfg)
		return report(nil, fmt.Sprintf("Policy v%d received; phone restrictions do not apply to computers", p.Policy.Version))
	case "REBOOT":
		if !a.Sys.Privileged() {
			_ = a.result(c.ID, "rejected", "Reboot needs the agent to run as a system service")
			return "rejected"
		}
		_ = a.Sys.Notify("Your IT team is restarting this computer", "Save your work: the computer restarts in 1 minute.")
		_ = a.result(c.ID, "succeeded", "Restart scheduled in 1 minute")
		if err := a.Sys.Reboot("Restart requested by your IT team (Mob Hunter)"); err != nil {
			a.logf("reboot failed: %v", err)
		}
		return "succeeded"
	case "RELEASE":
		// Report first: afterwards the agent, its key and its service are gone.
		_ = a.result(c.ID, "succeeded", "Management released; agent service removed and uninstalled")
		org := str(c.Params, "orgName", "Your organisation")
		_ = a.Sys.Notify("This computer is no longer managed", org+" removed this computer from management. Nothing is collected any more.")
		a.Release()
		return "succeeded"
	default:
		// LOCATE, Lost Mode, RING, app installs and WIPE are phone-only; anything else does not exist.
		_ = a.result(c.ID, "rejected", "Unsupported on computers")
		return "rejected:unsupported"
	}
}

// Release removes the service and every local credential (used by RELEASE and `uninstall`).
func (a *Agent) Release() {
	// Credentials first: removing the service may stop this very process.
	a.Cfg = nil
	if err := removeConfig(a.Dir); err != nil {
		a.logf("removing config: %v", err)
	}
	if err := a.Sys.RemoveService(); err != nil {
		a.logf("removing service: %v", err)
	}
}

// Run is the service loop: check in every 15 minutes, pull commands every minute.
func (a *Agent) Run(stop <-chan struct{}) {
	lastCheckin := time.Time{}
	for {
		if a.Cfg == nil {
			return
		}
		if time.Since(lastCheckin) >= 15*time.Minute {
			if err := a.Checkin(); err != nil {
				a.logf("check-in failed: %v", err)
				var ae *APIError
				if errors.As(err, &ae) && ae.Status == 401 && strings.Contains(ae.Message, "revoked") {
					a.logf("certificate revoked: this computer was retired or wiped in the console")
				}
			} else {
				lastCheckin = time.Now()
			}
		}
		if _, err := a.Poll(); err != nil {
			a.logf("command poll failed: %v", err)
		}
		if a.Cfg == nil {
			return
		}
		select {
		case <-stop:
			return
		case <-time.After(time.Minute):
		}
	}
}
