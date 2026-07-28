import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@main/ssh/SSHService', () => {
    class SSHParams {
        constructor(host, port, username, password, privateKey, passphrase) {
            this.name = ''
            this.host = host
            this.port = port
            this.username = username
            this.password = password
            this.privateKey = privateKey
            this.passphrase = passphrase
        }
        getConnectionParams() {
            return { name: this.name, host: this.host, port: this.port, username: this.username, password: this.password, privateKey: this.privateKey, passphrase: this.passphrase }
        }
        setHostName(name) { this.name = name }
    }
    class SSHService {
        constructor(params, onStateChange) {
            this.SSHParams = params
            this.connections = []
            this.onStateChange = onStateChange // expose for test inspection
            this.exec = vi.fn()
            this.execStream = vi.fn(async () => ({ abort: vi.fn() }))
            this.disconnect = vi.fn(() => { this.connections = [] })
            this.connect = vi.fn()
            this.reconnect = vi.fn(async () => true)
        }
    }
    return { SSHService, SSHParams }
})

vi.mock('electron-log', () => ({ default: { debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))

import { Node } from '@main/nodes/Node'
import { taskContext } from '@main/tasks/TaskManager'

const creds = { host: '1.2.3.4', port: 22, username: 'root', password: 'p', privateKey: '/fake/key', passphrase: '' }

function ok(stdout = '', stderr = '') { return { rc: 0, stdout, stderr } }
function fail(stderr = 'boom') { return { rc: 1, stdout: '', stderr } }

describe('Node', () => {
    let node
    beforeEach(() => {
        node = new Node(creds)
    })

    describe('constructor', () => {
        it('generates a UUID id', () => {
            expect(node.id).toMatch(/^[0-9a-f-]{36}$/)
        })
        it('creates distinct ids per instance', () => {
            const a = new Node(creds), b = new Node(creds)
            expect(a.id).not.toBe(b.id)
        })
        it('initializes settings null and services empty', () => {
            expect(node.settings).toBeNull()
            expect(node.services).toEqual([])
        })
        it('initializes status as "disconnected"', () => {
            expect(node.status).toBe('disconnected')
        })
        it('wires SSHService with credentials', () => {
            expect(node.sshService.SSHParams.host).toBe('1.2.3.4')
            expect(node.sshService.SSHParams.privateKey).toBe('/fake/key')
        })
        it('passes an onStateChange callback to SSHService that updates node.status', () => {
            expect(typeof node.sshService.onStateChange).toBe('function')
            node.sshService.onStateChange('connected')
            expect(node.status).toBe('connected')
            node.sshService.onStateChange('reconnecting')
            expect(node.status).toBe('reconnecting')
        })
    })

    describe('onStatusChange', () => {
        it('notifies all registered listeners on status change', () => {
            const a = vi.fn(), b = vi.fn()
            node.onStatusChange(a)
            node.onStatusChange(b)
            node._setStatus('connected')
            expect(a).toHaveBeenCalledWith('connected')
            expect(b).toHaveBeenCalledWith('connected')
        })

        it('deduplicates no-op transitions', () => {
            const cb = vi.fn()
            node.onStatusChange(cb)
            node._setStatus('disconnected') // already 'disconnected'
            expect(cb).not.toHaveBeenCalled()
        })

        it('returns an unsubscribe function', () => {
            const cb = vi.fn()
            const off = node.onStatusChange(cb)
            off()
            node._setStatus('connected')
            expect(cb).not.toHaveBeenCalled()
        })

        it('does not let one listener throwing stop others', () => {
            const bad = vi.fn(() => { throw new Error('x') })
            const good = vi.fn()
            node.onStatusChange(bad)
            node.onStatusChange(good)
            expect(() => node._setStatus('connected')).not.toThrow()
            expect(good).toHaveBeenCalled()
        })
    })

    describe('toListDTO', () => {
        it('returns lightweight DTO with connected=false when no connections', () => {
            node.sshService.SSHParams.name = 'mynode'
            expect(node.toListDTO()).toMatchObject({ id: node.id, name: 'mynode', host: '1.2.3.4', connected: false })
        })
        it('reports connected=true when connections exist', () => {
            node.sshService.connections = [{}]
            expect(node.toListDTO().connected).toBe(true)
        })
        it('includes the current status', () => {
            node._setStatus('reconnecting')
            expect(node.toListDTO().status).toBe('reconnecting')
        })
    })

    describe('fetchSettings', () => {
        it('parses YAML from stereum.yaml', async () => {
            node.sshService.exec.mockResolvedValueOnce(ok('stereum_settings:\n  settings:\n    controls_install_path: /opt/stereum\n'))
            const s = await node.fetchSettings()
            expect(s.stereum_settings.settings.controls_install_path).toBe('/opt/stereum')
            expect(node.sshService.exec).toHaveBeenCalledWith('cat /etc/stereum/stereum.yaml')
        })
        it('caches result; does not re-exec on subsequent calls', async () => {
            node.sshService.exec.mockResolvedValueOnce(ok('a: 1'))
            await node.fetchSettings()
            await node.fetchSettings()
            expect(node.sshService.exec).toHaveBeenCalledTimes(1)
        })
        it('refreshes when refresh=true', async () => {
            node.sshService.exec.mockResolvedValue(ok('a: 1'))
            await node.fetchSettings()
            await node.fetchSettings(true)
            expect(node.sshService.exec).toHaveBeenCalledTimes(2)
        })
        it('throws on non-zero rc with stderr', async () => {
            node.sshService.exec.mockResolvedValueOnce(fail('no perms'))
            await expect(node.fetchSettings()).rejects.toThrow('no perms')
        })
    })

    describe('fetchServices', () => {
        it('parses service IDs, stripping .yaml + whitespace + blanks', async () => {
            node.sshService.exec.mockResolvedValueOnce(ok('aaa.yaml\nbbb.yaml\n\n  ccc.yaml  \n'))
            const services = await node.fetchServices()
            expect(services).toEqual([{ id: 'aaa' }, { id: 'bbb' }, { id: 'ccc' }])
        })
        it('caches; refresh=true re-execs', async () => {
            node.sshService.exec.mockResolvedValue(ok('aaa.yaml'))
            await node.fetchServices()
            await node.fetchServices()
            expect(node.sshService.exec).toHaveBeenCalledTimes(1)
            await node.fetchServices(true)
            expect(node.sshService.exec).toHaveBeenCalledTimes(2)
        })
        it('throws on rc != 0', async () => {
            node.sshService.exec.mockResolvedValueOnce(fail('denied'))
            await expect(node.fetchServices()).rejects.toThrow('denied')
        })
    })

    describe('fetchContainerStatuses', () => {
        it('maps stereum-<uuid> container names to status objects', async () => {
            const uuid = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa'
            const line = JSON.stringify({ Names: `stereum-${uuid}`, State: 'running', Status: 'Up 5m', Image: 'geth:1.17' })
            node.sshService.exec.mockResolvedValueOnce(ok(line))
            const statuses = await node.fetchContainerStatuses()
            expect(statuses[uuid]).toEqual({ state: 'running', status: 'Up 5m', image: 'geth:1.17' })
        })
        it('ignores containers without stereum-UUID name', async () => {
            const line = JSON.stringify({ Names: 'random-container', State: 'running', Status: 'Up', Image: 'x' })
            node.sshService.exec.mockResolvedValueOnce(ok(line))
            const statuses = await node.fetchContainerStatuses()
            expect(statuses).toEqual({})
        })
        it('skips malformed JSON lines without throwing', async () => {
            const good = JSON.stringify({ Names: 'stereum-aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa', State: 's', Status: 'st', Image: 'i' })
            node.sshService.exec.mockResolvedValueOnce(ok('not json\n' + good + '\n}{broken{'))
            const statuses = await node.fetchContainerStatuses()
            expect(Object.keys(statuses)).toHaveLength(1)
        })
        it('throws on rc != 0', async () => {
            node.sshService.exec.mockResolvedValueOnce(fail('docker dead'))
            await expect(node.fetchContainerStatuses()).rejects.toThrow('docker dead')
        })
    })

    describe('fetchRawServiceConfig', () => {
        it('returns raw stdout for the YAML file', async () => {
            node.sshService.exec.mockResolvedValueOnce(ok('id: abc'))
            const raw = await node.fetchRawServiceConfig('abc')
            expect(raw).toBe('id: abc')
            expect(node.sshService.exec).toHaveBeenCalledWith('cat /etc/stereum/services/abc.yaml')
        })
        it('throws on failure', async () => {
            node.sshService.exec.mockResolvedValueOnce(fail('nope'))
            await expect(node.fetchRawServiceConfig('abc')).rejects.toThrow('nope')
        })
    })

    describe('writeServiceConfig', () => {
        it('base64-encodes content and pipes to sudo tee', async () => {
            node.sshService.exec.mockResolvedValueOnce(ok())
            await node.writeServiceConfig('abc', 'hello: world')
            const cmd = node.sshService.exec.mock.calls[0][0]
            const expectedB64 = Buffer.from('hello: world').toString('base64')
            expect(cmd).toContain(expectedB64)
            expect(cmd).toContain('/etc/stereum/services/abc.yaml')
            expect(cmd).toContain('sudo tee')
            // useSudo=false so caller controls sudo
            expect(node.sshService.exec.mock.calls[0][1]).toBe(false)
        })
        it('throws on rc != 0', async () => {
            node.sshService.exec.mockResolvedValueOnce(fail('readonly fs'))
            await expect(node.writeServiceConfig('abc', 'x')).rejects.toThrow('readonly fs')
        })
    })

    describe('fetchServiceConfigs', () => {
        it('populates config on each service in parallel', async () => {
            node.services = [{ id: 'a' }, { id: 'b' }]
            node.sshService.exec.mockImplementation((cmd) => {
                if (cmd.includes('a.yaml')) return Promise.resolve(ok('id: a'))
                if (cmd.includes('b.yaml')) return Promise.resolve(ok('id: b'))
                return Promise.resolve(fail())
            })
            await node.fetchServiceConfigs()
            expect(node.services[0].config).toEqual({ id: 'a' })
            expect(node.services[1].config).toEqual({ id: 'b' })
        })
        it('fetches services first when empty', async () => {
            node.sshService.exec
                .mockResolvedValueOnce(ok('a.yaml')) // fetchServices
                .mockResolvedValueOnce(ok('id: a')) // config for a
            await node.fetchServiceConfigs()
            expect(node.services).toEqual([{ id: 'a', config: { id: 'a' } }])
        })
        it('rejects if any config fetch fails', async () => {
            node.services = [{ id: 'a' }]
            node.sshService.exec.mockResolvedValueOnce(fail('gone'))
            await expect(node.fetchServiceConfigs()).rejects.toThrow('gone')
        })
    })

    describe('fetchSetups', () => {
        beforeEach(() => {
            node.settings = { stereum_settings: { settings: { controls_install_path: '/opt/stereum' } } }
        })
        it('parses multisetup.yaml into an array of setups', async () => {
            const yaml = [
                'setup-eth:',
                '  name: ethSetup1',
                '  network: hoodi',
                '  color: default',
                '  type: ETH',
                '  services:',
                '    - svc-a',
                '    - svc-b',
                'setup-common:',
                '  name: commonServices',
                '  network: default',
                '  type: common',
                '  services:',
                '    - svc-c',
            ].join('\n')
            node.sshService.exec.mockResolvedValueOnce(ok(yaml))
            const setups = await node.fetchSetups()
            expect(node.sshService.exec.mock.calls[0][0]).toContain('/etc/stereum/multisetup.yaml')
            expect(setups).toHaveLength(2)
            expect(setups[0]).toMatchObject({ id: 'setup-eth', name: 'ethSetup1', network: 'hoodi', type: 'ETH', services: ['svc-a', 'svc-b'] })
            expect(setups[1]).toMatchObject({ id: 'setup-common', type: 'common', services: ['svc-c'] })
        })
        it('returns [] when multisetup.yaml is absent (cat rc 1)', async () => {
            node.sshService.exec.mockResolvedValueOnce(fail('No such file'))
            expect(await node.fetchSetups()).toEqual([])
        })
        it('returns [] on empty output', async () => {
            node.sshService.exec.mockResolvedValueOnce(ok('   '))
            expect(await node.fetchSetups()).toEqual([])
        })
        it('caches; refresh=true re-reads', async () => {
            node.sshService.exec.mockResolvedValue(ok('x:\n  name: s\n  services: []'))
            await node.fetchSetups()
            await node.fetchSetups()
            expect(node.sshService.exec).toHaveBeenCalledTimes(1)
            await node.fetchSetups(true)
            expect(node.sshService.exec).toHaveBeenCalledTimes(2)
        })
    })

    describe('toDTO', () => {
        it('returns full DTO including container state merged into services', async () => {
            node.sshService.SSHParams.name = 'host1'
            const svcId = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa'
            node.sshService.exec.mockImplementation((cmd) => {
                if (cmd.includes('stereum.yaml')) return Promise.resolve(ok('stereum_settings:\n  settings:\n    controls_install_path: /opt/stereum'))
                if (cmd.startsWith('ls /etc/stereum/services')) return Promise.resolve(ok(`${svcId}.yaml`))
                if (cmd.includes(`${svcId}.yaml`)) return Promise.resolve(ok(`id: ${svcId}\nservice: GethService`))
                if (cmd.startsWith('docker ps')) {
                    return Promise.resolve(ok(JSON.stringify({ Names: `stereum-${svcId}`, State: 'running', Status: 'Up', Image: 'geth' })))
                }
                return Promise.resolve(fail('unexpected: ' + cmd))
            })
            const dto = await node.toDTO()
            expect(dto.id).toBe(node.id)
            expect(dto.name).toBe('host1')
            expect(dto.settings.stereum_settings.settings.controls_install_path).toBe('/opt/stereum')
            expect(dto.services).toHaveLength(1)
            expect(dto.services[0].container).toEqual({ state: 'running', status: 'Up', image: 'geth' })
        })
        it('sets container=null for services with no matching docker entry', async () => {
            node.sshService.exec.mockImplementation((cmd) => {
                if (cmd.includes('stereum.yaml')) return Promise.resolve(ok('a: 1'))
                if (cmd.startsWith('ls')) return Promise.resolve(ok('xxxx.yaml'))
                if (cmd.includes('xxxx.yaml')) return Promise.resolve(ok('id: xxxx'))
                if (cmd.startsWith('docker')) return Promise.resolve(ok(''))
                return Promise.resolve(fail())
            })
            const dto = await node.toDTO()
            expect(dto.services[0].container).toBeNull()
        })
        it('annotates each service with its setup and includes setups[]', async () => {
            const svcId = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa'
            node.sshService.exec.mockImplementation((cmd) => {
                if (cmd.includes('multisetup.yaml')) return Promise.resolve(ok(`s1:\n  name: ethSetup1\n  network: hoodi\n  type: ETH\n  services:\n    - ${svcId}`))
                if (cmd.includes('stereum.yaml')) return Promise.resolve(ok('stereum_settings:\n  settings:\n    controls_install_path: /opt/stereum'))
                if (cmd.startsWith('ls /etc/stereum/services')) return Promise.resolve(ok(`${svcId}.yaml`))
                if (cmd.includes(`${svcId}.yaml`)) return Promise.resolve(ok(`id: ${svcId}\nservice: GethService`))
                if (cmd.startsWith('docker ps')) return Promise.resolve(ok(''))
                return Promise.resolve(fail('unexpected: ' + cmd))
            })
            const dto = await node.toDTO()
            expect(dto.setups).toHaveLength(1)
            expect(dto.services[0].setup).toMatchObject({ id: 's1', name: 'ethSetup1', network: 'hoodi', type: 'ETH' })
        })
    })

    describe('start/stop/restart Service', () => {
        beforeEach(() => {
            node.settings = { stereum_settings: { settings: { controls_install_path: '/opt/stereum' } } }
            node.sshService.exec.mockResolvedValue(ok('ok'))
        })
        it('startService passes state=started', async () => {
            await node.startService('svc-1')
            const cmd = node.sshService.exec.mock.calls[0][0]
            expect(cmd).toContain('"state":"started"')
            expect(cmd).toContain('"id":"svc-1"')
            expect(cmd).toContain('stereum_role')
            expect(cmd).toContain('manage-service')
        })
        it('stopService passes state=stopped', async () => {
            await node.stopService('svc-1')
            expect(node.sshService.exec.mock.calls[0][0]).toContain('"state":"stopped"')
        })
        it('restartService passes state=restarted', async () => {
            await node.restartService('svc-1')
            expect(node.sshService.exec.mock.calls[0][0]).toContain('"state":"restarted"')
        })
    })

    describe('runPlaybook', () => {
        it('throws when controls_install_path missing', async () => {
            node.settings = { stereum_settings: { settings: {} } }
            await expect(node.runPlaybook('manage-service')).rejects.toThrow(/controls_install_path/)
        })
        it('fetches settings if not loaded', async () => {
            node.sshService.exec
                .mockResolvedValueOnce(ok('stereum_settings:\n  settings:\n    controls_install_path: /opt/stereum'))
                .mockResolvedValueOnce(ok('done')) // playbook
                .mockResolvedValueOnce(ok('')) // structured-log read
            await node.runPlaybook('update-services')
            // fetchSettings + playbook + log read
            expect(node.sshService.exec).toHaveBeenCalledTimes(3)
        })
        it('builds an ansible-playbook command with extra-vars and the controls path', async () => {
            node.settings = { stereum_settings: { settings: { controls_install_path: '/opt/stereum' } } }
            node.sshService.exec.mockResolvedValueOnce(ok('done'))
            await node.runPlaybook('update-services', { foo: 'bar' })
            const cmd = node.sshService.exec.mock.calls[0][0]
            expect(cmd).toContain('ansible-playbook')
            expect(cmd).toContain('/opt/stereum/ansible/controls/genericPlaybook.yaml')
            expect(cmd).toContain('--extra-vars')
            expect(cmd).toContain('"stereum_role":"update-services"')
            expect(cmd).toContain('"foo":"bar"')
        })
        it('escapes single quotes in extra-vars', async () => {
            node.settings = { stereum_settings: { settings: { controls_install_path: '/opt/stereum' } } }
            node.sshService.exec.mockResolvedValueOnce(ok('done'))
            await node.runPlaybook('manage-service', { x: "it's broken" })
            const cmd = node.sshService.exec.mock.calls[0][0]
            // Single quotes inside the JSON must be escaped using the '"'"' trick
            expect(cmd).toContain(`'"'"'`)
        })
        it('uses sudo (useSudo=true) for the exec call', async () => {
            node.settings = { stereum_settings: { settings: { controls_install_path: '/opt/stereum' } } }
            node.sshService.exec.mockResolvedValueOnce(ok('done'))
            await node.runPlaybook('manage-service')
            expect(node.sshService.exec.mock.calls[0][1]).toBe(true)
        })
        it('treats rc=null as success (e.g. signal termination ignored)', async () => {
            node.settings = { stereum_settings: { settings: { controls_install_path: '/opt/stereum' } } }
            node.sshService.exec.mockResolvedValueOnce({ rc: null, stdout: 'fine', stderr: '' })
            await expect(node.runPlaybook('manage-service')).resolves.toBeDefined()
        })
        it('throws on rc != 0', async () => {
            node.settings = { stereum_settings: { settings: { controls_install_path: '/opt/stereum' } } }
            node.sshService.exec.mockResolvedValueOnce({ rc: 2, stdout: '', stderr: 'fail' })
            await expect(node.runPlaybook('manage-service')).rejects.toThrow('fail')
        })
        it('sets a per-run ANSIBLE_LOG_FOLDER and reads the structured log into response.log', async () => {
            node.settings = { stereum_settings: { settings: { controls_install_path: '/opt/stereum' } } }
            node.sshService.exec
                .mockResolvedValueOnce(ok('PLAY RECAP (no structured blocks on stdout)')) // playbook
                .mockResolvedValueOnce(ok('TASK: Start\nACTION: docker_container\nCATEGORY: OK')) // log read
            const res = await node.runPlaybook('manage-service')

            const cmd = node.sshService.exec.mock.calls[0][0]
            const folder = cmd.match(/ANSIBLE_LOG_FOLDER=(\S+)/)[1]
            expect(folder).toMatch(/^\/tmp\/stereum-lite-/)
            // log read + cleanup run in one sudo sh -c
            const readCmd = node.sshService.exec.mock.calls[1][0]
            expect(readCmd).toContain(`cat ${folder}/*`)
            expect(readCmd).toContain(`rm -rf ${folder}`)
            expect(res.log).toContain('CATEGORY: OK')
        })
        it('attaches the structured log to the error on failure', async () => {
            node.settings = { stereum_settings: { settings: { controls_install_path: '/opt/stereum' } } }
            node.sshService.exec
                .mockResolvedValueOnce({ rc: 2, stdout: '', stderr: 'boom' }) // playbook
                .mockResolvedValueOnce(ok('TASK: Bad\nACTION: x\nCATEGORY: FAILED')) // log read
            let caught
            try { await node.runPlaybook('manage-service') } catch (e) { caught = e }
            expect(caught.message).toBe('boom')
            expect(caught.log).toContain('CATEGORY: FAILED')
        })
        it('swallows a failed log read (response.log = "")', async () => {
            node.settings = { stereum_settings: { settings: { controls_install_path: '/opt/stereum' } } }
            node.sshService.exec
                .mockResolvedValueOnce(ok('done')) // playbook
                .mockRejectedValueOnce(new Error('cat failed')) // log read throws
            const res = await node.runPlaybook('manage-service')
            expect(res.log).toBe('')
        })
        it('reports parsed sub-tasks to the task-context reporter on completion', async () => {
            node.settings = { stereum_settings: { settings: { controls_install_path: '/opt/stereum' } } }
            node.sshService.exec
                .mockResolvedValueOnce(ok('PLAY RECAP')) // playbook
                .mockResolvedValueOnce(ok('TASK: Final\nACTION: a\nCATEGORY: OK')) // final log read
            const reports = []
            const reporter = { begin: () => 0, report: (seg, subs) => reports.push(subs) }
            await taskContext.run(reporter, () => node.runPlaybook('manage-service'))
            expect(reports.at(-1)).toEqual([expect.objectContaining({ name: 'Final', status: 'OK' })])
        })
        it('claims a reporter segment only when inside a task context', async () => {
            node.settings = { stereum_settings: { settings: { controls_install_path: '/opt/stereum' } } }
            node.sshService.exec.mockResolvedValue(ok('done'))
            // No context: must not throw and must not poll (just playbook + final read).
            await node.runPlaybook('manage-service')
            expect(node.sshService.exec).toHaveBeenCalledTimes(2)
        })
    })

    describe('disconnect', () => {
        it('delegates to sshService.disconnect', () => {
            node.disconnect()
            expect(node.sshService.disconnect).toHaveBeenCalledTimes(1)
        })
    })

    describe('reconnect', () => {
        it('delegates to sshService.reconnect and returns its result', async () => {
            node.sshService.reconnect.mockResolvedValueOnce(true)
            const r = await node.reconnect()
            expect(r).toBe(true)
            expect(node.sshService.reconnect).toHaveBeenCalledTimes(1)
        })
    })

    describe('fetchControlsCommit', () => {
        beforeEach(() => {
            node.settings = { stereum_settings: { settings: { controls_install_path: '/opt/stereum' } } }
        })
        it('runs git rev-parse HEAD against <controls>/ansible and returns the trimmed commit', async () => {
            node.sshService.exec.mockResolvedValueOnce(ok('  deadbeef0123456789abcdef0123456789abcdef\n'))
            const c = await node.fetchControlsCommit()
            expect(c).toBe('deadbeef0123456789abcdef0123456789abcdef')
            const cmd = node.sshService.exec.mock.calls[0][0]
            expect(cmd).toContain('/opt/stereum/ansible')
            expect(cmd).toContain('rev-parse HEAD')
            // Fallback to bare controls path is part of the same command
            expect(cmd).toContain('/opt/stereum')
        })
        it('lazy-loads settings when not yet fetched', async () => {
            node.settings = null
            node.sshService.exec
                .mockResolvedValueOnce(ok('stereum_settings:\n  settings:\n    controls_install_path: /opt/stereum'))
                .mockResolvedValueOnce(ok('abc123'))
            const c = await node.fetchControlsCommit()
            expect(c).toBe('abc123')
            expect(node.sshService.exec).toHaveBeenCalledTimes(2)
        })
        it('throws when controls_install_path is missing', async () => {
            node.settings = { stereum_settings: { settings: {} } }
            await expect(node.fetchControlsCommit()).rejects.toThrow(/controls_install_path/)
        })
        it('throws when the repo cannot be read (empty stdout)', async () => {
            node.sshService.exec.mockResolvedValueOnce(ok(''))
            await expect(node.fetchControlsCommit()).rejects.toThrow(/not a git checkout/)
        })
        it('throws on non-zero rc with stderr', async () => {
            node.sshService.exec.mockResolvedValueOnce(fail('not a repo'))
            await expect(node.fetchControlsCommit()).rejects.toThrow('not a repo')
        })
        it('treats rc=null with non-empty stdout as success (signal-terminated child still produced output)', async () => {
            node.sshService.exec.mockResolvedValueOnce({ rc: null, stdout: 'abc\n', stderr: '' })
            await expect(node.fetchControlsCommit()).resolves.toBe('abc')
        })
    })

    describe('fetchUpgradablePackages', () => {
        it('parses apt list --upgradable output into structured objects', async () => {
            const stdout = [
                'curl/jammy-updates 7.81.0-1ubuntu1.20 amd64 [upgradable from: 7.81.0-1ubuntu1.10]',
                'libssl3/jammy-security 3.0.2-0ubuntu1.18 amd64 [upgradable from: 3.0.2-0ubuntu1.15]',
            ].join('\n')
            node.sshService.exec.mockResolvedValueOnce(ok(stdout))
            const pkgs = await node.fetchUpgradablePackages()
            expect(pkgs).toEqual([
                { name: 'curl', newVersion: '7.81.0-1ubuntu1.20', currentVersion: '7.81.0-1ubuntu1.10' },
                { name: 'libssl3', newVersion: '3.0.2-0ubuntu1.18', currentVersion: '3.0.2-0ubuntu1.15' },
            ])
        })
        it('returns an empty array when nothing is upgradable', async () => {
            node.sshService.exec.mockResolvedValueOnce(ok(''))
            await expect(node.fetchUpgradablePackages()).resolves.toEqual([])
        })
        it('ignores lines that do not match the apt format (e.g. "Listing..." headers)', async () => {
            const stdout = [
                'Listing...',
                'random noise',
                'curl/jammy 1.0 amd64 [upgradable from: 0.9]',
            ].join('\n')
            node.sshService.exec.mockResolvedValueOnce(ok(stdout))
            const pkgs = await node.fetchUpgradablePackages()
            expect(pkgs).toEqual([{ name: 'curl', newVersion: '1.0', currentVersion: '0.9' }])
        })
        it('uses the apt list command via SSH (tail trims the Listing… header)', async () => {
            node.sshService.exec.mockResolvedValueOnce(ok(''))
            await node.fetchUpgradablePackages()
            const cmd = node.sshService.exec.mock.calls[0][0]
            expect(cmd).toContain('apt list --upgradable')
        })
        it('treats rc=null as success (apt sometimes signals exit on shutdown)', async () => {
            node.sshService.exec.mockResolvedValueOnce({ rc: null, stdout: '', stderr: '' })
            await expect(node.fetchUpgradablePackages()).resolves.toEqual([])
        })
        it('throws on non-zero rc with stderr', async () => {
            node.sshService.exec.mockResolvedValueOnce(fail('apt locked'))
            await expect(node.fetchUpgradablePackages()).rejects.toThrow('apt locked')
        })
    })

    describe('fetchOsInfo', () => {
        it('returns the trimmed PRETTY_NAME and reads /etc/os-release without sudo', async () => {
            node.sshService.exec.mockResolvedValueOnce(ok('Ubuntu 22.04.3 LTS\n'))
            const os = await node.fetchOsInfo()
            expect(os).toBe('Ubuntu 22.04.3 LTS')
            const [cmd, useSudo] = node.sshService.exec.mock.calls[0]
            expect(cmd).toContain('/etc/os-release')
            // sudo can't run the `.` builtin - must be called with useSudo=false.
            expect(useSudo).toBe(false)
        })
        it('throws when os-release yields nothing', async () => {
            node.sshService.exec.mockResolvedValueOnce(ok('   \n'))
            await expect(node.fetchOsInfo()).rejects.toThrow(/OS info not found/)
        })
        it('throws on non-zero rc with stderr', async () => {
            node.sshService.exec.mockResolvedValueOnce(fail('nope'))
            await expect(node.fetchOsInfo()).rejects.toThrow('nope')
        })
    })

    describe('fetchSystemMetrics', () => {
        it('runs the metrics command WITHOUT a sh -c wrapper and without sudo', async () => {
            node.sshService.exec.mockResolvedValueOnce(ok('#cores\n4\n'))
            await node.fetchSystemMetrics()
            const [cmd, useSudo] = node.sshService.exec.mock.calls[0]
            // sh -c wrapping breaks - the command contains literal single quotes.
            expect(cmd.startsWith('sh -c')).toBe(false)
            expect(cmd).toContain('/proc/stat')
            expect(cmd).toContain('/proc/meminfo')
            expect(useSudo).toBe(false)
        })
        it('parses into a metrics DTO', async () => {
            node.sshService.exec.mockResolvedValueOnce(ok('#cores\n8\n#load\n1.5 1 1\n'))
            const m = await node.fetchSystemMetrics()
            expect(m.cpu.cores).toBe(8)
            expect(m.cpu.load1).toBe(1.5)
        })
        it('throws on non-zero rc', async () => {
            node.sshService.exec.mockResolvedValueOnce(fail('no /proc'))
            await expect(node.fetchSystemMetrics()).rejects.toThrow('no /proc')
        })
    })

    describe('fetchClientMetrics', () => {
        const gethId = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa'
        beforeEach(() => {
            node.services = [{ id: gethId, config: { service: 'GethService' } }]
        })
        it('probes running clients via a docker curl sidecar on the stereum network (with sudo)', async () => {
            node.sshService.exec
                .mockResolvedValueOnce(ok(`{"Names":"stereum-${gethId}","State":"running","Status":"Up","Image":"geth"}`)) // fetchContainerStatuses
                .mockResolvedValueOnce(ok(`===${gethId}===\n{"id":1,"result":false}\n\n{"id":2,"result":"0x2a"}\n`)) // docker run probe
            const r = await node.fetchClientMetrics()
            const [cmd, useSudo] = node.sshService.exec.mock.calls[1]
            expect(cmd).toContain('docker run --rm --network stereum')
            expect(cmd).toContain('curlimages/curl')
            expect(useSudo).toBe(true)
            expect(r[gethId]).toMatchObject({ role: 'execution', syncing: false, peers: 42 })
        })
        it('returns {} without a docker run when no client is running', async () => {
            node.sshService.exec.mockResolvedValueOnce(ok(`{"Names":"stereum-${gethId}","State":"exited","Status":"Exited","Image":"geth"}`))
            const r = await node.fetchClientMetrics()
            expect(r).toEqual({})
            expect(node.sshService.exec).toHaveBeenCalledTimes(1) // only the container-status read
        })

        it('queries Prometheus for beacon sync when a running PrometheusService is present', async () => {
            const lhId = 'cccccccc-0000-0000-0000-cccccccccccc'
            const promId = 'dddddddd-0000-0000-0000-dddddddddddd'
            node.services = [
                { id: lhId, config: { service: 'LighthouseBeaconService' } },
                { id: promId, config: { service: 'PrometheusService' } },
            ]
            node.sshService.exec
                .mockResolvedValueOnce(ok(`{"Names":"stereum-${lhId}","State":"running","Status":"Up","Image":"lh"}\n{"Names":"stereum-${promId}","State":"running","Status":"Up","Image":"prom"}`))
                .mockResolvedValueOnce(ok(''))
            await node.fetchClientMetrics()
            const cmd = node.sshService.exec.mock.calls[1][0]
            expect(cmd).toContain(`http://stereum-${promId}:9090/api/v1/query`)
        })
    })

    describe('fetchDiskBreakdown', () => {
        const gethId = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa'
        beforeEach(() => {
            node.settings = { stereum_settings: { settings: { controls_install_path: '/opt/stereum' } } }
            node.services = [{ id: gethId, config: { service: 'GethService', volumes: [`/opt/stereum/geth-${gethId}/data:/d`] } }]
        })
        it('runs du + df over the controls path with a long idle timeout (sudo)', async () => {
            node.sshService.exec.mockResolvedValueOnce(ok(`600\t/opt/stereum/geth-${gethId}/data\n#df\n/opt/stereum 1000 800`))
            const r = await node.fetchDiskBreakdown()
            const [cmd, useSudo, opts] = node.sshService.exec.mock.calls[0]
            expect(cmd).toContain('du -sb')
            expect(cmd).toContain("df -B1 --output=target,size,used '/opt/stereum'")
            expect(useSudo).toBe(true)
            expect(opts.timeoutMs).toBeGreaterThanOrEqual(60_000)
            expect(r.services[0]).toMatchObject({ id: gethId, bytes: 600 })
            expect(r.totalBytes).toBe(1000)
        })
        it('falls back to / when no controls path is set', async () => {
            node.settings = { stereum_settings: { settings: {} } }
            node.sshService.exec.mockResolvedValueOnce(ok('#df\n/ 1000 400'))
            await node.fetchDiskBreakdown()
            expect(node.sshService.exec.mock.calls[0][0]).toContain("df -B1 --output=target,size,used '/'")
        })
    })

    describe('streamServiceLogs', () => {
        it('runs docker logs -f against the stereum-<uuid> container and forwards callbacks', async () => {
            const onLine = vi.fn(), onClose = vi.fn()
            const handle = { abort: vi.fn() }
            node.sshService.execStream.mockResolvedValueOnce(handle)
            const r = await node.streamServiceLogs('svc-1', { tail: 50, onLine, onClose })
            expect(r).toBe(handle)
            const [cmd, opts] = node.sshService.execStream.mock.calls[0]
            expect(cmd).toBe('docker logs -f --tail 50 stereum-svc-1')
            expect(opts.onLine).toBe(onLine)
            expect(opts.onClose).toBe(onClose)
        })

        it('defaults tail to 200', async () => {
            await node.streamServiceLogs('svc-1', { onLine: () => {} })
            expect(node.sshService.execStream.mock.calls[0][0]).toContain('--tail 200')
        })

        it('coerces invalid tail values to the default', async () => {
            await node.streamServiceLogs('svc-1', { tail: -5, onLine: () => {} })
            expect(node.sshService.execStream.mock.calls[0][0]).toContain('--tail 200')

            await node.streamServiceLogs('svc-1', { tail: 'lots', onLine: () => {} })
            expect(node.sshService.execStream.mock.calls[1][0]).toContain('--tail 200')

            await node.streamServiceLogs('svc-1', { tail: 1.7, onLine: () => {} })
            expect(node.sshService.execStream.mock.calls[2][0]).toContain('--tail 1 ')
        })
    })

    describe('update playbook wrappers', () => {
        beforeEach(() => {
            node.settings = { stereum_settings: { settings: { controls_install_path: '/opt/stereum' } } }
            node.sshService.exec.mockResolvedValue(ok('done'))
        })

        it('updateOS runs update-os with no extra vars', async () => {
            await node.updateOS()
            const cmd = node.sshService.exec.mock.calls[0][0]
            expect(cmd).toContain('"stereum_role":"update-os"')
            expect(cmd).not.toContain('"stereum":')
        })

        it('updateStereum runs update-stereum with no extra vars', async () => {
            await node.updateStereum()
            const cmd = node.sshService.exec.mock.calls[0][0]
            expect(cmd).toContain('"stereum_role":"update-stereum"')
            expect(cmd).not.toContain('"stereum":')
        })

        it('updatePackage passes stereum.update_package.name', async () => {
            await node.updatePackage('curl')
            const cmd = node.sshService.exec.mock.calls[0][0]
            expect(cmd).toContain('"stereum_role":"update-package"')
            expect(cmd).toContain('"update_package":{"name":"curl"}')
        })

        it('updateServices with no ids omits services_to_update entirely', async () => {
            await node._runServicesUpdate()
            const cmd = node.sshService.exec.mock.calls[0][0]
            expect(cmd).toContain('"stereum_role":"update-services"')
            expect(cmd).not.toContain('services_to_update')
        })

        it('updateServices with empty array also omits services_to_update', async () => {
            await node._runServicesUpdate([])
            const cmd = node.sshService.exec.mock.calls[0][0]
            expect(cmd).not.toContain('services_to_update')
        })

        it('updateServices with a single id forwards it as a top-level string', async () => {
            await node._runServicesUpdate(['svc-a'])
            const cmd = node.sshService.exec.mock.calls[0][0]
            expect(cmd).toContain('"services_to_update":"svc-a"')
            expect(cmd).not.toContain('stereum_args')
        })

        it('updateServices with multiple ids forwards them as a top-level array', async () => {
            await node._runServicesUpdate(['svc-a', 'svc-b'])
            const cmd = node.sshService.exec.mock.calls[0][0]
            expect(cmd).toContain('"services_to_update":["svc-a","svc-b"]')
            expect(cmd).not.toContain('stereum_args')
        })

        it('updateServices restarts services changed during its window plus a 10s buffer', async () => {
            vi.spyOn(node, '_timestamp').mockReturnValueOnce(3000).mockReturnValueOnce(3015)
            const coreSpy = vi.spyOn(node, '_runServicesUpdate').mockResolvedValue()
            const restartSpy = vi.spyOn(node, 'restartChangedServices').mockResolvedValue([{ serviceId: 'svc-a', ok: true }])
            const restarted = await node.updateServices(['svc-a'])
            expect(coreSpy).toHaveBeenCalledWith(['svc-a'])
            expect(restartSpy).toHaveBeenCalledWith(25, { prune: true })
            expect(restarted).toEqual([{ serviceId: 'svc-a', ok: true }])
        })

        it('updateStereum runs both update-stereum and update-changes', async () => {
            vi.spyOn(node, 'restartChangedServices').mockResolvedValue([])
            await node.updateStereum()
            const cmds = node.sshService.exec.mock.calls.map(c => c[0])
            expect(cmds.some(c => c.includes('"stereum_role":"update-stereum"'))).toBe(true)
            expect(cmds.some(c => c.includes('"stereum_role":"update-changes"'))).toBe(true)
        })

        it('updateStereum with a commit pins override_gitcommit', async () => {
            vi.spyOn(node, 'restartChangedServices').mockResolvedValue([])
            await node.updateStereum('abc123')
            const cmd = node.sshService.exec.mock.calls[0][0]
            expect(cmd).toContain('"stereum_role":"update-stereum"')
            expect(cmd).toContain('"override_gitcommit":"abc123"')
        })

        it('updateStereum without a commit omits override_gitcommit', async () => {
            vi.spyOn(node, 'restartChangedServices').mockResolvedValue([])
            await node.updateStereum()
            const cmd = node.sshService.exec.mock.calls[0][0]
            expect(cmd).not.toContain('override_gitcommit')
        })

        it('updateStereum restarts services changed during its window plus a 10s buffer', async () => {
            vi.spyOn(node, '_timestamp').mockReturnValueOnce(2000).mockReturnValueOnce(2020)
            vi.spyOn(node, '_runStereumUpdate').mockResolvedValue()
            const restartSpy = vi.spyOn(node, 'restartChangedServices').mockResolvedValue([{ serviceId: 'svc', ok: true }])
            const restarted = await node.updateStereum('c1')
            expect(node._runStereumUpdate).toHaveBeenCalledWith('c1')
            expect(restartSpy).toHaveBeenCalledWith(30, { prune: true })
            expect(restarted).toEqual([{ serviceId: 'svc', ok: true }])
        })

        it('runAllUpdates updates stereum then services and returns elapsed seconds', async () => {
            vi.spyOn(node, '_timestamp').mockReturnValueOnce(1000).mockReturnValueOnce(1042)
            const stereumSpy = vi.spyOn(node, '_runStereumUpdate')
            const servicesSpy = vi.spyOn(node, '_runServicesUpdate')
            const elapsed = await node.runAllUpdates('c1')
            expect(stereumSpy).toHaveBeenCalledWith('c1')
            expect(servicesSpy).toHaveBeenCalled()
            expect(elapsed).toBe(42)
        })

        it('runAllUpdates does not restart mid-sequence (single restart left to runFullUpdate)', async () => {
            vi.spyOn(node, '_runStereumUpdate').mockResolvedValue()
            vi.spyOn(node, '_runServicesUpdate').mockResolvedValue()
            const restartSpy = vi.spyOn(node, 'restartChangedServices')
            await node.runAllUpdates()
            expect(restartSpy).not.toHaveBeenCalled()
        })

        it('runFullUpdate restarts services changed during the window plus a 10s buffer', async () => {
            vi.spyOn(node, '_timestamp').mockReturnValueOnce(1000).mockReturnValueOnce(1030)
            vi.spyOn(node, '_runStereumUpdate').mockResolvedValue()
            vi.spyOn(node, '_runServicesUpdate').mockResolvedValue()
            const restartSpy = vi.spyOn(node, 'restartChangedServices').mockResolvedValue([{ serviceId: 'x', ok: true }])
            const result = await node.runFullUpdate('c1')
            expect(restartSpy).toHaveBeenCalledWith(40, { prune: true })
            expect(result).toEqual({ elapsed: 30, restarted: [{ serviceId: 'x', ok: true }] })
        })
    })

    describe('restartChangedServices', () => {
        beforeEach(() => {
            node.settings = { stereum_settings: { settings: { controls_install_path: '/opt/stereum' } } }
        })

        it('findChangedServiceIds scopes the find to the timeframe and parses filenames to ids', async () => {
            node.sshService.exec.mockResolvedValue(ok('aaa.yaml\nbbb.yaml\n'))
            const ids = await node.findChangedServiceIds(30)
            const cmd = node.sshService.exec.mock.calls[0][0]
            expect(cmd).toContain('find /etc/stereum/services')
            expect(cmd).toContain('-newermt "30 seconds ago"')
            expect(ids).toEqual(['aaa', 'bbb'])
        })

        it('rejects a non-positive or non-numeric timeframe', async () => {
            await expect(node.findChangedServiceIds(0)).rejects.toThrow(/positive/)
            await expect(node.findChangedServiceIds(-5)).rejects.toThrow(/positive/)
            await expect(node.findChangedServiceIds('abc')).rejects.toThrow(/positive/)
        })

        it('restarts every changed service and prunes by default', async () => {
            node.sshService.exec.mockImplementation(async (cmd) => {
                if (cmd.includes('find /etc/stereum/services')) return ok('svc-a.yaml\nsvc-b.yaml\n')
                return ok('done')
            })
            const restartSpy = vi.spyOn(node, 'restartService')
            const pruneSpy = vi.spyOn(node, 'pruneDocker')
            const results = await node.restartChangedServices(60)
            expect(restartSpy).toHaveBeenCalledTimes(2)
            expect(restartSpy).toHaveBeenCalledWith('svc-a')
            expect(restartSpy).toHaveBeenCalledWith('svc-b')
            expect(pruneSpy).toHaveBeenCalledTimes(1)
            expect(results).toEqual([
                { serviceId: 'svc-a', ok: true },
                { serviceId: 'svc-b', ok: true },
            ])
        })

        it('prune removes unused images and volumes (mirrors the role)', async () => {
            node.sshService.exec.mockImplementation(async (cmd) => {
                if (cmd.includes('find /etc/stereum/services')) return ok('svc-a.yaml\n')
                return ok('done')
            })
            await node.restartChangedServices(60)
            const pruneCall = node.sshService.exec.mock.calls.find(c => c[0].includes('docker system prune'))
            expect(pruneCall[0]).toContain('docker system prune -af --volumes')
        })

        it('skips restarts and prune when nothing changed', async () => {
            node.sshService.exec.mockResolvedValue(ok('\n'))
            const pruneSpy = vi.spyOn(node, 'pruneDocker')
            const results = await node.restartChangedServices(60)
            expect(results).toEqual([])
            expect(pruneSpy).not.toHaveBeenCalled()
        })

        it('can skip the prune step', async () => {
            node.sshService.exec.mockImplementation(async (cmd) => {
                if (cmd.includes('find /etc/stereum/services')) return ok('svc-a.yaml\n')
                return ok('done')
            })
            const pruneSpy = vi.spyOn(node, 'pruneDocker')
            await node.restartChangedServices(60, { prune: false })
            expect(pruneSpy).not.toHaveBeenCalled()
        })

        it('captures a failed restart without aborting the others', async () => {
            node.sshService.exec.mockImplementation(async (cmd) => {
                if (cmd.includes('find /etc/stereum/services')) return ok('good.yaml\nbad.yaml\n')
                return ok('done')
            })
            vi.spyOn(node, 'restartService').mockImplementation(async (id) => {
                if (id === 'bad') throw new Error('restart blew up')
                return ok('done')
            })
            const results = await node.restartChangedServices(60)
            expect(results).toContainEqual({ serviceId: 'good', ok: true })
            expect(results).toContainEqual({ serviceId: 'bad', ok: false, error: 'restart blew up' })
        })
    })

    describe('toDTO status field', () => {
        it('includes the current status in the full DTO', async () => {
            node._setStatus('connected')
            node.sshService.exec.mockImplementation((cmd) => {
                if (cmd.includes('stereum.yaml')) return Promise.resolve({ rc: 0, stdout: 'a: 1', stderr: '' })
                if (cmd.startsWith('ls')) return Promise.resolve({ rc: 0, stdout: '', stderr: '' })
                if (cmd.startsWith('docker')) return Promise.resolve({ rc: 0, stdout: '', stderr: '' })
                return Promise.resolve({ rc: 0, stdout: '', stderr: '' })
            })
            const dto = await node.toDTO()
            expect(dto.status).toBe('connected')
        })
    })
})
