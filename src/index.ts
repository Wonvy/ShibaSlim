export {
  DEFAULT_CLARITY,
  PRESETS,
  attributeBuffer,
  attributeFile,
  optimizeBuffer,
  optimizeFile,
  settingsForClarity,
  type AttributeReport,
  type FileOptions,
  type ImageReport,
  type OptimizeOptions,
  type OptimizeReport,
  type Preset,
  type PresetName,
} from './optimize.js';
export {
  checkSignatureOf,
  defaultKeyPath,
  fingerprint,
  keyFileFingerprint,
  loadKey,
  loadOrCreateKey,
  type Attribution,
  type AttributionResult,
  type SignatureCheck,
  type SignatureStatus,
} from './attribution.js';
export { buildPreview, type PreviewInput } from './preview.js';
export {
  availableRenderers,
  renderSlides,
  type ImageFormat,
  type RenderOptions,
  type RenderReport,
  type RendererName,
} from './render.js';
export { SlimError } from './opc.js';
