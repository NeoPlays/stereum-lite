<template>
    <div class="login-container">
        <h1>SSH Login</h1>
        <div class="ssh-container">
            <div class="server-manager">
                <div class="server-list">
                    <div v-for="server in servers" :key="server.ip" class="server">
                        <p>{{ server.name }}</p>
                        <p>{{ server.host }}</p>
                    </div>
                </div>
                <div class="button" @click="importServer">Import From Stereum</div>
            </div>
            <div class="ssh-form"></div>
        </div>
    </div>
</template>
<script setup>
import { onMounted, ref } from 'vue'
const servers = ref([])

async function importServer() {
    servers.value = await window.api.invoke('import-server-from-stereum');
}

onMounted(() => {
    console.log('SSHLogin.vue mounted')
    window.api.invoke('store-get', 'server').then((data) => {
        servers.value = data
    })
})
</script>
<style scoped>
.server-manager {
    display: flex;
    flex-direction: column;
    height: auto;
    width: 100%;
    color: black;
    padding: 10px;
}
.button {
    background-color: #a1a6b4;
    border-radius: 5px;
    box-shadow: 0 0 10px rgba(0, 0, 0, 0.3);
    color: black;
    margin: 10px;
    padding: 10px;
    cursor: pointer;
}
.server p {
    margin: 0;
}
.server {
    display: flex;
    flex-direction: column;
    background-color: #b4d2e7;
    border-radius: 5px;
    box-shadow: 0 0 10px rgba(0, 0, 0, 0.3);
    color: black;
    margin: 10px;
    padding: 10px;
}
.ssh-form {
    display: flex;
    height: 100%;
    width: 100%;
    background-color: #a1a6b4;
    border-radius: 5px;
    box-shadow: 0 0 10px rgba(0, 0, 0, 0.3);
}
.server-list {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    background-color: #a1a6b4;
    overflow-y: auto;
    max-height: 100%;
    box-shadow: 0 0 10px rgba(0, 0, 0, 0.3);
    border-radius: 5px;
}
.ssh-container {
    display: flex;
    flex-direction: row;
    align-self: center;
    height: 90%;
    width: 100%;
    gap: 20px;
    box-sizing: border-box;
    flex-grow: 1;
}
.login-container {
    display: flex;
    flex-direction: column;
    width: 90vw;
    height: 90vh;
    background-color: #3d4250;
    border-color: black;
    border-radius: 5px;
    box-shadow: 0 0 10px rgba(0, 0, 0, 0.3);
    padding: 20px;
}
.login-container h1 {
    color: #a1a6b4;
    text-align: left;
    margin: 0;
}
</style>
