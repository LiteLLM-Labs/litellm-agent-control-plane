import { chromium } from 'playwright';
const BASE = 'http://ae7fbba6b9bd94fb8ae7aa4640d70da1-1735666001.us-east-1.elb.amazonaws.com';
const KEY = '5d6d52af44d3f3db3a87d66bc9fbf3ae9562b5b459cb65aea8bb973fdae72722';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(20_000);

await page.goto(`${BASE}/login`);
await page.locator('input[type=password]').fill(KEY);
await page.getByRole('button', { name: /sign in/i }).click();
await page.waitForURL(/^(?!.*\/login).*$/, { timeout: 15_000 });

await page.goto(`${BASE}/agents/c65e2463-19b1-4916-a9e0-0686f67a8422`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await page.screenshot({ path: '/tmp/agent-page.png' });

// Try spawn a session
const btn = page.getByRole('button', { name: /spawn session/i }).first();
const hasBtn = await btn.isVisible().catch(() => false);
if (hasBtn) {
  await btn.click();
  await page.waitForTimeout(5000);
  await page.screenshot({ path: '/tmp/after-spawn.png' });
}

const body = await page.evaluate(() => document.body.innerText);
const lines = body.split('\n').filter(l => l.trim().length > 3);
console.log(lines.slice(0, 25).join('\n'));
await browser.close();
