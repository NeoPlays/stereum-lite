import { ipcMain, app } from 'electron';

ipcMain.handle('app-version', () => {
  return app.getVersion();
});