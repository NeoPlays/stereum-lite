import Store from 'electron-store';
import log from 'electron-log';



export class StoreService {
    private store: Store;

    public constructor(name: Record<string, unknown>) {
        log.info(`Creating new Store ${name}`);
        this.store = new Store(name);
    }

    public get(key?: string): Record<string, unknown> {
        return this.store.get(key ? key : undefined) as Record<string, unknown>;
    }

    public set(key: string, value: Record<string, unknown>): void {
        this.store.set(key, value);
    }
}