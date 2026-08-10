import { describe, it, expect } from 'vitest'
import { serviceCategory, groupServices, SERVICE_CATEGORY, CATEGORY_ORDER, CATEGORY_LABELS, CATEGORY_COLOR } from '@renderer/utils/serviceCategory'

describe('serviceCategory', () => {
    it('categorizes execution / consensus / validator clients', () => {
        expect(serviceCategory('GethService')).toBe('execution')
        expect(serviceCategory('EthrexService')).toBe('execution')
        expect(serviceCategory('LighthouseBeaconService')).toBe('consensus')
        expect(serviceCategory('GrandineBeaconService')).toBe('consensus')
        expect(serviceCategory('LighthouseValidatorService')).toBe('validator')
    })

    it('treats Charon, SSVNetwork and Web3Signer as validator middleware', () => {
        expect(serviceCategory('CharonService')).toBe('validator')
        expect(serviceCategory('SSVNetworkService')).toBe('validator')
        expect(serviceCategory('Web3SignerService')).toBe('validator')
    })

    it('puts mev-boost, the ejector, and monitoring/helpers in "other"', () => {
        expect(serviceCategory('FlashbotsMevBoostService')).toBe('other')
        expect(serviceCategory('ValidatorEjectorService')).toBe('other') // not validator, despite the name
        expect(serviceCategory('PrometheusService')).toBe('other')
        expect(serviceCategory('GrafanaService')).toBe('other')
        expect(serviceCategory('SSVDKGService')).toBe('other')
        expect(serviceCategory('KeysAPIService')).toBe('other')
    })

    it('falls back to "other" for unknown / custom types and undefined', () => {
        expect(serviceCategory('CustomService')).toBe('other')
        expect(serviceCategory('SomeFutureService')).toBe('other')
        expect(serviceCategory(undefined)).toBe('other')
    })

    it('every mapped category is a known ordered key with a label + color', () => {
        for (const cat of Object.values(SERVICE_CATEGORY)) {
            expect(CATEGORY_ORDER).toContain(cat)
        }
        for (const key of CATEGORY_ORDER) {
            expect(typeof CATEGORY_LABELS[key]).toBe('string')
            expect(typeof CATEGORY_COLOR[key]).toBe('string')
        }
    })
})

describe('groupServices', () => {
    const svc = (id, service, setup) => ({ id, config: { service }, setup })
    const eth = { id: 'setup-eth', name: 'ethSetup1', network: 'hoodi', type: 'ETH' }
    const common = { id: 'setup-common', name: 'commonServices', network: 'default', type: 'common' }

    it('groups by setup (common last), then by ordered category', () => {
        const services = [
            svc('c1', 'PrometheusService', common),
            svc('v1', 'LighthouseValidatorService', eth),
            svc('e1', 'GethService', eth),
            svc('b1', 'LighthouseBeaconService', eth),
        ]
        const groups = groupServices(services)
        expect(groups.map((g) => g.setup.id)).toEqual(['setup-eth', 'setup-common']) // common last
        const ethGroup = groups[0]
        // categories ordered EC -> CC -> VC, empties dropped
        expect(ethGroup.categories.map((c) => c.key)).toEqual(['execution', 'consensus', 'validator'])
        expect(ethGroup.categories[0].services.map((s) => s.id)).toEqual(['e1'])
        expect(groups[1].categories.map((c) => c.key)).toEqual(['other'])
    })

    it('puts services with no setup in a trailing headerless group', () => {
        const groups = groupServices([svc('x', 'GethService', null)])
        expect(groups).toHaveLength(1)
        expect(groups[0].setup).toBeNull()
        expect(groups[0].categories[0].key).toBe('execution')
    })

    it('puts a name-tagged commonServices setup last even when its type is unset', () => {
        const shared = { id: 'setup-shared', name: 'commonServices', network: 'default', type: null }
        const groups = groupServices([
            svc('c1', 'PrometheusService', shared),
            svc('e1', 'GethService', eth),
        ])
        expect(groups.map((g) => g.setup.id)).toEqual(['setup-eth', 'setup-shared'])
    })

    it('sorts real setups by name', () => {
        const b = { id: 's-b', name: 'bravo', type: 'ETH' }
        const a = { id: 's-a', name: 'alpha', type: 'ETH' }
        const groups = groupServices([svc('1', 'GethService', b), svc('2', 'GethService', a)])
        expect(groups.map((g) => g.setup.name)).toEqual(['alpha', 'bravo'])
    })
})
