import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// public/ 下不再保留 .map（见 build-live2d.mjs）；本地 vendor 构建产物仍保留 .map，
// 让补丁同步写入 sourcesContent，调试器视图与运行时一致。
const targets = [
  path.join(root, "public/vendor/live2d-widget/dist/chunk/index.js"),
  path.join(root, "public/vendor/live2d-widget/dist/chunk/index2.js"),
  path.join(root, "vendor/live2d-widget/dist/chunk/index.js"),
  path.join(root, "vendor/live2d-widget/dist/chunk/index.js.map"),
  path.join(root, "vendor/live2d-widget/dist/chunk/index2.js"),
  path.join(root, "vendor/live2d-widget/dist/chunk/index2.js.map"),
].filter(existsSync);

// The full Cubism SDK is intentionally not checked into this repository, so
// Rollup treats the prebuilt Cubism chunks as external. Keep the custom
// lifecycle patches here in sync with the Cubism 2/5 source implementations.
const customDelegate = String.raw`function ws(i){const s=i?._models;if(!s)return;for(let e=s.getSize()-1;e>=0;e-=1)try{s.at(e)?.release?.()}catch(s){t.warn("Failed to release a Cubism 5 model.",s)}i.releaseAllModel?.()}vs.prototype.resizeCanvas=function(){const i=this._canvas;if(!i)return;const s=i.clientWidth||300,e=i.clientHeight||s,o=Math.min(window.devicePixelRatio||1,1.5);i.width=Math.max(1,Math.round(s*o)),i.height=Math.max(1,Math.round(e*o));const n=this._glManager?.getGl?.();n?.viewport(0,0,i.width,i.height)};class bs extends Ms{run(){if(this._running)return;this._running=!0;const i=()=>{if(!this._running)return;at.updateTime();for(let s=0;s<this._subdelegates.getSize();s++)this._subdelegates.at(s).update();this._drawFrameId=window.requestAnimationFrame(i)};i()}stop(){this._running=!1,this._drawFrameId!=null&&(window.cancelAnimationFrame(this._drawFrameId),this._drawFrameId=null)}release(){this.stop();for(let i=this._subdelegates.getSize()-1;i>=0;i-=1)ws(this._subdelegates.at(i)?.getLive2DManager?.());super.release(),this._canvases.clear()}transformOffset(i){const s=this._subdelegates.at(0),e=s.getCanvas(),o=e.getBoundingClientRect(),n=o.width?e.width/o.width:1,r=o.height?e.height/o.height:1,a=(i.clientX-o.left)*n,l=(i.clientY-o.top)*r;return{x:s._view.transformViewX(a),y:s._view.transformViewY(l)}}onMouseMove(i){const s=this._subdelegates.at(0)?.getLive2DManager?.(),e=s?._models?.at(0);if(!s||!e)return;const{x:o,y:n}=this.transformOffset(i);s.onDrag(o,n),s.onTap(o,n),e.hitTest("Body",o,n)&&window.dispatchEvent(new Event("live2d:hoverbody"))}onMouseEnd(i){const s=this._subdelegates.at(0)?.getLive2DManager?.();if(!s)return;const{x:e,y:o}=this.transformOffset(i);s.onDrag(0,0),s.onTap(e,o)}onTap(i){const s=this._subdelegates.at(0)?.getLive2DManager?.(),e=s?._models?.at(0);if(!s||!e)return;const{x:o,y:n}=this.transformOffset(i);e.hitTest("Body",o,n)&&window.dispatchEvent(new Event("live2d:tapbody"))}initializeEventListener(){this.mouseMoveEventListener=this.onMouseMove.bind(this),this.mouseEndedEventListener=this.onMouseEnd.bind(this),this.tapEventListener=this.onTap.bind(this),document.addEventListener("mousemove",this.mouseMoveEventListener,{passive:!0}),document.addEventListener("mouseout",this.mouseEndedEventListener,{passive:!0}),document.addEventListener("pointerdown",this.tapEventListener,{passive:!0})}releaseEventListener(){document.removeEventListener("mousemove",this.mouseMoveEventListener,{passive:!0}),this.mouseMoveEventListener=null,document.removeEventListener("mouseout",this.mouseEndedEventListener,{passive:!0}),this.mouseEndedEventListener=null,document.removeEventListener("pointerdown",this.tapEventListener,{passive:!0}),this.tapEventListener=null}initializeSubdelegates(){this._canvases.prepareCapacity(1),this._subdelegates.prepareCapacity(1);const i=document.getElementById("live2d");this._canvases.pushBack(i),i.style.width=i.width,i.style.height=i.height;for(let s=0;s<this._canvases.getSize();s++){const e=new vs;if(!e.initialize(this._canvases.at(s)))return void t.error("Failed to initialize AppSubdelegate");this._subdelegates.pushBack(e)}for(let s=0;s<1;s++)this._subdelegates.at(s).isContextLost()&&t.error("The context for Canvas at index "+s+" was lost, possibly because the acquisition limit for WebGLRenderingContext was reached.")}changeModel(i){const s=i.split("/"),e=s.pop(),o=s.join("/")+"/",n=this._subdelegates.at(0).getLive2DManager();ws(n);const r=new gs;r.setSubdelegate(n._subdelegate),r.loadAssets(o,e),n._models.pushBack(r)}get subdelegates(){return this._subdelegates}}export{bs as AppDelegate};`;

