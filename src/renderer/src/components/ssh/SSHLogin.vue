<template>
    <div class="ssh-login">
        <SSHServerList @select-server="selectServer"/>
        <div class="ssh-form">
            <div class="ssh-credentials">
                <div class="ssh-credentials-row">
                    <label for="ssh-credentials-name">Name</label>
                    <input type="text" id="ssh-credentials-name" v-model.trim="credentials.name"/>
                </div>
                <div class="ssh-credentials-row">
                    <label for="ssh-credentials-host">Host</label>
                    <input type="text" id="ssh-credentials-host" v-model.trim="credentials.host"/>
                </div>
                <div class="ssh-credentials-row">
                    <label for="ssh-credentials-port">Port</label>
                    <input type="number" id="ssh-credentials-port" v-model.number="credentials.port"/>
                </div>
                <div class="ssh-credentials-row">
                    <label for="ssh-credentials-username">Username</label>
                    <input type="text" id="ssh-credentials-username" v-model.trim="credentials.username"/>
                </div>
                <div class="ssh-credentials-row">
                    <label for="ssh-credentials-password">Password</label>
                    <input type="password" id="ssh-credentials-password" v-model="credentials.password"/>
                </div>
                <div class="ssh-credentials-row">
                    <label for="ssh-credentials-private-key">Private Key</label>
                    <input type="text" id="ssh-credentials-private-key" v-model.trim="credentials.privateKey"/>
                </div>
                <div class="ssh-credentials-row">
                    <label for="ssh-credentials-passphrase">Passphrase</label>
                    <input type="password" id="ssh-credentials-passphrase" v-model="credentials.passphrase"/>
                </div>
                <div class="ssh-credentials-row">
                    <button class="ssh-login-button" @click="login">Login</button>
                </div>
                <div class="ssh-credentials-row">
                    <button class="ssh-save-button" @click="save">Save</button>
                </div>
            </div>
        </div>
    </div>
</template>
<script setup>
import { onMounted, ref, defineEmits } from 'vue'
import SSHServerList from './SSHServerList.vue'
import _ from 'lodash'

const emit = defineEmits(['login'])

const credentials = ref({
    name: '',
    host: '',
    port: 22,
    username: '',
    password: '',
    privateKey: '',
    passphrase: ''
})

async function login() {
    await window.api.invoke('ssh-login', _.cloneDeep(credentials.value))
    emit('login', credentials.value)
}

async function save() {
    // not optimal, but it works
    // TODO: refactor to use a store
    const servers = await window.api.invoke('store-get', 'server')
    servers[servers.findIndex(server => server.host === credentials.value.host)] = copyCredentials(credentials.value)
    await window.api.invoke('store-set', 'server', _.cloneDeep(servers))
}

function selectServer(server) {
    credentials.value = copyCredentials(server, true)
}

function copyCredentials(creds, withSecrets=false) {
    if (withSecrets) {
        return _.cloneDeep(creds)
    }
    const copy = _.cloneDeep(creds)
    delete copy.password
    delete copy.passphrase
    return copy
}

onMounted(() => {
    console.log('SSHLogin.vue mounted')
})
</script>
<style scoped>
.ssh-login {
    display: flex;
    flex-direction: row;
    width: 100%;
    justify-content: center;
    gap: 50px;
}
.ssh-form {
    display: flex;
    max-width: 100%;
    background-color: #a1a6b4;
    border-radius: 5px;
    box-shadow: 0 0 10px rgba(0, 0, 0, 0.3);
    padding: 20px;
}
.ssh-credentials {
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.ssh-credentials-row {
    display: flex;
    flex-direction: row;
    justify-content: space-between;
    gap: 10px;
}
.ssh-credentials-row input {
    border: none;
    border-radius: 5px;
    padding: 5px;
}

.ssh-credentials-row label {

}

.ssh-login-button {

}

</style>
