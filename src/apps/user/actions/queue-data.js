// Kiebitz - Privacy-Friendly Appointments
// Copyright (C) 2021-2021 The Kiebitz Authors
// README.md contains license information.

export async function queueData(state, keyStore, settings, data) {
    const backend = settings.get('backend');
    // we just store the data...
    if (data !== undefined) backend.temporary.set('user::queueData', data);
    data = backend.temporary.get('user::queueData');
    if (data === null)
        return {
            status: 'failed',
        };
    return {
        status: 'loaded',
        data: data,
    };
}