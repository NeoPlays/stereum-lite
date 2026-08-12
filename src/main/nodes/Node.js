import { SSHService, SSHParams } from "@main/ssh/SSHService";
import { taskContext, parseSubTasks } from "@main/tasks/TaskManager";
import {
    SYSTEM_METRICS_CMD, parseSystemMetrics,
    buildClientProbeScript, parseClientMetrics,
    buildDiskBreakdownCommand, parseDiskBreakdown,
    CURL_IMAGE, STEREUM_DOCKER_NETWORK,
    PROMETHEUS_SERVICE, PROMETHEUS_PORT,
    shellQuote,
} from "@main/nodes/metrics";
import {
    isResyncable, resolveDataDir, isSafeDataDir, updateSyncCommand, supportsCheckpointSync,
} from "@main/nodes/resync";
import { buildCheckpointProbeScript, parseCheckpointResult } from "@main/nodes/checkpoint";
import {
    keymanagerInfo, keymanagerTarget, buildKeymanagerScript, wrapSidecar,
    buildTokenReadCommand, parseToken, buildWeb3SignerScript,
    parseKeymanagerResponse, parseKeystoresList, parseWeb3SignerPubkeys, validatorListable,
} from "@main/nodes/keymanager";
import { buildClusterLockReadCommand, parseClusterLock } from "@main/nodes/dvt";
import YAML from 'yaml';
import { randomUUID } from "crypto";
import log from 'electron-log';

// Interval for re-reading a running playbook's log to stream live sub-tasks (task context only).
const PLAYBOOK_POLL_MS = 2000;

/**
 * Represents a remote node managed via SSH
 */

export class Node {

    constructor(sshCredentials) {
        this.id = randomUUID();
        this.status = 'disconnected';
        this._statusListeners = new Set();
        this.sshService = new SSHService(
            new SSHParams(sshCredentials.host, sshCredentials.port, sshCredentials.username, sshCredentials.password, sshCredentials.privateKey, sshCredentials.passphrase),
            (state) => this._setStatus(state)
        );
        this.settings = null;
        this.services = [];
        this.setups = null;
    }

    _setStatus(status) {
        if (this.status === status) return;
        log.info(`Node :: ${this.sshService.SSHParams.host} :: ${this.status} → ${status}`);
        this.status = status;
        for (const cb of this._statusListeners) {
            try { cb(status) } catch (e) { log.error('status listener error:', e) }
        }
    }

    onStatusChange(cb) {
        this._statusListeners.add(cb);
        return () => this._statusListeners.delete(cb);
    }

    /**
     * @returns lightweight list DTO (no SSH calls)
     */
    toListDTO(){
        return {
            id: this.id,
            name: this.sshService.SSHParams.name,
            host: this.sshService.SSHParams.host,
            connected: this.sshService.connections.length > 0,
            status: this.status,
        }
    }

    async toDTO(refresh = false){
        await this.fetchSettings(refresh);
        await this.fetchServices(refresh);
        await this.fetchServiceConfigs();
        await this.fetchSetups(refresh);
        const containerStatuses = await this.fetchContainerStatuses();
        // serviceId -> its setup, so each service DTO carries its group + network.
        const setupByService = {}
        for (const setup of this.setups) {
            for (const sid of setup.services) setupByService[sid] = setup
        }
        return {
            id: this.id,
            name: this.sshService.SSHParams.name,
            host: this.sshService.SSHParams.host,
            port: this.sshService.SSHParams.port,
            username: this.sshService.SSHParams.username,
            status: this.status,
            settings: this.settings,
            setups: this.setups,
            services: this.services.map(s => {
                const su = setupByService[s.id]
                return {
                    ...s,
                    container: containerStatuses[s.id] ?? null,
                    setup: su ? { id: su.id, name: su.name, network: su.network, type: su.type, color: su.color } : null,
                    // Resync capability is a property of the client type (see resync.js) - the
                    // renderer can't import main-process modules, so surface it on the DTO.
                    resyncable: isResyncable(s.config),
                    supportsCheckpoint: supportsCheckpointSync(s.config),
                    // Validators tab: whether this service answers a keymanager-style read
                    // (the 5 VCs with the API flag on, + Web3Signer). reason = 'api-not-enabled'
                    // lets the UI explain a known client whose keymanager flag is off.
                    ...(() => { const km = keymanagerInfo(s.config); return { keymanagerCapable: km.capable, keymanagerReason: km.reason } })(),
                    // Whether the Validators tab can list keys for this service (keymanager API
                    // or Obol's cluster-lock.json). SSV lists via an external API - not yet wired.
                    validatorListable: validatorListable(s.config),
                }
            }),
        }
    }

