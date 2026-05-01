/*
 * Teams routes — team CRUD, members, invitations, role management
 *
 * Brings Tinai to parity with Vercel teams, Supabase organizations, Railway teams.
 *
 * Requires: 018_teams_and_members.sql
 */

import { FastifyInstance } from 'fastify'
import { randomBytes } from 'crypto'

export async function teamsRoutes(app: FastifyInstance) {

  // -------------------------------------------------------------------------
  // List user's teams
  // -------------------------------------------------------------------------
  app.get('/teams', async (req) => {
    const userId = (req as any).userId
    const { rows } = await app.pg.query(
      `SELECT t.id, t.name, t.slug, t.avatar_url, tm.role, t.created_at
         FROM teams t
         JOIN team_members tm ON tm.team_id = t.id
        WHERE tm.user_id = $1
        ORDER BY t.name`,
      [userId],
    )
    return rows
  })

  // -------------------------------------------------------------------------
  // Create team
  // -------------------------------------------------------------------------
  app.post<{ Body: { name: string; slug: string } }>(
    '/teams',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'slug'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            slug: { type: 'string', minLength: 1, maxLength: 63, pattern: '^[a-z0-9-]+$' },
          },
        },
      },
    },
    async (req, reply) => {
      const userId = (req as any).userId
      const { name, slug } = req.body

      const client = await app.pg.connect()
      try {
        await client.query('BEGIN')

        const { rows } = await client.query(
          `INSERT INTO teams (name, slug, owner_id) VALUES ($1, $2, $3) RETURNING id, name, slug, created_at`,
          [name, slug, userId],
        )
        const team = rows[0]

        // Add creator as owner
        await client.query(
          `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')`,
          [team.id, userId],
        )

        // Audit log
        await client.query(
          `INSERT INTO audit_log (tenant_id, actor_id, action, resource, metadata)
           VALUES ($1, $2, 'team.create', $3, $4)`,
          [(req as any).tenantId, userId, `team:${slug}`, JSON.stringify({ team_id: team.id })],
        )

        await client.query('COMMIT')
        return reply.status(201).send(team)
      } catch (e: any) {
        await client.query('ROLLBACK')
        if (e.code === '23505') return reply.status(409).send({ error: 'Team slug already taken' })
        throw e
      } finally {
        client.release()
      }
    },
  )

  // -------------------------------------------------------------------------
  // Get team details
  // -------------------------------------------------------------------------
  app.get<{ Params: { slug: string } }>('/teams/:slug', async (req, reply) => {
    const userId = (req as any).userId
    const { rows } = await app.pg.query(
      `SELECT t.*, tm.role AS my_role,
              (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) AS member_count
         FROM teams t
         JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = $2
        WHERE t.slug = $1`,
      [req.params.slug, userId],
    )
    if (!rows.length) return reply.status(404).send({ error: 'Team not found' })
    return rows[0]
  })

  // -------------------------------------------------------------------------
  // List team members
  // -------------------------------------------------------------------------
  app.get<{ Params: { slug: string } }>('/teams/:slug/members', async (req, reply) => {
    const userId = (req as any).userId

    // Verify user is a member
    const { rows: team } = await app.pg.query(
      `SELECT t.id FROM teams t JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = $2 WHERE t.slug = $1`,
      [req.params.slug, userId],
    )
    if (!team.length) return reply.status(404).send({ error: 'Team not found' })

    const { rows } = await app.pg.query(
      `SELECT u.id, u.email, u.display_name, tm.role, tm.joined_at
         FROM team_members tm
         JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id = $1
        ORDER BY tm.role, u.email`,
      [team[0].id],
    )
    return rows
  })

  // -------------------------------------------------------------------------
  // Update member role (owner/admin only)
  // -------------------------------------------------------------------------
  app.put<{ Params: { slug: string; memberId: string }; Body: { role: string } }>(
    '/teams/:slug/members/:memberId',
    {
      schema: {
        body: {
          type: 'object',
          required: ['role'],
          properties: {
            role: { type: 'string', enum: ['admin', 'member', 'viewer', 'billing'] },
          },
        },
      },
    },
    async (req, reply) => {
      const userId = (req as any).userId
      const { slug, memberId } = req.params
      const { role } = req.body

      // Verify caller is owner or admin
      const { rows: callerCheck } = await app.pg.query(
        `SELECT tm.role FROM teams t JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = $2 WHERE t.slug = $1`,
        [slug, userId],
      )
      if (!callerCheck.length) return reply.status(404).send({ error: 'Team not found' })
      if (!['owner', 'admin'].includes(callerCheck[0].role))
        return reply.status(403).send({ error: 'Only owners and admins can change roles' })

      // Cannot change owner role via this endpoint
      const { rows: target } = await app.pg.query(
        `SELECT role FROM team_members WHERE user_id = $1 AND team_id = (SELECT id FROM teams WHERE slug = $2)`,
        [memberId, slug],
      )
      if (!target.length) return reply.status(404).send({ error: 'Member not found' })
      if (target[0].role === 'owner') return reply.status(400).send({ error: 'Cannot change owner role' })

      await app.pg.query(
        `UPDATE team_members SET role = $1 WHERE user_id = $2 AND team_id = (SELECT id FROM teams WHERE slug = $3)`,
        [role, memberId, slug],
      )

      return { ok: true }
    },
  )

  // -------------------------------------------------------------------------
  // Invite member
  // -------------------------------------------------------------------------
  app.post<{ Params: { slug: string }; Body: { email: string; role?: string } }>(
    '/teams/:slug/invitations',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email' },
            role:  { type: 'string', enum: ['admin', 'member', 'viewer', 'billing'], default: 'member' },
          },
        },
      },
    },
    async (req, reply) => {
      const userId = (req as any).userId
      const { email, role = 'member' } = req.body

      // Verify caller is owner/admin
      const { rows: team } = await app.pg.query(
        `SELECT t.id FROM teams t JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = $2
         WHERE t.slug = $1 AND tm.role IN ('owner', 'admin')`,
        [req.params.slug, userId],
      )
      if (!team.length) return reply.status(403).send({ error: 'Not authorized to invite' })

      const token = randomBytes(32).toString('hex')

      const { rows } = await app.pg.query(
        `INSERT INTO team_invitations (team_id, email, role, token, invited_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, email, role, expires_at`,
        [team[0].id, email, role, token, userId],
      )

      // TODO: Send invitation email via Postmark
      // await sendEmail({ to: email, subject: 'Team invitation', ... })

      return reply.status(201).send({ ...rows[0], invite_url: `https://app.tinai.cloud/invite/${token}` })
    },
  )

  // -------------------------------------------------------------------------
  // Accept invitation
  // -------------------------------------------------------------------------
  app.post<{ Params: { token: string } }>('/teams/invitations/:token/accept', async (req, reply) => {
    const userId = (req as any).userId

    const { rows } = await app.pg.query(
      `SELECT * FROM team_invitations WHERE token = $1 AND accepted_at IS NULL AND expires_at > NOW()`,
      [req.params.token],
    )
    if (!rows.length) return reply.status(404).send({ error: 'Invitation not found or expired' })

    const invite = rows[0]

    const client = await app.pg.connect()
    try {
      await client.query('BEGIN')

      await client.query(
        `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [invite.team_id, userId, invite.role],
      )
      await client.query(
        `UPDATE team_invitations SET accepted_at = NOW() WHERE id = $1`,
        [invite.id],
      )

      await client.query('COMMIT')
      return { ok: true, team_id: invite.team_id }
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  })

  // -------------------------------------------------------------------------
  // Remove member (owner/admin only, or self-leave)
  // -------------------------------------------------------------------------
  app.delete<{ Params: { slug: string; memberId: string } }>(
    '/teams/:slug/members/:memberId',
    async (req, reply) => {
      const userId = (req as any).userId
      const { slug, memberId } = req.params
      const isSelfLeave = userId === memberId

      if (!isSelfLeave) {
        const { rows } = await app.pg.query(
          `SELECT tm.role FROM teams t JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = $2
           WHERE t.slug = $1 AND tm.role IN ('owner', 'admin')`,
          [slug, userId],
        )
        if (!rows.length) return reply.status(403).send({ error: 'Not authorized' })
      }

      // Cannot remove the owner
      const { rows: target } = await app.pg.query(
        `SELECT role FROM team_members WHERE user_id = $1 AND team_id = (SELECT id FROM teams WHERE slug = $2)`,
        [memberId, slug],
      )
      if (target[0]?.role === 'owner') return reply.status(400).send({ error: 'Cannot remove team owner' })

      await app.pg.query(
        `DELETE FROM team_members WHERE user_id = $1 AND team_id = (SELECT id FROM teams WHERE slug = $2)`,
        [memberId, slug],
      )
      return reply.status(204).send()
    },
  )
}
