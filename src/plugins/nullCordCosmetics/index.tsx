/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { BadgePosition, ProfileBadge } from "@api/Badges";
import { get, set } from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { ErrorCard } from "@components/ErrorCard";
import { NULLCORD_ICON_DATA_URL } from "@shared/nullCordIcon";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { relaunch } from "@utils/native";
import definePlugin, { OptionType } from "@utils/types";
import type { User } from "@vencord/discord-types";
import { Button, ConfirmModal, Forms, openModal, React, TextInput, useEffect, UserStore, useState } from "@webpack/common";

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
    badges: IdentityBadge[];
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
    return Boolean(value && validMediaUrl(value.avatar ?? "") && validMediaUrl(value.banner ?? "") && Array.isArray(value.badges) && value.badges.length <= 5 && value.badges.every(badge =>
        typeof badge.id === "string" && /^[a-z0-9_-]{1,32}$/i.test(badge.id) && typeof badge.title === "string" && badge.title.length > 0 && badge.title.length <= 48 && validMediaUrl(badge.icon)
    ));
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
            const normalized = { ...identity, badges: identity.badges ?? [] };
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

function createBadge(): IdentityBadge {
    return {
        id: `badge-${Date.now().toString(36)}`,
        title: "My badge",
        icon: ""
    };
}

function IdentityStudio() {
    const [, renderNetworkUpdate] = useState(0);
    const currentUser = UserStore.getCurrentUser();
    const current = identities.get(currentUser?.id) ?? { badges: [] };
    const [avatar, setAvatar] = useState(current.avatar ?? "");
    const [banner, setBanner] = useState(current.banner ?? "");
    const [badges, setBadges] = useState<IdentityBadge[]>(current.badges ?? []);
    const [publishKey, setPublishKey] = useState("");
    const [status, setStatus] = useState<string>();
    const [statusError, setStatusError] = useState(false);
    const [saving, setSaving] = useState(false);
    const [connecting, setConnecting] = useState(false);

    useEffect(() => {
        Promise.all([get<string>(PUBLISH_KEY_STORAGE_KEY), get<string>(LEGACY_PUBLISH_KEY_STORAGE_KEY)])
            .then(([key, legacyKey]) => setPublishKey(key ?? legacyKey ?? ""));
        return subscribeToIdentityNetwork(() => renderNetworkUpdate(value => value + 1));
    }, []);

    function updateBadge(id: string, patch: Partial<IdentityBadge>) {
        setBadges(currentBadges => currentBadges.map(badge => badge.id === id ? { ...badge, ...patch } : badge));
    }

    function validate() {
        if (!validMediaUrl(avatar) || !validMediaUrl(banner)) return "Avatar and banner must use HTTPS URLs (localhost is allowed for development).";
        if (badges.length > 5) return "Identity profiles support up to five custom badges.";
        if (badges.some(badge => !/^[a-z0-9_-]{1,32}$/i.test(badge.id) || !badge.title.trim() || badge.title.trim().length > 48 || !badge.icon || !validMediaUrl(badge.icon)))
            return "Every badge needs a valid ID, a 1-48 character title, and an HTTPS icon URL.";
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
            const response = await fetch(`${base}/v1/users/${userId}`, {
                method: "PUT",
                headers: {
                    "Authorization": `Bearer ${publishKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    avatar: avatar.trim() || null,
                    banner: banner.trim() || null,
                    badges: badges.map(badge => ({ ...badge, title: badge.title.trim(), icon: badge.icon.trim() }))
                })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);

            await set(PUBLISH_KEY_STORAGE_KEY, publishKey);
            await refreshIdentityNetwork();
            setStatusError(false);
            setStatus("Identity published. Other NullCord members will receive it on refresh.");
        } catch (error) {
            setStatusError(true);
            setStatus(`Publish failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setSaving(false);
        }
    }

    async function uploadMedia(kind: "avatar" | "banner" | "badge", file: File, badgeId?: string) {
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
            if (kind === "avatar") setAvatar(result.url);
            else if (kind === "banner") setBanner(result.url);
            else if (badgeId) updateBadge(badgeId, { icon: result.url });
            setStatusError(false);
            setStatus(kind === "badge"
                ? `Badge artwork ready at ${result.width}x${result.height}. Publish your identity to attach it.`
                : `${kind[0].toUpperCase() + kind.slice(1)} resized to ${result.width}x${result.height} and published live.`);
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

            <div className="nc-identity-preview" style={{ backgroundImage: banner ? `url(${banner})` : undefined }}>
                <img src={avatar || currentUser?.getAvatarURL(undefined, 256, true)} alt="Avatar preview" />
                <div>
                    <strong>{currentUser?.globalName ?? currentUser?.username}</strong>
                    <span>{badges.length} custom badge{badges.length === 1 ? "" : "s"} · NullCord member</span>
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
                    <span className="nc-identity-upload"><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={event => event.currentTarget.files?.[0] && uploadMedia("avatar", event.currentTarget.files[0])} />Upload & auto-size</span>
                </label>
                <label className="nc-identity-wide">
                    <span>Profile banner URL</span>
                    <TextInput value={banner} onChange={setBanner} placeholder="https://.../banner.gif" />
                    <span className="nc-identity-upload"><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={event => event.currentTarget.files?.[0] && uploadMedia("banner", event.currentTarget.files[0])} />Upload & auto-size</span>
                </label>
            </div>

            <section className="nc-identity-badges">
                <div className="nc-identity-section-title">
                    <div><strong>Shared profile badges</strong><span>Visible to everyone connected to this network.</span></div>
                    <button disabled={badges.length >= 5} onClick={() => setBadges(currentBadges => [...currentBadges, createBadge()])}>＋ Add badge</button>
                </div>
                {badges.map((badge, index) => (
                    <div className="nc-identity-badge-row" key={badge.id}>
                        <div className="nc-identity-badge-preview">{validMediaUrl(badge.icon) && badge.icon ? <img src={badge.icon} alt="" /> : index + 1}</div>
                        <TextInput value={badge.title} onChange={value => updateBadge(badge.id, { title: value })} placeholder="Badge title" />
                        <div className="nc-identity-badge-media">
                            <TextInput value={badge.icon} onChange={value => updateBadge(badge.id, { icon: value })} placeholder="https://.../badge.png" />
                            <label className="nc-identity-upload"><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={event => event.currentTarget.files?.[0] && uploadMedia("badge", event.currentTarget.files[0], badge.id)} />Upload</label>
                        </div>
                        <button className="nc-identity-remove" onClick={() => setBadges(currentBadges => currentBadges.filter(item => item.id !== badge.id))}>×</button>
                    </div>
                ))}
                {badges.length === 0 && <div className="nc-identity-empty">No shared badges yet. Published identities still receive the NullCord Network badge.</div>}
            </section>

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
    description: "Opt-in shared avatars, banners, and badges for NullCord members",
    tags: ["Appearance", "Customisation"],
    authors: [Devs.NullCord],
    settings,
    dependencies: ["BadgeAPI"],
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

    settingsAboutComponent: ErrorBoundary.wrap(IdentityStudio),

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
                ...identity.badges.map(badge => ({
                    id: `nullcord_identity_${userId}_${badge.id}`,
                    description: badge.title,
                    iconSrc: badge.icon,
                    position: BadgePosition.START,
                    props: { style: { borderRadius: "5px" } }
                } satisfies ProfileBadge)),
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

    async start() {
        await refreshIdentityNetwork();
        connectLiveUpdates();

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
        identities.clear();
        networkEtag = undefined;
        memberCount = 0;
        managedBadges = [];
        notifyListeners();
    }
});
