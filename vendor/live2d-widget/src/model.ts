/**
 * @file Contains classes related to waifu model loading and management.
 * @module model
 */

import { showMessage } from './message.js';
import { loadExternalResource, randomOtherOption } from './utils.js';
import type Cubism2Model from './cubism2/index.js';
import logger, { LogLevel } from './logger.js';

interface ModelListCDN {
  messages: string[];
  models: string | string[];
}

interface ModelList {
  name: string;
  paths: string[];
  message: string;
}

interface Config {
  /**
   * Path to the waifu configuration file.
   * @type {string}
   */
  waifuPath?: string;
  /**
   * In-memory waifu configuration. This avoids creating a Blob URL for
   * dynamically adjusted messages and model paths.
   */
  waifuData?: unknown;
  /**
   * Path to the API, if you need to load models via API.
   * @type {string | undefined}
   */
  apiPath?: string;
  /**
   * Path to the CDN, if you need to load models via CDN.
   * @type {string | undefined}
   */
  cdnPath?: string;
  /**
   * Path to Cubism 2 Core, if you need to load Cubism 2 models.
   * @type {string | undefined}
   */
  cubism2Path?: string;
  /**
   * Path to Cubism 5 Core, if you need to load Cubism 3 and later models.
   * @type {string | undefined}
   */
  cubism5Path?: string;
  /**
   * Default model id.
   * @type {string | undefined}
   */
  modelId?: number;
  /**
   * List of tools to display.
   * @type {string[] | undefined}
   */
  tools?: string[];
  /**
   * Support for dragging the waifu.
   * @type {boolean | undefined}
   */
  drag?: boolean;
  /**
   * Whether to show the toggle button after quitting the widget.
   * If false, quitting permanently disables the widget until localStorage is cleared.
   * @type {boolean | undefined}
   */
  showToggleAfterQuit?: boolean;
  /**
   * Log level.
   * @type {LogLevel | undefined}
   */
  logLevel?: LogLevel;
}

/**
 * Waifu model class, responsible for loading and managing models.
 */
class ModelManager {
  public readonly useCDN: boolean;
  private readonly cdnPath: string;
  private readonly cubism2Path: string;
  private readonly cubism5Path: string;
  private _modelId: number;
  private _modelTexturesId: number;
  private modelList: ModelListCDN | null = null;
  private cubism2model: Cubism2Model | undefined;
  private cubism5model: any;
  private currentCubism5ModelPath: string | undefined;
  private currentModelVersion: number;
  private loading: boolean;
  private modelSwitchQueue: Promise<void>;
  private modelJSONCache: Record<string, any>;
  private models: ModelList[];
  private lifecycleToken: number;
  private pendingDispose: boolean;
  private disposed: boolean;
  private paused: boolean;

  /**
   * Create a Model instance.
   * @param {Config} config - Configuration options
   */
  private constructor(config: Config, models: ModelList[] = []) {
    let { apiPath, cdnPath } = config;
    const { cubism2Path, cubism5Path } = config;
    let useCDN = false;
    if (typeof cdnPath === 'string') {
      if (!cdnPath.endsWith('/')) cdnPath += '/';
      useCDN = true;
    } else if (typeof apiPath === 'string') {
      if (!apiPath.endsWith('/')) apiPath += '/';
      cdnPath = apiPath;
      useCDN = true;
      logger.warn('apiPath option is deprecated. Please use cdnPath instead.');
    } else if (!models.length) {
      throw 'Invalid initWidget argument!';
    }
    let modelId: number = parseInt(localStorage.getItem('modelId') as string, 10);
    let modelTexturesId: number = parseInt(
      localStorage.getItem('modelTexturesId') as string, 10
    );
    if (isNaN(modelId) || isNaN(modelTexturesId)) {
      modelTexturesId = 0;
    }
    if (isNaN(modelId)) {
      modelId = config.modelId ?? 0;
    }
    this.useCDN = useCDN;
    this.cdnPath = cdnPath || '';
    this.cubism2Path = cubism2Path || '';
    this.cubism5Path = cubism5Path || '';
    this._modelId = modelId;
    this._modelTexturesId = modelTexturesId;
    this.currentModelVersion = 0;
    this.loading = false;
    this.modelSwitchQueue = Promise.resolve();
    this.modelJSONCache = {};
    this.models = models;
    this.lifecycleToken = 0;
    this.pendingDispose = false;
    this.disposed = false;
    this.paused = false;
  }