    /**
     * Read `/etc/stereum/multisetup.yaml` (NOT under controls_install_path): map keyed by setup id;
     * type `common` = node-wide services. Absent on single-setup/older nodes - treated as no setups.
     * @returns {Promise<{ id, name, network, color, type, services: string[] }[]>}
     */
    async fetchSetups(refresh = false) {
        if (refresh || !this.setups) {
            const path = '/etc/stereum/multisetup.yaml'
            const response = await this.sshService.exec(`cat ${path}`)
            // Missing file (rc 1) means no multi-setup grouping; log it and carry on.
            if (response.rc !== 0 && response.rc !== null) {
                log.warn(`Node :: ${this.sshService.SSHParams.host} :: ${path} not found or unreadable (rc=${response.rc}): ${response.stderr?.trim() || 'no stderr'}`)
                this.setups = []
                return this.setups
            }
            const parsed = response.stdout?.trim() ? YAML.parse(response.stdout) : null
            this.setups = parsed && typeof parsed === 'object'
                ? Object.entries(parsed).map(([id, s]) => ({
                    id,
                    name: s?.name ?? id,
                    network: s?.network ?? null,
                    color: s?.color ?? null,
                    type: s?.type ?? null,
                    services: Array.isArray(s?.services) ? s.services : [],
                }))
                : []
        }
        return this.setups
    }

    /**
     * Fetch the node settings
     * @param {Boolean} refresh - force re-fetch
     * @returns parsed settings object
     */
    async fetchSettings(refresh = false) {
        if (refresh || !this.settings) {
            const response = await this.sshService.exec("cat /etc/stereum/stereum.yaml");
            if (response.rc !== 0) throw new Error(response.stderr || 'fetchSettings failed');
            this.settings = YAML.parse(response.stdout);
        }
        return this.settings;
    }
    /**
     * Fetch the node's services
     * @param {Boolean} refresh - force re-fetch
     * @returns parsed services object
     */
    async fetchServices(refresh = false) {
        if (refresh || !this.services || this.services.length === 0) {
            const response = await this.sshService.exec("ls /etc/stereum/services");
            if (response.rc !== 0) throw new Error(response.stderr || 'fetchServices failed');
            const serviceIDs = response.stdout.split('\n').filter(s => s.trim() !== '').map(s => s.replace('.yaml', '').trim());
            this.services = serviceIDs.map(id => ({ id }));
        }
        return this.services;
    }

    async fetchContainerStatuses() {
        const response = await this.sshService.exec("docker ps -a --format '{{json .}}'")
        if (response.rc !== 0) throw new Error(response.stderr || 'fetchContainerStatuses failed')
        const statuses = {}
        for (const line of response.stdout.split('\n').filter(l => l.trim())) {
            try {
                const c = JSON.parse(line)
                const match = c.Names?.match(/stereum-([a-f0-9-]{36})/)
                if (match) statuses[match[1]] = { state: c.State, status: c.Status, image: c.Image }
            } catch { /* skip malformed lines */ }
        }
        return statuses
    }

    async fetchRawServiceConfig(serviceId) {
        const response = await this.sshService.exec(`cat /etc/stereum/services/${serviceId}.yaml`)
        if (response.rc !== 0) throw new Error(response.stderr || `fetchRawServiceConfig failed for ${serviceId}`)
        return response.stdout
    }

