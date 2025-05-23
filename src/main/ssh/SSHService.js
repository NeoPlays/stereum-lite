import { Client } from 'ssh2'
import { readFileSync } from 'fs'
import log from 'electron-log'
import crypto from 'crypto'

export class SSHParams {
    constructor(host, port, username, password, privateKey, passphrase) {
        this.host = host
        this.port = port
        this.username = username
        this.password = password
        this.privateKey = readFileSync(privateKey, 'utf8')
        this.passphrase = passphrase
    }

    getConnectionParams() {
        return {
            host: this.host,
            port: this.port,
            username: this.username,
            password: this.password,
            privateKey: this.privateKey,
            passphrase: this.passphrase
        }
    }
}

export class SSHConnection {
    constructor(conn) {
        this.id = crypto.randomUUID()
        this.conn = conn
    }
}

export class SSHService {
    constructor(SSHParams) {
        this.connections = []
        this.SSHParams = SSHParams
    }

    async connect() {
        return new Promise((resolve, reject) => {
            const conn = new Client()
            const params = this.SSHParams.getConnectionParams()
            conn.connect(params)
            conn.on('ready', () => {
                log.info('Client :: ready')
                this.connections.push(new SSHConnection(conn))
                resolve({code: 0, message: 'SSH connection established'})
            })
            conn.on('error', (err) => {
                log.error('Client :: error ::', err)
                reject({code: 1, message: 'SSH connection error', error: err})
            })
            conn.on('end', () => {
                log.info('Client :: end')
                this.connections = this.connections.filter(c => c.conn !== conn)
            })
            conn.on('close', () => {
                log.info('Client :: close')
                this.connections = this.connections.filter(c => c.conn !== conn)
            })
        })
    }

}