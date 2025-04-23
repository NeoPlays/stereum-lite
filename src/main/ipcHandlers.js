import { ipcMain } from "electron";
import { StoreService } from "./StoreService";
import { SSHService, SSHParams } from "./ssh/SSHService";
import { NodeManager } from "./nodes/NodeManager";
import { EthNode } from "./nodes/EthNode";
import _ from 'lodash'

// Instances
const storeService = new StoreService();
const nodeManager = new NodeManager();

export function initializeIpcHandlers() {
    // IPC test
    ipcMain.handle('ping', () => console.log('pong'));

    // IPC StoreService
    ipcMain.handle('import-server-from-stereum', () => {return storeService.importFromStereum()});
    ipcMain.handle('store-get', (_, key) => storeService.get(key));
    ipcMain.handle('store-set', (_, key, value) => storeService.set(key, value));

    // IPC SSHService
    ipcMain.handle('ssh-login', (_, credentials) => {
        const sshService = new SSHService(new SSHParams(credentials.host, credentials.port, credentials.username, credentials.password, credentials.privateKey, credentials.passphrase));
        nodeManager.addNode(new EthNode(sshService));
        console.log(nodeManager.getAllNodes());
        return sshService.connect().then((data) => {
            return data;
        }).catch((error) => {
            console.error('SSH login error:', error);
            return {code: 1, message: 'SSH login error', error: error};
        });
    });

    // IPC NodeManager
    ipcMain.handle('get-all-nodes', () => {
        return nodeManager.getAllNodes()
    });
}
