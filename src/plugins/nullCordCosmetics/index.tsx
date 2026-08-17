/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { BadgePosition, ProfileBadge } from "@api/Badges";
import { get, set } from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { ErrorCard } from "@components/ErrorCard";
import { NULLCORD_ICON_DATA_URL } from "@shared/nullCordIcon";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { relaunch } from "@utils/native";
import definePlugin, { OptionType } from "@utils/types";
import type { User } from "@vencord/discord-types";
import { Button, ColorPicker, ConfirmModal, Constants, Forms, openModal, React, RestAPI, TextInput, useEffect, UserStore, useState } from "@webpack/common";
import type { CSSProperties } from "react";
import virtualMerge from "virtual-merge";

interface IdentityBadge {
    id: string;
    title: string;
    icon: string;
}

interface ManagedIdentityBadge extends IdentityBadge {
    scope: "all" | "users";
    userIds: string[];
}

export interface NetworkIdentity {
    avatar?: string;
    banner?: string;
    themeColors?: [number, number];
    displayNameStyle?: {
        fontId: number;
        effectId: number;
        colors: number[];
    };
    badges?: IdentityBadge[];
    joinedAt?: string;
    updatedAt?: string;
    revision?: number;
}

interface NetworkResponse {
    schemaVersion?: number;
    memberCount?: number;
    profiles?: Record<string, NetworkIdentity>;
    users?: Record<string, NetworkIdentity>;
    globalBadges?: ManagedIdentityBadge[];
}

const logger = new Logger("NullCordIdentity");
const PUBLISH_KEY_STORAGE_KEY = "NullCordIdentity_publishKey";
const LEGACY_PUBLISH_KEY_STORAGE_KEY = "NullCordCosmetics_publishKey";
const identities = new Map<string, NetworkIdentity>();
let managedBadges: ManagedIdentityBadge[] = [];
const listeners = new Set<() => void>();
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let eventSource: EventSource | undefined;
let originalGetAvatarURL: User["getAvatarURL"] | undefined;
let originalRestPatch: typeof RestAPI.patch | undefined;
let originalGetUser: typeof UserStore.getUser | undefined;
let originalGetCurrentUser: typeof UserStore.getCurrentUser | undefined;
let authorizationPromise: Promise<string> | undefined;
let networkEtag: string | undefined;
let memberCount = 0;
let lastSyncedAt: Date | undefined;

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

function validIdentity(value: NetworkIdentity): value is NetworkIdentity {
    const validColors = (colors: unknown, minimum: number, maximum: number) => Array.isArray(colors) && colors.length >= minimum && colors.length <= maximum &&
        colors.every(color => Number.isInteger(color) && color >= 0 && color <= 0xffffff);
    const style = value?.displayNameStyle;
    return Boolean(value && validMediaUrl(value.avatar ?? "") && validMediaUrl(value.banner ?? "") &&
        (value.themeColors == null || validColors(value.themeColors, 2, 2)) &&
        (style == null || Number.isInteger(style.fontId) && style.fontId >= 1 && style.fontId <= 16 &&
            Number.isInteger(style.effectId) && style.effectId >= 1 && style.effectId <= 8 && validColors(style.colors, 0, 5)));
}

function withNetworkDisplayNameStyle<T extends User | undefined>(user: T): T {
    if (!user) return user;
    const style = identities.get(user.id)?.displayNameStyle;
    if (!style) return user;

    const displayNameStyles = {
        fontId: style.fontId,
        effectId: style.effectId,
        font_id: style.fontId,
        effect_id: style.effectId,
        colors: [...style.colors]
    };
    try {
        user.displayNameStyles = displayNameStyles as any;
    } catch {
        Object.defineProperty(user, "displayNameStyles", { configurable: true, enumerable: true, value: displayNameStyles, writable: true });
    }
    return user;
}

function patchNetworkProfile(profile: any) {
    const colors = identities.get(profile?.userId)?.themeColors;
    return colors ? virtualMerge(profile, { premiumType: 2, themeColors: colors }) : profile;
}

