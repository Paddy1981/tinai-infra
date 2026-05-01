package store

import (
	"bytes"
	"context"
	"fmt"
	"io"

	"github.com/minio/minio-go/v7"
)

const bucket = "tinai-functions"

// Client wraps a MinIO client for function code storage.
type Client struct {
	mc *minio.Client
}

// New returns a new store Client.
func New(mc *minio.Client) *Client {
	return &Client{mc: mc}
}

// objectKey returns the canonical MinIO object key for a function.
func objectKey(tenant, name string) string {
	return fmt.Sprintf("%s/%s/index.js", tenant, name)
}

// ensureBucket creates the bucket if it does not already exist.
func (c *Client) ensureBucket(ctx context.Context) error {
	exists, err := c.mc.BucketExists(ctx, bucket)
	if err != nil {
		return fmt.Errorf("bucket check: %w", err)
	}
	if exists {
		return nil
	}
	if err := c.mc.MakeBucket(ctx, bucket, minio.MakeBucketOptions{}); err != nil {
		// Race-safe: ignore "already exists"
		exists2, _ := c.mc.BucketExists(ctx, bucket)
		if !exists2 {
			return fmt.Errorf("make bucket: %w", err)
		}
	}
	return nil
}

// PutFunction uploads function source code to MinIO.
// Path: tinai-functions/{tenant}/{name}/index.js
func (c *Client) PutFunction(ctx context.Context, tenant, name, code string) error {
	if err := c.ensureBucket(ctx); err != nil {
		return err
	}
	data := []byte(code)
	_, err := c.mc.PutObject(ctx, bucket, objectKey(tenant, name),
		bytes.NewReader(data), int64(len(data)),
		minio.PutObjectOptions{ContentType: "application/javascript"},
	)
	if err != nil {
		return fmt.Errorf("put object: %w", err)
	}
	return nil
}

// GetFunction downloads and returns the source code for a function.
func (c *Client) GetFunction(ctx context.Context, tenant, name string) (string, error) {
	obj, err := c.mc.GetObject(ctx, bucket, objectKey(tenant, name), minio.GetObjectOptions{})
	if err != nil {
		return "", fmt.Errorf("get object: %w", err)
	}
	defer obj.Close()

	buf, err := io.ReadAll(obj)
	if err != nil {
		return "", fmt.Errorf("read object: %w", err)
	}
	return string(buf), nil
}

// DeleteFunction removes the function code object from MinIO.
func (c *Client) DeleteFunction(ctx context.Context, tenant, name string) error {
	err := c.mc.RemoveObject(ctx, bucket, objectKey(tenant, name), minio.RemoveObjectOptions{})
	if err != nil {
		return fmt.Errorf("remove object: %w", err)
	}
	return nil
}
