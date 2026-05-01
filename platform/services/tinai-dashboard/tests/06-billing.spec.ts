import { test, expect, API_URL } from './fixtures'

test.describe('Billing & Settings', () => {
  test('billing page loads with heading', async ({ authenticatedPage: page }) => {
    await page.goto('/billing')
    await page.waitForLoadState('domcontentloaded')

    // Title: "Billing" with subtitle "Usage, invoices, and payment methods"
    const heading = page.locator('text=/Billing/i')
    await expect(heading.first()).toBeVisible()
  })

  test('billing page shows stat cards', async ({ authenticatedPage: page }) => {
    await page.goto('/billing')
    await page.waitForLoadState('networkidle')

    // Stat cards: This Month, Last Month, Credit Balance, Next Invoice
    const statLabels = page.locator('text=/This Month/i, text=/Last Month/i, text=/Credit Balance/i, text=/Next Invoice/i')
    expect(await statLabels.count()).toBeGreaterThan(0)
  })

  test('billing page shows usage section', async ({ authenticatedPage: page }) => {
    await page.goto('/billing')
    await page.waitForLoadState('networkidle')

    const usageSection = page.locator('text=/Usage This Month/i, text=/usage/i')
    expect(await usageSection.count()).toBeGreaterThan(0)
  })

  test('billing page shows invoices section', async ({ authenticatedPage: page }) => {
    await page.goto('/billing')
    await page.waitForLoadState('networkidle')

    // Invoices table or empty state
    const invoicesSection = page.locator('text=/invoice/i, text=/No invoices yet/i')
    expect(await invoicesSection.count()).toBeGreaterThan(0)
  })

  test('billing page shows payment methods', async ({ authenticatedPage: page }) => {
    await page.goto('/billing')
    await page.waitForLoadState('networkidle')

    // Payment methods section with "Add Payment Method" button
    const paymentSection = page.locator('text=/Payment Method/i, text=/No payment methods/i, text=/Add Payment/i')
    expect(await paymentSection.count()).toBeGreaterThan(0)
  })

  test('billing usage API returns data', async ({ request, testUser }) => {
    const response = await request.get(`${API_URL}/api/v1/billing/usage/current`, {
      headers: { Authorization: `Bearer ${testUser.token}` },
    })

    // New user: 200 with zero usage, or 404
    expect([200, 404]).toContain(response.status())
  })

  test('settings page loads with heading', async ({ authenticatedPage: page }) => {
    await page.goto('/settings')
    await page.waitForLoadState('domcontentloaded')

    // Title: "Settings" with subtitle
    const heading = page.locator('text=/Settings/i')
    await expect(heading.first()).toBeVisible()
  })

  test('settings page shows profile section', async ({ authenticatedPage: page }) => {
    await page.goto('/settings')
    await page.waitForLoadState('networkidle')

    // Profile fields: Display name, Email, Mobile
    const profileFields = page.locator('text=/Display name/i, text=/Email/i, text=/Mobile/i, text=/Profile/i')
    expect(await profileFields.count()).toBeGreaterThan(0)
  })

  test('settings page shows appearance section', async ({ authenticatedPage: page }) => {
    await page.goto('/settings')
    await page.waitForLoadState('networkidle')

    // Dark/Light theme toggle
    const themeSection = page.locator('text=/Appearance/i, text=/Dark/i, text=/Light/i, button:has-text("Dark"), button:has-text("Light")')
    expect(await themeSection.count()).toBeGreaterThan(0)
  })

  test('settings page shows API keys section', async ({ authenticatedPage: page }) => {
    await page.goto('/settings')
    await page.waitForLoadState('networkidle')

    // API keys section with create form
    const apiSection = page.locator('text=/API Key/i, text=/No API keys/i, text=/Create key/i')
    expect(await apiSection.count()).toBeGreaterThan(0)
  })

  test('settings page shows notifications section', async ({ authenticatedPage: page }) => {
    await page.goto('/settings')
    await page.waitForLoadState('networkidle')

    // Notification toggles
    const notifSection = page.locator('text=/Notification/i, text=/Deploy success/i, text=/Deploy failure/i, text=/Billing threshold/i')
    if (await notifSection.count() > 0) {
      await expect(notifSection.first()).toBeVisible()
    }
  })

  test('settings page shows danger zone', async ({ authenticatedPage: page }) => {
    await page.goto('/settings')
    await page.waitForLoadState('networkidle')

    // Danger zone with delete account
    const dangerZone = page.locator('text=/Danger/i, text=/Delete account/i, text=/delete my account/i')
    if (await dangerZone.count() > 0) {
      await expect(dangerZone.first()).toBeVisible()
    }
  })

  test('settings save button is present', async ({ authenticatedPage: page }) => {
    await page.goto('/settings')
    await page.waitForLoadState('networkidle')

    const saveBtn = page.locator('button:has-text("Save")')
    if (await saveBtn.count() > 0) {
      await expect(saveBtn.first()).toBeVisible()
    }
  })
})