    async writeServiceConfig(serviceId, content) {
        const b64 = Buffer.from(content).toString('base64')
        const path = `/etc/stereum/services/${serviceId}.yaml`
        const response = await this.sshService.exec(`echo '${b64}' | base64 -d | sudo tee ${path} > /dev/null`, false)
        if (response.rc !== 0) throw new Error(response.stderr || `writeServiceConfig failed for ${serviceId}`)
    }

    async startService(serviceId) {
        return this.runPlaybook('manage-service', {
            manage_service: { state: 'started', configuration: { id: serviceId } }
        })
    }

    async stopService(serviceId) {
        return this.runPlaybook('manage-service', {
            manage_service: { state: 'stopped', configuration: { id: serviceId } }
        })
    }

    async restartService(serviceId) {
        return this.runPlaybook('manage-service', {
            manage_service: { state: 'restarted', configuration: { id: serviceId } }
        })
    }

    /**
     * Wipe a client's chain data and re-sync from scratch. Genesis by default; a checkpointUrl
     * (consensus clients only) fast-syncs from a trusted source. Composite task op: stop ->
     * wipe data dir -> (CL) rewrite checkpoint flag + write config -> start.
     *
     * Safety: the data dir is resolved from the config and gated by isSafeDataDir BEFORE any
     * stop/rm/write - an unresolved/unsafe path aborts the whole op (never a partial wipe). The
     * wipe runs as `sudo sh -c 'rm -rf <dir>/*'` so root expands the glob (root-owned dirs are
     * unlistable to the SSH user, so a bare `sudo rm -rf <dir>/*` would silently delete nothing).
     * @param {string} serviceId
     * @param {string|null} checkpointUrl - CL checkpoint-sync URL; null/empty = genesis sync
     */
    async resyncService(serviceId, checkpointUrl = null) {
        const raw = await this.fetchRawServiceConfig(serviceId)
        const config = YAML.parse(raw)
        if (!isResyncable(config)) throw new Error(`Service type ${config?.service ?? '?'} is not resyncable`)

        const dataDir = resolveDataDir(config)
        const controlsPath = this.settings?.stereum_settings?.settings?.controls_install_path
        if (!isSafeDataDir(dataDir, { serviceId, controlsPath })) {
            throw new Error(`Refusing resync: unsafe or unresolved data dir (${dataDir})`)
        }

        await this.stopService(serviceId)

        // Write the (reversible) config change BEFORE the (irreversible) wipe: if the write
        // fails, we abort with data still intact rather than wiped-with-a-stale-command.
        // Consensus clients carry the checkpoint/genesis flag in their command; EL clients
        // resync from a wipe alone, so their config is left untouched.
        if (supportsCheckpointSync(config)) {
            config.command = updateSyncCommand(config.command, config.service, checkpointUrl || null)
            await this.writeServiceConfig(serviceId, YAML.stringify(config))
        }

        // Long timeout: deleting a synced client's data (hundreds of GB) runs silent for well
        // over the 15s idle exec timeout. Same rationale as pruneDocker's timeout override.
        const wipe = await this.sshService.exec(
            `sh -c 'rm -rf ${shellQuote(dataDir)}/*'`, true, { timeoutMs: SSHService.PLAYBOOK_TIMEOUT_MS })
        if (wipe.rc !== 0 && wipe.rc !== null) throw new Error(wipe.stderr || `failed to wipe ${dataDir}`)

        await this.startService(serviceId)
    }

