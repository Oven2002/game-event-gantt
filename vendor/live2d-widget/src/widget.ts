/**
 * @file Contains functions for initializing the waifu widget.
 * @module widget
 */

import { ModelManager, Config, ModelList } from './model.js';
import { clearMessage, showMessage, welcomeMessage, Time } from './message.js';
import { randomSelection } from './utils.js';
import { ToolsManager } from './tools.js';
import logger from './logger.js';
import registerDrag from './drag.js';
import { fa_child } from './icons.js';

const WAIFU_DISABLED_KEY = 'waifu-disabled';

export interface Tips {
  /**
   * Default message configuration.
   */
  message: {
    /**
     * Default message array.
     * @type {string[]}
     */
    default: string[];
    /**
     * Console message.
     * @type {string}
     */
    console: string;
    /**
     * Copy message.
     * @type {string}
     */
    copy: string;
    /**
     * Visibility change message.
     * @type {string}
     */
    visibilitychange: string;
    changeSuccess: string;
    changeFail: string;
    photo: string;
    goodbye: string;
    hitokoto: string;
    welcome: string;
    referrer: string;
    hoverBody: string | string[];
    tapBody: string | string[];
  };
  /**
   * Time configuration.
   * @type {Time}
   */
  time: Time;
  /**
   * Mouseover message configuration.
   * @type {Array<{selector: string, text: string | string[]}>}
   */
  mouseover: {
    selector: string;
    text: string | string[];
  }[];
  /**
   * Click message configuration.
   * @type {Array<{selector: string, text: string | string[]}>}
   */
  click: {
    selector: string;
    text: string | string[];
  }[];
  /**
   * Season message configuration.
   * @type {Array<{date: string, text: string | string[]}>}
   */
  seasons: {
    date: string;
    text: string | string[];
  }[];
  models: ModelList[];
}

// Keep the console easter egg on one stable function. Reopening the widget
// must not leave one new console closure retaining every previous tips object.
let activeConsoleTips: Tips | null = null;
const devtools = () => {
  if (activeConsoleTips) showMessage(activeConsoleTips.message.console, 6000, 9);
};
devtools.toString = () => {
  if (activeConsoleTips) showMessage(activeConsoleTips.message.console, 6000, 9);
  return '';
};
console.log('%c', devtools);

/**
 * Register event listeners.
 * @param {Tips} tips - Result configuration.
 */
