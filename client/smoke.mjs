import { chromium } from 'playwright';

const targets = [
  { name: 'localhost', url: 'http://localhost:5173/dashboard' },
  { name: 'gamma', url: 'https://e-malkhana-3jirar6kn-cyberkallisys-projects.vercel.app/dashboard' },
];

const browser = await chromium.launch();
for (const t of targets) {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message)));
  try {
    await page.goto(t.url, { waitUntil: 'networkidle', timeout: 30000 });
  } catch (e) {
    errors.push('GOTO FAIL: ' + e.message);
  }
  // does #root have content?
  const rootHtmlLen = await page.evaluate(() => (document.getElementById('root')?.innerHTML || '').length);
  const bodyText = (await page.evaluate(() => document.body.innerText || '')).slice(0, 300);
  console.log(`\n===== ${t.name} (${t.url}) =====`);
  console.log('root innerHTML length:', rootHtmlLen);
  console.log('body text (first 300):', JSON.stringify(bodyText));
  console.log('console/page errors:', errors.length);
  errors.slice(0, 8).forEach((e) => console.log('  -', e.slice(0, 500)));
  await page.close();
}
await browser.close();
