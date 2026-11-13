# BetterDownload

A userplugin for [Equicord](https://github.com/Equicord/Equicord) and [Testcord](https://codeberg.org/Testcord/TestCord) that downloads every file in a message at once, straight into a folder. No save dialog per file, no browser download spam.

## Features

- **Download All** in the message menu (right click or `…`), with a count. Works on forwarded messages too.
- **Download This** when you right click one image in a multi-image message.
- **Hover bar button** on messages with media (can be turned off).
- **Hotkey**: hover a message and press `V` to download everything in it. `Shift+V` downloads only the image under your cursor. Also works in the image viewer.
- **Emojis & stickers** from a message, at full size.
- **User menu**: avatar, server avatar, banner and server banner.
- **Server menu**: icon, banner and invite background.
- **Channel / thread menu**: download all media from the messages currently loaded.
- Small popup at the top of the window when a download finishes. Click it to open the folder.

## Settings

| Setting | Default |
|---|---|
| Save folder | Your Downloads folder |
| Ask for a folder every time | Off |
| Filename template | `{filename}` |
| Hotkey | `v` |
| Hover bar button | On |
| Include embed images and videos | On |
| Popup when done | On |
| Open folder when done | Off |

Filename template tokens: `{filename}` `{name}` `{ext}` `{username}` `{displayname}` `{userid}` `{server}` `{channel}` `{messageid}` `{date}` `{time}` `{index}`. Use `/` for subfolders, for example `{username}/{filename}` or `{server}/{channel}/{date} {filename}`.

Files with the same name are never overwritten, they get ` (1)`, ` (2)` and so on.

## Install

Desktop only. It saves files through a small native helper, so it does not work in the browser build.

1. In your Equicord/Testcord source folder, create `src/userplugins` if it doesn't exist.
2. Copy this `betterDownload.desktop` folder into it. Keep the `.desktop` suffix.
3. Run `pnpm build` and fully restart Discord, then enable **BetterDownload** in Settings → Plugins.

Downloads only come from Discord's own servers (`cdn.discordapp.com`, `media.discordapp.net`, `images-ext-*.discordapp.net`).
