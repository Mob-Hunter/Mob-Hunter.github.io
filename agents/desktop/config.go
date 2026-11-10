package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// Config is everything the agent keeps on disk. The private key never leaves this file,
// which is readable by root / SYSTEM only when the agent runs as a service.
type Config struct {
	Server          string   `json:"server"`
	Pin             string   `json:"pin"`
	DeviceID        string   `json:"deviceId"`
	CertJSON        string   `json:"certJson"`
	CertSig         string   `json:"certSig"`
	PrivateKey      string   `json:"privateKey"` // Ed25519 seed+public (hex)
	ServerPublicKey string   `json:"serverPublicKey"`
	NoticeVersion   string   `json:"noticeVersion"`
	AcknowledgedAt  int64    `json:"acknowledgedAt"`
	AckSent         bool     `json:"ackSent"`
	PolicyVersion   int      `json:"policyVersion"`
	Seen            []string `json:"seen"`
	Privileged      bool     `json:"privileged"`
	Notice          Notice   `json:"notice"`
}

// Notice is the employee notice text returned at enrolment (kept so it can be shown again).
type Notice struct {
	Title        string   `json:"title"`
	Collected    []string `json:"collected"`
	NotCollected []string `json:"notCollected"`
}

func configPath(dir string) string { return filepath.Join(dir, "agent.json") }

func loadConfig(dir string) (*Config, error) {
	b, err := os.ReadFile(configPath(dir))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

func saveConfig(dir string, c *Config) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := configPath(dir) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, configPath(dir))
}

// remember records a command id / nonce so a replay is never executed twice (bounded list).
func (c *Config) remember(keys ...string) {
	c.Seen = append(c.Seen, keys...)
	if len(c.Seen) > 1000 {
		c.Seen = c.Seen[len(c.Seen)-1000:]
	}
}

func (c *Config) seen(key string) bool {
	for _, s := range c.Seen {
		if s == key {
			return true
		}
	}
	return false
}

func removeConfig(dir string) error {
	err := os.Remove(configPath(dir))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	_ = os.Remove(dir) // only if empty
	return nil
}
