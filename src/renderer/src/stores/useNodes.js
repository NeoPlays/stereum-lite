import { defineStore } from 'pinia'

export const useNodesStore = defineStore('nodes', {
    state: () => ({
        nodes: [],
    }),
    getters: {
        getAllNodes: (state) => {
            return state.nodes
        }
    },
    actions:{
        refreshNodes() {
            return window.api.invoke('get-all-nodes').then((data) => {
                this.nodes = data
            }).catch((error) => {
                console.error('Error fetching nodes:', error);
            });
        }
    }
})