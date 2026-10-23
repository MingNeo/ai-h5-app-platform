const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
}

export function mimeOf(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return MIME[ext] ?? 'application/octet-stream'
}

export const TEXT_EXT = /\.(?:html|js|mjs|ts|tsx|jsx|vue|css|scss|json|md|txt|svg|xml|yaml|yml)$/i

/** 允许用户通过 SDK 上传的类型 */
export const UPLOAD_MIME = /^(?:image\/(?:png|jpe?g|gif|webp|avif)|audio\/(?:mpeg|mp3|wav|ogg|mp4|aac|x-m4a)|video\/(?:mp4|webm))$/
