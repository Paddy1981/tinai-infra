export interface Config {
  port: number
  databaseUrl: string
  stagingNamespace: string
  buildNamespace: string
  jwtSecret: string
  forgejoUrl: string
  forgejoAdminToken: string
  forgejoWebhookUrl: string
  forgejoWebhookSecret: string
}

export function loadConfig(): Config {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL environment variable is required')

  const jwtSecret = process.env.JWT_SECRET
  if (!jwtSecret) throw new Error('JWT_SECRET environment variable is required')

  return {
    port: parseInt(process.env.PORT || '3001'),
    databaseUrl,
    stagingNamespace: process.env.STAGING_NAMESPACE || 'tinai-staging',
    buildNamespace: process.env.BUILD_NAMESPACE || 'tinai-build',
    jwtSecret,
    forgejoUrl: process.env.FORGEJO_URL || 'http://gitea.forgejo.svc.cluster.local:3000',
    forgejoAdminToken: process.env.FORGEJO_ADMIN_TOKEN || '',
    forgejoWebhookUrl: process.env.FORGEJO_WEBHOOK_URL || 'http://build-api.tinai-system.svc.cluster.local:8080/webhook',
    forgejoWebhookSecret: process.env.FORGEJO_WEBHOOK_SECRET || '',
  }
}
