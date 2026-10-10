const { defineConfig } = require("playwright/test");
module.exports = defineConfig({
  testDir: "./test/browser",
  use: { baseURL: "http://127.0.0.1:3179", browserName: "chromium" },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: "PORT=3179 DATA_PATH=/tmp/opencode/git-store-playwright-data OIDC_ISSUER= node index.js",
    url: "http://127.0.0.1:3179/ui/",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
