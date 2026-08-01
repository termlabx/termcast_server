// Standalone menu-bar preview of the three badged tray icons. Creates only
// Tray items — no server, no settings — so it can't disturb a running Termcast.
const { app, Tray, nativeImage, nativeTheme } = require('electron');
const { join } = require('node:path');

const ASSETS = '/path/to/termcast/relay-desktop/assets';
app.setPath('userData', join(app.getPath('temp'), 'tray-preview-userdata'));

const trays = [];
app.whenReady().then(() => {
  const dark = nativeTheme.shouldUseDarkColors;
  console.log('shouldUseDarkColors =', dark);
  for (const status of ['connected', 'connecting', 'offline']) {
    const file = `tray-${status}-${dark ? 'dark' : 'light'}.png`;
    const img = nativeImage.createFromPath(join(ASSETS, file));
    console.log(file, 'empty=', img.isEmpty(), 'size=', JSON.stringify(img.getSize()));
    img.setTemplateImage(false);
    const t = new Tray(img);
    t.setToolTip(status);
    trays.push(t);
  }
  setTimeout(() => app.exit(0), 180000);
});
