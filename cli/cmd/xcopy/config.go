package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
)

const defaultServer = "https://xcopy.werfamily.fun"
const maxFile = 50 * 1024 * 1024
const maxText = 1024 * 1024

type Config struct {
	Server     string `json:"server"`
	Name       string `json:"name"`
	ReceiveDir string `json:"receiveDir"`
}

type Paths struct{ Config, Data, Socket string }

func paths(profile string) (Paths, error) {
	if !regexp.MustCompile(`^[a-zA-Z0-9_-]{1,32}$`).MatchString(profile) {
		return Paths{}, fmt.Errorf("profile 只允许 1–32 个字母、数字、下划线或短横线")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return Paths{}, err
	}
	conf := os.Getenv("XDG_CONFIG_HOME")
	if conf == "" {
		conf = filepath.Join(home, ".config")
	}
	data := os.Getenv("XDG_DATA_HOME")
	if data == "" {
		data = filepath.Join(home, ".local/share")
	}
	if root := os.Getenv("XCOPY_HOME"); root != "" {
		conf, data = filepath.Join(root, "config"), filepath.Join(root, "data")
	}
	conf, err = filepath.Abs(filepath.Join(conf, "xcopy", profile))
	if err != nil {
		return Paths{}, err
	}
	data, err = filepath.Abs(filepath.Join(data, "xcopy", profile))
	if err != nil {
		return Paths{}, err
	}
	digest := sha256.Sum256([]byte(conf))
	runtime := os.Getenv("XDG_RUNTIME_DIR")
	if runtime == "" {
		runtime = os.TempDir()
	}
	sock := filepath.Join(runtime, fmt.Sprintf("xcopy-%d", os.Getuid()), hex.EncodeToString(digest[:8])+".sock")
	return Paths{conf, data, sock}, nil
}

func privateDir(path string) error {
	if err := receiveDir(path); err != nil {
		return err
	}
	return os.Chmod(path, 0700)
}

// Existing receive directories may be shared with other users or services.
func receiveDir(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("目录不能是符号链接: %s", path)
	}
	return nil
}

func atomicJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".xcopy-write-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(append(data, '\n')); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), path)
}

func loadConfig(p Paths) (Config, error) {
	var c Config
	data, err := os.ReadFile(filepath.Join(p.Config, "config.json"))
	if err != nil {
		return c, fmt.Errorf("请先运行 xcopy init: %w", err)
	}
	err = json.Unmarshal(data, &c)
	return c, err
}

func validateServer(server string) (string, error) {
	u, err := url.Parse(strings.TrimRight(server, "/"))
	if err != nil {
		return "", err
	}
	local := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && !(local && u.Scheme == "http")) {
		return "", fmt.Errorf("server 必须是 HTTPS origin，仅 localhost 允许 HTTP")
	}
	return u.String(), nil
}

func initConfig(p Paths, server, name, receive string) (Config, error) {
	c := Config{}
	var err error
	c.Server, err = validateServer(server)
	if err != nil {
		return c, err
	}
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 24 || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return c, fmt.Errorf("设备名称需要 1–24 个可见字符")
	}
	c.Name = name
	c.ReceiveDir, err = filepath.Abs(receive)
	if err != nil {
		return c, err
	}
	for _, dir := range []string{p.Config, p.Data} {
		if err := privateDir(dir); err != nil {
			return c, err
		}
	}
	if err := receiveDir(c.ReceiveDir); err != nil {
		return c, err
	}
	if old, err := loadConfig(p); err == nil && old.Server != c.Server {
		return c, fmt.Errorf("此 profile 已绑定 %s，请用 --profile 新名称隔离另一台服务器", old.Server)
	}
	if _, err := identity(p); err != nil {
		return c, err
	}
	return c, atomicJSON(filepath.Join(p.Config, "config.json"), c)
}

func identity(p Paths) (*ecdsa.PrivateKey, error) {
	path := filepath.Join(p.Config, "identity.pem")
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return nil, err
		}
		der, err := x509.MarshalECPrivateKey(key)
		if err != nil {
			return nil, err
		}
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return nil, err
		}
		err = pem.Encode(f, &pem.Block{Type: "EC PRIVATE KEY", Bytes: der})
		if err == nil {
			err = f.Sync()
		}
		closeErr := f.Close()
		if err != nil {
			return nil, err
		}
		if closeErr != nil {
			return nil, closeErr
		}
		return key, nil
	}
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, fmt.Errorf("设备私钥无效，未自动覆盖")
	}
	key, err := x509.ParseECPrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	if key.Curve != elliptic.P256() {
		return nil, fmt.Errorf("设备私钥必须为 P-256")
	}
	return key, os.Chmod(path, 0600)
}

func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func defaultDeviceName(hostname, system string) string {
	name := strings.TrimSpace(hostname)
	if name != "" && strings.IndexFunc(name, unicode.IsControl) < 0 {
		if len([]rune(name)) > 24 {
			name = string([]rune(name)[:24])
		}
		return name
	}
	prefix := map[string]string{"linux": "Linux", "darwin": "macOS", "windows": "Windows"}[system]
	if prefix == "" {
		prefix = "Device"
	}
	return prefix + "-" + strings.ToUpper(newID()[:4])
}

func safeName(name string) string {
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.In(r, unicode.Cf) || strings.ContainsRune(`/\\:*?"<>|`, r) {
			return '_'
		}
		return r
	}, name)
	name = strings.Trim(name, " .")
	for len(name) > 160 {
		name = string([]rune(name)[:len([]rune(name))-1])
	}
	if name == "" {
		name = "received-file"
	}
	return name
}
