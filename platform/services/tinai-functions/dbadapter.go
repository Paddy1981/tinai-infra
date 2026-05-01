package main

import (
	"context"

	"github.com/tinai/tinai-functions/internal/api"
	"github.com/tinai/tinai-functions/internal/db"
)

// dbAdapter wraps *db.DB and satisfies the api.FunctionDB interface by
// converting []db.Function → []api.FunctionRecord.
type dbAdapter struct{ inner *db.DB }

func (a *dbAdapter) UpsertFunction(ctx context.Context, tenant, name, runtime string, sizeBytes int) error {
	return a.inner.UpsertFunction(ctx, tenant, name, runtime, sizeBytes)
}

func (a *dbAdapter) GetFunction(ctx context.Context, tenant, name string) (api.FunctionRecord, error) {
	f, err := a.inner.GetFunction(ctx, tenant, name)
	if err != nil {
		return api.FunctionRecord{}, err
	}
	return api.FunctionRecord{
		ID:        f.ID,
		Tenant:    f.Tenant,
		Name:      f.Name,
		Runtime:   f.Runtime,
		SizeBytes: f.SizeBytes,
		CreatedAt: f.CreatedAt,
		UpdatedAt: f.UpdatedAt,
	}, nil
}

func (a *dbAdapter) ListFunctions(ctx context.Context, tenant string) ([]api.FunctionRecord, error) {
	fns, err := a.inner.ListFunctions(ctx, tenant)
	if err != nil {
		return nil, err
	}
	out := make([]api.FunctionRecord, len(fns))
	for i, f := range fns {
		out[i] = api.FunctionRecord{
			ID:        f.ID,
			Tenant:    f.Tenant,
			Name:      f.Name,
			Runtime:   f.Runtime,
			SizeBytes: f.SizeBytes,
			CreatedAt: f.CreatedAt,
			UpdatedAt: f.UpdatedAt,
		}
	}
	return out, nil
}

func (a *dbAdapter) DeleteFunction(ctx context.Context, tenant, name string) error {
	return a.inner.DeleteFunction(ctx, tenant, name)
}