const customCubism2Manager = String.raw`class Y{constructor(){this.model=null,this.gl=null,this.reloading=!1,this.loadToken=0,Live2D.init(),M.setPlatformManager(new X)}getModel(){return this.model}release(){this.loadToken+=1;try{this.model&&this.gl&&this.model.release(this.gl)}catch{}this.model=null,this.gl=null,this.reloading=!1}releaseModel(t){this.loadToken+=1,this.model&&(this.model.release(t),this.model=null)}async changeModel(t,e){this.gl=t;return new Promise(i=>{if(this.reloading)return void i(!1);this.reloading=!0;const s=this.model,n=new U,a=++this.loadToken;n.load(t,e,()=>{if(a!==this.loadToken){try{n.release(t)}catch{}return void i(!1)}s&&s.release(t),this.model=n,this.reloading=!1,i(!0)})})}async changeModelWithJSON(t,e,i){this.gl=t;if(this.reloading)return!1;this.reloading=!0;const s=this.model,n=new U,a=++this.loadToken;try{if(await n.loadModelSetting(e,i),a!==this.loadToken){try{n.release(t)}catch{}return!1}s&&s.release(t),this.model=n;return!0}finally{a===this.loadToken&&(this.reloading=!1)}}setDrag(t,e){this.model&&this.model.setDrag(t,e)}maxScaleEvent(){t.trace("Max scale event."),this.model&&this.model.startRandomMotion(O,f)}minScaleEvent(){t.trace("Min scale event."),this.model&&this.model.startRandomMotion(D,f)}tapEvent(e,i){return t.trace("tapEvent view x:"+e+" y:"+i),!!this.model&&(this.model.hitTest(L,e,i)?(t.trace("Tap face."),this.model.setRandomExpression()):this.model.hitTest(N,e,i)&&(t.trace("Tap body."),this.model.startRandomMotion(R,f)),!0)}}`;

