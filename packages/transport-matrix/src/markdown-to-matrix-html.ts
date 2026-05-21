import { marked } from 'marked'
import sanitizeHtml from 'sanitize-html'

// Matrix-permitted HTML tags per the m.room.message spec.
// https://spec.matrix.org/v1.11/client-server-api/#mroommessage-msgtypes
const ALLOWED_TAGS = [
  'del', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'p', 'a',
  'ul', 'ol', 'sup', 'sub', 'li', 'b', 'i', 'u', 'strong', 'em', 's',
  'code', 'hr', 'br', 'div', 'table', 'thead', 'tbody', 'tr', 'th',
  'td', 'caption', 'pre', 'span', 'img', 'details', 'summary',
]

const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  a: ['href', 'name', 'target'],
  img: ['width', 'height', 'alt', 'title', 'src'],
  ol: ['start'],
  code: ['class'],
  span: ['data-mx-color', 'data-mx-bg-color', 'data-mx-spoiler'],
}

const ALLOWED_SCHEMES = ['https', 'http', 'ftp', 'mailto', 'magnet', 'matrix']

marked.setOptions({ gfm: true, breaks: false, async: false })

export function toMatrixHtml(markdown: string): string {
  if (!markdown || !markdown.trim()) return ''
  let rawHtml: string
  try {
    const out = marked.parse(markdown) as string | Promise<string>
    if (typeof out !== 'string') return ''
    rawHtml = out
  } catch {
    return ''
  }
  return sanitizeHtml(rawHtml, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ALLOWED_SCHEMES,
    allowedSchemesByTag: { a: ALLOWED_SCHEMES },
  })
}
