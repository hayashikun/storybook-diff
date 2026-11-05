// Client-side behaviour of the storybook-diff gallery. gallery.ts reads this file and embeds it as a <script>.
// - Layout (side by side / slider) and diff highlight (on / off) are toggled independently
// - The highlight colour can be changed
// - Clicking an image opens it in a dialog; clicking inside the dialog toggles actual size
;(() => {
  const KEY = 'storybook-diff-view'
  const state = { layout: 'side', highlight: false, hlColor: '#16a34a' }
  try {
    Object.assign(state, JSON.parse(localStorage.getItem(KEY) || '{}'))
  } catch (_e) {}
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state))
    } catch (_e) {}
  }

  // Same rule as change detection (pixelDiff in diff.ts). buildGallery embeds the value
  const DIFF_THRESHOLD = Number(document.body.dataset.diffThreshold) || 24

  const diffEls = Array.from(
    document.querySelectorAll('.diff[data-base][data-head]'),
  )

  const img = (src, cls, w, h) =>
    '<img loading="lazy" class="' +
    (cls || '') +
    '" src="' +
    src +
    '"' +
    (w && h ? ' width="' + w + '" height="' + h + '"' : '') +
    ' alt="">'

  const hexToRgb = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
    if (!m) return [22, 163, 74]
    const n = Number.parseInt(m[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }

  const sbLink = (url) =>
    url
      ? ' <a class="sb-link" href="' +
        url +
        '" target="_blank" rel="noopener">(<u>Storybook</u>)</a>'
      : ''

  function buildSide(el) {
    const bw = el.dataset.baseW
    const bh = el.dataset.baseH
    const hw = el.dataset.headW
    const hh = el.dataset.headH
    el.innerHTML =
      '<div class="pair">' +
      '<figure><figcaption>base' +
      sbLink(el.dataset.sbBase) +
      '</figcaption>' +
      img(el.dataset.base, '', bw, bh) +
      '</figure>' +
      '<figure><figcaption>head' +
      sbLink(el.dataset.sbHead) +
      '</figcaption><div class="hl-wrap">' +
      img(el.dataset.head, '', hw, hh) +
      '</div></figure>' +
      '</div>'
  }

  function buildSlider(el) {
    const bw = el.dataset.baseW
    const bh = el.dataset.baseH
    const hw = el.dataset.headW
    const hh = el.dataset.headH
    el.innerHTML =
      '<div class="slider">' +
      img(el.dataset.base, 's-base', bw, bh) +
      '<div class="s-head"><div class="hl-wrap">' +
      img(el.dataset.head, '', hw, hh) +
      '</div></div>' +
      '<div class="s-divider"></div>' +
      '<input class="s-range" type="range" min="0" max="100" value="50" aria-label="比較スライダー">' +
      '</div>'
    const slider = el.querySelector('.slider')
    const baseImg = el.querySelector('.s-base')
    const head = el.querySelector('.s-head')
    const wrap = head.querySelector('.hl-wrap')
    const headImg = head.querySelector('img')
    const divider = el.querySelector('.s-divider')
    const range = el.querySelector('.s-range')
    const size = () => {
      // Make the head image and the diff overlay (relative to .hl-wrap) as wide as the slider.
      // Otherwise .hl-wrap shrinks to .s-head (50%) and the overlay is misaligned
      headImg.style.width = `${slider.clientWidth}px`
      wrap.style.width = `${slider.clientWidth}px`
    }
    const apply = () => {
      head.style.width = `${range.value}%`
      divider.style.left = `${range.value}%`
    }
    if (baseImg.complete) size()
    else baseImg.addEventListener('load', size)
    window.addEventListener('resize', size)
    range.addEventListener('input', apply)
    apply()
  }

  // Draws a coloured overlay of the differing pixels over the head image
  function addHighlight(el) {
    const wrap = el.querySelector('.hl-wrap')
    if (!wrap) return
    const old = wrap.querySelector('.hl-overlay')
    if (old) old.remove()
    const [r, g, bl] = hexToRgb(state.hlColor)
    const b = new Image()
    const h = new Image()
    let loaded = 0
    const draw = (im, w, ht) => {
      const c = document.createElement('canvas')
      c.width = w
      c.height = ht
      c.getContext('2d').drawImage(im, 0, 0)
      return c
    }
    const ready = () => {
      loaded += 1
      if (loaded < 2) return
      const w = Math.min(b.naturalWidth, h.naturalWidth)
      const ht = Math.min(b.naturalHeight, h.naturalHeight)
      if (!w || !ht) return
      let da
      let db
      try {
        da = draw(b, w, ht).getContext('2d').getImageData(0, 0, w, ht)
        db = draw(h, w, ht).getContext('2d').getImageData(0, 0, w, ht)
      } catch (_e) {
        return // No highlight if the canvas is tainted (file:// etc.)
      }
      const out = document.createElement('canvas')
      out.width = w
      out.height = ht
      out.className = 'hl-overlay'
      const ctx = out.getContext('2d')
      const od = ctx.createImageData(w, ht)
      const A = da.data
      const B = db.data
      const O = od.data
      for (let i = 0; i < A.length; i += 4) {
        if (
          Math.abs(A[i] - B[i]) > DIFF_THRESHOLD ||
          Math.abs(A[i + 1] - B[i + 1]) > DIFF_THRESHOLD ||
          Math.abs(A[i + 2] - B[i + 2]) > DIFF_THRESHOLD ||
          Math.abs(A[i + 3] - B[i + 3]) > DIFF_THRESHOLD
        ) {
          O[i] = r
          O[i + 1] = g
          O[i + 2] = bl
          O[i + 3] = 140
        }
      }
      ctx.putImageData(od, 0, 0)
      wrap.appendChild(out)
    }
    b.onload = ready
    h.onload = ready
    b.onerror = ready
    h.onerror = ready
    b.src = el.dataset.base
    h.src = el.dataset.head
  }

  function render(el) {
    const k = state.layout + (state.highlight ? `|hl|${state.hlColor}` : '')
    if (el.dataset.k === k) return
    el.dataset.k = k
    if (state.layout === 'slider') buildSlider(el)
    else buildSide(el)
    if (state.highlight) addHighlight(el)
  }

  // Render cards only once they come into view (the diff highlight is expensive, so defer it)
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) render(e.target)
    },
    { rootMargin: '300px' },
  )
  for (const el of diffEls) io.observe(el)

  // Re-render cards that are already rendered (in view). The observer renders the rest on scroll
  const rerender = () => {
    for (const el of diffEls) {
      if (el.dataset.k) {
        el.dataset.k = ''
        render(el)
      }
    }
  }

  function syncButtons() {
    for (const b of document.querySelectorAll('[data-layout]'))
      b.classList.toggle('active', b.dataset.layout === state.layout)
    for (const b of document.querySelectorAll('[data-hl]'))
      b.classList.toggle('active', (b.dataset.hl === 'on') === state.highlight)
  }

  for (const b of document.querySelectorAll('[data-layout]'))
    b.addEventListener('click', () => {
      state.layout = b.dataset.layout
      save()
      syncButtons()
      rerender()
    })
  for (const b of document.querySelectorAll('[data-hl]'))
    b.addEventListener('click', () => {
      state.highlight = b.dataset.hl === 'on'
      save()
      syncButtons()
      rerender()
    })
  const colorInput = document.querySelector('[data-hl-color]')
  if (colorInput) {
    colorInput.value = state.hlColor
    // input fires continuously while picking and is expensive, so apply only on change (when confirmed)
    colorInput.addEventListener('change', () => {
      state.hlColor = colorInput.value
      save()
      if (state.highlight) rerender()
    })
  }

  // Copy a deep link to a diff / the story file path (for reviews)
  const copyText = (text) => {
    if (navigator.clipboard?.writeText)
      return navigator.clipboard.writeText(text)
    return new Promise((resolve) => {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } catch (_e) {}
      ta.remove()
      resolve()
    })
  }
  document.addEventListener('click', (e) => {
    const link = e.target.closest?.('.copy-link')
    const file = e.target.closest?.('.copy-file')
    const btn = link || file
    if (!btn) return
    e.preventDefault()
    e.stopPropagation()
    const text = link
      ? `${location.origin}${location.pathname}#${btn.dataset.id}`
      : btn.dataset.file
    copyText(text).then(() => {
      const original = btn.textContent
      btn.textContent = '✓ コピーしました'
      btn.classList.add('copied')
      setTimeout(() => {
        btn.textContent = original
        btn.classList.remove('copied')
      }, 1300)
    })
  })

  // Keep the "reviewed" flags per PR in localStorage.
  // The key is the PR URL (pr-url). Without it, the gallery's location tells PRs apart
  const prKey = document.body.dataset.prKey || location.pathname
  const CHECK_KEY = `storybook-diff-checked:${prKey}`
  let checkedSet = new Set()
  try {
    checkedSet = new Set(JSON.parse(localStorage.getItem(CHECK_KEY) || '[]'))
  } catch (_e) {}
  const esc = (s) => (window.CSS?.escape ? CSS.escape(s) : s)
  const applyChecked = (id, on) => {
    const card = document.getElementById(id)
    if (card) {
      card.classList.toggle('is-checked', on)
      // Reviewed cards are collapsed by default (the fold button opens them)
      card.classList.toggle('collapsed', on)
    }
    document
      .querySelector(`.sidebar a[href="#${esc(id)}"]`)
      ?.classList.toggle('is-checked', on)
    const box = document.querySelector(`input[data-check="${esc(id)}"]`)
    if (box) box.checked = on
  }

  // Fold button: opens / closes one card. When opened, render in the current mode
  document.addEventListener('click', (e) => {
    const fold = e.target.closest?.('.fold, .fold-target')
    if (!fold) return
    const card = fold.closest('.card')
    if (!card) return
    card.classList.toggle('collapsed')
    if (!card.classList.contains('collapsed')) {
      const d = card.querySelector('.diff[data-base][data-head]')
      if (d) render(d)
    }
  })
  for (const id of checkedSet) applyChecked(id, true)
  document.addEventListener('change', (e) => {
    const box = e.target
    if (!box.matches?.('input[data-check]')) return
    const id = box.dataset.check
    if (box.checked) checkedSet.add(id)
    else checkedSet.delete(id)
    try {
      localStorage.setItem(CHECK_KEY, JSON.stringify([...checkedSet]))
    } catch (_e) {}
    applyChecked(id, box.checked)
  })

  // Lightbox: click an image to enlarge it; click inside the dialog to toggle actual size / fit
  const lb = document.querySelector('.lightbox')
  if (lb) {
    const lbImg = lb.querySelector('img')
    document.addEventListener('click', (e) => {
      const t = e.target
      // Skip images inside the slider, which is dragged
      if (
        t &&
        t.tagName === 'IMG' &&
        t.closest('figure') &&
        !t.closest('.slider')
      ) {
        lbImg.src = t.currentSrc || t.src
        lbImg.classList.remove('zoomed')
        if (lb.showModal) lb.showModal()
        else lb.setAttribute('open', '')
      }
    })
    lbImg.addEventListener('click', (e) => {
      e.stopPropagation()
      lbImg.classList.toggle('zoomed')
    })
    lb.addEventListener('click', () => {
      if (lb.close) lb.close()
      else lb.removeAttribute('open')
    })
  }

  // Sidebar
  const SIDEBAR_KEY = 'storybook-diff-sidebar'
  const SIDEBAR_WIDTH_KEY = 'storybook-diff-sidebar-width'

  const applySavedWidth = () => {
    try {
      const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY)
      if (saved) {
        const w = Number.parseInt(saved, 10)
        if (w >= 180 && w <= 600) {
          document.body.style.gridTemplateColumns = `${w}px 1fr`
          return
        }
      }
    } catch (_e) {}
    document.body.style.gridTemplateColumns = ''
  }

  // Collapse
  const sidebarClose = document.querySelector('.sidebar-close')
  const sidebarOpen = document.querySelector('.sidebar-open')
  if (sidebarClose && sidebarOpen) {
    let collapsed = false
    try {
      collapsed = localStorage.getItem(SIDEBAR_KEY) === '1'
    } catch (_e) {}
    const applySidebar = () => {
      document.body.classList.toggle('sidebar-collapsed', collapsed)
      if (collapsed) document.body.style.gridTemplateColumns = ''
      else applySavedWidth()
    }
    applySidebar()
    const toggle = () => {
      collapsed = !collapsed
      try {
        localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0')
      } catch (_e) {}
      applySidebar()
    }
    sidebarClose.addEventListener('click', toggle)
    sidebarOpen.addEventListener('click', toggle)
  }

  // Resize
  const sidebarEl = document.querySelector('.sidebar')
  const resizeHandle = document.querySelector('.sidebar-resize')
  if (sidebarEl && resizeHandle) {
    applySavedWidth()
    let dragging = false
    resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      dragging = true
      resizeHandle.classList.add('dragging')
      document.body.classList.add('sidebar-resizing')
    })
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return
      const w = Math.max(180, Math.min(600, e.clientX))
      document.body.style.gridTemplateColumns = `${w}px 1fr`
    })
    document.addEventListener('mouseup', () => {
      if (!dragging) return
      dragging = false
      resizeHandle.classList.remove('dragging')
      document.body.classList.remove('sidebar-resizing')
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarEl.offsetWidth))
      } catch (_e) {}
    })
  }

  syncButtons()

  if (navigator.userAgent.includes('Mac')) {
    for (const el of document.querySelectorAll('.mod-alt')) el.textContent = '⌥'
  }

  // Sidebar link scrolling: account for the height of the sticky view-toggle
  const viewToggle = document.querySelector('.view-toggle')
  const sidebarAnchors = document.querySelectorAll('.sidebar a[href^="#"]')

  for (const a of sidebarAnchors) {
    a.addEventListener('click', (e) => {
      const hash = a.getAttribute('href')
      e.preventDefault()
      history.replaceState(null, '', hash)
    })
  }

  // Highlight the active sidebar link based on the scroll position
  const allCards = Array.from(document.querySelectorAll('.card[id]'))
  const navMap = new Map()
  for (const a of sidebarAnchors) {
    const id = decodeURIComponent(a.getAttribute('href').slice(1))
    navMap.set(id, a)
  }

  let rafId = 0
  const updateActive = () => {
    const offset = viewToggle ? viewToggle.offsetHeight + 8 : 16
    let activeId = null
    for (const card of allCards) {
      if (card.getBoundingClientRect().top <= offset + 2) activeId = card.id
    }
    if (!activeId && allCards.length) activeId = allCards[0].id
    const prev = document.querySelector('.sidebar a.is-active')
    const next = activeId ? navMap.get(activeId) : null
    if (prev === next) return
    if (prev) prev.classList.remove('is-active')
    if (next) {
      next.classList.add('is-active')
      next.scrollIntoView({ block: 'nearest' })
    }
  }
  window.addEventListener(
    'scroll',
    () => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(updateActive)
    },
    { passive: true },
  )
  updateActive()

  // --- Progress bar ---
  const totalCheckboxes = document.querySelectorAll('input[data-check]').length
  const progressCountEl = document.querySelector('.progress-count')
  const progressTotalEl = document.querySelector('.progress-total')
  const progressFillEl = document.querySelector('.progress-fill')
  function updateProgress() {
    const confirmed = checkedSet.size
    if (progressCountEl) progressCountEl.textContent = String(confirmed)
    if (progressTotalEl) progressTotalEl.textContent = String(totalCheckboxes)
    if (progressFillEl)
      progressFillEl.style.width =
        totalCheckboxes > 0 ? `${(confirmed / totalCheckboxes) * 100}%` : '0%'
  }
  updateProgress()

  document.addEventListener('change', (e) => {
    const box = e.target
    if (!box.matches?.('input[data-check]')) return
    updateProgress()
  })

  // --- Keyboard navigation ---
  let focusIdx = -1
  let focusedCard = null

  function setFocus(idx) {
    if (focusedCard) focusedCard.classList.remove('is-focused')
    if (allCards.length === 0) {
      focusIdx = -1
      focusedCard = null
      return
    }
    focusIdx = Math.max(0, Math.min(idx, allCards.length - 1))
    const card = allCards[focusIdx]
    card.classList.add('is-focused')
    focusedCard = card
    // Before scrolling, render every unrendered card up to the target so the layout is final
    for (const el of diffEls) {
      if (!el.dataset.k) render(el)
      if (el.closest('.card') === card) break
    }
    const offset = viewToggle ? viewToggle.offsetHeight + 8 : 16
    const top = card.getBoundingClientRect().top + window.scrollY - offset
    window.scrollTo({ top, behavior: 'smooth' })
    const navLink = navMap.get(card.id)
    if (navLink) {
      const prevActive = document.querySelector('.sidebar a.is-active')
      if (prevActive) prevActive.classList.remove('is-active')
      navLink.classList.add('is-active')
      navLink.scrollIntoView({ block: 'nearest' })
    }
  }

  // Clicking a sidebar link focuses the card
  for (const a of sidebarAnchors) {
    a.addEventListener('click', () => {
      const id = decodeURIComponent(a.getAttribute('href').slice(1))
      const target = document.getElementById(id)
      if (!target) return
      const idx = allCards.indexOf(target)
      if (idx >= 0) setFocus(idx)
    })
  }

  // Clicking a card body focuses it (except on buttons and other controls)
  document.addEventListener('click', (e) => {
    if (e.target.closest?.('button, a, input, label')) return
    const card = e.target.closest?.('.card[id]')
    if (!card) return
    const idx = allCards.indexOf(card)
    if (idx >= 0) setFocus(idx)
  })

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
    if (lb?.open) return

    if (e.altKey) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setFocus(focusIdx < 0 ? 0 : focusIdx + 1)
          return
        case 'ArrowUp':
          e.preventDefault()
          setFocus(focusIdx < 0 ? 0 : focusIdx - 1)
          return
      }
    }

    if (e.altKey || e.ctrlKey || e.metaKey) return
    switch (e.key) {
      case 'a':
      case 'A':
        if (focusIdx >= 0 && focusIdx < allCards.length) {
          e.preventDefault()
          const card = allCards[focusIdx]
          const box = card.querySelector('input[data-check]')
          if (box && !box.checked) {
            box.checked = true
            box.dispatchEvent(new Event('change', { bubbles: true }))
          }
          if (focusIdx + 1 < allCards.length) {
            requestAnimationFrame(() => setFocus(focusIdx + 1))
          }
        }
        break
      case 'd':
      case 'D':
        if (focusIdx >= 0 && focusIdx < allCards.length) {
          e.preventDefault()
          const card = allCards[focusIdx]
          const box = card.querySelector('input[data-check]')
          if (box?.checked) {
            box.checked = false
            box.dispatchEvent(new Event('change', { bubbles: true }))
          }
        }
        break
    }
  })
})()
