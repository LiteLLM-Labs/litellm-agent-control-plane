import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const p = await b.newPage();

await p.goto('http://127.0.0.1:3211/');
await p.evaluate(() => sessionStorage.setItem('lite-harness-master-key', 'sk-local'));

// 1. Admin: MCP Servers page — edit deepwiki, discover tools
await p.goto('http://127.0.0.1:3211/mcp-servers/');
await p.waitForLoadState('networkidle');
await p.screenshot({ path: '/tmp/qa-01-mcp-servers.png' });

// Click edit on deepwiki
const editBtns = p.locator('button[aria-label*="Edit"], button:has-text("Edit")');
if (await editBtns.count() > 0) {
  await editBtns.last().click();
  await p.waitForTimeout(500);
  await p.screenshot({ path: '/tmp/qa-02-edit-deepwiki.png' });
  
  // Click Discover tools
  const discoverBtn = p.getByRole('button', { name: /discover tools/i });
  if (await discoverBtn.count() > 0) {
    await discoverBtn.click();
    await p.waitForTimeout(3000);
    await p.screenshot({ path: '/tmp/qa-03-tools-discovered.png' });
  }
  await p.keyboard.press('Escape');
}

// 2. User: Integrations — connect + test
await p.goto('http://127.0.0.1:3211/integrations/');
await p.waitForLoadState('networkidle');
await p.waitForTimeout(1500);
await p.screenshot({ path: '/tmp/qa-04-integrations.png' });

// Click deepwiki
const deepwikiCard = p.locator('div').filter({ hasText: /^deepwiki/ }).first();
const connectBtn = deepwikiCard.locator('button');
if (await connectBtn.count() > 0) {
  await connectBtn.click();
  await p.waitForTimeout(2000);
  await p.screenshot({ path: '/tmp/qa-05-deepwiki-dialog.png' });
}

await b.close();
console.log('done');
