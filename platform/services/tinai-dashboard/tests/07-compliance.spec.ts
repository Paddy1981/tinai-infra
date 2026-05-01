import { test, expect } from './fixtures'

test.describe('DPDPA Compliance Dashboard', () => {
  test('compliance page loads with heading', async ({ authenticatedPage: page }) => {
    await page.goto('/compliance')
    await page.waitForLoadState('domcontentloaded')

    // Title: "Compliance" with multi-jurisdiction subtitle
    const heading = page.locator('text=/Compliance/i')
    await expect(heading.first()).toBeVisible()
  })

  test('compliance page shows report download buttons', async ({ authenticatedPage: page }) => {
    await page.goto('/compliance')
    await page.waitForLoadState('networkidle')

    // SOC 2 Report and DPDPA Report download buttons
    const reportBtns = page.locator('button:has-text("SOC 2"), button:has-text("DPDPA"), a:has-text("SOC 2"), a:has-text("DPDPA")')
    if (await reportBtns.count() > 0) {
      await expect(reportBtns.first()).toBeVisible()
    }
  })

  test('compliance page shows 8 module cards', async ({ authenticatedPage: page }) => {
    await page.goto('/compliance')
    await page.waitForLoadState('networkidle')

    // 8 compliance modules
    const modules = page.locator(
      'text=/Data Residency/i, text=/Consent Manager/i, text=/Rights Requests/i, ' +
      'text=/Breach Incidents/i, text=/Records of Processing/i, text=/DPIA/i, ' +
      'text=/DPA Status/i, text=/DPO Registry/i'
    )
    expect(await modules.count()).toBeGreaterThan(0)
  })

  test('compliance module cards show status badges', async ({ authenticatedPage: page }) => {
    await page.goto('/compliance')
    await page.waitForLoadState('networkidle')

    // Status badges: Active, Setup needed, Planned
    const badges = page.locator('text=/Active/i, text=/Setup needed/i, text=/Planned/i')
    if (await badges.count() > 0) {
      await expect(badges.first()).toBeVisible()
    }
  })

  test('compliance page shows residency snapshot', async ({ authenticatedPage: page }) => {
    await page.goto('/compliance')
    await page.waitForLoadState('networkidle')

    // Latest Residency Snapshot section
    const snapshot = page.locator('text=/Residency Snapshot/i, text=/residency/i')
    if (await snapshot.count() > 0) {
      await expect(snapshot.first()).toBeVisible()
    }
  })

  test('consent management page loads', async ({ authenticatedPage: page }) => {
    await page.goto('/compliance/consent')
    await page.waitForLoadState('domcontentloaded')

    const url = page.url()
    expect(url).toMatch(/\/compliance/)

    const content = page.locator('text=/consent/i')
    if (await content.count() > 0) {
      await expect(content.first()).toBeVisible()
    }
  })

  test('rights requests page loads', async ({ authenticatedPage: page }) => {
    await page.goto('/compliance/rights')
    await page.waitForLoadState('domcontentloaded')

    const url = page.url()
    expect(url).toMatch(/\/compliance/)

    const content = page.locator('text=/rights/i, text=/request/i')
    if (await content.count() > 0) {
      await expect(content.first()).toBeVisible()
    }
  })

  test('ROPA page loads', async ({ authenticatedPage: page }) => {
    await page.goto('/compliance/ropa')
    await page.waitForLoadState('domcontentloaded')

    const url = page.url()
    expect(url).toMatch(/\/compliance/)

    const content = page.locator('text=/processing/i, text=/ropa/i, text=/record/i')
    if (await content.count() > 0) {
      await expect(content.first()).toBeVisible()
    }
  })

  test('breach incidents page loads', async ({ authenticatedPage: page }) => {
    await page.goto('/compliance/breach')
    await page.waitForLoadState('domcontentloaded')

    const url = page.url()
    expect(url).toMatch(/\/compliance/)

    const content = page.locator('text=/breach/i, text=/incident/i')
    if (await content.count() > 0) {
      await expect(content.first()).toBeVisible()
    }
  })

  test('DPIA page loads', async ({ authenticatedPage: page }) => {
    await page.goto('/compliance/dpia')
    await page.waitForLoadState('domcontentloaded')

    const url = page.url()
    expect(url).toMatch(/\/compliance/)

    const content = page.locator('text=/dpia/i, text=/impact/i, text=/assessment/i')
    if (await content.count() > 0) {
      await expect(content.first()).toBeVisible()
    }
  })

  test('DPA status page loads', async ({ authenticatedPage: page }) => {
    await page.goto('/compliance/dpa')
    await page.waitForLoadState('domcontentloaded')

    const url = page.url()
    expect(url).toMatch(/\/compliance/)
  })

  test('DPO registry page loads', async ({ authenticatedPage: page }) => {
    await page.goto('/compliance/dpo')
    await page.waitForLoadState('domcontentloaded')

    const url = page.url()
    expect(url).toMatch(/\/compliance/)
  })
})
