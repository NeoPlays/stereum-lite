import { ipcMain, BrowserWindow, dialog, net } from "electron";
import { readFileSync, writeFileSync } from "fs";
import { basename } from "path";
import storage from "@main/store/StoreService"
import nodeManager from "@main/nodes/NodeManager"
import taskManager from "@main/tasks/TaskManager"
import { Node } from "@main/nodes/Node";
import log from 'electron-log'
import { randomUUID } from 'crypto'

const logSessions = new Map() // sessionId -> { handle, nodeId }

function broadcast(channel, payload) {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
}

/** Friendly node label for a task, without any SSH calls. */
function nodeLabel(node) {
    return node?.name || node?.host || node?.id || 'node'
}

// Allowlist for the single `run-node-task` channel - adding a tracked op is one line here, no new channel.
// Read/fetch calls keep their own channels: the renderer needs their return value synchronously.
const NODE_TASK_ACTIONS = {
    'start-service':            { label: () => 'Start service',          run: (node, [id]) => node.startService(id) },
    'stop-service':             { label: () => 'Stop service',           run: (node, [id]) => node.stopService(id) },
    'restart-service':          { label: () => 'Restart service',        run: (node, [id]) => node.restartService(id) },
    'resync-service':           { label: () => 'Resync service',         run: (node, [id, url = null]) => node.resyncService(id, url) },
    'restart-changed-services': { label: () => 'Restart changed services', run: (node, [scope, prune = true]) => node.restartChangedServices(scope, { prune }) },
    'update-os':                { label: () => 'Update OS',              run: (node) => node.updateOS() },
    'update-package':           { label: ([name]) => `Update ${name}`,   run: (node, [name]) => node.updatePackage(name) },
    'update-services':          { label: () => 'Update services',        run: (node, [ids = null]) => node.updateServices(ids) },
    'update-stereum':           { label: () => 'Update node controls',   run: (node, [commit = null]) => node.updateStereum(commit) },
    'run-full-update':          { label: () => 'Full update',            run: (node, [commit = null, prune = true]) => node.runFullUpdate(commit, { prune }) },
}

const UPDATES_MANIFEST_URL = 'https://stereum.com/downloads/updates.json'
const UPDATES_MANIFEST_TTL_MS = 5 * 60 * 1000
let _manifestCache = null

function fetchUpdatesManifest() {
    if (_manifestCache && Date.now() - _manifestCache.fetchedAt < UPDATES_MANIFEST_TTL_MS) {
        return Promise.resolve(_manifestCache.data)
    }
    return new Promise((resolve, reject) => {
        const request = net.request(UPDATES_MANIFEST_URL)
        let body = ''
        request.on('response', (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                reject(new Error(`updates.json HTTP ${res.statusCode}`))
                return
            }
            res.on('data', (chunk) => { body += chunk.toString('utf8') })
            res.on('end', () => {
                try {
                    const data = JSON.parse(body)
                    _manifestCache = { data, fetchedAt: Date.now() }
                    resolve(data)
                } catch (e) {
                    reject(new Error(`updates.json parse failed: ${e.message}`))
                }
            })
            res.on('error', reject)
        })
        request.on('error', reject)
        request.end()
    })
}

