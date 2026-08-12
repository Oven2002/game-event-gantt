import { ModelManager } from './model.js';
import { clearMessage, showMessage, welcomeMessage } from './message.js';
import { randomSelection } from './utils.js';
import { ToolsManager } from './tools.js';
import logger from './logger.js';
import registerDrag from './drag.js';
import { fa_child } from './icons.js';
const WAIFU_DISABLED_KEY = 'waifu-disabled';
let activeConsoleTips = null;
const devtools = () => {
    if (activeConsoleTips)
        showMessage(activeConsoleTips.message.console, 6000, 9);
};
devtools.toString = () => {
    if (activeConsoleTips)
        showMessage(activeConsoleTips.message.console, 6000, 9);
    return '';
};
console.log('%c', devtools);
function registerEventListener(tips) {
    let userAction = false;
    let userActionTimer;
    let idleTimer;
    const messageArray = [...tips.message.default];
    tips.seasons.forEach(({ date, text }) => {
        const now = new Date(), after = date.split('-')[0], before = date.split('-')[1] || after;
        if (Number(after.split('/')[0]) <= now.getMonth() + 1 &&
            now.getMonth() + 1 <= Number(before.split('/')[0]) &&
            Number(after.split('/')[1]) <= now.getDate() &&
            now.getDate() <= Number(before.split('/')[1])) {
            text = randomSelection(text);
            text = text.replace('{year}', String(now.getFullYear()));
            messageArray.push(text);
        }
    });
    let lastHoverElement;
    const markUserAction = () => (userAction = true);
    const checkIdle = () => {
        if (userAction) {
            userAction = false;
            if (userActionTimer)
                clearInterval(userActionTimer);
            userActionTimer = undefined;
        }
        else if (!userActionTimer) {
            userActionTimer = setInterval(() => {
                showMessage(messageArray, 6000, 9);
            }, 20000);
        }
    };
    const startIdleTimer = () => {
        if (idleTimer === undefined)
            idleTimer = setInterval(checkIdle, 1000);
    };
    startIdleTimer();
    const handleMouseOver = (event) => {
        var _a;
        for (let { selector, text } of tips.mouseover) {
            if (!((_a = event.target) === null || _a === void 0 ? void 0 : _a.closest(selector)))
                continue;
            if (lastHoverElement === selector)
                return;
            lastHoverElement = selector;
            text = randomSelection(text);
            text = text.replace('{text}', event.target.innerText);
            showMessage(text, 4000, 8);
            return;
        }
    };
    const handleClick = (event) => {
        var _a;
        for (let { selector, text } of tips.click) {
            if (!((_a = event.target) === null || _a === void 0 ? void 0 : _a.closest(selector)))
                continue;
            text = randomSelection(text);
            text = text.replace('{text}', event.target.innerText);
            showMessage(text, 4000, 8);
            return;
        }
    };
    const handleHoverBody = () => {
        const text = randomSelection(tips.message.hoverBody);
        showMessage(text, 4000, 8, false);
    };
    const handleTapBody = () => {
        const text = randomSelection(tips.message.tapBody);
        showMessage(text, 4000, 9);
    };
    activeConsoleTips = tips;
    const handleCopy = () => {
        showMessage(tips.message.copy, 6000, 9);
    };
    const handleVisibility = () => {
        if (document.hidden) {
            if (idleTimer)
                clearInterval(idleTimer);
            idleTimer = undefined;
            if (userActionTimer)
                clearInterval(userActionTimer);
            userActionTimer = undefined;
        }
        else {
            startIdleTimer();
            showMessage(tips.message.visibilitychange, 6000, 9);
        }
    };
    window.addEventListener('mousemove', markUserAction);
    window.addEventListener('keydown', markUserAction);
    window.addEventListener('mouseover', handleMouseOver);
    window.addEventListener('click', handleClick);
    window.addEventListener('live2d:hoverbody', handleHoverBody);
    window.addEventListener('live2d:tapbody', handleTapBody);
    window.addEventListener('copy', handleCopy);
    window.addEventListener('visibilitychange', handleVisibility);
    return () => {
        if (activeConsoleTips === tips)
            activeConsoleTips = null;
        if (idleTimer)
            clearInterval(idleTimer);
        if (userActionTimer)
            clearInterval(userActionTimer);
        window.removeEventListener('mousemove', markUserAction);
        window.removeEventListener('keydown', markUserAction);
        window.removeEventListener('mouseover', handleMouseOver);
        window.removeEventListener('click', handleClick);
        window.removeEventListener('live2d:hoverbody', handleHoverBody);
        window.removeEventListener('live2d:tapbody', handleTapBody);
        window.removeEventListener('copy', handleCopy);
        window.removeEventListener('visibilitychange', handleVisibility);
    };
}
let activeRuntime = null;
let loadingModel = null;
let loadPromise = null;
let visibilityListenerInstalled = false;
async function loadWidgetInternal(config) {
    var _a, _b, _c, _d;
    localStorage.removeItem('waifu-display');
    sessionStorage.removeItem('waifu-message-priority');
    (_a = document.getElementById('waifu')) === null || _a === void 0 ? void 0 : _a.remove();
    document.body.insertAdjacentHTML('beforeend', `<div id="waifu">
       <div id="waifu-tips"></div>
       <div id="waifu-canvas">
         <canvas id="live2d" width="300" height="300"></canvas>
       </div>
       <div id="waifu-tool"></div>
     </div>`);
    let models = [];
    let tips;
    try {
        if (config.waifuData) {
            tips = config.waifuData;
        }
        else if (config.waifuPath) {
            const response = await fetch(config.waifuPath);
            if (!response.ok)
                throw new Error(`Failed to load waifu config (${response.status}).`);
            tips = await response.json();
        }
        else {
            throw new Error('Missing waifuData or waifuPath.');
        }
    }
    catch (error) {
        (_b = document.getElementById('waifu')) === null || _b === void 0 ? void 0 : _b.remove();
        throw error;
    }
    models = tips.models;
    let removeEventListeners = () => { };
    let model;
    try {
        removeEventListeners = registerEventListener(tips);
        showMessage(welcomeMessage(tips.time, tips.message.welcome, tips.message.referrer), 7000, 11);
        model = await ModelManager.initCheck(config, models);
        loadingModel = model;
        const loaded = await model.loadModel('');
        if (!loaded)
            throw new Error('The initial Live2D model failed to load.');
        loadingModel = null;
        let disposed = false;
        const dragCleanup = config.drag ? registerDrag() : undefined;
        const handlePageHide = (event) => {
            if (event.persisted)
                return;
            dispose();
        };
        const dispose = () => {
            var _a, _b, _c;
            if (disposed)
                return;
            disposed = true;
            window.removeEventListener('pagehide', handlePageHide);
            model.dispose();
            try {
                const canvas = document.getElementById('live2d');
                const gl = (_a = canvas === null || canvas === void 0 ? void 0 : canvas.getContext('webgl2')) !== null && _a !== void 0 ? _a : canvas === null || canvas === void 0 ? void 0 : canvas.getContext('webgl');
                (_b = gl === null || gl === void 0 ? void 0 : gl.getExtension('WEBGL_lose_context')) === null || _b === void 0 ? void 0 : _b.loseContext();
            }
            catch (_d) { }
            removeEventListeners();
            dragCleanup === null || dragCleanup === void 0 ? void 0 : dragCleanup();
            clearMessage();
            (_c = document.getElementById('waifu')) === null || _c === void 0 ? void 0 : _c.remove();
            if ((activeRuntime === null || activeRuntime === void 0 ? void 0 : activeRuntime.model) === model)
                activeRuntime = null;
            window.dispatchEvent(new Event('live2d:widget-disposed'));
        };
        const runtime = { model, dispose };
        activeRuntime = runtime;
        window.addEventListener('pagehide', handlePageHide);
        new ToolsManager(model, config, tips, {
            onPause: () => model.pause(),
            onDispose: dispose,
        }).registerTools();
        (_c = document.getElementById('waifu')) === null || _c === void 0 ? void 0 : _c.classList.add('waifu-active');
        window.dispatchEvent(new Event('live2d:widget-ready'));
        return runtime;
    }
    catch (error) {
        model === null || model === void 0 ? void 0 : model.dispose();
        if ((activeRuntime === null || activeRuntime === void 0 ? void 0 : activeRuntime.model) === model)
            activeRuntime = null;
        loadingModel = null;
        removeEventListeners();
        clearMessage();
        (_d = document.getElementById('waifu')) === null || _d === void 0 ? void 0 : _d.remove();
        throw error;
    }
}
async function loadWidget(config) {
    if (activeRuntime)
        return activeRuntime;
    if (loadPromise)
        return loadPromise;
    const pending = loadWidgetInternal(config);
    loadPromise = pending;
    try {
        return await pending;
    }
    finally {
        if (loadPromise === pending)
            loadPromise = null;
    }
}
function initWidget(config) {
    if (typeof config === 'string') {
        logger.error('Your config for Live2D initWidget is outdated. Please refer to https://github.com/stevenjoezhang/live2d-widget/blob/master/dist/autoload.js');
        return;
    }
    if (localStorage.getItem(WAIFU_DISABLED_KEY) === 'true') {
        return;
    }
    if (visibilityListenerInstalled)
        return;
    visibilityListenerInstalled = true;
    document.addEventListener('visibilitychange', () => {
        var _a;
        const model = (_a = activeRuntime === null || activeRuntime === void 0 ? void 0 : activeRuntime.model) !== null && _a !== void 0 ? _a : loadingModel;
        if (!model)
            return;
        if (document.hidden)
            model.pause();
        else
            model.resume();
    });
    logger.setLevel(config.logLevel);
    document.body.insertAdjacentHTML('beforeend', `<div id="waifu-toggle">
       ${fa_child}
     </div>`);
    const toggle = document.getElementById('waifu-toggle');
    toggle === null || toggle === void 0 ? void 0 : toggle.addEventListener('click', async () => {
        var _a;
        toggle === null || toggle === void 0 ? void 0 : toggle.classList.remove('waifu-toggle-active');
        const runtime = activeRuntime;
        if ((toggle === null || toggle === void 0 ? void 0 : toggle.getAttribute('first-time')) || !runtime || !document.getElementById('waifu')) {
            toggle === null || toggle === void 0 ? void 0 : toggle.removeAttribute('first-time');
            try {
                const nextRuntime = await loadWidget(config);
                nextRuntime.model.resume();
            }
            catch (error) {
                logger.error('Failed to reopen Live2D widget.', error);
            }
        }
        else {
            localStorage.removeItem('waifu-display');
            (_a = document.getElementById('waifu')) === null || _a === void 0 ? void 0 : _a.classList.remove('waifu-hidden');
            runtime.model.resume();
            setTimeout(() => {
                var _a;
                (_a = document.getElementById('waifu')) === null || _a === void 0 ? void 0 : _a.classList.add('waifu-active');
            }, 0);
        }
    });
    if (localStorage.getItem('waifu-display') &&
        Date.now() - Number(localStorage.getItem('waifu-display')) <= 86400000) {
        toggle === null || toggle === void 0 ? void 0 : toggle.setAttribute('first-time', 'true');
        setTimeout(() => {
            toggle === null || toggle === void 0 ? void 0 : toggle.classList.add('waifu-toggle-active');
        }, 0);
    }
    else {
        void loadWidget(config).catch((error) => {
            logger.error('Failed to load Live2D widget.', error);
        });
    }
}
export { initWidget };
