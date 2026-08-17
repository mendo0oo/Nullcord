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
let observer: MutationObserver | undefined;
let scheduled = false;

function addTitlebarLogo() {
    scheduled = false;

    for (const bar of document.querySelectorAll<HTMLElement>('[class*="titleBar_"], [class*="bar_"]')) {
        const bounds = bar.getBoundingClientRect();
        if (bounds.top > 48 || bounds.height > 64 || bar.querySelector(`.${LOGO_CLASS}`)) continue;

        const label = [...bar.querySelectorAll<HTMLElement>("*")].find(element =>
            element.childElementCount === 0 && element.textContent?.trim() === "Discord"
        );
        if (!label) continue;

        label.classList.add(ORIGINAL_CLASS);
        const logo = document.createElement("img");
        logo.className = LOGO_CLASS;
        logo.src = NULLCORD_TEXT_DATA_URL;
        logo.alt = "NullCord";
        label.after(logo);
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

    start() {
        scheduleRefresh();
        observer = new MutationObserver(scheduleRefresh);
        observer.observe(document.documentElement, { childList: true, subtree: true });
    },

    stop() {
        observer?.disconnect();
        observer = undefined;
        document.querySelectorAll(`.${LOGO_CLASS}`).forEach(element => element.remove());
        document.querySelectorAll(`.${ORIGINAL_CLASS}`).forEach(element => element.classList.remove(ORIGINAL_CLASS));
    }
});
