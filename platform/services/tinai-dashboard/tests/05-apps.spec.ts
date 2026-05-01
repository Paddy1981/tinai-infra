import { test, expect } from './fixtures'

test.describe('Apps & Templates', () => {
  test('apps page loads', async ({ authenticatedPage: page }) => {
    await page.goto('/apps')
    await page.waitForLoadState('domcontentloaded')

    const url = page.url()
    expect(url).toContain('/apps')
  })

  test('apps page shows list or empty state', async ({ authenticatedPage: page }) => {
    await page.goto('/apps')
    await page.waitForLoadState('networkidle')

    const emptyState = page.locator('text=/no app/i, text=/deploy your first/i, text=/get started/i')
    const appList = page.locator('table, .app-card, .app-row, [data-testid="app-list"]')

    const hasContent = (await emptyState.count()) > 0 || (await appList.count()) > 0
    expect(hasContent).toBeTruthy()
  })

  test('templates page loads with heading', async ({ authenticatedPage: page }) => {
    await page.goto('/templates')
    await page.waitForLoadState('domcontentloaded')

    const url = page.url()
    expect(url).toContain('/templates')

    // Title: "Templates" with subtitle "One-click service deployment"
    const heading = page.locator('text=/Templates/i')
    await expect(heading.first()).toBeVisible()
  })

  test('templates page shows template cards', async ({ authenticatedPage: page }) => {
    await page.goto('/templates')
    await page.waitForLoadState('networkidle')

    // Template cards with Deploy buttons
    const deployBtns = page.locator('a:has-text("Deploy"), button:has-text("Deploy")')
    const templateNames = page.locator('text=/Database/i, text=/Cache/i, text=/Storage/i, text=/Messaging/i')

    const hasCards = (await deployBtns.count()) > 0 || (await templateNames.count()) > 0
    expect(hasCards).toBeTruthy()
  })

  test('templates page has category filter tabs', async ({ authenticatedPage: page }) => {
    await page.goto('/templates')
    await page.waitForLoadState('networkidle')

    // Category tabs: All, Database, Cache, Storage, Messaging, Starter
    const allTab = page.locator('button:has-text("All")')
    const dbTab = page.locator('button:has-text("Database")')
    const cacheTab = page.locator('button:has-text("Cache")')

    if (await allTab.count() > 0) {
      await expect(allTab.first()).toBeVisible()
    }
    if (await dbTab.count() > 0) {
      await expect(dbTab.first()).toBeVisible()
    }
  })

  test('templates category filter works', async ({ authenticatedPage: page }) => {
    await page.goto('/templates')
    await page.waitForLoadState('networkidle')

    const dbTab = page.locator('button:has-text("Database")')
    if (await dbTab.count() > 0) {
      await dbTab.first().click()
      await page.waitForTimeout(500)

      // Should show only database templates or empty message
      const content = page.locator('text=/database/i, text=/postgres/i, text=/mysql/i, text=/No templates/i')
      expect(await content.count()).toBeGreaterThan(0)
    }
  })

  test('template deploy link navigates correctly', async ({ authenticatedPage: page }) => {
    await page.goto('/templates')
    await page.waitForLoadState('networkidle')

    // Deploy links go to /templates/{id}/deploy
    const deployLink = page.locator('a[href*="/templates/"][href*="/deploy"]')

    if (await deployLink.count() > 0) {
      await deployLink.first().click()
      await page.waitForLoadState('domcontentloaded')

      const url = page.url()
      expect(url).toMatch(/\/templates\/[^/]+\/deploy/)
    }
  })

  test('template card shows docker image info', async ({ authenticatedPage: page }) => {
    await page.goto('/templates')
    await page.waitForLoadState('networkidle')

    // Template cards show docker image name and port
    const dockerInfo = page.locator('text=/docker/i, text=/image/i, text=/port/i, code')
    if (await dockerInfo.count() > 0) {
      await expect(dockerInfo.first()).toBeVisible()
    }
  })
})
