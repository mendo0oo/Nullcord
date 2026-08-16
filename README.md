# NullCord

NullCord is a GPL-licensed Discord client mod based on [Vencord](https://github.com/Vendicated/Vencord). Its first distinctive feature is an opt-in Cosmetics Studio for animated avatars and profile banners that are visible to other users connected to the same NullCord cosmetics service.

## What works

- Vencord's existing plugin, theme, privacy, desktop, and browser foundation.
- Vencord's client-side FakeNitro compatibility enabled by default for link-based emoji/sticker rendering and local appearance features.
- A branded NullCord settings area and purple/cyan Cosmetics Studio.
- Animated avatar URL overrides throughout the client.
- Static or animated profile banner URL overrides.
- Five-minute shared-cosmetics refresh and a publish action in plugin settings.
- A dependency-free reference cosmetics API in [`server/`](server/README.md).
- Real Discord/Nitro cosmetics can be preferred over NullCord banners.

NullCord cosmetics are client-side. They do not grant Nitro, modify Discord entitlements, upload to Discord, or appear to users running an unmodified Discord client.

## Development

Requires Node.js 22+ and pnpm 11.9.0.

```sh
pnpm install
pnpm build
```

Run the local cosmetics service separately:

```sh
node server/server.mjs
```

Open Settings → Plugins → NullCordCosmetics to configure the API URL, publishing key, avatar, and banner. See [`server/README.md`](server/README.md) for provisioning keys.

## Upstream and licensing

The source retains Vencord's internal API/global names to stay compatible with its plugin ecosystem and make upstream merges practical. Original copyright notices and attribution remain intact.

NullCord is licensed under GPL-3.0-or-later. Discord is a trademark of Discord Inc.; this project is not affiliated with or endorsed by Discord. Client modifications may violate Discord's Terms of Service, so use a client mod only if you accept that account risk.
