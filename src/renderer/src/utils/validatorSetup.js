// Classify a validator setup into one of the staking paradigms so the Validators tab
// can render (and gate) the right thing. This is deliberately a pure function of the
// services in a setup - it decides WHAT a setup is, never touches SSH.
//
// The three paradigms are fundamentally different in WHO holds the signing keys, which
// is why solo key-management (import/remove/exit) must never be offered for Obol or SSV:
//   - solo:          the validator client (VC) holds keystores locally.
//   - remote-signer: a Web3Signer holds the keys; the VC only knows pubkeys.
//   - obol:          Charon middleware. The REAL distributed-validator pubkeys live in
//                    Charon's cluster-lock.json (read via the CharonService), not in the VC's
//                    share keystores - so keyHolder is the Charon service. Mutations
//                    (add/exit/remove) are multi-party and stay disabled (isSoloEligible=false).
//   - ssv:           an SSV operator node holds on-chain-delivered shares; registration
//                    and exit are wallet/multi-operator actions done off-node.

export const SOLO_VC_TYPES = new Set([
    'LighthouseValidatorService', 'PrysmValidatorService', 'NimbusValidatorService',
    'TekuValidatorService', 'LodestarValidatorService',
])
export const CHARON_TYPE = 'CharonService'
export const SSV_TYPE = 'SSVNetworkService'
export const WEB3SIGNER_TYPE = 'Web3SignerService'

/**
 * @param {{ id: string, config?: { service?: string } }[]} services - the services in one setup
 * @returns {{
 *   kind: 'solo'|'remote-signer'|'obol'|'ssv'|'none',
 *   clients: object[],        // all validator-category services in the setup
 *   keyHolder: object|null,   // solo: the VC; remote-signer: the Web3Signer; else null
 *   charon: object|null,
 *   ssv: object|null,
 *   web3signer: object|null,
 * }}
 */
export function classifyValidatorSetup(services = []) {
    const typeOf = (s) => s?.config?.service
    const find = (t) => services.find((s) => typeOf(s) === t) || null

    const charon = find(CHARON_TYPE)
    const ssv = find(SSV_TYPE)
    const web3signer = find(WEB3SIGNER_TYPE)
    const vcs = services.filter((s) => SOLO_VC_TYPES.has(typeOf(s)))
    const clients = services.filter((s) =>
        SOLO_VC_TYPES.has(typeOf(s)) || typeOf(s) === CHARON_TYPE || typeOf(s) === SSV_TYPE || typeOf(s) === WEB3SIGNER_TYPE)

    // Precedence: ssv > obol > remote-signer > solo. A setup can contain several (e.g. Obol
    // fronts a real VC that holds shares) - the outermost paradigm wins so we never treat a
    // share-holding VC as a solo key store.
    let kind = 'none'
    let keyHolder = null
    if (ssv) kind = 'ssv' // keyHolder stays null: SSV lists via the external api.ssv.network (not yet wired)
    // Obol: list the cluster's distributed-validator pubkeys from Charon's cluster-lock.json.
    else if (charon) { kind = 'obol'; keyHolder = charon }
    else if (web3signer) { kind = 'remote-signer'; keyHolder = web3signer }
    else if (vcs.length) { kind = 'solo'; keyHolder = vcs[0] }

    return { kind, clients, keyHolder, charon, ssv, web3signer }
}

/** Only solo setups may use the local keystore import/remove/exit lifecycle (slashing gate S4). */
export function isSoloEligible(kind) {
    return kind === 'solo'
}

/**
 * Whether a holder's pubkeys are REAL on-chain validators - i.e. they have beacon-chain
 * stats (status/balance/withdrawal/index). Charon's cluster-lock distributed-validator
 * pubkeys and a solo VC's (or a plain remote-signer's) keys are on-chain. The key SHARES a
 * VC or Web3Signer holds BEHIND Charon are not - a share pubkey never appears on-chain, so
 * beacon queries return nothing. Slice 1 uses this to enrich only on-chain holders and mark
 * shares as n/a. (Charon's own cluster/peer health comes separately from Prometheus.)
 * @param {'validator'|'share'|'distributed'|'signer'|'ssv'} role
 * @param {'solo'|'remote-signer'|'obol'|'ssv'} kind
 */
export function holdsOnChainValidators(role, kind) {
    if (role === 'distributed') return true   // Charon DV pubkeys are on-chain validators
    if (role === 'ssv') return false          // registered/managed off-node
    if (kind === 'obol') return false         // VC / Web3Signer behind Charon hold key shares only
    return role === 'validator' || role === 'signer'
}
