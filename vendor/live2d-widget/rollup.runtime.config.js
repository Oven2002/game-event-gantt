import terser from '@rollup/plugin-terser';

const normalized = (id) => id.replaceAll('\\', '/');
const runtimeChunk = (id) => {
  const path = normalized(id);
  if (path.endsWith('/build/cubism2/index.js') || id === './cubism2/index.js') {
    return './chunk/index.js';
  }
  if (path.endsWith('/build/cubism5/index.js') || id === './cubism5/index.js') {
    return './chunk/index2.js';
  }
  return undefined;
};

export default {
  input: 'build/waifu-tips.js',
  output: {
    dir: 'dist/',
    format: 'esm',
    entryFileNames: '[name].js',
    chunkFileNames: 'chunk/[name].js',
    minifyInternalExports: false,
    manualChunks: (id) => normalized(id).endsWith('/build/logger.js') ? 'logger' : undefined,
    paths: (id) => runtimeChunk(id) ?? id,
    sourcemap: true,
    banner: `/*!
 * Live2D Widget
 * https://github.com/stevenjoezhang/live2d-widget
 */`,
  },
  external: (id) => runtimeChunk(id) !== undefined,
  plugins: [terser()],
};
