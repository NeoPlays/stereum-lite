import { defineStore } from 'pinia'
import _ from 'lodash'

export const useServerStore = defineStore('server', {
    state: () => ({
        server: [],
    }),
    getters: {},
    actions:{
        async getServer() {
            return this.server = await window.api.invoke('store-get', 'server');
        },
        async setServer(server) {
            await window.api.invoke('store-set', 'server', server)
            await this.getServer()
        }
    }
})