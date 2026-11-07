# NotificationSounds

A userplugin for [Equicord](https://github.com/Equicord/Equicord) and [Testcord](https://codeberg.org/Testcord/TestCord) that plays different notification sounds for DMs, group DMs, pings, reply pings, role pings, @everyone, @here, threads, server messages and the current channel. Upload your own sounds or use any built-in Discord sound. You can also replace any other Discord sound (calls, voice joins/leaves, mute, deafen, streams…); all of them are listed with a search box.

Out of the box each category has its own sound:

| Category | Default |
|---|---|
| Direct message, Group DM, Current channel | message3 |
| Ping, Reply ping | message2 |
| Role ping | mention1 |
| @everyone | mention2 |
| @here | mention3 |
| Thread message, Server message | message1 |

Pick "Discord's own sound (no change)" to leave a category alone.

Discord still decides *whether* a sound plays: mutes, DND, focus, suppress-@everyone/roles, streamer mode and Discord's own sound toggles all keep working. This plugin only changes *which* sound plays.

## Install

Requires `AudioPlayerAPI`, which ships with Equicord and Testcord and turns on automatically.

1. In your Equicord/Testcord source folder, create `src/userplugins` if it doesn't exist.
2. Copy this `notificationSounds` folder into it.
3. Run `pnpm build` and restart Discord, then enable **NotificationSounds** in Settings → Plugins.

## Console helpers

    Vencord.Plugins.plugins.NotificationSounds.test("role")   // play the sound set for a category
    Vencord.Plugins.plugins.NotificationSounds.inspect()      // pending match, recent matches, cached files

## Credits

- Written by [visiuun](https://github.com/visiuun).
- The idea, the category list and the default sound for each category come from [DevilBro (mwittrien)'s NotificationSounds](https://github.com/mwittrien/BetterDiscordAddons/tree/master/Plugins/NotificationSounds) for BetterDiscord. This is an independent implementation; no code was copied from it.
- Sound swapping uses Equicord's `AudioPlayerAPI`.

## License

[GPL-3.0-or-later](../LICENSE), the same license as Vencord, Equicord and Testcord.
