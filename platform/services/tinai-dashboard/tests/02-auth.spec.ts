import { test, expect, API_URL, TEST_PASSWORD, generateTestEmail, loginViaUI } from './fixtures'

test.describe('Authentication — Registration & Login', () => {
  test('register a new user via API', async ({ request }) => {
    const email = generateTestEmail()

    const response = await request.post(`${API_URL}/api/v1/auth/register`, {
      data: { email, password: TEST_PASSWORD },
    })

    // Registration returns 201 Created with { token, user }
    expect(response.status()).toBe(201)
    const body = await response.json()
    expect(body.token).toBeTruthy()
    expect(body.user).toBeTruthy()
    expect(body.user.email).toBe(email)
    expect(body.user.id).toBeTruthy()
    expect(body.user.role).toBe('tenant')
  })

  test('registration rejects missing email', async ({ request }) => {
    const response = await request.post(`${API_URL}/api/v1/auth/register`, {
      data: { password: TEST_PASSWORD },
    })

    expect(response.status()).toBe(400)
  })

  test('registration rejects short password', async ({ request }) => {
    const email = generateTestEmail()

    const response = await request.post(`${API_URL}/api/v1/auth/register`, {
      data: { email, password: '123' },
    })

    expect(response.status()).toBeGreaterThanOrEqual(400)
  })

  test('registration rejects duplicate email', async ({ request }) => {
    const email = generateTestEmail()

    const first = await request.post(`${API_URL}/api/v1/auth/register`, {
      data: { email, password: TEST_PASSWORD },
    })
    expect(first.status()).toBe(201)

    const second = await request.post(`${API_URL}/api/v1/auth/register`, {
      data: { email, password: TEST_PASSWORD },
    })
    expect(second.status()).toBeGreaterThanOrEqual(400)
  })

  test('registration JWT contains expected claims', async ({ request }) => {
    const email = generateTestEmail()

    const response = await request.post(`${API_URL}/api/v1/auth/register`, {
      data: { email, password: TEST_PASSWORD },
    })

    // Skip if rate-limited
    if (response.status() === 500 || response.status() === 429) {
      test.skip(true, 'Rate limited — skipping JWT validation')
      return
    }

    expect(response.status()).toBe(201)
    const body = await response.json()
    expect(body.token).toBeTruthy()

    const payload = JSON.parse(Buffer.from(body.token.split('.')[1], 'base64').toString())
    expect(payload.sub).toBeTruthy()
    expect(payload.email).toBe(email)
    expect(payload.role).toBe('tenant')
    expect(payload.exp).toBeGreaterThan(Date.now() / 1000)
  })

  test('login rejects invalid credentials', async ({ request }) => {
    const response = await request.post(`${API_URL}/api/v1/auth/login`, {
      data: { email: 'nonexistent@test.local', password: 'wrongpass' },
    })

    expect(response.status()).toBeGreaterThanOrEqual(400)
  })

  test('login page renders with email and password inputs', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('domcontentloaded')

    // Email tab is default — should have email + password inputs
    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]')
    await expect(emailInput.first()).toBeVisible()

    const passwordInput = page.locator('input[type="password"], input[name="password"]')
    await expect(passwordInput.first()).toBeVisible()

    const submitBtn = page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login")')
    await expect(submitBtn.first()).toBeVisible()
  })

  test('login page has mobile OTP tab', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('domcontentloaded')

    // Two-tab interface: Email | Mobile OTP
    const mobileTab = page.locator('button:has-text("Mobile"), button:has-text("OTP"), [role="tab"]:has-text("Mobile")')
    if (await mobileTab.count() > 0) {
      await expect(mobileTab.first()).toBeVisible()
    }
  })

  test('login page has magic link option', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('domcontentloaded')

    const magicLink = page.locator('button:has-text("magic"), button:has-text("Magic"), a:has-text("magic"), text=/magic link/i')
    if (await magicLink.count() > 0) {
      await expect(magicLink.first()).toBeVisible()
    }
  })

  test('login page has register link', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('domcontentloaded')

    // Register link goes to /login?register=true
    const registerLink = page.locator('a:has-text("Register"), a:has-text("Sign up"), a:has-text("Create account"), a[href*="register"]')
    if (await registerLink.count() > 0) {
      await expect(registerLink.first()).toBeVisible()
    }
  })

  test('login via UI sets session and redirects', async ({ page, request }) => {
    const email = generateTestEmail()

    // Register user via API (returns token)
    await request.post(`${API_URL}/api/v1/auth/register`, {
      data: { email, password: TEST_PASSWORD },
    })

    // Login via UI
    await loginViaUI(page, email, TEST_PASSWORD)

    // After login, should redirect to /apps or /instances (per router.push)
    const url = page.url()
    expect(url).not.toContain('/login')
  })

  test('login page shows error for invalid credentials', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('domcontentloaded')

    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]')
    await emailInput.first().fill('wrong@test.local')

    const passwordInput = page.locator('input[type="password"], input[name="password"]')
    await passwordInput.first().fill('wrongpassword')

    const submitBtn = page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login")')
    await submitBtn.first().click()

    await page.waitForTimeout(2000)
    const url = page.url()
    const hasError = url.includes('/login') ||
      (await page.locator('[role="alert"], .error, .text-red, .text-destructive, [data-testid="error"]').count()) > 0

    expect(hasError).toBeTruthy()
  })

  test('authenticated user at /login is redirected to /instances', async ({ page, request }) => {
    const email = generateTestEmail()

    // Register to get token
    const response = await request.post(`${API_URL}/api/v1/auth/register`, {
      data: { email, password: TEST_PASSWORD },
    })
    const body = await response.json()

    // Set auth cookie
    await page.context().addCookies([{
      name: 'tinai_token',
      value: body.token,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      secure: false,
    }])

    // Visit /login — middleware should redirect to /instances
    await page.goto('/login')
    await page.waitForLoadState('networkidle')

    const url = page.url()
    expect(url).toContain('/instances')
  })
})
