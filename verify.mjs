import { chromium } from 'playwright';

const MASTER_KEY = 'sk-dev-master-key-change-me';
const BASE = 'http://localhost:3004';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(60000);

const shot = async (name) => {
  const p = `/tmp/brain-home-${name}.png`;
  await page.screenshot({ path: p, fullPage: true });
  console.log(`screenshot: ${p}`);
};

// Login
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.locator('input').first().fill(MASTER_KEY);
await page.locator('input').first().press('Enter');
await page.waitForTimeout(1500);

// Type "hi" and submit
const homeInput = page.locator('textarea[placeholder="Ask or build anything"]');
await homeInput.click();
await homeInput.fill('hi');
await page.waitForFunction(() => {
  const b = document.querySelector('button[aria-label="Send"]');
  return b && !b.disabled;
}, { timeout: 5000 });

console.log('submitting "hi" from home page...');
await page.locator('button[aria-label="Send"]').click();

// Wait for navigation — session create now awaits initial_prompt (~2-3s)
await page.waitForURL('**/sessions/**', { timeout: 20000 });
console.log('navigated to:', page.url());
await shot('1-just-landed');

// Thread should already be populated (history written before response returned)
await page.waitForTimeout(2000);
await shot('2-after-load');

const body = await page.locator('body').innerText();
const hasHi = body.toLowerCase().includes('hi');
const hasResponse = body.includes('Hello') || body.includes('help') || body.includes('assist');
const hasSandboxReady = body.includes('Sandbox is ready. Send a message below.');

console.log('has "hi":', hasHi);
console.log('has assistant response:', hasResponse);
console.log('still shows empty state:', hasSandboxReady);

await browser.close();
console.log(hasSandboxReady ? 'FAIL - still empty' : 'PASS - thread populated on landing');
