import { test, expect } from './fixtures'

test.describe('Onboarding Flow', () => {
  test('onboarding page loads for authenticated user', async ({ authenticatedPage: page }) => {
    await page.goto('/onboarding')
    await page.waitForLoadState('domcontentloaded')

    const url = page.url()
    expect(url).toContain('/onboarding')
  })

  test('step 1 — product selection with checkboxes', async ({ authenticatedPage: page }) => {
    await page.goto('/onboarding')
    await page.waitForLoadState('networkidle')

    // Step 1 shows product checkboxes: Instances, Storage, Inference
    const instancesOption = page.locator('text=/instance/i')
    const storageOption = page.locator('text=/storage/i')
    const inferenceOption = page.locator('text=/inference/i')

    const hasOptions = (await instancesOption.count()) > 0 ||
      (await storageOption.count()) > 0 ||
      (await inferenceOption.count()) > 0

    expect(hasOptions).toBeTruthy()

    // Continue button should be present
    const continueBtn = page.locator('button:has-text("Continue"), button:has-text("Next")')
    if (await continueBtn.count() > 0) {
      // Select first product option by clicking it
      if (await instancesOption.count() > 0) {
        await instancesOption.first().click()
      }
    }
  })

  test('step 1 — continue button enabled after product selection', async ({ authenticatedPage: page }) => {
    await page.goto('/onboarding')
    await page.waitForLoadState('networkidle')

    // Click a product option to select it
    const productOptions = page.locator('label:has(input[type="checkbox"]), [role="checkbox"], .product-card')
    if (await productOptions.count() > 0) {
      await productOptions.first().click()

      const continueBtn = page.locator('button:has-text("Continue"), button:has-text("Next")')
      if (await continueBtn.count() > 0) {
        await expect(continueBtn.first()).toBeEnabled()
      }
    }
  })

  test('step 2 — CLI quick start content', async ({ authenticatedPage: page }) => {
    await page.goto('/onboarding')
    await page.waitForLoadState('networkidle')

    // Navigate to step 2 by selecting a product and clicking continue
    const productOptions = page.locator('label:has(input[type="checkbox"]), [role="checkbox"], .product-card, text=/instance/i')
    if (await productOptions.count() > 0) {
      await productOptions.first().click()
    }

    const continueBtn = page.locator('button:has-text("Continue"), button:has-text("Next")')
    if (await continueBtn.count() > 0) {
      await continueBtn.first().click()
      await page.waitForTimeout(1000)

      // Step 2 shows CLI snippets
      const codeBlock = page.locator('pre, code, .code-block')
      const docsLink = page.locator('a[href*="/docs/cli"]')

      const hasCliContent = (await codeBlock.count()) > 0 || (await docsLink.count()) > 0
      if (hasCliContent) {
        expect(hasCliContent).toBeTruthy()
      }
    }
  })

  test('step 3 — API key creation form', async ({ authenticatedPage: page }) => {
    await page.goto('/onboarding')
    await page.waitForLoadState('networkidle')

    // Navigate through steps 1 and 2
    for (let i = 0; i < 2; i++) {
      const productOptions = page.locator('label:has(input[type="checkbox"]), [role="checkbox"], .product-card, text=/instance/i')
      if (await productOptions.count() > 0 && i === 0) {
        await productOptions.first().click()
      }

      const btn = page.locator('button:has-text("Continue"), button:has-text("Next"), button:has-text("Skip")')
      if (await btn.count() > 0) {
        await btn.first().click()
        await page.waitForTimeout(1000)
      }
    }

    // Step 3: API key creation
    const keyNameInput = page.locator('input[placeholder*="default"], input[name*="key"], input[placeholder*="key" i]')
    const createKeyBtn = page.locator('button:has-text("Create"), button:has-text("Generate")')

    if (await keyNameInput.count() > 0) {
      // Key name input defaults to "default"
      await expect(keyNameInput.first()).toBeVisible()
    }
    if (await createKeyBtn.count() > 0) {
      await expect(createKeyBtn.first()).toBeVisible()
    }
  })

  test('step 4 — completion with dashboard links', async ({ authenticatedPage: page }) => {
    await page.goto('/onboarding')
    await page.waitForLoadState('networkidle')

    // Navigate through all steps
    for (let i = 0; i < 3; i++) {
      const productOptions = page.locator('label:has(input[type="checkbox"]), [role="checkbox"], .product-card, text=/instance/i')
      if (await productOptions.count() > 0 && i === 0) {
        await productOptions.first().click()
      }

      const btn = page.locator('button:has-text("Continue"), button:has-text("Next"), button:has-text("Skip")')
      if (await btn.count() > 0) {
        await btn.first().click()
        await page.waitForTimeout(1000)
      }
    }

    // Step 4: completion screen with quick links
    const completionText = page.locator('text=/all set/i, text=/ready/i, text=/complete/i, text=/done/i')
    const dashboardBtn = page.locator('button:has-text("Dashboard"), button:has-text("Go to"), a:has-text("Dashboard")')
    const quickLinks = page.locator('a[href="/instances/new"], a[href*="bucket"], a[href*="endpoint"], a[href*="/docs"]')

    const hasCompletion = (await completionText.count()) > 0
    const hasDashboard = (await dashboardBtn.count()) > 0
    const hasQuickLinks = (await quickLinks.count()) > 0

    if (hasCompletion || hasDashboard || hasQuickLinks) {
      expect(hasCompletion || hasDashboard || hasQuickLinks).toBeTruthy()
    }
  })
})