for (const target of targets) {
  let source = readFileSync(target, "utf8");
  source = source.replaceAll("preserveDrawingBuffer:!0", "preserveDrawingBuffer:!1");
  source = source.replaceAll("preserveDrawingBuffer: true", "preserveDrawingBuffer: false");
  // Drop the default MSAA framebuffer: lighter GPU teardown on tab close and
  // cheaper per-frame rendering on weak iGPUs. Idempotent -- the patterns no
  // longer match once `antialias:!1` is present, so re-running is safe.
  source = source.replaceAll(
    'getContext("webgl2",{premultipliedAlpha:!0,preserveDrawingBuffer:!1})',
    'getContext("webgl2",{antialias:!1,premultipliedAlpha:!0,preserveDrawingBuffer:!1})',
  );
  source = source.replaceAll(
    'getContext("webgl2")',
    'getContext("webgl2",{antialias:!1,premultipliedAlpha:!0,preserveDrawingBuffer:!1})',
  );
  // Mirror the patch into the sourcemaps' embedded sourcesContent so debugger
  // views stay consistent with the runtime context attributes. Only the
  // attribute-bearing forms are patched; the no-arg GlManager lookup keeps its
  // original source text. (In the JSON-encoded .map text, `\n` is two chars.)
  source = source.replaceAll(
    `getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: false })`,
    `getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false })`,
  );
  source = source.replaceAll(
    `getContext('webgl2', {\\n            premultipliedAlpha: true,\\n            preserveDrawingBuffer: false\\n        })`,
    `getContext('webgl2', {\\n            antialias: false,\\n            premultipliedAlpha: true,\\n            preserveDrawingBuffer: false\\n        })`,
  );
  if (target.endsWith(".map")) {
    writeFileSync(target, source);
    continue;
  }
  if (!target.endsWith("index2.js")) {
    if (target.endsWith("index.js")) {
      // The Cubism 2 chunk is external for the same reason as Cubism 5. Keep
      // its manager and draw loop lifecycle-safe in the checked-in runtime.
      const managerStart = source.indexOf("class Y{");
      const managerEnd = source.indexOf("class G{", managerStart);
      if (managerStart < 0 || managerEnd < 0) {
        throw new Error(`Unable to locate the Cubism 2 manager in ${target}`);
      }
      source = `${source.slice(0, managerStart)}${customCubism2Manager}${source.slice(managerEnd)}`;
      source = source
        .replace(
          "release(t){const e=M.getPlatformManager();t.deleteTexture(e.texture)}",
          "release(t){this.live2DModel?.deleteTextures?.();const e=M.getPlatformManager();e.texture&&t.deleteTexture(e.texture),this.live2DModel=null,this.modelSetting=null}"
        )
        .replace(
          "class G{constructor(){this.live2DMgr=new Y,this.isDrawStart=!1,this.gl=null",
          "class G{constructor(){this.live2DMgr=new Y,this.isDrawStart=!1,this._drawFrameId=null,this.gl=null"
        )
        .replace(
          "this._drawFrameId&&(window.cancelAnimationFrame(this._drawFrameId),this._drawFrameId=null),this.isDrawStart=!1",
          "this.pauseDraw()"
        )
        .replace(
          "startDraw(){if(!this.isDrawStart){this.isDrawStart=!0;const t=()=>{this.draw(),this._drawFrameId=window.requestAnimationFrame(t,this.canvas)};t()}}draw(){w.reset()",
          "startDraw(){if(!this.isDrawStart){this.isDrawStart=!0;const t=()=>{if(!this.isDrawStart)return;this.draw(),this._drawFrameId=window.requestAnimationFrame(t,this.canvas)};t()}}pauseDraw(){this.isDrawStart=!1,this._drawFrameId!=null&&(window.cancelAnimationFrame(this._drawFrameId),this._drawFrameId=null)}resumeDraw(){this.canvas&&this.gl&&this.startDraw()}draw(){if(!this.isDrawStart||!this.gl||!this.canvas||!this.dragMgr||!this.live2DMgr)return;w.reset()"
        );
    }
    writeFileSync(target, source);
    continue;
  }
  const start = source.indexOf("class bs extends Ms{");
  const exportMarker = "}export{bs as AppDelegate};";
  const end = source.indexOf(exportMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`Unable to locate the Cubism delegate in ${target}`);
  }
  // Remove a previously injected helper/prototype block so this script is
  // safe to run repeatedly (for example, during local builds and CI).
  const helperStart = source.indexOf("function ws(");
  const prefixEnd = helperStart >= 0 && helperStart < start ? helperStart : start;
  source = `${source.slice(0, prefixEnd)}${customDelegate}${source.slice(end + exportMarker.length)}`;
  writeFileSync(target, source);
}

// 硬校验：本脚本依赖压缩产物的内部结构（压缩器生成的类名、导出标记等），
// 任何 replaceAll 静默失配都必须在构建期暴露，而不是等运行时才发现。
const jsTargets = targets.filter((target) => target.endsWith(".js"));
for (const target of jsTargets) {
  const source = readFileSync(target, "utf8");
  const invariants = target.endsWith("index2.js")
    ? ["function ws(", "antialias:!1", "preserveDrawingBuffer:!1"]
    : ["pauseDraw(){", "getModel(){return this.model}release(){", "antialias:!1", "preserveDrawingBuffer:!1"];
  for (const invariant of invariants) {
    if (!source.includes(invariant)) {
      throw new Error(
        `补丁校验失败：${target} 中找不到「${invariant}」。` +
        "上游 live2d-widget 的压缩产物可能已更新（变量名或导出顺序变化），" +
        "请同步维护本脚本中的补丁片段与 tests/data.test.ts 中的对应断言。",
      );
    }
  }
}

console.log(`Patched ${jsTargets.length} Live2D runtime chunk(s).`);
