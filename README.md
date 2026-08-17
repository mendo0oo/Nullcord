# NullCord

NullCord is a GPL-licensed Discord client mod based on [Vencord](https://github.com/Vendicated/Vencord). Its signature feature is the opt-in NullCord Identity Network: portable client-side identities with animated avatars, profile banners, and badges that are visible to other NullCord users on the same network.

## What works

- Vencord's existing plugin, theme, privacy, desktop, and browser foundation.
- Vencord's client-side FakeNitro compatibility enabled by default for link-based emoji/sticker rendering and local appearance features.
- A branded NullCord settings area and white/gray Identity Studio.
- Animated avatar URL overrides throughout the client.
- Static or animated profile banner URL overrides.
- Direct avatar, banner, and badge uploads with secure server-side resizing and optimized WebP output.
- A NullCord Network Member badge plus up to five shared custom badges per identity.
- Centrally managed global or user-assigned badges through the private `/admin` panel.
- Live update events, background synchronization, HTTP caching, and one-click publishing/removal.
- A versioned, dependency-free Identity Network API in [`server/`](server/README.md), including migration from the original cosmetics database.
- Real Discord/Nitro cosmetics can be preferred over NullCord banners.

NullCord identities are client-side. They do not grant Nitro, modify Discord entitlements, upload to Discord, or appear to users running an unmodified Discord client. The included service defaults to localhost; deploy it behind HTTPS to create a shared network.

## Development

Requires Node.js 22+ and pnpm 11.9.0.

```sh
pnpm install
pnpm build
```

Run the local Identity Network service separately:

```sh
node server/server.mjs
```

Open **Settings → Plugins → NullCordIdentity** to configure the network URL, publishing key, avatar, banner, and shared badges. See [`server/README.md`](server/README.md) for key provisioning and deployment details.

## Installer and releases

The installer source lives in [`installer/`](installer/README.md). A pushed version tag builds the client plus Windows, Linux, and macOS installers and publishes them together in a GitHub release.

```sh
git tag v0.5.0
git push origin v0.5.0
```

Windows users can then download `NullCordInstaller.exe` from the repository's Releases page. The installer supports install, repair, and uninstall, keeps NullCord data separate from Vencord, and checks GitHub Releases for hash-verified updates when opened.

## Upstream and licensing

The source retains Vencord's internal API/global names to stay compatible with its plugin ecosystem and make upstream merges practical. Original copyright notices and attribution remain intact.

NullCord is licensed under GPL-3.0-or-later. Discord is a trademark of Discord Inc.; this project is not affiliated with or endorsed by Discord. Client modifications may violate Discord's Terms of Service, so use a client mod only if you accept that account risk.
