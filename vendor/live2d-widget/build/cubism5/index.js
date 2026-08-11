import { LAppDelegate } from '@demo/lappdelegate.js';
import { LAppSubdelegate } from '@demo/lappsubdelegate.js';
import * as LAppDefine from '@demo/lappdefine.js';
import { LAppModel } from '@demo/lappmodel.js';
import { LAppPal } from '@demo/lapppal';
import logger from '../logger.js';
LAppPal.printMessage = () => { };
function releaseLive2DModels(live2dManager) {
    var _a, _b, _c;
    const models = live2dManager === null || live2dManager === void 0 ? void 0 : live2dManager._models;
    if (!models)
        return;
    for (let index = models.getSize() - 1; index >= 0; index -= 1) {
        try {
            (_b = (_a = models.at(index)) === null || _a === void 0 ? void 0 : _a.release) === null || _b === void 0 ? void 0 : _b.call(_a);
        }
        catch (error) {
            logger.warn('Failed to release a Cubism 5 model.', error);
        }
    }
    (_c = live2dManager.releaseAllModel) === null || _c === void 0 ? void 0 : _c.call(live2dManager);
}
class AppSubdelegate extends LAppSubdelegate {
    initialize(canvas) {
        const context = canvas.getContext('webgl2', {
            premultipliedAlpha: true,
            preserveDrawingBuffer: false
        });
        if (!context) {
            logger.error('Cannot initialize WebGL. This browser does not support.');
            return false;
        }
        this._glManager._gl = context;
        this._canvas = canvas;
        if (LAppDefine.CanvasSize === 'auto') {
            this.resizeCanvas();
        }
        else {
            canvas.width = LAppDefine.CanvasSize.width;
            canvas.height = LAppDefine.CanvasSize.height;
        }
        this._textureManager.setGlManager(this._glManager);
        const gl = this._glManager.getGl();
        if (!this._frameBuffer) {
            this._frameBuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        }
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        this._view.initialize(this);
        this._view._gear = {
            render: () => { },
            isHit: () => { },
            release: () => { }
        };
        this._view._back = {
            render: () => { },
            release: () => { }
        };
        this._live2dManager._subdelegate = this;
        this._resizeObserver = new window.ResizeObserver((entries, observer) => this.resizeObserverCallback.call(this, entries, observer));
        this._resizeObserver.observe(this._canvas);
        return true;
    }
    resizeCanvas() {
        var _a, _b;
        const canvas = this._canvas;
        if (!canvas)
            return;
        const cssWidth = canvas.clientWidth || 300;
        const cssHeight = canvas.clientHeight || cssWidth;
        const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
        canvas.width = Math.max(1, Math.round(cssWidth * ratio));
        canvas.height = Math.max(1, Math.round(cssHeight * ratio));
        const gl = (_b = (_a = this._glManager) === null || _a === void 0 ? void 0 : _a.getGl) === null || _b === void 0 ? void 0 : _b.call(_a);
        gl === null || gl === void 0 ? void 0 : gl.viewport(0, 0, canvas.width, canvas.height);
    }
    onResize() {
        this.resizeCanvas();
        this._view.initialize(this);
    }
    update() {
        if (this._glManager.getGl().isContextLost()) {
            return;
        }
        if (this._needResize) {
            this.onResize();
            this._needResize = false;
        }
        const gl = this._glManager.getGl();
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.clearDepth(1.0);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        this._view.render();
    }
}
export class AppDelegate extends LAppDelegate {
    run() {
        if (this._running)
            return;
        this._running = true;
        const loop = () => {
            if (!this._running)
                return;
            LAppPal.updateTime();
            for (let i = 0; i < this._subdelegates.getSize(); i++) {
                this._subdelegates.at(i).update();
            }
            this._drawFrameId = window.requestAnimationFrame(loop);
        };
        loop();
    }
    stop() {
        this._running = false;
        if (this._drawFrameId != null) {
            window.cancelAnimationFrame(this._drawFrameId);
            this._drawFrameId = null;
        }
    }
    release() {
        var _a;
        this.stop();
        for (let index = this._subdelegates.getSize() - 1; index >= 0; index -= 1) {
            const subdelegate = this._subdelegates.at(index);
            releaseLive2DModels((_a = subdelegate === null || subdelegate === void 0 ? void 0 : subdelegate.getLive2DManager) === null || _a === void 0 ? void 0 : _a.call(subdelegate));
        }
        super.release();
        this._canvases.clear();
    }
    transformOffset(e) {
        const subdelegate = this._subdelegates.at(0);
        const rect = subdelegate.getCanvas().getBoundingClientRect();
        const ratioX = rect.width ? subdelegate.getCanvas().width / rect.width : 1;
        const ratioY = rect.height ? subdelegate.getCanvas().height / rect.height : 1;
        const localX = (e.clientX - rect.left) * ratioX;
        const localY = (e.clientY - rect.top) * ratioY;
        const posX = localX;
        const posY = localY;
        const x = subdelegate._view.transformViewX(posX);
        const y = subdelegate._view.transformViewY(posY);
        return {
            x, y
        };
    }
    onMouseMove(e) {
        const lapplive2dmanager = this._subdelegates.at(0).getLive2DManager();
        const { x, y } = this.transformOffset(e);
        const model = lapplive2dmanager._models.at(0);
        lapplive2dmanager.onDrag(x, y);
        lapplive2dmanager.onTap(x, y);
        if (model.hitTest(LAppDefine.HitAreaNameBody, x, y)) {
            window.dispatchEvent(new Event('live2d:hoverbody'));
        }
    }
    onMouseEnd(e) {
        const lapplive2dmanager = this._subdelegates.at(0).getLive2DManager();
        const { x, y } = this.transformOffset(e);
        lapplive2dmanager.onDrag(0.0, 0.0);
        lapplive2dmanager.onTap(x, y);
    }
    onTap(e) {
        const lapplive2dmanager = this._subdelegates.at(0).getLive2DManager();
        const { x, y } = this.transformOffset(e);
        const model = lapplive2dmanager._models.at(0);
        if (model.hitTest(LAppDefine.HitAreaNameBody, x, y)) {
            window.dispatchEvent(new Event('live2d:tapbody'));
        }
    }
    initializeEventListener() {
        this.mouseMoveEventListener = this.onMouseMove.bind(this);
        this.mouseEndedEventListener = this.onMouseEnd.bind(this);
        this.tapEventListener = this.onTap.bind(this);
        document.addEventListener('mousemove', this.mouseMoveEventListener, {
            passive: true
        });
        document.addEventListener('mouseout', this.mouseEndedEventListener, {
            passive: true
        });
        document.addEventListener('pointerdown', this.tapEventListener, {
            passive: true
        });
    }
    releaseEventListener() {
        document.removeEventListener('mousemove', this.mouseMoveEventListener, {
            passive: true
        });
        this.mouseMoveEventListener = null;
        document.removeEventListener('mouseout', this.mouseEndedEventListener, {
            passive: true
        });
        this.mouseEndedEventListener = null;
        document.removeEventListener('pointerdown', this.tapEventListener, {
            passive: true
        });
    }
    initializeSubdelegates() {
        this._canvases.prepareCapacity(LAppDefine.CanvasNum);
        this._subdelegates.prepareCapacity(LAppDefine.CanvasNum);
        const canvas = document.getElementById('live2d');
        this._canvases.pushBack(canvas);
        canvas.style.width = canvas.width;
        canvas.style.height = canvas.height;
        for (let i = 0; i < this._canvases.getSize(); i++) {
            const subdelegate = new AppSubdelegate();
            const result = subdelegate.initialize(this._canvases.at(i));
            if (!result) {
                logger.error('Failed to initialize AppSubdelegate');
                return;
            }
            this._subdelegates.pushBack(subdelegate);
        }
        for (let i = 0; i < LAppDefine.CanvasNum; i++) {
            if (this._subdelegates.at(i).isContextLost()) {
                logger.error(`The context for Canvas at index ${i} was lost, possibly because the acquisition limit for WebGLRenderingContext was reached.`);
            }
        }
    }
    changeModel(modelSettingPath) {
        const segments = modelSettingPath.split('/');
        const modelJsonName = segments.pop();
        const modelPath = segments.join('/') + '/';
        const live2dManager = this._subdelegates.at(0).getLive2DManager();
        releaseLive2DModels(live2dManager);
        const instance = new LAppModel();
        instance.setSubdelegate(live2dManager._subdelegate);
        instance.loadAssets(modelPath, modelJsonName);
        live2dManager._models.pushBack(instance);
    }
    get subdelegates() {
        return this._subdelegates;
    }
}
