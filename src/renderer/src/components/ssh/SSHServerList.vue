<template>
    <div class="ssh-server-list">
        <div class="ssh-server" v-for="server in server" :key="server.name" @click="$emit('selectServer', server)">
            <span class="ssh-server-name">{{ server.name }}</span>
            <span class="ssh-server-host">{{ server.host }}</span>
        </div> 
    </div>
</template>
<script setup>
import { onMounted, ref} from 'vue'
import { storeToRefs } from 'pinia'
import { useServerStore } from '@stores/useServer';

const store = useServerStore()

const { server } = storeToRefs(store)
const { getServer, setServer } = store

async function importServer() {
    await setServer(await window.api.invoke('import-server-from-stereum'))
}

async function loadserver() {
    await getServer()
}

onMounted(() => {
    console.log('SSHServerList.vue mounted')
    loadserver()
})
</script>
<style scoped>
.ssh-server-list {
    display: flex;
    flex-direction: column;
    max-width: 100%;
    max-height: 500px;
    background-color: #a1a6b4;
    padding: 20px;
    border-radius: 5px;
    box-shadow: 0 0 10px rgba(0, 0, 0, 0.3);
    overflow: auto;
}
.ssh-server {
    display: flex;
    flex-direction: column;
    margin: 10px;
    padding: 5px;
    border-radius: 5px;
    background-color: #b4d2e7;
    cursor: pointer;
}
</style>