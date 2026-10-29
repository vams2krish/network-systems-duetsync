import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'./test',timeout:120000,expect:{timeout:20000},workers:1,
  use:{baseURL:process.env.BASE_URL||'http://127.0.0.1:3187',viewport:{width:1440,height:1180},trace:'retain-on-failure',screenshot:'only-on-failure'},
  webServer:process.env.BASE_URL?undefined:{command:'node scripts/test-server.mjs',url:'http://127.0.0.1:3187/healthz',reuseExistingServer:false},
});
