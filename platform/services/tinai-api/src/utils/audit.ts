import { FastifyInstance } from 'fastify'

export interface AuditEventInput {
  tenant_id?: string
  actor?: string
  action: string
  resource: string
  resource_id?: string | null
  ip_address?: string | null
  region?: string
  metadata?: Record<string, unknown>
}

/**
 * Write a single audit event to the audit_events table.
 * Failures are logged but never propagate — the main request always succeeds.
 */
export async function writeAuditEvent(
  app: FastifyInstance,
  event: AuditEventInput,
): Promise<void> {
  try {
    await app.pg.query(
      `INSERT INTO audit_events
         (tenant_id, actor, action, resource, resource_id, ip_address, region, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        event.tenant_id ?? 'tinai-admin',
        event.actor ?? 'system',
        event.action,
        event.resource,
        event.resource_id ?? null,
        event.ip_address ?? null,
        event.region ?? 'IN',
        JSON.stringify(event.metadata ?? {}),
      ],
    )
  } catch (err) {
    app.log.error({ err, event }, 'audit write failed — non-fatal')
  }
}
