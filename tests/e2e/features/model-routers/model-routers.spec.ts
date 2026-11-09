import { expect, test } from '../../core/fixtures/base.fixture'
import { assertToast } from '../../core/utils/test-helpers'

// The routers, their status, the model routing rules and the decision
// router's provider are mocked, so these tests depend neither on an embedding
// provider nor on what the gateway holds.
test.describe('Model Routers', () => {
  const KEYWORDS = { simple_keywords: ['hello'], medium_keywords: ['summarize this thread'], complex_keywords: ['design a system'] }
  const ROUTERS = [
    {
      id: 'default',
      name: 'Default',
      classifier: 'semantic',
      keywords: KEYWORDS,
      semantic: { provider: 'openai', embedding_model: 'text-embedding-3-small', timeout: '2000ms', min_similarity: 0.4, vector_store: 'embedded', fallback: 'none' },
    },
    {
      id: 'support',
      name: 'Support',
      description: 'Help desk traffic',
      classifier: 'decision',
      keywords: KEYWORDS,
      decision: { provider: 'openai', model: 'gpt-4o-mini', previous_message_count: 1, timeout: '3000ms', min_confidence: 0.7 },
    },
  ]
  const RULES = [
    {
      id: 'desk',
      name: 'Support desk',
      description: '',
      enabled: true,
      cel_expression: '',
      model_router_id: 'support',
      scope: 'global',
      priority: 0,
      targets: [{ tier: 'SIMPLE', provider: 'openai', model: 'gpt-4o-mini', weight: 1 }],
      created_at: '2026-11-09T00:00:00Z',
      updated_at: '2026-11-09T00:00:00Z',
    },
  ]
  let deleteAttempts = 0

  test.beforeEach(async ({ page }) => {
    deleteAttempts = 0
    await page.route(
      (url) => url.pathname === '/api/routing/model-routers',
      (route) => route.fulfill({ json: { routers: ROUTERS, count: ROUTERS.length } }),
    )
    await page.route(
      (url) => /^\/api\/routing\/model-routers\/[^/]+\/status$/.test(url.pathname),
      (route) => route.fulfill({ json: { state: 'ready', loaded: 3, total: 3, cached_phrases: 3 } }),
    )
    await page.route(
      (url) => /^\/api\/routing\/model-routers\/[^/]+$/.test(url.pathname),
      async (route) => {
        if (route.request().method() === 'DELETE') {
          deleteAttempts++
          return route.fulfill({ status: 409, json: { error: { message: 'model router "support" is used by model routing rules: Support desk' } } })
        }
        const id = new URL(route.request().url()).pathname.split('/').pop()
        return route.fulfill({ json: ROUTERS.find((router) => router.id === id) })
      },
    )
    await page.route(
      (url) => url.pathname === '/api/routing/model-routing-rules',
      (route) => route.fulfill({ json: { rules: RULES, count: RULES.length } }),
    )
    await page.route(
      (url) => url.pathname === '/api/providers',
      (route) => route.fulfill({ json: { providers: [{ name: 'openai', provider_status: 'active', keys: [] }] } }),
    )
    await page.route(
      (url) => url.pathname === '/api/keys',
      (route) => route.fulfill({ json: [{ key_id: 'openai-key', name: 'OpenAI', provider: 'openai', enabled: true }] }),
    )
  })

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('should list routers with their classifier and rules, and open one', async ({ page }) => {
    await page.goto('/workspace/model-routers')
    await expect(page.getByTestId('model-router-row-default')).toContainText('Default')
    const support = page.getByTestId('model-router-row-support')
    await expect(support).toContainText('Decision model')
    await expect(support).toContainText('1 rule')

    await support.click()
    await expect(page).toHaveURL(/router=support/)
    await expect(page.getByTestId('model-router-name')).toHaveText('Support')
    await expect(page.getByTestId('model-router-rules-summary')).toContainText('Support desk')
  })

  test('should show a decision router as ready when its provider has an enabled key', async ({ page }) => {
    await page.goto('/workspace/model-routers')
    await expect(page.getByTestId('model-router-status-support')).toHaveAttribute('data-state-value', 'ready')
  })

  test('should show a decision router whose provider has no enabled key', async ({ page }) => {
    await page.route(
      (url) => url.pathname === '/api/keys',
      (route) => route.fulfill({ json: [] }),
    )
    await page.goto('/workspace/model-routers')
    await expect(page.getByTestId('model-router-status-support')).toHaveAttribute('data-state-value', 'no-enabled-key')
  })

  test('should show why a router that rules use cannot be deleted', async ({ page }) => {
    await page.goto('/workspace/model-routers')
    await page.getByTestId('model-router-actions-support-btn').click()
    await page.getByTestId('model-router-delete-support-btn').click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click()
    await assertToast(page, 'Support desk', 'error')
    expect(deleteAttempts).toBe(1)
  })

  test('should not offer to delete the default router', async ({ page }) => {
    await page.goto('/workspace/model-routers')
    await page.getByTestId('model-router-actions-default-btn').click()
    await expect(page.getByTestId('model-router-delete-default-btn')).toHaveAttribute('aria-disabled', 'true')
  })

  test('should list model routing rules with the model each tier gets', async ({ page }) => {
    await page.goto('/workspace/model-routers?view=rules')
    const row = page.getByTestId('model-routing-rule-row-desk')
    await expect(row).toContainText('Support desk')
    await expect(row).toContainText('Support')
    await expect(row).toContainText('openai/gpt-4o-mini')
  })
})
