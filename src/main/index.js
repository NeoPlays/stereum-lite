import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { initializeIpcHandlers } from './ipcHandlers'

function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 900,
        height: 670,
        show: false,
        autoHideMenuBar: true,
        ...(process.platform === 'linux' ? { icon } : {}),
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            sandbox: false
        }
    })

    mainWindow.on('ready-to-show', () => {
        mainWindow.show()
    })

    mainWindow.webContents.setWindowOpenHandler((details) => {
        shell.openExternal(details.url)
        return { action: 'deny' }
    })

    // Dev: electron-vite HMR URL; prod: local html file.
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
        mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }
}

// Some Electron APIs are only usable after this event.
app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.electron')

    // F12 toggles DevTools in dev, CmdOrCtrl+R is ignored in prod.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on('browser-window-created', (_, window) => {
        optimizer.watchWindowShortcuts(window)
    })
    initializeIpcHandlers()
    createWindow()

    app.on('activate', function () {
        // macOS convention: re-create a window on dock click when none are open.
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
})

// Quit on last window close, except on macOS where apps stay active until Cmd+Q.
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
    }
})
