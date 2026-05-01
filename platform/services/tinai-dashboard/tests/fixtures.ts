import { test as base, expect, type Page, type APIRequestContext } from '@playwright/test'

// Service URLs
const API_URL = process.env.API_URL || 'http://localhost:3001'
const AUTH_URL = process.env.AUTH_URL || 'http://localhost:3002'
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3007'

// Test user defaults
const TEST_PASSWORD = 'TestPass123!'
let testUserCounter = 0

interface TestUser {
  email: string
  password: string
  token?: string
  id?: string
}

/**
 * Generate a unique test email to avoid collisions between runs
 */
function generateTestEmail(): string {
  testUserCounter++
  const ts = Date.now()
  return `e2e-test-${ts}-${testUserCounter}@tinai-test.local`
}

/**
 * Register a new test user via the API.
 * The register endpoint returns 201 with { token, user } directly.
 */
async function createTestUser(request: APIRequestContext): Promise<TestUser> {
  const email = generateTestEmail()
  const password = TEST_PASSWORD

  const response = await request.post(`${API_URL}/api/v1/auth/register`, {
    data: { email, password },
  })

  // Registration returns 201 Created
  if (response.status() !== 201 && response.status() !== 200) {
    const body = await response.text()
    throw new Error(`Failed to register test user: ${response.status()} ${body}`)
  }

  const data = await response.json()
  const token = data.token || data.access_token || data.data?.token
  const id = data.user?.id || data.data?.id

  return { email, password, token, id }
}

/**
 * Login a test user via the API and return the JWT token.
 * NOTE: As of current deployment, /api/v1/auth/login may 500 due to
 * missing refresh_tokens table. Use createTestUser() which returns
 * the token directly from registration.
 */
async function loginViaAPI(request: APIRequestContext, user: TestUser): Promise<string | undefined> {
  const response = await request.post(`${API_URL}/api/v1/auth/login`, {
    data: { email: user.email, password: user.password },
  })

  if (!response.ok()) {
    // Login endpoint may be broken — return undefined so callers fall back
    return undefined
  }

  const data = await response.json()
  return data.token || data.access_token || data.data?.token
}

/**
 * Login via the browser UI — fills the login form and submits
 */
async function loginViaUI(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login')
  await page.waitForLoadState('networkidle')

  // Fill email
  const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]')
  await emailInput.fill(email)

  // Fill password
  const passwordInput = page.locator('input[type="password"], input[name="password"]')
  await passwordInput.fill(password)

  // Submit
  const submitBtn = page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login")')
  await submitBtn.click()

  // Wait for navigation away from login
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15_000 })
}

/**
 * Set the auth cookie directly (bypass UI login for speed)
 */
async function setAuthCookie(page: Page, token: string): Promise<void> {
  await page.context().addCookies([
    {
      name: 'tinai_token',
      value: token,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      secure: false,
    },
  ])
}

// Extended test fixture with auth helpers
type TestFixtures = {
  testUser: TestUser
  authenticatedPage: Page
}

export const test = base.extend<TestFixtures>({
  testUser: async ({ request }, use) => {
    // Registration returns the token directly — no separate login needed
    const user = await createTestUser(request)
    await use(user)
  },

  authenticatedPage: async ({ page, request }, use) => {
    const user = await createTestUser(request)
    if (user.token) {
      await setAuthCookie(page, user.token)
    } else {
      // Fallback: login via UI
      await loginViaUI(page, user.email, user.password)
    }
    await use(page)
  },
})

export {
  expect,
  API_URL,
  AUTH_URL,
  DASHBOARD_URL,
  TEST_PASSWORD,
  createTestUser,
  loginViaAPI,
  loginViaUI,
  setAuthCookie,
  generateTestEmail,
}
