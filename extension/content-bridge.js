// content-bridge.js
// This script is injected into the VibeWorker Web App page (e.g., localhost:3000)
// It listens for messages from the Web App and forwards them to the Extension Background.

console.log('VibeWorker Content Bridge injected.');

window.addEventListener('message', (event) => {
    // Only accept messages from the same window
    if (event.source !== window) {
        return;
    }

    const message = event.data;

    // We only care about messages intended for the extension
    if (message && message.type === 'VIBEWORKER_EXTENSION_REQUEST') {
        console.log('Content Bridge intercepting VibeWorker request:', message);

        // Forward to the extension background script
        try {
            chrome.runtime.sendMessage(message, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('Content Bridge error:', chrome.runtime.lastError.message);
                    return;
                }
                console.log('Content Bridge received response from background:', response);

                // Optionally send a response back to the Web App
                window.postMessage({
                    type: 'VIBEWORKER_EXTENSION_RESPONSE',
                    payload: response
                }, '*');
            });
        } catch (e) {
            console.error('Content Bridge exception:', e);
        }
    }
});

// Listen for messages from the extension background and forward to Web App
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'VIBEWORKER_USER_FINISHED') {
        console.log('Content Bridge received VIBEWORKER_USER_FINISHED from background:', request);
        window.postMessage({
            type: 'VIBEWORKER_EXTENSION_RESPONSE',
            payload: request.payload
        }, '*');
    }
});
