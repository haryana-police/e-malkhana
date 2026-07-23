#!/usr/bin/env python
"""Screenshot the RegisterCaseModal at the moment of registration
(opened from /caseproperty/new), so we can compare against the new
CasePropertyDetail screenshot side-by-side."""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

OUT_ABOVE = Path('C:/Users/gsash/e-malkhana/register-modal-above-fold.png')
OUT_FULL  = Path('C:/Users/gsash/e-malkhana/register-modal-full.png')

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={'width': 1280, 'height': 900})
        page = await ctx.new_page()
        page.on('console', lambda m: print('CONSOLE', m.type, m.text[:200]) if m.type == 'error' else None)

        # Login then go straight to the registration form
        await page.goto('http://127.0.0.1:5173/', wait_until='networkidle', timeout=20000)
        try:
            await page.locator('button:has-text("SI Rakesh Sharma")').first.click(timeout=8000)
        except Exception:
            pass
        # Navigate via the URL — this route mounts RegisterCaseModal in `asPage` mode.
        await page.goto('http://127.0.0.1:5173/caseproperty/new', wait_until='networkidle', timeout=20000)
        # Wait for the form to render
        await page.wait_for_selector('.form-card, form', state='attached', timeout=15000)
        await page.wait_for_timeout(1500)

        # probe
        cards = await page.locator('.form-card, .form-grid').count()
        print(f'form mounts: {cards}')

        await page.screenshot(path=str(OUT_ABOVE), full_page=False)
        await page.screenshot(path=str(OUT_FULL), full_page=True)
        print('SAVED', OUT_ABOVE)
        print('SAVED', OUT_FULL)
        await browser.close()

asyncio.run(main())
