// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";

contextBridge.exposeInMainWorld("promiseIpc", {
  send: (event: string, ...args: unknown[]): Promise<unknown> => 
    ipcRenderer.invoke(event, ...args),

  addListener: (event: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void): void => {
    ipcRenderer.on(event, listener);
  },

  removeListener: (event: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void): void => {
    ipcRenderer.removeListener(event, listener);
    },
});
