import log from "electron-log";
import { readFileSync } from "fs";

export class StoreService {
    constructor() {
        this.init();
    }

    async init(){
        const Store = ( await import('electron-store') ).default;
        this.store = new Store();
    }
    
    get(key) {
        return this.store.get(key);
    }
    
    set(key, value) {
        this.store.set(key, value);
    }
    
    delete(key) {
        this.store.delete(key);
    }
    
    clear() {
        this.store.clear();
    }
    
    onDidChange(key, callback) {
        this.store.onDidChange(key, callback);
    }

    importFromStereum() {
        log.info("Importing server from Stereum");
        const configFile = readFileSync(this.store.path.replace('stereum-lite', 'stereum-launcher'), 'utf8');
        const data = JSON.parse(configFile);
        const formatedData = data['config-v2'].savedConnections.map(({ name, host, port = 22, user = 'root', keylocation = '' }) => ({
            name,
            host,
            port,
            username: user,
            privateKey: keylocation,
        }));
        
        let existing = this.get('server') ?? [];
        formatedData.forEach((item) => {
            if (!existing.some((element) => element.name === item.name)) {
                existing.push(item);
            }
        });

        this.set('server', existing);
        return this.get('server');
    }
}