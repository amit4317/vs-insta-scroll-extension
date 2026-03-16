# Instagram Reels for VS Code

Play Instagram Reels directly inside VS Code with an optional DRM mode using Widevine CDM.

## Marketplace-friendly summary

- Adds a sidebar and commands to open Instagram Reels in VS Code Simple Browser.
- Supports DRM by launching a new editor window with Widevine path/flags from Chrome/Edge.
- Includes fallback command to open Reels in your default browser.

## Features

- Reels: Open Reels — opens a Reels view in the built-in browser.
- Reels: Launch with DRM support — starts a new window with Widevine for DRM playback.
- Reels: Open in VS Code — open inside the current window.
- Reels: Open in browser — fallback external browser mode.

## How to use

1. Install Google Chrome or Microsoft Edge, and open it once (to initialize Widevine).
2. Run Instagram Reels: Launch with DRM support.
3. In the new window, run Reels: Open Reels (or use the sidebar button).

If DRM playback does not work, use Reels: Open in browser.

## Requirements

- Chrome or Edge installed with Widevine support.
- Open your Instagram account with an active Internet connection.
- VS Code or Cursor with built-in Simple Browser.

## Dev setup

`ash
npm install
npm run compile
`

Then press **F5** to test in Extension Development Host.

## License & attribution

This extension is not affiliated with Instagram or Meta.

## Privacy

No user data is collected. All actions run locally in the extension host.
