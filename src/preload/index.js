import { contextBridge, ipcRenderer } from 'electron'
const validChannels = ['ping', 'import-server-from-stereum', 'store-get', 'store-set', 'ssh-login'];

contextBridge.exposeInMainWorld(
    "api", {
        invoke: (channel, ...data) => {
            if (validChannels.includes(channel)) {
                // ipcRenderer.invoke accesses ipcMain.handle channels like 'myfunc'
                // make sure to include this return statement or you won't get your Promise back
                return ipcRenderer.invoke(channel, ...data); 
            }
        },
    }
);
