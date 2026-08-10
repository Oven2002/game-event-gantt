/*!
 * Live2D Widget
 * https://github.com/stevenjoezhang/live2d-widget
 */
class e{constructor(e="info"){this.level=e}setLevel(e){e&&(this.level=e)}shouldLog(o){return e.levelOrder[o]<=e.levelOrder[this.level]}error(e,...o){this.shouldLog("error")&&console.error("[Live2D Widget][ERROR]",e,...o)}warn(e,...o){this.shouldLog("warn")&&console.warn("[Live2D Widget][WARN]",e,...o)}info(e,...o){this.shouldLog("info")&&console.log("[Live2D Widget][INFO]",e,...o)}trace(e,...o){this.shouldLog("trace")&&console.log("[Live2D Widget][TRACE]",e,...o)}}e.levelOrder={error:0,warn:1,info:2,trace:3};const o=new e;export{o as logger};
//# sourceMappingURL=logger.js.map
