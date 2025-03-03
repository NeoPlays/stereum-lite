import { Client } from 'ssh2';
import log from 'electron-log';

interface SSHConnection {
  id: number;
  client: Client;
  isInUse: boolean;
}

interface SSHCredentials {
    host: string;
    port?: number;
    username: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
}

export class SSHPool {
  private static instance: SSHPool;
  private pool: SSHConnection[] = [];
  private poolSize = 5;
  private connectionIdCounter = 0;
  private credentials: SSHCredentials;

  private constructor() {
    // empty bc singleton
  }

  /**
   * Singleton-Accessor
   */
  public static getInstance(): SSHPool {
    if (!SSHPool.instance) {
      SSHPool.instance = new SSHPool();
    }
    return SSHPool.instance;
  }

  public setCredentials(credentials: SSHCredentials) {
    this.credentials = credentials;
  }

  /**
   * Create Connection and add it to the pool
   */
  private async createConnection(): Promise<SSHConnection> {
    const client = new Client();
    const id = this.connectionIdCounter++;

    return new Promise((resolve, reject) => {
      client.on("ready", () => {
        log.info(`✅ SSH Connection ${id} established`);
        this.pool.push({ id, client, isInUse: false });
        resolve({ id, client, isInUse: false });
      });

      client.on("error", (err) => {
        log.error(`❌ SSH Connection ${id} failed:`, err);
        reject(err);
      });

      client.connect({
        host: this.credentials.host,
        port: this.credentials.port || 22,
        username: this.credentials.username,
        password: this.credentials.password,
        privateKey: this.credentials.privateKey,
        passphrase: this.credentials.passphrase,
      });
    });
  }

  /**
   * Gets a connection from the pool or creates a new one
   */
  public async getConnection(): Promise<SSHConnection> {
    let connection = this.pool.find((conn) => !conn.isInUse);

    if (!connection && this.pool.length < this.poolSize) {
      connection = await this.createConnection();
    }

    if (connection) {
      connection.isInUse = true;
      return connection;
    }

    throw new Error("No free SSH connections available");
  }

  /**
   * executes a command
   */

  public async exec(command: string): Promise<{ rc: number; stdout: string; stderr: string }> {
    const conn = await this.getConnection();
    return new Promise((resolve, reject) => {

      const data = {
        rc: -1,
        stdout: "",
        stderr: "",
      };
      conn.client.exec(command, (err, stream) => {
        if (err) {
          log.error("ERROR:", err);
          return reject(err);
        }
        stream
          .on("close", (code: number) => {
            data.rc = code;
            resolve(data);
          })
          .on("data", (stdout: string) => {
            data.stdout += stdout.toString();
          })
          .stderr.on("data", (stderr: string) => {
            log.error("stderr got data:", stderr.toString());
            data.stderr += stderr.toString();
          });
      });
    });
  }

  /**
   * Releases a connection back to the pool
   */
  public releaseConnection(connection: SSHConnection) {
    connection.isInUse = false;
  }

  /**
   * Closes all connections in the pool
   */
  public closeAllConnections() {
    this.pool.forEach((conn) => conn.client.end());
    this.pool = [];
    log.info("🔻 Closed all SSH Connections");
  }
}
