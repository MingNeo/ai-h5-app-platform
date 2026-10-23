import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'

;(self as any).MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === 'json')
      return new JsonWorker()
    if (label === 'css' || label === 'scss')
      return new CssWorker()
    if (label === 'html')
      return new HtmlWorker()
    if (label === 'typescript' || label === 'javascript')
      return new TsWorker()
    return new EditorWorker()
  },
}

export function languageOf(path: string) {
  const ext = path.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts':
      return 'typescript'
    case 'js':
    case 'mjs':
      return 'javascript'
    case 'vue':
    case 'html':
      return 'html'
    case 'json':
      return 'json'
    case 'yaml':
    case 'yml':
      return 'yaml'
    case 'css':
      return 'css'
    case 'scss':
      return 'scss'
    case 'md':
      return 'markdown'
    default:
      return 'plaintext'
  }
}

export { monaco }
