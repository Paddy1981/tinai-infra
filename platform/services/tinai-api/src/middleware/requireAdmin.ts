import { FastifyRequest, FastifyReply } from 'fastify'

/**
 * Admin RBAC guard.
 *
 * Reads `(req as any).role` which is populated by the JWT auth preHandler in
 * server.ts from the `role` claim in the JWT payload.
 *
 * Usage — pass as a preHandler on any route that requires admin access:
 *
 *   app.get('/admin/something', { preHandler: requireAdmin }, async (req, reply) => { ... })
 *
 *   // Or on a whole plugin:
 *   app.register(async (sub) => {
 *     sub.addHook('preHandler', requireAdmin)
 *     sub.get('/resource', handler)
 *   })
 */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const role = (req as any).role as string | undefined
  if (role !== 'admin') {
    return reply.status(403).send({
      error: 'Forbidden',
      message: 'Admin access required',
    })
  }
}
