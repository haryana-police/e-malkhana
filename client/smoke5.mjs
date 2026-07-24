import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 395, height: 720 });
page.setDefaultTimeout(20000);
await page.goto('http://localhost:5173/dashboard', { waitUntil: 'load', timeout: 20000 });
try { await page.click('button:has-text("MM-001")', { timeout: 8000 }); } catch(e){}
await page.waitForTimeout(6000);
const rows = await page.evaluate(() => {
  const tbl = document.querySelector('.register-table');
  if (!tbl) return { err: 'no table' };
  const trs = tbl.querySelectorAll('tbody tr');
  const first = trs[0];
  const tds = first ? Array.from(first.querySelectorAll('td')).map(td => td.innerText) : [];
  // find which td contains Narcotics
  const locIdx = tds.findIndex(t => /Narcotics/i.test(t));
  return { rowCount: trs.length, locIdx, locText: locIdx>=0 ? tds[locIdx] : '(not found)', allTds: tds };
});
console.log(JSON.stringify(rows, null, 2));
// mid-word break check across whole table
const broken = await page.evaluate(() => {
  const cells = Array.from(document.querySelectorAll('.register-table tbody td'));
  return cells.some(c => { const L=c.innerText.split('\n'); for(let i=0;i<L.length-1;i++){ if(L[i].trim().endsWith('Narco')&&L[i+1].trim().startsWith('tics')) return true; } return false; });
});
console.log('mid-word Narco/tics break anywhere?:', broken);
await browser.close();
