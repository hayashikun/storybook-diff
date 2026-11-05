import { describe, expect, test } from 'vitest'
import { normalizeHtml } from './diff.ts'

describe('normalizeHtml', () => {
  test.each([
    ['React 18', ':r1:', ':r2a:'],
    ['React 19.1', '«r1»', '«r2a»'],
    ['React 19.2', '_r_1_', '_r_2a_'],
  ])('%s の採番 id は値が違っても同一視する', (_, a, b) => {
    const html = (id: string) =>
      `<input id="${id}" aria-describedby="${id}-helper-text">`
    expect(normalizeHtml(html(a))).toBe(normalizeHtml(html(b)))
  })

  test('1 つの属性値に並んだ複数の採番 id も同一視する', () => {
    expect(normalizeHtml('<div aria-labelledby="_r_1_ _r_2_">')).toBe(
      normalizeHtml('<div aria-labelledby="_r_a_ _r_b_">'),
    )
  })

  test.each([
    [
      '<style> 内のセレクタ',
      '<style>:root:x{}</style>',
      '<style>:rooot:x{}</style>',
    ],
    ['snake_case のテキスト', '<p>user_r_name_</p>', '<p>user_r_title_</p>'],
    ['コロン区切りのテキスト', '<p>a:rows:b</p>', '<p>a:rowz:b</p>'],
  ])('属性値の外にある %s は変えない', (_, a, b) => {
    expect(normalizeHtml(a)).not.toBe(normalizeHtml(b))
  })

  test('採番 id 以外の id の違いは差分として残す', () => {
    expect(normalizeHtml('<div id="user-1">')).not.toBe(
      normalizeHtml('<div id="user-2">'),
    )
  })

  test('object URL と空白の揺らぎを除去する', () => {
    expect(
      normalizeHtml('<img src="blob:http://127.0.0.1:1234/abc">\n  <p>a</p>'),
    ).toBe(normalizeHtml('<img src="blob:http://127.0.0.1:5678/def"> <p>a</p>'))
  })
})
