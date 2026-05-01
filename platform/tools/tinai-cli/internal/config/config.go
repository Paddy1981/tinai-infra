package config

import (
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

type Config struct {
	APIURL string `yaml:"api_url"`
}

type Credentials struct {
	Token string `yaml:"token"`
}

func Load() (*Config, error) {
	cfg := &Config{APIURL: "https://api.tinai.cloud"}
	home, err := os.UserHomeDir()
	if err != nil {
		return cfg, nil
	}
	data, err := os.ReadFile(filepath.Join(home, ".tinai", "config.yaml"))
	if err != nil {
		return cfg, nil
	}
	yaml.Unmarshal(data, cfg)
	return cfg, nil
}

func LoadCredentials() (*Credentials, error) {
	cred := &Credentials{}
	home, err := os.UserHomeDir()
	if err != nil {
		return cred, nil
	}
	data, err := os.ReadFile(filepath.Join(home, ".tinai", "credentials.yaml"))
	if err != nil {
		return cred, nil
	}
	yaml.Unmarshal(data, cred)
	return cred, nil
}
