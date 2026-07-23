#!/usr/bin/env python
"""Screenshot the new CasePropertyDetail page from local vite (port 5173).

Flow:
  1. Login as SI Rakesh Sharma via the MM quick-login button.
  2. Navigate to /caseproperty (the register).
  3. Click the first FIR/DD link.
  4. Wait for the detail page to mount.
  5. Take a full-page screenshot.

Run: python scripts/screenshot-case-detail.py
Output: ~/e-malkhana/case-property-detail-desktop.png
"""
import asyncio
import sys
from pathlib import Path
from playwright.async_api import async_playwright

OUT = Path('C:/Users/gsash/e-malkhana/case-property-detail-desktop.png')

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={'width': 1280, 'height': 900})
        page = await ctx.new_page()
        page.on('console', lambda m: print('CONSOLE', m.type, m.text[:200]))
        page.on('pageerror', lambda e: print('PAGEERR', str(e)[:300]))

        # Go straight to the dev server
        await page.goto('http://127.0.0.1:5173/', wait_until='networkidle', timeout=20000)
        # Quick-login as SI Rakesh Sharma
        try:
            await page.locator('button:has-text("SI Rakesh Sharma")').first.click(timeout=8000)
        except Exception as e:
            print('quicklogin failed:', e)
            # alternative: type login
            await page.locator('input[type=email], input[type=text]').first.fill('RS')
            await page.locator('input[type=password]').first.fill('demo')
            await page.locator('button[type=submit]').first.click()

        # Wait for dashboard / register to mount
        await page.wait_for_selector('.register-table, .register-cards, .case-detail', state='attached', timeout=15000)
        # Try to open an FIR/DD link directly.  Use the public gamma URL with encodeURIComponent-style id.
        # The detail route is /case-property/:item_id where item_id is the c.id (FIR x/y/2026) URL-encoded.
        # We'll just click the first row's link.
        # Click a FIR row that has a photo (FIR 112/2026 = MK-2026-000001 has photo).
        target_href = '/case-property/FIR+112%2F2026'
        try:
            link = page.locator(f'a.case-link[href*="{target_href}"], a.rc-fir[href*="{target_href}"]').first
            await link.click(timeout=4000)
        except Exception:
            # Fallback: navigate directly to the known FIR with a photo.
            await page.goto(f'http://127.0.0.1:5173{target_href}', wait_until='networkidle', timeout=20000)
        except Exception as e:
            print('click first link failed:', e)
            # navigate directly
            await page.goto('http://127.0.0.1:5173/case-property/FIR+112%2F2026', wait_until='networkidle', timeout=20000)

        # Wait for the detail header
        await page.wait_for_selector('.case-property-head', state='attached', timeout=15000)
        await page.wait_for_selector('.case-property-qr-img, .case-property-qr-placeholder', state='attached', timeout=8000)
        # small settle
        await page.wait_for_timeout(800)

        # Final probe
        head_visible = await page.locator('.case-property-head').is_visible()
        qr_img = await page.locator('.case-property-qr-img').count()
        qr_alt = await page.locator('.case-property-qr-placeholder').count()
        cards = await page.locator('.case-property-card').count()
        photo_imgs = await page.locator('.rc-photo-readonly img').count()
        photo_empty = await page.locator('.rc-photo-empty').count()
        steps = await page.locator('.case-property-card h3').all_text_contents()
        ctx_bar = await page.locator('.case-property-context').count()
        radios = await page.locator('.ro-radio-row').count()
        # Action toolbar
        action_bar = await page.locator('.case-detail-actions').count()
        action_buttons = await page.locator('.case-detail-actions button').all_text_contents()
        url = page.url
        print(f'HEAD visible:{head_visible}  cards:{cards}  steps:{steps}  qr:{qr_img}/{qr_alt}  photos:{photo_imgs}/{photo_empty}  ctx:{ctx_bar}  radios:{radios}  action_buttons:{action_buttons}  url={url}')

        await page.screenshot(path=str(OUT), full_page=True)
        print('SAVED', OUT)
        # Also screenshot above the fold only (for the inline preview)
        ABOVE = Path('C:/Users/gsash/e-malkhana/case-property-detail-above-fold.png')
        await page.screenshot(path=str(ABOVE), full_page=False)
        print('SAVED', ABOVE)
        await browser.close()

asyncio.run(main())
