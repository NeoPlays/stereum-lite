import { IpcRendererEvent } from "electron";

export interface PromiseIpc {
  send: (event: string, ...args: unknown[]) => Promise<unknown>;
  addListener: (event: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void) => void;
  removeListener: (event: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void) => void;
}

declare global {
  interface Window {
    promiseIpc: PromiseIpc;
  }
}

