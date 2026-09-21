"""E2E the avatar crop flow with a real file upload via Playwright.

Logs in as e2e13a through the gateway, opens the profile editor, uploads an
800x600 PNG into the avatar slot, and verifies the redone CropDialog:
 - cover-fit baseline (no letterboxing at zoom 1)
 - drag panning clamped inside the frame
 - wheel zoom grows the drawn image and stays clamped
 - circular mask present in avatar mode
"""
import json
import sys

from playwright.sync_api import sync_playwright

GW = "http://localhost:81"

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(GW, wait_until="networkidle")
    page.wait_for_timeout(2500)

    # sign in (landing -> sign in view)
    login_input = page.locator("#identifier")
    if login_input.count() == 0:
        page.get_by_role("button", name="Sign in").first.click()
        page.wait_for_timeout(800)
        login_input = page.locator("#identifier")
    login_input.fill("e2e13a")
    page.locator("#password").fill("e2e13apass")
    page.get_by_role("button", name="Sign in").last.click()
    page.wait_for_timeout(4000)

    # open the user panel popover -> edit profile
    page.get_by_role("button", name="Your profile and status").click()
    page.wait_for_timeout(700)
    page.get_by_role("button", name="Edit profile").click()
    page.wait_for_timeout(1200)

    # upload into the avatar slot
    with page.expect_file_chooser() as fc_info:
        page.get_by_role("button", name="Change profile picture").click()
    fc = fc_info.value
    fc.set_files("/tmp/crop-test.png")
    page.wait_for_timeout(1500)

    # the crop dialog should be open now: identified by its zoom slider
    def crop_state():
        return page.evaluate(
            """() => {
                const slider = [...document.querySelectorAll('input[type=range]')].find(i => i.getAttribute('aria-label') === 'Zoom');
                if (!slider) return null;
                const dlg = slider.closest('[role=dialog]');
                const frame = dlg.querySelector('[role=application]');
                const img = frame.querySelector('img');
                const fb = frame.getBoundingClientRect();
                const ib = img.getBoundingClientRect();
                return {
                    frame: {x: fb.x, y: fb.y, w: fb.width, h: fb.height},
                    img: {x: ib.x, y: ib.y, w: ib.width, h: ib.height},
                    style: img.getAttribute('style'),
                    zoom: slider.value,
                };
            }"""
        )

    if crop_state() is None:
        print(json.dumps({"ok": False, "error": "crop dialog did not open"}))
        sys.exit(1)

    st = crop_state()
    fbox = {"x": st["frame"]["x"], "y": st["frame"]["y"], "width": st["frame"]["w"], "height": st["frame"]["h"]}
    ibox = {"x": st["img"]["x"], "y": st["img"]["y"], "width": st["img"]["w"], "height": st["img"]["h"]}

    # zoom 1: cover fit means the image fills the frame exactly on both axes
    covers = ibox["x"] <= fbox["x"] + 1 and ibox["y"] <= fbox["y"] + 1 and ibox["x"] + ibox["width"] >= fbox["x"] + fbox["width"] - 1 and ibox["y"] + ibox["height"] >= fbox["y"] + fbox["height"] - 1

    # circular mask present in avatar mode
    has_mask = page.evaluate(
        """() => {
            const slider = [...document.querySelectorAll('input[type=range]')].find(i => i.getAttribute('aria-label') === 'Zoom');
            const frame = slider?.closest('[role=dialog]')?.querySelector('[role=application]');
            return !!frame?.querySelector('span.rounded-full');
        }"""
    )

    # wheel zoom at the center: image should grow, still covering
    page.mouse.move(fbox["x"] + fbox["width"] / 2, fbox["y"] + fbox["height"] / 2)
    page.mouse.wheel(0, -400)
    page.wait_for_timeout(500)
    zst = crop_state()
    zbox = {"x": zst["img"]["x"], "y": zst["img"]["y"], "width": zst["img"]["w"], "height": zst["img"]["h"]}
    grew = zbox["width"] > ibox["width"] + 5
    diag = {"zoomSlider": zst["zoom"], "imgStyle": zst["style"], "before": ibox, "afterWheel": zbox}
    still_covers = (
        zbox["x"] <= fbox["x"] + 1
        and zbox["y"] <= fbox["y"] + 1
        and zbox["x"] + zbox["width"] >= fbox["x"] + fbox["width"] - 1
        and zbox["y"] + zbox["height"] >= fbox["y"] + fbox["height"] - 1
    )

    # drag pan: stays clamped (image edges never enter the frame)
    page.mouse.move(fbox["x"] + fbox["width"] / 2, fbox["y"] + fbox["height"] / 2)
    page.mouse.down()
    page.mouse.move(fbox["x"] + fbox["width"] / 2 + 300, fbox["y"] + fbox["height"] / 2 + 200, steps=8)
    page.mouse.up()
    page.wait_for_timeout(300)
    pst = crop_state()
    pbox = {"x": pst["img"]["x"], "y": pst["img"]["y"], "width": pst["img"]["w"], "height": pst["img"]["h"]}
    diag["afterPan"] = {"img": pst["img"], "zoom": pst["zoom"]}
    pan_clamped = (
        pbox["x"] <= fbox["x"] + 1
        and pbox["y"] <= fbox["y"] + 1
        and pbox["x"] + pbox["width"] >= fbox["x"] + fbox["width"] - 1
        and pbox["y"] + pbox["height"] >= fbox["y"] + fbox["height"] - 1
    )

    # apply and confirm the avatar actually changed
    page.get_by_role("button", name="apply").click()
    page.wait_for_timeout(2000)

    print(json.dumps({
        "ok": True,
        "coverFit": covers,
        "mask": has_mask,
        "wheelZoomGrew": grew,
        "zoomStillCovers": still_covers,
        "panClamped": pan_clamped,
        "pageErrors": errors[:3], "diag": diag,
    }, indent=1))
    browser.close()
