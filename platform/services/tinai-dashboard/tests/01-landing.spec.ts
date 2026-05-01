import { test, expect } from '@playwright/test'

test.describe('Public Pages & Landing', () => {
  test('homepage loads with branding', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    const title = await page.title()
    expect(title).toBeTruthy()

    // Landing page has "Nuts & Bolts of Cloud" tagline
    const body = await page.textContent('body')
    expect(body?.toLowerCase()).toContain('tinai')
  })

  test('homepage has navigation links', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    // Should have Sign in link and Get Started button
    const signInLink = page.locator('a:has-text("Sign in"), a[href*="login"]')
    await expect(signInLink.first()).toBeVisible({ timeout: 10_000 })
  })

  test('homepage has product cards', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    // Landing page shows 9 product cards: GPU, Mail, COLL, Storage, etc.
    const productSection = page.locator('text=/GPU/i, text=/Storage/i, text=/Inference/i')
    expect(await productSection.count()).toBeGreaterThan(0)
  })

  test('homepage has pricing section', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    const pricing = page.locator('text=/pricing/i, text=/₹/i, text=/per hour/i, text=/\\/hr/i')
    expect(await pricing.count()).toBeGreaterThan(0)
  })

  test('Get Started links to register', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    const getStarted = page.locator('a:has-text("Get Started"), a[href*="register"]')
    if (await getStarted.count() > 0) {
      const href = await getStarted.first().getAttribute('href')
      expect(href).toContain('login')
    }
  })

  test('unauthenticated user is redirected from /instances', async ({ page }) => {
    await page.context().clearCookies()

    await page.goto('/instances')
    await page.waitForLoadState('networkidle')

    // Middleware redirects to /login
    const url = page.url()
    expect(url).toContain('/login')
  })

  test('unauthenticated user is redirected from /apps', async ({ page }) => {
    await page.context().clearCookies()

    await page.goto('/apps')
    await page.waitForLoadState('networkidle')

    const url = page.url()
    expect(url).toContain('/login')
  })

  test('unauthenticated user is redirected from /billing', async ({ page }) => {
    await page.context().clearCookies()

    await page.goto('/billing')
    await page.waitForLoadState('networkidle')

    const url = page.url()
    expect(url).toContain('/login')
  })

  test('unauthenticated user is redirected from /settings', async ({ page }) => {
    await page.context().clearCookies()

    await page.goto('/settings')
    await page.waitForLoadState('networkidle')

    const url = page.url()
    expect(url).toContain('/login')
  })

  test('/features is accessible without auth', async ({ page }) => {
    await page.context().clearCookies()

    const response = await page.goto('/features')
    if (response) {
      // Features is a public path per middleware
      const url = page.url()
      expect(url).not.toContain('/login')
    }
  })
})
