import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 395, height: 720 });
page.setDefaultTimeout(15000);
await page.goto('http://localhost:5173/dashboard', { waitUntil: 'load', timeout: 15000 });
try { await page.click('button:has-text("MM-001")', { timeout: 8000 }); } catch(e){}
await page.waitForTimeout(4000);
// Check is-mobile class applied + the table rendered
const isMobile = await page.evaluate(() => !!document.querySelector('.panel.is-mobile'));
// Get the location cell innerText (preserves line breaks as \n)
const locs = await page.evaluate(() => {
  const cells = Array.from(document.querySelectorAll('.register-table td[class*="col-location"]'));
  return cells.slice(0,3).map(c => c.innerText);
});
console.log('isMobile panel present:', isMobile);
console.log('LOCATION cells (raw, \n = line break):');
locs.forEach((t,i)=>console.log(`  [${i}] ${JSON.stringify(t)}`));
// Detect mid-word break: 'Narco' line immediately followed by 'tics'
let broken = false;
locs.forEach(t => { const lines = t.split('\n'); for (let i=0;i<lines.length-1;i++){ if (lines[i].trim().endsWith('Narco') && lines[i+1].trim().startsWith('tics')) broken = true; } });
console.log('Narco/tics mid-word break present?:', broken);
await browser.close();
