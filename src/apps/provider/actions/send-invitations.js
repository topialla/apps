// Kiebitz - Privacy-Friendly Appointments
// Copyright (C) 2021-2021 The Kiebitz Authors
// README.md contains license information.

import {
    sign,
    ecdhEncrypt,
    ecdhDecrypt,
    randomBytes,
    generateECDHKeyPair,
} from 'helpers/crypto';

function getQueuePrivateKey(queueID, verifiedProviderData) {
    for (const queueKeys of verifiedProviderData.queuePrivateKeys) {
        if (queueKeys.id === queueID) return JSON.parse(queueKeys.privateKey);
    }
    return null;
}

// regularly checks open appointment slots
export async function sendInvitations(
    state,
    keyStore,
    settings,
    keyPairs,
    verifiedProviderData
) {
    const backend = settings.get('backend');
    // we lock the local backend to make sure we don't have any data races

    try {
        // we lock the local backend to make sure we don't have any data races
        await backend.local.lock();
    } catch (e) {
        throw null; // we throw a null exception (which won't affect the store state)
    }

    try {
        let openAppointments = backend.local.get(
            'provider::appointments::open',
            []
        );

        if (openAppointments.length === 0)
            // we don't have any new appointments to give out
            return {
                status: 'succeeded',
            };

        // only offer appointments that are in the future
        openAppointments = openAppointments.filter(oa => {
            const timestamp = new Date(oa.timestamp);
            const inOneHour = new Date(new Date().getTime() + 1000 * 60 * 60);
            return timestamp > inOneHour;
        });

        let openTokens = backend.local.get('provider::tokens::open', []);
        // we announce expired tokens to the backend
        let expiredTokens = openTokens.filter(
            token => new Date(token.expiresAt) <= new Date()
        );
        // we filter out any expired tokens...

        // we send the signed, encrypted data to the backend
        if (expiredTokens.length > 0)
            await backend.appointments.returnTokens(
                { tokens: expiredTokens.map(token => token.token) },
                keyPairs.signing
            );

        openTokens = openTokens.filter(
            token => new Date(token.expiresAt) > new Date()
        );
        let openSlots = 0;
        openAppointments.forEach(ap => {
            openSlots += ap.slotData.filter(sl => sl.open).length;
        });
        try {
            // how many more users we invite than we have slots
            const overbookingFactor = 5;
            const n = Math.floor(
                Math.max(0, openSlots * overbookingFactor - openTokens.length)
            );
            // we don't have enough tokens for our open appointments, we generate more
            if (n > 0 && openTokens.length < 1000) {
                // to do: get appointments by type
                const newTokens = await backend.appointments.getQueueTokens(
                    { capacities: [{ n: n, properties: {} }] },
                    keyPairs.signing
                );
                if (newTokens === null)
                    return {
                        status: 'failed',
                    };
                const validTokens = [];
                for (const tokenList of newTokens) {
                    for (const token of tokenList) {
                        const privateKey = getQueuePrivateKey(
                            token.queue,
                            verifiedProviderData
                        );
                        try {
                            token.data = JSON.parse(
                                await ecdhDecrypt(
                                    token.encryptedData,
                                    privateKey
                                )
                            );
                        } catch (e) {
                            console.error(e);
                            continue;
                        }
                        token.keyPair = await generateECDHKeyPair();
                        token.grantID = randomBytes(32);
                        token.slotIDs = [];
                        // users have 24 hours to respond
                        token.expiresAt = new Date(
                            new Date().getTime() + 1000 * 60 * 60 * 24
                        ).toISOString();
                        validTokens.push(token);
                    }
                    openTokens = [...openTokens, ...validTokens];
                }
                // we update the list of open tokens
                backend.local.set('provider::tokens::open', openTokens);
            }

            const selectedAppointments = openAppointments.filter(
                oa => oa.slotData.filter(sl => sl.open || true).length > 0
            );
            const appointmentsById = {};
            const appointmentsBySlotId = {};
            const slotsById = {};

            for (const oa of selectedAppointments) {
                appointmentsById[oa.id] = oa;
                for (const slot of oa.slotData) {
                    appointmentsBySlotId[slot.id] = oa;
                    slotsById[slot.id] = slot;
                }
            }
            const dataToSubmit = [];
            // we make sure all token holders can initialize all appointment data IDs
            for (const [i, token] of openTokens.entries()) {
                try {

                    if (token.grantID === undefined)
                        token.grantID = randomBytes(32);
                    if (token.slotIDs === undefined) token.slotIDs = [];
                    token.slotIDs = token.slotIDs.filter(id => {
                        const slot = slotsById[id];
                        // we remove slots that have been deleted
                        if (slot === undefined) return false;
                        // we remove slots taken by other users
                        if (!slot.open && !slot.token.token === token.token)
                            return false;
                        return true;
                    });

                    addSlots: while (token.slotIDs.length < 12) {
                        let addedSlots = 0;
                        for (const oa of selectedAppointments) {
                            const openSlots = oa.slotData.filter(sl => sl.open);
                            // we add three slots per appointment offer
                            for (
                                let i = 0;
                                i < Math.min(3, openSlots.length);
                                i++
                            ) {
                                if (
                                    !token.slotIDs.find(
                                        id => id === openSlots[i].id
                                    )
                                ) {
                                    addedSlots++;
                                    token.slotIDs.push(openSlots[i].id);
                                }
                                if (token.slotIDs.length >= 12) break addSlots;
                            }
                        }
                        // seems there are no more slots left
                        if (addedSlots === 0) break;
                    }
                    // to do: expire tokens
                    token.expiresAt = new Date(
                        new Date().getTime() + 1000 * 60 * 60 * 24
                    ).toISOString();
                    // we generate grants for all appointments IDs.

                    const slots = [];
                    token.slotIDs.forEach(id => {
                        const slot = slotsById[id];
                        if (slot !== undefined) slots.push(slot);
                    });

                    let grantsData = await Promise.all(
                        slots.map(
                            async slot =>
                                await sign(
                                    keyPairs.signing.privateKey,
                                    JSON.stringify({
                                        objectID: slot.id,
                                        grantID: token.grantID,
                                        singleUse: true,
                                        expiresAt: token.expiresAt,
                                        permissions: [
                                            {
                                                rights: [
                                                    'read',
                                                    'write',
                                                    'delete',
                                                ],
                                                keys: [
                                                    keyPairs.signing.publicKey,
                                                ],
                                            },
                                            {
                                                rights: [
                                                    'write',
                                                    'read',
                                                    'delete',
                                                ],
                                                keys: [token.data.publicKey],
                                            },
                                        ],
                                    }),
                                    keyPairs.signing.publicKey
                                )
                        )
                    );

                    const appointments = {};

                    slots.forEach((slot, i) => {
                        const oa = appointmentsBySlotId[slot.id];
                        if (appointments[oa.id] === undefined)
                            appointments[oa.id] = {
                                ...oa,
                                slotData: [],
                                grants: [],
                            };

                        const appointment = appointments[oa.id];

                        appointment.slotData.push(slot);
                        appointment.grants.push(grantsData[i]);
                    });

                    const userData = {
                        provider: verifiedProviderData.signedData,
                        offers: Array.from(Object.values(appointments)),
                    };

                    // we first encrypt the data
                    const encryptedUserData = await ecdhEncrypt(
                        JSON.stringify(userData),
                        token.keyPair,
                        token.encryptedData.publicKey
                    );
                    // we sign the data with our private key
                    const signedEncryptedUserData = await sign(
                        keyPairs.signing.privateKey,
                        JSON.stringify(encryptedUserData),
                        keyPairs.signing.publicKey
                    );
                    const submitData = {
                        id: token.data.id,
                        data: signedEncryptedUserData,
                        permissions: [
                            {
                                rights: ['read'],
                                keys: [token.data.publicKey],
                            },
                            {
                                rights: ['read', 'write', 'delete'],
                                keys: [keyPairs.signing.publicKey],
                            },
                        ],
                    };
                    dataToSubmit.push(submitData);
                } catch (e) {
                    console.error(e);
                    continue;
                }
            }

            backend.local.set('provider::tokens::open', openTokens);

            // we send the signed, encrypted data to the backend
            await backend.appointments.bulkStoreData(
                { dataList: dataToSubmit },
                keyPairs.signing
            );

            return { status: 'succeeded' };
        } catch (e) {
            console.error(e);
            return { status: 'failed', error: e };
        }
    } catch (e) {
        console.error(e);
    } finally {
        backend.local.unlock();
    }
}

sendInvitations.actionName = 'sendInvitations';
