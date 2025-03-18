<template>
    <div class="ssh-server-list">
        <div class="ssh-server" v-for="server in servers" :key="server.name" @click="$emit('selectServer', server)">
            <span class="ssh-server-name">{{ server.name }}</span>
            <span class="ssh-server-host">{{ server.host }}</span>
        </div> 
    </div>
</template>
<script setup>
import { onMounted, ref} from 'vue'


const servers = ref([])

async function importServer() {
    servers.value = await window.api.invoke('import-server-from-stereum');
}

async function loadServers() {
    servers.value = await window.api.invoke('store-get', 'server');
}

onMounted(() => {
    console.log('SSHServerList.vue mounted')
    loadServers()
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