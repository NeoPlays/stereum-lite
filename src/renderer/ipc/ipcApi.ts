export const ipcApi = {
    getAppVersion: async (): Promise<string> => {
        const response = await window.promiseIpc.send('app-version');
        return response as string;
    }
}