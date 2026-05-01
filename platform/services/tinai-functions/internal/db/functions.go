package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Function represents a deployed serverless function record.
type Function struct {
	ID        string    `json:"id"`
	Tenant    string    `json:"tenant"`
	Name      string    `json:"name"`
	Runtime   string    `json:"runtime"`
	SizeBytes int       `json:"size_bytes"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// DB holds a database/sql pool and exposes typed query methods.
type DB struct {
	pool *sql.DB
}

// New wraps an existing *sql.DB.
func New(pool *sql.DB) *DB {
	return &DB{pool: pool}
}

// Migrate creates the functions table if it does not exist.
func (d *DB) Migrate(ctx context.Context) error {
	const ddl = `
CREATE TABLE IF NOT EXISTS functions (
	id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	tenant     VARCHAR NOT NULL,
	name       VARCHAR NOT NULL,
	runtime    VARCHAR NOT NULL DEFAULT 'node20',
	size_bytes INT     NOT NULL DEFAULT 0,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	UNIQUE(tenant, name)
);`
	if _, err := d.pool.ExecContext(ctx, ddl); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	return nil
}

// UpsertFunction inserts or updates a function record.
// On conflict (tenant, name) the runtime, size_bytes and updated_at are refreshed.
func (d *DB) UpsertFunction(ctx context.Context, tenant, name, runtime string, sizeBytes int) error {
	const q = `
INSERT INTO functions (tenant, name, runtime, size_bytes)
VALUES ($1, $2, $3, $4)
ON CONFLICT (tenant, name) DO UPDATE
  SET runtime    = EXCLUDED.runtime,
      size_bytes = EXCLUDED.size_bytes,
      updated_at = NOW();`
	if _, err := d.pool.ExecContext(ctx, q, tenant, name, runtime, sizeBytes); err != nil {
		return fmt.Errorf("upsert function: %w", err)
	}
	return nil
}

// ListFunctions returns all functions belonging to the given tenant.
func (d *DB) ListFunctions(ctx context.Context, tenant string) ([]Function, error) {
	const q = `
SELECT id, tenant, name, runtime, size_bytes, created_at, updated_at
FROM functions
WHERE tenant = $1
ORDER BY name;`

	rows, err := d.pool.QueryContext(ctx, q, tenant)
	if err != nil {
		return nil, fmt.Errorf("list functions: %w", err)
	}
	defer rows.Close()

	var fns []Function
	for rows.Next() {
		var f Function
		if err := rows.Scan(&f.ID, &f.Tenant, &f.Name, &f.Runtime, &f.SizeBytes, &f.CreatedAt, &f.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan function: %w", err)
		}
		fns = append(fns, f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows error: %w", err)
	}
	return fns, nil
}

// GetFunction returns a single function record by (tenant, name).
// Returns sql.ErrNoRows if the function does not exist.
func (d *DB) GetFunction(ctx context.Context, tenant, name string) (Function, error) {
	const q = `
SELECT id, tenant, name, runtime, size_bytes, created_at, updated_at
FROM functions
WHERE tenant = $1 AND name = $2;`
	var f Function
	err := d.pool.QueryRowContext(ctx, q, tenant, name).Scan(
		&f.ID, &f.Tenant, &f.Name, &f.Runtime, &f.SizeBytes, &f.CreatedAt, &f.UpdatedAt,
	)
	if err != nil {
		return Function{}, err
	}
	return f, nil
}

// DeleteFunction removes a function record by (tenant, name).
// Returns sql.ErrNoRows if the function does not exist.
func (d *DB) DeleteFunction(ctx context.Context, tenant, name string) error {
	const q = `DELETE FROM functions WHERE tenant = $1 AND name = $2;`
	res, err := d.pool.ExecContext(ctx, q, tenant, name)
	if err != nil {
		return fmt.Errorf("delete function: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return sql.ErrNoRows
	}
	return nil
}
