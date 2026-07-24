import { chromium } from 'playwright';

const url = 'http://localhost:5173/dashboard';
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message)));

await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
// Click first quick-login button (MM-001)
await page.click('button:has-text("MM-001")');
await page.waitForTimeout(2500);

// Grab the register table location cells text
const locText = await page.evaluate(() => {
  const cells = Array.from(document.querySelectorAll('.register-table .col-location'));
  return cells.slice(0, 4).map(c => c.innerText.replace(/\s+/g, ' | '));
});
console.log('LOCATION cells (innerText):');
locText.forEach((t, i) => console.log(`  [${i}] ${t}`));

// Check for any mid-word break indicator: 'Narco' followed by 'tics' on separate lines
const raw = await page.evaluate(() => {
  const cells = Array.from(document.querySelectorAll('.register-table .col-location'));
  return cells.slice(0, 4).map(c => c.innerText);
});
console.log('\nRAW location text:');
raw.forEach((t, i) => console.log(`  [${i}] ${JSON.stringify(t)}`));

const bodyHasLogin = (await page.evaluate(() => document.body.innerText)).includes('sign-in');
console.log('\nStill on login screen?:', bodyHasLogin);
console.log('console/page errors:', errors.length);
errors.slice(0,5).forEach(e => console.log('  -', e.slice(0,300)));
await browser.close();
