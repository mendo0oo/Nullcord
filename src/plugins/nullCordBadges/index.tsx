/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { BadgePosition, ProfileBadge } from "@api/Badges";
import { get, set } from "@api/DataStore";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { Button, Forms, React, TextInput, useEffect, UserStore, useState } from "@webpack/common";

interface BadgeConfig {
    id: string;
    userId: string;
    title: string;
    icon: string;
}

const STORAGE_KEY = "NullCord_customBadges";
const NULLCORD_ICON = "https://raw.githubusercontent.com/mendo0oo/Nullcord/main/installer/winres/icon.png";
let customBadges: BadgeConfig[] = [];

function validIcon(url: string) {
    try {
        return new URL(url).protocol === "https:";
    } catch {
        return false;
    }
}

function newBadge(): BadgeConfig {
    return {
        id: `nc-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        userId: UserStore.getCurrentUser()?.id ?? "",
        title: "My badge",
        icon: ""
    };
}

function BadgeStudio() {
    const [badges, setBadges] = useState<BadgeConfig[]>(customBadges);
    const [status, setStatus] = useState("Changes are stored locally on this NullCord installation.");

    useEffect(() => {
        get<BadgeConfig[]>(STORAGE_KEY).then(saved => {
            customBadges = saved ?? [];
            setBadges(customBadges);
        });
    }, []);

    function update(id: string, patch: Partial<BadgeConfig>) {
        setBadges(current => current.map(badge => badge.id === id ? { ...badge, ...patch } : badge));
    }

    async function save() {
        const clean = badges.filter(badge => badge.title.trim() && validIcon(badge.icon) && (/^\d{15,22}$/.test(badge.userId) || badge.userId === "*"));
        customBadges = clean;
        setBadges(clean);
        await set(STORAGE_KEY, clean);
        setStatus(`Saved ${clean.length} badge${clean.length === 1 ? "" : "s"}. Reopen a profile to refresh it.`);
    }

    return (
        <div className="nc-badge-studio">
            <header>
                <span>NULLCORD IDENTITY</span>
                <h2>Badge panel</h2>
                <p>Add an icon, hover title, and the Discord user ID that should receive it.</p>
            </header>

            <div className="nc-badge-list">
                {badges.map((badge, index) => (
                    <div className="nc-badge-row" key={badge.id}>
                        <div className="nc-badge-preview">
                            {validIcon(badge.icon) ? <img src={badge.icon} alt="" /> : <span>{index + 1}</span>}
                        </div>
                        <label>
                            <span>Title</span>
                            <TextInput value={badge.title} onChange={value => update(badge.id, { title: value })} placeholder="Early supporter" />
                        </label>
                        <label>
                            <span>Icon URL</span>
                            <TextInput value={badge.icon} onChange={value => update(badge.id, { icon: value })} placeholder="https://…/icon.png" />
                        </label>
                        <label>
                            <span>User ID</span>
                            <TextInput value={badge.userId} onChange={value => update(badge.id, { userId: value })} placeholder="Discord user ID" />
                        </label>
                        <button className="nc-badge-remove" onClick={() => setBadges(current => current.filter(item => item.id !== badge.id))}>×</button>
                    </div>
                ))}
            </div>

            {badges.length === 0 && <div className="nc-badge-empty">No custom badges yet. Your built-in NullCord badge is already active.</div>}
            <div className="nc-badge-actions">
                <button className="nc-badge-add" onClick={() => setBadges(current => [...current, newBadge()])}>＋ Add badge</button>
                <Button onClick={save}>Save badge panel</Button>
            </div>
            <Forms.FormText>{status}</Forms.FormText>
        </div>
    );
}

export default definePlugin({
    name: "NullCordBadges",
    description: "A panel for custom profile badge icons and hover titles",
    authors: [Devs.NullCord],
    tags: ["Appearance", "Customisation"],
    dependencies: ["BadgeAPI"],
    enabledByDefault: true,

    settingsAboutComponent: ErrorBoundary.wrap(BadgeStudio),

    userProfileBadge: {
        id: "nullcord_badges",
        getBadges({ userId }) {
            const badges: ProfileBadge[] = [];
            if (userId === UserStore.getCurrentUser()?.id) {
                badges.push({
                    id: "nullcord_user",
                    description: "NullCord User",
                    iconSrc: NULLCORD_ICON,
                    position: BadgePosition.START,
                    props: { style: { borderRadius: "5px" } }
                });
            }

            badges.push(...customBadges
                .filter(badge => (badge.userId === userId || badge.userId === "*") && validIcon(badge.icon) && badge.title)
                .map(badge => ({
                    id: badge.id,
                    description: badge.title,
                    iconSrc: badge.icon,
                    position: BadgePosition.START,
                    props: { style: { borderRadius: "5px" } }
                })));
            return badges;
        }
    },

    async start() {
        customBadges = await get<BadgeConfig[]>(STORAGE_KEY) ?? [];
    },

    stop() {
        customBadges = [];
    }
});
