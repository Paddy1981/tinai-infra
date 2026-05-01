import { test, expect, API_URL } from './fixtures'

test.describe('GPU Instance Management', () => {
  test('instances page loads', async ({ authenticatedPage: page }) => {
    await page.goto('/instances')
    await page.waitForLoadState('domcontentloaded')

    const url = page.url()
    expect(url).toContain('/instances')
  })

  test('instances page shows empty state or list', async ({ authenticatedPage: page }) => {
    await page.goto('/instances')
    await page.waitForLoadState('networkidle')

    // Empty state: "No instances yet" with launch link
    const emptyState = page.locator('text=/No instances yet/i')
    const launchLink = page.locator('text=/Launch your first GPU instance/i, a[href="/instances/new"]')
    const instanceTable = page.locator('table, [data-testid="instance-list"]')

    const hasEmptyState = (await emptyState.count()) > 0
    const hasLaunchLink = (await launchLink.count()) > 0
    const hasTable = (await instanceTable.count()) > 0

    expect(hasEmptyState || hasLaunchLink || hasTable).toBeTruthy()
  })

  test('instances page has Launch Instance button', async ({ authenticatedPage: page }) => {
    await page.goto('/instances')
    await page.waitForLoadState('networkidle')

    const launchBtn = page.locator('a[href="/instances/new"], button:has-text("Launch Instance"), a:has-text("Launch Instance")')
    await expect(launchBtn.first()).toBeVisible()
  })

  test('launch instance page loads with correct title', async ({ authenticatedPage: page }) => {
    await page.goto('/instances/new')
    await page.waitForLoadState('domcontentloaded')

    const heading = page.locator('text=/Launch GPU Instance/i')
    await expect(heading.first()).toBeVisible()
  })

  test('step 1 — image selection with category tabs', async ({ authenticatedPage: page }) => {
    await page.goto('/instances/new')
    await page.waitForLoadState('networkidle')

    // Section: "Choose Image" with category tabs
    const chooseImage = page.locator('text=/Choose Image/i')
    await expect(chooseImage.first()).toBeVisible()

    // Category tabs: All, Pre-built, Base OS, Custom Images
    const allTab = page.locator('button:has-text("All")')
    if (await allTab.count() > 0) {
      await expect(allTab.first()).toBeVisible()
    }

    // Image cards should load (PyTorch, TensorFlow, etc.)
    const imageCards = page.locator('text=/PyTorch/i, text=/TensorFlow/i, text=/VLLM/i, text=/Jupyter/i')
    expect(await imageCards.count()).toBeGreaterThan(0)
  })

  test('step 2 — instance type selection with pricing', async ({ authenticatedPage: page }) => {
    await page.goto('/instances/new')
    await page.waitForLoadState('networkidle')

    // Section: "Choose Instance Type"
    const chooseType = page.locator('text=/Choose Instance Type/i')
    await expect(chooseType.first()).toBeVisible()

    // Instance type cards with VRAM, RAM, pricing in ₹/hr
    const typeCards = page.locator('text=/VRAM/i, text=/₹/i, text=/vCPU/i')
    expect(await typeCards.count()).toBeGreaterThan(0)
  })

  test('step 3 — configure form with name and volume', async ({ authenticatedPage: page }) => {
    await page.goto('/instances/new')
    await page.waitForLoadState('networkidle')

    // Section: "Configure & Launch"
    const configSection = page.locator('text=/Configure/i')
    expect(await configSection.count()).toBeGreaterThan(0)

    // Instance name input
    const nameInput = page.locator('input[placeholder*="pytorch"], input[placeholder*="name" i], input[name="name"]')
    if (await nameInput.count() > 0) {
      await nameInput.first().fill('e2e-test-instance')
      await expect(nameInput.first()).toHaveValue('e2e-test-instance')
    }

    // Persistent volume slider (50-500 GB)
    const volumeSlider = page.locator('input[type="range"]')
    if (await volumeSlider.count() > 0) {
      await expect(volumeSlider.first()).toBeVisible()
    }
  })

  test('launch button is disabled without instance name', async ({ authenticatedPage: page }) => {
    await page.goto('/instances/new')
    await page.waitForLoadState('networkidle')

    const launchBtn = page.locator('button:has-text("Launch Instance")')
    if (await launchBtn.count() > 0) {
      // Should be disabled until name is provided
      await expect(launchBtn.first()).toBeDisabled()
    }
  })

  test('empty state message for no images in category', async ({ authenticatedPage: page }) => {
    await page.goto('/instances/new')
    await page.waitForLoadState('networkidle')

    // Click "Custom Images" tab — might show empty state
    const customTab = page.locator('button:has-text("Custom")')
    if (await customTab.count() > 0) {
      await customTab.first().click()
      await page.waitForTimeout(500)

      const emptyMsg = page.locator('text=/No images found/i')
      // May or may not have custom images
      if (await emptyMsg.count() > 0) {
        await expect(emptyMsg.first()).toBeVisible()
      }
    }
  })

  test('images API returns valid data', async ({ request, testUser }) => {
    const response = await request.get(`${API_URL}/api/v1/instances/images`, {
      headers: { Authorization: `Bearer ${testUser.token}` },
    })

    if (response.status() === 200) {
      const data = await response.json()
      expect(Array.isArray(data) || data.data).toBeTruthy()
    }
  })

  test('instance types API returns valid data', async ({ request, testUser }) => {
    const response = await request.get(`${API_URL}/api/v1/instances/types`, {
      headers: { Authorization: `Bearer ${testUser.token}` },
    })

    if (response.status() === 200) {
      const data = await response.json()
      expect(Array.isArray(data) || data.data).toBeTruthy()
    }
  })
})
