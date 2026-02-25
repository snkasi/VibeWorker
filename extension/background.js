// background.js

// 记录需要等待用户完成操作的标签页映射关系：targetTabId -> senderApp (Web端)
const pendingUserActions = new Map();

function injectWaitUIWhenReady(tabId) {
    const listener = (updatedTabId, info, tab) => {
        if (updatedTabId === tabId && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['injected-ui.js']
            }).catch(e => console.error("Inject UI failed:", e));
        }
    };
    chrome.tabs.onUpdated.addListener(listener);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'USER_FINISHED_WORK') {
        const targetTabId = sender.tab?.id;
        if (targetTabId && pendingUserActions.has(targetTabId)) {
            const originApp = pendingUserActions.get(targetTabId);

            // 将完成信号转发回原始的发起方（Web端页面）
            if (originApp.senderTabId) {
                chrome.tabs.sendMessage(originApp.senderTabId, {
                    type: 'VIBEWORKER_USER_FINISHED',
                    payload: { action: 'USER_FINISHED_WORK', targetTabId: targetTabId }
                }).catch(e => console.log("Failed to send message back to app:", e));

                // 将浏览器焦点自动切回 Web 端页面
                chrome.tabs.update(originApp.senderTabId, { active: true });
                if (originApp.senderWindowId) {
                    chrome.windows.update(originApp.senderWindowId, { focused: true });
                }
            }

            pendingUserActions.delete(targetTabId);
            sendResponse({ status: 'success' });
        }
        return true;
    }

    if (request.type === 'VIBEWORKER_EXTENSION_REQUEST') {
        const action = request.payload?.action;
        const targetUrl = request.payload?.url || 'https://github.com'; // Default for testing

        console.log(`Received action: ${action} with URL: ${targetUrl}`);

        if (action === 'PING') {
            chrome.notifications.create({
                type: 'basic',
                title: 'VibeWorker Extension',
                message: `Received action: ${action}`,
                priority: 2,
                iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
            });
            sendResponse({ status: 'success', message: 'PING received.' });
        }
        else if (action === 'HEALTH_CHECK') {
            sendResponse({ status: 'success', message: 'Extension is healthy.' });
        }
        else if (action === 'OPEN_POPUP') {
            const focused = request.payload?.require_focus !== false; // Default to true
            const waitForUser = request.payload?.wait_for_user === true;
            chrome.windows.create({
                url: targetUrl,
                type: 'popup',
                width: 800,
                height: 600,
                focused: focused
            }, (win) => {
                let tabId = null;
                if (win.tabs && win.tabs.length > 0) {
                    tabId = win.tabs[0].id;
                }

                const returnResponse = (tId) => {
                    if (waitForUser && tId) {
                        pendingUserActions.set(tId, {
                            senderTabId: sender.tab ? sender.tab.id : null,
                            senderWindowId: sender.tab ? sender.tab.windowId : null
                        });
                        injectWaitUIWhenReady(tId);
                    }
                    sendResponse({ status: 'success', windowId: win.id, tabId: tId, waiting_for_user: waitForUser, message: 'Popup opened.' });
                };

                if (tabId) {
                    returnResponse(tabId);
                } else {
                    chrome.tabs.query({ windowId: win.id }, (tabs) => {
                        tabId = tabs && tabs.length > 0 ? tabs[0].id : null;
                        returnResponse(tabId);
                    });
                }
            });
            return true; // Keep channel open for async response
        }
        else if (action === 'OPEN_TAB') {
            const active = request.payload?.require_focus !== false; // Default to true
            const waitForUser = request.payload?.wait_for_user === true;
            chrome.tabs.create({
                url: targetUrl,
                active: active
            }, (tab) => {
                if (waitForUser && tab.id) {
                    pendingUserActions.set(tab.id, {
                        senderTabId: sender.tab ? sender.tab.id : null,
                        senderWindowId: sender.tab ? sender.tab.windowId : null
                    });
                    injectWaitUIWhenReady(tab.id);
                }
                sendResponse({ status: 'success', tabId: tab.id, waiting_for_user: waitForUser, message: 'Tab opened.' });
            });
            return true; // Keep channel open for async response
        }
        else if (action === 'EXTRACT_CONTENT') {
            const tabId = request.payload?.tabId;
            if (!tabId) {
                sendResponse({ status: 'error', message: 'tabId is required for EXTRACT_CONTENT action.' });
                return true;
            }

            // Execute scripting in the target tab
            chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['lib/turndown.js'] // First inject the dependency
            }, () => {
                if (chrome.runtime.lastError) {
                    console.error('Script injection failed:', chrome.runtime.lastError.message);
                    sendResponse({ status: 'error', message: chrome.runtime.lastError.message });
                    return;
                }

                // Then inject the extractor
                chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    files: ['content-extractor.js']
                }, (results) => {
                    if (chrome.runtime.lastError) {
                        console.error('Extractor execution failed:', chrome.runtime.lastError.message);
                        sendResponse({ status: 'error', message: chrome.runtime.lastError.message });
                        return;
                    }
                    const extractionResult = results?.[0]?.result;
                    sendResponse({ status: 'success', data: extractionResult });
                });
            });

            return true; // async response
        }
        else if (action === 'EXECUTE_ACTION') {
            const tabId = request.payload?.tabId;
            const domAction = request.payload?.domAction; // e.g. 'type', 'click'
            const selector = request.payload?.selector;
            const text = request.payload?.text;

            if (!tabId || !domAction || !selector) {
                sendResponse({ status: 'error', message: 'tabId, domAction, and selector are required for EXECUTE_ACTION.' });
                return true;
            }

            // Define the actual execution function that will be injected
            function injectorWrapper(actionStr, selectorStr, textStr) {
                try {
                    const el = document.querySelector(selectorStr);
                    if (!el) return { success: false, error: `Element not found: ${selectorStr}` };

                    if (actionStr === 'click') {
                        el.click();
                        return { success: true, message: `Clicked ${selectorStr}` };
                    }
                    else if (actionStr === 'type') {
                        el.focus();

                        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
                        const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;

                        if (el.tagName.toLowerCase() === 'textarea' && nativeTextAreaValueSetter) {
                            nativeTextAreaValueSetter.call(el, textStr);
                        } else if (nativeInputValueSetter) {
                            nativeInputValueSetter.call(el, textStr);
                        } else {
                            el.value = textStr;
                        }

                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));

                        // Simulate pressing Enter if we typed something
                        el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
                        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13 }));

                        return { success: true, message: `Typed '${textStr}' into ${selectorStr} and pressed Enter` };
                    }
                    return { success: false, error: 'Unknown domAction' };
                } catch (e) {
                    return { success: false, error: e.toString() };
                }
            }

            // Execute scripting in the target tab passing the arguments
            chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: injectorWrapper,
                args: [domAction, selector, text]
            }, (results) => {
                if (chrome.runtime.lastError) {
                    console.error('Action execution failed:', chrome.runtime.lastError.message);
                    sendResponse({ status: 'error', message: chrome.runtime.lastError.message });
                    return;
                }
                const execResult = results?.[0]?.result;
                sendResponse({ status: 'success', data: execResult });
            });

            return true; // async response
        }
        else if (action === 'CLOSE_TAB') {
            const tabId = request.payload?.tabId;
            const windowId = request.payload?.windowId;

            if (!tabId && !windowId) {
                sendResponse({ status: 'error', message: 'tabId or windowId is required for CLOSE_TAB action.' });
                return true;
            }

            if (windowId) {
                chrome.windows.remove(windowId, () => {
                    if (chrome.runtime.lastError) {
                        sendResponse({ status: 'error', message: chrome.runtime.lastError.message });
                    } else {
                        sendResponse({ status: 'success', message: `Window ${windowId} closed.` });
                    }
                });
            } else if (tabId) {
                chrome.tabs.remove(tabId, () => {
                    if (chrome.runtime.lastError) {
                        sendResponse({ status: 'error', message: chrome.runtime.lastError.message });
                    } else {
                        sendResponse({ status: 'success', message: `Tab ${tabId} closed.` });
                    }
                });
            }
            return true;
        }
        else {
            sendResponse({ status: 'error', message: `Unknown action: ${action}` });
        }
    }
    return true;
});

console.log('VibeWorker Extension Background Service Worker started.');
