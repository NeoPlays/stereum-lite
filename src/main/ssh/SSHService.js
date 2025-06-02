import { Client } from 'ssh2'
import { readFileSync } from 'fs'
import log from 'electron-log'
import crypto from 'crypto'

export class SSHParams {
    constructor(host, port, username, password, privateKey, passphrase) {
        this.name = ""
        this.host = host
        this.port = port
        this.username = username
        this.password = password
        this.privateKey = readFileSync(privateKey, 'utf8')
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
    constructor(SSHParams) {
        this.connections = []
        this.SSHParams = SSHParams
    }

    async getConnection(){
        const conn = this.connections.find(c => c.sessionCount <= SSHService.MAX_SESSION_COUNT)
        if (conn) {
            conn.sessionCount++
            return conn
        } else {
            await this.connect()
            const newConn = this.connections.find(c => c.sessionCount <= SSHService.MAX_SESSION_COUNT)
            if (newConn) {
                newConn.sessionCount++
                return newConn
            } else {
                throw new Error('No available SSH connection')
            }
        }
    }

    async exec(command, useSudo = true) {
        if (useSudo) {
            command = "sudo " + command
        }
        return new Promise(async (resolve, reject) => {
            const sshConn = await this.getConnection()
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
              conn.exec(command, (err, stream) => {
                if (err) {
                  log.error("ERROR:", err);
                  return reject(err);
                }
                stream
                  .on("close", (code) => {
                    data.rc = code;
                    resolve(data);
                  })
                  .on("data", (stdout) => {
                    data.stdout += stdout.toString("utf8");
                  })
                  .stderr.on("data", (stderr) => {
                    log.debug("stderr got data", stderr.toString("utf8"));
                    data.stderr += stderr.toString("utf8");
                  });
              });
        })
    }

    async connect() {
        return new Promise((resolve, reject) => {
            const conn = new Client()
            const sshConn = new SSHConnection(conn)
            const params = this.SSHParams.getConnectionParams()
            conn.connect(params)
            conn.on('ready', async () => {
                log.info('Client :: ready')
                this.connections.push(sshConn)
                if(!this.SSHParams.name){
                    log.info('Client :: get hostname')
                    const hostname = await this.exec('hostname')
                    log.info('Client :: hostname ::', hostname)
                    this.SSHParams.setHostName(hostname.stdout ? hostname.stdout.trim() : 'Unknown')
                }
                resolve({code: 0, message: 'SSH connection established'})
            })
            conn.on('error', (err) => {
                log.error('Client :: error ::', err)
                reject({code: 1, message: 'SSH connection error', error: err})
            })
            conn.on('end', () => {
                log.info('Client :: end')
                this.connections = this.connections.filter(c => c.conn.id !== sshConn.id)
            })
            conn.on('close', () => {
                log.info('Client :: close')
                this.connections = this.connections.filter(c => c.conn.id !== conn.id)
            })
        })
    }

}