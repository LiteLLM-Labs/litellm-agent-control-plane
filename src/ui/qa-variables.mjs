import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto('http://127.0.0.1:3211/');
await p.evaluate(() => sessionStorage.setItem('lite-harness-master-key', 'sk-local'));

// Admin: edit gmail server - check Variables + Static Headers UI
await p.goto('http://127.0.0.1:3211/mcp-servers/');
await p.waitForLoadState('networkidle');
await p.screenshot({ path: '/tmp/vars-01-list.png' });

// Click edit on first gmail (the real Composio one)
const rows = p.locator('tr, [role="row"]');
const gmailRow = p.locator('text=Gmail via Composio').first();
if (await gmailRow.count()) {
  const editBtn = gmailRow.locator('..').locator('button').last();
  await editBtn.click();
} else {
  // Try clicking edit via any visible edit button
  const btns = p.locator('button').filter({ hasText: /edit/i });
  if (await btns.count()) await btns.first().click();
}
await p.waitForTimeout(800);
await p.screenshot({ path: '/tmp/vars-02-edit-modal.png' });

await b.close();
console.log('done');
