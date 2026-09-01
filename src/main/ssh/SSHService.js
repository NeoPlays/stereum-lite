import { Client } from 'ssh2'
import { readFileSync } from 'fs'
import log from 'electron-log'
import crypto from 'crypto'

export class SSHParams {
    constructor(host, port, username, password, privateKey, passphrase) {
        this.name = ""
        this.host = typeof host === 'string' ? host.trim() : host
        this.port = port
        this.username = typeof username === 'string' ? username.trim() : username
        this.password = password
        this.privateKey = readFileSync(typeof privateKey === 'string' ? privateKey.trim() : privateKey, 'utf8')
        this.passphrase = passphrase
    }

    getConnectionParams() {
        return {
            name: this.name,
            host: this.host,
            port: this.port,
            username: this.username,
            password: this.password,
            privateKey: this.privateKey,
            passphrase: this.passphrase
        }
    }

    setHostName(name) {
        this.name = name
    }
}

export class SSHConnection {
    constructor(conn) {
        this.id = crypto.randomUUID()
        this.conn = conn
        this.sessionCount = 0
    }
}

export class SSHService {
    static MAX_SESSION_COUNT = 5
    static EXEC_TIMEOUT_MS = 15_000
    // Idle window for playbook execs - resets on output, so it only covers the longest silent stretch, not total runtime
    static PLAYBOOK_TIMEOUT_MS = 10 * 60_000
    static KEEPALIVE_INTERVAL_MS = 10_000
    static KEEPALIVE_COUNT_MAX = 3
    static READY_TIMEOUT_MS = 15_000
    static RECONNECT_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000]

    constructor(SSHParams, onStateChange = null) {
        this.connections = []
        this.SSHParams = SSHParams
        this._reachable = false
        this._onStateChange = onStateChange
        this._lastState = null
        this._reconnecting = false
        this._reconnectAbort = null
    }

    async reconnect() {
        this._reconnectAbort?.abort()
        if (this._reachable) return true
        const abort = new AbortController()
        this._reconnectAbort = abort
        this._reconnecting = true
        this._emitState('reconnecting')
        try {
            await this.connect()
            return true
        } catch (e) {
            log.warn('SSH :: reconnect failed:', e?.message || e)
            if (!abort.signal.aborted) this._emitState('disconnected')
            return false
        } finally {
            if (this._reconnectAbort === abort) {
                this._reconnecting = false
                this._reconnectAbort = null
            }
        }
    }

    async _reconnectWithBackoff() {
        this._reconnectAbort?.abort()
        if (this._reachable) return true
        const abort = new AbortController()
        this._reconnectAbort = abort
        this._reconnecting = true
        this._emitState('reconnecting')
        const delays = SSHService.RECONNECT_DELAYS_MS
        try {
            for (let i = 0; i < delays.length; i++) {
                try {
                    await this._sleep(delays[i], abort.signal)
                } catch {
                    return false
                }
                try {
                    await this.connect()
                    return true
                } catch (e) {
                    log.warn(`SSH :: backoff ${i + 1}/${delays.length} failed: ${e?.message || e}`)
                }
            }
            this._emitState('disconnected')
            return false
        } finally {
            if (this._reconnectAbort === abort) {
                this._reconnecting = false
                this._reconnectAbort = null
            }
        }
    }

    _sleep(ms, signal) {
        return new Promise((resolve, reject) => {
            const t = setTimeout(resolve, ms)
            signal.addEventListener('abort', () => {
                clearTimeout(t)
                reject(new Error('aborted'))
            }, { once: true })
        })
    }

    _emitState(state) {
        if (state === this._lastState) return
        this._lastState = state
        try { this._onStateChange?.(state) } catch (e) { log.error('onStateChange error:', e) }
    }

    async _getConnection(){
        const conn = this.connections.find(c => c.sessionCount <= SSHService.MAX_SESSION_COUNT)
        if (conn) {
            conn.sessionCount++
            return conn
        }
        if (!this._reachable) {
            throw { code: 1, message: 'SSH connection unavailable' }
        }
        await this.connect()
        const newConn = this.connections.find(c => c.sessionCount <= SSHService.MAX_SESSION_COUNT)
        if (newConn) {
            newConn.sessionCount++
            return newConn
        }
        throw new Error('No available SSH connection')
    }

    /**
     * Run a command over SSH and collect its output.
     *
     * `input` is written to the command's STDIN and then closed. This is the only way to hand a
     * remote command a secret (keymanager token, keystore JSON, keystore password) without it
     * appearing in the host's process list, where a bare `-H 'Authorization: Bearer x'` would sit
     * in plain view of every user on the box. Note the command still runs under `sudo` by default;
     * that is safe here only because stereum hosts have passwordless sudo, so sudo passes stdin
     * straight through to the child instead of consuming it as a password.
     */
    async exec(command, useSudo = true, { timeoutMs = SSHService.EXEC_TIMEOUT_MS, input = null } = {}) {
        if (useSudo) {
            command = "sudo " + command
        }
        log.debug('%cCOMMAND:%c', 'color: yellow', 'color: unset', command)
        // The executor is async because it awaits _getConnection before wiring the stream.
        // Restructuring that touches every SSH call path in the app, so it stays as-is rather
        // than being changed as a side effect of an unrelated feature.
        // eslint-disable-next-line no-async-promise-executor
        return new Promise(async (resolve, reject) => {
            let sshConn
            try {
                sshConn = await this._getConnection()
            } catch (err) {
                return reject(err)
            }
            const conn = sshConn.conn
            if (!conn) {
                reject({code: 1, message: 'No SSH connection available'})
                return
            }
            const data = {
                rc: -1,
                stdout: "",
                stderr: "",
              };
              let settled = false
              let activeStream = null
              let timer = null
              // Idle timeout: re-armed on every output chunk, so only a silent/dead socket trips it
              const arm = () => {
                if (timer) clearTimeout(timer)
                timer = setTimeout(() => {
                  if (settled) return
                  settled = true
                  log.warn('SSH :: EXEC TIMEOUT (idle) ::', command)
                  try { activeStream?.close() } catch { /* ignore */ }
                  reject({ rc: -1, code: 1, message: 'SSH exec timeout' })
                }, timeoutMs)
              }
              arm()

              conn.exec(command, (err, stream) => {
                if (err) {
                  if (settled) return
                  settled = true
                  if (timer) clearTimeout(timer)
                  log.error("ERROR:", err);
                  return reject(err);
                }
                activeStream = stream
                stream
                  .on("close", (code) => {
                    if (settled) return
                    settled = true
                    if (timer) clearTimeout(timer)
                    data.rc = code;
                    resolve(data);
                  })
                  .on("data", (stdout) => {
                    data.stdout += stdout.toString("utf8");
                    arm();
                  })
                  .stderr.on("data", (stderr) => {
                    data.stderr += stderr.toString("utf8");
                    arm();
                  });

                // Feed the secret in and close stdin, so a remote `read`/`cat` sees EOF and
                // doesn't hang until the idle timeout. Only touched when a caller opts in.
                if (input != null) {
                  try {
                    stream.end(input)
                  } catch (e) {
                    log.error('SSH :: failed writing exec stdin:', e?.message || e)
                  }
                }
              });
        })
    }

    /** Stream a long-running command line-by-line via onLine; returns a handle with abort(). */
    async execStream(command, { onLine, onClose, onError, useSudo = true } = {}) {
        if (useSudo) command = "sudo " + command
        log.debug('SSH :: STREAM :: %s', command)
        let sshConn
        try {
            sshConn = await this._getConnection()
        } catch (err) {
            onError?.(err)
            onClose?.({ rc: -1, error: err })
            return { abort() {} }
        }
        const conn = sshConn.conn
        let stream = null
        let closed = false
        let buffer = ''

        const emitLines = (chunk) => {
            buffer += chunk.toString('utf8')
            let idx
            while ((idx = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, idx).replace(/\r$/, '')
                buffer = buffer.slice(idx + 1)
                try { onLine?.(line) } catch (e) { log.warn('execStream onLine threw:', e?.message || e) }
            }
        }

        const handle = {
            abort() {
                if (closed) return
                try { stream?.close() } catch { /* ignore */ }
            },
        }

        conn.exec(command, (err, s) => {
            if (err) {
                if (closed) return
                closed = true
                onError?.(err)
                onClose?.({ rc: -1, error: err })
                return
            }
            stream = s
            s.on('close', (code) => {
                if (closed) return
                closed = true
                if (buffer.length) {
                    try { onLine?.(buffer.replace(/\r$/, '')) } catch { /* ignore */ }
                    buffer = ''
                }
                onClose?.({ rc: code })
            })
            s.on('data', emitLines)
            s.stderr.on('data', emitLines)
        })

        return handle
    }

    disconnect() {
        this._reachable = false
        this._reconnectAbort?.abort()
        this.connections.forEach(c => c.conn.end())
        this.connections = []
        this._emitState('disconnected')
    }

    async connect() {
        return new Promise((resolve, reject) => {
            const conn = new Client()
            const sshConn = new SSHConnection(conn)
            const params = this.SSHParams.getConnectionParams()
            const dropConnection = () => {
                this.connections = this.connections.filter(c => c.id !== sshConn.id)
                if (this.connections.length === 0) {
                    const wasConnected = this._lastState === 'connected'
                    this._reachable = false
                    if (wasConnected && !this._reconnecting) {
                        this._reconnectWithBackoff()
                    } else if (!this._reconnecting) {
                        this._emitState('disconnected')
                    }
                }
            }
            conn.connect({
                ...params,
                keepaliveInterval: SSHService.KEEPALIVE_INTERVAL_MS,
                keepaliveCountMax: SSHService.KEEPALIVE_COUNT_MAX,
                readyTimeout: SSHService.READY_TIMEOUT_MS,
            })
            conn.on('ready', async () => {
                this.connections.push(sshConn)
                this._reachable = true
                this._emitState('connected')
                if(!this.SSHParams.name){
                    const hostname = await this.exec('hostname')
                    this.SSHParams.setHostName(hostname.stdout ? hostname.stdout.trim() : 'Unknown')
                }
                resolve({code: 0, message: 'SSH connection established'})
            })
            conn.on('error', (err) => {
                log.error('SSH :: ERROR :: ', err)
                dropConnection()
                reject({code: 1, message: 'SSH connection error', error: err})
            })
            conn.on('end', () => {
                log.info('SSH :: END')
                dropConnection()
            })
            conn.on('close', () => {
                log.info('SSH :: CLOSE')
                dropConnection()
            })
        })
    }

}