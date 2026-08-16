/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { get, set } from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { ErrorCard } from "@components/ErrorCard";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import type { User } from "@vencord/discord-types";
import { Button, Forms, React, TextInput, useEffect, UserStore, useState } from "@webpack/common";

interface Cosmetic {
    avatar?: string;
    banner?: string;
    updatedAt?: string;
}

interface CosmeticsResponse {
    users?: Record<string, Cosmetic>;
}

const logger = new Logger("NullCordCosmetics");
const PUBLISH_KEY_STORAGE_KEY = "NullCordCosmetics_publishKey";
const cosmetics = new Map<string, Cosmetic>();
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let originalGetAvatarURL: User["getAvatarURL"] | undefined;

function cleanBaseUrl(url: string) {
    return url.trim().replace(/\/+$/, "");
}

function validMediaUrl(value: string) {
    if (!value) return true;

    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.hostname === "127.0.0.1" || url.hostname === "localhost";
    } catch {
        return false;
    }
}

const settings = definePluginSettings({
    serverUrl: {
        type: OptionType.STRING,
        description: "NullCord cosmetics API URL",
        default: "http://127.0.0.1:8787",
        placeholder: "https://cosmetics.example.com"
    },
    preferDiscordBanner: {
        type: OptionType.BOOLEAN,
        description: "Keep a real Discord banner when both Discord and NullCord banners exist",
        default: false
    },
    animateAvatars: {
        type: OptionType.BOOLEAN,
        description: "Animate NullCord GIF avatars",
        default: true
    }
});

async function refreshCosmetics() {
    const base = cleanBaseUrl(settings.store.serverUrl);
    if (!base) return;

    try {
        const response = await fetch(`${base}/v1/cosmetics`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json() as CosmeticsResponse;
        cosmetics.clear();
        for (const [userId, cosmetic] of Object.entries(data.users ?? {})) {
            if (validMediaUrl(cosmetic.avatar ?? "") && validMediaUrl(cosmetic.banner ?? ""))
                cosmetics.set(userId, cosmetic);
        }
    } catch (error) {
        logger.warn("Could not refresh cosmetics", error);
    }
}

function CosmeticsStudio() {
    const current = cosmetics.get(UserStore.getCurrentUser()?.id) ?? {};
    const [avatar, setAvatar] = useState(current.avatar ?? "");
    const [banner, setBanner] = useState(current.banner ?? "");
    const [publishKey, setPublishKey] = useState("");
    const [status, setStatus] = useState<string>();
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        get<string>(PUBLISH_KEY_STORAGE_KEY).then(value => setPublishKey(value ?? ""));
    }, []);

    async function save() {
        if (!validMediaUrl(avatar) || !validMediaUrl(banner)) {
            setStatus("Use HTTPS media URLs (localhost is allowed for development).");
            return;
        }

        const userId = UserStore.getCurrentUser()?.id;
        const base = cleanBaseUrl(settings.store.serverUrl);
        if (!userId || !base || !publishKey) {
            setStatus("Set a server URL and publishing key above first.");
            return;
        }

        setSaving(true);
        setStatus(undefined);
        try {
            const response = await fetch(`${base}/v1/users/${userId}`, {
                method: "PUT",
                headers: {
                    "Authorization": `Bearer ${publishKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ avatar: avatar.trim() || null, banner: banner.trim() || null })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);

            await set(PUBLISH_KEY_STORAGE_KEY, publishKey);
            await refreshCosmetics();
            setStatus("Published. Other NullCord users will see it on their next refresh.");
        } catch (error) {
            setStatus(`Publish failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="nc-cosmetics-studio">
            <div className="nc-cosmetics-hero">
                <div>
                    <span className="nc-cosmetics-kicker">NULLCORD LABS</span>
                    <Forms.FormTitle tag="h2">Cosmetics Studio</Forms.FormTitle>
                    <Forms.FormText>Client-side identity, visible only to people using the same NullCord cosmetics server.</Forms.FormText>
                </div>
                <div className="nc-cosmetics-orb" />
            </div>

            <div className="nc-cosmetics-preview" style={{ backgroundImage: banner ? `url(${banner})` : undefined }}>
                <img src={avatar || UserStore.getCurrentUser()?.getAvatarURL(undefined, 256, true)} alt="Avatar preview" />
                <div>
                    <strong>{UserStore.getCurrentUser()?.globalName ?? UserStore.getCurrentUser()?.username}</strong>
                    <span>NullCord cosmetic preview</span>
                </div>
            </div>

            <label>
                <span>Private publishing key</span>
                <TextInput type="password" value={publishKey} onChange={setPublishKey} placeholder="nc_..." />
            </label>
            <label>
                <span>Animated avatar URL</span>
                <TextInput value={avatar} onChange={setAvatar} placeholder="https://.../avatar.gif" />
            </label>
            <label>
                <span>Profile banner URL</span>
                <TextInput value={banner} onChange={setBanner} placeholder="https://.../banner.gif" />
            </label>

            {status && <ErrorCard>{status}</ErrorCard>}
            <Button onClick={save} disabled={saving}>{saving ? "Publishing…" : "Publish cosmetics"}</Button>
            <Forms.FormText className="nc-cosmetics-note">
                This does not grant Discord Nitro or alter Discord's servers. Non-NullCord users see your normal Discord profile.
            </Forms.FormText>
        </div>
    );
}

export default definePlugin({
    name: "NullCordCosmetics",
    description: "NullCord-only animated avatars and profile banners",
    tags: ["Appearance", "Customisation"],
    authors: [Devs.NullCord],
    settings,
    enabledByDefault: true,
    patches: [
        {
            find: ':"SHOULD_LOAD");',
            replacement: {
                match: /\i(?:\?)?.getPreviewBanner\(\i,\i,\i\)(?=.{0,100}"COMPLETE")/,
                replace: "$self.getBannerUrl(arguments[0])||$&"
            }
        }
    ],

    settingsAboutComponent: ErrorBoundary.wrap(CosmeticsStudio),

    getBannerUrl({ displayProfile }: any) {
        if (!displayProfile?.userId) return;
        if (displayProfile.banner && settings.store.preferDiscordBanner) return;
        return cosmetics.get(displayProfile.userId)?.banner;
    },

    async start() {
        await refreshCosmetics();

        const currentUser = UserStore.getCurrentUser();
        const prototype = currentUser && Object.getPrototypeOf(currentUser);
        if (prototype?.getAvatarURL && !originalGetAvatarURL) {
            originalGetAvatarURL = prototype.getAvatarURL;
            prototype.getAvatarURL = function (guildId?: string | null, size?: number, canAnimate?: boolean, format?: string) {
                const custom = cosmetics.get(this.id)?.avatar;
                if (custom && (settings.store.animateAvatars || !custom.toLowerCase().includes(".gif"))) return custom;
                return originalGetAvatarURL!.call(this, guildId, size, canAnimate, format);
            };
        }

        refreshTimer = setInterval(refreshCosmetics, 5 * 60 * 1000);
    },

    stop() {
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = undefined;

        const prototype = UserStore.getCurrentUser() && Object.getPrototypeOf(UserStore.getCurrentUser());
        if (prototype && originalGetAvatarURL) prototype.getAvatarURL = originalGetAvatarURL;
        originalGetAvatarURL = undefined;
        cosmetics.clear();
    }
});
