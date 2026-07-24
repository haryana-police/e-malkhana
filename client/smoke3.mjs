import { chromium } from 'playwright';
const url = 'http://localhost:5173/dashboard';
const browser = await chromium.launch();
const page = await browser.newPage();
page.setDefaultTimeout(15000);
await page.goto(url, { waitUntil: 'load', timeout: 15000 });
try { await page.click('button:has-text("MM-001")', { timeout: 8000 }); } catch(e){ console.log('login click failed', e.message.slice(0,80)); }
await page.waitForTimeout(4000);
const info = await page.evaluate(() => {
  const tbl = document.querySelector('.register-table');
  const rows = tbl ? tbl.querySelectorAll('tbody tr').length : -1;
  const ths = tbl ? Array.from(tbl.querySelectorAll('thead th')).map(t=>t.innerText.replace(/\n/g,' ')) : [];
  let firstRowLocs = [];
  if (tbl) { const fr = tbl.querySelector('tbody tr'); if (fr) firstRowLocs = Array.from(fr.querySelectorAll('td')).map(td=>td.className + ' => ' + JSON.stringify(td.innerText.replace(/\n/g,' ').slice(0,40))); }
  return { hasTable: !!tbl, rows, ths, firstRowLocs };
});
console.log('hasTable:', info.hasTable, '| rows:', info.rows);
console.log('headers:', info.ths);
info.firstRowLocs.forEach(l => console.log('  ', l));
await browser.close();
