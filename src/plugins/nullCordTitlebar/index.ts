/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { NULLCORD_TEXT_DATA_URL } from "@shared/nullCordText";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

const LOGO_CLASS = "nc-titlebar-logo";
const ORIGINAL_CLASS = "nc-titlebar-original";
const DM_LOGO_CLASS = "nc-titlebar-dm-logo";
const DM_ORIGINAL_CLASS = "nc-titlebar-dm-original";
let observer: MutationObserver | undefined;
let scheduled = false;

function addTitlebarLogo() {
    scheduled = false;

    for (const bar of document.querySelectorAll<HTMLElement>('[class*="titleBar_"], [class*="bar_"]')) {
        const bounds = bar.getBoundingClientRect();
        if (bounds.top < -1 || bounds.top > 48 || bounds.height < 20 || bounds.height > 64 || bounds.width < 240 || bar.querySelector(`.${LOGO_CLASS}`)) continue;

        const walker = document.createTreeWalker(bar, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        let label: HTMLElement | null = null;
        while ((node = walker.nextNode())) {
            if (/^Discord(?: PTB| Canary)?$/i.test(node.textContent?.trim() ?? "")) {
                label = node.parentElement;
                break;
            }
        }
        if (!label) continue;

        label.classList.add(ORIGINAL_CLASS);
        const logo = document.createElement("img");
        logo.className = LOGO_CLASS;
        logo.src = NULLCORD_TEXT_DATA_URL;
        logo.alt = "NullCord";
        label.after(logo);
    }

    for (const bar of document.querySelectorAll<HTMLElement>('[class*="titleBar_"], [class*="bar_"]')) {
        if (bar.querySelector(`.${DM_LOGO_CLASS}`)) continue;
        const bounds = bar.getBoundingClientRect();
        if (bounds.top < -1 || bounds.top > 42 || bounds.height < 20 || bounds.height > 64) continue;

        const walker = document.createTreeWalker(bar, NodeFilter.SHOW_TEXT);
        let text: Node | null;
        while ((text = walker.nextNode())) {
            if (text.textContent?.trim() !== "Direct Messages" || !text.parentElement) continue;
            text.parentElement.classList.add(DM_ORIGINAL_CLASS);
            const logo = document.createElement("img");
            logo.className = DM_LOGO_CLASS;
            logo.src = NULLCORD_TEXT_DATA_URL;
            logo.alt = "NullCord";
            text.parentElement.after(logo);
            break;
        }
    }
}

function scheduleRefresh() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(addTitlebarLogo);
}

export default definePlugin({
    name: "NullCordTitlebar",
    description: "Adds the NullCord wordmark to Discord's desktop titlebar",
    authors: [Devs.NullCord],
    tags: ["Appearance", "Customisation"],
    enabledByDefault: true,
    required: true,

    start() {
        scheduleRefresh();
        observer = new MutationObserver(scheduleRefresh);
        observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
    },

    stop() {
        observer?.disconnect();
        observer = undefined;
        document.querySelectorAll(`.${LOGO_CLASS}`).forEach(element => element.remove());
        document.querySelectorAll(`.${ORIGINAL_CLASS}`).forEach(element => element.classList.remove(ORIGINAL_CLASS));
        document.querySelectorAll(`.${DM_LOGO_CLASS}`).forEach(element => element.remove());
        document.querySelectorAll(`.${DM_ORIGINAL_CLASS}`).forEach(element => element.classList.remove(DM_ORIGINAL_CLASS));
    }
});
