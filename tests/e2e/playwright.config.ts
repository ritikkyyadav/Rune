import { defineConfig, devices } from "@playwright/test";

/**
 * The browser smoke for `gear web`.
 *
 * No `webServer` here on purpose: the spec stands up its own fake model and its
 * own `gear web` on a free port, in a temp GEAR_HOME, so two runs never share a
 * session database or a token and a failure names which of the two processes
 * broke. `webServer` would give us one fixed port and no fake model.
 *
 * One worker, no retries: this drives a real engine running real tools. A
 * retried flake here would hide exactly the kind of defect the smoke exists to
 * catch.
 */
export default defineConfig({
  testDir: "./specs",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
