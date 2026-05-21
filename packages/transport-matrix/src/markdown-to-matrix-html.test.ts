import { describe, expect, it } from 'vitest'
import { toMatrixHtml } from './markdown-to-matrix-html.js'

describe('toMatrixHtml', () => {
  it('returns empty string for empty input', () => {
    expect(toMatrixHtml('')).toBe('')
    expect(toMatrixHtml('   \n\n   ')).toBe('')
  })

  it('wraps plain prose in <p>', () => {
    expect(toMatrixHtml('hello world')).toContain('<p>hello world</p>')
  })

  it('renders bold and italic', () => {
    const out = toMatrixHtml('**bold** and _italic_')
    expect(out).toContain('<strong>bold</strong>')
    expect(out).toContain('<em>italic</em>')
  })

  it('renders inline code', () => {
    expect(toMatrixHtml('use `foo()`')).toContain('<code>foo()</code>')
  })

  it('renders fenced code with language hint as class', () => {
    const out = toMatrixHtml('```ts\nconst x = 1\n```')
    expect(out).toContain('<pre>')
    expect(out).toContain('<code class="language-ts">')
    expect(out).toContain('const x = 1')
  })

  it('renders headings up to h6', () => {
    expect(toMatrixHtml('# H1')).toContain('<h1>H1</h1>')
    expect(toMatrixHtml('###### H6')).toContain('<h6>H6</h6>')
  })

  it('renders unordered and ordered lists', () => {
    const ul = toMatrixHtml('- a\n- b')
    expect(ul).toContain('<ul>')
    expect(ul).toContain('<li>a</li>')
    expect(ul).toContain('<li>b</li>')

    const ol = toMatrixHtml('1. one\n2. two')
    expect(ol).toContain('<ol>')
    expect(ol).toContain('<li>one</li>')
  })

  it('renders GFM strikethrough as <del>', () => {
    expect(toMatrixHtml('~~gone~~')).toContain('<del>gone</del>')
  })

  it('renders GFM tables', () => {
    const md = `| a | b |\n|---|---|\n| 1 | 2 |`
    const out = toMatrixHtml(md)
    expect(out).toContain('<table>')
    expect(out).toContain('<th>a</th>')
    expect(out).toContain('<td>1</td>')
  })

  it('renders blockquotes', () => {
    expect(toMatrixHtml('> quoted')).toContain('<blockquote>')
  })

  it('renders safe https links', () => {
    const out = toMatrixHtml('[home](https://example.com)')
    expect(out).toContain('<a href="https://example.com">home</a>')
  })

  it('strips javascript: URLs from links', () => {
    const out = toMatrixHtml('[evil](javascript:alert(1))')
    // sanitize-html drops the href; the anchor text is preserved
    expect(out).not.toContain('javascript:')
    expect(out).toContain('evil')
  })

  it('strips <script> tags entirely', () => {
    const out = toMatrixHtml('<script>alert(1)</script>hello')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('alert(1)')
    expect(out).toContain('hello')
  })

  it('strips inline event handlers', () => {
    const out = toMatrixHtml('<a href="https://x" onclick="bad()">x</a>')
    expect(out).not.toContain('onclick')
  })

  it('strips <style> tags', () => {
    const out = toMatrixHtml('<style>body{display:none}</style>safe')
    expect(out).not.toContain('<style')
    expect(out).toContain('safe')
  })

  it('preserves @user:server text passthrough for downstream mention rendering', () => {
    // We do NOT convert mentions to anchors here — Zoon does that on render.
    const out = toMatrixHtml('hello @alice:zoon.eco how are you')
    expect(out).toContain('@alice:zoon.eco')
  })

  it('survives pathological input without throwing', () => {
    expect(() => toMatrixHtml(' '.repeat(10))).not.toThrow()
  })
})