  public static async initCheck(config: Config, models: ModelList[] = []) {
    const model = new ModelManager(config, models);
    if (model.useCDN) {
      const response = await fetch(`${model.cdnPath}model_list.json`);
      model.modelList = await response.json();
      if (model.modelId >= model.modelList.models.length) {
        model.modelId = 0;
      }
      const modelName = model.modelList.models[model.modelId];
      if (Array.isArray(modelName)) {
        if (model.modelTexturesId >= modelName.length) {
          model.modelTexturesId = 0;
        }
      } else {
        const modelSettingPath = `${model.cdnPath}model/${modelName}/index.json`;
        const modelSetting = await model.fetchWithCache(modelSettingPath);
        const version = model.checkModelVersion(modelSetting);
        if (version === 2) {
          const textureCache = await model.loadTextureCache(modelName);
          if (model.modelTexturesId >= textureCache.length) {
            model.modelTexturesId = 0;
          }
        }
      }
    } else {
      if (model.modelId >= model.models.length) {
        model.modelId = 0;
      }
      if (model.modelTexturesId >= model.models[model.modelId].paths.length) {
        model.modelTexturesId = 0;
      }
    }
    return model;
  }

  public set modelId(modelId: number) {
    this._modelId = modelId;
    localStorage.setItem('modelId', modelId.toString());
  }

  public get modelId() {
    return this._modelId;
  }

  public set modelTexturesId(modelTexturesId: number) {
    this._modelTexturesId = modelTexturesId;
    localStorage.setItem('modelTexturesId', modelTexturesId.toString());
  }

  public get modelTexturesId() {
    return this._modelTexturesId;
  }

  resetCanvas() {
    document.getElementById('waifu-canvas').innerHTML = '<canvas id="live2d" width="300" height="300"></canvas>';
  }

  private releaseRuntime(): void {
    this.lifecycleToken += 1;
    this.pendingDispose = false;
    this.paused = false;

    if (this.cubism5model) {
      try {
        this.cubism5model.release?.();
      } catch (error) {
        logger.warn('Failed to release Cubism 5 runtime.', error);
      }
      this.cubism5model = undefined;
    }
    if (this.cubism2model) {
      try {
        this.cubism2model.destroy?.();
      } catch (error) {
        logger.warn('Failed to release Cubism 2 runtime.', error);
      }
      this.cubism2model = undefined;
    }
    this.currentCubism5ModelPath = undefined;
    this.currentModelVersion = 0;
  }

  pause(): void {
    this.paused = true;
    this.cubism5model?.stop?.();
    this.cubism2model?.pauseDraw?.();
  }

  resume(): void {
    if (this.disposed) return;
    this.paused = false;
    if (document.hidden) return;
    if (this.cubism5model) this.cubism5model.run?.();
    else this.cubism2model?.resumeDraw?.();
  }

  dispose(): void {
    this.disposed = true;
    this.lifecycleToken += 1;
    this.pause();
    if (this.loading) {
      this.pendingDispose = true;
      return;
    }
    this.releaseRuntime();
  }

