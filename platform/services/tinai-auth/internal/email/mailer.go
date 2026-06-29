package email

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/smtp"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// MailJob represents a single email to be sent.
type MailJob struct {
	To      string `json:"to"`
	Subject string `json:"subject"`
	Body    string `json:"body"`
}

// Mailer handles sending emails via SMTP, with support for Redis queuing.
type Mailer struct {
	Host     string
	Port     int
	User     string
	Password string
	FromName string
	FromAddr string
	Redis    *redis.Client
}

// NewMailer creates a new Mailer instance.
func NewMailer(host string, port int, user, password, fromName, fromAddr string, rdb *redis.Client) *Mailer {
	return &Mailer{
		Host:     host,
		Port:     port,
		User:     user,
		Password: password,
		FromName: fromName,
		FromAddr: fromAddr,
		Redis:    rdb,
	}
}

// Queue pushes the email job into a Redis list (the queue).
func (m *Mailer) Queue(ctx context.Context, to, subject, body string) error {
	if m.Redis == nil {
		// Fallback to direct background send if Redis is not available.
		go func() {
			if err := m.Send(to, subject, body); err != nil {
				log.Printf("mailer: background send error: %v", err)
			}
		}()
		return nil
	}
	job := MailJob{To: to, Subject: subject, Body: body}
	data, _ := json.Marshal(job)
	return m.Redis.LPush(ctx, "mail_queue", data).Err()
}

// StartWorker starts a background worker that processes jobs from the Redis queue.
func (m *Mailer) StartWorker(ctx context.Context) {
	if m.Redis == nil {
		return
	}
	log.Println("mailer: starting background worker")
	for {
		select {
		case <-ctx.Done():
			return
		default:
			// Block until a job is available in the queue.
			res, err := m.Redis.BRPop(ctx, 0, "mail_queue").Result()
			if err != nil {
				if err == context.Canceled {
					return
				}
				log.Printf("mailer: worker queue error: %v", err)
				time.Sleep(5 * time.Second)
				continue
			}
			var job MailJob
			if err := json.Unmarshal([]byte(res[1]), &job); err != nil {
				log.Printf("mailer: worker unmarshal error: %v", err)
				continue
			}
			// Attempt to send the email with a simple retry strategy.
			for i := 0; i < 3; i++ {
				if err := m.Send(job.To, job.Subject, job.Body); err != nil {
					log.Printf("mailer: worker send error (attempt %d): %v", i+1, err)
					time.Sleep(time.Duration(i+1) * 2 * time.Second)
					continue
				}
				break
			}
		}
	}
}

// Send performs the actual SMTP delivery.
func (m *Mailer) Send(to, subject, body string) error {
	if m.Host == "" {
		return fmt.Errorf("SMTP host not configured")
	}

	auth := smtp.PlainAuth("", m.User, m.Password, m.Host)
	addr := fmt.Sprintf("%s:%d", m.Host, m.Port)

	// RFC 822 message format
	header := make(map[string]string)
	header["From"] = fmt.Sprintf("\"%s\" <%s>", m.FromName, m.FromAddr)
	header["To"] = to
	header["Subject"] = subject
	header["MIME-Version"] = "1.0"
	header["Content-Type"] = "text/plain; charset=\"utf-8\""

	var message strings.Builder
	for k, v := range header {
		message.WriteString(fmt.Sprintf("%s: %s\r\n", k, v))
	}
	message.WriteString("\r\n")
	message.WriteString(body)

	err := smtp.SendMail(addr, auth, m.FromAddr, []string{to}, []byte(message.String()))
	if err != nil {
		return fmt.Errorf("send mail: %w", err)
	}

	return nil
}

// SendMagicLink queues a magic link OTP to the user.
func (m *Mailer) SendMagicLink(ctx context.Context, to, otp, appName string) error {
	subject := fmt.Sprintf("%s — Your Magic Link", appName)
	body := fmt.Sprintf("Hello,\n\nYour magic link code is: %s\n\nThis code will expire in 15 minutes. If you did not request this, please ignore this email.\n\nThanks,\nThe %s Team", otp, appName)
	return m.Queue(ctx, to, subject, body)
}

// SendVerificationEmail queues an email-verification link to the user.
func (m *Mailer) SendVerificationEmail(ctx context.Context, to, link, appName string) error {
	subject := fmt.Sprintf("%s — Verify your email", appName)
	body := fmt.Sprintf("Hello,\n\nPlease confirm your email address by opening the link below:\n\n%s\n\nThis link expires in 24 hours. If you did not create an account, you can ignore this email.\n\nThanks,\nThe %s Team", link, appName)
	return m.Queue(ctx, to, subject, body)
}

// SendPasswordReset queues a password-reset link to the user.
func (m *Mailer) SendPasswordReset(ctx context.Context, to, link, appName string) error {
	subject := fmt.Sprintf("%s — Reset your password", appName)
	body := fmt.Sprintf("Hello,\n\nWe received a request to reset your password. Open the link below to choose a new one:\n\n%s\n\nThis link expires in 1 hour. If you did not request this, you can safely ignore this email and your password will stay the same.\n\nThanks,\nThe %s Team", link, appName)
	return m.Queue(ctx, to, subject, body)
}
