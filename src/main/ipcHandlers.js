import { ipcMain } from "electron";
import { StoreService } from "./StoreService";
import { SSHService, SSHParams } from "./SSHService";

// Instances
const storeService = new StoreService();

export function initializeIpcHandlers() {
    // IPC test
    ipcMain.handle('ping', () => console.log('pong'));

    // IPC StoreService
    ipcMain.handle('import-server-from-stereum', () => {return storeService.importFromStereum()});
    ipcMain.handle('store-get', (_, key) => storeService.get(key));
    ipcMain.handle('store-set', (_, key, value) => storeService.set(key, value));
}
