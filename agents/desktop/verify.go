package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"
)

const (
	maxTTL    = 10 * time.Minute
	clockSkew = 2 * time.Minute
)

// Envelope is a signed command as delivered by GET /v1/commands/pending.
type Envelope struct {
	Signed  string          `json:"signed"`
	Sig     string          `json:"sig"`
	Kid     string          `json:"kid"`
	Payload json.RawMessage `json:"payload"`
}

// Command is the verified payload.
type Command struct {
	V         int            `json:"v"`
	ID        string         `json:"id"`
	DeviceID  string         `json:"deviceId"`
	Type      string         `json:"type"`
	Params    map[string]any `json:"params"`
	Nonce     string         `json:"nonce"`
	IssuedAt  int64          `json:"issuedAt"`
	ExpiresAt int64          `json:"expiresAt"`
	Ticket    string         `json:"ticket"`
}

// pinOf is the SHA-256 fingerprint of the server's command-signing key (hex), as carried in the enrolment link.
func pinOf(publicKeyHex string) string {
	b, err := hex.DecodeString(publicKeyHex)
	if err != nil {
		return ""
	}
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// verify applies the same rules as the Android agent: Ed25519 signature by the pinned server key over the
// exact signed string, this device, unexpired, at most 10 minutes of validity, never seen before.
func verify(env Envelope, serverPublicKeyHex, deviceID string, now time.Time, seen func(string) bool) (*Command, string) {
	if env.Signed == "" || env.Sig == "" {
		return nil, "malformed"
	}
	pub, err := hex.DecodeString(serverPublicKeyHex)
	sig, err2 := hex.DecodeString(env.Sig)
	if err != nil || err2 != nil || len(pub) != ed25519.PublicKeySize {
		return nil, "malformed"
	}
	if !ed25519.Verify(ed25519.PublicKey(pub), []byte(env.Signed), sig) {
		return nil, "bad_signature"
	}
	var c Command
	if err := json.Unmarshal([]byte(env.Signed), &c); err != nil || c.V != 1 {
		return nil, "malformed"
	}
	if c.ID == "" || len(c.Nonce) < 8 {
		return nil, "malformed"
	}
	if c.DeviceID != deviceID {
		return &c, "wrong_device"
	}
	if c.ExpiresAt <= c.IssuedAt || time.Duration(c.ExpiresAt-c.IssuedAt)*time.Millisecond > maxTTL {
		return &c, "malformed"
	}
	t := now.UnixMilli()
	if t > c.ExpiresAt {
		return &c, "expired"
	}
	if c.IssuedAt > t+clockSkew.Milliseconds() {
		return &c, "not_yet_valid"
	}
	if seen("id:"+c.ID) || seen("n:"+c.Nonce) {
		return &c, "replayed"
	}
	return &c, ""
}

// idOf extracts the command id from an envelope that failed verification, so the rejection can be reported.
func idOf(env Envelope) string {
	var p struct {
		ID string `json:"id"`
	}
	if json.Unmarshal([]byte(env.Signed), &p) == nil && p.ID != "" {
		return p.ID
	}
	if json.Unmarshal(env.Payload, &p) == nil {
		return p.ID
	}
	return ""
}
