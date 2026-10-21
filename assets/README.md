# Brand icons

Sora uses the original photograph in `sora/logo.png`. Run `vp run icons:export` to
regenerate the web, Electron, iOS, Android, and widget assets. Run
`vp run icons:check` to check that the tracked exports match the source.
The exporter uses Sharp and runs on Linux or macOS without Icon Composer.

The existing asset paths and platform dimensions are preserved. App icons are
1024×1024; macOS uses an 824×824 rounded body inset 100px inside that canvas.
Web favicons are 16px and 32px, Apple touch icons are 180px, and Windows ICOs
contain the existing 16px through 256px renditions. In-app and widget marks use
128px copies rather than loading the full-resolution photograph.

Android uses a full-bleed photograph on its 432px adaptive background and a
transparent foreground so the system applies the launcher mask once. Splash
images use the existing 1152px canvas. Android themed icons and notifications
require monochrome alpha masks; these are derived from the photograph.

The Icon Composer projects use the same photo for native iOS builds. The
upstream Icon Composer and Android SVG exporters remain in the repository;
use the package scripts above to preserve Sora branding.