export function initializeIpcHandlers() {
    // Broadcast every task create/transition to all windows so the docked panel stays live.
    taskManager.onUpdate((task) => broadcast('task-updated', task))

    // IPC test
    ipcMain.handle('ping', () => log.debug('pong'));

    ipcMain.handle('get-tasks', () => taskManager.list());

    // IPC StoreService
    ipcMain.handle('import-server-from-stereum', () => {return storage.importFromStereum()});
    ipcMain.handle('store-get', (_, key) => storage.get(key));
    ipcMain.handle('store-set', (_, key, value) => storage.set(key, value));

    // IPC NodeManager
    ipcMain.handle('ssh-login', (_, credentials) => {
        const trim = (v) => (typeof v === 'string' ? v.trim() : v)
        credentials = { ...credentials, host: trim(credentials.host), username: trim(credentials.username) }
        const existing = nodeManager.findNodeByEndpoint(credentials.host, credentials.port, credentials.username)
        if (existing) {
            return Promise.resolve({
                code: 2,
                message: `Already connected to ${credentials.username}@${credentials.host}:${credentials.port}`,
                nodeId: existing.id,
            })
        }
        const node = new Node(credentials)
        node.onStatusChange((status) => {
            for (const w of BrowserWindow.getAllWindows()) {
                w.webContents.send('node-status-changed', { id: node.id, status })
            }
        })
        return node.sshService.connect().then((data) => {
            nodeManager.addNode(node);
            return data;
        }).catch((error) => {
            log.error('SSH login error:', error);
            return {code: 1, message: error.message || 'SSH login error'};
        });
    });

    ipcMain.handle('get-all-nodes', () => {
        return nodeManager.getAllNodes()
    });

    ipcMain.handle('get-node', async (_, nodeId) => {
        try {
            return await nodeManager.getNode(nodeId);
        } catch (error) {
            log.error('get-node error:', error);
            throw error;
        }
    });

    ipcMain.handle('reconnect-node', async (_, nodeId) => {
        try {
            const node = nodeManager.findNode(nodeId)
            if (!node) throw new Error('Node not found')
            return await node.reconnect()
        } catch (error) {
            log.error('reconnect-node error:', error)
            return false
        }
    });

    ipcMain.handle('disconnect-node', async (_, nodeId) => {
        try {
            for (const [sessionId, session] of logSessions) {
                if (session.nodeId !== nodeId) continue
                try { session.handle.abort() } catch { /* ignore */ }
                logSessions.delete(sessionId)
            }
            nodeManager.disconnectNode(nodeId)
        } catch (error) {
            log.error('disconnect-node error:', error);
        }
    });

    // Async entry point for long-running node ops: returns the task id immediately, progress via `task-updated`.
    ipcMain.handle('run-node-task', (_, nodeId, action, args = []) => {
        const node = nodeManager.findNode(nodeId)
        if (!node) throw new Error('Node not found')
        const spec = NODE_TASK_ACTIONS[action]
        if (!spec) throw new Error(`Unknown task action: ${action}`)
        const label = `${spec.label(args)} · ${nodeLabel(node)}`
        const taskId = taskManager.run(label, () => spec.run(node, args), { nodeId })
        return { taskId }
    });

    ipcMain.handle('fetch-updates-manifest', async () => {
        try {
            return await fetchUpdatesManifest()
        } catch (error) {
            log.error('fetch-updates-manifest error:', error)
            throw error
        }
    });

    ipcMain.handle('service-logs-start', async (_, nodeId, serviceId, tail) => {
        const node = nodeManager.findNode(nodeId)
        if (!node) throw new Error('Node not found')
        const sessionId = randomUUID()
        const handle = await node.streamServiceLogs(serviceId, {
            tail,
            onLine: (line) => broadcast('service-log-data', { sessionId, line }),
            onClose: ({ rc, error }) => {
                logSessions.delete(sessionId)
                broadcast('service-log-closed', { sessionId, rc, error: error?.message })
            },
        })
        logSessions.set(sessionId, { handle, nodeId })
        return sessionId
    });

    ipcMain.handle('service-logs-stop', (_, sessionId) => {
        const session = logSessions.get(sessionId)
        if (!session) return
        try { session.handle.abort() } catch (e) { log.warn('service-logs-stop abort threw:', e?.message || e) }
        // onClose will delete the entry; ensure cleanup even if no close event fires
        logSessions.delete(sessionId)
    });

    ipcMain.handle('get-controls-commit', async (_, nodeId) => {
        try {
            const node = nodeManager.findNode(nodeId)
            if (!node) throw new Error('Node not found')
            return await node.fetchControlsCommit()
        } catch (error) {
            log.error('get-controls-commit error:', error)
            throw error
        }
    });

    ipcMain.handle('get-os-info', async (_, nodeId) => {
        try {
            const node = nodeManager.findNode(nodeId)
            if (!node) throw new Error('Node not found')
            return await node.fetchOsInfo()
        } catch (error) {
            log.error('get-os-info error:', error)
            throw error
        }
    });

    ipcMain.handle('get-upgradable-packages', async (_, nodeId) => {
        try {
            const node = nodeManager.findNode(nodeId)
            if (!node) throw new Error('Node not found')
            return await node.fetchUpgradablePackages()
        } catch (error) {
            log.error('get-upgradable-packages error:', error)
            throw error
        }
    });

    ipcMain.handle('get-container-statuses', async (_, nodeId) => {
        try {
            const node = nodeManager.findNode(nodeId)
            if (!node) throw new Error('Node not found')
            return await node.fetchContainerStatuses()
        } catch (error) {
            log.error('get-container-statuses error:', error)
            throw error
        }
    });

    ipcMain.handle('get-system-metrics', async (_, nodeId) => {
        try {
            const node = nodeManager.findNode(nodeId)
            if (!node) throw new Error('Node not found')
            return await node.fetchSystemMetrics()
        } catch (error) {
            log.error('get-system-metrics error:', error)
            throw error
        }
    });

    ipcMain.handle('get-client-metrics', async (_, nodeId) => {
        try {
            const node = nodeManager.findNode(nodeId)
            if (!node) throw new Error('Node not found')
            return await node.fetchClientMetrics()
        } catch (error) {
            log.error('get-client-metrics error:', error)
            throw error
        }
    });

    ipcMain.handle('get-disk-usage', async (_, nodeId) => {
        try {
            const node = nodeManager.findNode(nodeId)
            if (!node) throw new Error('Node not found')
            return await node.fetchDiskBreakdown()
        } catch (error) {
            log.error('get-disk-usage error:', error)
            throw error
        }
    });

    // Native "browse for the SSH private key" picker. Returns the absolute file path
    // (SSHParams reads the file itself), or null if the dialog was cancelled.
    ipcMain.handle('pick-private-key-file', async () => {
        const win = BrowserWindow.getFocusedWindow()
        const opts = {
            title: 'Select SSH private key',
            // Keys are usually extensionless (id_ed25519, id_rsa) and often live in a hidden ~/.ssh.
            properties: ['openFile', 'showHiddenFiles', 'dontAddToRecent'],
        }
        const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
        if (result.canceled || !result.filePaths?.length) return null
        return result.filePaths[0]
    });

    ipcMain.handle('list-validators', async (_, nodeId, serviceId) => {
        try {
            const node = nodeManager.findNode(nodeId)
            if (!node) throw new Error('Node not found')
            return await node.listValidators(serviceId)
        } catch (error) {
            log.error('list-validators error:', error)
            return { ok: false, error: error.message || 'list-validators failed', keys: [] }
        }
    });

    // Per-validator settings. These are WRITES, but they keep their own channels rather than going
    // through run-node-task: that returns { taskId } and the renderer never sees the op's result,
    // while every one of these returns per-key outcomes the UI has to render. They are also fast
    // keymanager calls, not playbooks, so there is no long-running task to observe.
    ipcMain.handle('get-validator-settings', async (_, nodeId, serviceId, pubkeys) => {
        try {
            const node = nodeManager.findNode(nodeId)
            if (!node) throw new Error('Node not found')
            return await node.getValidatorSettings(serviceId, pubkeys)
        } catch (error) {
            log.error('get-validator-settings error:', error)
            return { ok: false, error: error.message || 'get-validator-settings failed', settings: {} }
        }
    });

    ipcMain.handle('set-fee-recipient', async (_, nodeId, serviceId, pubkeys, address) => {
        try {
            const node = nodeManager.findNode(nodeId)
            if (!node) throw new Error('Node not found')
            return await node.setFeeRecipient(serviceId, pubkeys, address)
        } catch (error) {
            log.error('set-fee-recipient error:', error)
            return { ok: false, error: error.message || 'set-fee-recipient failed' }
        }
    });

    ipcMain.handle('set-graffiti', async (_, nodeId, serviceId, pubkeys, graffiti) => {
        try {
            const node = nodeManager.findNode(nodeId)
            if (!node) throw new Error('Node not found')
            return await node.setGraffiti(serviceId, pubkeys, graffiti)
        } catch (error) {
            log.error('set-graffiti error:', error)
            return { ok: false, error: error.message || 'set-graffiti failed' }
        }
    });

    // Read JSON files the user picks (keystores, or an EIP-3076 interchange). Contents come back
    // to the renderer so it can show what was selected and validate before anything is sent.
    ipcMain.handle('pick-json-files', async (_, { multi = false, title = 'Select file' } = {}) => {
        try {
            const win = BrowserWindow.getFocusedWindow()
            const opts = {
                title,
                properties: multi ? ['openFile', 'multiSelections', 'dontAddToRecent'] : ['openFile', 'dontAddToRecent'],
                filters: [{ name: 'JSON', extensions: ['json'] }],
            }
            const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
            if (result.canceled || !result.filePaths?.length) return { ok: false, canceled: true }
            const files = result.filePaths.map((p) => ({ name: basename(p), content: readFileSync(p, 'utf8') }))
            return { ok: true, files }
        } catch (error) {
            log.error('pick-json-files error:', error)
            return { ok: false, error: error.message || 'Could not read the selected file' }
        }
    });

    ipcMain.handle('validate-slashing-protection', async (_, nodeId, content, pubkeys) => {
        try {
            const node = nodeManager.findNode(nodeId)
            if (!node) throw new Error('Node not found')
            return await node.validateSlashingProtection(content, pubkeys)
        } catch (error) {
            log.error('validate-slashing-protection error:', error)
            return { ok: false, error: error.message || 'Could not validate the file' }
        }
    });

    ipcMain.handle('import-validator-keys', async (_, nodeId, serviceId, keystores, passwords, slashingProtection, opts) => {
        try {
            const node = nodeManager.findNode(nodeId)
            if (!node) throw new Error('Node not found')
            return await node.importValidatorKeys(serviceId, keystores, passwords, slashingProtection, opts || {})
        } catch (error) {
            log.error('import-validator-keys error:', error)
            return { ok: false, error: error.message || 'import-validator-keys failed' }
        }
    });

    ipcMain.handle('get-exit-preflight', async (_, nodeId, serviceId, pubkeys, beaconUrl) => {
        try {
            const node = nodeManager.findNode(nodeId)
            if (!node) throw new Error('Node not found')
            return await node.getExitPreflight(serviceId, pubkeys, { beaconUrl })
        } catch (error) {
            log.error('get-exit-preflight error:', error)
            return { ok: false, error: error.message || 'get-exit-preflight failed', checks: {} }
        }
    });

    // Irreversible. Note the signed exit message never crosses this boundary: it is a bearer
    // credential that would let anyone holding it exit the validator later, so it stays in main.
    ipcMain.handle('submit-voluntary-exit', async (_, nodeId, serviceId, pubkeys, beaconUrl) => {
        try {
            const node = nodeManager.findNode(nodeId)
            if (!node) throw new Error('Node not found')
            return await node.submitVoluntaryExit(serviceId, pubkeys, { beaconUrl })
        } catch (error) {
            log.error('submit-voluntary-exit error:', error)
            return { ok: false, error: error.message || 'submit-voluntary-exit failed' }
        }
    });

    ipcMain.handle('delete-validator-keys', async (_, nodeId, serviceId, pubkeys) => {
        try {
            const node = nodeManager.findNode(nodeId)
            if (!node) throw new Error('Node not found')
            return await node.deleteValidatorKeys(serviceId, pubkeys)
        } catch (error) {
            log.error('delete-validator-keys error:', error)
            return { ok: false, error: error.message || 'delete-validator-keys failed' }
        }
    });

    // Write the slashing-protection record a delete returned to a file the user chooses.
    // Deliberately a separate channel the renderer awaits: the removal flow must not report
    // success until this has written, because the record cannot be reconstructed from anywhere
    // else. (Repeating the delete does re-return it, which is the recovery path.)
    ipcMain.handle('save-slashing-protection', async (_, content, suggestedName) => {
        try {
            if (typeof content !== 'string' || !content) throw new Error('Nothing to save')
            const win = BrowserWindow.getFocusedWindow()
            const opts = {
                title: 'Save slashing protection',
                defaultPath: suggestedName || 'slashing_protection.json',
                filters: [{ name: 'EIP-3076 interchange', extensions: ['json'] }],
            }
            const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
            if (result.canceled || !result.filePath) return { ok: false, canceled: true }
            writeFileSync(result.filePath, content, 'utf8')
            return { ok: true, path: result.filePath }
        } catch (error) {
            log.error('save-slashing-protection error:', error)
            return { ok: false, error: error.message || 'Could not save the file' }
        }
    });

    ipcMain.handle('get-validator-states', async (_, nodeId, pubkeys, beaconUrl) => {
        try {
            const node = nodeManager.findNode(nodeId)
            if (!node) throw new Error('Node not found')
            return await node.getValidatorStates(pubkeys, { beaconUrl })
        } catch (error) {
            log.error('get-validator-states error:', error)
            return { ok: false, error: error.message || 'get-validator-states failed', states: {} }
        }
    });

    ipcMain.handle('check-checkpoint-sync', async (_, nodeId, url) => {
        try {
            const node = nodeManager.findNode(nodeId)
            if (!node) throw new Error('Node not found')
            return await node.checkCheckpointSync(url)
        } catch (error) {
            log.error('check-checkpoint-sync error:', error)
            return { ok: false, error: error.message || 'Check failed' }
        }
    });

    ipcMain.handle('get-raw-service-config', async (_, nodeId, serviceId) => {
        try {
            const node = nodeManager.findNode(nodeId)
            if (!node) throw new Error('Node not found')
            return await node.fetchRawServiceConfig(serviceId)
        } catch (error) {
            log.error('get-raw-service-config error:', error)
            throw error
        }
    });

    ipcMain.handle('write-service-config', async (_, nodeId, serviceId, content) => {
        try {
            const node = nodeManager.findNode(nodeId)
            if (!node) throw new Error('Node not found')
            await node.writeServiceConfig(serviceId, content)
        } catch (error) {
            log.error('write-service-config error:', error)
            throw error
        }
    });
}
