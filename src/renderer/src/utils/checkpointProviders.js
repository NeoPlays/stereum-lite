// Public checkpoint-sync providers per network. Base set mirrors stereum's one-click
// installer (launcher/src/store/clickInstallation.js); a few extras are folded in from
// the community-maintained list at https://eth-clients.github.io/checkpoint-sync-endpoints/.
// Each entry: { name, url } where `url` is the beacon-API base a consensus client
// checkpoint-syncs from. URLs carry no trailing slash; the check/flag code appends paths.
//
// These are third-party endpoints, so the modal runs stereum's liveness check
// (GET <url>/eth/v2/debug/beacon/states/finalized -> HTTP 200) before a URL is accepted.
export const CHECKPOINT_PROVIDERS = {
    mainnet: [
        { name: 'Attestant', url: 'https://mainnet-checkpoint-sync.attestant.io' },
        { name: 'Lodestar (ChainSafe)', url: 'https://beaconstate-mainnet.chainsafe.io' },
        { name: 'EthStaker', url: 'https://beaconstate.ethstaker.cc' },
        { name: 'beaconcha.in', url: 'https://sync-mainnet.beaconcha.in' },
        { name: 'Sigma Prime (Lighthouse)', url: 'https://mainnet.checkpoint.sigp.io' },
        { name: 'PietjePuk', url: 'https://checkpointz.pietjepuk.net' },
        { name: 'invis.tools', url: 'https://sync.invis.tools' },
        { name: 'Stakely', url: 'https://mainnet-checkpoint-sync.stakely.io' },
        { name: 'BeaconState.info', url: 'https://beaconstate.info' },
    ],
    holesky: [
        { name: 'Lodestar (ChainSafe)', url: 'https://beaconstate-holesky.chainsafe.io' },
        { name: 'BeaconState.info', url: 'https://holesky.beaconstate.info' },
        { name: 'EthStaker', url: 'https://holesky.beaconstate.ethstaker.cc' },
        { name: 'EF DevOps', url: 'https://checkpoint-sync.holesky.ethpandaops.io' },
        { name: 'Stakely', url: 'https://holesky-checkpoint-sync.stakely.io' },
    ],
    hoodi: [
        { name: 'EthStaker', url: 'https://hoodi.beaconstate.ethstaker.cc' },
        { name: 'EF DevOps', url: 'https://checkpoint-sync.hoodi.ethpandaops.io' },
        { name: 'BeaconState.info', url: 'https://hoodi.beaconstate.info' },
        { name: 'Lodestar (ChainSafe)', url: 'https://beaconstate-hoodi.chainsafe.io' },
        { name: 'Stakely', url: 'https://hoodi-checkpoint-sync.stakely.io' },
        { name: 'Attestant', url: 'https://hoodi-checkpoint-sync.attestant.io' },
        { name: 'Sigma Prime (Lighthouse)', url: 'https://hoodi.checkpoint.sigp.io' },
    ],
    sepolia: [
        { name: 'Lodestar (ChainSafe)', url: 'https://beaconstate-sepolia.chainsafe.io' },
        { name: 'EF DevOps', url: 'https://checkpoint-sync.sepolia.ethpandaops.io' },
        { name: 'BeaconState.info', url: 'https://sepolia.beaconstate.info' },
    ],
    gnosis: [
        { name: 'Gnosis Chain', url: 'https://checkpoint.gnosischain.com' },
    ],
}

/**
 * Providers for a service's network (case-insensitive; unknown/devnet -> []).
 * @param {string} network - a service config's `network` (e.g. "mainnet", "holesky")
 * @returns {{ name: string, url: string }[]}
 */
export function providersForNetwork(network) {
    return CHECKPOINT_PROVIDERS[String(network || '').toLowerCase()] || []
}