async function uploadNativeMedia(userId: string, publishingKey: string, kind: "avatar" | "banner", dataUrl: string) {
    const source = await fetch(dataUrl);
    const blob = await source.blob();
    const base = cleanBaseUrl(settings.store.serverUrl);
    const response = await fetch(`${base}/v1/users/${userId}/media/${kind}`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${publishingKey}`, "Content-Type": blob.type },
        body: blob
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    return result.url as string;
}

async function publishNativeProfile(userId: string, publishingKey: string, patch: Partial<NetworkIdentity>) {
    const current = identities.get(userId) ?? {};
    const next = { ...current, ...patch, badges: undefined };
    const base = cleanBaseUrl(settings.store.serverUrl);
    const response = await fetch(`${base}/v1/users/${userId}`, {
        method: "PUT",
        headers: { "Authorization": `Bearer ${publishingKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(next)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    const saved = result.profile as NetworkIdentity | undefined;
    if (!saved) throw new Error("The Identity server did not confirm the saved profile. Update the private server package before trying again.");

    for (const key of ["avatar", "banner", "themeColors", "displayNameStyle"] as const) {
        if (!Object.hasOwn(patch, key)) continue;
        if (JSON.stringify(saved[key] ?? null) !== JSON.stringify(patch[key] ?? null))
            throw new Error(`The Identity server did not save ${key}. Update the server, then retry.`);
    }
    return saved;
}

async function authorizeIdentity() {
    if (authorizationPromise) return authorizationPromise;
    authorizationPromise = (async () => {
        const currentUser = UserStore.getCurrentUser();
        const base = cleanBaseUrl(settings.store.serverUrl);
        if (!currentUser || !base) throw new Error("Log in to Discord before connecting NullCord.");
        if (!await allowNetworkConnection()) throw new Error("Restart Discord, then press Save to NullCord again.");

        const deviceResponse = await fetch(`${base}/v1/auth/device`, { method: "POST" });
        const device = await deviceResponse.json().catch(() => ({}));
        if (!deviceResponse.ok) throw new Error(device.error ?? `HTTP ${deviceResponse.status}`);
        if (IS_WEB) window.open(device.verificationUrl, "_blank", "noopener,noreferrer");
        else VencordNative.native.openExternal(device.verificationUrl);

        const deadline = Date.now() + Math.min(Number(device.expiresIn) || 600, 600) * 1000;
        const interval = Math.max(Number(device.interval) || 2, 2) * 1000;
        while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, interval));
            const pollResponse = await fetch(`${base}/v1/auth/device/${encodeURIComponent(device.deviceCode)}`);
            if (pollResponse.status === 202) continue;
            const result = await pollResponse.json().catch(() => ({}));
            if (!pollResponse.ok) throw new Error(result.error ?? `HTTP ${pollResponse.status}`);
            if (result.userId !== currentUser.id) throw new Error("The authorized Discord account does not match this client.");
            await set(PUBLISH_KEY_STORAGE_KEY, result.publishingKey);
            await refreshIdentityNetwork();
            connectLiveUpdates();
            return result.publishingKey as string;
        }
        throw new Error("Discord authorization expired. Try again.");
    })().finally(() => authorizationPromise = undefined);
    return authorizationPromise;
}

async function interceptProfileSave(request: any) {
    const currentUser = UserStore.getCurrentUser();
    const body = request?.body;
    if (!originalRestPatch || request?.url !== Constants.Endpoints.ME || !body || currentUser?.premiumType === 2)
        return originalRestPatch!(request);

    const publishingKey = await get<string>(PUBLISH_KEY_STORAGE_KEY) ??
        await get<string>(LEGACY_PUBLISH_KEY_STORAGE_KEY) ?? await authorizeIdentity();

    const discordBody = { ...body };
    const networkPatch: Partial<NetworkIdentity> = {};
    let diverted = false;

    if (typeof discordBody.avatar === "string" && discordBody.avatar.startsWith("data:image/gif")) {
        networkPatch.avatar = await uploadNativeMedia(currentUser.id, publishingKey, "avatar", discordBody.avatar);
        delete discordBody.avatar;
        diverted = true;
    }
    if (discordBody.banner === null || typeof discordBody.banner === "string" && discordBody.banner.startsWith("data:image/")) {
        networkPatch.banner = discordBody.banner === null ? undefined : await uploadNativeMedia(currentUser.id, publishingKey, "banner", discordBody.banner);
        delete discordBody.banner;
        diverted = true;
    }
    if (Object.hasOwn(discordBody, "theme_colors")) {
        networkPatch.themeColors = discordBody.theme_colors ?? undefined;
        delete discordBody.theme_colors;
        diverted = true;
    }

    const displayFields = ["display_name_font_id", "display_name_effect_id", "display_name_colors"];
    if (displayFields.some(field => Object.hasOwn(discordBody, field))) {
        networkPatch.displayNameStyle = discordBody.display_name_font_id == null || discordBody.display_name_effect_id == null
            ? undefined
            : {
                fontId: discordBody.display_name_font_id,
                effectId: discordBody.display_name_effect_id,
                colors: discordBody.display_name_colors ?? []
            };
        displayFields.forEach(field => delete discordBody[field]);
        diverted = true;
    }

    if (!diverted) return originalRestPatch(request);
    await publishNativeProfile(currentUser.id, publishingKey, networkPatch);
    await refreshIdentityNetwork();
    withNetworkDisplayNameStyle(currentUser);

    if (Object.keys(discordBody).length > 0) return originalRestPatch({ ...request, body: discordBody });
    return { body: currentUser, ok: true, status: 200 };
}

