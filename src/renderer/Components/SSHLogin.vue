<template>
    <div class="login-container">
        <h1>SSH Login</h1>
        <div class="ssh-container">
            <div class="server-manager">
                <div class="server-list">
                    <div v-for="server in servers" :key="server.ip" class="server">
                        <p>{{ server.name }}</p>
                        <p>{{ server.ip }}</p>
                    </div>
                </div>
                <div class="button" v-on:click="importServer">
                    Import From Stereum
                </div>
            </div>
            <div class="ssh-form">
            </div>
        </div>
    </div>
</template>
<script setup>
import { ref } from 'vue'
const servers = ref([])

function importServer() {console.log('importing server')}

servers.value.push({name: 'Server1', ip: '192.168.1.1',})
servers.value.push({name: 'Server2', ip: '192.168.1.2',})
servers.value.push({name: 'Server3', ip: '192.168.1.3',})
servers.value.push({name: 'Server4', ip: '192.168.1.4',})
servers.value.push({name: 'Server5', ip: '192.168.1.5',})
servers.value.push({name: 'Server6', ip: '192.168.1.6',})
servers.value.push({name: 'Server7', ip: '192.168.1.7',})
servers.value.push({name: 'Server1', ip: '192.168.1.1',})
servers.value.push({name: 'Server2', ip: '192.168.1.2',})
servers.value.push({name: 'Server3', ip: '192.168.1.3',})
servers.value.push({name: 'Server4', ip: '192.168.1.4',})
servers.value.push({name: 'Server5', ip: '192.168.1.5',})
servers.value.push({name: 'Server6', ip: '192.168.1.6',})
servers.value.push({name: 'Server7', ip: '192.168.1.7',})
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
    background-color: #A1A6B4;
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
.server{
    display: flex;
    flex-direction: column;
    background-color: #B4D2E7;
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
    background-color: #A1A6B4;
    border-radius: 5px;
    box-shadow: 0 0 10px rgba(0, 0, 0, 0.3);
}
.server-list {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    background-color: #A1A6B4;
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
    flex-grow: 1
}
.login-container {
    display: flex;
    flex-direction: column;
    width: 90vw;
    height: 90vh;
    background-color: #3D4250;
    border-color: black;
    border-radius: 5px;
    box-shadow: 0 0 10px rgba(0, 0, 0, 0.3);
    padding: 20px;
}
.login-container h1 {
    color: #A1A6B4;
    text-align: left;
    margin: 0;
}
</style>