  async fetchWithCache(url: string) {
    if (url in this.modelJSONCache) {
      return this.modelJSONCache[url];
    }
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Request failed with status ${response.status}.`);
      const result = await response.json();
      this.modelJSONCache[url] = result;
      return result;
    } catch {
      return null;
    }
  }

  checkModelVersion(modelSetting: any) {
    if (modelSetting.Version === 3 || modelSetting.FileReferences) {
      return 3;
    }
    return 2;
  }

  async waitForCubism5ModelReady(token: number, timeoutMs = 30000): Promise<void> {
    const live2dManager = this.cubism5model?.subdelegates.at(0)?.getLive2DManager();
    const model = live2dManager?._models?.at(0);
    if (!model) throw new Error('Cubism 5 model was not created.');
    await new Promise<void>((resolve, reject) => {
      let visibleElapsed = 0;
      let visibleStartedAt = document.hidden ? null : performance.now();
      let checkTimer: ReturnType<typeof setTimeout> | undefined;

      const getVisibleElapsed = () => visibleElapsed + (
        visibleStartedAt === null ? 0 : performance.now() - visibleStartedAt
      );
      const handleVisibilityChange = () => {
        const now = performance.now();
        if (document.hidden) {
          if (visibleStartedAt !== null) visibleElapsed += now - visibleStartedAt;
          visibleStartedAt = null;
        } else if (visibleStartedAt === null) {
          visibleStartedAt = now;
        }
      };
      const cleanup = () => {
        if (checkTimer !== undefined) clearTimeout(checkTimer);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      };
      const checkReady = () => {
        // LoadStep.CompleteSetup in the bundled Cubism SDK.
        if (token !== this.lifecycleToken || this.disposed) {
          cleanup();
          reject(new Error('Cubism 5 model load was cancelled.'));
        } else if (model._state === 22) {
          cleanup();
          resolve();
        } else if (getVisibleElapsed() >= timeoutMs) {
          cleanup();
          reject(new Error('Timed out while loading Cubism 5 model.'));
        } else {
          // Poll less often while the tab is backgrounded; loading time is
          // measured only while visible, so this does not shorten the budget.
          checkTimer = setTimeout(checkReady, document.hidden ? 250 : 16);
        }
      };
      document.addEventListener('visibilitychange', handleVisibilityChange);
      checkReady();
    });
  }

  configureCubism5InputHandlers(): void {
    const delegate = this.cubism5model;
    delegate.onMouseMove = (event: MouseEvent) => {
      const live2dManager = delegate.subdelegates.at(0)?.getLive2DManager();
      const model = live2dManager?._models?.at(0);
      if (!model || model._state !== 22) return;
      const { x, y } = delegate.transformOffset(event);
      live2dManager.onDrag(x, y);
      if (model.hitTest('Body', x, y)) {
        window.dispatchEvent(new Event('live2d:hoverbody'));
      }
    };
    delegate.onMouseEnd = () => {
      delegate.subdelegates.at(0)?.getLive2DManager()?.onDrag(0, 0);
    };
    delegate.onTap = (event: PointerEvent) => {
      const live2dManager = delegate.subdelegates.at(0)?.getLive2DManager();
      const model = live2dManager?._models?.at(0);
      if (!model || model._state !== 22) return;
      const { x, y } = delegate.transformOffset(event);
      live2dManager.onTap(x, y);
      if (model.hitTest('Body', x, y)) {
        window.dispatchEvent(new Event('live2d:tapbody'));
      }
    };
  }

  async loadLive2D(modelSettingPath: string, modelSetting: object): Promise<boolean> {
    if (this.loading || this.disposed) {
      logger.warn('Still loading. Abort.');
      return false;
    }
    this.loading = true;
    const token = this.lifecycleToken;
    let changedCubism5Model = false;
    const previousCubism5ModelPath = this.currentCubism5ModelPath;
    try {
      const version = this.checkModelVersion(modelSetting);
      if (version === 2) {
        if (!this.cubism2model) {
          if (!this.cubism2Path) {
            logger.error('No cubism2Path set, cannot load Cubism 2 Core.')
            return false;
          }
          await loadExternalResource(this.cubism2Path, 'js');
          if (token !== this.lifecycleToken || this.disposed) return false;
          const { default: Cubism2Model } = await import('./cubism2/index.js');
          this.cubism2model = new Cubism2Model();
        }
        if (this.currentModelVersion === 3) {
          this.cubism5model?.release?.();
          this.cubism5model = undefined;
          this.currentCubism5ModelPath = undefined;
          // Recycle WebGL resources
          this.resetCanvas();
        }
        if (this.currentModelVersion === 3 || !this.cubism2model.gl) {
          await this.cubism2model.init('live2d', modelSettingPath, modelSetting);
        } else {
          const changed = await (this.cubism2model.changeModelWithJSON(modelSettingPath, modelSetting) as unknown as Promise<boolean>);
          if (changed === false) return false;
        }
        if (token !== this.lifecycleToken || this.disposed) return false;
        if (this.paused || document.hidden) this.cubism2model.pauseDraw?.();
      } else {
        if (!this.cubism5Path) {
          logger.error('No cubism5Path set, cannot load Cubism 5 Core.')
          return false;
        }
        if (this.currentModelVersion === 2) {
          this.cubism2model?.destroy?.();
          this.cubism2model = undefined;
          // Recycle WebGL resources
          this.resetCanvas();
        }
        if (!this.cubism5model) {
          await loadExternalResource(this.cubism5Path, 'js');
          if (token !== this.lifecycleToken || this.disposed) return false;
          const { AppDelegate: Cubism5Model } = await import('./cubism5/index.js');
          this.cubism5model = new (Cubism5Model as any)();
          this.configureCubism5InputHandlers();
        }
        if (this.currentModelVersion === 2 || !this.cubism5model.subdelegates.at(0)) {
          this.cubism5model.initialize();
          this.cubism5model.changeModel(modelSettingPath);
          changedCubism5Model = true;
          if (!this.paused && !document.hidden) this.cubism5model.run();
        } else {
          this.cubism5model.changeModel(modelSettingPath);
          changedCubism5Model = true;
        }
        await this.waitForCubism5ModelReady(token);
        if (token !== this.lifecycleToken || this.disposed) return false;
        this.currentCubism5ModelPath = modelSettingPath;
      }
      if (!this.paused && !document.hidden) {
        if (this.cubism5model) this.cubism5model.run?.();
        else this.cubism2model?.resumeDraw?.();
      }
      logger.info(`Model ${modelSettingPath} (Cubism version ${version}) loaded`);
      this.currentModelVersion = version;
      return true;
    } catch (err) {
      if (token === this.lifecycleToken && !this.disposed && changedCubism5Model && previousCubism5ModelPath && this.cubism5model) {
        try {
          this.cubism5model.changeModel(previousCubism5ModelPath);
        } catch (rollbackError) {
          logger.error('Failed to restore the previous Cubism 5 model.', rollbackError);
        }
      }
      console.error('loadLive2D failed', err);
      return false;
    } finally {
      this.loading = false;
      if (this.pendingDispose) this.releaseRuntime();
    }
  }

  async loadTextureCache(modelName: string): Promise<any[]> {
    const textureCache = await this.fetchWithCache(`${this.cdnPath}model/${modelName}/textures.cache`);
    return textureCache || [];
  }

  /**
   * Load the specified model.
   * @param {string | string[]} message - Loading message.
   */
  async loadModel(
    message: string | string[],
    modelId = this.modelId,
    modelTexturesId = this.modelTexturesId
  ): Promise<boolean> {
    if (this.disposed) return false;
    let modelSettingPath, modelSetting;
    if (this.useCDN) {
      let modelName = this.modelList.models[modelId];
      if (Array.isArray(modelName)) {
        modelName = modelName[modelTexturesId];
      }
      modelSettingPath = `${this.cdnPath}model/${modelName}/index.json`;
      modelSetting = await this.fetchWithCache(modelSettingPath);
      const version = this.checkModelVersion(modelSetting);
      if (version === 2) {
        const textureCache = await this.loadTextureCache(modelName);
        // this.loadTextureCache may return an empty array
        if (textureCache.length > 0) {
          let textures = textureCache[modelTexturesId];
          if (typeof textures === 'string') textures = [textures];
          modelSetting.textures = textures;
        }
      }
    } else {
      modelSettingPath = this.models[modelId].paths[modelTexturesId];
      modelSetting = await this.fetchWithCache(modelSettingPath);
    }
    const loaded = await this.loadLive2D(modelSettingPath, modelSetting);
    if (loaded) showMessage(message, 4000, 10);
    return loaded;
  }

  /**
   * Load a random texture for the current model.
   */
  async loadRandTexture(successMessage: string | string[] = '', failMessage: string | string[] = '') {
    if (this.disposed || this.paused) return;
    const { modelId } = this;
    let noTextureAvailable = false;
    if (this.useCDN) {
      const modelName = this.modelList.models[modelId];
      if (Array.isArray(modelName)) {
        this.modelTexturesId = randomOtherOption(modelName.length, this.modelTexturesId);
      } else {
        const modelSettingPath = `${this.cdnPath}model/${modelName}/index.json`;
        const modelSetting = await this.fetchWithCache(modelSettingPath);
        const version = this.checkModelVersion(modelSetting);
        if (version === 2) {
          const textureCache = await this.loadTextureCache(modelName);
          if (textureCache.length <= 1) {
            noTextureAvailable = true;
          } else {
            this.modelTexturesId = randomOtherOption(textureCache.length, this.modelTexturesId);
          }
        } else {
          noTextureAvailable = true;
        }
      }
    } else {
      if (this.models[modelId].paths.length === 1) {
        noTextureAvailable = true;
      } else {
        this.modelTexturesId = randomOtherOption(this.models[modelId].paths.length, this.modelTexturesId);
      }
    }
    if (noTextureAvailable) {
      showMessage(failMessage, 4000, 10);
    } else {
      await this.loadModel(successMessage);
    }
  }

  /**
   * Load the next character's model.
   */
  loadNextModel(): Promise<void> {
    const switchModel = async () => {
      if (this.disposed || this.paused) return;
      const modelCount = this.useCDN ? this.modelList.models.length : this.models.length;
      const nextModelId = (this.modelId + 1) % modelCount;
      const message = this.useCDN
        ? this.modelList.messages[nextModelId]
        : this.models[nextModelId].message;
      const loaded = await this.loadModel(message, nextModelId, 0);
      if (loaded) {
        this.modelTexturesId = 0;
        this.modelId = nextModelId;
      }
    };
    const queuedSwitch = this.modelSwitchQueue.then(switchModel);
    this.modelSwitchQueue = queuedSwitch.catch((error) => {
      logger.error('Failed to switch model.', error);
    });
    return queuedSwitch;
  }
}

export { ModelManager, Config, ModelList };