function notifyListeners() {
    listeners.forEach(listener => listener());
}

export function getNetworkIdentity(userId: string) {
    return identities.get(userId);
}

export function subscribeToIdentityNetwork(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

const settings = definePluginSettings({
    serverUrl: {
        type: OptionType.STRING,
        description: "NullCord Identity Network API URL",
        default: "https://identity.mend0.net",
        placeholder: "https://identity.example.com"
    },
    preferDiscordBanner: {
        type: OptionType.BOOLEAN,
        description: "Keep a real Discord banner when both Discord and NullCord banners exist",
        default: false
    },
    animateAvatars: {
        type: OptionType.BOOLEAN,
        description: "Animate Identity Network GIF avatars",
        default: true
    },
    showNetworkBadges: {
        type: OptionType.BOOLEAN,
        description: "Show membership and custom badges published through the Identity Network",
        default: true
    }
});

export async function refreshIdentityNetwork() {
    const base = cleanBaseUrl(settings.store.serverUrl);
    if (!base) return false;

    try {
        const response = await fetch(`${base}/v1/network`, {
            headers: networkEtag ? { "If-None-Match": networkEtag } : undefined
        });
        if (response.status === 304) {
            lastSyncedAt = new Date();
            notifyListeners();
            return true;
        }

        let data: NetworkResponse;
        if (response.status === 404) {
            const legacy = await fetch(`${base}/v1/cosmetics`);
            if (!legacy.ok) throw new Error(`HTTP ${legacy.status}`);
            data = await legacy.json() as NetworkResponse;
        } else {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            data = await response.json() as NetworkResponse;
            networkEtag = response.headers.get("ETag") ?? undefined;
        }

        const incoming = data.profiles ?? data.users ?? {};
        const next = new Map<string, NetworkIdentity>();
        for (const [userId, identity] of Object.entries(incoming)) {
            const normalized = { ...identity, badges: [] };
            if (/^\d{15,22}$/.test(userId) && validIdentity(normalized)) next.set(userId, normalized);
        }

        identities.clear();
        next.forEach((identity, userId) => identities.set(userId, identity));
        managedBadges = (data.globalBadges ?? []).filter(badge =>
            /^[a-z0-9_-]{1,32}$/i.test(badge.id) && badge.title?.length > 0 && badge.title.length <= 48 && validMediaUrl(badge.icon) &&
            (badge.scope === "all" || badge.scope === "users" && Array.isArray(badge.userIds))
        );
        memberCount = data.memberCount ?? identities.size;
        lastSyncedAt = new Date();
        notifyListeners();
        return true;
    } catch (error) {
        logger.warn("Could not refresh the Identity Network", error);
        notifyListeners();
        return false;
    }
}

async function allowNetworkConnection() {
    const base = cleanBaseUrl(settings.store.serverUrl);
    const directives = ["connect-src", "img-src"];
    if (!base || IS_WEB || await VencordNative.csp.isDomainAllowed(base, directives)) return true;

    const result = await VencordNative.csp.requestAddOverride(base, directives, "NullCord Identity Network");
    if (result !== "ok") return false;

    openModal(props => (
        <ConfirmModal
            {...props}
            title="Identity Network enabled"
            subtitle={`${new URL(base).host} has been allowed. Restart Discord to connect to it.`}
            confirmText="Restart now"
            cancelText="Later"
            variant="primary"
            onConfirm={relaunch}
        />
    ));
    return false;
}

function connectLiveUpdates() {
    eventSource?.close();
    const base = cleanBaseUrl(settings.store.serverUrl);
    if (!base) return;
    eventSource = new EventSource(`${base}/v1/events`);
    eventSource.addEventListener("sync", () => refreshIdentityNetwork());
    eventSource.onerror = () => logger.debug("Identity live update stream disconnected; periodic refresh remains active");
}

const DISPLAY_FONTS = [
    [11, "gg Sans", "gg sans"],
    [3, "Sakura", "Sakura"],
    [4, "Jellybean", "Jellybean"],
    [6, "Modern", "Modern"],
    [7, "Medieval", "Medieval"],
    [8, "8 Bit", "8Bit"],
    [10, "Vampyre", "Vampyre"],
    [12, "Tempo", "Tempo"],
    [13, "Monkey Bars", "Monkey Bars"],
    [14, "Mainframe", "Mainframe"],
    [15, "Headbang", "Headbang"],
    [16, "Journal", "Journal"]
] as const;
const DISPLAY_EFFECTS = [[1, "Solid"], [2, "Gradient"], [3, "Neon"], [4, "Toon"], [5, "Pop"], [6, "Glow"], [7, "Prism"], [8, "Gummy"]] as const;

function fontFamily(id: number) {
    const family = DISPLAY_FONTS.find(([fontId]) => fontId === id)?.[2] ?? "gg sans";
    return `"${family}", "gg sans", sans-serif`;
}

function cssColor(color: number) {
    return `#${color.toString(16).padStart(6, "0")}`;
}

function displayNamePreviewStyle(fontId: number, effectId: number, colors: number[]): CSSProperties {
    const primary = cssColor(colors[0] ?? 0xffffff);
    const secondary = cssColor(colors[1] ?? colors[0] ?? 0xffffff);
    const style: CSSProperties = { color: primary, fontFamily: fontFamily(fontId) };

    if (effectId === 2 || effectId === 7 || effectId === 8) Object.assign(style, {
        backgroundImage: effectId === 7
            ? `linear-gradient(90deg, ${primary}, #55cdfc, #c77dff, ${secondary})`
            : `linear-gradient(90deg, ${primary}, ${secondary})`,
        backgroundClip: "text",
        color: "transparent",
        WebkitBackgroundClip: "text"
    });
    if (effectId === 3) style.textShadow = `0 0 5px ${primary}, 0 0 12px ${primary}`;
    if (effectId === 4) Object.assign(style, { color: secondary, textShadow: `0 2px 0 ${primary}`, WebkitTextStroke: `1px ${primary}` });
    if (effectId === 5) style.textShadow = `3px 3px 0 ${secondary}`;
    if (effectId === 6) style.textShadow = `0 0 3px #fff, 0 0 10px ${primary}, 0 0 18px ${secondary}`;
    if (effectId === 8) style.filter = `drop-shadow(0 2px 2px ${secondary})`;
    return style;
}

export function IdentityStudio() {
    const [, renderNetworkUpdate] = useState(0);
    const currentUser = UserStore.getCurrentUser();
    const current = identities.get(currentUser?.id) ?? { badges: [] };
    const [avatar, setAvatar] = useState(current.avatar ?? "");
    const [banner, setBanner] = useState(current.banner ?? "");
    const [publishKey, setPublishKey] = useState("");
    const [themePrimary, setThemePrimary] = useState(current.themeColors?.[0] ?? 0x171717);
    const [themeAccent, setThemeAccent] = useState(current.themeColors?.[1] ?? 0x737373);
    const [fontId, setFontId] = useState(current.displayNameStyle?.fontId ?? 11);
    const [effectId, setEffectId] = useState(current.displayNameStyle?.effectId ?? 1);
    const [fontColor, setFontColor] = useState(current.displayNameStyle?.colors[0] ?? 0xffffff);
    const [fontAccent, setFontAccent] = useState(current.displayNameStyle?.colors[1] ?? 0xff4fd8);
    const [status, setStatus] = useState<string>();
    const [statusError, setStatusError] = useState(false);
    const [saving, setSaving] = useState(false);
    const [connecting, setConnecting] = useState(false);

    useEffect(() => {
        Promise.all([get<string>(PUBLISH_KEY_STORAGE_KEY), get<string>(LEGACY_PUBLISH_KEY_STORAGE_KEY)])
            .then(([key, legacyKey]) => setPublishKey(key ?? legacyKey ?? ""));
        return subscribeToIdentityNetwork(() => renderNetworkUpdate(value => value + 1));
    }, []);

    function validate() {
        if (!validMediaUrl(avatar) || !validMediaUrl(banner)) return "Avatar and banner must use HTTPS URLs (localhost is allowed for development).";
    }

    async function connectDiscord() {
        const base = cleanBaseUrl(settings.store.serverUrl);
        if (!base || !currentUser) {
            setStatusError(true);
            setStatus("Log in to Discord and set the Identity Network URL first.");
            return;
        }

        setConnecting(true);
        setStatusError(false);
        setStatus("Opening Discord authorization in your browser...");
        try {
            if (!await allowNetworkConnection()) return;
            const deviceResponse = await fetch(`${base}/v1/auth/device`, { method: "POST" });
            const device = await deviceResponse.json().catch(() => ({}));
            if (!deviceResponse.ok) throw new Error(device.error ?? `HTTP ${deviceResponse.status}`);

            if (IS_WEB) window.open(device.verificationUrl, "_blank", "noopener,noreferrer");
            else VencordNative.native.openExternal(device.verificationUrl);
            setStatus("Approve NullCord in your browser. This panel will connect automatically when you return.");

            const deadline = Date.now() + Math.min(Number(device.expiresIn) || 600, 600) * 1000;
            const interval = Math.max(Number(device.interval) || 2, 2) * 1000;
            while (Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, interval));
                const pollResponse = await fetch(`${base}/v1/auth/device/${encodeURIComponent(device.deviceCode)}`);
                if (pollResponse.status === 202) continue;
                const result = await pollResponse.json().catch(() => ({}));
                if (!pollResponse.ok) throw new Error(result.error ?? `HTTP ${pollResponse.status}`);
                if (result.userId !== currentUser.id) throw new Error("The authorized Discord account does not match the account open in this client.");

                setPublishKey(result.publishingKey);
                await set(PUBLISH_KEY_STORAGE_KEY, result.publishingKey);
                await refreshIdentityNetwork();
                connectLiveUpdates();
                setStatusError(false);
                setStatus("Discord connected. You can now upload and publish through the shared NullCord network.");
                return;
            }
            throw new Error("Discord authorization expired. Try connecting again.");
        } catch (error) {
            setStatusError(true);
            setStatus(`Connection failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setConnecting(false);
        }
    }

    async function publish() {
        const validationError = validate();
        if (validationError) {
            setStatusError(true);
            setStatus(validationError);
            return;
        }

        const userId = currentUser?.id;
        const base = cleanBaseUrl(settings.store.serverUrl);
        if (!userId || !base || !publishKey) {
            setStatusError(true);
            setStatus("Set an Identity Network URL and your private publishing key first.");
            return;
        }

        setSaving(true);
        setStatus(undefined);
        try {
            if (!await allowNetworkConnection()) return;
            await publishNativeProfile(userId, publishKey, {
                avatar: avatar.trim() || undefined,
                banner: banner.trim() || undefined,
                themeColors: [themePrimary, themeAccent],
                displayNameStyle: { fontId, effectId, colors: effectId === 1 ? [fontColor] : [fontColor, fontAccent] }
            });

            await set(PUBLISH_KEY_STORAGE_KEY, publishKey);
            if (!await refreshIdentityNetwork()) throw new Error("Saved, but the profile could not be read back from the network.");
            const verified = identities.get(userId);
            if (!verified?.displayNameStyle || verified.displayNameStyle.fontId !== fontId || verified.displayNameStyle.effectId !== effectId)
                throw new Error("The profile response did not contain the selected font and effect. Nothing was reported as saved.");
            withNetworkDisplayNameStyle(currentUser);
            setStatusError(false);
            setStatus("Identity verified and published live to other NullCord members.");
        } catch (error) {
            setStatusError(true);
            setStatus(`Publish failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setSaving(false);
        }
    }

    async function uploadMedia(kind: "avatar" | "banner", file: File) {
        const userId = currentUser?.id;
        const base = cleanBaseUrl(settings.store.serverUrl);
        if (!userId || !base || !publishKey) {
            setStatusError(true);
            setStatus("Set an Identity Network URL and your private publishing key before uploading.");
            return;
        }

        setSaving(true);
        setStatus(`Optimizing and uploading ${kind}...`);
        try {
            if (!await allowNetworkConnection()) return;
            const response = await fetch(`${base}/v1/users/${userId}/media/${kind}`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${publishKey}`, "Content-Type": file.type },
                body: file
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
            if (!result.published || typeof result.url !== "string") throw new Error("The server did not confirm the media upload.");
            if (kind === "avatar") setAvatar(result.url);
            else setBanner(result.url);
            if (!await refreshIdentityNetwork() || identities.get(userId)?.[kind] !== result.url)
                throw new Error(`The uploaded ${kind} could not be verified on the Identity Network.`);
            setStatusError(false);
            setStatus(`${kind[0].toUpperCase() + kind.slice(1)} resized to ${result.width}x${result.height} and published live.`);
        } catch (error) {
            setStatusError(true);
            setStatus(`Upload failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setSaving(false);
        }
    }

    async function removeIdentity() {
        const userId = currentUser?.id;
        const base = cleanBaseUrl(settings.store.serverUrl);
        if (!userId || !base || !publishKey) {
            setStatusError(true);
            setStatus("A publishing key is required to remove your shared identity.");
            return;
        }

        setSaving(true);
        try {
            if (!await allowNetworkConnection()) return;
            const response = await fetch(`${base}/v1/users/${userId}`, {
                method: "DELETE",
                headers: { "Authorization": `Bearer ${publishKey}` }
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
            await refreshIdentityNetwork();
            setStatusError(false);
            setStatus("Your Identity Network profile has been removed.");
        } catch (error) {
            setStatusError(true);
            setStatus(`Removal failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="nc-identity-studio">
            <div className="nc-identity-hero">
                <div>
                    <span className="nc-identity-kicker">NULLCORD IDENTITY NETWORK</span>
                    <Forms.FormTitle tag="h2">Your identity, shared your way.</Forms.FormTitle>
                    <Forms.FormText>Publish one opt-in profile that other NullCord clients can render across Discord.</Forms.FormText>
                </div>
                <div className="nc-identity-network-stat">
                    <strong>{memberCount}</strong>
                    <span>network members</span>
                </div>
            </div>

            <div className="nc-identity-profile-preview" style={{ background: `linear-gradient(150deg, ${cssColor(themePrimary)}, ${cssColor(themeAccent)})` }}>
                <div className="nc-identity-profile-banner" style={{ backgroundImage: banner ? `url(${banner})` : `linear-gradient(120deg, ${cssColor(themeAccent)}, ${cssColor(themePrimary)})` }} />
                <div className="nc-identity-profile-body">
                    <img className="nc-identity-profile-avatar" src={avatar || currentUser?.getAvatarURL(undefined, 256, true)} alt="Avatar preview" />
                    <div className="nc-identity-profile-badges"><img src={NULLCORD_ICON_DATA_URL} alt="NullCord member" /></div>
                    <strong className="nc-identity-profile-name" style={displayNamePreviewStyle(fontId, effectId, [fontColor, fontAccent])}>{currentUser?.globalName ?? currentUser?.username}</strong>
                    <span className="nc-identity-profile-handle">{currentUser?.username} · NullCord member</span>
                    <div className="nc-identity-profile-about"><b>ABOUT ME</b><span>This preview updates live with your banner, avatar, profile colors, font, and name effect.</span></div>
                </div>
            </div>

            <div className="nc-identity-connection">
                <div><strong>{publishKey ? "Discord connected" : "Connect your Discord account"}</strong><span>{publishKey ? "This device can publish your NullCord identity." : "Authorize once—no self-hosting or manually issued key required."}</span></div>
                <Button onClick={connectDiscord} disabled={connecting}>{connecting ? "Waiting for Discord..." : publishKey ? "Reconnect" : "Connect Discord"}</Button>
            </div>

            <div className="nc-identity-grid">
                <label>
                    <span>Private publishing key</span>
                    <TextInput type="password" value={publishKey} onChange={setPublishKey} placeholder="nc_..." />
                </label>
                <label>
                    <span>Animated avatar URL</span>
                    <TextInput value={avatar} onChange={setAvatar} placeholder="https://.../avatar.gif" />
                    <div className="nc-identity-upload">
                        <input id="nc-identity-avatar-upload" type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={event => event.currentTarget.files?.[0] && uploadMedia("avatar", event.currentTarget.files[0])} />
                        <Button onClick={() => document.getElementById("nc-identity-avatar-upload")?.click()} disabled={saving}>Upload avatar</Button>
                    </div>
                </label>
                <label className="nc-identity-wide">
                    <span>Profile banner URL</span>
                    <TextInput value={banner} onChange={setBanner} placeholder="https://.../banner.gif" />
                    <div className="nc-identity-upload">
                        <input id="nc-identity-banner-upload" type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={event => event.currentTarget.files?.[0] && uploadMedia("banner", event.currentTarget.files[0])} />
                        <Button onClick={() => document.getElementById("nc-identity-banner-upload")?.click()} disabled={saving}>Upload banner</Button>
                    </div>
                </label>
            </div>

            <section className="nc-identity-customize">
                <div className="nc-identity-section-heading">
                    <strong>Profile colors</strong>
                    <span>Shown on your client-side NullCord profile.</span>
                </div>
                <div className="nc-identity-colors">
                    <ColorPicker color={themePrimary} onChange={value => value != null && setThemePrimary(value)} label="Primary" />
                    <ColorPicker color={themeAccent} onChange={value => value != null && setThemeAccent(value)} label="Accent" />
                    <ColorPicker color={fontColor} onChange={value => value != null && setFontColor(value)} label="Name" />
                    {effectId !== 1 && <ColorPicker color={fontAccent} onChange={value => value != null && setFontAccent(value)} label="Name accent" />}
                </div>
            </section>

            <section className="nc-identity-customize">
                <div className="nc-identity-section-heading">
                    <strong>Display name font</strong>
                    <span>Visible to NullCord users in supported Discord surfaces.</span>
                </div>
                <div className="nc-identity-choice-grid">
                    {DISPLAY_FONTS.map(([id, label]) => <button key={id} type="button" className={fontId === id ? "selected" : ""} onClick={() => setFontId(id)}><b style={{ fontFamily: fontFamily(id) }}>Gg</b><span>{label}</span></button>)}
                </div>
                <div className="nc-identity-section-heading nc-identity-effect-heading"><strong>Name effect</strong></div>
                <div className="nc-identity-choice-grid nc-identity-effects">
                    {DISPLAY_EFFECTS.map(([id, label]) => <button key={id} type="button" className={effectId === id ? "selected" : ""} onClick={() => setEffectId(id)}><b style={displayNamePreviewStyle(fontId, id, [fontColor, fontAccent])}>{label}</b></button>)}
                </div>
            </section>

            <div className="nc-identity-empty">Profile badges are managed centrally by the NullCord administrator.</div>

            {status && (statusError ? <ErrorCard>{status}</ErrorCard> : <div className="nc-identity-success">{status}</div>)}
            <div className="nc-identity-actions">
                <Button onClick={publish} disabled={saving}>{saving ? "Publishing…" : "Publish identity"}</Button>
                <button className="nc-identity-delete" onClick={removeIdentity} disabled={saving || !currentUser || !identities.has(currentUser.id)}>Stop sharing</button>
                <button className="nc-identity-refresh" onClick={async () => {
                    if (!await allowNetworkConnection()) return;
                    await refreshIdentityNetwork();
                    connectLiveUpdates();
                }}>Connect / refresh</button>
            </div>
            <Forms.FormText className="nc-identity-note">
                Last sync: {lastSyncedAt?.toLocaleTimeString() ?? "not connected"}. This is client-side identity; non-NullCord users continue to see your normal Discord profile.
            </Forms.FormText>
        </div>
    );
}

export default definePlugin({
    name: "NullCordIdentity",
    description: "Opt-in shared avatars and banners with administrator-managed badges for NullCord members",
    tags: ["Appearance", "Customisation"],
    authors: [Devs.NullCord],
    settings,
    dependencies: ["BadgeAPI"],
    required: true,
    hidden: true,
    patches: [
        {
            find: "UserProfileStore",
            replacement: {
                match: /(?<=getUserProfile\(\i\){return )(.+?)(?=})/,
                replace: "$self.patchNetworkProfile($1)"
            }
        },
        {
            find: "hasThemeColors(){",
            replacement: {
                match: /get canUsePremiumProfileCustomization\(\){return /,
                replace: "$&$self.canUseNullCordProfile(this?.userId)||"
            }
        },
        {
            find: ':"SHOULD_LOAD");',
            replacement: {
                match: /\i(?:\?)?.getPreviewBanner\(\i,\i,\i\)(?=.{0,100}"COMPLETE")/,
                replace: "$self.getBannerUrl(arguments[0])||$&"
            }
        }
    ],

    userProfileBadge: {
        id: "nullcord_identity_badges",
        getBadges({ userId }) {
            if (!settings.store.showNetworkBadges) return [];
            const identity = identities.get(userId);
            if (!identity) return [];

            return [
                {
                    id: `nullcord_network_${userId}`,
                    description: "NullCord Network Member",
                    iconSrc: NULLCORD_ICON_DATA_URL,
                    position: BadgePosition.START,
                    props: { style: { borderRadius: "5px" } }
                },
                ...managedBadges.filter(badge => badge.scope === "all" || badge.userIds.includes(userId)).map(badge => ({
                    id: `nullcord_managed_${userId}_${badge.id}`,
                    description: badge.title,
                    iconSrc: badge.icon,
                    position: BadgePosition.START,
                    props: { style: { borderRadius: "5px" } }
                } satisfies ProfileBadge))
            ];
        }
    },

    getBannerUrl({ displayProfile }: any) {
        if (!displayProfile?.userId) return;
        if (displayProfile.banner && settings.store.preferDiscordBanner) return;
        return identities.get(displayProfile.userId)?.banner;
    },

    patchNetworkProfile,

    canUseNullCordProfile(userId: string) {
        return userId === UserStore.getCurrentUser()?.id;
    },

    async start() {
        await refreshIdentityNetwork();
        connectLiveUpdates();

        originalRestPatch = RestAPI.patch;
        RestAPI.patch = interceptProfileSave;
        originalGetUser = UserStore.getUser;
        originalGetCurrentUser = UserStore.getCurrentUser;
        UserStore.getUser = function (userId: string) {
            return withNetworkDisplayNameStyle(originalGetUser!.call(this, userId));
        };
        UserStore.getCurrentUser = function () {
            return withNetworkDisplayNameStyle(originalGetCurrentUser!.call(this));
        };
        const currentUser = UserStore.getCurrentUser();
        const prototype = currentUser && Object.getPrototypeOf(currentUser);
        if (prototype?.getAvatarURL && !originalGetAvatarURL) {
            originalGetAvatarURL = prototype.getAvatarURL;
            prototype.getAvatarURL = function (guildId?: string | null, size?: number, canAnimate?: boolean, format?: string) {
                const custom = identities.get(this.id)?.avatar;
                if (custom && (settings.store.animateAvatars || !custom.toLowerCase().includes(".gif"))) return custom;
                return originalGetAvatarURL!.call(this, guildId, size, canAnimate, format);
            };
        }

        refreshTimer = setInterval(refreshIdentityNetwork, 2 * 60 * 1000);
    },

    stop() {
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = undefined;
        eventSource?.close();
        eventSource = undefined;

        const prototype = UserStore.getCurrentUser() && Object.getPrototypeOf(UserStore.getCurrentUser());
        if (prototype && originalGetAvatarURL) prototype.getAvatarURL = originalGetAvatarURL;
        originalGetAvatarURL = undefined;
        if (originalRestPatch) RestAPI.patch = originalRestPatch;
        if (originalGetUser) UserStore.getUser = originalGetUser;
        if (originalGetCurrentUser) UserStore.getCurrentUser = originalGetCurrentUser;
        originalRestPatch = undefined;
        originalGetUser = undefined;
        originalGetCurrentUser = undefined;
        identities.clear();
        networkEtag = undefined;
        memberCount = 0;
        managedBadges = [];
        notifyListeners();
    }
});
