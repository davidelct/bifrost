import { expect, test } from '../../core/fixtures/base.fixture'

test.describe('Model Router: default router', () => {
  test.describe('Decision Model Picker', () => {
    // The saved config, the providers (OpenRouter, Cloudflare, Perplexity, Ollama and a custom OpenAI-based one),
    // and the model listing are mocked, so the test does not depend on decisions
    // access or on which models the catalog holds. The listing answers with the
    // decision models only when the picker asks for them, which is what proves
    // the picker filters on decisions.
    const CUSTOM_OPENAI = 'my-openai'
    let decisionProvider = 'openai'
    let savedModel = 'gpt-6-luna'
    let decisionModels: string[] = []
    let chatModels: string[] = []
    let modelQueries: URLSearchParams[] = []

    test.beforeEach(async ({ page }) => {
      modelQueries = []
      await page.route(
        (url) => url.pathname === '/api/routing/model-routers/default',
        async (route) => {
          if (route.request().method() !== 'GET') return route.continue()
          await route.fulfill({
            json: {
              id: 'default',
              name: 'Default',
              classifier: 'decision',
              keywords: {
                simple_keywords: ['simple'],
                medium_keywords: ['medium'],
                complex_keywords: ['complex'],
              },
              decision: {
                provider: decisionProvider,
                model: savedModel,
                previous_message_count: 2,
                timeout: '3000ms',
                min_confidence: 0.7,
              },
            },
          })
        },
      )
      // The configured providers, plus OpenRouter, Cloudflare, Perplexity, Ollama, Azure, Databricks and a custom provider built on OpenAI.
      await page.route(
        (url) => url.pathname === '/api/providers',
        async (route) => {
          if (route.request().method() !== 'GET') return route.continue()
          const response = await route.fetch()
          const body = await response.json()
          body.providers = [
            ...(body.providers ?? []).filter(
              (p: { name: string }) => ![CUSTOM_OPENAI, 'openrouter', 'cloudflare', 'perplexity', 'ollama', 'azure', 'databricks'].includes(p.name),
            ),
            { name: 'openrouter', provider_status: 'active', keys: [] },
            { name: 'cloudflare', provider_status: 'active', keys: [] },
            { name: 'perplexity', provider_status: 'active', keys: [] },
            { name: 'ollama', provider_status: 'active', keys: [] },
            { name: 'azure', provider_status: 'active', keys: [] },
            { name: 'databricks', provider_status: 'active', keys: [] },
            {
              name: CUSTOM_OPENAI,
              provider_status: 'active',
              keys: [],
              custom_provider_config: { base_provider_type: 'openai', is_key_less: true },
            },
          ]
          await route.fulfill({ response, json: body })
        },
      )
      await page.route(
        (url) => url.pathname === '/api/models',
        async (route) => {
          const params = new URL(route.request().url()).searchParams
          if (params.get('provider') !== decisionProvider) return route.continue()
          modelQueries.push(params)
          const names = params.get('decisions') === 'true' ? decisionModels : chatModels
          const models = names.map((name) => ({ name, provider: decisionProvider }))
          await route.fulfill({ json: { models, total: models.length } })
        },
      )
    })

    // The page polls /api/providers; a poll still inside route.fetch when the page
    // closes would otherwise fail the test.
    test.afterEach(async ({ page }) => {
      await page.unrouteAll({ behavior: 'ignoreErrors' })
    })

    const cases = [
      ...['openai', CUSTOM_OPENAI].map((provider) => ({
        provider,
        saved: 'gpt-6-luna',
        decisions: ['gpt-6-luna', 'gpt-6-luna-2026-09-01'],
        chat: ['gpt-4o'],
      })),
      // OpenRouter lists a chat router under Typesafe's namespace; only the models
      // the datasheet marks as decision models, Clef included, are offered.
      {
        provider: 'openrouter',
        saved: '~typesafe/jev-latest',
        decisions: ['~typesafe/jev-latest', 'typesafe/jev-1.13', 'cloudflare/clef'],
        chat: ['typesafe/jev-router'],
      },
      // Cloudflare's catalog is mostly chat and embedding models; only Clef is offered.
      {
        provider: 'cloudflare',
        saved: '@cf/cloudflare/clef-flash',
        decisions: ['@cf/cloudflare/clef', '@cf/cloudflare/clef-flash'],
        chat: ['@cf/meta/llama-4-scout-17b-16e-instruct'],
      },
      // Perplexity's catalog is its Sonar chat models plus the deciders; only the deciders are offered.
      {
        provider: 'perplexity',
        saved: 'pplx-decider-v1.1-27b',
        decisions: ['pplx-decider-v1-27b', 'pplx-decider-v1.1-27b'],
        chat: ['sonar-pro'],
      },
      // Ollama lists every locally pulled model; only the System One models are offered.
      {
        provider: 'ollama',
        saved: 'tev1:0.8b-q8_0',
        decisions: ['tev1:0.8b-q8_0', 'nimble'],
        chat: ['llama3.1:latest'],
      },
      // Azure lists every deployment; only Microsoft's decision models are offered.
      {
        provider: 'azure',
        saved: 'Microsoft-Decision-1',
        decisions: ['Microsoft-Decision-1'],
        chat: ['gpt-4o'],
      },
      // Databricks' catalog is mostly chat serving endpoints; only ai_decide and the System One models are offered.
      {
        provider: 'databricks',
        saved: 'ai_decide',
        decisions: ['ai_decide', 'system.ai.openjev-qwen35-4b'],
        chat: ['databricks-claude-sonnet-4'],
      },
    ]

    for (const { provider, saved, decisions, chat } of cases) {
      test(`should list only decision models for the ${provider} provider`, async ({ page }) => {
        decisionProvider = provider
        savedModel = saved
        decisionModels = decisions
        chatModels = chat
        await page.goto('/workspace/model-routers?router=default')
        await page.getByTestId('complexity-router-decision-settings-button').click()
        await expect(page.getByTestId('complexity-router-decision-sheet')).toBeVisible({ timeout: 5000 })

        const modelSelect = page.getByTestId('complexity-router-decision-model-select')
        await expect(modelSelect).toBeVisible({ timeout: 10000 })
        await expect(modelSelect).toContainText(saved)

        await modelSelect.click()
        await expect(page.getByRole('option', { name: decisions[decisions.length - 1] })).toBeVisible()
        for (const name of chat) {
          await expect(page.getByRole('option', { name })).toHaveCount(0)
        }
        expect(modelQueries.length).toBeGreaterThan(0)
        expect(modelQueries.every((params) => params.get('decisions') === 'true')).toBe(true)
      })
    }

    test('should show the saved confidence threshold in the model configuration sheet', async ({ page }) => {
      decisionProvider = 'openai'
      savedModel = 'gpt-6-luna'
      decisionModels = ['gpt-6-luna']
      chatModels = ['gpt-4o-mini']
      await page.goto('/workspace/model-routers?router=default')
      await page.getByTestId('complexity-router-decision-settings-button').click()
      await expect(page.getByTestId('complexity-router-decision-sheet')).toBeVisible({ timeout: 5000 })

      await expect(page.getByTestId('complexity-router-decision-sheet')).toContainText('Confidence threshold')
      await expect(page.getByTestId('complexity-router-decision-min-confidence-input')).toHaveValue('0.7')
    })
  })
  test.describe('Phrase Suggestions', () => {
    // Everything the page reads about the router and its suggestions is mocked,
    // so these run against any dev server, with or without real suggestions.
    const OPEN = [
      {
        id: 'sug-refund',
        router_id: 'default',
        router_version: 'bank-v2',
        stale: false,
        status: 'open',
        tier: 'SIMPLE',
        phrases: ['where is my refund'],
        category: 'weak',
        reason: 'refund status questions',
        request_count: 214,
        coverage: 0.8,
        nearest_phrase: 'summarize this support thread',
        nearest_tier: 'MEDIUM',
        nearest_similarity: 0.46,
        example_log_ids: ['log-1', 'log-gone'],
        embedding_signature: 'ns',
        run_id: 'run-1',
        last_seen_at: '2026-11-04T03:00:00Z',
        created_at: '2026-11-04T03:00:00Z',
        updated_at: '2026-11-04T03:00:00Z',
      },
      {
        id: 'sug-migration',
        router_id: 'default',
        router_version: 'bank-v1',
        stale: true,
        status: 'open',
        tier: 'COMPLEX',
        phrases: ['plan a database migration'],
        category: 'uncovered',
        request_count: 12,
        coverage: 1,
        nearest_similarity: 0.21,
        example_log_ids: [],
        embedding_signature: 'ns',
        run_id: 'run-1',
        last_seen_at: '2026-11-04T03:00:00Z',
        created_at: '2026-11-04T03:00:00Z',
        updated_at: '2026-11-04T03:00:00Z',
      },
    ]
    const DISMISSED = [{ ...OPEN[1], id: 'sug-old', status: 'dismissed', phrases: ['translate this paragraph'] }]
    const LAST_RUN = {
      id: 'run-1',
      triggered_by: 'schedule',
      status: 'succeeded',
      requests_read: 900,
      clusters: 30,
      created: 2,
      refreshed: 0,
      superseded: 0,
      cost: 0.01,
      started_at: '2026-11-04T03:00:00Z',
      finished_at: '2026-11-04T03:02:00Z',
    }
    const CONFIG = {
      id: 'default',
      name: 'Default',
      classifier: 'semantic',
      keywords: { simple_keywords: ['hello'], medium_keywords: ['summarize this support thread'], complex_keywords: ['design a system'] },
      semantic: { provider: 'openai', embedding_model: 'text-embedding-3-small', timeout: '2000ms', min_similarity: 0.4, vector_store: 'embedded', fallback: 'none' },
      // As the gateway returns it: the models a run uses are filled in.
      suggestions: {
        enabled: true,
        sample_rate: 0.1,
        lookback_days: 7,
        schedule: { every: '1d', at: '03:00', timezone: 'UTC' },
        max_clustered_requests: 20000,
        min_cluster_requests: 6,
        provider: 'openai',
        model: 'gpt-4.1-mini',
        tier: { classifier: 'llm', provider: 'openai', model: 'gpt-4.1-mini' },
      },
    }
    const TIER_PROMPT =
      'Pick the tier by the work asked.\n\nTier definitions:\n- "SIMPLE": short answers\n\n' +
      "Requests this router's administrator assigned to each tier; requests like these belong in that tier:\n" +
      'SIMPLE:\n- hello\nMEDIUM:\n- summarize this support thread\nCOMPLEX:\n- design a system'
    const TIER_CRITERIA = {
      SIMPLE: { definition: 'One short answer.', signals: ['a lookup'], examples: ['hello'] },
      MEDIUM: { definition: 'Routine multi-step work.', signals: ['a draft'], examples: ['summarize this support thread'] },
      COMPLEX: { definition: 'Design with trade-offs.', signals: ['trade-offs'], examples: ['design a system'] },
    }
    let saved: Record<string, unknown>[] = []
    let statusCalls: { id: string; status: string }[] = []
    let runStarts = 0
    let runWindows: (string | null)[] = []
    let listRouters: (string | null)[] = []

    test.beforeEach(async ({ page }) => {
      saved = []
      statusCalls = []
      runStarts = 0
      runWindows = []
      listRouters = []
      await page.route(
        (url) => url.pathname === '/api/routing/model-routers/default',
        async (route) => {
          if (route.request().method() === 'PUT') {
            const body = route.request().postDataJSON()
            saved.push(body)
            return route.fulfill({ json: { ...body, id: 'default' } })
          }
          return route.fulfill({ json: CONFIG })
        },
      )
      await page.route(
        (url) => url.pathname === '/api/routing/model-routers/default/status',
        (route) =>
          route.fulfill({
            json: {
              state: 'ready',
              loaded: 3,
              total: 3,
              cached_phrases: 3,
              suggestion_default_instructions: 'Write short reference phrases.',
              suggestion_default_tier_instructions: 'Pick the tier by the work asked.',
              // Rendered by the gateway from this router: its own phrases are the examples.
              suggestion_default_tier_prompt: TIER_PROMPT,
              suggestion_default_tier_criteria: TIER_CRITERIA,
            },
          }),
      )
      await page.route(
        (url) => url.pathname === '/api/routing/complexity-suggestions',
        (route) => {
          const params = new URL(route.request().url()).searchParams
          const status = params.get('status')
          listRouters.push(params.get('router_id'))
          return route.fulfill({
            json: {
              router_id: 'default',
              router_version: 'bank-v2',
              suggestions: status === 'dismissed' ? DISMISSED : OPEN,
              counts: { open: OPEN.length, dismissed: DISMISSED.length },
              enabled: true,
              last_run: LAST_RUN,
              next_run_at: '2026-11-05T03:00:00Z',
            },
          })
        },
      )
      await page.route(
        (url) => url.pathname === '/api/routing/complexity-suggestions/sug-refund',
        (route) =>
          route.fulfill({
            json: {
              suggestion: OPEN[0],
              examples: [{ log_id: 'log-1', text: 'where is my refund for order 12' }, { log_id: 'log-gone' }],
            },
          }),
      )
      await page.route(
        (url) => /^\/api\/routing\/complexity-suggestions\/[^/]+\/status$/.test(url.pathname),
        (route) => {
          const id = new URL(route.request().url()).pathname.split('/')[4]
          const { status } = route.request().postDataJSON()
          statusCalls.push({ id, status })
          return route.fulfill({ json: { ...OPEN[0], id, status } })
        },
      )
      await page.route(
        (url) => url.pathname === '/api/routing/complexity-suggestions/runs',
        (route) => {
          if (route.request().method() !== 'POST') return route.fulfill({ json: { runs: [LAST_RUN] } })
          runStarts++
          runWindows.push(new URL(route.request().url()).searchParams.get('window'))
          return route.fulfill({ status: 202, json: { run_id: '6f1d2c3a-8b4e-4f5a-9c7d-1e2f3a4b5c6d' } })
        },
      )
      await page.route(
        (url) => url.pathname === '/api/routing/complexity-suggestions/runs/estimate',
        (route) => {
          const window = new URL(route.request().url()).searchParams.get('window')
          const requests = window === '24h' ? 1200 : 8400
          return route.fulfill({ json: { requests, clustered: requests, assigned: 0, skipped: 0, max_model_calls: 400 } })
        },
      )
      await page.route(
        (url) => url.pathname === '/api/routing/complexity-suggestions/test',
        (route) => {
          const body = route.request().postDataJSON()
          return route.fulfill({
            json: {
              phrases: body.phrases.map((p: { tier: string; text: string }) => ({
                ...p,
                nearest_existing: { tier: 'MEDIUM', phrase: 'summarize this support thread', similarity: 0.46, accepted: true, candidate: false },
              })),
              examples: [
                {
                  log_id: 'log-1',
                  text: 'where is my refund for order 12',
                  current: { tier: 'MEDIUM', phrase: 'summarize this support thread', similarity: 0.46, accepted: true, candidate: false },
                  with_phrases: { tier: body.phrases[0].tier, phrase: body.phrases[0].text, similarity: 0.91, accepted: true, candidate: true },
                  changed: true,
                },
              ],
              taken_over: 1,
            },
          })
        },
      )
    })

    test.afterEach(async ({ page }) => {
      await page.unrouteAll({ behavior: 'ignoreErrors' })
    })

    test('should open the default router from the old complexity router URL', async ({ page }) => {
      await page.goto('/workspace/complexity-router?tab=suggestions')
      await expect(page).toHaveURL(/\/workspace\/model-routers\?.*router=default/)
      await expect(page).toHaveURL(/tab=suggestions/)
      await expect(page.getByTestId('model-router-name')).toHaveText('Default')
    })

    test('should list pending suggestions with their reasons and examples', async ({ page }) => {
      await page.goto('/workspace/model-routers?router=default')
      await expect(page.getByTestId('complexity-router-tab-suggestions-count')).toHaveText('2', { timeout: 10000 })
      await page.getByTestId('complexity-router-tab-suggestions').click()

      const row = page.getByTestId('complexity-suggestion-row-sug-refund')
      await expect(row).toContainText('where is my refund')
      await expect(row).toContainText('Weak match')
      await expect(row).toContainText('214 requests')
      await expect(page.getByTestId('complexity-suggestions-next-run')).toBeVisible()
      await expect(page.getByTestId('complexity-suggestion-stale-sug-migration')).toContainText('Earlier phrase bank')
      await expect(page.getByTestId('complexity-suggestion-stale-sug-refund')).toHaveCount(0)
      expect(listRouters.every((id) => id === 'default')).toBe(true)

      await page.getByTestId('complexity-suggestion-expand-sug-refund').click()
      const details = page.getByTestId('complexity-suggestion-details-sug-refund')
      await expect(details).toContainText('summarize this support thread')
      const examples = page.getByTestId('complexity-suggestion-examples-sug-refund')
      await expect(examples).toContainText('where is my refund for order 12')
      await expect(examples).toContainText('1 example is not shown')

      await page.getByTestId('complexity-suggestions-search-input').fill('migration')
      await expect(page.getByTestId('complexity-suggestion-row-sug-refund')).toHaveCount(0)
      await expect(page.getByTestId('complexity-suggestion-row-sug-migration')).toBeVisible()

      await page.getByTestId('complexity-suggestions-list-dismissed').click()
      await expect(page.getByTestId('complexity-suggestion-row-sug-old')).toHaveCount(0)
      await page.getByTestId('complexity-suggestions-search-input').fill('')
      await expect(page.getByTestId('complexity-suggestion-row-sug-old')).toContainText('translate this paragraph')
    })

    test('should stage a suggestion, edit it, and accept it when the config is saved', async ({ page }) => {
      await page.goto('/workspace/model-routers?router=default&tab=suggestions')
      await page.getByTestId('complexity-suggestion-expand-sug-refund').click()
      await page.getByTestId('complexity-suggestion-add-sug-refund').click()

      // Staged: gone from the list, shown in its tier, and the save is pending.
      await expect(page.getByTestId('complexity-suggestion-row-sug-refund')).toHaveCount(0)
      await expect(page.getByTestId('complexity-suggestions-staged-phrase-sug-refund-0')).toContainText('where is my refund')
      await page.getByTestId('complexity-suggestions-staged-edit-sug-refund-0').click()
      const stagedInput = page.getByTestId('complexity-suggestions-staged-input-sug-refund-0')
      await expect(stagedInput).toHaveValue('where is my refund')
      await expect(page.getByTestId('complexity-router-footer-note')).toContainText('1 suggested phrase staged')

      await stagedInput.fill('where is my refund for an order')
      await stagedInput.press('Enter')
      await page.getByTestId('complexity-router-save-changes-button').click()

      await expect.poll(() => saved.length).toBe(1)
      const keywords = saved[0].keywords as Record<string, string[]>
      expect(keywords.simple_keywords).toEqual(['hello', 'where is my refund for an order'])
      // The suggestions block rides along unchanged.
      expect(saved[0].suggestions).toMatchObject({ enabled: true, lookback_days: 7, schedule: { every: '1d', at: '03:00', timezone: 'UTC' } })
      await expect.poll(() => statusCalls).toEqual([{ id: 'sug-refund', status: 'accepted' }])
    })

    test('should take a staged suggestion back without saving it', async ({ page }) => {
      await page.goto('/workspace/model-routers?router=default&tab=suggestions')
      await page.getByTestId('complexity-suggestion-expand-sug-migration').click()
      await page.getByTestId('complexity-suggestion-add-menu-sug-migration').click()
      await page.getByTestId('complexity-suggestion-add-sug-migration-medium').click()
      await expect(page.getByTestId('complexity-suggestions-staged-medium')).toContainText('+1 new')

      await page.getByTestId('complexity-suggestions-staged-undo-sug-migration').click()
      await expect(page.getByTestId('complexity-suggestion-row-sug-migration')).toBeVisible()
      await expect(page.getByTestId('complexity-router-save-changes-button')).toBeDisabled()
    })

    test('should add a selection to a tier, and a dragged row to the tier it is dropped on', async ({ page }) => {
      await page.goto('/workspace/model-routers?router=default&tab=suggestions')
      const header = page.getByTestId('complexity-suggestions-list-header')
      await expect(header).toContainText('2 suggestions')

      await page.getByTestId('complexity-suggestion-select-sug-refund').click()
      await expect(header).toContainText('1 of 2 selected')
      await expect(page.getByTestId('complexity-suggestions-bulk-dismiss')).toHaveText('Dismiss 1')
      await page.getByTestId('complexity-suggestions-bulk-add').click()
      await page.getByTestId('complexity-suggestions-bulk-add-complex').click()
      await expect(page.getByTestId('complexity-suggestion-row-sug-refund')).toHaveCount(0)
      await expect(page.getByTestId('complexity-suggestions-staged-complex')).toContainText('where is my refund')
      await expect(header).toContainText('1 suggestion')

      await page.getByTestId('complexity-suggestion-row-sug-migration').dragTo(page.getByTestId('complexity-suggestions-staged-simple'))
      await expect(page.getByTestId('complexity-suggestion-row-sug-migration')).toHaveCount(0)
      await expect(page.getByTestId('complexity-suggestions-staged-simple')).toContainText('plan a database migration')
      await expect(page.getByTestId('complexity-router-footer-note')).toContainText('2 suggested phrases staged')
    })

    test('should dismiss a suggestion and start a run', async ({ page }) => {
      await page.goto('/workspace/model-routers?router=default&tab=suggestions')
      await page.getByTestId('complexity-suggestion-expand-sug-migration').click()
      await page.getByTestId('complexity-suggestion-dismiss-sug-migration').click()
      await expect.poll(() => statusCalls).toEqual([{ id: 'sug-migration', status: 'dismissed' }])

      await page.getByTestId('complexity-suggestions-run-now-button').click()
      const dialog = page.getByTestId('complexity-suggestions-run-dialog')
      await expect(dialog).toBeVisible()
      // One line of copy; the estimate only gates Start and shows nothing when
      // there is something to run on.
      await expect(dialog).toContainText('Runs in the background inside your gateway, outside the request path.')
      await expect(dialog).not.toContainText('requests in the window')
      await expect(page.getByTestId('complexity-suggestions-run-estimate')).toHaveCount(0)
      const startButton = page.getByTestId('complexity-suggestions-run-start-button')
      await expect(startButton).toBeEnabled()
      // The 7-day lookback offers 24 hours and 7 days, and starts on 7 days.
      await page.getByTestId('complexity-suggestions-run-window-select').click()
      await expect(page.getByTestId('complexity-suggestions-run-window-14d')).toHaveCount(0)
      await page.getByTestId('complexity-suggestions-run-window-24h').click()
      await expect(startButton).toBeEnabled()
      await startButton.click()
      await expect.poll(() => runStarts).toBe(1)
      expect(runWindows).toEqual(['24h'])
      await expect(dialog).toBeHidden()
    })

    test('should show a started run\'s suggestions without a reload', async ({ page }) => {
      const STARTED = '6f1d2c3a-8b4e-4f5a-9c7d-1e2f3a4b5c6d'
      const FRESH = { ...OPEN[0], id: 'sug-fresh', phrases: ['reset my password'], request_count: 9 }
      let listedAfterStart = 0
      // The gateway queues a run before the run records itself, so the lists
      // refetched right after the start (the tab's and the tab count's) still
      // show the previous run.
      await page.route(
        (url) => url.pathname === '/api/routing/complexity-suggestions',
        (route) => {
          if (runStarts === 0) return route.fallback()
          listedAfterStart++
          const fresh = listedAfterStart > 2
          return route.fulfill({
            json: {
              router_id: 'default',
              suggestions: fresh ? [...OPEN, FRESH] : OPEN,
              counts: { open: OPEN.length + (fresh ? 1 : 0), dismissed: DISMISSED.length },
              enabled: true,
              last_run: fresh ? { ...LAST_RUN, id: STARTED, triggered_by: 'manual' } : LAST_RUN,
              next_run_at: '2026-11-05T03:00:00Z',
            },
          })
        },
      )
      await page.goto('/workspace/model-routers?router=default&tab=suggestions')
      await page.getByTestId('complexity-suggestions-run-now-button').click()
      await expect(page.getByTestId('complexity-suggestions-run-start-button')).toBeEnabled()
      await page.getByTestId('complexity-suggestions-run-start-button').click()
      await expect.poll(() => runStarts).toBe(1)
      await expect(page.getByTestId('complexity-suggestions-run-now-button')).toBeDisabled()

      await expect(page.getByTestId('complexity-suggestion-row-sug-fresh')).toBeVisible({ timeout: 15000 })
      await expect(page.getByTestId('complexity-router-tab-suggestions-count')).toHaveText('3')
      await expect(page.getByTestId('complexity-suggestions-run-now-button')).toBeEnabled()
    })

    test('should mark a suggestion that adds two phrases', async ({ page }) => {
      const PAIR = { ...OPEN[0], id: 'sug-pair', phrases: ['translate this to formal german', 'formal german translation please'] }
      await page.route(
        (url) => url.pathname === '/api/routing/complexity-suggestions',
        (route) =>
          route.fulfill({
            json: { suggestions: [PAIR], counts: { open: 1, dismissed: 0 }, enabled: true, last_run: LAST_RUN },
          }),
      )
      await page.goto('/workspace/model-routers?router=default&tab=suggestions')
      const row = page.getByTestId('complexity-suggestion-row-sug-pair')
      await expect(row).toContainText('translate this to formal german')
      await expect(row).toContainText('formal german translation please')
      await expect(page.getByTestId('complexity-suggestion-phrase-count-sug-pair')).toHaveText('2 phrases')
    })

    test('should decide suggestion tiers with a decision model, sending only the tiers edited', async ({ page }) => {
      await page.goto('/workspace/model-routers?router=default&tab=suggestions')
      await page.getByTestId('complexity-suggestions-settings-button').click()
      const sheet = page.getByTestId('complexity-suggestions-settings-sheet')
      await expect(sheet).toBeVisible()
      // No fallback model to explain away: both steps name their model.
      await expect(sheet).not.toContainText('LLM fallback model')
      await expect(page.getByTestId('complexity-suggestions-phrase-section')).toBeVisible()

      await page.getByTestId('complexity-suggestions-tier-classifier-select').click()
      await page.getByTestId('complexity-suggestions-tier-classifier-option-decision').click()
      await expect(page.getByTestId('complexity-suggestions-tier-provider-select')).toBeVisible()
      // The question shows the shipped text until it is edited.
      const question = page.getByTestId('complexity-suggestions-tier-instructions-input')
      await expect(question).toHaveValue('Pick the tier by the work asked.')
      await expect(page.getByTestId('complexity-suggestions-tier-instructions-state')).toHaveText('Shipped')
      await question.fill('Judge the work each request asks for.')
      await expect(page.getByTestId('complexity-suggestions-tier-instructions-state')).toHaveText('Edited')

      // Each tier's choice shows the router's own phrases as its examples.
      const complex = page.getByTestId('complexity-suggestions-tier-criteria-tier-complex')
      await expect(complex).toContainText('Design with trade-offs.')
      await expect(complex).toContainText('design a system')
      await page.getByTestId('complexity-suggestions-tier-criteria-complex-definition-edit-button').click()
      await page.getByTestId('complexity-suggestions-tier-criteria-complex-definition-input').fill('Multi-step design work.')
      await page.getByTestId('complexity-suggestions-settings-save-button').click()

      await expect.poll(() => saved.length).toBe(1)
      expect(saved[0].suggestions).toMatchObject({
        provider: 'openai',
        model: 'gpt-4.1-mini',
        // The router has no decision model of its own, so the shipped one.
        tier: {
          classifier: 'decision',
          provider: 'typesafe',
          model: 'jev-latest',
          instructions: 'Judge the work each request asks for.',
          // Only the edited tier is frozen; the others stay generated.
          criteria: { COMPLEX: { definition: 'Multi-step design work.', signals: ['trade-offs'], examples: ['design a system'] } },
        },
      })
      const tier = (saved[0].suggestions as { tier: { criteria: Record<string, unknown> } }).tier
      expect(Object.keys(tier.criteria)).toEqual(['COMPLEX'])
    })

    test('should show and edit the whole llm tier prompt, examples included', async ({ page }) => {
      await page.goto('/workspace/model-routers?router=default&tab=suggestions')
      await page.getByTestId('complexity-suggestions-settings-button').click()
      const prompt = page.getByTestId('complexity-suggestions-tier-prompt-input')
      // Unedited, the editor holds the generated prompt, examples and all.
      await expect(prompt).toHaveValue(TIER_PROMPT)
      await expect(page.getByTestId('complexity-suggestions-tier-prompt-state')).toHaveText('Generated')
      await expect(page.getByTestId('complexity-suggestions-tier-prompt-reset-button')).toHaveCount(0)

      const edited = TIER_PROMPT.replace('MEDIUM:\n- summarize this support thread', 'MEDIUM:\n- summarize this support thread\n- draft a refund reply')
      await prompt.fill(edited)
      await expect(page.getByTestId('complexity-suggestions-tier-prompt-state')).toHaveText('Edited')
      // Back to generated: the editor shows the generated prompt again.
      await page.getByTestId('complexity-suggestions-tier-prompt-reset-button').click()
      await expect(prompt).toHaveValue(TIER_PROMPT)
      await expect(page.getByTestId('complexity-suggestions-tier-prompt-state')).toHaveText('Generated')

      await prompt.fill(edited)
      await page.getByTestId('complexity-suggestions-settings-save-button').click()
      await expect.poll(() => saved.length).toBe(1)
      expect(saved[0].suggestions).toMatchObject({ tier: { classifier: 'llm', prompt: edited } })
    })

    test('should not save suggestions turned on without a model to write phrases', async ({ page }) => {
      await page.route(
        (url) => url.pathname === '/api/routing/model-routers/default',
        (route) => {
          if (route.request().method() === 'PUT') return route.fallback()
          const { provider: _p, model: _m, tier: _t, ...rest } = CONFIG.suggestions
          return route.fulfill({ json: { ...CONFIG, suggestions: { ...rest, enabled: false } } })
        },
      )
      await page.goto('/workspace/model-routers?router=default&tab=suggestions')
      await page.getByTestId('complexity-suggestions-settings-button').click()
      await page.getByTestId('complexity-suggestions-enabled-switch').click()
      await page.getByTestId('complexity-suggestions-settings-save-button').click()
      await expect(page.getByTestId('complexity-suggestions-settings-sheet')).toContainText('Choose the model that writes phrases')
      await expect(page.getByTestId('complexity-suggestions-settings-sheet')).toContainText('Choose the model that decides tiers')
      expect(saved).toHaveLength(0)
    })

    test('should not show or start on an estimate for another window', async ({ page }) => {
      // The 7-day estimate answers; the 24-hour one is held, then fails.
      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      await page.route(
        (url) => url.pathname === '/api/routing/complexity-suggestions/runs/estimate',
        async (route) => {
          if (new URL(route.request().url()).searchParams.get('window') !== '24h') return route.fallback()
          await held
          return route.fulfill({ status: 500, json: { error: { message: 'log store unavailable' } } })
        },
      )
      await page.goto('/workspace/model-routers?router=default&tab=suggestions')
      await page.getByTestId('complexity-suggestions-run-now-button').click()
      const estimate = page.getByTestId('complexity-suggestions-run-estimate')
      const startButton = page.getByTestId('complexity-suggestions-run-start-button')
      await expect(startButton).toBeEnabled()

      await page.getByTestId('complexity-suggestions-run-window-select').click()
      await page.getByTestId('complexity-suggestions-run-window-24h').click()
      // While the new window is estimated, the run cannot start on the old
      // window's estimate.
      await expect(startButton).toBeDisabled()

      release()
      await expect(estimate).toContainText('Could not estimate the run')
      await expect(startButton).toBeDisabled()
      expect(runStarts).toBe(0)
    })

    test('should not start a run on a window with nothing captured', async ({ page }) => {
      await page.route(
        (url) => url.pathname === '/api/routing/complexity-suggestions/runs/estimate',
        (route) => route.fulfill({ json: { requests: 0, clustered: 0, assigned: 0, skipped: 0, max_model_calls: 0 } }),
      )
      await page.goto('/workspace/model-routers?router=default&tab=suggestions')
      await page.getByTestId('complexity-suggestions-run-now-button').click()
      await expect(page.getByTestId('complexity-suggestions-run-estimate')).toContainText('No requests have been captured in this window yet.')
      await expect(page.getByTestId('complexity-suggestions-run-start-button')).toBeDisabled()
    })

    test('should say why nothing is captured when the vector store is Chromem', async ({ page }) => {
      await page.route(
        (url) => url.pathname === '/api/routing/model-routers/default/status',
        (route) =>
          route.fulfill({
            json: {
              state: 'ready',
              loaded: 3,
              total: 3,
              cached_phrases: 3,
              capture_available: false,
              capture_unavailable_reason: 'embedded_vector_store',
              suggestion_default_instructions: 'Write short reference phrases.',
              suggestion_default_tier_instructions: 'Pick the tier by the work asked.',
              suggestion_default_tier_prompt: TIER_PROMPT,
              suggestion_default_tier_criteria: TIER_CRITERIA,
            },
          }),
      )
      await page.goto('/workspace/model-routers?router=default&tab=suggestions')
      const callout = page.getByTestId('complexity-suggestions-capture-unavailable')
      await expect(callout).toContainText('Chromem')
      await expect(callout).toContainText('shared vector store')
      // Nothing to run on, so no Run now.
      await expect(page.getByTestId('complexity-suggestions-run-now-button')).toHaveCount(0)
    })

    test('should test an edited phrase before staging it', async ({ page }) => {
      await page.goto('/workspace/model-routers?router=default&tab=suggestions')
      await page.getByTestId('complexity-suggestion-expand-sug-refund').click()
      await page.getByTestId('complexity-suggestion-test-sug-refund').click()
      const dialog = page.getByTestId('complexity-phrase-test-dialog')
      await expect(dialog).toBeVisible()
      await page.getByTestId('complexity-phrase-test-phrase-input-0').fill('refund status for my order')
      await page.getByTestId('complexity-phrase-test-run-button').click()
      await expect(page.getByTestId('complexity-phrase-test-taken-over')).toContainText('100%')
      await expect(page.getByTestId('complexity-phrase-test-example-log-1')).toContainText('where is my refund for order 12')

      await page.getByTestId('complexity-phrase-test-add-button').click()
      await expect(dialog).toBeHidden()
      await expect(page.getByTestId('complexity-suggestions-staged-phrase-sug-refund-0')).toContainText('refund status for my order')
    })

    test('should drop a phrase test result once the phrases or tier it was run on change', async ({ page }) => {
      await page.goto('/workspace/model-routers?router=default&tab=suggestions')
      await page.getByTestId('complexity-suggestion-expand-sug-refund').click()
      await page.getByTestId('complexity-suggestion-test-sug-refund').click()
      const result = page.getByTestId('complexity-phrase-test-result')
      const runButton = page.getByTestId('complexity-phrase-test-run-button')
      const phraseInput = page.getByTestId('complexity-phrase-test-phrase-input-0')

      await runButton.click()
      await expect(result).toBeVisible()
      await phraseInput.fill('refund status for my order')
      await expect(result).toHaveCount(0)

      await runButton.click()
      await expect(result).toBeVisible()
      await page.getByTestId('complexity-phrase-test-tier-select').click()
      await page.getByRole('option', { name: 'Complex' }).click()
      await expect(result).toHaveCount(0)

      // An answer still in flight when the phrase changes is for the old
      // phrase, so it is not shown.
      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      await page.route(
        (url) => url.pathname === '/api/routing/complexity-suggestions/test',
        async (route) => {
          await held
          await route.fallback()
        },
      )
      const answered = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/routing/complexity-suggestions/test')
      await runButton.click()
      await phraseInput.fill('refund status for order 12')
      release()
      await answered
      await expect(runButton).toBeEnabled()
      await expect(result).toHaveCount(0)
      await expect(page.getByTestId('complexity-phrase-test-error')).toHaveCount(0)
    })

    test('should filter the list to prompt-template suggestions', async ({ page }) => {
      const TEMPLATE = {
        ...OPEN[1],
        id: 'sug-template',
        tier: 'MEDIUM',
        category: 'template',
        phrases: ['write an image prompt for a scene'],
        reason: 'One image-prompt scaffold sent with different scenes.',
      }
      // Registered after beforeEach, so it answers first.
      await page.route(
        (url) => url.pathname === '/api/routing/complexity-suggestions',
        (route) =>
          route.fulfill({
            json: {
              suggestions: [...OPEN, TEMPLATE],
              counts: { open: OPEN.length + 1, dismissed: DISMISSED.length },
              enabled: true,
              last_run: LAST_RUN,
              next_run_at: '2026-11-05T03:00:00Z',
            },
          }),
      )
      await page.goto('/workspace/model-routers?router=default&tab=suggestions')
      await expect(page.getByTestId('complexity-suggestion-row-sug-refund')).toBeVisible()

      await page.getByTestId('complexity-suggestions-category-select').click()
      await expect(page.getByTestId('complexity-suggestions-category-option-template')).toContainText('Prompt template (1)')
      await page.getByTestId('complexity-suggestions-category-option-template').click()

      await expect(page.getByTestId('complexity-suggestion-row-sug-template')).toBeVisible()
      await expect(page.getByTestId('complexity-suggestion-row-sug-template')).toContainText('write an image prompt for a scene')
      await expect(page.getByTestId('complexity-suggestion-row-sug-refund')).toHaveCount(0)
      await expect(page.getByTestId('complexity-suggestion-row-sug-migration')).toHaveCount(0)
    })

    test('should save a weekly schedule from the settings sheet', async ({ page }) => {
      await page.goto('/workspace/model-routers?router=default&tab=suggestions')
      await page.getByTestId('complexity-suggestions-settings-button').click()
      await expect(page.getByTestId('complexity-suggestions-settings-sheet')).toBeVisible()

      await page.getByTestId('complexity-suggestions-every-select').click()
      await page.getByTestId('complexity-suggestions-every-option-1w').click()
      await expect(page.getByTestId('complexity-suggestions-weekday-select')).toBeVisible()
      // Cluster sizes are not edited in the UI.
      await expect(page.getByTestId('complexity-suggestions-max-clustered-input')).toHaveCount(0)
      await expect(page.getByTestId('complexity-suggestions-min-cluster-input')).toHaveCount(0)
      await page.getByTestId('complexity-suggestions-timezone-input').fill('Asia/Kolkata')
      await page.getByTestId('complexity-suggestions-settings-save-button').click()

      await expect.poll(() => saved.length).toBe(1)
      expect(saved[0].suggestions).toMatchObject({
        enabled: true,
        schedule: { every: '1w', at: '03:00', weekday: 'monday', timezone: 'Asia/Kolkata' },
        // Set outside the UI, they ride along unchanged.
        max_clustered_requests: 20000,
        min_cluster_requests: 6,
      })
    })

    test('should tie each settings error to its field for assistive tech', async ({ page }) => {
      await page.goto('/workspace/complexity-router?tab=suggestions')
      await page.getByTestId('complexity-suggestions-settings-button').click()
      await expect(page.getByTestId('complexity-suggestions-settings-sheet')).toBeVisible()

      const sample = page.getByTestId('complexity-suggestions-sample-input')
      const timezone = page.getByTestId('complexity-suggestions-timezone-input')
      const lookback = page.getByTestId('complexity-suggestions-lookback-input')
      await sample.fill('0')
      await timezone.fill('')
      await page.getByTestId('complexity-suggestions-settings-save-button').click()

      for (const [input, id] of [
        [sample, 'suggestions-sample-error'],
        [timezone, 'suggestions-timezone-error'],
      ] as const) {
        await expect(input).toHaveAttribute('aria-invalid', 'true')
        await expect(input).toHaveAttribute('aria-describedby', id)
        await expect(page.locator(`#${id}`)).toBeVisible()
      }
      // A valid field carries neither attribute.
      await expect(lookback).not.toHaveAttribute('aria-invalid')
      await expect(lookback).not.toHaveAttribute('aria-describedby')
      expect(saved).toHaveLength(0)

      // Fixed, the attributes go with the message.
      await sample.fill('10')
      await timezone.fill('UTC')
      await expect(sample).not.toHaveAttribute('aria-invalid')
      await expect(sample).not.toHaveAttribute('aria-describedby')
      await expect(page.locator('#suggestions-sample-error')).toHaveCount(0)
      await expect(timezone).not.toHaveAttribute('aria-invalid')
    })
  })
})
