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
    const [status, setStatus] = useState("Local overrides stay on this installation. Publish shared badges through NullCord Identity instead.");

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

            {badges.length === 0 && <div className="nc-badge-empty">No local badge overrides. Shared badges are managed by NullCord Identity.</div>}
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
    description: "Local badge overrides for testing and personal customisation",
    authors: [Devs.NullCord],
    tags: ["Appearance", "Customisation"],
    dependencies: ["BadgeAPI"],
    enabledByDefault: true,

    settingsAboutComponent: ErrorBoundary.wrap(BadgeStudio),

    userProfileBadge: {
        id: "nullcord_badges",
        getBadges({ userId }) {
            const badges: ProfileBadge[] = [];
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
