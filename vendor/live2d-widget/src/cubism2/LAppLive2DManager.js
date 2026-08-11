/* global Live2D */
import { Live2DFramework } from './Live2DFramework.js';
import LAppModel from './LAppModel.js';
import PlatformManager from './PlatformManager.js';
import LAppDefine from './LAppDefine.js';
import logger from '../logger.js';

class LAppLive2DManager {
  constructor() {
    this.model = null;
    this.gl = null;
    this.reloading = false;
    this.loadToken = 0;

    Live2D.init();
    Live2DFramework.setPlatformManager(new PlatformManager());
  }

  getModel() {
    return this.model;
  }

  releaseModel(gl) {
    this.loadToken += 1;
    if (this.model) {
      this.model.release(gl);
      this.model = null;
    }
  }

  release() {
    this.loadToken += 1;
    if (this.model && this.gl) this.model.release(this.gl);
    this.model = null;
    this.gl = null;
    this.reloading = false;
  }

  async changeModel(gl, modelSettingPath) {
    this.gl = gl;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    return new Promise((resolve, reject) => {
      if (this.reloading) {
        resolve(false);
        return;
      }
      this.reloading = true;
      const token = ++this.loadToken;

      const oldModel = this.model;
      const newModel = new LAppModel();

      newModel.load(gl, modelSettingPath, () => {
        if (token !== this.loadToken) {
          try {
            newModel.release(gl);
          } catch (error) {
            logger.warn('Failed to release a cancelled Cubism 2 model.', error);
          }
          resolve(false);
          return;
        }
        if (oldModel) {
          oldModel.release(gl);
        }
        this.model = newModel;
        this.reloading = false;
        resolve(true);
      });
    });
  }

  async changeModelWithJSON(gl, modelSettingPath, modelSetting) {
    this.gl = gl;
    if (this.reloading) return false;
    this.reloading = true;
    const token = ++this.loadToken;

    const oldModel = this.model;
    const newModel = new LAppModel();

    try {
      await newModel.loadModelSetting(modelSettingPath, modelSetting);
      if (token !== this.loadToken) {
        try {
          newModel.release(gl);
        } catch (error) {
          logger.warn('Failed to release a cancelled Cubism 2 model.', error);
        }
        return false;
      }
      if (oldModel) {
        oldModel.release(gl);
      }
      this.model = newModel;
      return true;
    } finally {
      if (token === this.loadToken) this.reloading = false;
    }
  }

  setDrag(x, y) {
    if (this.model) {
      this.model.setDrag(x, y);
    }
  }

  maxScaleEvent() {
    logger.trace('Max scale event.');
    if (this.model) {
      this.model.startRandomMotion(
        LAppDefine.MOTION_GROUP_PINCH_IN,
        LAppDefine.PRIORITY_NORMAL,
      );
    }
  }

  minScaleEvent() {
    logger.trace('Min scale event.');
    if (this.model) {
      this.model.startRandomMotion(
        LAppDefine.MOTION_GROUP_PINCH_OUT,
        LAppDefine.PRIORITY_NORMAL,
      );
    }
  }

  tapEvent(x, y) {
    logger.trace('tapEvent view x:' + x + ' y:' + y);

    if (!this.model) return false;

    if (this.model.hitTest(LAppDefine.HIT_AREA_HEAD, x, y)) {
      logger.trace('Tap face.');
      this.model.setRandomExpression();
    } else if (this.model.hitTest(LAppDefine.HIT_AREA_BODY, x, y)) {
      logger.trace('Tap body.');
      this.model.startRandomMotion(
        LAppDefine.MOTION_GROUP_TAP_BODY,
        LAppDefine.PRIORITY_NORMAL,
      );
    }
    return true;
  }
}

export default LAppLive2DManager;
