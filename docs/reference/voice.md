# Voice

Viewers in a room can talk to each other. The devices in the room can play their voices.

## On a viewer

1. After the answer to your own offer, add the microphone as a `sendonly` transceiver.
2. Send `mute`, then an `offer` with `tracks: [{ track_name: "microphone", mid }]`.
3. To hear someone, send `subscribe` with `microphones: [viewer_id]`.
4. When that viewer's `microphone_generation` changes in `viewers`, subscribe again.

A room takes 10 microphones (`MAX_MICROPHONES_PER_ROOM`). Past that, the offer gets the error `MICROPHONE_LIMIT`. Roll it back and only listen.

## On a device

1. Send your offer with `voices: true`.
2. The worker sends an `offer` each time the microphones in your rooms change.
3. Answer it within 10 seconds. If you do not, you play no voices until you publish again.
