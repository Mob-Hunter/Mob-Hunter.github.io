package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// APIError is a non-2xx answer from the server.
type APIError struct {
	Status  int
	Code    string
	Message string
}

func (e *APIError) Error() string { return fmt.Sprintf("%s (%d %s)", e.Message, e.Status, e.Code) }

// Client speaks the Mob Hunter device protocol: every request is signed with the device key over
// METHOD \n PATH \n TS \n NONCE \n SHA-256(body), alongside the CA-signed device certificate.
type Client struct {
	Base string
	HTTP *http.Client
	cfg  *Config
	key  ed25519.PrivateKey
	now  func() time.Time
}

func checkServerURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return fmt.Errorf("invalid server URL %q", raw)
	}
	host := u.Hostname()
	if u.Scheme != "https" && host != "127.0.0.1" && host != "localhost" {
		return fmt.Errorf("refusing non-HTTPS server %q", raw)
	}
	return nil
}

func newClient(cfg *Config) (*Client, error) {
	if err := checkServerURL(cfg.Server); err != nil {
		return nil, err
	}
	c := &Client{Base: strings.TrimRight(cfg.Server, "/"), HTTP: &http.Client{Timeout: 45 * time.Second}, cfg: cfg, now: time.Now}
	if cfg.PrivateKey != "" {
		k, err := hex.DecodeString(cfg.PrivateKey)
		if err != nil || len(k) != ed25519.PrivateKeySize {
			return nil, fmt.Errorf("corrupt device key")
		}
		c.key = ed25519.PrivateKey(k)
	}
	return c, nil
}

func (c *Client) do(method, path string, body []byte, signed bool) ([]byte, error) {
	req, err := http.NewRequest(method, c.Base+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "MobHunterDesktopAgent/"+Version)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if signed {
		ts := strconv.FormatInt(c.now().UnixMilli(), 10)
		nb := make([]byte, 12)
		if _, err := rand.Read(nb); err != nil {
			return nil, err
		}
		nonce := hex.EncodeToString(nb)
		sum := sha256.Sum256(body)
		bodyHash := hex.EncodeToString(sum[:])
		msg := method + "\n" + path + "\n" + ts + "\n" + nonce + "\n" + bodyHash
		req.Header.Set("X-MH-Device", c.cfg.DeviceID)
		req.Header.Set("X-MH-Cert", base64.StdEncoding.EncodeToString([]byte(c.cfg.CertJSON)))
		req.Header.Set("X-MH-Cert-Sig", c.cfg.CertSig)
		req.Header.Set("X-MH-Ts", ts)
		req.Header.Set("X-MH-Nonce", nonce)
		req.Header.Set("X-MH-Body-Sha256", bodyHash)
		req.Header.Set("X-MH-Sig", hex.EncodeToString(ed25519.Sign(c.key, []byte(msg))))
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	out, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		var e struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(out, &e)
		if e.Message == "" {
			e.Message = "HTTP " + strconv.Itoa(res.StatusCode)
		}
		return nil, &APIError{Status: res.StatusCode, Code: e.Error, Message: e.Message}
	}
	return out, nil
}

func (c *Client) call(method, path string, in any, out any) error {
	var body []byte
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = b
	}
	res, err := c.do(method, path, body, true)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(res, out)
}
