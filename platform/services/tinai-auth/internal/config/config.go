package config

import (
	"log"
	"os"
	"strconv"
)

type Config struct {
	Port         string
	DatabaseURL  string
	RedisURL     string
	JWTSecret    string
	JWTExpirySec int64
	AppName      string
	DevMode      bool

	// SMTP settings
	SMTPHost     string
	SMTPPort     int
	SMTPUser     string
	SMTPPass     string
	SMTPFromName string
	SMTPFromAddr string
}

func Load() Config {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatalf("DATABASE_URL environment variable is required")
	}

	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" {
		log.Fatalf("JWT_SECRET environment variable is required")
	}

	return Config{
		Port:         getEnv("PORT", "3002"),
		DatabaseURL:  databaseURL,
		RedisURL:     getEnv("REDIS_URL", ""),
		JWTSecret:    jwtSecret,
		JWTExpirySec: 7 * 24 * 3600,
		AppName:      getEnv("APP_NAME", "Tinai Cloud"),
		DevMode:      getEnv("NODE_ENV", "production") == "development",

		SMTPHost:     getEnv("SMTP_HOST", "stalwart.core.svc.cluster.local"),
		SMTPPort:     getEnvInt("SMTP_PORT", 587),
		SMTPUser:     getEnv("SMTP_USER", "admin"),
		SMTPPass:     getEnv("SMTP_PASS", ""),
		SMTPFromName: getEnv("SMTP_FROM_NAME", "Tinai Platform"),
		SMTPFromAddr: getEnv("SMTP_FROM_ADDR", "noreply@tinai.cloud"),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			return i
		}
	}
	return fallback
}
