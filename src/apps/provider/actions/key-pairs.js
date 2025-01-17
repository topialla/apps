// Kiebitz - Privacy-Friendly Appointments
// Copyright (C) 2021-2021 The Kiebitz Authors
// README.md contains license information.

import {
    generateECDHKeyPair,
    generateECDSAKeyPair,
    generateSymmetricKey,
} from 'helpers/crypto';

import { markAsLoading } from 'helpers/actions';

// make sure the signing and encryption key pairs exist
export async function keyPairs(state, keyStore, settings, lockName) {
    const backend = settings.get('backend');

    if (lockName === undefined) lockName = 'keyPairs';

    try {
        // we lock the local backend to make sure we don't have any data races
        await backend.local.lock(lockName);
    } catch (e) {
        throw null; // we throw a null exception (which won't affect the store state)
    }

    try {
        const providerKeyPairs = backend.local.get('provider::keyPairs');

        markAsLoading(state, keyStore);

        if (providerKeyPairs === null) {
            try {
                const syncKey = await generateSymmetricKey();
                const signingKeyPair = await generateECDSAKeyPair();
                const encryptionKeyPair = await generateECDHKeyPair();
                const keyPairs = {
                    sync: syncKey,
                    signing: signingKeyPair,
                    encryption: encryptionKeyPair,
                };
                backend.local.set('provider::keyPairs', keyPairs);
                return {
                    status: 'loaded',
                    data: keyPairs,
                };
            } catch (e) {
                return {
                    status: 'failed',
                    error: e,
                };
            }
        } else {
            return {
                status: 'loaded',
                data: providerKeyPairs,
            };
        }
    } finally {
        backend.local.unlock(lockName);
    }
}

keyPairs.actionName = 'keyPairs';
