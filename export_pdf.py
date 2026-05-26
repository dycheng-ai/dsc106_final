"""
Capture all 6 visualization stages as full-page screenshots and
compile into a single PDF.

Requires: pip install playwright fpdf2
          python -m playwright install chromium
"""

import asyncio, os, time
from pathlib import Path
from playwright.async_api import async_playwright
from fpdf import FPDF
from PIL import Image

BASE_URL   = "http://localhost:8765"
OUT_DIR    = Path(__file__).parent / "data"
PDF_PATH   = Path(__file__).parent / "wildfire_visualizations.pdf"
VIEWPORT   = {"width": 1280, "height": 900}

STAGES = [
    (1, "1 – Weekly Fire Animation"),
    (2, "2 – VPD and Fire Season"),
    (3, "3 – VPD × Fire Bivariate Choropleth"),
    (4, "4 – VPD vs Lightning: The Comparison"),
    (5, "5 – Humidity × Fire Bivariate"),
    (6, "6 – Correlation Rankings"),
]

async def capture_stages():
    img_paths = []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        page    = await browser.new_page(viewport=VIEWPORT)

        print(f"Loading {BASE_URL} …")
        await page.goto(BASE_URL, wait_until="networkidle")
        # wait for D3 data to load + state cache warmup
        await page.wait_for_timeout(6000)

        # scroll into the scrolly section
        await page.evaluate("""
          const el = document.querySelector('.scrolly');
          if (el) {
            const top = el.getBoundingClientRect().top + window.scrollY + 200;
            window.scrollTo({ top, behavior: 'instant' });
          }
        """)

        for stage_num, label in STAGES:
            print(f"  capturing stage {stage_num}: {label}")
            await page.evaluate(f"goToStage({stage_num})")

            # extra wait for stage 3 panel reveal animation (600ms)
            if stage_num == 3:
                await page.wait_for_timeout(900)
            else:
                await page.wait_for_timeout(400)

            # for stage 2, set slider to peak week (index 11 ≈ late July)
            if stage_num == 2:
                await page.evaluate("""
                  const sl = document.getElementById('week-slider');
                  if (sl) { sl.value = 11; sl.dispatchEvent(new Event('input')); }
                """)
                await page.wait_for_timeout(300)

            # for stage 1, set slider to week index 15 (mid-September peak)
            if stage_num == 1:
                await page.evaluate("""
                  const sl = document.getElementById('week-slider');
                  if (sl) { sl.value = 15; sl.dispatchEvent(new Event('input')); }
                """)
                await page.wait_for_timeout(200)

            path = OUT_DIR / f"stage_{stage_num}.png"
            # screenshot only the graphic area
            el = await page.query_selector(".scrolly-graphic")
            if el:
                await el.screenshot(path=str(path))
            else:
                await page.screenshot(path=str(path))
            img_paths.append((str(path), label))
            print(f"    saved {path}")

        await browser.close()
    return img_paths


def build_pdf(img_paths):
    pdf = FPDF(orientation="L", unit="mm", format="A4")
    pdf.set_auto_page_break(False)
    pdf.set_margins(0, 0, 0)

    # cover page
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 28)
    pdf.set_text_color(26, 26, 26)
    pdf.cell(0, 60, "", ln=True)
    pdf.cell(0, 20, "What Actually Causes U.S. Wildfires?", align="C", ln=True)
    pdf.set_font("Helvetica", "", 14)
    pdf.set_text_color(107, 107, 107)
    pdf.cell(0, 12, "A Visual Investigation · DSC 106 Project 3", align="C", ln=True)
    pdf.cell(0, 8,  "Dylan Cheng, Vipra Bindal & Anwesha Nayak", align="C", ln=True)
    pdf.set_font("Helvetica", "", 11)
    pdf.cell(0, 20, "Data: NOAA GOES-16 (fires) · GridMET / Climatology Lab UC Merced (climate)", align="C", ln=True)

    # one page per stage
    A4_W_MM, A4_H_MM = 297, 210   # landscape A4
    for img_path, label in img_paths:
        pdf.add_page()

        # stage label strip at top
        pdf.set_fill_color(251, 250, 247)
        pdf.rect(0, 0, A4_W_MM, A4_H_MM, "F")
        pdf.set_font("Helvetica", "B", 9)
        pdf.set_text_color(107, 107, 107)
        pdf.set_xy(8, 4)
        pdf.cell(0, 6, label.replace("–", "-").replace("×", "x").upper(), ln=False)

        # fit image
        img = Image.open(img_path)
        iw, ih = img.size
        # max area: full width, leaving 12mm for header
        scale = min(A4_W_MM / (iw / 3.7795), (A4_H_MM - 12) / (ih / 3.7795))
        disp_w = iw / 3.7795 * scale
        disp_h = ih / 3.7795 * scale
        x_off  = (A4_W_MM - disp_w) / 2
        pdf.image(img_path, x=x_off, y=12, w=disp_w, h=disp_h)

    pdf.output(str(PDF_PATH))
    print(f"\nPDF saved → {PDF_PATH}  ({PDF_PATH.stat().st_size/1e3:.0f} KB)")


if __name__ == "__main__":
    imgs = asyncio.run(capture_stages())
    build_pdf(imgs)