    /**
     * Validate a checkpoint-sync URL the way stereum's one-click installer does: HEAD-probe
     * `<url>/eth/v2/debug/beacon/states/finalized` (5s) and accept iff it answers HTTP 200.
     * Runs from a throwaway curl sidecar (guaranteed curl, no host apt-get) - the check is
     * outbound-only, so no stereum network is needed. Read-only; never mutates the node.
     * @param {string} url
     * @returns {Promise<{ ok: boolean, httpCode?: number, error?: string }>}
     */
    async checkCheckpointSync(url) {
        const script = buildCheckpointProbeScript(url)
        if (!script) return { ok: false, error: 'Enter a valid http(s) URL' }
        const escaped = script.replace(/'/g, `'"'"'`)
        const cmd = `docker run --rm --entrypoint sh ${CURL_IMAGE} -c '${escaped}'`
        const response = await this.sshService.exec(cmd, true, { timeoutMs: 20_000 })
        return parseCheckpointResult(response.stdout)
    }

    /**
     * List the validator keys a client is signing for, via the standard Keymanager REST API
     * over a curl sidecar (matches stereum's ValidatorAccountManager). Web3Signer is listed via
     * its own pubkeys endpoint. Read-only. Returns `{ ok, keys:[{pubkey,readonly,derivationPath?}] }`
     * or a soft error object (never throws) so the tab can render a reason instead of a blank.
     *
     * NOTE (v1): the bearer token is passed on the sidecar's curl command line (as stereum does),
     * so it is briefly visible in the host process list - acceptable for a read, revisit for writes.
     * @param {string} serviceId - the key-holding service (a *ValidatorService or Web3SignerService)
     */
    async listValidators(serviceId) {
        const raw = await this.fetchRawServiceConfig(serviceId)
        const config = YAML.parse(raw)

        // Obol: the real distributed-validator pubkeys come from Charon's cluster-lock.json
        // (read off the host), NOT the VC's share keystores. Matches stereum's getDVTKeys.
        if (config.service === 'CharonService') {
            const cmd = buildClusterLockReadCommand(config)
            if (!cmd) return { ok: false, error: 'Could not resolve the Charon data directory', keys: [] }
            const res = await this.sshService.exec(cmd)
            if (res.rc !== 0 && res.rc !== null) return { ok: false, error: 'Could not read cluster-lock.json (is the cluster set up?)', keys: [] }
            return { ok: true, keys: parseClusterLock(res.stdout) }
        }

        const info = keymanagerInfo(config)
        if (!info.capable) return { ok: false, reason: info.reason || 'unsupported', keys: [] }

        // Web3Signer: no bearer token, its own /api/v1/eth2/publicKeys endpoint.
        if (info.web3signer) {
            const res = await this.sshService.exec(wrapSidecar(buildWeb3SignerScript(serviceId)), true, { timeoutMs: 20_000 })
            const { httpCode, body } = parseKeymanagerResponse(res.stdout)
            if (httpCode !== 200) return { ok: false, error: httpCode ? `Web3Signer HTTP ${httpCode}` : 'Web3Signer unreachable', httpCode, keys: [] }
            return { ok: true, keys: parseWeb3SignerPubkeys(body) }
        }

        // Validator client: read the bearer token, then GET /eth/v1/keystores.
        const tokenCmd = buildTokenReadCommand({ id: serviceId, config })
        if (!tokenCmd) return { ok: false, error: 'Could not resolve the keymanager token path', keys: [] }
        const tokenRes = await this.sshService.exec(tokenCmd)
        if (tokenRes.rc !== 0 && tokenRes.rc !== null) return { ok: false, error: 'Could not read the keymanager token (is the client running?)', keys: [] }
        const token = parseToken(config.service, tokenRes.stdout)

        const target = keymanagerTarget(config)
        const script = buildKeymanagerScript({ serviceId, ...target, method: 'GET', path: '/eth/v1/keystores', token })
        const res = await this.sshService.exec(wrapSidecar(script), true, { timeoutMs: 20_000 })
        const { httpCode, body } = parseKeymanagerResponse(res.stdout)
        if (httpCode !== 200) return { ok: false, error: httpCode ? `Keymanager HTTP ${httpCode}` : 'Client API unreachable (running?)', httpCode, keys: [] }
        return { ok: true, keys: parseKeystoresList(body) }
    }

    /**
     * Ids of services whose config changed in the last `timeScopeSeconds` (mirrors the upstream `restart-services` role's selection).
     * @param {number} timeScopeSeconds
     * @returns {Promise<string[]>} ids of changed services
     */
    async findChangedServiceIds(timeScopeSeconds) {
        const scope = Math.floor(Number(timeScopeSeconds))
        if (!Number.isFinite(scope) || scope <= 0) throw new Error('timeScopeSeconds must be a positive number')
        // Requires GNU find (-newermt, -printf).
        const cmd = `find /etc/stereum/services -maxdepth 1 -type f -name '*.yaml' -newermt "${scope} seconds ago" -printf '%f\\n'`
        const response = await this.sshService.exec(cmd)
        if (response.rc !== 0 && response.rc !== null) throw new Error(response.stderr || 'findChangedServiceIds failed')
        return response.stdout
            .split('\n')
            .map(s => s.trim())
            .filter(Boolean)
            .map(f => f.replace(/\.yaml$/, ''))
    }

    /**
     * Restart services changed within the window - the upstream `restart-services` role, but parallel.
     * @param {number} timeScopeSeconds - lookback window in seconds
     * @param {{ prune?: boolean }} [opts] - docker prune afterwards (default true, mirrors the role)
     * @returns {Promise<{ serviceId: string, ok: boolean, error?: string }[]>} per-service outcome
     */
    async restartChangedServices(timeScopeSeconds, { prune = true } = {}) {
        const serviceIds = await this.findChangedServiceIds(timeScopeSeconds)
        const results = await Promise.all(
            serviceIds.map(async (serviceId) => {
                try {
                    await this.restartService(serviceId)
                    return { serviceId, ok: true }
                } catch (e) {
                    return { serviceId, ok: false, error: e?.message || String(e) }
                }
            })
        )
        if (prune && serviceIds.length) await this.pruneDocker()
        return results
    }

    /** Mirror the role's final `docker_prune` (all unused images, not just dangling). */
    async pruneDocker() {
        const response = await this.sshService.exec('docker system prune -af --volumes', true, {
            timeoutMs: SSHService.PLAYBOOK_TIMEOUT_MS,
        })
        if (response.rc !== 0 && response.rc !== null) throw new Error(response.stderr || 'docker prune failed')
        return response.stdout
    }

    /**
     * Stream `docker logs -f` for a service. Returns a handle with .abort().
     * @param {string} serviceId
     * @param {{ tail?: number, onLine: (line: string) => void, onClose?: (info: { rc?: number, error?: Error }) => void }} opts
     */
    async streamServiceLogs(serviceId, { tail = 200, onLine, onClose, onError } = {}) {
        const safeTail = Number.isFinite(tail) && tail > 0 ? Math.floor(tail) : 200
        const cmd = `docker logs -f --tail ${safeTail} stereum-${serviceId}`
        return this.sshService.execStream(cmd, { onLine, onClose, onError })
    }

    async fetchControlsCommit() {
        if (!this.settings) await this.fetchSettings()
        const controlsPath = this.settings?.stereum_settings?.settings?.controls_install_path
        if (!controlsPath) throw new Error('controls_install_path not found in stereum settings')
        const response = await this.sshService.exec(
            `git -C ${controlsPath}/ansible rev-parse HEAD 2>/dev/null || git -C ${controlsPath} rev-parse HEAD 2>/dev/null`
        )
        if (response.rc !== 0 && response.rc !== null) throw new Error(response.stderr || 'fetchControlsCommit failed')
        const commit = response.stdout.trim()
        if (!commit) throw new Error('controls commit not found (not a git checkout?)')
        return commit
    }

    /**
     * OS distro + version string (e.g. "Ubuntu 22.04.3 LTS") from `/etc/os-release` PRETTY_NAME, NAME+VERSION fallback.
     */
    async fetchOsInfo() {
        // No sudo: os-release is world-readable and `.` is a shell builtin sudo can't invoke.
        const response = await this.sshService.exec(
            '. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-$NAME $VERSION}"',
            false
        )
        if (response.rc !== 0 && response.rc !== null) throw new Error(response.stderr || 'fetchOsInfo failed')
        const os = response.stdout.trim()
        if (!os) throw new Error('OS info not found (/etc/os-release missing?)')
        return os
    }

    /**
     * Host system metrics in a single cheap SSH exec - safe to poll. See `metrics.js`.
     */
    async fetchSystemMetrics() {
        // Do NOT wrap in `sh -c '...'` - the command contains single quotes.
        const response = await this.sshService.exec(SYSTEM_METRICS_CMD, false)
        if (response.rc !== 0 && response.rc !== null) throw new Error(response.stderr || 'fetchSystemMetrics failed')
        return parseSystemMetrics(response.stdout)
    }

    /**
     * Sync/peer health for all running EL/CL clients via one curl sidecar on the stereum
     * network (internal API ports, no host publishing). Failed probes carry `error`, never dropped.
     * @returns {Promise<{ [serviceId:string]: object }>}
     */
    async fetchClientMetrics() {
        // Configs are static - only (re)read when missing; container state stays fresh per poll.
        if (!this.services?.length) await this.fetchServices()
        if (this.services.some(s => !s.config)) await this.fetchServiceConfigs()
        const containerStatuses = await this.fetchContainerStatuses()
        const services = this.services.map(s => ({ ...s, container: containerStatuses[s.id] ?? null }))
        // Prefer Prometheus for beacon sync (wall-clock target slot); beacon API is the fallback.
        const prometheus = services.find(s => s.config?.service === PROMETHEUS_SERVICE && s.container?.state === 'running')
        const promHost = prometheus ? `stereum-${prometheus.id}:${PROMETHEUS_PORT}` : null
        const script = buildClientProbeScript(services, { promHost })
        if (!script) return {}
        const escaped = script.replace(/'/g, `'"'"'`)
        const cmd = `docker run --rm --network ${STEREUM_DOCKER_NETWORK} --entrypoint sh ${CURL_IMAGE} -c '${escaped}'`
        const response = await this.sshService.exec(cmd, true)
        if (response.rc !== 0 && response.rc !== null) throw new Error(response.stderr || 'fetchClientMetrics failed')
        return parseClientMetrics(response.stdout, services)
    }

    /**
     * Per-service disk usage (`du` over host volume paths). Heavy - slow cadence only,
     * generous timeout since a cold `du` on chain data is slow.
     */
    async fetchDiskBreakdown() {
        if (!this.settings) await this.fetchSettings()
        if (!this.services?.length) await this.fetchServices()
        if (this.services.some(s => !s.config)) await this.fetchServiceConfigs()
        const dfTarget = this.settings?.stereum_settings?.settings?.controls_install_path || '/'
        const cmd = buildDiskBreakdownCommand(this.services, dfTarget)
        const response = await this.sshService.exec(cmd, true, { timeoutMs: 120_000 })
        if (response.rc !== 0 && response.rc !== null) throw new Error(response.stderr || 'fetchDiskBreakdown failed')
        return parseDiskBreakdown(response.stdout, this.services)
    }

    async fetchUpgradablePackages() {
        const response = await this.sshService.exec("apt list --upgradable 2>/dev/null | tail -n +2")
        if (response.rc !== 0 && response.rc !== null) {
            throw new Error(response.stderr || 'fetchUpgradablePackages failed')
        }
        const pkgs = []
        for (const line of response.stdout.split('\n')) {
            const m = line.match(/^([^/\s]+)\/\S+\s+(\S+)\s+\S+\s+\[upgradable from:\s*([^\]]+)\]/)
            if (m) pkgs.push({ name: m[1], newVersion: m[2], currentVersion: m[3].trim() })
        }
        return pkgs
    }

    async updateOS() {
        return this.runPlaybook('update-os', { only_os_updates: true })
    }

    async updatePackage(name) {
        return this.runPlaybook('update-package', { update_package: { name } })
    }

    /**
     * `update-services` role, no restart. Top-level `services_to_update`: single id as a
     * bare string, multiple as an array, none = all services.
     */
    async _runServicesUpdate(serviceIds = null) {
        const topLevel = serviceIds?.length
            ? { services_to_update: serviceIds.length === 1 ? serviceIds[0] : serviceIds }
            : {}
        return this.runPlaybook('update-services', {}, topLevel)
    }

    /**
     * Update service images + restart changed services (without the restart the running container keeps the old image).
     * @param {string[]|null} serviceIds - ids to update; all services when null/empty
     * @param {{ prune?: boolean }} [opts]
     * @returns {Promise<{ serviceId: string, ok: boolean, error?: string }[]>} restarted services
     */
    async updateServices(serviceIds = null, { prune = true } = {}) {
        const before = this._timestamp()
        await this._runServicesUpdate(serviceIds)
        const elapsed = this._timestamp() - before
        return this.restartChangedServices(elapsed + 10, { prune })
    }

    /**
     * `update-stereum` then `update-changes` (config migrations), no restart - the caller restarts.
     * @param {string|null} commit - optional target commit (override_gitcommit); latest when null
     */
    async _runStereumUpdate(commit = null) {
        await this.runPlaybook('update-stereum', commit ? { override_gitcommit: commit } : {})
        await this.runPlaybook('update-changes')
    }

    /**
     * Update controls + restart changed services (without the restart, `update-changes` migrations wouldn't take effect).
     * @param {string|null} commit - optional target stereum commit
     * @param {{ prune?: boolean }} [opts]
     * @returns {Promise<{ serviceId: string, ok: boolean, error?: string }[]>} restarted services
     */
    async updateStereum(commit = null, { prune = true } = {}) {
        const before = this._timestamp()
        await this._runStereumUpdate(commit)
        const elapsed = this._timestamp() - before
        return this.restartChangedServices(elapsed + 10, { prune })
    }

    /** Current unix timestamp in seconds (rounded up), matching the launcher's getTimeStamp. */
    _timestamp() {
        return Math.ceil(Date.now() / 1000)
    }

    /**
     * Controls + image updates, no restart (runFullUpdate restarts once over the whole window). Mirrors the launcher's NodeUpdates.runAllUpdates.
     * @param {string|null} commit - optional target stereum commit
     * @returns {Promise<number>} elapsed seconds
     */
    async runAllUpdates(commit = null) {
        const before = this._timestamp()
        await this._runStereumUpdate(commit)
        await this._runServicesUpdate()
        return this._timestamp() - before
    }

    /**
     * Full update cycle, then restart services changed in the window + 10s (launcher's `restart_time_scope = seconds + 10`).
     * @param {string|null} commit - optional target stereum commit
     * @param {{ prune?: boolean }} [opts]
     * @returns {Promise<{ elapsed: number, restarted: { serviceId: string, ok: boolean, error?: string }[] }>}
     */
    async runFullUpdate(commit = null, { prune = true } = {}) {
        const elapsed = await this.runAllUpdates(commit)
        const restarted = await this.restartChangedServices(elapsed + 10, { prune })
        return { elapsed, restarted }
    }

    /** Sub-task group heading for a playbook run; state + short id keeps parallel restarts distinguishable. */
    _playbookLabel(role, stereumArgs = {}, topLevelVars = {}) {
        if (role === 'manage-service') {
            const svc = stereumArgs.manage_service || {}
            const verb = { started: 'Start', stopped: 'Stop', restarted: 'Restart' }[svc.state] || 'Manage'
            const id = svc.configuration?.id
            return id ? `${verb} service · ${id.slice(0, 8)}` : `${verb} service`
        }
        if (role === 'update-package') return `Update package · ${stereumArgs.update_package?.name || ''}`.trim()
        return {
            'update-services': 'Update services',
            'update-stereum': 'Update controls',
            'update-changes': 'Apply config migrations',
            'update-os': 'Update OS',
        }[role] || role
    }

    async runPlaybook(role, stereumArgs = {}, topLevelVars = {}) {
        if (!this.settings) await this.fetchSettings()

        const controlsPath = this.settings?.stereum_settings?.settings?.controls_install_path
        if (!controlsPath) throw new Error('controls_install_path not found in stereum settings')

        const payload = { stereum_role: role, ...topLevelVars }
        if (Object.keys(stereumArgs).length) payload.stereum_args = stereumArgs
        const vars = JSON.stringify(payload)
        const escaped = vars.replace(/'/g, `'"'"'`)
        // stereumjson writes its per-task records to a file under ANSIBLE_LOG_FOLDER, NOT stdout - give each run its own folder.
        const logFolder = `/tmp/stereum-lite-${randomUUID()}`
        const command = `ANSIBLE_LOAD_CALLBACK_PLUGINS=1 ANSIBLE_STDOUT_CALLBACK=stereumjson ANSIBLE_DEPRECATION_WARNINGS=false ANSIBLE_LOG_FOLDER=${logFolder} ansible-playbook --connection=local --inventory 127.0.0.1, --extra-vars '${escaped}' ${controlsPath}/ansible/controls/genericPlaybook.yaml`

        // Inside a task: stream sub-tasks live; each runPlaybook claims its own segment so composite ops accumulate in order.
        const reporter = taskContext.getStore()
        const segment = reporter ? reporter.begin(this._playbookLabel(role, stereumArgs, topLevelVars)) : null
        const stop = reporter ? this._pollPlaybookLog(logFolder, segment, reporter) : null

        let response
        try {
            response = await this.sshService.exec(command, true, { timeoutMs: SSHService.PLAYBOOK_TIMEOUT_MS })
        } finally {
            stop?.()
        }

        // Final log read + cleanup, even on failure so failed steps are captured. Folder is root-owned, so cat + rm share one sudo.
        response.log = await this._readPlaybookLog(logFolder, { cleanup: true })
        if (reporter) reporter.report(segment, parseSubTasks(response.log))

        if (response.rc !== null && response.rc !== 0) {
            const err = new Error(response.stderr || response.stdout || `Playbook '${role}' failed`)
            err.log = response.log
            err.stdout = response.stdout
            err.stderr = response.stderr
            throw err
        }
        return response
    }

    /** Poll a running playbook's log and stream parsed sub-tasks to the segment; returns stop(). */
    _pollPlaybookLog(logFolder, segment, reporter) {
        let active = true
        let timer = null
        const tick = async () => {
            if (!active) return
            const logText = await this._readPlaybookLog(logFolder, { cleanup: false })
            if (active && logText) reporter.report(segment, parseSubTasks(logText))
            if (active) timer = setTimeout(tick, PLAYBOOK_POLL_MS)
        }
        timer = setTimeout(tick, PLAYBOOK_POLL_MS)
        return () => { active = false; if (timer) clearTimeout(timer) }
    }

    /** Read the stereumjson per-host log file(s) from a run's ANSIBLE_LOG_FOLDER; optionally remove the folder. */
    async _readPlaybookLog(logFolder, { cleanup = true } = {}) {
        try {
            const rm = cleanup ? `; rm -rf ${logFolder}` : ''
            const res = await this.sshService.exec(`sh -c 'cat ${logFolder}/* 2>/dev/null${rm}'`, true)
            return res.stdout || ''
        } catch (e) {
            log.warn('runPlaybook: could not read playbook log:', e?.message || e)
            return ''
        }
    }

    disconnect() {
        this.sshService.disconnect()
    }

    async reconnect() {
        return this.sshService.reconnect()
    }

    async fetchServiceConfigs() {
        if (!this.services || this.services.length === 0) {
            await this.fetchServices();
        }
        await Promise.all(this.services.map(async (service) => {
            const response = await this.sshService.exec(`cat /etc/stereum/services/${service.id}.yaml`);
            if (response.rc !== 0) throw new Error(response.stderr || `fetchServiceConfig failed for ${service.id}`);
            service.config = YAML.parse(response.stdout);
        }));
        return this.services;
    }
}