function registerEventListener(tips: Tips): () => void {
  // Detect user activity and display messages when idle
  let userAction = false;
  let userActionTimer: ReturnType<typeof setInterval> | undefined;
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  const messageArray = [...tips.message.default];
  tips.seasons.forEach(({ date, text }) => {
    const now = new Date(),
      after = date.split('-')[0],
      before = date.split('-')[1] || after;
    if (
      Number(after.split('/')[0]) <= now.getMonth() + 1 &&
      now.getMonth() + 1 <= Number(before.split('/')[0]) &&
      Number(after.split('/')[1]) <= now.getDate() &&
      now.getDate() <= Number(before.split('/')[1])
    ) {
      text = randomSelection(text);
      text = (text as string).replace('{year}', String(now.getFullYear()));
      messageArray.push(text);
    }
  });
  let lastHoverElement: any;
  const markUserAction = () => (userAction = true);
  const checkIdle = () => {
    if (userAction) {
      userAction = false;
      if (userActionTimer) clearInterval(userActionTimer);
      userActionTimer = undefined;
    } else if (!userActionTimer) {
      userActionTimer = setInterval(() => {
        showMessage(messageArray, 6000, 9);
      }, 20000);
    }
  };
  const startIdleTimer = () => {
    if (idleTimer === undefined) idleTimer = setInterval(checkIdle, 1000);
  };
  startIdleTimer();

  const handleMouseOver = (event: MouseEvent) => {
    // eslint-disable-next-line prefer-const
    for (let { selector, text } of tips.mouseover) {
      if (!(event.target as HTMLElement)?.closest(selector)) continue;
      if (lastHoverElement === selector) return;
      lastHoverElement = selector;
      text = randomSelection(text);
      text = (text as string).replace(
        '{text}',
        (event.target as HTMLElement).innerText,
      );
      showMessage(text, 4000, 8);
      return;
    }
  };
  const handleClick = (event: MouseEvent) => {
    // eslint-disable-next-line prefer-const
    for (let { selector, text } of tips.click) {
      if (!(event.target as HTMLElement)?.closest(selector)) continue;
      text = randomSelection(text);
      text = (text as string).replace(
        '{text}',
        (event.target as HTMLElement).innerText,
      );
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
      if (idleTimer) clearInterval(idleTimer);
      idleTimer = undefined;
      if (userActionTimer) clearInterval(userActionTimer);
      userActionTimer = undefined;
    } else {
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
    if (activeConsoleTips === tips) activeConsoleTips = null;
    if (idleTimer) clearInterval(idleTimer);
    if (userActionTimer) clearInterval(userActionTimer);
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

interface WidgetRuntime {
  model: ModelManager;
  dispose: () => void;
}

let activeRuntime: WidgetRuntime | null = null;
let loadingModel: ModelManager | null = null;
let loadPromise: Promise<WidgetRuntime> | null = null;
let visibilityListenerInstalled = false;

async function loadWidgetInternal(config: Config): Promise<WidgetRuntime> {
  localStorage.removeItem('waifu-display');
  sessionStorage.removeItem('waifu-message-priority');
  document.getElementById('waifu')?.remove();
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div id="waifu">
       <div id="waifu-tips"></div>
       <div id="waifu-canvas">
         <canvas id="live2d" width="300" height="300"></canvas>
       </div>
       <div id="waifu-tool"></div>
     </div>`,
  );

  let models: ModelList[] = [];
  let tips: Tips;
  try {
    if (config.waifuData) {
      tips = config.waifuData as Tips;
    } else if (config.waifuPath) {
      const response = await fetch(config.waifuPath);
      if (!response.ok) throw new Error(`Failed to load waifu config (${response.status}).`);
      tips = await response.json() as Tips;
    } else {
      throw new Error('Missing waifuData or waifuPath.');
    }
  } catch (error) {
    document.getElementById('waifu')?.remove();
    throw error;
  }
  models = tips.models;

  let removeEventListeners = () => {};
  let model: ModelManager | undefined;
  try {
    removeEventListeners = registerEventListener(tips);
    showMessage(welcomeMessage(tips.time, tips.message.welcome, tips.message.referrer), 7000, 11);
    model = await ModelManager.initCheck(config, models);
    loadingModel = model;
    const loaded = await model.loadModel('');
    if (!loaded) throw new Error('The initial Live2D model failed to load.');
    loadingModel = null;

    let disposed = false;
    const dragCleanup = config.drag ? registerDrag() : undefined;
    const handlePageHide = (event: PageTransitionEvent) => {
      if (event.persisted) return;
      dispose();
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('pagehide', handlePageHide);
      model.dispose();
      try {
        const canvas = document.getElementById('live2d') as HTMLCanvasElement | null;
        const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
        gl?.getExtension('WEBGL_lose_context')?.loseContext();
      } catch {}
      removeEventListeners();
      dragCleanup?.();
      clearMessage();
      document.getElementById('waifu')?.remove();
      if (activeRuntime?.model === model) activeRuntime = null;
      window.dispatchEvent(new Event('live2d:widget-disposed'));
    };
    const runtime = { model, dispose };
    activeRuntime = runtime;
    window.addEventListener('pagehide', handlePageHide);
    new ToolsManager(model, config, tips, {
      onPause: () => model.pause(),
      onDispose: dispose,
    }).registerTools();
    document.getElementById('waifu')?.classList.add('waifu-active');
    window.dispatchEvent(new Event('live2d:widget-ready'));
    return runtime;
  } catch (error) {
    model?.dispose();
    if (activeRuntime?.model === model) activeRuntime = null;
    loadingModel = null;
    removeEventListeners();
    clearMessage();
    document.getElementById('waifu')?.remove();
    throw error;
  }
}

/**
 * Load the waifu widget once. A disposed instance is recreated on the next
 * toggle click, while concurrent opens share the same in-flight promise.
 */
async function loadWidget(config: Config): Promise<WidgetRuntime> {
  if (activeRuntime) return activeRuntime;
  if (loadPromise) return loadPromise;
  const pending = loadWidgetInternal(config);
  loadPromise = pending;
  try {
    return await pending;
  } finally {
    if (loadPromise === pending) loadPromise = null;
  }
}

/**
 * Initialize the waifu widget.
 * @param {string | Config} config - Waifu configuration or configuration path.
 */
function initWidget(config: string | Config) {
  if (typeof config === 'string') {
    logger.error('Your config for Live2D initWidget is outdated. Please refer to https://github.com/stevenjoezhang/live2d-widget/blob/master/dist/autoload.js');
    return;
  }
  if (localStorage.getItem(WAIFU_DISABLED_KEY) === 'true') {
    return;
  }
  if (visibilityListenerInstalled) return;
  visibilityListenerInstalled = true;
  document.addEventListener('visibilitychange', () => {
    const model = activeRuntime?.model ?? loadingModel;
    if (!model) return;
    if (document.hidden) model.pause();
    else model.resume();
  });
  logger.setLevel(config.logLevel);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div id="waifu-toggle">
       ${fa_child}
     </div>`,
  );
  const toggle = document.getElementById('waifu-toggle');
  toggle?.addEventListener('click', async () => {
    toggle?.classList.remove('waifu-toggle-active');
    const runtime = activeRuntime;
    if (toggle?.getAttribute('first-time') || !runtime || !document.getElementById('waifu')) {
      toggle?.removeAttribute('first-time');
      try {
        const nextRuntime = await loadWidget(config as Config);
        nextRuntime.model.resume();
      } catch (error) {
        logger.error('Failed to reopen Live2D widget.', error);
      }
    } else {
      localStorage.removeItem('waifu-display');
      document.getElementById('waifu')?.classList.remove('waifu-hidden');
      runtime.model.resume();
      setTimeout(() => {
        document.getElementById('waifu')?.classList.add('waifu-active');
      }, 0);
    }
  });
  if (
    localStorage.getItem('waifu-display') &&
    Date.now() - Number(localStorage.getItem('waifu-display')) <= 86400000
  ) {
    toggle?.setAttribute('first-time', 'true');
    setTimeout(() => {
      toggle?.classList.add('waifu-toggle-active');
    }, 0);
  } else {
    void loadWidget(config as Config).catch((error) => {
      logger.error('Failed to load Live2D widget.', error);
    });
  }
}

export { initWidget };
