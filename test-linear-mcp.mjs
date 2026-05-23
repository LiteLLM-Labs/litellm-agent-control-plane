import { chromium } from 'playwright';

const BASE = 'http://ae7fbba6b9bd94fb8ae7aa4640d70da1-1735666001.us-east-1.elb.amazonaws.com';
const AGENT_ID = '6b023d93-b570-4a60-a5bd-6a0b630e4a7b';
const MASTER_KEY = '5d6d52af44d3f3db3a87d66bc9fbf3ae9562b5b459cb65aea8bb973fdae72722';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(180_000);

// Sign in
await page.goto(`${BASE}/login`);
await page.locator('input[type=password]').fill(MASTER_KEY);
await page.getByRole('button', { name: /sign in/i }).click();
await page.waitForURL(/^(?!.*\/login).*$/, { timeout: 15_000 });

// Navigate to agent
await page.goto(`${BASE}/agents/${AGENT_ID}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);

// Click Spawn Session
await page.getByRole('button', { name: /spawn session/i }).first().waitFor({ timeout: 15_000 });
await page.getByRole('button', { name: /spawn session/i }).first().click();
await page.waitForURL(/\/sessions\/[a-f0-9-]+/, { timeout: 120_000 });
console.log('Session URL:', page.url());

// Wait for textarea
await page.locator('textarea').last().waitFor({ timeout: 120_000 });
console.log('Session ready, sending message...');

// Send message
await page.locator('textarea').last().fill('do you have access to linear mcp tools? list them');
await page.locator('textarea').last().press('Enter');

// Wait for "thinking..." to GO AWAY and a real response to appear
console.log('Waiting for agent to finish thinking...');
await page.waitForFunction(() => {
  // thinking... must be gone
  if (document.body.innerText.includes('thinking…')) return false;
  // some real response text about tools/mcp must exist
  const t = document.body.innerText.toLowerCase();
  return t.includes('yes') || t.includes('tool') || t.includes('linear') && !t.endsWith('list them\n');
}, { timeout: 240_000, polling: 3000 });

await page.screenshot({ path: '/tmp/ss-final.png' });
console.log('Screenshot saved to /tmp/ss-final.png');

const bodyText = await page.evaluate(() => document.body.innerText);
const lines = bodyText.split('\n').filter(l => l.trim());
// Find lines after the user message
const msgIdx = lines.findIndex(l => l.includes('do you have access'));
const responseLines = msgIdx >= 0 ? lines.slice(msgIdx + 1) : lines.slice(-50);
console.log('\n--- AGENT RESPONSE ---');
console.log(responseLines.slice(0, 50).join('\n'));

await browser.close();
