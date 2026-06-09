import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

// Intercept API calls to see what's happening
page.on('response', r => {
  if (r.url().includes('mcp')) console.log('API:', r.status(), r.url().replace('http://127.0.0.1:3211',''));
});

await page.goto('http://127.0.0.1:3211/integrations/');
await page.evaluate(() => sessionStorage.setItem('lite-harness-master-key', 'sk-local'));
await page.reload();
await page.waitForTimeout(3000);
await page.screenshot({ path: '/tmp/integrations-check.png' });

const text = await page.locator('main').innerText().catch(() => '');
console.log('Page text:', text.slice(0, 300));
await browser.close();
