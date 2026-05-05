import { expect, test } from '@playwright/test'

const HOMESERVER = 'http://localhost:28448'
const ECHO_USER = '@echo:localhost'

test('admin mentions @echo and receives an echo reply', async ({ page, request }) => {
  // 1. Open the bundled UI — verifies cycle 2's webStatic + the runtime config.
  await page.goto('/')
  await expect(page.getByRole('textbox', { name: /username|user/i })).toBeVisible()

  // 2. Log in as admin:admin via the UI.
  await page.getByRole('textbox', { name: /username|user/i }).fill('admin')
  await page.getByRole('textbox', { name: /password/i }).fill('admin')
  await page.getByRole('button', { name: /sign in|log in/i }).click()

  // 3. After login, the room list renders. The example's #welcome room is
  //    pre-created by BotPool.bootstrap when the daemon starts.
  await expect(page.getByText('welcome')).toBeVisible({ timeout: 30_000 })
  await page.getByText('welcome').click()

  // 4. Echo bot is registered as a virtual AS user — confirm via Matrix REST
  //    rather than chasing a member-list selector that varies by ZNC001 cycle.
  const profile = await request.get(`${HOMESERVER}/_matrix/client/v3/profile/${ECHO_USER}`)
  expect(profile.ok()).toBe(true)

  // 5. Send a message that mentions @echo.
  const composer = page.getByRole('textbox', { name: /message|compose/i })
  await composer.fill(`${ECHO_USER} ping`)
  await composer.press('Enter')

  // 6. Assert the echo reply lands in the room timeline. The shim sees the
  //    raw event body (mention prefix included), so it replies with
  //    `echo: @echo:localhost ping`.
  await expect(
    page.getByText('echo: @echo:localhost ping', { exact: true }),
  ).toBeVisible({ timeout: 30_000 })
})
